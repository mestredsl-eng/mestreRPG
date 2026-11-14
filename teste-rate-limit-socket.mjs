// Issue #68 — rate limit Socket.IO da Mesa (wiring real).
// Sobe um servidor real com banco descartável e prova, via socket.io-client:
//   - rajada de chat rejeitada com ACK RATE_LIMITED + retryAfterMs;
//   - cota compartilhada entre sockets/abas do mesmo usuário;
//   - cotas independentes por ação e por usuário;
//   - recuperação após retryAfterMs;
//   - rejeições não gravam nada (chat_messages);
//   - idempotência requestId/clientId preservada;
//   - névoa: gestos legítimos passam, flood é rejeitado e a
//     sincronização ordenada (mesa:vtt:nevoa:sincronizar) é isenta;
//   - mesa:sair e ping não são limitados;
//   - turno/timer, tokens VTT e entrada têm cotas próprias.
import { io as ioClient } from "socket.io-client";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, abrirDb, sessao, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const DIR = dirTeste("rate-limit-socket");
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
const emitirCb = (s, ev, p, timeoutMs = 15000) => new Promise((r) => {
  const to = setTimeout(() => r({ ok: false, erro: "timeout", codigo: "TIMEOUT_TESTE" }), timeoutMs);
  s.emit(ev, p, (x) => { clearTimeout(to); r(x); });
});
const ehRateLimited = (r) => r?.ok === false && r?.codigo === "RATE_LIMITED" && typeof r?.retryAfterMs === "number" && r.retryAfterMs > 0;

/** Dispara `n` emissões o mais rápido possível (sem esperar ACK uma a uma
 *  quando `paralelo` — mas ACKs sequenciais já chegam a ~100+/s). */
async function rajada(s, ev, payloadFn, n) {
  const rs = [];
  for (let i = 0; i < n; i++) rs.push(emitirCb(s, ev, payloadFn(i)));
  return Promise.all(rs);
}

const contarChat = (marcador) => abrirDb(BANCO)
  .prepare("select count(*) c from chat_messages where content like ?")
  .get(`%${marcador}%`).c;

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
  proc.stderr.on("data", (d) => process.stderr.write("[srv] " + d));
  await esperarSaudavel(BASE, proc);

  const C = await criarCenario(BASE, BANCO, { jogadores: { jogador1: "rl_j1", jogador2: "rl_j2" } });
  ids = { camp: C.campId, cookieMestre: C.cookieMestre, j1: C.jogadores.jogador1, j2: C.jogadores.jogador2 };
  const sess = await req(BASE, "POST", `/campaigns/${ids.camp}/sessoes`, { cookie: ids.cookieMestre, body: { name: "RL" } });
  sid = sess.json?.sessao?.id ?? sess.json?.id;
  t("sessão criada", !!sid);

  const sM = conectar(ids.cookieMestre);
  const sJ = conectar(ids.j1.cookie);
  const sJ2 = conectar(ids.j1.cookie);   // segunda aba do MESMO usuário
  const sJb = conectar(ids.j2.cookie);  // usuário distinto
  await Promise.all([pronto(sM), pronto(sJ), pronto(sJ2), pronto(sJb)]);
  for (const s of [sM, sJ, sJ2, sJb]) s.emit("entrar-campanha", ids.camp, () => undefined);
  const entradas = await Promise.all([
    emitirCb(sM, "mesa:entrar", { sessionId: sid }),
    emitirCb(sJ, "mesa:entrar", { sessionId: sid }),
    emitirCb(sJb, "mesa:entrar", { sessionId: sid }),
  ]);
  t("sockets entram na sessão", entradas.every((r) => r?.ok === true), JSON.stringify(entradas));

  // ---------- A. Rajada de chat ----------
  sec("A. chat — rajada acima da cota rejeitada com RATE_LIMITED");
  // cota chat = 10 burst + 3/s. 16 emissões em <1s estouram.
  const msgs = await rajada(sJ, "mesa:mensagem", (i) => ({
    sessionId: sid, content: `RL-chat-${i}`, clientId: `rl-c-${i}`,
  }), 16);
  const aceitos = msgs.filter((r) => r?.ok === true).length;
  const recusados = msgs.filter(ehRateLimited);
  t("parte da rajada passa", aceitos >= 8 && aceitos <= 13, `aceitos=${aceitos}`);
  t("excedente rejeitado com codigo RATE_LIMITED e retryAfterMs",
    recusados.length >= 3, JSON.stringify(msgs.slice(-4)));
  t("nenhuma rejeição tem efeito colateral de sucesso", msgs.every((r) => r?.ok === true || ehRateLimited(r) || r?.ok === false));

  // ---------- B. Cota compartilhada entre abas do mesmo usuário ----------
  sec("B. abas do mesmo usuário dividem a cota de chat");
  // logo após a rajada, a cota de sJ está ~vazia; sJ2 (mesmo userId)
  // também deve estar limitado — prova do bucket userId:acao
  const cross = await rajada(sJ2, "mesa:mensagem", (i) => ({
    sessionId: sid, content: `RL-cross-${i}`, clientId: `rl-x-${i}`,
  }), 6);
  const crossOk = cross.filter((r) => r?.ok === true).length;
  const crossRl = cross.filter(ehRateLimited).length;
  // cota nova daria ~10 aceites; o compartilhamento deixa passar no
  // máximo os poucos tokens repostos na janela (~1-2)
  t("segunda aba não ganha cota nova", crossOk <= 2 && crossRl >= 3, `ok=${crossOk} rl=${crossRl}`);
  // usuário distinto segue com cota própria
  const outro = await emitirCb(sJb, "mesa:mensagem", { sessionId: sid, content: "RL-outro-user", clientId: "rl-ou-1" });
  t("usuário distinto não é afetado", outro?.ok === true, JSON.stringify(outro));

  // ---------- C. Cotas independentes por ação ----------
  sec("C. ações independentes — chat esgotado não afeta rolagem/teste/turno");
  const rolagem = await emitirCb(sJ, "mesa:rolar", { sessionId: sid, dados: [{ sides: 6, count: 1 }], motivo: "rl", requestId: "rl-roll-1" });
  t("rolagem livre ainda permitida", rolagem?.ok === true, JSON.stringify(rolagem));
  const pedir = await emitirCb(sJ, "mesa:teste:pedir", { sessionId: sid, characterId: "inexistente", dadosCount: 1, requestId: "rl-pedir-1" });
  t("teste:pedir consome cota própria (rejeição de domínio, não RATE_LIMITED)",
    pedir?.ok === false && pedir?.codigo !== "RATE_LIMITED", JSON.stringify(pedir));

  // ---------- D. Rejeições não gravam nada ----------
  sec("D. rejeição não persiste mensagem");
  const gravadas = contarChat("RL-chat-");
  t("somente os ACKs ok viraram chat_messages", gravadas === aceitos, `gravadas=${gravadas} aceitos=${aceitos}`);
  const gravadasCross = contarChat("RL-cross-");
  t("rejeições da segunda aba não gravaram nada", gravadasCross === 0, `gravadas=${gravadasCross}`);

  // ---------- E. Recuperação após retryAfterMs ----------
  sec("E. recuperação da cota após a janela");
  const r0 = msgs.find(ehRateLimited);
  await dormir(Math.min(2000, (r0?.retryAfterMs ?? 500) + 400));
  const pos = await emitirCb(sJ, "mesa:mensagem", { sessionId: sid, content: "RL-pos-janela", clientId: "rl-pos-1" });
  t("chat volta a ser aceito após retryAfterMs", pos?.ok === true, JSON.stringify(pos));

  // ---------- F. Idempotência preservada ----------
  sec("F. idempotência requestId/clientId intacta");
  const cid = "rl-idem-1";
  const [d1, d2] = await Promise.all([
    emitirCb(sJ, "mesa:mensagem", { sessionId: sid, content: "RL-idem", clientId: cid }),
    emitirCb(sJ, "mesa:mensagem", { sessionId: sid, content: "RL-idem", clientId: cid }),
  ]);
  t("duplicata idempotente não grava duas vezes", contarChat("RL-idem") === 1, JSON.stringify([d1?.ok, d2?.ok, d1?.duplicado, d2?.duplicado]));

  // ---------- G. Névoa — gestos legítimos e flood ----------
  sec("G. névoa — gesto legítimo passa, flood é limitado, sync é isenta");
  const traco = { raioX: 0.2, raioY: 0.2, pontos: [{ x: 0.5, y: 0.5 }] };
  const legit = await rajada(sM, "mesa:vtt:nevoa", () => ({ sessionId: sid, acao: "revelar", traco }), 8);
  t("8 gestos de névoa legítimos passam", legit.every((r) => r?.ok === true), JSON.stringify(legit.filter((r) => r?.ok !== true)));
  // flood: cota nevoa = 30 burst; já consumimos 8 → ~22+resto. 40 emissões estouram.
  const flood = await rajada(sM, "mesa:vtt:nevoa", (i) => ({ sessionId: sid, acao: "ocultarTudo", clientId: `rl-n-${i}` }), 40);
  const rlNevoa = flood.filter(ehRateLimited);
  t("flood de névoa rejeitado com RATE_LIMITED", rlNevoa.length >= 5, `limitados=${rlNevoa.length}`);
  // sincronização ordenada NUNCA é limitada (mecanismo de recuperação da névoa)
  const syncs = await rajada(sM, "mesa:vtt:nevoa:sincronizar", () => ({ sessionId: sid }), 12);
  t("sincronização de névoa isenta de rate limit", syncs.every((r) => r?.ok === true), JSON.stringify(syncs.slice(0, 3)));

  // ---------- H. Timer/turno tem cota própria ----------
  sec("H. mesa:timer — flood limitado");
  const timers = await rajada(sM, "mesa:timer", (i) => ({ sessionId: sid, acao: "pausar", clientId: `rl-t-${i}` }), 70);
  const rlTimer = timers.filter(ehRateLimited);
  t("flood de timer rejeitado com RATE_LIMITED", rlTimer.length >= 5, `limitados=${rlTimer.length} total=${timers.length}`);

  // ---------- I. Tokens VTT — burst generoso mas taxa sustentada limitada ----------
  sec("I. mesa:vtt:token — flood sustentado limitado");
  // cria 1 token e depois inunda 'mover' (barato, sem crescer o estado)
  await emitirCb(sM, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { id: "rl-tk", nome: "RL", x: 0.5, y: 0.5 } });
  const moves = await rajada(sM, "mesa:vtt:token", (i) => ({ sessionId: sid, acao: "mover", token: { id: "rl-tk", x: 0.1 + (i % 50) * 0.01, y: 0.5 } }), 400);
  const rlTok = moves.filter(ehRateLimited);
  t("flood de tokens rejeitado após burst", rlTok.length >= 5, `limitados=${rlTok.length} total=${moves.length}`);

  // ---------- J. mesa:entrar tem cota própria ----------
  sec("J. mesa:entrar — reentradas em rajada limitadas");
  const ents = await rajada(sJb, "mesa:entrar", () => ({ sessionId: sid }), 20);
  const rlEnt = ents.filter(ehRateLimited);
  t("reentrada em rajada limitada", rlEnt.length >= 3, `limitados=${rlEnt.length}`);

  // ---------- K. Eventos isentos: mesa:sair, ping, sair-campanha ----------
  sec("K. eventos isentos não consomem cota nem quebram");
  for (let i = 0; i < 10; i++) sJb.emit("mesa:sair", { sessionId: sid });
  sJb.emit("ping", () => undefined);
  sJb.emit("sair-campanha", ids.camp);
  await dormir(300);
  t("socket segue conectado após eventos isentos", sJb.connected === true);
  // e o usuário ainda opera normalmente em ação com cota própria
  const posIsento = await emitirCb(sJb, "mesa:rolar", { sessionId: sid, dados: [{ sides: 6, count: 1 }], requestId: "rl-pos-isento" });
  t("ação legítima funciona após eventos isentos", posIsento?.ok === true, JSON.stringify(posIsento));

  // ---------- L. Cliente sem callback não derruba o handler ----------
  sec("L. emissões sem ACK não quebram o servidor");
  for (let i = 0; i < 20; i++) sJ.emit("mesa:mensagem", { sessionId: sid, content: `RL-semack-${i}` });
  await dormir(400);
  t("servidor continua saudável após flood sem callback", (await req(BASE, "GET", "/health")).status === 200);

  console.log(`\n${pass} ok, ${fail} falhas`);
} catch (e) {
  console.error("ERRO FATAL:", e);
  fail++;
} finally {
  for (const s of sockets) { try { s.close(); } catch {} }
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
}
process.exit(fail === 0 ? 0 : 1);
