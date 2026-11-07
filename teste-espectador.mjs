// Testes de integração — Etapa 13: modo espectador
import Database from "better-sqlite3";
import { io as ioClient } from "socket.io-client";
import { hashToken } from "./servidor/dist/lib/password.js";

const BASE = "http://localhost:3001";
const API = BASE + "/api";
const db = new Database("banco/mestre-rpg.db");

const CID = "e8bbf8ea-c4d0-4bc1-9f1b-c4e6ec8558c0";   // Caçadores & Caçados
const SID = "266a82d6-1137-49c5-a68a-b7a816d7b845";   // Sessão Timer E8 (ativa)
const CHAR = "fc54075d-6eb0-4692-bff0-b225d404da41";  // personagem T3 (dono: jogador_e5)

function sessaoHttp(username) {
  const u = db.prepare("select id from users where username=?").get(username);
  const token = "t13-" + crypto.randomUUID();
  db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), u.id, hashToken(token), "t", "127.0.0.1", Date.now() + 86400000, Date.now());
  return { token, cookie: `mestre_rpg_session=${encodeURIComponent(token)}` };
}
const ADMIN = sessaoHttp("admin");
const JOG5 = sessaoHttp("jogador_e5");
const ESPEC = sessaoHttp("jogador_teste");   // não é membro — entrará por convite

async function req(metodo, path, { cookie = ADMIN.cookie, body, cid = CID } = {}) {
  const r = await fetch(`${API}/campaigns/${cid}${path}`, {
    method: metodo,
    headers: { "content-type": "application/json", cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { }
  return { status: r.status, json };
}
async function reqAbs(metodo, path, { cookie = ADMIN.cookie, body } = {}) {
  const r = await fetch(`${API}${path}`, {
    method: metodo,
    headers: { "content-type": "application/json", cookie },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { }
  return { status: r.status, json };
}
function conectar(cookie) {
  return ioClient(BASE, { path: "/socket.io", transports: ["polling", "websocket"], extraHeaders: { cookie }, reconnection: false });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function emitirCb(socket, evento, payload) {
  return new Promise((resolve) => socket.emit(evento, payload, resolve));
}
async function esperar(socket, evento, pred = () => true, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout ${evento}`)), timeout);
    const h = (d) => { if (pred(d)) { clearTimeout(t); socket.off(evento, h); resolve(d); } };
    socket.on(evento, h);
  });
}

let pass = 0, fail = 0;
const res = [];
const t = (n, c, extra = "") => { if (c) { pass++; res.push("ok " + n); } else { fail++; res.push("FALHOU " + n + " " + extra); } };

// ---------- 1. Convite de espectador ----------
const inv = await req("POST", "/invitations", { body: { role: "espectador", requiresApproval: false } });
t("1. mestre cria convite de espectador", inv.status === 201 && !!inv.json?.convite?.code, JSON.stringify(inv.json));
const CODE = inv.json?.convite?.code;

const invJogador = await req("POST", "/invitations", { cookie: JOG5.cookie, body: { role: "espectador" } });
t("2. jogador não cria convite", invJogador.status === 403, String(invJogador.status));

const info = await reqAbs("GET", `/convites/${CODE}`, { cookie: ESPEC.cookie });
t("3. convidado vê papel espectador no convite", info.status === 200 && info.json?.campanha?.role === "espectador" || (info.status === 200 && JSON.stringify(info.json).includes("espectador")), JSON.stringify(info.json).slice(0, 200));

const aceite = await reqAbs("POST", `/convites/${CODE}/aceitar`, { cookie: ESPEC.cookie });
t("4. espectador aceita convite e entra ativo", aceite.status === 201 && aceite.json?.status === "ativo", JSON.stringify(aceite.json));

const aceite2 = await reqAbs("POST", `/convites/${CODE}/aceitar`, { cookie: ESPEC.cookie });
t("5. segunda entrada pelo mesmo convite → 409", aceite2.status === 409, String(aceite2.status));

const camp = await req("GET", "", { cookie: ESPEC.cookie });
t("6. espectador acessa dados da campanha", camp.status === 200, String(camp.status));

// membershipId do espectador
const memEsp = db.prepare("select id, role, status, permissions from memberships where campaign_id=? and user_id=(select id from users where username='jogador_teste')").get(CID);
t("7. membership espectador persistida no SQLite", memEsp?.role === "espectador" && memEsp?.status === "ativo", JSON.stringify(memEsp));

// reseta permissões para tornar o teste idempotente entre execuções
db.prepare("update memberships set permissions=? where id=?").run("{}", memEsp.id);

// ---------- 2. Mesa em tempo real ----------
const sEsp = conectar(ESPEC.cookie);
const sAdm = conectar(ADMIN.cookie);
await sleep(300);

const entrar = await emitirCb(sEsp, "mesa:entrar", { sessionId: SID });
t("8. espectador entra na mesa", entrar?.ok === true && entrar?.papel === "espectador", JSON.stringify(entrar));
t("9. podeEnviar=false por padrão", entrar?.podeEnviar === false, JSON.stringify(entrar));

// espectador recebe mensagem pública do mestre
const msgAdm = "msg-publica-" + crypto.randomUUID();
const recebido = esperar(sEsp, "mesa:mensagem", (m) => m?.content === msgAdm, 8000);
await emitirCb(sAdm, "mesa:mensagem", { sessionId: SID, content: msgAdm });
const msgRecebida = await recebido.catch(() => null);
t("10. espectador recebe chat público em tempo real", !!msgRecebida, "timeout");

// sem permissão → mensagem rejeitada
const neg1 = await emitirCb(sEsp, "mesa:mensagem", { sessionId: SID, content: "tentativa " + crypto.randomUUID() });
t("11. espectador sem permissão não envia mensagem", neg1?.ok === false, JSON.stringify(neg1));

// ---------- 3. Permissão individual de chat (mestre configura) ----------
const patchPerm = await req("PATCH", `/members/${memEsp.id}`, { body: { permissions: { enviarMensagens: true } } });
t("12. mestre concede enviarMensagens ao espectador", patchPerm.status === 200, JSON.stringify(patchPerm.json).slice(0, 200));

const patchInvalido = await req("PATCH", `/members/${memEsp.id}`, { body: { permissions: { enviarMensagens: "sim" } } });
t("13. permissão inválida rejeitada", patchInvalido.status === 400, String(patchInvalido.status));

const patchJogador = await req("PATCH", `/members/${memEsp.id}`, { cookie: JOG5.cookie, body: { permissions: { enviarMensagens: false } } });
t("14. jogador não altera permissões de espectador", patchJogador.status === 403, String(patchJogador.status));

// reconecta para recarregar permissões no ctx (ctx é por conexão)
sEsp.disconnect();
const sEsp2 = conectar(ESPEC.cookie);
await sleep(300);
const entrar2 = await emitirCb(sEsp2, "mesa:entrar", { sessionId: SID });
t("15. após permissão, podeEnviar=true", entrar2?.podeEnviar === true, JSON.stringify(entrar2));

const msgEsp = "msg-espectador-" + crypto.randomUUID();
const okMsg = await emitirCb(sEsp2, "mesa:mensagem", { sessionId: SID, content: msgEsp });
t("16. espectador autorizado envia mensagem pública", okMsg?.ok === true, JSON.stringify(okMsg));

const negPriv = await emitirCb(sEsp2, "mesa:mensagem", { sessionId: SID, content: "privada", visibilidade: "privada", destinatarioUserId: "93e49f5a-5456-4066-9096-9ba26277bf51" });
t("17. espectador não envia mensagem privada", negPriv?.ok === false, JSON.stringify(negPriv));

// ---------- 4. Restrições do espectador ----------
const pedirTeste = await emitirCb(sEsp2, "mesa:teste:pedir", { sessionId: SID, characterId: CHAR, rotulo: "força" });
t("18. espectador não solicita teste", pedirTeste?.ok === false, JSON.stringify(pedirTeste));

const rolar = await emitirCb(sEsp2, "mesa:rolar", { sessionId: SID, lados: 20, quantidade: 1 });
t("19. espectador não rola", rolar?.ok === false, JSON.stringify(rolar));

const turno = await emitirCb(sEsp2, "mesa:turno", { sessionId: SID, acao: "proximo" });
t("20. espectador não altera turno", turno?.ok === false, JSON.stringify(turno));

const timer = await emitirCb(sEsp2, "mesa:timer", { sessionId: SID, acao: "iniciar", duracaoSegundos: 60 });
t("21. espectador não controla timer", timer?.ok === false, JSON.stringify(timer));

// personagem/ficha/inventário
const patchChar = await reqAbs("PATCH", `/characters/${CHAR}`, { cookie: ESPEC.cookie, body: { name: "Invadido" } });
t("22. espectador não edita ficha", patchChar.status === 403, String(patchChar.status));

const getChar = await reqAbs("GET", `/characters/${CHAR}`, { cookie: ESPEC.cookie });
t("23. espectador não acessa ficha de personagem", getChar.status === 403, String(getChar.status));

const postItem = await reqAbs("POST", `/characters/${CHAR}/inventario`, { cookie: ESPEC.cookie, body: { name: "espada", quantity: 1 } });
t("24. espectador não altera inventário", postItem.status === 403, String(postItem.status));

const sessaoPost = await req("POST", "/sessoes", { cookie: ESPEC.cookie, body: { name: "x" } });
t("25. espectador não cria sessão", sessaoPost.status === 403 || sessaoPost.status === 404, String(sessaoPost.status));

const snap = await req("POST", "/snapshots", { cookie: ESPEC.cookie, body: { descricao: "x", confirmar: "SNAPSHOT" } });
t("26. espectador não cria snapshot", snap.status === 403, String(snap.status));

const restaurar = await req("POST", "/snapshots/xxx/restaurar", { cookie: ESPEC.cookie, body: { confirmar: "RESTAURAR" } });
t("27. espectador não restaura snapshot", restaurar.status === 403, String(restaurar.status));

const anot = await req("POST", "/anotacoes", { cookie: ESPEC.cookie, body: { titulo: "x", conteudo: "y" } });
t("28. espectador não cria anotação", anot.status === 403 || anot.status === 400 || anot.status === 404, String(anot.status));

const upload = await fetch(`${API}/campaigns/${CID}/arquivos/upload`, {
  method: "POST", headers: { cookie: ESPEC.cookie, "content-type": "application/octet-stream", "x-file-name": "esp.txt" }, body: "x",
});
t("29. espectador não faz upload", upload.status === 403, String(upload.status));

// ---------- 5. Leituras permitidas ----------
const sessoes = await req("GET", "/sessoes", { cookie: ESPEC.cookie });
t("30. espectador lista sessões", sessoes.status === 200, String(sessoes.status));

const hist = await req("GET", `/sessoes/${SID}/historico`, { cookie: ESPEC.cookie });
t("31. espectador consulta histórico permitido", hist.status === 200, String(hist.status));

const msgs = await req("GET", `/sessoes/${SID}/mensagens`, { cookie: ESPEC.cookie });
t("32. espectador lê mensagens filtradas", msgs.status === 200, String(msgs.status));

const estado = await req("GET", `/sessoes/${SID}/estado`, { cookie: ESPEC.cookie });
t("33. espectador lê estado da sessão", estado.status === 200, String(estado.status));

const arquivos = await req("GET", "/arquivos", { cookie: ESPEC.cookie });
t("34. espectador lista biblioteca autorizada", arquivos.status === 200, String(arquivos.status));
const nomes = (arquivos.json?.arquivos ?? []).map((f) => f.fileName ?? f.file_name);
t("35. espectador não vê arquivo do mestre", !nomes.includes("regras.pdf") && !nomes.includes("segredo.txt"), nomes.join(","));
t("36. espectador vê arquivo público", nomes.includes("mapa.png") || nomes.includes("aviso.txt"), nomes.join(","));

// ---------- 6. Permissões individuais: histórico e biblioteca ----------
const patchHist = await req("PATCH", `/members/${memEsp.id}`, { body: { permissions: { verHistorico: false, verBiblioteca: false } } });
t("37. mestre revoga histórico e biblioteca", patchHist.status === 200, JSON.stringify(patchHist.json).slice(0, 150));

const histNeg = await req("GET", `/sessoes/${SID}/historico`, { cookie: ESPEC.cookie });
t("38. espectador sem verHistorico → 403", histNeg.status === 403, String(histNeg.status));

const arqNeg = await req("GET", "/arquivos", { cookie: ESPEC.cookie });
t("39. espectador sem verBiblioteca → 403", arqNeg.status === 403, String(arqNeg.status));

// ---------- 7. Controle do mestre: promover, remover, bloquear, revogar ----------
// promover jogador a espectador
const memJog5 = db.prepare("select id from memberships where campaign_id=? and user_id=(select id from users where username='jogador_e5')").get(CID);
const promo = await req("PATCH", `/members/${memJog5.id}`, { body: { role: "espectador" } });
t("40. mestre promove jogador a espectador", promo.status === 200, JSON.stringify(promo.json).slice(0, 150));
const roleDepois = db.prepare("select role from memberships where id=?").get(memJog5.id);
t("41. papel persistido como espectador", roleDepois?.role === "espectador", JSON.stringify(roleDepois));
// restaura jogador_e5
await req("PATCH", `/members/${memJog5.id}`, { body: { role: "jogador" } });

// bloquear espectador
const bloq = await req("PATCH", `/members/${memEsp.id}`, { body: { status: "bloqueado" } });
t("42. mestre bloqueia espectador", bloq.status === 200, String(bloq.status));
const entrarBloq = await emitirCb(conectar(ESPEC.cookie), "mesa:entrar", { sessionId: SID });
t("43. espectador bloqueado não entra na mesa", entrarBloq?.ok === false, JSON.stringify(entrarBloq));
const campBloq = await req("GET", "", { cookie: ESPEC.cookie });
t("44. espectador bloqueado não acessa campanha", campBloq.status === 403, String(campBloq.status));

// desbloqueia e remove
await req("PATCH", `/members/${memEsp.id}`, { body: { status: "ativo" } });
const rem = await req("PATCH", `/members/${memEsp.id}`, { body: { status: "removido" } });
t("45. mestre remove espectador", rem.status === 200, String(rem.status));
const entrarRem = await emitirCb(conectar(ESPEC.cookie), "mesa:entrar", { sessionId: SID });
t("46. espectador removido não entra na mesa", entrarRem?.ok === false, JSON.stringify(entrarRem));

// revogar convite
const convs = await req("GET", "/invitations", {});
const conviteId = convs.json?.convites?.find?.((c) => c.id === inv.json?.convite?.id)?.id ?? inv.json?.convite?.id;
const rev = await req("PATCH", `/invitations/${conviteId}`, { body: { action: "revogar" } });
t("47. mestre revoga convite", rev.status === 200, JSON.stringify(rev.json).slice(0, 150));

// reentrada por convite revogado → 410
const aceite3 = await reqAbs("POST", `/convites/${CODE}/aceitar`, { cookie: ESPEC.cookie });
t("48. convite revogado não permite reentrada", aceite3.status === 410 || aceite3.status === 409, String(aceite3.status));

sEsp2.disconnect(); sAdm.disconnect();

console.log(res.join("\n"));
console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
