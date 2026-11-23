// Homologação combinada — vida nos tokens (Issue #127) × régua de
// distância (Issue #125/#178): os indicadores de HP/vitalidade NÃO
// podem quebrar o snap da régua, em desktop (mouse) e mobile (toque
// real via CDP). Também verifica que vida continua transitória por
// destinatário e nunca é persistida em vtt_state.
// Banco 100% descartável.
import crypto from "node:crypto";
import zlib from "node:zlib";
import { chromium } from "playwright";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { io as ioClient } from "socket.io-client";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, sessao, abrirDb, encerrarServidor, limparDir, req,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

// ---------- PNG 1600x1000 (mesma geometria do homologacao-regua) ----------
const crcTable = (() => {
  const tab = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tab[n] = c >>> 0;
  }
  return tab;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (tipo, dados) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(dados.length);
  const td = Buffer.concat([Buffer.from(tipo, "ascii"), dados]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
function pngSolido(w, h, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const linha = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) { linha[1 + x * 3] = r; linha[2 + x * 3] = g; linha[3 + x * 3] = b; }
  const cru = Buffer.concat(Array.from({ length: h }, () => linha));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(cru)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const DIR = dirTeste("vida-regua");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const SHOTS = join(process.cwd(), "_evidencias", "vida-regua");
mkdirSync(SHOTS, { recursive: true });
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const MAPA_PATH = join(DIR, "mapa-16x10.png");
writeFileSync(MAPA_PATH, pngSolido(1600, 1000, [60, 90, 140]));

const CFG = {
  hp: { habilitado: true, base: 100, porNivel: 10, semantico: "atributo", edicaoPor: "mestre" },
  vitalidade: {
    edicaoPor: "mestre",
    niveis: [
      { nome: "São", penalidadeDados: 0, bloqueiaAcoes: false },
      { nome: "Machucado", penalidadeDados: 1, bloqueiaAcoes: false },
    ],
  },
};

let browser, proc, ids, sid;
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
const centroToken = (page, ini) => page.locator(".vtt-token", { hasText: ini }).first().evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
const arrastar = async (page, de, para) => {
  await page.mouse.move(de.x, de.y);
  await page.mouse.down();
  await page.mouse.move((de.x + para.x) / 2, (de.y + para.y) / 2, { steps: 4 });
  await page.mouse.move(para.x, para.y, { steps: 4 });
  await page.mouse.up();
};
const ligarRegua = async (page) => {
  if ((await page.locator(".vtt-tabuleiro-regua").count()) === 0) {
    await page.getByRole("button", { name: "Régua", exact: true }).click();
    await page.locator(".vtt-tabuleiro-regua").waitFor({ timeout: 8000 });
  }
};
function socketMestre() {
  const token = decodeURIComponent(ids.cookieMestre.split("=")[1]);
  const s = ioClient(BASE, {
    path: "/socket.io", transports: ["websocket", "polling"],
    extraHeaders: { cookie: `mestre_rpg_session=${encodeURIComponent(token)}` },
    reconnection: false,
  });
  return s;
}
const emitirCb = (s, ev, p) => new Promise((r) => {
  const to = setTimeout(() => r({ ok: false, erro: "timeout" }), 8000);
  s.emit(ev, p, (x) => { clearTimeout(to); r(x); });
});

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", () => {});
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO, {
    jogadores: { jogador1: "vr_j1", jogador2: "vr_j2" },
    config: CFG,
  });
  ids = { camp: c.campId, cookieMestre: c.cookieMestre, j1: c.jogadores.jogador1.id };

  // personagens com vida: Ana (j1, HP 120/150, vit 1) e Beto (j2, HP 80/150)
  const PJ1 = c.novoPersonagem(c.jogadores.jogador1.membershipId, "Ana", { __hp: { atual: 120, historico: [] }, __vitalidade: { nivel: 1, nivelManual: 1 } });
  const PJ2 = c.novoPersonagem(c.jogadores.jogador2.membershipId, "Beto", { __hp: { atual: 80, historico: [] } });

  const sess = await req(BASE, "POST", `/campaigns/${c.campId}/sessoes`, { cookie: c.cookieMestre, body: { name: "Mesa Vida Régua" } });
  sid = sess.json?.sessao?.id ?? sess.json?.id;
  t("sessão criada", !!sid);

  browser = await chromium.launch();
  const ctxM = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const pgM = await ctxM.newPage();
  vigiar(pgM, "mestre");
  await login(pgM, "mestre_teste", "senha-forte-123");
  await irMesa(pgM);
  await abrirSessao(pgM, "Mesa Vida Régua");

  // mapa 1600x1000 via upload real do mestre
  await pgM.locator(".mesa-vtt input[type=file]").setInputFiles(MAPA_PATH);
  await pgM.locator(".vtt-tabuleiro").waitFor({ timeout: 15000 });
  await pgM.waitForFunction(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.trim() === "Régua");
    return b && !b.disabled;
  }, { timeout: 15000 });

  // tokens com vida via socket real (personagemId não existe na UI)
  const sM = socketMestre();
  await new Promise((res, rej) => { sM.on("connect", res); sM.on("connect_error", rej); });
  const criarTok = (id, extra) => emitirCb(sM, "mesa:vtt:token", {
    sessionId: sid, acao: "criar",
    token: { id, nome: id, cor: "#4f8ef7", x: 0.2, y: 0.5, ...extra },
  });
  t("token Ana criado",
    (await criarTok("tkanavida1", { nome: "Ana", personagemId: PJ1, userId: ids.j1 }))?.ok === true);
  t("token Beto criado",
    (await criarTok("tkbetovida2", { nome: "Beto", personagemId: PJ2, x: 0.8, y: 0.5 }))?.ok === true);
  await pgM.locator(".vtt-token", { hasText: "AN" }).waitFor({ timeout: 10000 });
  await pgM.locator(".vtt-token", { hasText: "BE" }).waitFor({ timeout: 10000 });
  await pgM.waitForTimeout(600);

  // indicadores de vida presentes ANTES da medida (mestre vê todos)
  t("HP bar + badge vitalidade renderizados",
    await pgM.locator(".vtt-token", { hasText: "AN" }).locator(".vtt-token-hp").count() === 1
    && await pgM.locator(".vtt-token", { hasText: "AN" }).locator(".vtt-token-vit").count() === 1
    && await pgM.locator(".vtt-token", { hasText: "BE" }).locator(".vtt-token-hp").count() === 1);

  // calibração via socket real: 100 un. mapa = 1,5 m
  const cal = await emitirCb(sM, "mesa:vtt:mapa", {
    sessionId: sid, acao: "calibrar",
    regua: { unidade: "m", distanciaReferencia: 100, valorReferencia: 1.5 },
  });
  t("calibração aceita", cal?.ok === true, JSON.stringify(cal).slice(0, 120));

  // ---------- A. Desktop: snap token→token COM indicadores de vida ----------
  sec("A. Desktop — régua snap com HP/vitalidade visíveis");
  await ligarRegua(pgM);
  const cAna = await centroToken(pgM, "AN");
  const cBeto = await centroToken(pgM, "BE");
  // o gesto começa exatamente sobre o badge/HP do token — snap deve
  // resolver via .closest(".vtt-token") mesmo com o filho indicador
  // por cima do centro do botão
  await arrastar(pgM, cAna, cBeto);
  await pgM.locator(".vtt-regua-rotulo").waitFor({ timeout: 8000 });
  const rotM = await pgM.locator(".vtt-regua-rotulo").textContent();
  // dx=0.6 → 960 un → 960/100*1.5 = 14,4 m
  t("snap token→token com indicadores → 14,4 m", /14[.,]4/.test(rotM ?? ""), rotM);
  t("dois pontos snap (não ponto livre)", await pgM.locator(".vtt-regua-ponto").count() === 2);
  // indicadores continuam visíveis após a medida
  t("indicadores de vida intactos pós-medida",
    await pgM.locator(".vtt-token", { hasText: "AN" }).locator(".vtt-token-hp").count() === 1);
  await pgM.screenshot({ path: join(SHOTS, "vida-regua-01-desktop.png") });
  await pgM.keyboard.press("Escape");
  await pgM.waitForTimeout(150);

  // ---------- B. Mobile: toque real token→token com indicadores ----------
  sec("B. Mobile 390x844 — toque real com indicadores de vida");
  const ctxJ = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const pgJ = await ctxJ.newPage();
  vigiar(pgJ, "jogador-mobile");
  await login(pgJ, "vr_j1", "senha-jogador-123");
  await irMesa(pgJ);
  await abrirSessao(pgJ, "Mesa Vida Régua");
  await pgJ.locator(".vtt-tabuleiro").waitFor({ timeout: 15000 });
  // jogador vê vida só do próprio personagem (flag OFF) — Ana tem
  // HP bar + badge; snap não pode depender de vida visível em ambos
  await pgJ.locator(".vtt-token", { hasText: "AN" }).waitFor({ timeout: 10000 });
  await pgJ.locator(".vtt-token", { hasText: "BE" }).waitFor({ timeout: 10000 });
  await pgJ.waitForFunction(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.trim() === "Régua");
    return b && !b.disabled;
  }, { timeout: 15000 });
  t("mobile: indicador de vida visível no token próprio",
    await pgJ.locator(".vtt-token", { hasText: "AN" }).locator(".vtt-token-hp").count() === 1);
  await ligarRegua(pgJ);
  const cdp = await ctxJ.newCDPSession(pgJ);
  const g1 = await centroToken(pgJ, "AN");
  const g2 = await centroToken(pgJ, "BE");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: g1.x, y: g1.y, id: 1 }] });
  const PASSOS = 10;
  for (let i = 1; i <= PASSOS; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: g1.x + ((g2.x - g1.x) * i) / PASSOS, y: g1.y + ((g2.y - g1.y) * i) / PASSOS, id: 1 }],
    });
    await pgJ.waitForTimeout(25);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await pgJ.locator(".vtt-regua-rotulo").waitFor({ timeout: 8000 });
  const rotJ = await pgJ.locator(".vtt-regua-rotulo").textContent();
  t("toque real token→token com vida → snap e distância correta",
    /14[.,]4/.test(rotJ ?? "") && (await pgJ.locator(".vtt-regua-ponto").count()) === 2, rotJ);
  await pgJ.screenshot({ path: join(SHOTS, "vida-regua-02-mobile.png") });

  // ---------- C. Vida nunca persistida em vtt_state ----------
  sec("C. vtt_state sem dados transitórios de vida");
  {
    const db = abrirDb(BANCO);
    const row = db.prepare("select vtt_state from sessions where id=?").get(sid);
    db.close();
    const st = JSON.parse(typeof row.vtt_state === "string" ? row.vtt_state : JSON.stringify(row.vtt_state));
    const toks = st.tokens ?? [];
    t("vtt_state persiste calibração da régua", !!st.regua && st.regua.unidade === "m");
    t("tokens persistidos sem campo vida",
      toks.length >= 2 && toks.every((tk) => !("vida" in tk)),
      JSON.stringify(toks.map((tk) => Object.keys(tk))));
  }

  // ---------- D. Higiene ----------
  sec("D. Higiene");
  const errosReais = errosConsole.filter((e) => !/401|Failed to load resource/.test(e));
  t("sem erros de console/pageerror", errosReais.length === 0, errosReais.slice(0, 3).join(" | "));

  console.log(`\n==== homologacao-vida-regua: ${pass} ok, ${fail} falhas ====`);
} catch (e) {
  console.error("FALHA GERAL:", e);
  fail++;
} finally {
  try { sM?.close(); } catch {}
  try { await browser?.close(); } catch {}
  try { await encerrarServidor(proc); } catch {}
  try { limparDir(DIR); } catch (e2) { console.log("[limpeza]", e2.message); }
}
process.exit(fail ? 1 : 0);
