// Testes de integração — Etapa 15 Fase 2: bloqueio/remoção de membros
// Cobre V1 (HTTP personagem/patrimônio), V2 (entrar-campanha) e V3 (expulsão de rooms).
import Database from "better-sqlite3";
import { io as ioClient } from "socket.io-client";
import { hashToken } from "./servidor/dist/lib/password.js";

const BASE = "http://localhost:3001";
const API = BASE + "/api";
const db = new Database("banco/mestre-rpg.db");

function sessaoHttp(username) {
  const u = db.prepare("select id from users where username=?").get(username);
  if (!u) throw new Error("usuário inexistente: " + username);
  const token = "t15-" + crypto.randomUUID();
  db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), u.id, hashToken(token), "t", "127.0.0.1", Date.now() + 86400000, Date.now());
  return { token, cookie: `mestre_rpg_session=${encodeURIComponent(token)}` };
}
const ADMIN = sessaoHttp("admin");

async function req(metodo, path, { cookie = ADMIN.cookie, body } = {}) {
  const r = await fetch(`${API}${path}`, {
    method: metodo,
    signal: AbortSignal.timeout(15000),
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
  return Promise.race([
    new Promise((resolve) => socket.emit(evento, payload, resolve)),
    sleep(8000).then(() => ({ __timeout: true })),
  ]);
}
function aguardarEvento(socket, evento, ms = 1500) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { socket.off(evento, h); resolve(null); }, ms);
    const h = (d) => { clearTimeout(t); socket.off(evento, h); resolve(d); };
    socket.on(evento, h);
  });
}
async function esperarConexao(socket) {
  if (socket.connected) return;
  await Promise.race([
    new Promise((res, rej) => { socket.once("connect", res); socket.once("connect_error", rej); }),
    sleep(8000).then(() => { throw new Error("timeout connect"); }),
  ]);
}

let pass = 0, fail = 0;
const res = [];
const t = (n, c, extra = "") => { if (c) { pass++; res.push("ok " + n); } else { fail++; res.push("FALHOU " + n + " " + extra); } console.error((c ? "ok " : "FALHOU ") + n + (extra ? " — " + extra : "")); };

// ---------- setup ----------
for (const [username, display] of [["jog_bloqueio", "Jogador Bloqueio"], ["mest_bloqueio", "Mestre Bloqueio"]]) {
  const r = await req("POST", "/admin/users", { body: { username, displayName: display, password: "senha-teste-123" } });
  if (r.status !== 201 && r.status !== 409) throw new Error("falha ao criar " + username + ": " + r.status);
}
const JOG = sessaoHttp("jog_bloqueio");
const MESTRE2 = sessaoHttp("mest_bloqueio");

const camp = await req("POST", "/campaigns", { body: { name: "Teste Bloqueio Etapa15", system: "teste" } });
t("0. admin cria campanha de teste", camp.status === 201, JSON.stringify(camp.json).slice(0, 200));
const CID = camp.json?.campanha?.id;
if (!CID) { console.log(res.join("\n")); process.exit(1); }

async function convitePara(cookie) {
  const inv = await req("POST", `/campaigns/${CID}/invitations`, { body: { role: "jogador", requiresApproval: false } });
  const code = inv.json?.convite?.code;
  const acc = await req("POST", `/convites/${code}/aceitar`, { cookie });
  return acc.status;
}
t("1. jogadores aceitam convites", (await convitePara(JOG.cookie)) === 201 && (await convitePara(MESTRE2.cookie)) === 201);

const membros = (await req("GET", `/campaigns/${CID}/members`)).json?.membros ?? [];
const memJog = membros.find((m) => m.username === "jog_bloqueio");
const memM2 = membros.find((m) => m.username === "mest_bloqueio");
t("2. memberships localizadas", !!memJog && !!memM2);

// mest_bloqueio vira segundo mestre
const promo = await req("PATCH", `/campaigns/${CID}/members/${memM2.membershipId}`, { body: { role: "mestre" } });
t("3. segundo mestre promovido", promo.status === 200, String(promo.status));

// personagem do jogador (insert direto — ficha exige template publicado)
const CHAR = crypto.randomUUID();
const agora = Date.now();
db.prepare("insert into characters (id,campaign_id,membership_id,name,data,overrides,status,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
  .run(CHAR, CID, memJog.membershipId, "Herói Bloqueio", "{}", "{}", "rascunho", agora, agora);

// sessão de mesa para testes de socket
const ses = await req("POST", `/campaigns/${CID}/sessoes`, { body: {} });
const SID = ses.json?.sessao?.id ?? ses.json?.id;
t("4. sessão de mesa criada", !!SID, JSON.stringify(ses.json).slice(0, 200));

// sockets
const sockAdmin = conectar(ADMIN.cookie);
const sockJog = conectar(JOG.cookie);
await Promise.all([esperarConexao(sockAdmin), esperarConexao(sockJog)]);
await emitirCb(sockAdmin, "entrar-campanha", CID);
await emitirCb(sockJog, "entrar-campanha", CID);

// ---------- baseline: membro ativo funciona ----------
const g1 = await req("GET", `/characters/${CHAR}`, { cookie: JOG.cookie });
t("5. ativo lê próprio personagem", g1.status === 200, String(g1.status));
const gi1 = await req("GET", `/characters/${CHAR}/inventario`, { cookie: JOG.cookie });
t("6. ativo lê inventário", gi1.status === 200, String(gi1.status));
const p1 = await req("PATCH", `/characters/${CHAR}`, { cookie: JOG.cookie, body: { name: "Herói Bloqueio" } });
t("7. ativo edita personagem", p1.status === 200, String(p1.status));

const entrarAtivo = await emitirCb(sockJog, "entrar-campanha", CID);
t("8. ativo entra na room da campanha", entrarAtivo === true, String(entrarAtivo));
const mesaOk = await emitirCb(sockJog, "mesa:entrar", { sessionId: SID });
t("9. ativo entra na mesa", mesaOk?.ok === true, JSON.stringify(mesaOk));

// evento positivo: membros:atualizados chega ao ativo
let jogRecebeu = false;
sockJog.on("membros:atualizados", () => { jogRecebeu = true; });
await req("PATCH", `/campaigns/${CID}/members/${memJog.membershipId}`, { body: { permissions: {} } });
await sleep(400);
t("10. ativo recebe eventos da campanha", jogRecebeu === true);

// mestre ativo vê personagem de terceiro
const gm2 = await req("GET", `/characters/${CHAR}`, { cookie: MESTRE2.cookie });
t("11. mestre ativo lê personagem de outro", gm2.status === 200, String(gm2.status));

// ---------- bloqueio ----------
const bloq = await req("PATCH", `/campaigns/${CID}/members/${memJog.membershipId}`, { body: { status: "bloqueado" } });
t("12. mestre bloqueia jogador", bloq.status === 200, String(bloq.status));

const g2 = await req("GET", `/characters/${CHAR}`, { cookie: JOG.cookie });
t("13. bloqueado → 403 no personagem", g2.status === 403, String(g2.status));
const gi2 = await req("GET", `/characters/${CHAR}/inventario`, { cookie: JOG.cookie });
t("14. bloqueado → 403 no inventário", gi2.status === 403, String(gi2.status));
const gv2 = await req("GET", `/characters/${CHAR}/veiculos`, { cookie: JOG.cookie });
t("15. bloqueado → 403 nos veículos", gv2.status === 403, String(gv2.status));
const gf2 = await req("GET", `/characters/${CHAR}/financeiro`, { cookie: JOG.cookie });
t("16. bloqueado → 403 no financeiro", gf2.status === 403, String(gf2.status));
const p2 = await req("PATCH", `/characters/${CHAR}`, { cookie: JOG.cookie, body: { name: "Invadido" } });
t("17. bloqueado → 403 ao editar", p2.status === 403, String(p2.status));

const entrarBloq = await emitirCb(sockJog, "entrar-campanha", CID);
t("18. bloqueado não entra na room (entrar-campanha)", entrarBloq === false, String(entrarBloq));
const mesaBloq = await emitirCb(sockJog, "mesa:entrar", { sessionId: SID });
t("19. bloqueado não entra na mesa", mesaBloq?.ok === false, JSON.stringify(mesaBloq));

// socket já conectado não recebe mais eventos da campanha
jogRecebeu = false;
const pAdmin = aguardarEvento(sockAdmin, "membros:atualizados", 2000);
await req("PATCH", `/campaigns/${CID}/members/${memJog.membershipId}`, { body: { permissions: {} } });
const jogEvt = await aguardarEvento(sockJog, "membros:atualizados", 1200);
const admEvt = await pAdmin;
t("20. bloqueado não recebe membros:atualizados", jogEvt === null, JSON.stringify(jogEvt));
t("21. outros membros continuam recebendo", admEvt !== null);

// mensagem de mesa não chega ao bloqueado (expulso da room sessao:)
let jogMsg = false;
sockJog.on("mesa:mensagem", () => { jogMsg = true; });
await emitirCb(sockAdmin, "mesa:entrar", { sessionId: SID });
await emitirCb(sockAdmin, "mesa:mensagem", { sessionId: SID, content: "ping bloqueio" });
await sleep(600);
t("22. bloqueado não recebe mesa:mensagem", jogMsg === false);
const msgBloq = await emitirCb(sockJog, "mesa:mensagem", { sessionId: SID, content: "tentativa" });
t("23. bloqueado não envia mesa:mensagem", msgBloq?.ok === false, JSON.stringify(msgBloq));

// ---------- pendente ----------
await req("PATCH", `/campaigns/${CID}/members/${memJog.membershipId}`, { body: { status: "pendente" } });
const gp = await req("GET", `/characters/${CHAR}`, { cookie: JOG.cookie });
t("24. pendente → 403 no personagem", gp.status === 403, String(gp.status));
const entrarPend = await emitirCb(sockJog, "entrar-campanha", CID);
t("25. pendente não entra na room", entrarPend === false, String(entrarPend));

// ---------- restaura ativo ----------
await req("PATCH", `/campaigns/${CID}/members/${memJog.membershipId}`, { body: { status: "ativo" } });
const g3 = await req("GET", `/characters/${CHAR}`, { cookie: JOG.cookie });
t("26. reativado volta a acessar", g3.status === 200, String(g3.status));
const entrarVolta = await emitirCb(sockJog, "entrar-campanha", CID);
t("27. reativado entra na room novamente", entrarVolta === true, String(entrarVolta));

// ---------- mestre bloqueado ----------
await req("PATCH", `/campaigns/${CID}/members/${memM2.membershipId}`, { body: { status: "bloqueado" } });
const gm2b = await req("GET", `/characters/${CHAR}`, { cookie: MESTRE2.cookie });
t("28. mestre bloqueado → 403 em personagem alheio", gm2b.status === 403, String(gm2b.status));
await req("PATCH", `/campaigns/${CID}/members/${memM2.membershipId}`, { body: { status: "ativo" } });
const gm2c = await req("GET", `/characters/${CHAR}`, { cookie: MESTRE2.cookie });
t("29. mestre reativado volta a acessar", gm2c.status === 200, String(gm2c.status));

// ---------- remoção ----------
const del = await req("DELETE", `/campaigns/${CID}/members/${memJog.membershipId}`);
t("30. mestre remove jogador", del.status === 200, String(del.status));
const g4 = await req("GET", `/characters/${CHAR}`, { cookie: JOG.cookie });
t("31. removido → 403 no personagem", g4.status === 403, String(g4.status));
jogRecebeu = false;
const pAdmin2 = aguardarEvento(sockAdmin, "membros:atualizados", 2000);
await req("PATCH", `/campaigns/${CID}/members/${memM2.membershipId}`, { body: { permissions: {} } });
const jogEvt2 = await aguardarEvento(sockJog, "membros:atualizados", 1200);
await pAdmin2;
t("32. removido não recebe eventos", jogEvt2 === null);
const entrarRem = await emitirCb(sockJog, "entrar-campanha", CID);
t("33. removido não entra na room", entrarRem === false, String(entrarRem));

// ---------- limpeza ----------
// Nota: usuários de teste são mantidos (delete falha por FK em chat_messages.author_id
// quando o usuário já enviou mensagens — limitação pré-existente do DELETE /admin/users).
sockAdmin.close(); sockJog.close();
console.log(res.join("\n"));
console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
