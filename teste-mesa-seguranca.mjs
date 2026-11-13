// Segurança da mesa multiplayer — Socket.IO (PR #37).
// Cenário: mestre + jogador + espectador (com e sem permissão de chat)
// + usuário externo sem vínculo. Cobre entrada negada, ações exclusivas
// do mestre, privacidade de mensagens, reconexão sem presença duplicada,
// sessão inválida, saída sem eventos posteriores e idempotência.
import { io as ioClient } from "socket.io-client";
import crypto from "node:crypto";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, comDb, abrirDb, sessao, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("mesa-seg");
const BANCO = `${DIR}/teste.db`;
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc, ids, sid;
const sockets = [];

function conectar(cookie) {
  const token = decodeURIComponent(cookie.split("=")[1]);
  const s = ioClient(BASE, {
    path: "/socket.io", transports: ["websocket", "polling"],
    extraHeaders: { cookie: `mestre_rpg_session=${encodeURIComponent(token)}` },
    reconnection: false,
  });
  sockets.push(s);
  return s;
}
const pronto = (s) => new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
const emitirCb = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));
function esperar(socket, evento, timeout = 8000, pred) {
  return new Promise((resolve, reject) => {
    const h = (d) => { if (pred && !pred(d)) return; clearTimeout(to); socket.off(evento, h); resolve(d); };
    const to = setTimeout(() => { socket.off(evento, h); reject(new Error(`timeout ${evento}`)); }, timeout);
    socket.on(evento, h);
  });
}
const msgContent = (d) => d?.content ?? "";

// usuário sintético direto no banco (sem login HTTP — sessão via cookie)
function novoUsuario(banco, { username, role = null, permissions = {} }) {
  const db = abrirDb(banco);
  try {
    const uid = crypto.randomUUID(), agora = Date.now();
    db.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
      .run(uid, username, username, "x", agora, agora);
    let mid = null;
    if (role) {
      mid = crypto.randomUUID();
      db.prepare("insert into memberships (id,campaign_id,user_id,role,status,permissions,joined_at,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
        .run(mid, ids.camp, uid, role, "ativo", JSON.stringify(permissions), agora, agora, agora);
    }
    return { id: uid, membershipId: mid, cookie: sessao(banco, uid) };
  } finally { db.close(); }
}

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
  proc.stderr.on("data", () => {});
  await esperarSaudavel(BASE, proc);

  const c = await criarCenario(BASE, BANCO, { jogadores: { jogador1: "seg_j1" } });
  ids = { admin: c.adminId, j1: c.jogadores.jogador1.id, camp: c.campId };

  // espectador sem permissão de mensagem + espectador COM permissão + externo
  const esp = novoUsuario(BANCO, { username: "seg_esp", role: "espectador", permissions: {} });
  const espMsg = novoUsuario(BANCO, { username: "seg_esp_msg", role: "espectador", permissions: { enviarMensagens: true } });
  const externo = novoUsuario(BANCO, { username: "seg_externo", role: null });

  // sessão de mesa
  const sess = await req(BASE, "POST", `/campaigns/${ids.camp}/sessoes`, { cookie: c.cookieMestre, body: { name: "Mesa Seg" } });
  sid = sess.json?.sessao?.id ?? sess.json?.id;
  t("sessão criada", !!sid, JSON.stringify(sess.json).slice(0, 160));

  const sockM = conectar(c.cookieMestre);
  const sockJ1 = conectar(c.jogadores.jogador1.cookie);
  const sockEsp = conectar(esp.cookie);
  const sockEspMsg = conectar(espMsg.cookie);
  const sockExt = conectar(externo.cookie);
  await Promise.all([pronto(sockM), pronto(sockJ1), pronto(sockEsp), pronto(sockEspMsg), pronto(sockExt)]);

  sec("entrada e autorização");
  const rM = await emitirCb(sockM, "mesa:entrar", { sessionId: sid });
  const rJ1 = await emitirCb(sockJ1, "mesa:entrar", { sessionId: sid });
  const rEsp = await emitirCb(sockEsp, "mesa:entrar", { sessionId: sid });
  const rEspMsg = await emitirCb(sockEspMsg, "mesa:entrar", { sessionId: sid });
  const rExt = await emitirCb(sockExt, "mesa:entrar", { sessionId: sid });
  t("mestre/jogador/espectadores entram", rM.ok && rJ1.ok && rEsp.ok && rEspMsg.ok);
  t("externo sem vínculo → entrar negado", rExt.ok === false, JSON.stringify(rExt));

  // entrar-campanha (room campanha:) também deve negar externo
  const entrouCampanha = await new Promise((res) => sockExt.emit("entrar-campanha", ids.camp, res));
  t("externo não entra na room da campanha", entrouCampanha === false, String(entrouCampanha));

  sec("ações exclusivas do mestre");
  const rTurnoJ = await emitirCb(sockJ1, "mesa:turno", { sessionId: sid, acao: "iniciar", ordem: ["x"] });
  t("jogador não controla turno", rTurnoJ?.ok === false, JSON.stringify(rTurnoJ));
  const rTimerJ = await emitirCb(sockJ1, "mesa:timer", { sessionId: sid, acao: "iniciar", duracaoSegundos: 60 });
  t("jogador não controla timer", rTimerJ?.ok === false, JSON.stringify(rTimerJ));
  const rPedirJ = await emitirCb(sockJ1, "mesa:teste:pedir", { sessionId: sid, characterId: c.personagemMestre, rotulo: "x" });
  t("jogador não pede teste", rPedirJ?.ok === false, JSON.stringify(rPedirJ).slice(0, 140));

  sec("chat e privacidade");
  const rEspMsgNeg = await emitirCb(sockEsp, "mesa:mensagem", { sessionId: sid, content: "esp sem perm", visibilidade: "publica" });
  t("espectador sem permissão → mensagem negada", rEspMsgNeg?.ok === false, JSON.stringify(rEspMsgNeg));
  const rEspMsgOk = await emitirCb(sockEspMsg, "mesa:mensagem", { sessionId: sid, content: "esp com perm", visibilidade: "publica" });
  t("espectador com permissão → pública ok", rEspMsgOk?.ok === true, JSON.stringify(rEspMsgOk));
  const rEspPriv = await emitirCb(sockEspMsg, "mesa:mensagem", { sessionId: sid, content: "x", visibilidade: "privada", destinatarioUserId: ids.j1 });
  t("espectador não envia privada", rEspPriv?.ok === false, JSON.stringify(rEspPriv));

  // privada J1 → J1? melhor: mestre → J1 privada; J2... temos só j1. Use mestre→j1 privada e verificamos que espectador não recebe.
  let espViu = false, j1Viu = false;
  const hEsp = (d) => { if (/priv-j1/.test(msgContent(d))) espViu = true; };
  const hJ1 = (d) => { if (/priv-j1/.test(msgContent(d))) j1Viu = true; };
  sockEspMsg.on("mesa:mensagem", hEsp); sockEsp.on("mesa:mensagem", hEsp);
  sockJ1.on("mesa:mensagem", hJ1);
  const rPriv = await emitirCb(sockM, "mesa:mensagem", { sessionId: sid, content: "priv-j1", visibilidade: "privada", destinatarioUserId: ids.j1 });
  t("mestre envia privada", rPriv?.ok === true, JSON.stringify(rPriv));
  await new Promise((r) => setTimeout(r, 600));
  t("destinatário recebeu privada", j1Viu);
  t("espectadores NÃO receberam privada", !espViu);

  sec("idempotência");
  const clientId = crypto.randomUUID();
  const ouvinteJ1 = esperar(sockJ1, "mesa:mensagem", 8000, (d) => /msg-dup/.test(msgContent(d)));
  const rDup1 = await emitirCb(sockJ1, "mesa:mensagem", { sessionId: sid, content: "msg-dup", clientId });
  const rDup2 = await emitirCb(sockJ1, "mesa:mensagem", { sessionId: sid, content: "msg-dup", clientId });
  const recebidas = [];
  sockJ1.on("mesa:mensagem", (d) => { if (/msg-dup/.test(msgContent(d))) recebidas.push(d.id); });
  await ouvinteJ1;
  await new Promise((r) => setTimeout(r, 500));
  const totalNoBanco = comDbCount();
  t("mesmo clientId não duplica no banco", totalNoBanco === 1, `count=${totalNoBanco} r1=${JSON.stringify(rDup1)} r2=${JSON.stringify(rDup2)}`);

  sec("reconexão e sessão");
  // presença: reconectar mesmo usuário não duplica
  const presAntes = await emitirCb(sockM, "mesa:entrar", { sessionId: sid });
  sockJ1.disconnect();
  await new Promise((r) => setTimeout(r, 400));
  const sockJ1b = conectar(c.jogadores.jogador1.cookie);
  await pronto(sockJ1b);
  const rRecon = await emitirCb(sockJ1b, "mesa:entrar", { sessionId: sid });
  t("reconexão entra ok", rRecon.ok === true, JSON.stringify(rRecon).slice(0, 120));
  const online = rRecon.presenca ?? [];
  const contagemJ1 = online.filter((x) => x === ids.j1).length;
  t("presença sem duplicata do mesmo usuário", contagemJ1 <= 1, JSON.stringify(online));

  // sessão inválida: cookie adulterado não autentica socket
  const tokenFake = "token-inexistente-" + crypto.randomUUID();
  const falhouAuth = await new Promise((res) => {
    const s = ioClient(BASE, { path: "/socket.io", transports: ["websocket"], extraHeaders: { cookie: `mestre_rpg_session=${tokenFake}` }, reconnection: false });
    s.on("connect", () => { s.disconnect(); res("conectou"); });
    s.on("connect_error", () => res("negado"));
    setTimeout(() => res("timeout"), 6000);
  });
  t("cookie inválido não autentica", falhouAuth === "negado" || falhouAuth === "timeout", falhouAuth);

  sec("saída sem eventos posteriores");
  const sockJ1c = sockJ1b;
  await emitirCb(sockJ1c, "mesa:sair", { sessionId: sid });
  let j1RecebeuDepois = false;
  sockJ1c.on("mesa:mensagem", (d) => { if (/apos-saida/.test(msgContent(d))) j1RecebeuDepois = true; });
  await emitirCb(sockM, "mesa:mensagem", { sessionId: sid, content: "apos-saida teste", visibilidade: "publica" });
  await new Promise((r) => setTimeout(r, 700));
  t("após mesa:sair não recebe eventos da sessão", !j1RecebeuDepois);
} finally {
  for (const s of sockets) { try { s.disconnect(); } catch {} }
  await encerrarServidor(proc);
  limparDir(DIR);
}

function comDbCount() {
  const db = abrirDb(BANCO);
  try { return db.prepare("select count(*) n from chat_messages where content='msg-dup'").get().n; }
  finally { db.close(); }
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
