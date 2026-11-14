// Teste P6 — rollback otimista de tokens (Mesa Virtual Etapa 1).
// Versão versionada da auditoria adversarial: intercepta quadros
// Socket.IO via routeWebSocket para controlar deterministicamente os
// acknowledgements de `mesa:vtt:token`:
//   proxEvento:'hold' → pacote não chega ao servidor
//   proxAck:'hold'    → ack do servidor fica retido (entrega manual depois)
//   injetarAck        → ack sintético {ok:false} entregue ao cliente
// Atualizações autoritativas `mesa:vtt` sempre fluem, exceto quando o
// evento foi retido (servidor nunca processou → sem broadcast).
//
// Framing: WS message = engine.io packets separados por \x1e; tipo '4'
// (message) carrega socket.io packets (também separados por \x1e):
//   sio = <tipo><id?><json>   EVENT=2 ACK=3  (nsp "/" omitido)
import { chromium } from "playwright";
import { io as ioClient } from "socket.io-client";
import crypto from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, abrirDb, sessao, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");
const quase = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;

const DIR = dirTeste("p6-rollback");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const SHOTS = join(DIR, "shots");
mkdirSync(SHOTS, { recursive: true });
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");
const PNG_PATH = join(DIR, "mapa.png");
writeFileSync(PNG_PATH, PNG);

// ---------- parsing socket.io sobre engine.io ----------
function parseSio(p) {
  const tipo = p[0];
  let i = 1;
  if (p[i] === "/") { const c = p.indexOf(",", i); i = c < 0 ? p.length : c + 1; }
  let id = null;
  while (i < p.length && p[i] >= "0" && p[i] <= "9") { id = (id ?? "") + p[i]; i++; }
  let dados = null;
  try { dados = JSON.parse(p.slice(i)); } catch { /* não-json */ }
  return { tipo, id: id === null ? null : Number(id), dados, cru: p };
}
// retorna [{ eng:string, sios:[{...cru}] }] — eng = pacote engine.io cru
function decodificar(msg) {
  return msg.split("\x1e").filter(Boolean).map((eng) => ({
    eng,
    sios: eng[0] === "4" ? eng.slice(1).split("\x1e").filter(Boolean).map(parseSio) : [],
  }));
}
const ehEventoToken = (s) => s.tipo === "2" && s.dados?.[0] === "mesa:vtt:token" && s.id !== null;
const ehAck = (s) => s.tipo === "3" && s.id !== null;

// estado global do interceptador
const ctrl = { proxEvento: "pass", proxAck: "pass" };
const stats = {
  ops: [],          // {ackId, evento, ack} por emissão interceptada
  acksRetidos: [],  // {ackId, cru} acks reais segurados
  senders: new Map(), // page -> fn(wsMessageString) p/ injetar frames
  passivos: 0,
};

function interceptar(page) {
  page.routeWebSocket(/socket\.io/, (ws) => {
    const server = ws.connectToServer();
    stats.senders.set(page, (m) => ws.send(m));
    const ackModo = new Map(); // ackId -> 'hold'|'pass'
    const DEBUG = !!process.env.P6_DEBUG;
    let dbgN = 0;
    ws.onMessage((msg) => { // página -> servidor
      const s = msg.toString();
      if (DEBUG && dbgN < 12 && /vtt|entrar/.test(s)) { dbgN++; console.log("  [C→S]", s.slice(0, 200)); }
      const frames = decodificar(s);
      const tok = frames.flatMap((f) => f.sios).find(ehEventoToken);
      if (!tok) { server.send(msg); return; }
      const modo = { evento: ctrl.proxEvento, ack: ctrl.proxAck };
      ctrl.proxEvento = "pass"; ctrl.proxAck = "pass";
      stats.ops.push({ ackId: tok.id, ...modo });
      if (modo.evento === "hold") return; // nunca chega ao servidor
      // encaminha; se o frame contém outros pacotes, preserva todos
      server.send(msg);
      if (modo.ack === "hold") ackModo.set(tok.id, "hold");
    });
    server.onMessage((msg) => { // servidor -> página
      const s = msg.toString();
      if (DEBUG && dbgN < 24 && /vtt|entrar/.test(s)) { dbgN++; console.log("  [S→C]", s.slice(0, 200)); }
      const frames = decodificar(s);
      const acks = frames.flatMap((f) => f.sios).filter(ehAck);
      const segurados = acks.filter((a) => ackModo.get(a.id) === "hold");
      if (!segurados.length) { ws.send(msg); return; }
      segurados.forEach((a) => {
        ackModo.delete(a.id);
        stats.acksRetidos.push({ ackId: a.id, cru: a.cru });
      });
      // reconstrói o frame sem os acks segurados
      const partes = [];
      for (const f of frames) {
        if (f.eng[0] !== "4") { partes.push(f.eng); continue; }
        const restantes = f.sios.filter((x) => !(ehAck(x) && segurados.some((g) => g.cru === x.cru)));
        if (restantes.length) partes.push("4" + restantes.map((x) => x.cru).join("\x1e"));
      }
      if (partes.length) ws.send(partes.join("\x1e"));
    });
  });
}
function injetarAck(page, ackId, payload) {
  const send = stats.senders.get(page);
  if (!send) throw new Error("página sem sender WS registrado");
  send(`4` + `3${ackId}` + JSON.stringify([payload]));
}
function entregarAck(page, ack) {
  const send = stats.senders.get(page);
  if (!send) return false;
  send(`4` + ack.cru);
  return true;
}

let browser, proc;
const errosConsole = [];
function vigiar(page, tag) {
  page.on("pageerror", (e) => errosConsole.push(`${tag}:pageerror:${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const txt = m.text();
    if (/401|Failed to load resource/.test(txt)) return;
    errosConsole.push(`${tag}:console:${txt.slice(0, 160)}`);
  });
}
async function login(page, user, senha) {
  await page.goto(BASE);
  await page.getByLabel("Usuário").fill(user);
  await page.getByLabel("Senha").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByText("Servidor online").waitFor({ timeout: 15000 });
}
async function irMesa(page) {
  await page.getByRole("button", { name: "Campanhas" }).click();
  await page.getByText("Campanha Teste", { exact: true }).first().click();
  await page.locator(".abas button", { hasText: "Mesa" }).first().click();
}
async function abrirSessao(page, nome) {
  const linha = page.locator("tr.clicavel", { hasText: nome });
  await linha.first().waitFor({ timeout: 15000 });
  await linha.first().click();
  await page.locator(".vtt-tabuleiro, .mesa-vtt .dica, .mesa-vtt h3").first().waitFor({ timeout: 15000 });
}

// ---------- helpers de token ----------
async function posToken(page, txt) {
  const el = page.locator(".vtt-token", { hasText: txt }).first();
  return el.evaluate((e) => ({ x: parseFloat(e.style.left) / 100, y: parseFloat(e.style.top) / 100 }));
}
async function esperarPos(page, txt, frac, tol = 0.02, timeout = 6000) {
  const ini = Date.now();
  let p = await posToken(page, txt);
  while (Date.now() - ini < timeout) {
    p = await posToken(page, txt);
    if (quase(p.x, frac.x, tol) && quase(p.y, frac.y, tol)) return p;
    await page.waitForTimeout(120);
  }
  return p;
}
async function arrastar(page, txt, toFrac) {
  const tok = page.locator(".vtt-token", { hasText: txt }).first();
  const tb = await page.locator(".vtt-tabuleiro").boundingBox();
  const tokBox = await tok.boundingBox();
  if (!tb || !tokBox) throw new Error("tabuleiro/token sem bounding box");
  // índice do token entre todos os .vtt-token (querySelector pegaria sempre o 1º)
  const textos = await page.locator(".vtt-token").allTextContents();
  const idx = textos.findIndex((x) => x.includes(txt));
  if (idx < 0) throw new Error(`token "${txt}" não encontrado: ${JSON.stringify(textos)}`);
  const cx = tokBox.x + tokBox.width / 2, cy = tokBox.y + tokBox.height / 2;
  const tx = tb.x + toFrac.x * tb.width, ty = tb.y + toFrac.y * tb.height;
  await page.evaluate(([i, px, py, qx, qy]) => {
    const el = document.querySelectorAll(".vtt-token")[i];
    el.dispatchEvent(new PointerEvent("pointerdown", { clientX: px, clientY: py, pointerId: 11, bubbles: true }));
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: qx, clientY: qy, pointerId: 11, bubbles: true }));
    window.dispatchEvent(new PointerEvent("pointerup", { clientX: qx, clientY: qy, pointerId: 11, bubbles: true }));
  }, [idx, cx, cy, tx, ty]);
  await page.waitForTimeout(150);
  return { alvo: { x: (tx - tb.x) / tb.width, y: (ty - tb.y) / tb.height } };
}
function novoUsuario(banco, { username, role = null, permissions = {}, campId }) {
  const db = abrirDb(banco);
  try {
    const uid = crypto.randomUUID(), agora = Date.now();
    db.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
      .run(uid, username, username, "x", agora, agora);
    let mid = null;
    if (role) {
      mid = crypto.randomUUID();
      db.prepare("insert into memberships (id,campaign_id,user_id,role,status,permissions,joined_at,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
        .run(mid, campId, uid, role, "ativo", JSON.stringify(permissions), agora, agora, agora);
    }
    return { id: uid, membershipId: mid, cookie: sessao(banco, uid) };
  } finally { db.close(); }
}
const conectar = (cookie) => {
  const token = decodeURIComponent(cookie.split("=")[1]);
  return ioClient(BASE, {
    path: "/socket.io", transports: ["websocket", "polling"],
    extraHeaders: { cookie: `mestre_rpg_session=${encodeURIComponent(token)}` },
    reconnection: false,
  });
};
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const emitirUmaVez = (s, ev, p) => new Promise((r) => s.emit(ev, p, r));
// Rate limit Socket.IO (#68): aguarda retryAfterMs e repete. Rejeições de
// negócio (ok:false sem codigo) não são repetidas.
const emitirCb = async (s, ev, p) => {
  for (let i = 0; i < 5; i++) {
    const r = await emitirUmaVez(s, ev, p);
    if (r?.codigo !== "RATE_LIMITED") return r;
    await dormir(Math.min(r.retryAfterMs ?? 500, 2500) + 50);
  }
  return emitirUmaVez(s, ev, p);
};
const pronto = (s) => new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
function tokenIdDoBanco(banco, sessionId, nome) {
  const db = abrirDb(banco);
  try {
    const row = db.prepare("select vtt_state from sessions where id=?").get(sessionId);
    const vtt = JSON.parse(row?.vtt_state ?? "{}");
    return (vtt.tokens ?? []).find((x) => x.nome === nome)?.id ?? null;
  } finally { db.close(); }
}

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", () => {});
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO, { jogadores: { jogador1: "p6_j1" } });
  const esp = novoUsuario(BANCO, { username: "p6_esp", role: "espectador", permissions: {}, campId: c.campId });
  const sess = await req(BASE, "POST", `/campaigns/${c.campId}/sessoes`, { cookie: c.cookieMestre, body: { name: "P6 Audit" } });
  const sid = sess.json?.sessao?.id ?? sess.json?.id;
  t("setup: sessão criada", !!sid, JSON.stringify(sess.json).slice(0, 120));

  browser = await chromium.launch();
  const ctxJ1 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pgJ1 = await ctxJ1.newPage();
  interceptar(pgJ1);
  vigiar(pgJ1, "j1");
  const ctxM = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pgM = await ctxM.newPage();
  vigiar(pgM, "m");

  await login(pgJ1, "p6_j1", "senha-jogador-123");
  await login(pgM, "mestre_teste", "senha-forte-123");
  await Promise.all([irMesa(pgJ1), irMesa(pgM)]);
  await abrirSessao(pgJ1, "P6 Audit");
  await abrirSessao(pgM, "P6 Audit");

  // mestre: mapa + token AN (dono jogador1) + token BE (sem dono)
  await pgM.locator(".mesa-vtt input[type=file]").setInputFiles(PNG_PATH);
  await pgM.locator(".vtt-tabuleiro").waitFor({ timeout: 10000 });
  await pgJ1.locator(".vtt-tabuleiro").waitFor({ timeout: 10000 });
  await pgM.locator(".vtt-controles input").fill("Ana");
  await pgM.locator(".vtt-controles select").selectOption(c.jogadores.jogador1.id);
  await pgM.locator(".vtt-controles button.primario").click();
  await pgJ1.locator(".vtt-token", { hasText: "AN" }).waitFor({ timeout: 8000 });
  await pgM.locator(".vtt-controles input").fill("Beto");
  await pgM.locator(".vtt-controles select").selectOption("");
  await pgM.locator(".vtt-controles button.primario").click();
  await pgJ1.locator(".vtt-token", { hasText: "BE" }).waitFor({ timeout: 8000 });
  await pgJ1.waitForTimeout(400);
  t("setup: interceptador ativo", stats.senders.has(pgJ1), "");

  const A0 = await posToken(pgJ1, "AN");
  console.log("posição inicial AN:", JSON.stringify(A0));

  // ---------- P6.1 movimento aceito ----------
  sec("P6.1 movimento aceito");
  const B1 = { x: 0.25, y: 0.30 };
  await arrastar(pgJ1, "AN", B1);
  await pgJ1.waitForTimeout(900);
  let p = await esperarPos(pgJ1, "AN", B1);
  t("P6.1 token permanece em B após ok", quase(p.x, B1.x) && quase(p.y, B1.y), JSON.stringify(p));
  const pM1 = await posToken(pgM, "AN");
  t("P6.1 mestre vê B (broadcast)", quase(pM1.x, B1.x, 0.03), JSON.stringify(pM1));

  // ---------- P6.2 rejeição explícita ----------
  sec("P6.2 rejeição explícita");
  const C2 = { x: 0.70, y: 0.65 };
  ctrl.proxEvento = "hold"; ctrl.proxAck = "hold";
  const d2 = await arrastar(pgJ1, "AN", C2);
  t("P6.2 otimista foi para C", quase(d2.alvo.x, C2.x, 0.03), JSON.stringify(d2.alvo));
  const op2 = stats.ops[stats.ops.length - 1];
  injetarAck(pgJ1, op2.ackId, { ok: false, erro: "audit: rejeitado" });
  await pgJ1.waitForTimeout(400);
  p = await posToken(pgJ1, "AN");
  t("P6.2 token retornou a B (último confirmado)", quase(p.x, B1.x, 0.03) && quase(p.y, B1.y, 0.03), JSON.stringify(p));

  // ---------- P6.3 timeout sem resposta ----------
  sec("P6.3 timeout 5s (evento retido — servidor nunca vê)");
  const D3 = { x: 0.15, y: 0.75 };
  ctrl.proxEvento = "hold"; ctrl.proxAck = "hold";
  await arrastar(pgJ1, "AN", D3);
  await pgJ1.waitForTimeout(5600);
  p = await posToken(pgJ1, "AN");
  const erroTxt = await pgJ1.locator(".mesa-vtt .erro").allTextContents().catch(() => []);
  t("P6.3 token retornou a B após timeout", quase(p.x, B1.x, 0.03) && quase(p.y, B1.y, 0.03), JSON.stringify({ p, erroTxt }));
  t("P6.3 mensagem de timeout exibida", erroTxt.join(" ").includes("Sem resposta"), JSON.stringify(erroTxt));

  // ---------- P6.3b ack perdido mas broadcast recebido ----------
  sec("P6.3b ack perdido, broadcast mesa:vtt entregue");
  const E3 = { x: 0.80, y: 0.20 };
  ctrl.proxEvento = "pass"; ctrl.proxAck = "hold";
  await arrastar(pgJ1, "AN", E3);
  await pgJ1.waitForTimeout(800);
  p = await esperarPos(pgJ1, "AN", E3, 0.03, 4000);
  const antesTimeout = { ...p };
  await pgJ1.waitForTimeout(5000); // timeout real dispara
  p = await posToken(pgJ1, "AN");
  const pM3 = await posToken(pgM, "AN");
  console.log("   P6.3b J1 pós-timeout:", JSON.stringify(p), "| mestre:", JSON.stringify(pM3), "| antes:", JSON.stringify(antesTimeout));
  const diverge = !(quase(p.x, pM3.x, 0.03) && quase(p.y, pM3.y, 0.03));
  t("P6.3b broadcast vence: timeout NÃO reverte posição já confirmada", !diverge, JSON.stringify({ j1: p, mestre: pM3 }));
  // realinha J1 com a verdade do servidor para os próximos cenários
  await arrastar(pgM, "AN", B1);
  await pgJ1.waitForTimeout(900);
  p = await esperarPos(pgJ1, "AN", B1, 0.03, 5000);
  t("P6.3b realinhamento via mestre", quase(p.x, B1.x, 0.03), JSON.stringify(p));

  // ---------- P6.4 atualização autoritativa mais recente ----------
  sec("P6.4 autoridade chega antes do reject antigo");
  const F4 = { x: 0.35, y: 0.60 };
  ctrl.proxEvento = "hold"; ctrl.proxAck = "hold";
  await arrastar(pgJ1, "AN", F4);
  const G4 = { x: 0.55, y: 0.45 };
  await arrastar(pgM, "AN", G4);
  await pgJ1.waitForTimeout(800);
  p = await esperarPos(pgJ1, "AN", G4, 0.03, 5000);
  t("P6.4a cliente recebeu autoridade G", quase(p.x, G4.x, 0.03), JSON.stringify(p));
  const op4 = stats.ops[stats.ops.length - 1];
  injetarAck(pgJ1, op4.ackId, { ok: false, erro: "audit: rejeitado" });
  await pgJ1.waitForTimeout(400);
  p = await posToken(pgJ1, "AN");
  t("P6.4a reject antigo NÃO sobrescreve G", quase(p.x, G4.x, 0.03), JSON.stringify(p));

  // ---------- P6.5 dois drags, 1ª rejeitada ----------
  sec("P6.5 dois drags rápidos — 1ª op rejeitada");
  const H5 = { x: 0.60, y: 0.30 }, I5 = { x: 0.85, y: 0.70 };
  ctrl.proxEvento = "hold"; ctrl.proxAck = "hold";
  await arrastar(pgJ1, "AN", H5);          // op1 retida
  ctrl.proxEvento = "pass"; ctrl.proxAck = "pass";
  await arrastar(pgJ1, "AN", I5);          // op2 confirmada
  await pgJ1.waitForTimeout(900);
  p = await esperarPos(pgJ1, "AN", I5, 0.03, 5000);
  t("P6.5 2º movimento confirmado em I", quase(p.x, I5.x, 0.03), JSON.stringify(p));
  const op5a = stats.ops[stats.ops.length - 2];
  injetarAck(pgJ1, op5a.ackId, { ok: false, erro: "audit: rejeitado" });
  await pgJ1.waitForTimeout(400);
  p = await posToken(pgJ1, "AN");
  t("P6.5 reject antigo não destrói I", quase(p.x, I5.x, 0.03) && quase(p.y, I5.y, 0.03), JSON.stringify(p));

  // ---------- P6.6 dois drags, 2ª rejeitada ----------
  sec("P6.6 dois drags rápidos — 2ª op rejeitada");
  const J6 = { x: 0.45, y: 0.80 }, K6 = { x: 0.10, y: 0.15 };
  ctrl.proxEvento = "pass"; ctrl.proxAck = "hold";
  await arrastar(pgJ1, "AN", J6);          // servidor confirma J; ack retido
  await pgJ1.waitForTimeout(800);
  p = await esperarPos(pgJ1, "AN", J6, 0.03, 5000);
  t("P6.6 1º movimento confirmado em J", quase(p.x, J6.x, 0.03), JSON.stringify(p));
  ctrl.proxEvento = "hold"; ctrl.proxAck = "hold";
  await arrastar(pgJ1, "AN", K6);          // op2 retida
  const op6b = stats.ops[stats.ops.length - 1];
  injetarAck(pgJ1, op6b.ackId, { ok: false, erro: "audit: rejeitado" });
  await pgJ1.waitForTimeout(400);
  p = await posToken(pgJ1, "AN");
  t("P6.6 volta à última posição confirmada J", quase(p.x, J6.x, 0.03) && quase(p.y, J6.y, 0.03), JSON.stringify(p));
  // entrega o ack retido da op1 (ok:true) — não pode reverter nada
  const ret6 = stats.acksRetidos.find((a) => a.ackId === stats.ops[stats.ops.length - 2].ackId);
  if (ret6) { entregarAck(pgJ1, ret6); stats.acksRetidos.splice(stats.acksRetidos.indexOf(ret6), 1); }
  await pgJ1.waitForTimeout(300);
  p = await posToken(pgJ1, "AN");
  t("P6.6 ack tardio ok não altera J", quase(p.x, J6.x, 0.03), JSON.stringify(p));

  // ---------- P6.7 respostas fora de ordem ----------
  sec("P6.7 respostas fora de ordem");
  const L7 = { x: 0.75, y: 0.55 }, M7 = { x: 0.30, y: 0.90 };
  ctrl.proxEvento = "hold"; ctrl.proxAck = "hold"; // op1 totalmente retida
  await arrastar(pgJ1, "AN", L7);
  ctrl.proxEvento = "pass"; ctrl.proxAck = "hold"; // op2: servidor confirma M; ack retido
  await arrastar(pgJ1, "AN", M7);
  await pgJ1.waitForTimeout(800);
  p = await esperarPos(pgJ1, "AN", M7, 0.03, 5000);
  t("P6.7 op2 confirmada em M", quase(p.x, M7.x, 0.03), JSON.stringify(p));
  const op7a = stats.ops[stats.ops.length - 2];
  const op7b = stats.ops[stats.ops.length - 1];
  const ret7b = stats.acksRetidos.find((a) => a.ackId === op7b.ackId);
  if (ret7b) { entregarAck(pgJ1, ret7b); stats.acksRetidos.splice(stats.acksRetidos.indexOf(ret7b), 1); }
  await pgJ1.waitForTimeout(300);
  // resposta "antiga" da op1 chega DEPOIS, como rejeição — não pode reverter M
  injetarAck(pgJ1, op7a.ackId, { ok: false, erro: "audit: rejeitado" });
  await pgJ1.waitForTimeout(400);
  p = await posToken(pgJ1, "AN");
  t("P6.7 reject fora de ordem não reverte M", quase(p.x, M7.x, 0.03) && quase(p.y, M7.y, 0.03), JSON.stringify(p));

  // ---------- P6.8 dois drags rejeitados ----------
  sec("P6.8 dois drags rejeitados");
  const N8 = { x: 0.50, y: 0.50 }, O8 = { x: 0.90, y: 0.40 };
  const confAntes = await posToken(pgJ1, "AN"); // última posição autoritativa = M7
  ctrl.proxEvento = "hold"; ctrl.proxAck = "hold";
  await arrastar(pgJ1, "AN", N8);
  ctrl.proxEvento = "hold"; ctrl.proxAck = "hold"; // re-arma p/ o 2º drag
  await arrastar(pgJ1, "AN", O8);
  const op8a = stats.ops[stats.ops.length - 2];
  const op8b = stats.ops[stats.ops.length - 1];
  injetarAck(pgJ1, op8a.ackId, { ok: false, erro: "audit: rejeitado" });
  await pgJ1.waitForTimeout(200);
  injetarAck(pgJ1, op8b.ackId, { ok: false, erro: "audit: rejeitado" });
  await pgJ1.waitForTimeout(400);
  p = await posToken(pgJ1, "AN");
  console.log("   P6.8 final:", JSON.stringify(p), "| esperado≈", JSON.stringify(confAntes));
  t("P6.8 volta à última posição AUTORITATIVA", quase(p.x, confAntes.x, 0.03) && quase(p.y, confAntes.y, 0.03), JSON.stringify(p));

  // ---------- P6.9 atualização de outro token ----------
  sec("P6.9 token BE atualizado com op de AN pendente");
  const Q9 = { x: 0.65, y: 0.25 }, S9 = { x: 0.88, y: 0.12 };
  ctrl.proxEvento = "hold"; ctrl.proxAck = "hold"; // AN pendente (evento retido)
  await arrastar(pgJ1, "AN", Q9);
  await arrastar(pgM, "BE", S9);                    // broadcast real do mestre
  await pgJ1.waitForTimeout(800);
  p = await esperarPos(pgJ1, "BE", S9, 0.03, 5000);
  t("P6.9 BE recebeu atualização do mestre", quase(p.x, S9.x, 0.03), JSON.stringify(p));
  const anAposBroadcast = await posToken(pgJ1, "AN");
  console.log("   P6.9 AN após broadcast do BE:", JSON.stringify(anAposBroadcast));
  const op9 = stats.ops[stats.ops.length - 1];
  injetarAck(pgJ1, op9.ackId, { ok: false, erro: "audit: rejeitado" });
  await pgJ1.waitForTimeout(400);
  const beDepois = await posToken(pgJ1, "BE");
  const anDepois = await posToken(pgJ1, "AN");
  t("P6.9 BE preservado após rollback de AN", quase(beDepois.x, S9.x, 0.03) && quase(beDepois.y, S9.y, 0.03), JSON.stringify(beDepois));
  console.log("   P6.9 AN final:", JSON.stringify(anDepois), "| BE final:", JSON.stringify(beDepois));

  // ---------- P6.11 token removido durante operação pendente ----------
  sec("P6.11 token removido com drag pendente");
  // mestre cria token CAR do jogador1 pela UI
  await pgM.locator(".vtt-controles input").fill("CAR");
  await pgM.locator(".vtt-controles select").selectOption(c.jogadores.jogador1.id);
  await pgM.locator(".vtt-controles button.primario").click();
  await pgJ1.locator(".vtt-token", { hasText: "CA" }).waitFor({ timeout: 8000 });
  const carId = tokenIdDoBanco(BANCO, sid, "CAR");
  t("P6.11 token CAR criado", !!carId, String(carId));
  // drag de J1 retido (servidor nunca vê) — posição otimista pendente
  ctrl.proxEvento = "hold"; ctrl.proxAck = "hold";
  await arrastar(pgJ1, "CA", { x: 0.20, y: 0.80 });
  const op11 = stats.ops[stats.ops.length - 1];
  // mestre remove o token — broadcast real chega ao J1
  const sockM = conectar(c.cookieMestre);
  await pronto(sockM);
  await emitirCb(sockM, "mesa:entrar", { sessionId: sid });
  const rRem = await emitirCb(sockM, "mesa:vtt:token", { sessionId: sid, acao: "remover", token: { id: carId } });
  t("P6.11 mestre remove token → ok", rRem?.ok === true, JSON.stringify(rRem).slice(0, 120));
  await pgJ1.waitForTimeout(800);
  const carSumiu = await pgJ1.locator(".vtt-token", { hasText: "CA" }).count();
  t("P6.11 broadcast removeu CAR do cliente", carSumiu === 0, `count=${carSumiu}`);
  // rejeição/timeout tardio da operação pendente não pode ressuscitar
  // nem corromper o estado — o token não existe mais no confRef
  injetarAck(pgJ1, op11.ackId, { ok: false, erro: "audit: rejeitado" });
  await pgJ1.waitForTimeout(400);
  t("P6.11 CAR continua ausente após reject tardio",
    (await pgJ1.locator(".vtt-token", { hasText: "CA" }).count()) === 0);
  // AN permanece na posição confirmada (M7) — rollback não tocou em nada
  p = await posToken(pgJ1, "AN");
  t("P6.11 AN preservado", quase(p.x, confAntes.x, 0.03) && quase(p.y, confAntes.y, 0.03), JSON.stringify(p));
  sockM.close();

  // ---------- P6.10 espectador ----------
  sec("P6.10 espectador");
  const sockEsp = conectar(esp.cookie);
  await pronto(sockEsp);
  const rEnt = await emitirCb(sockEsp, "mesa:entrar", { sessionId: sid });
  t("P6.10 espectador entra na sessão", rEnt?.ok === true, JSON.stringify(rEnt).slice(0, 120));
  const idAna = tokenIdDoBanco(BANCO, sid, "Ana");
  t("P6.10 token id resolvido", !!idAna, String(idAna));
  const anSrvAntes = tokenIdDoBanco(BANCO, sid, "Ana");
  void anSrvAntes;
  const vttAntes = JSON.parse((await dbVtt(BANCO, sid)) ?? "{}");
  const posAnaSrv = vttAntes.tokens?.find((x) => x.id === idAna);
  const rMover = await emitirCb(sockEsp, "mesa:vtt:token", { sessionId: sid, acao: "mover", token: { id: idAna, x: 0.05, y: 0.05 } });
  t("P6.10 servidor rejeita movimento de espectador", rMover?.ok === false, JSON.stringify(rMover).slice(0, 140));
  const vttDepois = JSON.parse((await dbVtt(BANCO, sid)) ?? "{}");
  const posAnaSrvDepois = vttDepois.tokens?.find((x) => x.id === idAna);
  t("P6.10 servidor manteve posição de AN", quase(posAnaSrvDepois?.x ?? -9, posAnaSrv?.x ?? -8, 0.001), JSON.stringify({ antes: posAnaSrv, depois: posAnaSrvDepois }));

  // UI do espectador: drag não deve mover (bloqueio no cliente)
  const ctxE = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pgE = await ctxE.newPage();
  interceptar(pgE); // garante que nenhum emit escape se o cliente tentasse
  vigiar(pgE, "esp");
  await pgE.context().addCookies([{ name: "mestre_rpg_session", value: decodeURIComponent(esp.cookie.split("=")[1]), url: BASE }]);
  await pgE.goto(BASE);
  await pgE.waitForTimeout(800);
  // usuário sintético pode não ter "Campanhas" — navega direto se necessário
  try {
    await irMesa(pgE);
  } catch {
    await pgE.goto(`${BASE}/campanhas/${c.campId}?aba=mesa`).catch(() => {});
  }
  try {
    await abrirSessao(pgE, "P6 Audit");
  } catch {
    // fallback: clica na sessão se a lista já estiver visível
    await pgE.locator(".vtt-tabuleiro").waitFor({ timeout: 8000 });
  }
  await pgE.locator(".vtt-tabuleiro").waitFor({ timeout: 10000 });
  const beEspAntes = await posToken(pgE, "BE");
  await arrastar(pgE, "BE", { x: 0.05, y: 0.05 });
  await pgE.waitForTimeout(700);
  const beEspDepois = await posToken(pgE, "BE");
  t("P6.10 espectador UI: drag não move token", quase(beEspDepois.x, beEspAntes.x, 0.03) && quase(beEspDepois.y, beEspAntes.y, 0.03), JSON.stringify({ beEspAntes, beEspDepois }));
  await ctxE.close();
  sockEsp.close();

  t("nenhum erro de console/pageerror", errosConsole.length === 0, errosConsole.slice(0, 3).join(" | "));
  await pgJ1.screenshot({ path: join(SHOTS, "p6-final-j1.png") });
  await browser.close();
  await encerrarServidor(proc);
} catch (e) {
  fail++;
  console.log("FALHOU exceção:", e?.message ?? e);
  console.log((e?.stack ?? "").split("\n").slice(0, 5).join("\n"));
  try { await browser?.close(); } catch {}
  try { await encerrarServidor(proc); } catch {}
} finally {
  limparDir(DIR);
}
console.log(`\n${pass} passaram, ${fail} falharam`);
console.log("stats:", JSON.stringify({ ops: stats.ops.length, acksRetidos: stats.acksRetidos.length }));
process.exit(fail ? 1 : 0);

async function dbVtt(banco, sessionId) {
  const db = abrirDb(banco);
  try {
    return db.prepare("select vtt_state from sessions where id=?").get(sessionId)?.vtt_state ?? null;
  } finally { db.close(); }
}
