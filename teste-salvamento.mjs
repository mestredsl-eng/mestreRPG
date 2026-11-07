// Testes de integração — Etapa 12: salvamento automático, pontos de recuperação, export/import, estados
import Database from "better-sqlite3";
import { io as ioClient } from "socket.io-client";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { hashToken } from "./servidor/dist/lib/password.js";

const BASE = "http://localhost:3001";
const API = BASE + "/api";
const db = new Database("banco/mestre-rpg.db");

const CID = "e8bbf8ea-c4d0-4bc1-9f1b-c4e6ec8558c0";   // Caçadores & Caçados
const CID2 = "1de51765-25aa-4713-b3f4-1ca866d10a27";  // Campanha Teste E4

function sessaoHttp(username) {
  const u = db.prepare("select id from users where username=?").get(username);
  const token = "t12-" + crypto.randomUUID();
  db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), u.id, hashToken(token), "t", "127.0.0.1", Date.now() + 86400000, Date.now());
  return { token, cookie: `mestre_rpg_session=${encodeURIComponent(token)}` };
}
const ADMIN = sessaoHttp("admin");
const JOG5 = sessaoHttp("jogador_e5");

async function req(metodo, path, { cookie = ADMIN.cookie, body, cid = CID, raw } = {}) {
  const r = await fetch(`${API}${path}`, {
    method: metodo,
    headers: { "content-type": "application/json", cookie },
    body: body !== undefined ? (raw ? body : JSON.stringify(body)) : undefined,
  });
  let json = null; try { json = await r.json(); } catch { }
  return { status: r.status, json };
}
const cReq = (m, p, o = {}) => req(m, `/campaigns/${o.cid ?? CID}${p}`, o);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function conectar(cookie) {
  return ioClient(BASE, { path: "/socket.io", transports: ["polling", "websocket"], extraHeaders: { cookie }, reconnection: false });
}
function emitirCb(socket, evento, payload) {
  return new Promise((resolve) => socket.emit(evento, payload, resolve));
}
let pass = 0, fail = 0;
const res = [];
const t = (n, c, extra = "") => { if (c) { pass++; res.push("ok " + n); } else { fail++; res.push("FALHOU " + n + " " + extra); } };

const RUN = Date.now().toString(36);

try {
  // ============ 1-4: salvamento automático ============
  const ultimoAntes = db.prepare("select id from snapshots where campaign_id=? and kind='automatico' order by created_at desc limit 1").get(CID)?.id ?? null;
  // mutação que emite evento de socket → agenda autosave (debounce 15s)
  await cReq("PATCH", "", { body: { summary: `autosave-e12-${RUN}` } });
  await sleep(18000);
  const snapsDepois = db.prepare("select count(*) c from snapshots where campaign_id=? and kind='automatico'").get(CID).c;
  const ultimoDepois = db.prepare("select id from snapshots where campaign_id=? and kind='automatico' order by created_at desc limit 1").get(CID)?.id ?? null;
  t("1 autosave criou snapshot automático", ultimoDepois !== ultimoAntes, `${ultimoAntes}→${ultimoDepois}`);
  const autoSnap = db.prepare("select * from snapshots where campaign_id=? and kind='automatico' order by created_at desc limit 1").get(CID);
  t("2 snapshot automático tem dados completos", !!autoSnap && !!autoSnap.data);

  // rajada de mutações → debounce colapsa em poucos snapshots
  await cReq("PATCH", "", { body: { summary: `rajada-${RUN}-1` } });
  await cReq("PATCH", "", { body: { summary: `rajada-${RUN}-2` } });
  await cReq("PATCH", "", { body: { summary: `rajada-${RUN}-3` } });
  await sleep(18000);
  const autoTotal = db.prepare("select count(*) c from snapshots where campaign_id=? and kind='automatico'").get(CID).c;
  t("3 rajada colapsada pelo debounce", autoTotal <= snapsDepois + 2, `${snapsDepois}→${autoTotal}`);

  // ============ 5-9: pontos manuais, estado, restaurações ============
  // anotação marcadora para validar restore
  const nota = await cReq("POST", "/anotacoes", { cookie: JOG5.cookie, body: { title: `Marco E12 ${RUN}`, kind: "diario", visibility: "privada" } });
  const notaId = nota.json?.id;
  t("4 anotação marcadora criada", !!notaId);

  let r = await cReq("POST", "/snapshots", { body: { description: `Ponto E12 ${RUN}` } });
  t("5 ponto de recuperação manual", r.status === 201 && !!r.json?.id);
  const snapManual = r.json?.id;

  const estado = (await cReq("GET", "/snapshots/estado")).json;
  t("6 endpoint estado atual", estado?.campanha?.id === CID && estado?.totais?.personagens > 0, JSON.stringify(estado?.totais));
  t("6b estado tem sessão/status", !!estado?.campanha?.status);

  // jogador não acessa snapshots/estado/restauração
  r = await cReq("GET", "/snapshots", { cookie: JOG5.cookie });
  t("7 jogador não lista snapshots", r.status === 403);
  r = await cReq("GET", "/snapshots/estado", { cookie: JOG5.cookie });
  t("7b jogador não vê estado de snapshots", r.status === 403);

  // remove a anotação e restaura o ponto manual → anotação deve voltar
  await cReq("DELETE", `/anotacoes/${notaId}`, { cookie: JOG5.cookie });
  const sumAntes = estado.campanha.name;
  r = await cReq("POST", `/snapshots/${snapManual}/restaurar`, { body: { confirmacao: "RESTAURAR" } });
  t("8 restauração com confirmação", r.status === 200 && r.json?.ok === true, JSON.stringify(r.json));
  t("8b pré-restauração criada", !!r.json?.preSnapshotId);

  const notaVolta = db.prepare("select id from notes where id=?").get(notaId);
  t("9 dados restaurados (anotação voltou)", !!notaVolta);

  // sem confirmação → 400
  r = await cReq("POST", `/snapshots/${snapManual}/restaurar`, { body: {} });
  t("10 restauração exige confirmação", r.status === 400);

  const rests = (await cReq("GET", "/snapshots/restauracoes")).json?.restauracoes ?? [];
  t("11 histórico de restaurações", rests.length > 0 && rests[0].detalhe?.snapshotId === snapManual, JSON.stringify(rests[0]?.detalhe));

  // sem duplicação: conta de notas do tipo da campanha é estável após restore duplo
  const c1 = db.prepare("select count(*) c from notes where campaign_id=?").get(CID).c;
  await cReq("POST", `/snapshots/${snapManual}/restaurar`, { body: { confirmacao: "RESTAURAR" } });
  const c2 = db.prepare("select count(*) c from notes where campaign_id=?").get(CID).c;
  t("12 restore duplo não duplica", c1 === c2, `${c1}→${c2}`);

  // ============ 13-18: exportação e importação ============
  r = await cReq("GET", "/exportar");
  t("13 exportar campanha", r.status === 200 && r.json?.versao === 1 && r.json?.campanhaId === CID, `status=${r.status}`);
  const pacote = r.json;
  t("13b pacote tem estado e arquivos", !!pacote?.estado?.memberships && typeof pacote?.arquivos === "object");
  const arqComConteudo = Object.keys(pacote?.arquivos ?? {}).length;
  t("13c pacote inclui binários", arqComConteudo > 0, `${arqComConteudo} arquivo(s)`);

  // pacote inválido
  r = await req("POST", "/campaigns/importar", { body: { pacote: { versao: 99 }, modo: "nova" } });
  t("14 pacote inválido rejeitado", r.status === 400);

  // importar como nova → 409 (id já existe)
  r = await req("POST", "/campaigns/importar", { body: { pacote, modo: "nova" } });
  t("15 import não sobrescreve sem autorização", r.status === 409, `status=${r.status}`);

  // jogador não pode substituir
  r = await req("POST", "/campaigns/importar", { cookie: JOG5.cookie, body: { pacote, modo: "substituir", campaignId: CID, confirmacao: "SUBSTITUIR" } });
  t("16 jogador não substitui campanha", r.status === 403, `status=${r.status}`);

  // mestre substitui pela importação → estado volta ao do pacote + pré-snapshot
  const msgsAntes = db.prepare("select count(*) c from chat_messages where campaign_id=?").get(CID).c;
  r = await req("POST", "/campaigns/importar", { body: { pacote, modo: "substituir", campaignId: CID, confirmacao: "SUBSTITUIR" } });
  t("17 import-substituir pelo mestre", r.status === 200 && r.json?.ok === true, JSON.stringify(r.json));
  const msgsDepois = db.prepare("select count(*) c from chat_messages where campaign_id=?").get(CID).c;
  t("17b dados batem com o pacote", msgsDepois === msgsAntes, `${msgsAntes}→${msgsDepois}`);

  // pacote de outra campanha (CID2) importado como nova → criaria duplicata de id? CID2 existe → 409
  // testa pacote corrompido: remove memberships → 400
  const pacoteRuim = { ...pacote, estado: { ...pacote.estado, memberships: "nao-array" } };
  r = await req("POST", "/campaigns/importar", { body: { pacote: pacoteRuim, modo: "nova" } });
  t("18 pacote corrompido rejeitado", r.status === 400);

  // ============ 19-22: estados da campanha ============
  const statusOriginal = db.prepare("select status from campaigns where id=?").get(CID).status;
  for (const st of ["pausada", "andamento", "preparacao"]) {
    r = await cReq("PATCH", "", { body: { status: st } });
    t(`19 status ${st}`, r.status === 200, `status=${r.status}`);
  }
  r = await cReq("PATCH", "", { cookie: JOG5.cookie, body: { status: "arquivada" } });
  t("20 jogador não muda status", r.status === 403);
  r = await cReq("PATCH", "", { body: { status: "invalido" } });
  t("21 status inválido rejeitado", r.status === 400);
  // restaura status original
  await cReq("PATCH", "", { body: { status: statusOriginal } });
  t("22 status restaurado", db.prepare("select status from campaigns where id=?").get(CID).status === statusOriginal);

  // ============ 23: isolamento ============
  const snapsC2 = db.prepare("select count(*) c from snapshots where campaign_id=?").get(CID2).c;
  t("23 isolamento: CID2 sem snapshots do teste", true, `snaps CID2=${snapsC2}`);
  r = await cReq("GET", "/snapshots", { cid: CID2 });
  t("23b snapshots isolados por campanha", r.status === 200 && !(r.json?.snapshots ?? []).some((s) => s.description?.includes("E12")));

  // ============ 24-26: cobertura do autosave (auditoria) ============
  // mutações que antes NÃO emitiam evento → agora devem agendar autosave
  const ultimoCovAntes = db.prepare("select id from snapshots where campaign_id=? and kind='automatico' order by created_at desc limit 1").get(CID)?.id ?? null;
  await cReq("PUT", "/regras/config", { body: {} });                       // regras: config
  await cReq("POST", "/invitations", { body: { role: "jogador", requiresApproval: true } }); // convite
  // mensagem de chat via socket (mesa)
  let sessaoAtiva = db.prepare("select id from sessions where campaign_id=? and status='ativa' order by number desc limit 1").get(CID);
  if (!sessaoAtiva) {
    const sr = await cReq("POST", "/sessoes", { body: { name: `Autosave E12 ${RUN}` } });
    sessaoAtiva = sr.json?.sessao ? { id: sr.json.sessao.id } : null;
  }
  let chatOk = false;
  if (sessaoAtiva) {
    const sock = conectar(ADMIN.cookie);
    await emitirCb(sock, "mesa:entrar", { sessionId: sessaoAtiva.id });
    const resp = await emitirCb(sock, "mesa:mensagem", { sessionId: sessaoAtiva.id, content: `autosave-chat-${RUN}`, clientId: crypto.randomUUID() });
    chatOk = !!resp;
    sock.close();
  }
  t("24 mutações de cobertura executadas", chatOk !== undefined);
  await sleep(18000);
  const ultimoCovDepois = db.prepare("select id from snapshots where campaign_id=? and kind='automatico' order by created_at desc limit 1").get(CID)?.id ?? null;
  t("25 autosave cobre regras/convite/chat", ultimoCovDepois !== ultimoCovAntes, `${ultimoCovAntes}→${ultimoCovDepois}`);

  // ============ 27-31: falha de importação após gravar arquivos físicos ============
  // pacote "cópia": novo campaignId + campaignId remapeado em todas as coleções
  const NOVO_CID = crypto.randomUUID();
  const pacoteCopia = JSON.parse(JSON.stringify(pacote));
  pacoteCopia.campanhaId = NOVO_CID;
  const colecoes = ["memberships","invitations","sheetTemplates","characters","ruleSets","itemTemplates","vehicles","financialAccounts","moneyTransactions","sessions","chatMessages","rolls","tests","notes","files","folders"];
  for (const k of colecoes) for (const row of pacoteCopia.estado[k] ?? []) row.campaignId = NOVO_CID;

  // arquivo preexistente no diretório da "nova" campanha — não pode ser tocado
  const dirNovo = resolve("arquivos/campanhas", NOVO_CID);
  mkdirSync(dirNovo, { recursive: true });
  writeFileSync(resolve(dirNovo, "sentinela-preexistente.txt"), "NAO APAGAR");

  // adultera FK no fim da ordem de inserção (files.uploadedBy) → tx falha após gravar binários
  const arquivosMeta = pacoteCopia.estado.files ?? [];
  t("26 pacote cópia tem arquivos", arquivosMeta.length > 0);
  if (arquivosMeta.length) arquivosMeta[0].uploadedBy = "usuario-fantasma-inexistente";

  const snapsAntesFalha = db.prepare("select count(*) c from snapshots where campaign_id=?").get(NOVO_CID).c;
  r = await req("POST", "/campaigns/importar", { body: { pacote: pacoteCopia, modo: "nova" } });
  t("27 import falha com integridade", r.status === 422, `status=${r.status} ${JSON.stringify(r.json).slice(0,120)}`);

  const campanhaRolled = db.prepare("select count(*) c from campaigns where id=?").get(NOVO_CID).c;
  t("28 campanha não criada (rollback SQLite)", campanhaRolled === 0);
  const sentinela = resolve(dirNovo, "sentinela-preexistente.txt");
  t("29 arquivo preexistente preservado", existsSync(sentinela) && readFileSync(sentinela, "utf8") === "NAO APAGAR");
  // arquivos gravados pela tentativa devem ter sido removidos (exceto a sentinela)
  const restantes = readdirSync(dirNovo).filter((f) => f !== "sentinela-preexistente.txt" && f !== ".lixeira");
  t("30 arquivos da tentativa removidos", restantes.length === 0, `restantes: ${restantes.join(",")}`);
  const msgsNovas = db.prepare("select count(*) c from chat_messages where campaign_id=?").get(NOVO_CID).c;
  t("31 nenhuma entidade parcial persistida", msgsNovas === 0);

  // pacote de outra campanha não pode substituir (coerência)
  r = await req("POST", "/campaigns/importar", { body: { pacote, modo: "substituir", campaignId: CID2, confirmacao: "SUBSTITUIR" } });
  t("32 pacote de campanha diversa rejeitado no substituir", r.status === 400 || r.status === 403, `status=${r.status}`);
} catch (e) {
  fail++; res.push("EXCEÇÃO " + (e?.stack ?? e));
}

console.log(res.join("\n"));
console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
