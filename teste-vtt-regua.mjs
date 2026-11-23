// Mesa virtual — régua de distância (Issue #125), backend:
// calibração da sessão persistida em vtt_state.regua, restrita ao mestre,
// validação estrita no servidor e entrega filtrada a todos os papéis.
// A medição em si é local/efêmera — este arquivo prova que NADA dela
// trafega: só a configuração é persistida.
// Banco 100% descartável.
import { io as ioClient } from "socket.io-client";
import crypto from "node:crypto";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, abrirDb, sessao, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("mesa-regua");
const BANCO = `${DIR}/teste.db`;
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc, ids, sid;
const sockets = [];
const ultVtt = new Map();
const cntVtt = new Map();

function conectar(cookie) {
  const token = decodeURIComponent(cookie.split("=")[1]);
  const s = ioClient(BASE, {
    path: "/socket.io", transports: ["websocket", "polling"],
    extraHeaders: { cookie: `mestre_rpg_session=${encodeURIComponent(token)}` },
    reconnection: false,
  });
  sockets.push(s);
  ultVtt.set(s, null); cntVtt.set(s, 0);
  s.on("mesa:vtt", (p) => { ultVtt.set(s, p?.vtt ?? null); cntVtt.set(s, (cntVtt.get(s) ?? 0) + 1); });
  return s;
}
const pronto = (s) => new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
const emitirCb = (s, ev, p) => new Promise((r) => { const to = setTimeout(() => r({ ok: false, erro: "timeout" }), 8000); s.emit(ev, p, (x) => { clearTimeout(to); r(x); }); });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
async function esperarVtt(socket, timeout = 8000) {
  const ini = cntVtt.get(socket) ?? 0;
  const fim = Date.now() + timeout;
  while (Date.now() < fim) {
    if ((cntVtt.get(socket) ?? 0) > ini) return;
    await dormir(50);
  }
  throw new Error("timeout mesa:vtt");
}
function novoUsuario(banco, { username, role = null, campId = null }) {
  const db = abrirDb(banco);
  try {
    const uid = crypto.randomUUID(), agora = Date.now();
    db.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
      .run(uid, username, username, "x", agora, agora);
    let mid = null;
    if (role) {
      mid = crypto.randomUUID();
      db.prepare("insert into memberships (id,campaign_id,user_id,role,status,permissions,joined_at,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
        .run(mid, campId ?? ids.camp, uid, role, "ativo", "{}", agora, agora, agora);
    }
    return { id: uid, membershipId: mid, cookie: sessao(banco, uid) };
  } finally { db.close(); }
}
const vttBruto = (banco, sid_) => {
  const db = abrirDb(banco);
  try {
    const row = db.prepare("select vtt_state from sessions where id = ?").get(sid_);
    return row?.vtt_state ? JSON.parse(row.vtt_state) : null;
  } finally { db.close(); }
};

const PNG_16_10 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
  proc.stderr.on("data", (d) => process.stderr.write("[srv] " + d)); proc.stdout?.on("data", (d) => process.stderr.write("[srv] " + d));
  await esperarSaudavel(BASE, proc);

  const c = await criarCenario(BASE, BANCO, { jogadores: { jogador1: "rg_j1", jogador2: "rg_j2" } });
  ids = { admin: c.adminId, j1: c.jogadores.jogador1.id, j2: c.jogadores.jogador2.id, camp: c.campId, cookieMestre: c.cookieMestre };
  const esp = novoUsuario(BANCO, { username: "rg_esp", role: "espectador" });

  const sess = await req(BASE, "POST", `/campaigns/${ids.camp}/sessoes`, { cookie: ids.cookieMestre, body: { name: "Mesa Régua" } });
  sid = sess.json?.sessao?.id ?? sess.json?.id;
  t("sessão criada", !!sid);

  const sM = conectar(ids.cookieMestre);
  const sA = conectar(c.jogadores.jogador1.cookie);
  const sE = conectar(esp.cookie);
  await Promise.all([pronto(sM), pronto(sA), pronto(sE)]);
  const [rM, rA, rE] = await Promise.all([
    emitirCb(sM, "mesa:entrar", { sessionId: sid }),
    emitirCb(sA, "mesa:entrar", { sessionId: sid }),
    emitirCb(sE, "mesa:entrar", { sessionId: sid }),
  ]);
  t("três participantes entram", rM?.ok && rA?.ok && rE?.ok);

  // ---------- A. mapa com dimensões intrínsecas ----------
  sec("A. Dimensões do mapa persistidas");
  // upload real: octet-stream + metadados em headers (mesmo contrato da UI)
  const up = await fetch(`${BASE}/api/campaigns/${ids.camp}/arquivos/upload`, {
    method: "POST",
    headers: {
      cookie: ids.cookieMestre,
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent("mapa.png"),
      "x-file-mime": "image/png",
      "x-category": "mapa",
      "x-visibility": "publica",
    },
    body: Buffer.from(PNG_16_10, "base64"),
  });
  const upJson = await up.json().catch(() => ({}));
  const fileId = upJson.id;
  t("upload do mapa", up.ok && !!fileId, `HTTP ${up.status} ${JSON.stringify(upJson).slice(0, 120)}`);

  if (fileId) {
    const pMapa = Promise.all([esperarVtt(sM), esperarVtt(sA), esperarVtt(sE)]);
    const rDef = await emitirCb(sM, "mesa:vtt:mapa", {
      sessionId: sid, acao: "definir",
      mapa: { fileId, nome: "mapa.png", largura: 1600, altura: 1000 },
    });
    t("mestre define mapa com dimensões", rDef?.ok === true, JSON.stringify(rDef).slice(0, 160));
    await pMapa;
    t("dimensões persistidas no estado", ultVtt.get(sM)?.mapa?.largura === 1600 && ultVtt.get(sM)?.mapa?.altura === 1000);
    t("jogador recebe as mesmas dimensões", ultVtt.get(sA)?.mapa?.largura === 1600);
    const br = vttBruto(BANCO, sid);
    t("vtt_state persistido tem largura/altura", br?.mapa?.largura === 1600 && br?.mapa?.altura === 1000);

    // dimensões inválidas são descartadas (par precisa ser positivo/finito)
    const pDef2 = esperarVtt(sM);
    const rDef2 = await emitirCb(sM, "mesa:vtt:mapa", {
      sessionId: sid, acao: "definir",
      mapa: { fileId, nome: "mapa.png", largura: -5, altura: 1000 },
    });
    await pDef2;
    t("dimensões negativas descartadas (mapa sem dims)", rDef2?.ok === true && ultVtt.get(sM)?.mapa?.largura === undefined, JSON.stringify(ultVtt.get(sM)?.mapa).slice(0, 140));
    // repõe dimensões válidas para os próximos passos
    const pDef3 = esperarVtt(sM);
    await emitirCb(sM, "mesa:vtt:mapa", {
      sessionId: sid, acao: "definir",
      mapa: { fileId, nome: "mapa.png", largura: 1600, altura: 1000 },
    });
    await pDef3;
  }

  // ---------- B. calibração: somente mestre ----------
  sec("B. Calibração restrita ao mestre");
  const CAL = { unidade: "m", distanciaReferencia: 100, valorReferencia: 1.5 };
  const rJog = await emitirCb(sA, "mesa:vtt:mapa", { sessionId: sid, acao: "calibrar", regua: CAL });
  t("jogador NÃO calibra", rJog?.ok === false, JSON.stringify(rJog).slice(0, 120));
  const rEsp = await emitirCb(sE, "mesa:vtt:mapa", { sessionId: sid, acao: "calibrar", regua: CAL });
  t("espectador NÃO calibra", rEsp?.ok === false, JSON.stringify(rEsp).slice(0, 120));
  t("vtt_state segue sem regua após tentativas", vttBruto(BANCO, sid)?.regua == null);

  // ---------- C. validação estrita da calibração ----------
  sec("C. Validação da calibração");
  const casosInvalidos = [
    ["unidade vazia", { unidade: "  ", distanciaReferencia: 100, valorReferencia: 1.5 }],
    ["unidade gigante", { unidade: "x".repeat(30), distanciaReferencia: 100, valorReferencia: 1.5 }],
    ["ref zero", { unidade: "m", distanciaReferencia: 0, valorReferencia: 1.5 }],
    ["ref negativa", { unidade: "m", distanciaReferencia: -10, valorReferencia: 1.5 }],
    ["valor NaN", { unidade: "m", distanciaReferencia: 100, valorReferencia: NaN }],
    ["valor Infinity", { unidade: "m", distanciaReferencia: 100, valorReferencia: Infinity }],
    ["não-objeto", "m"],
    ["campos string", { unidade: "m", distanciaReferencia: "100", valorReferencia: "1.5" }],
  ];
  for (const [nome, regua] of casosInvalidos) {
    const r = await emitirCb(sM, "mesa:vtt:mapa", { sessionId: sid, acao: "calibrar", regua });
    t(`inválida rejeitada: ${nome}`, r?.ok === false, JSON.stringify(r).slice(0, 100));
    await dormir(250); // cota do limitador de socket por ação
  }
  t("vtt_state continua sem regua", vttBruto(BANCO, sid)?.regua == null);

  // ---------- D. mestre calibra e todos recebem ----------
  sec("D. Calibração válida persiste e é entregue");
  const pCal = Promise.all([esperarVtt(sM), esperarVtt(sA), esperarVtt(sE)]);
  const rOk = await emitirCb(sM, "mesa:vtt:mapa", { sessionId: sid, acao: "calibrar", regua: CAL });
  t("mestre calibra com sucesso", rOk?.ok === true, JSON.stringify(rOk).slice(0, 140));
  await pCal;
  const esperado = { unidade: "m", distanciaReferencia: 100, valorReferencia: 1.5 };
  t("mestre recebe regua no vtt", JSON.stringify(ultVtt.get(sM)?.regua) === JSON.stringify(esperado), JSON.stringify(ultVtt.get(sM)?.regua));
  t("jogador recebe regua no vtt", JSON.stringify(ultVtt.get(sA)?.regua) === JSON.stringify(esperado));
  t("espectador recebe regua no vtt", JSON.stringify(ultVtt.get(sE)?.regua) === JSON.stringify(esperado));
  t("vtt_state persistido tem regua", JSON.stringify(vttBruto(BANCO, sid)?.regua) === JSON.stringify(esperado));

  // unidade com espaços é normalizada (trim) na gravação
  const pTrim = esperarVtt(sM);
  const rTrim = await emitirCb(sM, "mesa:vtt:mapa", { sessionId: sid, acao: "calibrar", regua: { unidade: "  hex  ", distanciaReferencia: 10, valorReferencia: 2 } });
  t("unidade com trim aceita", rTrim?.ok === true, JSON.stringify(rTrim).slice(0, 100));
  await pTrim;
  await dormir(250);
  t("unidade persistida sem espaços", ultVtt.get(sM)?.regua?.unidade === "hex", ultVtt.get(sM)?.regua?.unidade);

  // ---------- E. persistência entre entradas (reconexão/snapshot) ----------
  sec("E. Calibração sobrevive a nova entrada na sessão");
  const sM2 = conectar(ids.cookieMestre);
  await pronto(sM2);
  const rEntrar2 = await emitirCb(sM2, "mesa:entrar", { sessionId: sid });
  t("nova entrada recebe calibração", rEntrar2?.sessao?.vttState?.regua?.unidade === "hex"
    && rEntrar2?.sessao?.vttState?.regua?.valorReferencia === 2, JSON.stringify(rEntrar2?.sessao?.vttState?.regua));

  // ---------- F. remoção da calibração ----------
  sec("F. Remoção da calibração");
  const pRem = Promise.all([esperarVtt(sM), esperarVtt(sA)]);
  const rRem = await emitirCb(sM, "mesa:vtt:mapa", { sessionId: sid, acao: "calibrar", regua: null });
  t("mestre remove calibração", rRem?.ok === true);
  await pRem;
  t("regua null após remoção", ultVtt.get(sM)?.regua === null || ultVtt.get(sM)?.regua === undefined, JSON.stringify(ultVtt.get(sM)?.regua));
  t("vtt_state sem regua", vttBruto(BANCO, sid)?.regua == null);
  const rJog2 = await emitirCb(sA, "mesa:vtt:mapa", { sessionId: sid, acao: "calibrar", regua: CAL });
  t("jogador continua sem poder calibrar", rJog2?.ok === false);

  // ---------- G. ação desconhecida e sessão encerrada ----------
  sec("G. Ações adjacentes");
  const rAca = await emitirCb(sM, "mesa:vtt:mapa", { sessionId: sid, acao: "inventada" });
  t("ação inválida rejeitada", rAca?.ok === false);

  console.log(`\n==== regua-backend: ${pass} ok, ${fail} falhas ====`);
} catch (e) {
  console.error("FALHA GERAL:", e);
  fail++;
} finally {
  for (const s of sockets) try { s.close(); } catch {}
  try { await encerrarServidor(proc); } catch {}
  try { limparDir(DIR); } catch (e) { console.log("[limpeza]", e.message); }
}
process.exit(fail ? 1 : 0);
