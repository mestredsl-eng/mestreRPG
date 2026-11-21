// Issue #127 / PR #179 — PROVA DIFERENCIAL P1: privacidade do HP de NPC.
// Dois NPCs idênticos na visão pública diferem SÓ no atributo mestre-only
// `for` (8 vs 10 → HP real 180 vs 200). Mesmo dano absoluto (100) pelo
// serviço autoritativo → persistido 80/100. Com vidaCompartilhada=true,
// o payload de `mesa:vtt:sincronizar` para jogador não-dono e espectador
// deve ser indistinguível; se divergir, o HP atual vaza o atributo oculto.
// Controle: vidaCompartilhada=false → vida=null nos dois (idêntico).
// Banco 100% descartável. Não altera código de produção.
import { io as ioClient } from "socket.io-client";
import crypto from "node:crypto";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, encerrarServidor, limparDir, abrirDb, sessao,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const DIR = dirTeste("vtt-vida-p1");
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
const sincronizar = (s) => emitirCb(s, "mesa:vtt:sincronizar", { sessionId: sid });
const tok = (vtt, id) => (vtt?.tokens ?? []).find((x) => x.id === id);

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

const CFG = {
  hp: { habilitado: true, base: 100, porNivel: 10, semantico: "atributo", edicaoPor: "mestre" },
};

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
  proc.stderr.on("data", (d) => process.stderr.write("[srv] " + d));
  await esperarSaudavel(BASE, proc);

  const c = await criarCenario(BASE, BANCO, {
    jogadores: { jogador1: "p1_j1" },
    config: CFG,
  });
  ids = { admin: c.adminId, j1: c.jogadores.jogador1.id, camp: c.campId, cookieMestre: c.cookieMestre };
  const esp = novoUsuario(BANCO, { username: "p1_esp", role: "espectador", campId: ids.camp });

  // Dois NPCs IDÊNTICOS na visão pública: mesmo nome-base distinto só no
  // token, mesmo overrides (for=mestre), diferem SÓ em data.for (8 vs 10).
  const NPC_A = c.novoPersonagem(c.membMestre, "NPC Alfa", { for: 8 });
  const NPC_B = c.novoPersonagem(c.membMestre, "NPC Beta", { for: 10 });
  {
    const db = abrirDb(BANCO);
    const ov = JSON.stringify({ for: { visibilidade: "mestre" } });
    db.prepare("update characters set is_npc=1, overrides=? where id in (?,?)").run(ov, NPC_A, NPC_B);
    db.close();
  }

  const sess = await req(BASE, "POST", `/campaigns/${ids.camp}/sessoes`, { cookie: ids.cookieMestre, body: { name: "Mesa P1" } });
  sid = sess.json?.sessao?.id ?? sess.json?.id;
  t("sessão criada", !!sid);

  const sM = conectar(ids.cookieMestre);
  const sJ = conectar(c.jogadores.jogador1.cookie);
  const sE = conectar(esp.cookie);
  await Promise.all([pronto(sM), pronto(sJ), pronto(sE)]);
  const [rM, rJ, rE] = await Promise.all([
    emitirCb(sM, "mesa:entrar", { sessionId: sid }),
    emitirCb(sJ, "mesa:entrar", { sessionId: sid }),
    emitirCb(sE, "mesa:entrar", { sessionId: sid }),
  ]);
  t("três participantes entram", rM?.ok && rJ?.ok && rE?.ok);

  const criar = (id, nome, personagemId) => emitirCb(sM, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { id, nome, cor: "#123456", x: 0.5, y: 0.5, personagemId, oculto: false } });
  t("token NPC-A criado", (await criar("tknpc-a1", "NPC Alfa", NPC_A)).ok === true);
  t("token NPC-B criado", (await criar("tknpc-b2", "NPC Beta", NPC_B)).ok === true);

  // Sanidade mestre: HP real 180 vs 200 (for privado visível ao mestre).
  {
    const rSyncM = await sincronizar(sM);
    t("mestre: NPC-A max=180", tok(rSyncM?.vtt, "tknpc-a1")?.vida?.hp?.maximo === 180, JSON.stringify(tok(rSyncM?.vtt, "tknpc-a1")?.vida));
    t("mestre: NPC-B max=200", tok(rSyncM?.vtt, "tknpc-b2")?.vida?.hp?.maximo === 200, JSON.stringify(tok(rSyncM?.vtt, "tknpc-b2")?.vida));
  }

  // Mesmo dano absoluto 100 pelo serviço autoritativo → persistido 80/100.
  const dA = await req(BASE, "POST", `/characters/${NPC_A}/hp`, { cookie: ids.cookieMestre, body: { acao: "dano", quantidade: 100, motivo: "p1 prova" } });
  const dB = await req(BASE, "POST", `/characters/${NPC_B}/hp`, { cookie: ids.cookieMestre, body: { acao: "dano", quantidade: 100, motivo: "p1 prova" } });
  t("dano 100 aceito nos dois NPCs", dA.status === 200 && dB.status === 200, `A=${dA.status} B=${dB.status}`);
  {
    const db = abrirDb(BANCO);
    const la = JSON.parse(db.prepare("select data from characters where id=?").get(NPC_A).data);
    const lb = JSON.parse(db.prepare("select data from characters where id=?").get(NPC_B).data);
    db.close();
    t("persistido NPC-A __hp.atual=80", la.__hp?.atual === 80, JSON.stringify(la.__hp));
    t("persistido NPC-B __hp.atual=100", lb.__hp?.atual === 100, JSON.stringify(lb.__hp));
  }

  // ---------- vidaCompartilhada = TRUE ----------
  sec("vidaCompartilhada=true — payload de não-dono e espectador");
  await req(BASE, "PUT", `/campaigns/${ids.camp}/regras/config`, { cookie: ids.cookieMestre, body: { vtt: { vidaCompartilhada: true } } });

  const rJ2 = await sincronizar(sJ);
  const rE2 = await sincronizar(sE);
  t("sync jogador ok", rJ2?.ok === true);
  t("sync espectador ok", rE2?.ok === true);

  const vidaJ_A = tok(rJ2?.vtt, "tknpc-a1")?.vida;
  const vidaJ_B = tok(rJ2?.vtt, "tknpc-b2")?.vida;
  const vidaE_A = tok(rE2?.vtt, "tknpc-a1")?.vida;
  const vidaE_B = tok(rE2?.vtt, "tknpc-b2")?.vida;

  console.log("  payload jogador  NPC-A.vida =", JSON.stringify(vidaJ_A));
  console.log("  payload jogador  NPC-B.vida =", JSON.stringify(vidaJ_B));
  console.log("  payload espect.  NPC-A.vida =", JSON.stringify(vidaE_A));
  console.log("  payload espect.  NPC-B.vida =", JSON.stringify(vidaE_B));

  // Presença/ausência de campos no payload público
  t("jogador: vida presente nos dois tokens NPC", vidaJ_A != null && vidaJ_B != null);
  t("jogador: hp.atual exposto", typeof vidaJ_A?.hp?.atual === "number" && typeof vidaJ_B?.hp?.atual === "number");
  t("jogador: hp.maximo exposto", typeof vidaJ_A?.hp?.maximo === "number" && typeof vidaJ_B?.hp?.maximo === "number");
  t("jogador: historico vazio/ausente no caminho filtrado",
    (vidaJ_A?.hp?.historico ?? []).length === 0 && !("historico" in (vidaJ_A?.hp ?? {})));
  t("espectador: vida presente nos dois tokens NPC", vidaE_A != null && vidaE_B != null);

  // NÚCLEO DA PROVA: payloads devem ser indistinguíveis
  const indistJ = eq(vidaJ_A, vidaJ_B);
  const indistE = eq(vidaE_A, vidaE_B);
  console.log(`  ==> jogador:    vida_A==vida_B? ${indistJ}   (atual ${vidaJ_A?.hp?.atual} vs ${vidaJ_B?.hp?.atual}, max ${vidaJ_A?.hp?.maximo} vs ${vidaJ_B?.hp?.maximo})`);
  console.log(`  ==> espectador: vida_A==vida_B? ${indistE}   (atual ${vidaE_A?.hp?.atual} vs ${vidaE_B?.hp?.atual}, max ${vidaE_A?.hp?.maximo} vs ${vidaE_B?.hp?.maximo})`);
  t("P1: payload do JOGADOR indistinguível entre NPCs", indistJ,
    `diverge: ${JSON.stringify(vidaJ_A)} !== ${JSON.stringify(vidaJ_B)}`);
  t("P1: payload do ESPECTADOR indistinguível entre NPCs", indistE,
    `diverge: ${JSON.stringify(vidaE_A)} !== ${JSON.stringify(vidaE_B)}`);

  // Controle: flag OFF → vida=null para não-mestres → idêntico por construção
  sec("Controle vidaCompartilhada=false");
  await req(BASE, "PUT", `/campaigns/${ids.camp}/regras/config`, { cookie: ids.cookieMestre, body: { vtt: { vidaCompartilhada: false } } });
  const rJ3 = await sincronizar(sJ);
  const rE3 = await sincronizar(sE);
  const cJ_A = tok(rJ3?.vtt, "tknpc-a1")?.vida;
  const cJ_B = tok(rJ3?.vtt, "tknpc-b2")?.vida;
  const cE_A = tok(rE3?.vtt, "tknpc-a1")?.vida;
  const cE_B = tok(rE3?.vtt, "tknpc-b2")?.vida;
  t("controle jogador: vida=null nos dois NPCs", cJ_A == null && cJ_B == null, `A=${JSON.stringify(cJ_A)} B=${JSON.stringify(cJ_B)}`);
  t("controle espectador: vida=null nos dois NPCs", cE_A == null && cE_B == null);
} catch (e) {
  fail++;
  console.log("  FALHOU exceção:", String(e?.stack ?? e).slice(0, 800));
} finally {
  for (const s of sockets) { try { s.close(); } catch { } }
  await encerrarServidor(proc);
  limparDir(DIR);
}
console.log(`\n==== vtt-vida-p1: ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
