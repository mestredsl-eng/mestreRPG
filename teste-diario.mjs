// Testes de integração — Etapa 11: diário, anotações do mestre, anexos e histórico de sessões
// Isolado (Lote 1): banco SQLite, uploads e backups vivem em diretórios
// temporários via teste-base.mjs — nenhum acesso a banco/mestre-rpg.db,
// usuários, campanhas ou arquivos reais.
import { join, resolve, sep } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  encerrarServidor, limparDir, req as reqBase, criarCenario, comDb, abrirDb, sessao,
} from "./teste-base.mjs";

const RAIZ = dirTeste("diario");
const BANCO = join(RAIZ, "banco", "mestre-rpg.db");
const ARQUIVOS = join(RAIZ, "arquivos", "campanhas");
const BACKUPS = join(RAIZ, "backups");

let pass = 0, fail = 0;
const res = [];
const t = (n, c, extra = "") => { if (c) { pass++; res.push("ok " + n); } else { fail++; res.push("FALHOU " + n + " " + extra); } };

const RUN = Date.now().toString(36);
let proc = null;
let BASE = "";

// Buffers limitados dos pipes do servidor: stdout/stderr são consumidos
// continuamente (senão o pipe enche e o processo filho bloqueia) e só as
// últimas linhas são retidas para diagnóstico em caso de falha.
const LOG_LIMITE = 200;
const logsServidor = { out: [], err: [] };
function consumirStream(stream, destino) {
  if (!stream) return;
  let resto = "";
  stream.on("data", (chunk) => {
    resto += String(chunk);
    const linhas = resto.split("\n");
    resto = linhas.pop() ?? "";
    for (const l of linhas) {
      if (l.trim()) { destino.push(l); if (destino.length > LOG_LIMITE) destino.shift(); }
    }
  });
}
function despejarLogs() {
  const cauda = (arr) => arr.slice(-15).join("\n");
  if (logsServidor.err.length) console.log("--- stderr do servidor (cauda) ---\n" + cauda(logsServidor.err));
  if (logsServidor.out.length) console.log("--- stdout do servidor (cauda) ---\n" + cauda(logsServidor.out));
}

// Lista SOMENTE arquivos regulares (Dirent.isFile) — readdirSync
// recursivo também retorna diretórios e não serve para contagem.
function arquivosRegulares(dir, prefixo = "") {
  const saida = [];
  let entradas;
  try { entradas = readdirSync(dir, { withFileTypes: true, recursive: true }); }
  catch { return saida; }
  for (const e of entradas) {
    if (!e.isFile()) continue;
    const rel = e.parentPath ? join(e.parentPath, e.name).slice(dir.length + 1) : e.name;
    saida.push(prefixo + rel);
  }
  return saida;
}

try {
  await prepararBanco(BANCO);
  const porta = await portaLivre();
  BASE = `http://127.0.0.1:${porta}`;
  proc = subirServidor(porta, { banco: BANCO, arquivos: ARQUIVOS, backups: BACKUPS });
  consumirStream(proc.stdout, logsServidor.out);
  consumirStream(proc.stderr, logsServidor.err);
  await esperarSaudavel(BASE, proc);

  const ids = await criarCenario(BASE, BANCO, {
    jogadores: { jog5: "jogador_cinco", jog2: "jogador_dois" },
  });
  const CID = ids.campId;
  const ADMIN = { cookie: ids.cookieMestre };
  const JOG5 = { cookie: ids.jogadores.jog5.cookie };
  const JOG2 = { cookie: ids.jogadores.jog2.cookie };
  const uJ5 = ids.jogadores.jog5.id;
  const uJ2 = ids.jogadores.jog2.id;
  const CHAR = ids.novoPersonagem(ids.jogadores.jog5.membershipId, "P5 Diário");

  const req = (metodo, path, { cookie = ADMIN.cookie, body } = {}) =>
    reqBase(BASE, metodo, `/campaigns/${CID}${path}`, { cookie, body });

  // ============ 1-6: diário do jogador ============
  let r = await req("POST", "/anotacoes", { cookie: JOG5.cookie, body: { title: `Diario E11 ${RUN}`, content: "encontrei uma pista", category: "pista", characterId: CHAR, kind: "diario", visibility: "privada" } });
  t("1 criar anotação no diário", r.status === 201, JSON.stringify(r.json));
  const notaId = r.json?.id;

  r = await req("PATCH", `/anotacoes/${notaId}`, { cookie: JOG5.cookie, body: { content: "pista confirmada", important: true } });
  t("2 editar anotação", r.status === 200);

  // privacidade: jogador2 não vê diário privado de jogador5
  let lista = (await req("GET", "/anotacoes?tipo=diario", { cookie: JOG2.cookie })).json?.anotacoes ?? [];
  t("3 diário privado não vaza", !lista.some((a) => a.id === notaId));

  // compartilhar com mestre
  r = await req("PATCH", `/anotacoes/${notaId}`, { cookie: JOG5.cookie, body: { visibility: "mestre" } });
  t("4 compartilhar com mestre", r.status === 200);
  lista = (await req("GET", "/anotacoes?tipo=diario", { cookie: ADMIN.cookie })).json?.anotacoes ?? [];
  t("4b mestre vê compartilhada", lista.some((a) => a.id === notaId));

  // compartilhamento seletivo com jogador2
  r = await req("PATCH", `/anotacoes/${notaId}`, { cookie: JOG5.cookie, body: { visibility: "selecionada", recipients: [uJ2] } });
  t("5 compartilhar com selecionado", r.status === 200, JSON.stringify(r.json));
  lista = (await req("GET", "/anotacoes?tipo=diario", { cookie: JOG2.cookie })).json?.anotacoes ?? [];
  t("5b selecionado recebe", lista.some((a) => a.id === notaId));

  // personagem errado é rejeitado
  r = await req("POST", "/anotacoes", { cookie: JOG5.cookie, body: { title: "x", kind: "diario", characterId: "inexistente" } });
  t("6 characterId inválido rejeitado", r.status === 400);

  // ============ 7-12: anotações do mestre ============
  r = await req("POST", "/anotacoes", { cookie: ADMIN.cookie, body: { title: `Mestre E11 ${RUN}`, content: "segredo do mestre", kind: "mestre", category: "misterio", visibility: "privada" } });
  t("7 mestre cria anotação privada", r.status === 201);
  const notaMestre = r.json?.id;

  lista = (await req("GET", "/anotacoes?tipo=mestre", { cookie: JOG5.cookie })).json?.anotacoes ?? [];
  t("8 jogador não vê nota privada do mestre", !lista.some((a) => a.id === notaMestre));

  // jogador tenta criar nota de mestre → 403
  r = await req("POST", "/anotacoes", { cookie: JOG5.cookie, body: { title: "fake", kind: "mestre" } });
  t("9 jogador não cria nota de mestre", r.status === 403);

  // mestre compartilha com jogador selecionado
  r = await req("PATCH", `/anotacoes/${notaMestre}`, { cookie: ADMIN.cookie, body: { visibility: "selecionada", recipients: [uJ5] } });
  t("10 mestre compartilha selecionado", r.status === 200);
  lista = (await req("GET", "/anotacoes?tipo=mestre", { cookie: JOG5.cookie })).json?.anotacoes ?? [];
  t("10b jogador selecionado vê", lista.some((a) => a.id === notaMestre));
  lista = (await req("GET", "/anotacoes?tipo=mestre", { cookie: JOG2.cookie })).json?.anotacoes ?? [];
  t("10c não selecionado não vê", !lista.some((a) => a.id === notaMestre));

  // ============ 13-18: anexos ============
  // arquivo privado do mestre (visibility=mestre) e arquivo público
  const upPriv = await fetch(`${BASE}/api/campaigns/${CID}/arquivos/upload`, {
    method: "POST", headers: { cookie: ADMIN.cookie, "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("segredo-mestre.txt"), "x-file-mime": "text/plain", "x-visibility": "mestre" },
    body: Buffer.from("segredo"),
  });
  const filePriv = (await upPriv.json())?.id;
  const upPub = await fetch(`${BASE}/api/campaigns/${CID}/arquivos/upload`, {
    method: "POST", headers: { cookie: ADMIN.cookie, "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("mapa-e11.txt"), "x-file-mime": "text/plain", "x-visibility": "publica" },
    body: Buffer.from("mapa"),
  });
  const filePub = (await upPub.json())?.id;
  t("13 uploads de anexo criados",
    upPriv.status === 201 && upPub.status === 201
      && typeof filePriv === "string" && filePriv.length > 0
      && typeof filePub === "string" && filePub !== filePriv,
    `${upPriv.status}/${upPub.status} ids=${filePriv}/${filePub}`);

  // registros + arquivos físicos dos DOIS uploads, confinados ao temp
  const dirCampanha = join(ARQUIVOS, CID);
  const metaUploads = comDb(BANCO, (db) => ({
    priv: db.prepare("select storage_name from files where id=?").get(filePriv),
    pub: db.prepare("select storage_name from files where id=?").get(filePub),
  }));
  const snOk = (sn) => typeof sn === "string" && sn.length > 0
    && !sn.includes("..") && !sn.includes("/") && !sn.includes("\\");
  const fisicoDe = (sn) => snOk(sn) ? resolve(dirCampanha, sn) : "";
  const confinadoEm = (p) => p && existsSync(p) && resolve(p).startsWith(resolve(dirCampanha) + sep);
  t("13b registros de upload no banco temporário com storage_name seguro",
    snOk(metaUploads.priv?.storage_name) && snOk(metaUploads.pub?.storage_name)
      && metaUploads.priv.storage_name !== metaUploads.pub.storage_name,
    JSON.stringify(metaUploads));
  t("13c dois arquivos físicos reais dentro do diretório temporário da campanha",
    confinadoEm(fisicoDe(metaUploads.priv?.storage_name)) && confinadoEm(fisicoDe(metaUploads.pub?.storage_name))
      && fisicoDe(metaUploads.priv?.storage_name) !== fisicoDe(metaUploads.pub?.storage_name)
      && arquivosRegulares(dirCampanha).length >= 2,
    `priv=${metaUploads.priv?.storage_name} pub=${metaUploads.pub?.storage_name}`);

  // anexa arquivo público à nota do jogador
  r = await req("POST", `/anotacoes/${notaId}/anexos`, { cookie: JOG5.cookie, body: { fileId: filePub } });
  t("14 anexar arquivo à anotação", r.status === 201, JSON.stringify(r.json));

  // jogador NÃO pode anexar arquivo privado do mestre
  r = await req("POST", `/anotacoes/${notaId}/anexos`, { cookie: JOG5.cookie, body: { fileId: filePriv } });
  t("15 anexo de arquivo invisível rejeitado", r.status === 403, `status=${r.status}`);

  // lista traz o anexo
  lista = (await req("GET", "/anotacoes?tipo=diario", { cookie: JOG5.cookie })).json?.anotacoes ?? [];
  const notaLista = lista.find((a) => a.id === notaId);
  t("16 anexo aparece na listagem", (notaLista?.anexos ?? []).some((a) => a.fileId === filePub), JSON.stringify(notaLista?.anexos));

  // remove anexo
  r = await req("DELETE", `/anotacoes/${notaId}/anexos/${filePub}`, { cookie: JOG5.cookie });
  t("17 remover anexo", r.status === 200);
  lista = (await req("GET", "/anotacoes?tipo=diario", { cookie: JOG5.cookie })).json?.anotacoes ?? [];
  t("17b anexo sumiu", !(lista.find((a) => a.id === notaId)?.anexos ?? []).length);

  // upload direto com x-note-id (mestre anexa à própria nota)
  const upAnexo = await fetch(`${BASE}/api/campaigns/${CID}/arquivos/upload`, {
    method: "POST", headers: { cookie: ADMIN.cookie, "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("anexo-nota.txt"), "x-file-mime": "text/plain", "x-visibility": "publica", "x-note-id": notaMestre },
    body: Buffer.from("conteudo anexo"),
  });
  t("18 upload com x-note-id", upAnexo.status === 201, `status=${upAnexo.status}`);
  lista = (await req("GET", "/anotacoes?tipo=mestre", { cookie: ADMIN.cookie })).json?.anotacoes ?? [];
  t("18b anexo criado via upload", (lista.find((a) => a.id === notaMestre)?.anexos ?? []).length === 1);

  // ============ 19-24: histórico de sessões ============
  r = await req("POST", "/sessoes", { cookie: ADMIN.cookie, body: { name: `Sessão E11 ${RUN}` } });
  const sid = r.json?.sessao?.id;
  const numSessao = r.json?.sessao?.number;
  t("19 criar sessão", r.status === 201 && !!sid);

  // gera uma alteração auditável dentro da sessão (resumo pelo mestre)
  await req("PATCH", `/sessoes/${sid}`, { cookie: ADMIN.cookie, body: { summary: "resumo e11" } });
  r = await req("PATCH", `/sessoes/${sid}`, { cookie: ADMIN.cookie, body: { status: "encerrada" } });
  t("20 encerrar sessão", r.status === 200);

  const hist = (await req("GET", `/sessoes/${sid}/historico`, { cookie: JOG5.cookie })).json;
  t("21 histórico tem número da sessão", hist?.sessao?.number === numSessao && numSessao > 0);
  t("22 histórico tem datas e duração", !!hist?.sessao?.startedAt && !!hist?.sessao?.endedAt && hist?.duracaoMs >= 0, `dur=${hist?.duracaoMs}`);
  t("23 histórico tem resumo", hist?.resumo === "resumo e11");
  t("24 histórico tem alterações relevantes", Array.isArray(hist?.alteracoes) && hist.alteracoes.length > 0, JSON.stringify(hist?.alteracoes?.map((a) => a.action)));
  t("24b jogador não vê detalhe interno das alterações", hist?.alteracoes?.every((a) => a.detalhe === undefined));

  const histM = (await req("GET", `/sessoes/${sid}/historico`, { cookie: ADMIN.cookie })).json;
  t("24c mestre vê detalhe das alterações", histM?.alteracoes?.some((a) => a.detalhe !== undefined));

  // ============ 25-28: integridade, isolamento, persistência ============
  // isolamento: anotação de OUTRA campanha com o mesmo título não aparece
  const camp2 = await reqBase(BASE, "POST", "/campaigns", { cookie: ADMIN.cookie, body: { name: "Campanha Isolada" } });
  const CID2 = camp2.json?.campanha?.id;
  t("25a segunda campanha criada para o teste de isolamento",
    camp2.status === 201 && typeof CID2 === "string" && CID2.length > 0,
    `status=${camp2.status} id=${CID2}`);
  if (CID2) {
    const w = abrirDb(BANCO);
    try {
      w.prepare(
        "insert into notes (id,campaign_id,owner_id,kind,title,content,created_at,updated_at) values (?,?,?,?,?,?,?,?)"
      ).run(crypto.randomUUID(), CID2, uJ5, "diario", `Diario E11 ${RUN}`, "nota de outra campanha", Date.now(), Date.now());
    } finally { w.close(); }
  }
  lista = (await req("GET", "/anotacoes?tipo=todas", { cookie: JOG5.cookie })).json?.anotacoes ?? [];
  t("25 isolamento entre campanhas", !lista.some((a) => a.title === `Diario E11 ${RUN}` && a.campaignId === CID2));

  // persistência direta no banco temporário
  comDb(BANCO, (db) => {
    const rowNota = db.prepare("select * from notes where id=?").get(notaId);
    const rowAtt = db.prepare("select count(*) c from note_attachments where note_id=?").get(notaMestre).c;
    t("26 registros persistidos no SQLite", !!rowNota && rowNota.kind === "diario" && rowAtt === 1, `atts=${rowAtt}`);
  });

  // nota de mestre continua privada para jogador2 via API (mesmo forçando id)
  r = await req("GET", "/anotacoes?tipo=todas", { cookie: JOG2.cookie });
  t("27 nota mestre não vaza p/ não selecionado", !(r.json?.anotacoes ?? []).some((a) => a.id === notaMestre));

  // excluir anotação (dono)
  r = await req("DELETE", `/anotacoes/${notaId}`, { cookie: JOG5.cookie });
  t("28 excluir anotação do diário", r.status === 200);
  lista = (await req("GET", "/anotacoes?tipo=diario", { cookie: JOG5.cookie })).json?.anotacoes ?? [];
  t("28b anotação removida", !lista.some((a) => a.id === notaId));

  // ============ 29-31: regressões de anexos ============
  // anexo em anotação inexistente → 404
  r = await req("POST", "/anotacoes/nota-inexistente/anexos", { cookie: JOG5.cookie, body: { fileId: filePub } });
  t("29 anexo em anotação inexistente rejeitado", r.status === 404, `status=${r.status}`);
  // jogador não anexa arquivo na nota de outro dono → 403
  r = await req("POST", `/anotacoes/${notaMestre}/anexos`, { cookie: JOG5.cookie, body: { fileId: filePub } });
  t("29b anexo em nota alheia rejeitado", r.status === 403, `status=${r.status}`);
  // arquivo inexistente → 404
  r = await req("POST", `/anotacoes/${notaMestre}/anexos`, { cookie: ADMIN.cookie, body: { fileId: "arquivo-inexistente" } });
  t("29c anexo de arquivo inexistente rejeitado", r.status === 404, `status=${r.status}`);
  // nome de arquivo hostil não escapa do diretório temporário
  const upHostil = await fetch(`${BASE}/api/campaigns/${CID}/arquivos/upload`, {
    method: "POST", headers: { cookie: ADMIN.cookie, "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("../../fora-do-temp.txt"), "x-file-mime": "text/plain", "x-visibility": "publica" },
    body: Buffer.from("hostil"),
  });
  const hostilJson = await upHostil.json();
  const hostilId = hostilJson?.id;
  t("29d upload com nome hostil não quebra nem vaza", upHostil.status === 201 && !!hostilId, `status=${upHostil.status}`);
  // Prova real: o nome enviado pelo cliente NÃO controla o caminho físico.
  // storageName é gerado no servidor (<uuid>.<ext>); o arquivo tem que
  // existir dentro do diretório temporário da campanha e nenhum arquivo
  // chamado "fora-do-temp.txt" pode ter sido criado em lugar algum.
  const rowHostil = hostilId
    ? comDb(BANCO, (db) => db.prepare("select storage_name,file_name from files where id=?").get(hostilId))
    : null;
  const sn = rowHostil?.storage_name ?? "";
  const fisico = sn ? resolve(ARQUIVOS, CID, sn) : "";
  const storageSeguro = !!sn && !sn.includes("..") && !sn.includes("/") && !sn.includes("\\");
  const confinado = storageSeguro && existsSync(fisico)
    && resolve(fisico).startsWith(resolve(ARQUIVOS) + sep);
  const semArquivoFora = !readdirSync(RAIZ, { recursive: true })
    .some((f) => typeof f === "string" && f.endsWith("fora-do-temp.txt"));
  t("29e nome hostil não controla o caminho físico",
    !!rowHostil && storageSeguro && confinado && semArquivoFora,
    JSON.stringify({ storageName: sn, fileName: rowHostil?.file_name, fisico }));
  // ============ Issue #164 — config.notas.espectadorLeCompartilhadas ============
  // Espectador sintético: usuário + membership direto no banco; cookie de
  // sessão real via sessao() — mesmo caminho de autenticação dos demais.
  const uEsp = crypto.randomUUID();
  {
    const w = abrirDb(BANCO); const agora = Date.now();
    w.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
      .run(uEsp, "espectador_teste", "Espectador Teste", "sem-login", agora, agora);
    w.prepare("insert into memberships (id,campaign_id,user_id,role,status,joined_at,created_at,updated_at) values (?,?,?,'espectador','ativo',?,?,?)")
      .run(crypto.randomUUID(), CID, uEsp, agora, agora, agora);
    w.close();
  }
  const COOKIE_ESP = sessao(BANCO, uEsp);

  const setFlagEsp = (v) => {
    const w = abrirDb(BANCO);
    const rs = w.prepare("select id, config from rule_sets where campaign_id=? and is_active=1").get(CID);
    const cfg = JSON.parse(rs?.config || "{}");
    cfg.notas = { ...(cfg.notas ?? {}), espectadorLeCompartilhadas: v };
    w.prepare("update rule_sets set config=? where id=?").run(JSON.stringify(cfg), rs.id);
    w.close();
  };
  const idsAnot = async (cookie) =>
    (await req("GET", "/anotacoes?tipo=todas", { cookie })).json?.anotacoes?.map((a) => a.id) ?? [];
  const criarNota = async (title, visibility, recipients) => {
    const rr = await req("POST", "/anotacoes", { body: { title, kind: "diario", visibility, ...(recipients ? { recipients } : {}) } });
    return rr.json?.id;
  };

  // Cinco notas cobrindo as 4 visibilidades + selecionada com destinatário
  // correto (espectador) e incorreto (jogador dois) para o espectador.
  const N_PRIV = await criarNota(`E164 privada ${RUN}`, "privada");
  const N_MST = await criarNota(`E164 mestre ${RUN}`, "mestre");
  const N_PUB = await criarNota(`E164 publica ${RUN}`, "publica");
  const N_SEL_OK = await criarNota(`E164 sel-esp ${RUN}`, "selecionada", [uEsp]);
  const N_SEL_ERR = await criarNota(`E164 sel-j2 ${RUN}`, "selecionada", [uJ2]);
  const N_J5 = await (async () => {
    const rr = await req("POST", "/anotacoes", { cookie: JOG5.cookie, body: { title: `E164 j5 ${RUN}`, kind: "diario", visibility: "privada" } });
    return rr.json?.id;
  })();
  t("164-00 notas da matriz criadas", [N_PRIV, N_MST, N_PUB, N_SEL_OK, N_SEL_ERR, N_J5].every(Boolean));

  const tem = (ids, id) => ids.includes(id);
  const vis = async (cookie) => {
    const r = await req("GET", "/anotacoes?tipo=todas", { cookie });
    return { status: r.status, ids: (r.json?.anotacoes ?? []).map((a) => a.id), lista: r.json?.anotacoes ?? [] };
  };

  // ---------- flag LIGADA (default true) ----------
  setFlagEsp(true);
  let vM = await vis(ADMIN.cookie), vJ5 = await vis(JOG5.cookie), vJ2 = await vis(JOG2.cookie), vE = await vis(COOKIE_ESP);
  t("164-01 flag on: mestre vê as 5 notas da matriz",
    [N_PRIV, N_MST, N_PUB, N_SEL_OK, N_SEL_ERR].every((id) => tem(vM.ids, id)), JSON.stringify(vM.ids));
  t("164-02 flag on: ehMinha preservada para o dono (mestre)",
    vM.lista.find((a) => a.id === N_PUB)?.ehMinha === true);
  t("164-03 flag on: jogador vê só a pública (sem destinatário)",
    tem(vJ5.ids, N_PUB) && ![N_PRIV, N_MST, N_SEL_OK, N_SEL_ERR].some((id) => tem(vJ5.ids, id)), JSON.stringify(vJ5.ids));
  t("164-04 flag on: jog2 vê pública + selecionada destinada a ele",
    tem(vJ2.ids, N_PUB) && tem(vJ2.ids, N_SEL_ERR) && ![N_PRIV, N_MST, N_SEL_OK].some((id) => tem(vJ2.ids, id)), JSON.stringify(vJ2.ids));
  t("164-05 flag on: espectador vê pública + selecionada destinada a ele",
    vE.status === 200 && tem(vE.ids, N_PUB) && tem(vE.ids, N_SEL_OK)
    && ![N_PRIV, N_MST, N_SEL_ERR].some((id) => tem(vE.ids, id)), JSON.stringify(vE.ids));
  t("164-06 flag on: privada do jogador invisível até para o mestre",
    !tem(vM.ids, N_J5) && tem(vJ5.ids, N_J5)
    && vJ5.lista.find((a) => a.id === N_J5)?.ehMinha === true);

  // ---------- flag DESLIGADA ----------
  setFlagEsp(false);
  vM = await vis(ADMIN.cookie); vJ5 = await vis(JOG5.cookie); vJ2 = await vis(JOG2.cookie); vE = await vis(COOKIE_ESP);
  t("164-07 flag off: espectador não recebe nenhuma nota compartilhada",
    vE.status === 200 && ![N_PRIV, N_MST, N_PUB, N_SEL_OK, N_SEL_ERR].some((id) => tem(vE.ids, id)), JSON.stringify(vE.ids));
  t("164-08 flag off: mestre inalterado (vê as 5)",
    [N_PRIV, N_MST, N_PUB, N_SEL_OK, N_SEL_ERR].every((id) => tem(vM.ids, id)));
  t("164-09 flag off: jogador inalterado (vê a pública)",
    tem(vJ5.ids, N_PUB));
  t("164-10 flag off: jog2 inalterado (pública + selecionada dele)",
    tem(vJ2.ids, N_PUB) && tem(vJ2.ids, N_SEL_ERR));
  const espPost = await req("POST", "/anotacoes", { cookie: COOKIE_ESP, body: { title: "x", kind: "diario", visibility: "publica" } });
  t("164-11 flag off: escrita de espectador segue bloqueada (403)", espPost.status === 403, String(espPost.status));
  const espPatch = await req("PATCH", `/anotacoes/${N_PUB}`, { cookie: COOKIE_ESP, body: { title: "invadir" } });
  t("164-12 flag off: espectador não edita anotação alheia", espPatch.status === 403 || espPatch.status === 404, String(espPatch.status));

  // devolve flag ao default para não contaminar o restante do arquivo
  setFlagEsp(true);
  vE = await vis(COOKIE_ESP);
  t("164-13 flag restaurada: espectador volta a ver compartilhadas",
    tem(vE.ids, N_PUB) && tem(vE.ids, N_SEL_OK));


  // ============ Issue #171 — bypasses de PATCH com compartilhamento off ============
  {
    const setFlagCompartilha = (v) => {
      const w = abrirDb(BANCO);
      const rs = w.prepare("select id, config from rule_sets where campaign_id=? and is_active=1").get(CID);
      const cfg = JSON.parse(rs?.config || "{}");
      cfg.notas = { ...(cfg.notas ?? {}), jogadorCompartilha: v };
      w.prepare("update rule_sets set config=? where id=?").run(JSON.stringify(cfg), rs.id);
      w.close();
    };
    const notaDe = async (id, cookie) => {
      const r = await req("GET", "/anotacoes?tipo=todas", { cookie });
      return (r.json?.anotacoes ?? []).find((a) => a.id === id);
    };

    // Flag LIGADA: o jogador cria as notas da matriz de bypass.
    setFlagCompartilha(true);
    const mkJ = async (title, visibility, extra = {}) =>
      (await req("POST", "/anotacoes", { cookie: JOG5.cookie, body: { title, kind: "diario", visibility, ...extra } })).json?.id;
    const J_PUB = await mkJ(`E171 pub ${RUN}`, "publica");
    const J_SEL = await mkJ(`E171 sel ${RUN}`, "selecionada", { recipients: [uJ2] });
    const J_PRIV = await mkJ(`E171 priv ${RUN}`, "privada");
    const J_KIND = await mkJ(`E171 kind ${RUN}`, "privada");
    const A_KIND = (await req("POST", "/anotacoes", { body: { title: `E171 mestre ${RUN}`, kind: "diario", visibility: "privada" } })).json?.id;
    t("171-00 notas da matriz criadas", [J_PUB, J_SEL, J_PRIV, J_KIND, A_KIND].every(Boolean));
    setFlagCompartilha(false);

    // B1 — PATCH de conteúdo em nota pública própria → 403 (antes: 200).
    const b1 = await req("PATCH", `/anotacoes/${J_PUB}`, { cookie: JOG5.cookie, body: { content: "editado" } });
    t("171-01 B1: PATCH {content} em pública → 403", b1.status === 403, String(b1.status));
    // Rebaixar para privada NO MESMO PATCH → 200; some para o outro jogador.
    const b2 = await req("PATCH", `/anotacoes/${J_PUB}`, { cookie: JOG5.cookie, body: { content: "editado", visibility: "privada" } });
    t("171-02 rebaixa pública p/ privada no mesmo PATCH → 200", b2.status === 200, String(b2.status));
    const lstJ2 = await req("GET", "/anotacoes?tipo=todas", { cookie: JOG2.cookie });
    t("171-03 nota rebaixada não aparece p/ outro jogador", !(lstJ2.json?.anotacoes ?? []).some((a) => a.id === J_PUB));
    const nPub = await notaDe(J_PUB, JOG5.cookie);
    t("171-04 visibilidade persistida = privada", nPub?.visibility === "privada", String(nPub?.visibility));

    // B2 — recipients em nota selecionada → 403 em qualquer variação.
    const b3 = await req("PATCH", `/anotacoes/${J_SEL}`, { cookie: JOG5.cookie, body: { recipients: [uJ2] } });
    t("171-05 B2: PATCH {recipients} em selecionada → 403", b3.status === 403, String(b3.status));
    const b4 = await req("PATCH", `/anotacoes/${J_SEL}`, { cookie: JOG5.cookie, body: { recipients: [] } });
    t("171-06 zerar destinatários em selecionada → 403", b4.status === 403, String(b4.status));
    const b5 = await req("PATCH", `/anotacoes/${J_SEL}`, { cookie: JOG5.cookie, body: { content: "só texto" } });
    t("171-07 PATCH {content} em selecionada → 403", b5.status === 403, String(b5.status));
    const b6 = await req("PATCH", `/anotacoes/${J_SEL}`, { cookie: JOG5.cookie, body: { visibility: "selecionada", recipients: [uJ2] } });
    t("171-08 PATCH visibility selecionada + recipients → 403", b6.status === 403, String(b6.status));
    // Rebaixar selecionada → privada limpa o compartilhamento.
    const b7 = await req("PATCH", `/anotacoes/${J_SEL}`, { cookie: JOG5.cookie, body: { visibility: "privada" } });
    t("171-09 rebaixa selecionada p/ privada → 200", b7.status === 200, String(b7.status));
    const nSel = await notaDe(J_SEL, JOG5.cookie);
    t("171-10 selecionada rebaixada fica privada", nSel?.visibility === "privada", String(nSel?.visibility));

    // B3 — kind "mestre" via PATCH: jogador 403, mestre 200.
    const b8 = await req("PATCH", `/anotacoes/${J_KIND}`, { cookie: JOG5.cookie, body: { kind: "mestre" } });
    t("171-11 B3: jogador PATCH kind=mestre → 403", b8.status === 403, String(b8.status));
    const lstMestreJ5 = await req("GET", "/anotacoes?tipo=mestre", { cookie: JOG5.cookie });
    t("171-12 kind permanece diario (não aparece em tipo=mestre)", !(lstMestreJ5.json?.anotacoes ?? []).some((a) => a.id === J_KIND));
    const b9 = await req("PATCH", `/anotacoes/${A_KIND}`, { body: { kind: "mestre" } });
    t("171-13 mestre PATCH kind=mestre → 200", b9.status === 200, String(b9.status));

    // Nota privada segue editável com a flag desligada.
    const b10 = await req("PATCH", `/anotacoes/${J_PRIV}`, { cookie: JOG5.cookie, body: { content: "edit privado ok" } });
    t("171-14 PATCH em nota privada → 200", b10.status === 200, String(b10.status));

    // Flag LIGADA: fluxos compartilhados legítimos seguem funcionando.
    setFlagCompartilha(true);
    const b11 = await req("PATCH", `/anotacoes/${J_PRIV}`, { cookie: JOG5.cookie, body: { visibility: "publica" } });
    t("171-15 flag on: privada → pública → 200", b11.status === 200, String(b11.status));
    const b12 = await req("PATCH", `/anotacoes/${J_PRIV}`, { cookie: JOG5.cookie, body: { content: "segue pública" } });
    t("171-16 flag on: PATCH conteúdo em pública → 200", b12.status === 200, String(b12.status));
    // Mestre é isento mesmo com a flag desligada.
    setFlagCompartilha(false);
    const b13 = await req("PATCH", `/anotacoes/${A_KIND}`, { body: { content: "mestre edita compartilhada" } });
    t("171-17 flag off: mestre edita normalmente → 200", b13.status === 200, String(b13.status));
    setFlagCompartilha(true);
  }
} catch (e) {
  fail++; res.push("EXCEÇÃO " + (e?.stack ?? e));
} finally {
  // Limpeza garantida: falha ao encerrar o servidor NÃO impede a
  // tentativa de remover o diretório temporário. Falhas de teardown
  // são registradas e tornam o teste não-zero via exitCode.
  let teardownFalhou = false;
  try {
    await encerrarServidor(proc);
  } catch (e) {
    teardownFalhou = true;
    res.push("TEARDOWN servidor: " + (e?.message ?? e));
  }
  try {
    if (!limparDir(RAIZ)) teardownFalhou = true;
  } catch (e) {
    teardownFalhou = true;
    res.push("TEARDOWN limpeza: " + (e?.message ?? e));
  }
  if (teardownFalhou) fail++;
  if (fail > 0) despejarLogs();
  console.log(res.join("\n"));
  console.log(`\n${pass} passaram, ${fail} falharam`);
  process.exitCode = fail ? 1 : 0;
}
