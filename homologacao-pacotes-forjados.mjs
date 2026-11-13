// Homologação browser — pacotes forjados/atrasados ​​de eventos de mesa.
// Injeta eventos pelo MESMO transporte do frontend (socket.io-client
// interno da página, via onevent — o caminho real de entrega servidor→
// cliente) e verifica o ESTADO VISUAL resultante: conteúdo presente só
// para autorizados, alvo oculto nunca renderizado para não-mestres,
// decisões/rolagens privadas do dono legítimo preservadas.
// 4 contextos isolados: mestre, dono A, jogador B, espectador.
import { chromium } from "playwright";
import crypto from "node:crypto";
import { join } from "node:path";
import { hashSenha } from "./servidor/dist/lib/password.js";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, encerrarServidor, limparDir, req, abrirDb, sessao,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const DIR = dirTeste("mesa-forjados-ui");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;

let browser, proc, C, ids, sid, charA, charB;
const ctxs = [];
const errosConsole = [];

function vigiar(page, tag) {
  page.on("pageerror", (e) => errosConsole.push(`${tag}:pageerror:${e.message}`));
}
async function login(page, user, senha) {
  await page.goto(BASE);
  await page.getByLabel("Usuário").fill(user);
  await page.getByLabel("Senha").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByText("Servidor online").waitFor({ timeout: 15000 });
}
async function irMesa(page) {
  await page.getByRole("button", { name: "Campanhas" }).click();
  await page.getByText("Campanha Teste", { exact: true }).first().click();
  await page.locator(".abas button", { hasText: "Mesa" }).first().click();
}
async function abrirSessao(page) {
  const linha = page.locator("tr.clicavel", { hasText: "Sessão PF" });
  await linha.first().waitFor({ timeout: 15000 });
  await linha.first().click();
  await page.locator(".mesa-vtt").first().waitFor({ timeout: 15000 });
  // espera o socket interno do app existir (alça de diagnóstico localhost)
  await page.waitForFunction(() => !!window.__mesaSocket?.connected, null, { timeout: 15000 });
}
// injeta um evento forjado pelo transporte real do app: onevent é o
// mesmo dispatcher interno que pacotes servidor→cliente usam
const injetar = (page, ev, payload) => page.evaluate(([e, p]) => {
  const s = window.__mesaSocket;
  if (!s?.connected) return "sem-socket";
  s.onevent({ type: 2, data: [e, p] });
  return "ok";
}, [ev, payload]);
// emite um evento REAL cliente→servidor pelo socket do app (ack via promise)
const emitirReal = (page, ev, payload) => page.evaluate(([e, p]) => new Promise((res) => {
  const s = window.__mesaSocket;
  if (!s?.connected) return res({ ok: false, erro: "sem-socket" });
  const to = setTimeout(() => res({ ok: false, erro: "timeout" }), 8000);
  s.emit(e, p, (r) => { clearTimeout(to); res(r ?? { ok: true }); });
}), [ev, payload]);
const temTexto = async (page, txt) => (await page.getByText(txt, { exact: false }).count()) > 0;
const page_count = (page, txt) => page.getByText(txt, { exact: false }).count();
const nChat = (page, txt) => page.locator(".chat-msg", { hasText: txt }).count();
const nTeste = (page, txt) => page.locator(".teste-card", { hasText: txt }).count();
const nRoll = (page) => page.locator(".rolagem-item").count();

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
  proc.stderr.on("data", (d) => process.stderr.write("[srv] " + d));
  await esperarSaudavel(BASE, proc);

  C = await criarCenario(BASE, BANCO, { jogadores: { ja: "pf_ja", jb: "pf_jb" } });
  ids = { camp: C.campId, mestre: C.adminId, ja: C.jogadores.ja.id, jb: C.jogadores.jb.id, cookieMestre: C.cookieMestre };
  // espectador + personagens
  const esp = crypto.randomUUID(), agora = Date.now();
  {
    const db = abrirDb(BANCO);
    db.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
      .run(esp, "pf_esp", "PF Esp", await hashSenha("senha-forte-123"), agora, agora);
    db.prepare("insert into memberships (id,campaign_id,user_id,role,status,joined_at,created_at,updated_at) values (?,?,?,'espectador','ativo',?,?,?)")
      .run(crypto.randomUUID(), ids.camp, esp, agora, agora, agora);
    db.close();
  }
  ids.esp = esp;
  charA = C.novoPersonagem(C.jogadores.ja.membershipId, "PersA");
  charB = C.novoPersonagem(C.jogadores.jb.membershipId, "PersB");
  // sessão
  const sess = await req(BASE, "POST", `/campaigns/${ids.camp}/sessoes`, { cookie: ids.cookieMestre, body: { name: "Sessão PF" } });
  sid = sess.json?.sessao?.id ?? sess.json?.id;
  t("sessão criada", !!sid);

  // testes seeded direto no banco (estado autoritativo para os filtros)
  const db = abrirDb(BANCO);
  const agora2 = Date.now();
  const insTeste = db.prepare("insert into tests (id,campaign_id,session_id,character_id,requested_by,skill_ref,modifiers,dice_count,dice_sides,target,status,visibility,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const pubT = crypto.randomUUID(), privTB = crypto.randomUUID();
  insTeste.run(pubT, ids.camp, sid, charB, ids.mestre, JSON.stringify({ rotulo: "PF-publico-B" }), "{}", 1, 20, null, "pendente", "publica", agora2, agora2);
  insTeste.run(privTB, ids.camp, sid, charB, ids.mestre, JSON.stringify({ rotulo: "PF-privado-B" }), "{}", 1, 20, 11, "pendente", "privada", agora2, agora2);
  db.close();

  // ---------- navegador: 4 contextos isolados ----------
  sec("Browser: 4 contextos isolados (mestre, dono A, jogador B, espectador)");
  browser = await chromium.launch();
  async function contexto(user, senha, tag) {
    const ctx = await browser.newContext();
    ctxs.push(ctx);
    const page = await ctx.newPage();
    vigiar(page, tag);
    await login(page, user, senha);
    await irMesa(page);
    await abrirSessao(page);
    return page;
  }
  const pgM = await contexto("mestre_teste", "senha-forte-123", "mestre");
  const pgA = await contexto("pf_ja", "senha-jogador-123", "donoA");
  const pgB = await contexto("pf_jb", "senha-jogador-123", "jogadorB");
  const pgE = await contexto("pf_esp", "senha-forte-123", "espectador");
  await dormir(500);
  t("4 sessões de mesa abertas", true);

  // estado inicial: teste público de B visível para todos; privado de B não
  t("setup: teste público aparece para o dono A", await nTeste(pgA, "PF-publico-B") >= 1);
  t("setup: teste privado de B NÃO aparece para o dono A", (await nTeste(pgA, "PF-privado-B")) === 0);
  t("setup: teste privado de B aparece para o mestre", (await nTeste(pgM, "PF-privado-B")) >= 1);

  // ---------- M. Mensagens forjadas ----------
  sec("M. Mensagens forjadas — visibilidade e destinatário");
  const msgs = [
    ["secreta", "PF2-msg-secreta", { visibility: "secreta" }],
    ["mestre", "PF2-msg-mestre", { visibility: "mestre" }],
    ["ausente", "PF2-msg-sem-vis", {}],
    ["nula", "PF2-msg-vis-nula", { visibility: null }],
    ["vazia", "PF2-msg-vis-vazia", { visibility: "" }],
    ["numerica", "PF2-msg-vis-num", { visibility: 7 }],
    ["objeto", "PF2-msg-vis-obj", { visibility: { x: 1 } }],
    ["desconhecida", "PF2-msg-vis-x", { visibility: "confidencial" }],
    ["publica+privado", "PF2-msg-pub-priv", { visibility: "publica", privado: true }],
  ];
  // "privada de outro": autor E destinatário são um usuário que a página
  // visualizada NÃO é — montar por página (B não pode ver a própria msg)
  const privadaOutro = (pgUser) => ({
    A: { authorId: ids.jb, recipients: [ids.jb] },
    B: { authorId: ids.ja, recipients: [ids.ja] },
    esp: { authorId: ids.ja, recipients: [ids.ja] },
  }[pgUser]);
  for (const [pg, tag] of [[pgA, "A"], [pgB, "B"], [pgE, "esp"]]) {
    for (const [, marker, extra] of msgs) {
      await injetar(pg, "mesa:mensagem", { id: crypto.randomUUID(), sessionId: sid, kind: "texto", content: marker, authorId: ids.jb, visibility: extra.visibility, privado: extra.privado, createdAt: new Date().toISOString() });
    }
    const po = privadaOutro(tag);
    await injetar(pg, "mesa:mensagem", { id: crypto.randomUUID(), sessionId: sid, kind: "texto", content: "PF2-msg-priv-outro", authorId: po.authorId, visibility: "privada", recipients: po.recipients, createdAt: new Date().toISOString() });
    await dormir(200);
  }
  // controle: mensagem pública legítima forjada aparece para todos
  for (const pg of [pgA, pgB, pgE]) await injetar(pg, "mesa:mensagem", { id: crypto.randomUUID(), sessionId: sid, kind: "texto", content: "PF2-msg-publica-ok", authorId: ids.jb, visibility: "publica", createdAt: new Date().toISOString() });
  await dormir(300);
  for (const [pg, tag] of [[pgA, "A"], [pgB, "B"], [pgE, "esp"]]) {
    for (const [nome, marker] of msgs) {
      t(`M/${tag}: ${nome} rejeitada`, (await nChat(pg, marker)) === 0, `count=${await nChat(pg, marker)}`);
    }
    t(`M/${tag}: privada de outro rejeitada`, (await nChat(pg, "PF2-msg-priv-outro")) === 0);
    t(`M/${tag}: mensagem pública legítima exibida`, (await nChat(pg, "PF2-msg-publica-ok")) === 1);
  }
  // mestre recebe os rótulos privados (contrato: mestre vê tudo)
  for (const [nome, marker] of [["secreta", "PF2-msg-secreta"], ["mestre", "PF2-msg-mestre"], ["publica+privado", "PF2-msg-pub-priv"]]) {
    await injetar(pgM, "mesa:mensagem", { id: crypto.randomUUID(), sessionId: sid, kind: "texto", content: marker, authorId: ids.jb, visibility: nome === "publica+privado" ? "publica" : nome, privado: nome === "publica+privado" ? true : undefined, createdAt: new Date().toISOString() });
  }
  await dormir(300);
  t("M/mestre: secreta exibida", (await nChat(pgM, "PF2-msg-secreta")) === 1);
  t("M/mestre: mestre exibida", (await nChat(pgM, "PF2-msg-mestre")) === 1);
  t("M/mestre: publica+privado tratada como privada (exibida ao mestre)", (await nChat(pgM, "PF2-msg-pub-priv")) === 1);

  // ---------- T. Testes forjados ----------
  sec("T. Testes forjados — alvo oculto e propriedade");
  // mestre cria teste PRIVADO real do personagem A (fluxo legítimo)
  const rPedir = await emitirReal(pgM, "mesa:teste:pedir", { sessionId: sid, characterId: charA, rotulo: "PF-priv-A", dadosCount: 1, visibilidade: "privada", minimo: 12, requestId: "pf-priv-a-1" });
  t("T: mestre pediu teste privado de A (servidor aceitou)", rPedir?.ok === true, JSON.stringify(rPedir).slice(0, 140));
  const idTestePrivA = rPedir?.id;
  await dormir(600);
  t("T/donoA: teste privado próprio aparece (acesso legítimo)", (await nTeste(pgA, "PF-priv-A")) >= 1);
  t("T/mestre: teste privado aparece", (await nTeste(pgM, "PF-priv-A")) >= 1);
  t("T/jogadorB: teste privado de A NÃO aparece", (await nTeste(pgB, "PF-priv-A")) === 0);
  t("T/espectador: teste privado de A NÃO aparece", (await nTeste(pgE, "PF-priv-A")) === 0);
  // alvo oculto: payload forjado com alvo alto para jogador — não renderiza.
  // `target` é o campo que a UI lê para exibir "alvo N" (só mestre).
  const alvoOutro = { A: charB, B: charA, esp: charB };
  for (const [pg, tag] of [[pgA, "A"], [pgB, "B"], [pgE, "esp"]]) {
    await injetar(pg, "mesa:teste", { id: "forge-alvo-1", sessionId: sid, characterId: alvoOutro[tag], characterName: "X", rotulo: "PF2-alvo-forjado", status: "pendente", alvo: 99, target: 99, dados: { lados: 20, count: 1 }, pool: { positivos: 1, negativos: 0, dadosLados: 20 }, visibility: "publica", createdAt: new Date().toISOString() });
  }
  await dormir(300);
  for (const [pg, tag] of [[pgA, "A"], [pgB, "B"], [pgE, "esp"]]) {
    t(`T/${tag}: teste público forjado aparece (evento legítimo)`, (await nTeste(pg, "PF2-alvo-forjado")) >= 1);
    // o alvo=99 NÃO pode aparecer na UI de não-mestre (só mestre vê "alvo N")
    t(`T/${tag}: alvo oculto NÃO renderizado`, !(await temTexto(pg, "alvo 99")));
  }
  t("T/mestre: alvo visível para o mestre (controle)", await (async () => {
    await injetar(pgM, "mesa:teste", { id: "forge-alvo-m", sessionId: sid, characterId: charB, characterName: "PersB", rotulo: "PF2-alvo-mestre", status: "pendente", alvo: 99, target: 99, dados: { lados: 20, count: 1 }, pool: { positivos: 1, negativos: 0, dadosLados: 20 }, visibility: "publica", createdAt: new Date().toISOString() });
    await dormir(300);
    return temTexto(pgM, "alvo 99");
  })());
  // teste privado forjado de OUTRO personagem → rejeitado
  // (para B, "outro" = charA; para A/esp, "outro" = charB)
  for (const [pg, tag] of [[pgA, "A"], [pgB, "B"], [pgE, "esp"]]) {
    await injetar(pg, "mesa:teste", { id: "forge-priv-b", sessionId: sid, characterId: alvoOutro[tag], characterName: "X", rotulo: "PF2-priv-outro", status: "pendente", alvo: 11, dados: { lados: 20, count: 1 }, pool: { positivos: 1, negativos: 0, dadosLados: 20 }, visibility: "privada", privado: true, createdAt: new Date().toISOString() });
  }
  await dormir(300);
  for (const [pg, tag] of [[pgA, "A"], [pgB, "B"], [pgE, "esp"]]) {
    t(`T/${tag}: teste privado de outro personagem rejeitado`, (await nTeste(pg, "PF2-priv-outro")) === 0);
  }
  // visibilidade ausente/inválida em teste → fail-closed
  for (const pg of [pgA, pgB]) {
    await injetar(pg, "mesa:teste", { id: "forge-sem-vis", sessionId: sid, characterId: charA, characterName: "PersA", rotulo: "PF2-teste-sem-vis", status: "pendente", visibility: undefined, createdAt: new Date().toISOString() });
  }
  await dormir(300);
  t("T/A: teste sem visibility rejeitado", (await nTeste(pgA, "PF2-teste-sem-vis")) === 0);

  // ---------- R. Rolagens forjadas ----------
  sec("R. Rolagens forjadas — privadas e userId adulterado");
  // "teste de outro" é relativo a cada página: para B, o teste privado
  // de A (idTestePrivA/charA); para A e esp, o de B (privTB/charB)
  const outroTeste = { A: { testId: privTB, characterId: charB }, B: { testId: idTestePrivA, characterId: charA }, esp: { testId: privTB, characterId: charB } };
  for (const [pg, tag] of [[pgA, "A"], [pgB, "B"], [pgE, "esp"]]) {
    const ot = outroTeste[tag];
    const rollBase = { id: crypto.randomUUID(), testId: ot.testId, characterId: ot.characterId, dados: [7], total: 7, lados: 20, count: 1, rolador: "PF Rolador", visibility: "privada", userId: ids.mestre, createdAt: new Date().toISOString() };
    await injetar(pg, "mesa:rolagem", { ...rollBase, motivo: "PF2-roll-priv-outro" });
    // userId ADULTERADO: pacote diz que o próprio usuário rolei —
    // para rolagem DE TESTE isso não autoriza (só dono/mestre)
    await injetar(pg, "mesa:rolagem", { ...rollBase, id: crypto.randomUUID(), userId: tag === "A" ? ids.ja : tag === "B" ? ids.jb : ids.esp, motivo: "PF2-roll-userid-adul" });
    // characterId inconsistente com o teste conhecido
    await injetar(pg, "mesa:rolagem", { ...rollBase, id: crypto.randomUUID(), characterId: tag === "B" ? charB : charA, motivo: "PF2-roll-char-incons" });
  }
  // rolagem pública legítima → todos veem
  for (const pg of [pgA, pgB, pgE]) {
    await injetar(pg, "mesa:rolagem", { id: crypto.randomUUID(), sessionId: sid, userId: ids.jb, rolador: "PF Rolador", grupos: [{ lados: 20, resultados: [15] }], total: 15, motivo: "PF2-roll-publica-ok", visibility: "publica", createdAt: new Date().toISOString() });
  }
  await dormir(400);
  for (const [pg, tag] of [[pgA, "A"], [pgB, "B"], [pgE, "esp"]]) {
    for (const mk of ["PF2-roll-priv-outro", "PF2-roll-userid-adul", "PF2-roll-char-incons"]) {
      t(`R/${tag}: '${mk}' ausente`, (await page_count(pg, mk)) === 0);
    }
    t(`R/${tag}: rolagem pública legítima visível`, (await page_count(pg, "PF2-roll-publica-ok")) >= 1);
  }

  // ---------- D. Decisões forjadas ----------
  sec("D. Decisões forjadas — propriedade e destinatário");
  // "teste de outro" relativo a cada página (mesmo mapa da seção R)
  const outroDec = { A: { testId: privTB, characterId: charB }, B: { testId: idTestePrivA, characterId: charA }, esp: { testId: privTB, characterId: charB } };
  for (const [pg, tag] of [[pgA, "A"], [pgB, "B"], [pgE, "esp"]]) {
    const od = outroDec[tag];
    const decBase = { testId: od.testId, characterId: od.characterId, characterName: "X", outcome: "sucesso", visibility: "privada", nota: "PF2-nota-priv-outro", decididoPor: "Mestre", createdAt: new Date().toISOString() };
    await injetar(pg, "mesa:decisao", decBase);
    // proprietário adulterado: characterId trocado
    await injetar(pg, "mesa:decisao", { ...decBase, characterId: tag === "B" ? charB : charA, nota: "PF2-nota-adul" });
    // personagem inexistente
    await injetar(pg, "mesa:decisao", { ...decBase, characterId: crypto.randomUUID(), nota: "PF2-nota-inex" });
    // metadados contraditórios: publica + privado:true
    await injetar(pg, "mesa:decisao", { ...decBase, visibility: "publica", privado: true, nota: "PF2-nota-contr" });
    // testeId desconhecido (privada sempre exige teste conhecido)
    await injetar(pg, "mesa:decisao", { ...decBase, testId: crypto.randomUUID(), nota: "PF2-nota-testex" });
  }
  await dormir(400);
  for (const [pg, tag] of [[pgA, "A"], [pgB, "B"], [pgE, "esp"]]) {
    for (const mk of ["PF2-nota-priv-outro", "PF2-nota-adul", "PF2-nota-inex", "PF2-nota-contr", "PF2-nota-testex"]) {
      t(`D/${tag}: '${mk}' ausente da UI`, (await page_count(pg, mk)) === 0);
    }
  }
  // decisão pública legítima aparece
  for (const pg of [pgA, pgB, pgE]) {
    await injetar(pg, "mesa:decisao", { testId: pubT, characterId: charB, characterName: "PersB", outcome: "parcial", nota: "PF2-nota-publica-ok", visibility: "publica", decididoPor: "Mestre", createdAt: new Date().toISOString() });
  }
  await dormir(400);
  for (const [pg, tag] of [[pgA, "A"], [pgB, "B"], [pgE, "esp"]]) {
    t(`D/${tag}: decisão pública legítima visível`, (await page_count(pg, "PF2-nota-publica-ok")) >= 1);
  }

  // ---------- V. Fluxo REAL privado: dono recebe, outros não ----------
  sec("V. Fluxo real — teste/rolagem/decisão privada do dono");
  if (idTestePrivA) {
    const nRollA0 = await nRoll(pgA), nRollB0 = await nRoll(pgB), nRollE0 = await nRoll(pgE), nRollM0 = await nRoll(pgM);
    const rRoll = await emitirReal(pgM, "mesa:teste:rolar", { testId: idTestePrivA, requestId: "pf-roll-a-1" });
    t("V: mestre rolou teste privado de A", rRoll?.ok === true, JSON.stringify(rRoll).slice(0, 140));
    await dormir(800);
    t("V/donoA: rolagem privada do PRÓPRIO teste aparece", (await nRoll(pgA)) > nRollA0);
    t("V/mestre: rolagem privada aparece", (await nRoll(pgM)) > nRollM0);
    t("V/jogadorB: rolagem privada NÃO aparece", (await nRoll(pgB)) === nRollB0);
    t("V/espectador: rolagem privada NÃO aparece", (await nRoll(pgE)) === nRollE0);
    const rDec = await emitirReal(pgM, "mesa:teste:decidir", { testId: idTestePrivA, outcome: "sucesso", nota: "PF-nota-real-priv" });
    t("V: mestre decidiu teste privado", rDec?.ok === true, JSON.stringify(rDec).slice(0, 120));
    await dormir(800);
    t("V/donoA: decisão privada do próprio teste visível (nota integral)", await temTexto(pgA, "PF-nota-real-priv"));
    t("V/mestre: decisão privada visível", await temTexto(pgM, "PF-nota-real-priv"));
    t("V/jogadorB: decisão privada NÃO visível", !(await temTexto(pgB, "PF-nota-real-priv")));
    t("V/espectador: decisão privada NÃO visível", !(await temTexto(pgE, "PF-nota-real-priv")));
  } else {
    t("V: pulado — teste privado não foi criado", false);
  }

  // ---------- A. Pacote atrasado após rebaixamento ----------
  sec("A. Pacote atrasado: mestre rebaixado não herda conteúdo privado");
  // segundo mestre efêmero para o teste de rebaixamento
  const m2 = crypto.randomUUID(), agora3 = Date.now();
  {
    const db2 = abrirDb(BANCO);
    db2.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
      .run(m2, "pf_m2", "PF M2", await hashSenha("senha-forte-123"), agora3, agora3);
    db2.prepare("insert into memberships (id,campaign_id,user_id,role,status,joined_at,created_at,updated_at) values (?,?,?,'mestre','ativo',?,?,?)")
      .run(crypto.randomUUID(), ids.camp, m2, agora3, agora3, agora3);
    db2.close();
  }
  const pgM2 = await contexto("pf_m2", "senha-forte-123", "mestre2");
  // enquanto mestre: pacote privado aparece
  await injetar(pgM2, "mesa:mensagem", { id: crypto.randomUUID(), sessionId: sid, kind: "texto", content: "PF2-atraso-secreta", authorId: ids.ja, visibility: "secreta", createdAt: new Date().toISOString() });
  await dormir(300);
  t("A/m2-mestre: secreta visível enquanto mestre", (await nChat(pgM2, "PF2-atraso-secreta")) === 1);
  // rebaixa m2 → jogador via API real
  const db3 = abrirDb(BANCO);
  const midM2 = db3.prepare("select id from memberships where campaign_id=? and user_id=?").get(ids.camp, m2).id;
  db3.close();
  await req(BASE, "PATCH", `/campaigns/${ids.camp}/members/${midM2}`, { cookie: ids.cookieMestre, body: { role: "jogador" } });
  await dormir(1200); // notificação de permissão + reload do papel
  // pacote atrasado do "passado de mestre" → rejeitado
  await injetar(pgM2, "mesa:mensagem", { id: crypto.randomUUID(), sessionId: sid, kind: "texto", content: "PF2-atraso-secreta-2", authorId: ids.ja, visibility: "secreta", createdAt: new Date().toISOString() });
  // pacote atrasado endereçado a OUTRO (não a ele): privada legítima
  // endereçada ao próprio m2 continuaria visível — o contrato permite
  await injetar(pgM2, "mesa:mensagem", { id: crypto.randomUUID(), sessionId: sid, kind: "texto", content: "PF2-atraso-priv-2", authorId: ids.ja, visibility: "privada", recipients: [ids.ja], createdAt: new Date().toISOString() });
  await dormir(400);
  t("A/m2-rebaixado: secreta atrasada rejeitada", (await nChat(pgM2, "PF2-atraso-secreta-2")) === 0);
  t("A/m2-rebaixado: privada endereçada a ele rejeitada (autor é outro)", (await nChat(pgM2, "PF2-atraso-priv-2")) === 0);

  // ---------- W. Classificação reservada + flag contraditório ----------
  sec("W. mestre/secreta/desconhecida + privado:true NUNCA vira privada");
  // para o dono A, TODO pacote reservado+contraditório deve ser rejeitado;
  // para o mestre, os mesmos tipos seguem visíveis (controle)
  const reservado = [
    ["mestre", "PF3-vis-mestre"],
    ["secreta", "PF3-vis-secreta"],
    ["desconhecida", "PF3-vis-desconhecida"],
    [null, "PF3-vis-nula"],
  ];
  for (const [vis, marker] of reservado) {
    // mesa:teste — personagem do próprio A, mas visibilidade reservada
    await injetar(pgA, "mesa:teste", { id: `forge-${marker}`, sessionId: sid, characterId: charA, characterName: "PersA", rotulo: marker, status: "pendente", alvo: 77, dados: { lados: 20, count: 1 }, visibility: vis, privado: true, createdAt: new Date().toISOString() });
    // mesa:rolagem — sem testId (livre): antes do fix, privado:true+a
    // classificar como privada deixava o dono passar como "rolador"
    await injetar(pgA, "mesa:rolagem", { id: crypto.randomUUID(), sessionId: sid, characterId: charA, userId: ids.ja, rolador: "PF3", grupos: [{ lados: 20, resultados: [3] }], total: 3, motivo: marker, visibility: vis, privado: true, createdAt: new Date().toISOString() });
    // mesa:decisao — com testId conhecido e sem testId
    await injetar(pgA, "mesa:decisao", { testId: pubT, characterId: charB, characterName: "PersB", outcome: "sucesso", nota: `${marker}-dec`, visibility: vis, privado: true, decididoPor: "M", createdAt: new Date().toISOString() });
    await injetar(pgA, "mesa:decisao", { testId: undefined, characterId: charA, outcome: "falha", nota: `${marker}-dec-sem-id`, visibility: vis, privado: true, decididoPor: "M", createdAt: new Date().toISOString() });
  }
  await dormir(500);
  for (const [vis, marker] of reservado) {
    t(`W/A: mesa:teste ${vis ?? "null"}+privado rejeitado`, (await nTeste(pgA, marker)) === 0);
    t(`W/A: mesa:rolagem ${vis ?? "null"}+privado rejeitada`, (await page_count(pgA, marker)) === 0);
    t(`W/A: mesa:decisao ${vis ?? "null"}+privado (com e sem testId) rejeitada`, (await page_count(pgA, `${marker}-dec`)) === 0 && (await page_count(pgA, `${marker}-dec-sem-id`)) === 0);
    // controle: o MESMO pacote é visível para o mestre atual — cada
    // decisão usa o testId do teste forjado DESTA visibilidade (ids
    // únicos, senão a última decisão sobrescreveria a nota da anterior)
    const idTesteM = `forge-m-${marker}`;
    await injetar(pgM, "mesa:teste", { id: idTesteM, sessionId: sid, characterId: charB, characterName: "PersB", rotulo: `${marker}-m`, status: "pendente", alvo: 77, dados: { lados: 20, count: 1 }, visibility: vis, privado: true, createdAt: new Date().toISOString() });
    await injetar(pgM, "mesa:rolagem", { id: crypto.randomUUID(), sessionId: sid, userId: ids.mestre, rolador: "PF3M", grupos: [{ lados: 20, resultados: [9] }], total: 9, motivo: `${marker}-m`, visibility: vis, privado: true, createdAt: new Date().toISOString() });
    // a decisão marca o teste como "decidido" (some da lista de
    // pendentes) — usa um SEGUNDO teste forjado para não esconder o
    // card cujo rótulo está sendo verificado
    await injetar(pgM, "mesa:teste", { id: `forge-d-${marker}`, sessionId: sid, characterId: charB, characterName: "PersB", rotulo: `${marker}-m-dec-t`, status: "pendente", visibility: vis, privado: true, createdAt: new Date().toISOString() });
    await injetar(pgM, "mesa:decisao", { testId: `forge-d-${marker}`, characterId: charB, characterName: "PersB", outcome: "sucesso", nota: `${marker}-m-dec`, visibility: vis, privado: true, decididoPor: "M", createdAt: new Date().toISOString() });
  }
  await dormir(500);
  for (const [vis, marker] of reservado) {
    t(`W/mestre: mesa:teste ${vis ?? "null"} visível (controle)`, (await nTeste(pgM, `${marker}-m`)) >= 1);
    t(`W/mestre: mesa:rolagem ${vis ?? "null"} visível (controle)`, (await page_count(pgM, `${marker}-m`)) >= 1);
    t(`W/mestre: mesa:decisao ${vis ?? "null"} visível (controle)`, (await page_count(pgM, `${marker}-m-dec`)) >= 1);
  }
  // controle preservado: publica + privado:true continua PRIVADA
  // (restrita), não vira pública nem some para o mestre/dono
  await injetar(pgA, "mesa:teste", { id: "forge-pub-priv-w", sessionId: sid, characterId: charA, characterName: "PersA", rotulo: "PF3-pub-priv", status: "pendente", visibility: "publica", privado: true, createdAt: new Date().toISOString() });
  await injetar(pgB, "mesa:teste", { id: "forge-pub-priv-w2", sessionId: sid, characterId: charB, characterName: "PersB", rotulo: "PF3-pub-priv-b", status: "pendente", visibility: "publica", privado: true, createdAt: new Date().toISOString() });
  await dormir(400);
  t("W/A: publica+privado:true do PRÓPRIO personagem visível (privada)", (await nTeste(pgA, "PF3-pub-priv")) >= 1);
  t("W/B: publica+privado:true de B visível para o próprio B", (await nTeste(pgB, "PF3-pub-priv-b")) >= 1);
  t("W/A: publica+privado:true de B NÃO visível para A", (await nTeste(pgA, "PF3-pub-priv-b")) === 0);

  // ---------- erros de console ----------
  sec("Erros de console");
  t("nenhum erro de página/console inesperado", errosConsole.length === 0, errosConsole.slice(0, 5).join(" | "));

} catch (e) {
  fail++;
  console.error("ERRO FATAL", e);
} finally {
  for (const c of ctxs) { try { await c.close(); } catch {} }
  if (browser) await browser.close().catch(() => {});
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
}
console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
