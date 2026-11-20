// Homologação E2E — Régua de distância na Mesa Virtual (Issue #125).
// Cobre: gate de geometria (aspectos 16:10, 4:3, panorâmico, retrato em
// desktop e mobile), calibração mestre-only pela UI, medição mouse e
// toque, snap em tokens, privacidade de tokens ocultos, limpeza de
// estado (Esc, troca de mapa/papel/reconexão).
// Banco 100% descartável. Nenhuma medição trafega por socket — apenas
// a calibração é persistida.
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

// ---------- PNG mínimo (RGB 8-bit, cor sólida) ----------
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
  ihdr[8] = 8; ihdr[9] = 2; // 8 bits, RGB
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

const DIR = dirTeste("regua-ui");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const SHOTS = join(process.cwd(), "_evidencias", "regua");
mkdirSync(SHOTS, { recursive: true });
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;

const MAPAS = {
  "16:10": pngSolido(1600, 1000, [60, 90, 140]),
  "4:3": pngSolido(1200, 900, [90, 120, 80]),
  "panoramico": pngSolido(2000, 500, [140, 100, 60]),
  "retrato": pngSolido(500, 1200, [100, 80, 140]),
};
for (const [nome, buf] of Object.entries(MAPAS)) {
  writeFileSync(join(DIR, `mapa-${nome}.png`), buf);
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
const aspectoTabuleiro = (page) => page.locator(".vtt-tabuleiro").evaluate((el) => {
  const r = el.getBoundingClientRect();
  return r.width / r.height;
});
const esperarTabuleiro = (page) => page.locator(".vtt-tabuleiro").waitFor({ timeout: 15000 });
async function uploadMapa(page, arquivo, aspectoEsperado = null) {
  await page.locator(".mesa-vtt input[type=file]").setInputFiles(arquivo);
  await esperarTabuleiro(page);
  // aguarda dims intrínsecas medidas (botão Régua habilitado)
  await page.getByRole("button", { name: "Régua", exact: true }).waitFor({ state: "visible", timeout: 15000 });
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.trim() === "Régua");
    return b && !b.disabled;
  }, { timeout: 15000 });
  // o tabuleiro não desmonta na troca de mapa — espera o aspecto novo
  if (aspectoEsperado != null) {
    await page.waitForFunction((esp) => {
      const el = document.querySelector(".vtt-tabuleiro");
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.height > 0 && Math.abs(r.width / r.height - esp) < 0.02;
    }, aspectoEsperado, { timeout: 15000 });
  }
}
const reguaOn = async (page) => (await page.locator(".vtt-tabuleiro-regua").count()) > 0;
async function ligarRegua(page) {
  if (!(await reguaOn(page))) {
    await page.getByRole("button", { name: "Régua", exact: true }).click();
    await page.locator(".vtt-tabuleiro-regua").waitFor({ timeout: 8000 });
  }
}

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", () => {});
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO, { jogadores: { jogador1: "rg_j1", jogador2: "rg_j2" } });
  const j1 = c.jogadores.jogador1;

  const sess = await req(BASE, "POST", `/campaigns/${c.campId}/sessoes`, { cookie: c.cookieMestre, body: { name: "Mesa Régua UI" } });
  const sid = sess.json?.sessao?.id ?? sess.json?.id;
  t("sessão criada", !!sid);

  // socket de controle (mestre) para posicionar tokens deterministicamente
  const cookieM = decodeURIComponent(c.cookieMestre.split("=")[1]);
  const sockM = ioClient(BASE, {
    path: "/socket.io", transports: ["websocket", "polling"],
    extraHeaders: { cookie: `mestre_rpg_session=${encodeURIComponent(cookieM)}` },
    reconnection: false,
  });
  await new Promise((res, rej) => { sockM.on("connect", res); sockM.on("connect_error", rej); });
  const emitir = (ev, p) => new Promise((r) => { const to = setTimeout(() => r({ ok: false, erro: "timeout" }), 8000); sockM.emit(ev, p, (x) => { clearTimeout(to); r(x); }); });
  await emitir("mesa:entrar", { sessionId: sid });
  const novoToken = async (nome, x, y, extra = {}) => {
    const r = await emitir("mesa:vtt:token", {
      sessionId: sid, acao: "criar",
      token: { nome, cor: "#4f8ef7", x, y, userId: null, personagemId: null, ...extra },
    });
    return r?.vtt?.tokens?.find((tk) => tk.nome === nome)?.id;
  };

  browser = await chromium.launch();
  const ctxM = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const ctxJ = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const pgM = await ctxM.newPage(); const pgJ = await ctxJ.newPage();
  vigiar(pgM, "mestre"); vigiar(pgJ, "jogador");
  await login(pgM, "mestre_teste", "senha-forte-123");
  await login(pgJ, j1.username, "senha-jogador-123");
  await irMesa(pgM); await irMesa(pgJ);
  await abrirSessao(pgM, "Mesa Régua UI");
  await abrirSessao(pgJ, "Mesa Régua UI");

  // ---------- A. Gate de geometria — 4 aspectos em desktop ----------
  sec("A. Geometria do mapa (desktop 1366x768)");
  const aspectos = [["16:10", 1.6], ["4:3", 4 / 3], ["panoramico", 4], ["retrato", 500 / 1200]];
  for (const [nome, esperado] of aspectos) {
    await uploadMapa(pgM, join(DIR, `mapa-${nome}.png`), esperado);
    // estado propagado ao jogador
    await pgJ.locator(".vtt-tabuleiro").waitFor({ timeout: 15000 });
    await pgJ.waitForFunction(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.trim() === "Régua");
      return b && !b.disabled;
    }, { timeout: 15000 });
    const aspM = await aspectoTabuleiro(pgM);
    const aspJ = await aspectoTabuleiro(pgJ);
    t(`mapa ${nome}: aspecto mestre ≈ ${esperado.toFixed(3)}`, Math.abs(aspM - esperado) < 0.02, `obtido ${aspM.toFixed(3)}`);
    t(`mapa ${nome}: aspecto jogador igual`, Math.abs(aspJ - aspM) < 0.01, `jogador ${aspJ.toFixed(3)}`);
  }
  await pgM.screenshot({ path: join(SHOTS, "regua-01-mapa-retrato.png") });

  // volta ao 16:10 para as medições
  await uploadMapa(pgM, join(DIR, "mapa-16:10.png"), 1.6);
  await pgJ.waitForFunction(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.trim() === "Régua");
    return b && !b.disabled;
  }, { timeout: 15000 });

  // ---------- B. Calibração pela UI (mestre) ----------
  sec("B. Calibração pela UI");
  t("jogador NÃO vê botão Calibrar", await pgJ.getByRole("button", { name: "Calibrar régua" }).count() === 0);
  await pgM.getByRole("button", { name: "Calibrar régua" }).click();
  const cal = pgM.locator(".vtt-calibracao");
  await cal.waitFor({ timeout: 8000 });
  const inputs = cal.locator("input");
  await inputs.nth(0).fill("m");
  await inputs.nth(1).fill("100");
  await inputs.nth(2).fill("1.5");
  await cal.getByRole("button", { name: "Salvar escala" }).click();
  const escalaTxt = pgM.locator(".vtt-regua-controles .meta", { hasText: "Escala:" });
  await escalaTxt.waitFor({ timeout: 8000 });
  t("mestre vê escala configurada", /1[.,]5/.test((await escalaTxt.textContent()) ?? ""), await escalaTxt.textContent());
  // jogador recebe a calibração em tempo real
  await pgJ.locator(".vtt-regua-controles .meta", { hasText: "Escala:" }).waitFor({ timeout: 10000 });
  t("jogador vê a escala (calibração compartilhada)", true);

  // ---------- C. Tokens e medição mestre ----------
  sec("C. Medição mestre — token↔token e livre");
  const t1 = await novoToken("Alfa", 0.2, 0.5);
  const t2 = await novoToken("Beta", 0.8, 0.5);
  const t3 = await novoToken("Secreto", 0.5, 0.5, { oculto: true });
  t("3 tokens criados (1 oculto)", !!(t1 && t2 && t3));
  await pgM.locator(".vtt-token").nth(2).waitFor({ timeout: 8000 });
  t("mestre vê token oculto (3 tokens)", await pgM.locator(".vtt-token").count() === 3, String(await pgM.locator(".vtt-token").count()));
  await pgJ.locator(".vtt-token").nth(1).waitFor({ timeout: 8000 });
  t("jogador NÃO vê token oculto (2 tokens)", await pgJ.locator(".vtt-token").count() === 2, String(await pgJ.locator(".vtt-token").count()));

  const centroToken = (page, idx) => page.locator(".vtt-token").nth(idx).evaluate((el) => {
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

  await ligarRegua(pgM);
  t("modo régua ativo (classe)", await pgM.locator(".vtt-tabuleiro.vtt-tabuleiro-regua").count() === 1);
  const c1 = await centroToken(pgM, 0); // Alfa (0.2,0.5)
  const c2 = await centroToken(pgM, 1); // Beta  (0.8,0.5)
  await arrastar(pgM, c1, c2);
  const rotulo = pgM.locator(".vtt-regua-rotulo");
  await rotulo.waitFor({ timeout: 8000 });
  // esperado: dx=0.6 → 0.6*1600=960 un. mapa; 960/100*1.5 = 14,4 m
  const txtRot = await rotulo.textContent();
  t("régua token↔token exibe distância real", /14[.,]4/.test(txtRot ?? ""), txtRot);
  t("linha SVG presente", await pgM.locator(".vtt-regua-svg line").count() === 1);
  t("dois pontos marcados", await pgM.locator(".vtt-regua-ponto").count() === 2);
  await pgM.screenshot({ path: join(SHOTS, "regua-02-medida-token-token.png") });

  // mestre mede token oculto → snap funciona (token está no estado do mestre)
  await pgM.keyboard.press("Escape");
  await pgM.waitForTimeout(150);
  t("Esc limpa a medida", await pgM.locator(".vtt-regua-rotulo").count() === 0);
  const c3 = await centroToken(pgM, 2); // Secreto oculto
  await arrastar(pgM, c1, c3);
  await pgM.locator(".vtt-regua-rotulo").waitFor({ timeout: 8000 });
  // dx=0.3 → 480 un → 7,2 m
  t("mestre mede token oculto recebido", /7[.,]2/.test(await pgM.locator(".vtt-regua-rotulo").textContent() ?? ""), await pgM.locator(".vtt-regua-rotulo").textContent());
  await pgM.keyboard.press("Escape");

  // ponto livre: arrastar em área vazia do tabuleiro
  const box = await pgM.locator(".vtt-tabuleiro").boundingBox();
  await arrastar(pgM, { x: box.x + box.width * 0.1, y: box.y + box.height * 0.8 }, { x: box.x + box.width * 0.1, y: box.y + box.height * 0.2 });
  await pgM.locator(".vtt-regua-rotulo").waitFor({ timeout: 8000 });
  // dy=0.6 → 0.6*1000=600 un → 9 m
  t("ponto livre vertical exibe distância", /9/.test(await pgM.locator(".vtt-regua-rotulo").textContent() ?? ""), await pgM.locator(".vtt-regua-rotulo").textContent());
  await pgM.keyboard.press("Escape"); // limpa a medida local do mestre
  await pgM.waitForTimeout(150);
  t("Esc limpa medida de ponto livre", await pgM.locator(".vtt-regua-rotulo").count() === 0);

  // ---------- D. Jogador mede (só tokens recebidos) ----------
  sec("D. Jogador — régua e privacidade");
  await ligarRegua(pgJ);
  const jc1 = await centroToken(pgJ, 0);
  const jc2 = await centroToken(pgJ, 1);
  await arrastar(pgJ, jc1, jc2);
  await pgJ.locator(".vtt-regua-rotulo").waitFor({ timeout: 8000 });
  t("jogador mede token↔token visível", /14[.,]4/.test(await pgJ.locator(".vtt-regua-rotulo").textContent() ?? ""), await pgJ.locator(".vtt-regua-rotulo").textContent());
  // jogador tenta medir na posição do token oculto (0.5,0.5) → vira ponto livre
  const jbox = await pgJ.locator(".vtt-tabuleiro").boundingBox();
  const pOculto = { x: jbox.x + jbox.width * 0.5, y: jbox.y + jbox.height * 0.5 };
  await arrastar(pgJ, pOculto, { x: pOculto.x + 40, y: pOculto.y });
  await pgJ.locator(".vtt-regua-rotulo").waitFor({ timeout: 8000 });
  t("jogador NÃO snap no token oculto (mede livre)", await pgJ.locator(".vtt-regua-ponto").count() === 2);
  // medição do jogador NÃO aparece no mestre (privacidade da medida)
  t("medida do jogador não vaza ao mestre", await pgM.locator(".vtt-regua-rotulo").count() === 0);
  await pgJ.keyboard.press("Escape");

  // ---------- D2. Exclusividade régua × pincel de névoa ----------
  sec("D2. Régua e pincel são mutuamente exclusivos");
  const metaNevoa = pgM.locator(".vtt-nevoa-controles .meta", { hasText: "Névoa:" });
  const btnPincel = pgM.getByRole("button", { name: "Pincel de névoa" });
  const btnRegua = pgM.getByRole("button", { name: /Régua|Sair da régua/ });
  // com a régua ativa, um gesto no tabuleiro mede — não desenha névoa
  await ligarRegua(pgM);
  const b2 = await pgM.locator(".vtt-tabuleiro").boundingBox();
  await arrastar(pgM,
    { x: b2.x + b2.width * 0.15, y: b2.y + b2.height * 0.85 },
    { x: b2.x + b2.width * 0.15, y: b2.y + b2.height * 0.15 });
  await pgM.locator(".vtt-regua-rotulo").waitFor({ timeout: 8000 });
  t("gesto com régua ativa mede (não vira traço de névoa)",
    await pgM.locator(".vtt-nevoa-canvas-pincel").count() === 0
    && /desativada/.test((await metaNevoa.textContent()) ?? ""));
  await pgM.keyboard.press("Escape");
  await pgM.waitForTimeout(150);
  // ativar o pincel desliga a régua e limpa a medida
  await btnPincel.click();
  t("ativar pincel desliga régua", await pgM.locator(".vtt-tabuleiro-regua").count() === 0);
  t("pincel ativo (canvas interativo)", await pgM.locator(".vtt-nevoa-canvas-pincel").count() === 1);
  // com o pincel ativo, um gesto desenha — não mede
  await arrastar(pgM,
    { x: b2.x + b2.width * 0.2, y: b2.y + b2.height * 0.2 },
    { x: b2.x + b2.width * 0.7, y: b2.y + b2.height * 0.7 });
  // "desativada" contém "ativa" — o wait precisa do padrão completo
  await pgM.waitForFunction(() => /Névoa: ativa \(\d+ traço/.test(
    document.querySelector(".vtt-nevoa-controles .meta")?.textContent ?? ""), null, { timeout: 10000 });
  t("gesto com pincel ativo desenha traço de névoa",
    /ativa \(1 traço\)/.test((await metaNevoa.textContent()) ?? ""), await metaNevoa.textContent());
  t("gesto de pincel não gerou medida de régua", await pgM.locator(".vtt-regua-rotulo").count() === 0);
  // ativar a régua desliga o pincel e limpa o rascunho
  await btnRegua.click();
  await pgM.locator(".vtt-tabuleiro-regua").waitFor({ timeout: 8000 });
  t("ativar régua desliga pincel", await pgM.locator(".vtt-nevoa-canvas-pincel").count() === 0);
  // desfaz a névoa criada pelo teste para não afetar as seções seguintes
  await pgM.getByRole("button", { name: "Revelar tudo" }).click();
  await pgM.locator(".vtt-nevoa-controles .meta", { hasText: "desativada" }).waitFor({ timeout: 10000 });
  t("névoa desativada após limpeza do teste", true);
  await pgM.keyboard.press("Escape");
  await pgM.waitForTimeout(150);

  // ---------- E. Limpeza de estado ----------
  sec("E. Limpeza de estado");
  // troca de mapa desativa a régua (garante modo ativo antes)
  await ligarRegua(pgM);
  await uploadMapa(pgM, join(DIR, "mapa-4:3.png"), 4 / 3);
  t("troca de mapa desativa modo régua", await pgM.locator(".vtt-tabuleiro-regua").count() === 0);
  t("troca de mapa limpa medida", await pgM.locator(".vtt-regua-rotulo").count() === 0);

  // token some → medida limpa
  await ligarRegua(pgM);
  const cA = await centroToken(pgM, 0); const cB = await centroToken(pgM, 1);
  await arrastar(pgM, cA, cB);
  await pgM.locator(".vtt-regua-rotulo").waitFor({ timeout: 8000 });
  await emitir("mesa:vtt:token", { sessionId: sid, acao: "remover", token: { id: t1 } });
  await pgM.waitForTimeout(600);
  t("token removido limpa a medida", await pgM.locator(".vtt-regua-rotulo").count() === 0, String(await pgM.locator(".vtt-regua-rotulo").count()));

  // reconexão/reload: medida nunca é restaurada — sessão e calibração
  // persistem, o estado efêmero da régua não.
  const cC = await centroToken(pgM, 0); const cD = await centroToken(pgM, 1);
  await arrastar(pgM, cC, cD);
  await pgM.locator(".vtt-regua-rotulo").waitFor({ timeout: 8000 }).catch(() => {});
  await pgM.reload();
  await pgM.getByText("Servidor online").waitFor({ timeout: 15000 }).catch(() => {});
  await irMesa(pgM); await abrirSessao(pgM, "Mesa Régua UI");
  t("após reload não há medida restaurada", await pgM.locator(".vtt-regua-rotulo").count() === 0);
  t("após reload régua desativada", await pgM.locator(".vtt-tabuleiro-regua").count() === 0);
  t("calibração persiste após reload", await pgM.locator(".vtt-regua-controles .meta", { hasText: "Escala:" }).count() === 1);

  // reconexão de socket: medida e modo régua nunca são restaurados
  await ligarRegua(pgM);
  {
    const cR1 = await centroToken(pgM, 0); const cR2 = await centroToken(pgM, 1);
    await arrastar(pgM, cR1, cR2);
    await pgM.locator(".vtt-regua-rotulo").waitFor({ timeout: 8000 });
  }
  // reconexão de socket real: disconnect/connect do cliente —
  // o handler 'connect' zera medida e modo régua
  await pgM.evaluate(() => window.__mesaSocket?.disconnect());
  await pgM.waitForFunction(() => window.__mesaSocket?.connected === false, null, { timeout: 10000 }).catch(() => {});
  await pgM.evaluate(() => window.__mesaSocket?.connect());
  await pgM.waitForFunction(() => window.__mesaSocket?.connected === true, null, { timeout: 20000 }).catch(() => {});
  await pgM.waitForTimeout(800);
  t("reconexão zera medida e desativa régua",
    await pgM.locator(".vtt-regua-rotulo").count() === 0 && await pgM.locator(".vtt-tabuleiro-regua").count() === 0);

  // reentrada na sessão (sair e voltar) também não restaura estado
  await ligarRegua(pgM);
  {
    const cS1 = await centroToken(pgM, 0); const cS2 = await centroToken(pgM, 1);
    await arrastar(pgM, cS1, cS2);
    await pgM.locator(".vtt-regua-rotulo").waitFor({ timeout: 8000 });
  }
  await pgM.getByRole("button", { name: "Sair da mesa" }).click();
  await irMesa(pgM);
  await abrirSessao(pgM, "Mesa Régua UI");
  t("reentrada na sessão não restaura medida nem modo", 
    await pgM.locator(".vtt-regua-rotulo").count() === 0 && await pgM.locator(".vtt-tabuleiro-regua").count() === 0);

  // dois tokens visíveis ao jogador para o gesto token→token por
  // toque real (o Alfa foi removido na seção E; Beta e Secreto seguem)
  await novoToken("Gama", 0.2, 0.3);
  await novoToken("Delta", 0.8, 0.3);

  // ---------- F. Mobile (touch REAL via CDP Input.dispatchTouchEvent) ----------
  sec("F. Mobile 390x844 — toque real token→token");
  const ctxMob = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const pgMob = await ctxMob.newPage();
  vigiar(pgMob, "mobile");
  await login(pgMob, j1.username, "senha-jogador-123");
  await irMesa(pgMob);
  await abrirSessao(pgMob, "Mesa Régua UI");
  await pgMob.locator(".vtt-tabuleiro").waitFor({ timeout: 15000 });
  const aspMob = await aspectoTabuleiro(pgMob);
  t("mapa 4:3 no mobile mantém aspecto", Math.abs(aspMob - 4 / 3) < 0.03, aspMob.toFixed(3));
  await pgMob.getByRole("button", { name: "Régua", exact: true }).waitFor({ state: "visible", timeout: 15000 });
  await pgMob.waitForFunction(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent?.trim() === "Régua");
    return b && !b.disabled;
  }, { timeout: 15000 });
  await ligarRegua(pgMob);
  // Gesto touchscreen REAL via CDP: touchStart no centro do token de
  // origem, touchMove atravessando o tabuleiro e terminando sobre o
  // token de destino, touchEnd. Pointer Events unificados + Pointer
  // Capture implícito do toque reproduzem o cenário do audit — um
  // snap preso à origem exibiria ~0 m e FALHARIA este teste.
  const cdp = await ctxMob.newCDPSession(pgMob);
  const centroNome = (txt) => pgMob.locator(".vtt-token", { hasText: txt }).first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  const g1 = await centroNome("GA"); // Gama (0.2,0.3)
  const g2 = await centroNome("DE"); // Delta (0.8,0.3)
  t("tokens Gama/Delta visíveis ao jogador no mobile",
    await pgMob.locator(".vtt-token", { hasText: "GA" }).count() === 1
    && await pgMob.locator(".vtt-token", { hasText: "DE" }).count() === 1);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: g1.x, y: g1.y, id: 1 }] });
  const PASSOS = 10;
  for (let i = 1; i <= PASSOS; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: g1.x + ((g2.x - g1.x) * i) / PASSOS, y: g1.y + ((g2.y - g1.y) * i) / PASSOS, id: 1 }],
    });
    await pgMob.waitForTimeout(25);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await pgMob.locator(".vtt-regua-rotulo").waitFor({ timeout: 8000 });
  // dx=0.6 → 0.6*1200=720 un. mapa; 720/100*1.5 = 10,8 m
  const txtRotMob = await pgMob.locator(".vtt-regua-rotulo").textContent();
  t("toque real token→token snap no destino e exibe distância",
    /10[.,]8/.test(txtRotMob ?? "") && /720/.test(txtRotMob ?? ""), txtRotMob);
  t("dois pontos e linha SVG após gesto touch", 
    await pgMob.locator(".vtt-regua-ponto").count() === 2 && await pgMob.locator(".vtt-regua-svg line").count() === 1);
  // gesto encerrado: medida permanece estável (não depende de gesto ativo)
  await pgMob.waitForTimeout(300);
  t("medida persiste após touchEnd", /10[.,]8/.test(await pgMob.locator(".vtt-regua-rotulo").textContent() ?? ""));
  await pgMob.screenshot({ path: join(SHOTS, "regua-03-mobile.png") });
  t("mobile sem overflow horizontal", await pgMob.evaluate(() => document.scrollingElement.scrollWidth <= document.documentElement.clientWidth + 1));

  // ---------- G. Console limpo ----------
  sec("G. Higiene");
  const errosReais = errosConsole.filter((e) => !/401|Failed to load resource/.test(e));
  t("sem erros de console/pageerror", errosReais.length === 0, errosReais.slice(0, 3).join(" | "));

  console.log(`\n==== homologacao-regua: ${pass} ok, ${fail} falhas ====`);
} catch (e) {
  console.error("FALHA GERAL:", e);
  fail++;
} finally {
  try { sockM?.close(); } catch {}
  try { await browser?.close(); } catch {}
  try { await encerrarServidor(proc); } catch {}
  try { limparDir(DIR); } catch (e2) { console.log("[limpeza]", e2.message); }
}
process.exit(fail ? 1 : 0);
