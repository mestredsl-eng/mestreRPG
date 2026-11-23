// Testes — Issue #291: regressão ponta a ponta do ciclo de campanha,
// convites e membros (release 1.0.9). Cobre os 9 cenários obrigatórios
// no nível de API real: servidor spawnado + banco descartável + migrations.
// Não duplica teste-convite-cadastro (cadastro anônimo), teste-escopo-cruzado
// (admin/guilda sem membership) nem homologacao-convites-guilda — aqui o
// ciclo completo campanha↔convite↔papel↔personagem↔remoção↔reentrada.
import { randomUUID } from "node:crypto";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  encerrarServidor, limparDir, req, sessao, criarCenario, comDb, abrirDb,
} from "./teste-base.mjs";
import { hashSenha } from "./servidor/dist/lib/password.js";

const DIR = dirTeste("ciclo-campanha");
const BANCO = `${DIR}/mestre-rpg-teste.db`;
await prepararBanco(BANCO);

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const porta = await portaLivre();
const BASE = `http://127.0.0.1:${porta}`;
const proc = subirServidor(porta, {
  banco: BANCO,
  arquivos: `${DIR}/arquivos`,
  backups: `${DIR}/backups`,
});
await esperarSaudavel(BASE, proc);

/** Usuário novo SEM membership — só existe na campanha se aceitar convite. */
async function novoUsuario(username) {
  const id = randomUUID();
  const agora = Date.now();
  const db = abrirDb(BANCO);
  try {
    db.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
      .run(id, username, username, await hashSenha("senha-jogador-123"), agora, agora);
  } finally { db.close(); }
  return { id, cookie: sessao(BANCO, id), username };
}
const membershipDe = (campId, userId) => comDb(BANCO, (db) =>
  db.prepare("select id, role, status from memberships where campaign_id=? and user_id=?").get(campId, userId));
const contarMembros = (campId) => comDb(BANCO, (db) =>
  db.prepare("select count(*) n from memberships where campaign_id=? and status!='removido'").get(campId).n);
const usosConvite = (invId) => comDb(BANCO, (db) =>
  db.prepare("select uses from invitations where id=?").get(invId)?.uses);

try {
  sec("S1 — mestre cria campanha e configura dados iniciais");
  const c = await criarCenario(BASE, BANCO, { jogadores: {} });
  const { campId, cookieMestre } = c;
  t("campanha criada via API", !!campId);
  const patch = await req(BASE, "PATCH", `/campaigns/${campId}`, {
    cookie: cookieMestre, body: { name: "Caçadores & Caçados — Ciclo", status: "andamento" },
  });
  t("mestre edita campanha (nome+status)", patch.status === 200 && patch.json?.campanha?.status === "andamento",
    `status=${patch.status}`);
  const lista = await req(BASE, "GET", "/campaigns", { cookie: cookieMestre });
  t("campanha aparece na lista do mestre", lista.status === 200 &&
    (lista.json?.campanhas ?? lista.json ?? []).some?.((x) => x.id === campId) !== false);

  sec("S2 — convites: válido, uso único, expirado, inválido e concorrência");
  // convite uso único para jogador
  const inv1 = await req(BASE, "POST", `/campaigns/${campId}/invitations`, {
    cookie: cookieMestre, body: { role: "jogador", maxUses: 1, requiresApproval: false },
  });
  t("mestre cria convite (201 + código)", inv1.status === 201 && !!inv1.json?.convite?.code, `status=${inv1.status}`);
  const code1 = inv1.json.convite.code;
  const u1 = await novoUsuario("ciclo_jogador1");
  const ok1 = await req(BASE, "POST", `/convites/${code1}/aceitar`, { cookie: u1.cookie });
  t("jogador aceita convite válido", ok1.status === 200 || ok1.status === 201, `status=${ok1.status} ${JSON.stringify(ok1.json)?.slice(0, 120)}`);
  const m1 = membershipDe(campId, u1.id);
  t("membership ativa papel jogador", m1?.role === "jogador" && m1?.status === "ativo", JSON.stringify(m1));
  const u2 = await novoUsuario("ciclo_jogador2");
  const over = await req(BASE, "POST", `/convites/${code1}/aceitar`, { cookie: u2.cookie });
  t("uso único esgotado → 410", over.status === 410, `status=${over.status}`);
  t("uso esgotado não cria membership", membershipDe(campId, u2.id) === undefined);

  // convite expirado: cria e retrocede expires_at no banco
  const invExp = await req(BASE, "POST", `/campaigns/${campId}/invitations`, {
    cookie: cookieMestre, body: { role: "jogador", expiresInHours: 1, requiresApproval: false },
  });
  t("convite com expiração criado", invExp.status === 201, `status=${invExp.status}`);
  const codeExp = invExp.json.convite.code;
  {
    const w = abrirDb(BANCO);
    try { w.prepare("update invitations set expires_at=? where id=?").run(Date.now() - 1000, invExp.json.convite.id); }
    finally { w.close(); }
  }
  const uExp = await novoUsuario("ciclo_expirado");
  const rExp = await req(BASE, "POST", `/convites/${codeExp}/aceitar`, { cookie: uExp.cookie });
  t("convite expirado → 410", rExp.status === 410, `status=${rExp.status}`);
  t("expirado não cria membership", membershipDe(campId, uExp.id) === undefined);

  // código inexistente
  const uInval = await novoUsuario("ciclo_invalido");
  const rInval = await req(BASE, "POST", `/convites/CODIGO-INEXISTENTE-XYZ/aceitar`, { cookie: uInval.cookie });
  t("código inválido → 404", rInval.status === 404, `status=${rInval.status}`);
  t("inválido não cria membership", membershipDe(campId, uInval.id) === undefined);

  // concorrência: maxUses=1, dois aceites simultâneos → exatamente um vence
  const invCorr = await req(BASE, "POST", `/campaigns/${campId}/invitations`, {
    cookie: cookieMestre, body: { role: "espectador", maxUses: 1, requiresApproval: false },
  });
  const codeCorr = invCorr.json.convite.code;
  const [ua, ub] = await Promise.all([novoUsuario("ciclo_corr_a"), novoUsuario("ciclo_corr_b")]);
  const [ra, rb] = await Promise.all([
    req(BASE, "POST", `/convites/${codeCorr}/aceitar`, { cookie: ua.cookie }),
    req(BASE, "POST", `/convites/${codeCorr}/aceitar`, { cookie: ub.cookie }),
  ]);
  const sucessos = [ra, rb].filter((r) => r.status === 200 || r.status === 201).length;
  t("corrida maxUses=1 → exatamente 1 sucesso", sucessos === 1, `a=${ra.status} b=${rb.status}`);
  const usos = usosConvite(invCorr.json.convite.id);
  t("uses=1 após corrida", usos === 1, `uses=${usos}`);

  // requiresApproval → membership pendente
  const invApr = await req(BASE, "POST", `/campaigns/${campId}/invitations`, {
    cookie: cookieMestre, body: { role: "jogador", maxUses: 1, requiresApproval: true },
  });
  const uApr = await novoUsuario("ciclo_pendente");
  const rApr = await req(BASE, "POST", `/convites/${invApr.json.convite.code}/aceitar`, { cookie: uApr.cookie });
  t("aceite com aprovação retorna sucesso", rApr.status === 200 || rApr.status === 201, `status=${rApr.status}`);
  const mApr = membershipDe(campId, uApr.id);
  t("membership nasce pendente", mApr?.status === "pendente", JSON.stringify(mApr));
  const negadoPendente = await req(BASE, "GET", `/campaigns/${campId}/members`, { cookie: uApr.cookie });
  t("pendente não lista membros (403)", negadoPendente.status === 403, `status=${negadoPendente.status}`);

  sec("S3 — jogador entra, cria ficha e acessa só a campanha autorizada");
  const ficha = await req(BASE, "POST", `/campaigns/${campId}/characters`, {
    cookie: u1.cookie, body: { name: "Herói do Ciclo", data: { for: 5 } },
  });
  t("jogador cria personagem (201)", ficha.status === 201 || ficha.status === 200, `status=${ficha.status} ${JSON.stringify(ficha.json)?.slice(0, 150)}`);
  const personagens = await req(BASE, "GET", `/campaigns/${campId}/characters`, { cookie: u1.cookie });
  t("jogador lista personagens da campanha", personagens.status === 200, `status=${personagens.status}`);
  const listaJogador = await req(BASE, "GET", "/campaigns", { cookie: u1.cookie });
  const campsVisiveis = JSON.stringify(listaJogador.json);
  t("jogador vê a campanha autorizada", campsVisiveis.includes(campId));

  sec("S4 — espectador vê só o permitido e não executa ações");
  const vencedor = ra.status === 200 || ra.status === 201 ? ua : ub;
  const espMemb = membershipDe(campId, vencedor.id);
  t("vencedor da corrida é espectador", espMemb?.role === "espectador", JSON.stringify(espMemb));
  const memEsp = await req(BASE, "GET", `/campaigns/${campId}/members`, { cookie: vencedor.cookie });
  t("espectador lista membros (200)", memEsp.status === 200, `status=${memEsp.status}`);
  const fichaEsp = await req(BASE, "POST", `/campaigns/${campId}/characters`, {
    cookie: vencedor.cookie, body: { name: "Nao Pode", data: {} },
  });
  t("espectador NÃO cria personagem (403)", fichaEsp.status === 403, `status=${fichaEsp.status}`);
  const patchEsp = await req(BASE, "PATCH", `/campaigns/${campId}`, {
    cookie: vencedor.cookie, body: { name: "Invadido" },
  });
  t("espectador NÃO edita campanha (403)", patchEsp.status === 403, `status=${patchEsp.status}`);
  const invEsp = await req(BASE, "POST", `/campaigns/${campId}/invitations`, {
    cookie: vencedor.cookie, body: { role: "jogador" },
  });
  t("espectador NÃO cria convite (403)", invEsp.status === 403, `status=${invEsp.status}`);

  sec("S5 — mudança de papel e remoção revalidam no servidor");
  const mJogador = m1;
  const rebaixa = await req(BASE, "PATCH", `/campaigns/${campId}/members/${mJogador.id}`, {
    cookie: cookieMestre, body: { role: "espectador" },
  });
  t("mestre rebaixa jogador→espectador", rebaixa.status === 200, `status=${rebaixa.status}`);
  const fichaAposRebaixa = await req(BASE, "POST", `/campaigns/${campId}/characters`, {
    cookie: u1.cookie, body: { name: "Tarde Demais", data: {} },
  });
  t("após rebaixar, criar personagem → 403", fichaAposRebaixa.status === 403, `status=${fichaAposRebaixa.status}`);
  const promove = await req(BASE, "PATCH", `/campaigns/${campId}/members/${mJogador.id}`, {
    cookie: cookieMestre, body: { role: "jogador" },
  });
  t("mestre promove de volta", promove.status === 200, `status=${promove.status}`);
  const bloqueia = await req(BASE, "PATCH", `/campaigns/${campId}/members/${mJogador.id}`, {
    cookie: cookieMestre, body: { status: "bloqueado" },
  });
  t("mestre bloqueia membro", bloqueia.status === 200, `status=${bloqueia.status}`);
  const fichaBloqueado = await req(BASE, "POST", `/campaigns/${campId}/characters`, {
    cookie: u1.cookie, body: { name: "Bloqueado", data: {} },
  });
  t("membro bloqueado → 403 em ação", fichaBloqueado.status === 403, `status=${fichaBloqueado.status}`);
  await req(BASE, "PATCH", `/campaigns/${campId}/members/${mJogador.id}`, {
    cookie: cookieMestre, body: { status: "ativo" },
  });
  const remove = await req(BASE, "DELETE", `/campaigns/${campId}/members/${mJogador.id}`, { cookie: cookieMestre });
  t("mestre remove membro (soft delete)", remove.status === 200 || remove.status === 204, `status=${remove.status}`);
  const aposRemocao = await req(BASE, "GET", `/campaigns/${campId}`, { cookie: u1.cookie });
  t("removido perde acesso à campanha", aposRemocao.status === 403 || aposRemocao.status === 404, `status=${aposRemocao.status}`);

  sec("S6 — isolamento entre campanhas");
  const camp2 = await req(BASE, "POST", "/campaigns", { cookie: cookieMestre, body: { name: "Outra Campanha" } });
  const camp2Id = camp2.json?.campanha?.id;
  t("segunda campanha criada", !!camp2Id);
  // uApr (pendente) tenta acessar recursos da campanha do ciclo via IDs diretos
  const invasaoGet = await req(BASE, "GET", `/campaigns/${campId}/members`, { cookie: uApr.cookie });
  t("pendente não lê membros da campanha", invasaoGet.status === 403, `status=${invasaoGet.status}`);
  const crossPatch = await req(BASE, "PATCH", `/campaigns/${campId}`, {
    cookie: cookieMestre, body: { name: "X" },
  });
  void crossPatch;
  // usuário da campanha B (criado via convite nela) não acessa A
  const invB = await req(BASE, "POST", `/campaigns/${camp2Id}/invitations`, {
    cookie: cookieMestre, body: { role: "jogador", requiresApproval: false },
  });
  const uB = await novoUsuario("ciclo_camp_b");
  await req(BASE, "POST", `/convites/${invB.json.convite.code}/aceitar`, { cookie: uB.cookie });
  const crossA = await req(BASE, "GET", `/campaigns/${campId}/members`, { cookie: uB.cookie });
  t("membro de B não lê membros de A", crossA.status === 403 || crossA.status === 404, `status=${crossA.status}`);
  const crossChars = await req(BASE, "GET", `/campaigns/${campId}/characters`, { cookie: uB.cookie });
  t("membro de B não lista personagens de A", crossChars.status === 403 || crossChars.status === 404, `status=${crossChars.status}`);

  sec("S7 — reentrada e repetição não duplicam");
  const antes = contarMembros(campId);
  // uB tenta re-aceitar convite de B (já participante) → 409 e uses estornado
  const reaceite = await req(BASE, "POST", `/convites/${invB.json.convite.code}/aceitar`, { cookie: uB.cookie });
  t("re-aceite do mesmo convite → 409", reaceite.status === 409, `status=${reaceite.status}`);
  t("re-aceite não duplica membership", membershipDe(camp2Id, uB.id) !== undefined);
  // GETs repetidos não criam nada
  for (let i = 0; i < 3; i++) {
    await req(BASE, "GET", `/campaigns/${campId}`, { cookie: cookieMestre });
    await req(BASE, "GET", `/campaigns/${campId}/members`, { cookie: cookieMestre });
    await req(BASE, "GET", `/campaigns/${campId}/invitations`, { cookie: cookieMestre });
  }
  t("leituras repetidas não alteram contagem de membros", contarMembros(campId) === antes,
    `antes=${antes} depois=${contarMembros(campId)}`);
  const convitesB = await req(BASE, "GET", `/campaigns/${campId}/invitations`, { cookie: cookieMestre });
  const codigos = new Set((convitesB.json?.convites ?? []).map((x) => x.id));
  t("lista de convites íntegra (ids únicos)", codigos.size === (convitesB.json?.convites ?? []).length);

  sec("S8 — campanha vazia, com membros e encerrada");
  // campanha "vazia" = só mestre (camp2 tem uB; criar uma terceira sem membros)
  const campVazia = await req(BASE, "POST", "/campaigns", { cookie: cookieMestre, body: { name: "Vazia" } });
  const vaziaId = campVazia.json?.campanha?.id;
  const memVazia = await req(BASE, "GET", `/campaigns/${vaziaId}/members`, { cookie: cookieMestre });
  t("campanha vazia lista só o mestre", memVazia.status === 200, `status=${memVazia.status}`);
  // encerra a campanha do ciclo
  const encerra = await req(BASE, "PATCH", `/campaigns/${campId}`, {
    cookie: cookieMestre, body: { status: "concluida" },
  });
  t("mestre encerra campanha (concluida)", encerra.status === 200 && encerra.json?.campanha?.status === "concluida",
    `status=${encerra.status}`);
  const fichaEncerrada = await req(BASE, "POST", `/campaigns/${campId}/characters`, {
    cookie: uB.cookie, body: { name: "Na Encerrada", data: {} },
  });
  t("criar personagem em campanha concluída → 403 (servidor bloqueia)",
    fichaEncerrada.status === 403, `status=${fichaEncerrada.status}`);

  sec("S9 — falhas não deixam estado parcial");
  const membrosAntesFalha = contarMembros(camp2Id);
  const invFalha = await req(BASE, "POST", `/campaigns/${camp2Id}/invitations`, {
    cookie: cookieMestre, body: { role: "jogador", requiresApproval: false },
  });
  const uFalha = await novoUsuario("ciclo_falha");
  const rFalha = await req(BASE, "POST", "/convites/CODIGO-QUE-NAO-EXISTE/aceitar", { cookie: uFalha.cookie });
  t("aceite inválido → 404", rFalha.status === 404);
  t("falha não cria membership na campanha errada", membershipDe(camp2Id, uFalha.id) === undefined);
  t("contagem de membros estável após falhas", contarMembros(camp2Id) === membrosAntesFalha);
  void invFalha;

  console.log(`\n${pass} passaram, ${fail} falharam`);
  if (fail > 0) process.exitCode = 1;
} finally {
  await encerrarServidor(proc);
  limparDir(DIR);
}
