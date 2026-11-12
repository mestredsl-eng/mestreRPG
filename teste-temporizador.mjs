// Temporizador configurável da mesa — Socket.IO (PR #54).
// Cobre: limites de duração (1min–24h), autoridade do mestre, pausa/retomada
// preservando restante, reinício com duração escolhida (inclusive após o fim),
// sincronização entre dois clientes, reconexão recuperando estado e rejeição
// de manipulação client-side do tempo restante.
import { io as ioClient } from "socket.io-client";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, comDb, abrirDb, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("timer");
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
const timerDb = () => {
  const raw = comDb(BANCO, (db) => db.prepare("select timer_state from sessions where id=?").get(sid)?.timer_state);
  return raw ? JSON.parse(raw) : null;
};

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
  proc.stderr.on("data", () => {});
  await esperarSaudavel(BASE, proc);

  const c = await criarCenario(BASE, BANCO, { jogadores: { jogador1: "timer_j1" } });
  ids = { camp: c.campId };

  const sess = await req(BASE, "POST", `/campaigns/${ids.camp}/sessoes`, { cookie: c.cookieMestre, body: { name: "Mesa Timer" } });
  sid = sess.json?.sessao?.id ?? sess.json?.id;
  t("sessão criada", !!sid, JSON.stringify(sess.json).slice(0, 160));

  const sockM = conectar(c.cookieMestre);
  const sockJ = conectar(c.jogadores.jogador1.cookie);
  await Promise.all([pronto(sockM), pronto(sockJ)]);
  await emitirCb(sockM, "mesa:entrar", { sessionId: sid });
  await emitirCb(sockJ, "mesa:entrar", { sessionId: sid });

  sec("limites de duração (servidor autoritativo)");
  for (const [rotulo, dur] of [
    ["abaixo do mínimo (59s)", 59], ["fracionário abaixo (59.5s)", 59.5],
    ["acima do máximo (86401s)", 86401], ["fracionário acima (86400.4s)", 86400.4],
    ["fracionário dentro (60.5s)", 60.5],
    ["zero", 0], ["negativo", -30], ["não numérico", "abc"], ["booleano", true],
  ]) {
    const r = await emitirCb(sockM, "mesa:timer", { sessionId: sid, acao: "iniciar", duracaoSegundos: dur });
    t(`iniciar ${rotulo} → rejeitado`, r?.ok === false, JSON.stringify(r));
    const rr = await emitirCb(sockM, "mesa:timer", { sessionId: sid, acao: "reiniciar", duracaoSegundos: dur });
    t(`reiniciar ${rotulo} → rejeitado`, rr?.ok === false, JSON.stringify(rr));
  }
  t("rejeições não criaram estado de timer", timerDb() === null, JSON.stringify(timerDb()));

  sec("duração padrão e limites válidos");
  const rPadrao = await emitirCb(sockM, "mesa:timer", { sessionId: sid, acao: "iniciar" });
  t("iniciar sem duração → 300s (compat)", rPadrao?.ok === true && rPadrao.timer?.totalMs === 300000, JSON.stringify(rPadrao?.timer));
  const rMin = await emitirCb(sockM, "mesa:timer", { sessionId: sid, acao: "iniciar", duracaoSegundos: 60 });
  t("iniciar no mínimo (60s)", rMin?.ok === true && rMin.timer?.totalMs === 60000, JSON.stringify(rMin?.timer));
  const rMax = await emitirCb(sockM, "mesa:timer", { sessionId: sid, acao: "reiniciar", duracaoSegundos: 86400 });
  t("reiniciar no máximo (24h)", rMax?.ok === true && rMax.timer?.totalMs === 86400000, JSON.stringify(rMax?.timer));

  sec("iniciar com duração escolhida + sincronização");
  const evM = esperar(sockM, "mesa:timer", 8000, (d) => d?.sessionId === sid && d.status === "rodando" && d.totalMs === 120000);
  const evJ = esperar(sockJ, "mesa:timer", 8000, (d) => d?.sessionId === sid && d.status === "rodando" && d.totalMs === 120000);
  const r120 = await emitirCb(sockM, "mesa:timer", { sessionId: sid, acao: "iniciar", duracaoSegundos: 120 });
  const [tm, tj] = await Promise.all([evM, evJ]);
  t("mestre inicia 120s", r120?.ok === true && r120.timer?.totalMs === 120000, JSON.stringify(r120?.timer));
  t("jogador recebe o mesmo estado (endsAt/totalMs)",
    tm.endsAt === tj.endsAt && tm.totalMs === tj.totalMs && tm.totalMs === 120000,
    `m=${tm.endsAt}/${tm.totalMs} j=${tj.endsAt}/${tj.totalMs}`);

  sec("pausa e retomada preservam o restante");
  const rPausa = await emitirCb(sockM, "mesa:timer", { sessionId: sid, acao: "pausar" });
  t("pausar → pausado com restante", rPausa?.ok === true && rPausa.timer?.status === "pausado" && rPausa.timer?.remainingMs > 0 && rPausa.timer?.remainingMs <= 120000,
    JSON.stringify(rPausa?.timer));
  const restPausado = rPausa.timer.remainingMs;
  const rRetoma = await emitirCb(sockM, "mesa:timer", { sessionId: sid, acao: "retomar" });
  t("retomar → rodando preservando restante",
    rRetoma?.ok === true && rRetoma.timer?.status === "rodando" &&
    Math.abs(rRetoma.timer.remainingMs - restPausado) < 2000,
    `pausado=${restPausado} retomado=${rRetoma?.timer?.remainingMs}`);

  sec("reinício com duração escolhida após encerramento");
  await emitirCb(sockM, "mesa:timer", { sessionId: sid, acao: "encerrar" });
  const evFim = esperar(sockJ, "mesa:timer", 8000, (d) => d?.sessionId === sid && d.status === "rodando" && d.totalMs === 90000);
  const rRe = await emitirCb(sockM, "mesa:timer", { sessionId: sid, acao: "reiniciar", duracaoSegundos: 90 });
  const tjRe = await evFim.catch(() => null);
  t("reiniciar após fim usa duração escolhida (90s)",
    rRe?.ok === true && rRe.timer?.totalMs === 90000, JSON.stringify(rRe?.timer));
  t("jogador recebe o reinício", !!tjRe && tjRe.totalMs === 90000, JSON.stringify(tjRe));

  sec("expiração natural no servidor");
  // duração mínima é 60s — injeta estado quase expirado para não esperar 1min
  const dbW = abrirDb(BANCO);
  dbW.prepare("update sessions set timer_state=? where id=?")
    .run(JSON.stringify({ status: "rodando", endsAt: Date.now() + 1200, remainingMs: 1200, totalMs: 90000 }), sid);
  dbW.close();
  const evFimJ = esperar(sockJ, "mesa:timer", 10000, (d) => d?.sessionId === sid && d.status === "parado" && d.remainingMs === 0);
  const evFimM = esperar(sockM, "mesa:timer", 10000, (d) => d?.sessionId === sid && d.status === "parado" && d.remainingMs === 0);
  const [fj, fm] = await Promise.all([evFimJ, evFimM]);
  t("jogador recebe encerramento por expiração", fj?.status === "parado" && fj.remainingMs === 0);
  t("mestre recebe encerramento por expiração", fm?.status === "parado" && fm.remainingMs === 0);
  await new Promise((r) => setTimeout(r, 300));
  t("expiração persistida como parado", timerDb()?.status === "parado" && timerDb()?.remainingMs === 0, JSON.stringify(timerDb()));

  sec("reinício após expiração natural");
  const rRe2 = await emitirCb(sockM, "mesa:timer", { sessionId: sid, acao: "reiniciar", duracaoSegundos: 300 });
  t("reiniciar após expiração → 300s rodando", rRe2?.ok === true && rRe2.timer?.status === "rodando" && rRe2.timer?.totalMs === 300000, JSON.stringify(rRe2?.timer));

  sec("rejeição não altera estado persistido");
  const antes = timerDb();
  for (const dur of [59, 59.5, 60.5, 86400.4, 86401]) {
    await emitirCb(sockM, "mesa:timer", { sessionId: sid, acao: "iniciar", duracaoSegundos: dur });
    await emitirCb(sockM, "mesa:timer", { sessionId: sid, acao: "reiniciar", duracaoSegundos: dur });
  }
  t("timerState inalterado após rejeições", JSON.stringify(timerDb()) === JSON.stringify(antes),
    `antes=${JSON.stringify(antes)} depois=${JSON.stringify(timerDb())}`);

  sec("controles exclusivos do mestre");
  for (const acao of ["iniciar", "pausar", "retomar", "reiniciar", "encerrar"]) {
    const r = await emitirCb(sockJ, "mesa:timer", { sessionId: sid, acao, duracaoSegundos: 60 });
    t(`jogador não executa '${acao}'`, r?.ok === false, JSON.stringify(r));
  }
  const estadoAposNeg = timerDb();
  t("estado do timer inalterado após tentativas do jogador",
    estadoAposNeg?.status === "rodando" && estadoAposNeg?.totalMs === 300000, JSON.stringify(estadoAposNeg));

  sec("autoridade do servidor — cliente não manipula tempo");
  const rInj = await emitirCb(sockM, "mesa:timer", {
    sessionId: sid, acao: "iniciar", duracaoSegundos: 60,
    remainingMs: 1, endsAt: 1, totalMs: 1, status: "parado",
  });
  t("campos forjados ignorados — totalMs=60000",
    rInj?.ok === true && rInj.timer?.totalMs === 60000 && rInj.timer?.remainingMs === 60000, JSON.stringify(rInj?.timer));

  sec("reconexão recupera o estado");
  await emitirCb(sockM, "mesa:timer", { sessionId: sid, acao: "pausar" });
  const restAntes = timerDb()?.remainingMs;
  sockJ.close();
  await new Promise((r) => setTimeout(r, 200));
  sockets.splice(sockets.indexOf(sockJ), 1);
  const sockJ2 = conectar(c.jogadores.jogador1.cookie);
  await pronto(sockJ2);
  const entrar = await emitirCb(sockJ2, "mesa:entrar", { sessionId: sid });
  t("reentrada retorna timerState pausado",
    entrar?.sessao?.timerState?.status === "pausado" && entrar.sessao.timerState.remainingMs === restAntes,
    JSON.stringify(entrar?.sessao?.timerState));
  const est = await req(BASE, "GET", `/campaigns/${ids.camp}/sessoes/${sid}/estado`, { cookie: c.jogadores.jogador1.cookie });
  t("GET estado confirma pausa persistida",
    est.json?.sessao?.timerState?.status === "pausado" && est.json.sessao.timerState.remainingMs === restAntes,
    JSON.stringify(est.json?.sessao?.timerState));

} finally {
  for (const s of sockets) { try { s.close(); } catch { } }
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
