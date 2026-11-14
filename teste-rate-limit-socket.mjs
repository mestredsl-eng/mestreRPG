// Rate limit Socket.IO da Mesa (Issue #68) — sockets reais contra
// servidor descartável. Cobre: rejeição RATE_LIMITED com retryAfterMs,
// cota compartilhada entre abas do mesmo usuário, isolamento entre
// usuários, refill de tokens, rejeição sem persistência, payload
// malformado sem consumo de cota e isenção de mesa:sair.
import { io as ioClient } from "socket.io-client";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, sessao, req, encerrarServidor, limparDir, abrirDb,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const DIR = dirTeste("rate-limit-socket");
const BANCO = join(DIR, "teste.db");
await prepararBanco(BANCO);

const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc;
const sockets = [];

function conectar(cookie) {
  const opts = { path: "/socket.io", transports: ["websocket", "polling"], reconnection: false };
  if (cookie) {
    const token = decodeURIComponent(cookie.split("=")[1]);
    opts.extraHeaders = { cookie: `mestre_rpg_session=${encodeURIComponent(token)}` };
  }
  const s = ioClient(BASE, opts);
  sockets.push(s);
  return s;
}
const pronto = (s) => new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
const emitirCb = (s, ev, p) => new Promise((r) => {
  const to = setTimeout(() => r({ ok: false, erro: "timeout" }), 8000);
  s.emit(ev, p, (x) => { clearTimeout(to); r(x); });
});
const contarChat = () => {
  const db = abrirDb(BANCO);
  const n = db.prepare("select count(*) c from chat_messages where session_id=?").get(sid).c;
  db.close();
  return n;
};

proc = subirServidor(PORTA, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
proc.stderr.on("data", () => {});
await esperarSaudavel(BASE, proc);

const cenario = await criarCenario(BASE, BANCO, {
  campanha: "Campanha Rate Limit", jogadores: { a: "rl_a", b: "rl_b" },
});
const M = cenario.cookieMestre;
const A1 = cenario.jogadores.a.cookie;
const A2 = sessao(BANCO, cenario.jogadores.a.id); // segunda sessão da MESMA conta
const B = cenario.jogadores.b.cookie;

let sid;
try {
  const sess = await req(BASE, "POST", `/campaigns/${cenario.campId}/sessoes`, { cookie: M, body: { name: "Mesa RL" } });
  sid = sess.json?.sessao?.id ?? sess.json?.id;
  t("sessão criada", !!sid, JSON.stringify(sess.json).slice(0, 200));

  const sM = conectar(M); await pronto(sM);
  const sA = conectar(A1); await pronto(sA);
  const sA2 = conectar(A2); await pronto(sA2);
  const sB = conectar(B); await pronto(sB);

  sec("Entrada na mesa e baseline");
  t("mestre entra", (await emitirCb(sM, "mesa:entrar", { sessionId: sid }))?.ok === true);
  t("jogador A entra", (await emitirCb(sA, "mesa:entrar", { sessionId: sid }))?.ok === true);
  t("jogador B entra", (await emitirCb(sB, "mesa:entrar", { sessionId: sid }))?.ok === true);
  const chatAntes = contarChat();

  sec("Rajada de chat — RATE_LIMITED com retryAfterMs");
  // capacidade chat = 8 tokens; 14 envios em rajada → ~8 ok, resto negado
  const respostas = await Promise.all(
    Array.from({ length: 14 }, (_, i) => emitirCb(sA, "mesa:mensagem", {
      sessionId: sid, content: `msg rl ${i}`, clientId: crypto.randomUUID(),
    })),
  );
  const ok = respostas.filter((r) => r?.ok === true);
  const neg = respostas.filter((r) => r?.ok === false);
  const rl = neg.filter((r) => r?.codigo === "RATE_LIMITED");
  t("parte da rajada aceita", ok.length >= 1 && ok.length <= 8, `ok=${ok.length}`);
  t("restante rejeitada como RATE_LIMITED", rl.length === neg.length && rl.length >= 1, `neg=${neg.length} rl=${rl.length}`);
  t("rejeição traz retryAfterMs positivo", rl.every((r) => typeof r.retryAfterMs === "number" && r.retryAfterMs > 0));

  sec("Rejeição não persiste");
  const chatDepois = contarChat();
  t("somente mensagens aceitas gravadas",
    chatDepois - chatAntes === ok.length, `delta=${chatDepois - chatAntes} ok=${ok.length}`);

  sec("Cota compartilhada entre abas do mesmo usuário");
  // A está sem tokens de chat; a segunda sessão da mesma conta divide o bucket
  const rAba2 = await emitirCb(sA2, "mesa:mensagem", { sessionId: sid, content: "aba 2", clientId: crypto.randomUUID() });
  t("segunda aba do usuário A também rejeitada", rAba2?.ok === false && rAba2?.codigo === "RATE_LIMITED", JSON.stringify(rAba2));

  sec("Isolamento entre usuários");
  const rB1 = await emitirCb(sB, "mesa:mensagem", { sessionId: sid, content: "B msg 1", clientId: crypto.randomUUID() });
  const rB2 = await emitirCb(sB, "mesa:mensagem", { sessionId: sid, content: "B msg 2", clientId: crypto.randomUUID() });
  t("usuário B não é afetado pela cota de A", rB1?.ok === true && rB2?.ok === true, JSON.stringify([rB1, rB2]));

  sec("Payload malformado não consome cota");
  const malformadas = await Promise.all(
    Array.from({ length: 20 }, () => emitirCb(sA, "mesa:mensagem", { sessionId: sid })),
  );
  t("payloads inválidos rejeitados sem RATE_LIMITED",
    malformadas.every((r) => r?.ok === false && r?.codigo !== "RATE_LIMITED"),
    JSON.stringify(malformadas[0]));

  sec("Isenção de saída");
  const rSair = await emitirCb(sA, "mesa:sair", { sessionId: sid });
  t("mesa:sair funciona mesmo com cota esgotada", rSair?.ok === true, JSON.stringify(rSair));

  sec("Refill de tokens");
  await dormir(3000); // ~6 tokens repostos (2/s)
  const rAposEspera = await emitirCb(sA, "mesa:mensagem", { sessionId: sid, content: "após espera", clientId: crypto.randomUUID() });
  t("após janela, usuário A volta a enviar", rAposEspera?.ok === true, JSON.stringify(rAposEspera));

  sec("Outras ações têm buckets independentes");
  // turno tem cota própria — não foi consumida pela rajada de chat
  const rTurno = await emitirCb(sM, "mesa:turno", { sessionId: sid, acao: "iniciar", ordem: [] });
  t("mesa:turno do mestre não bloqueado pela cota de chat de A",
    rTurno !== null && rTurno?.codigo !== "RATE_LIMITED", JSON.stringify(rTurno));
} finally {
  for (const s of sockets) { try { s.close(); } catch { } }
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
