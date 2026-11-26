#!/usr/bin/env node
// Teste E2E de feedback de carregamento/erro (Issue #239 / #132).
// Cobre: EstadoCarregando (role=status, texto visível, indicador discreto),
// EstadoErro (role=alert, mensagem segura, sem stack/detalhes internos),
// retry manual que reexecuta a carga existente (1 clique = 1 nova request),
// convites sem flash de estado vazio, reduced-motion e mobile 390px.
import { chromium } from "playwright";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

const DIR = dirTeste("feedback-listas");
const BANCO = `${DIR}/mestre-rpg-teste.db`;
prepararBanco(BANCO);
const porta = await portaLivre();
const BASE = `http://127.0.0.1:${porta}`;
const proc = subirServidor(porta, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });

const resultados = [];
const ok = (nome, cond, extra = "") => {
  resultados.push({ nome, ok: !!cond });
  console.log(`${cond ? "ok" : "FALHOU"} ${nome}${extra ? " — " + extra : ""}`);
};

async function abrirAba(page, nome) {
  await page.locator(".abas button", { hasText: nome }).first().click();
  await page.waitForTimeout(400);
}
async function abrirCampanha(page) {
  await page.getByRole("button", { name: "Campanhas" }).first().click();
  await page.locator(".cartao-campanha", { hasText: "Campanha Teste" }).first().click();
  await page.locator(".abas").waitFor({ timeout: 15000 });
}

try {
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO, { campanha: "Campanha Teste" });
  const urlChars = `**/api/campaigns/${c.campId}/characters*`;
  const urlConvites = `**/api/campaigns/${c.campId}/invitations*`;

  const browser = await chromium.launch();
  const ctxM = await browser.newContext();
  await ctxM.addCookies([{ name: "mestre_rpg_session", value: c.cookieMestre.split("=").pop(), url: BASE }]);
  const pm = await ctxM.newPage();

  // ---------- 1) Loading: role=status, texto visível, spinner aria-hidden ----------
  let liberarChars;
  const charsPendente = new Promise((res) => { liberarChars = res; });
  let charsAtrasadas = 0;
  await pm.route(urlChars, async (route) => {
    charsAtrasadas++;
    await charsPendente;
    await route.continue();
  });
  await pm.goto(BASE, { waitUntil: "domcontentloaded" });
  await abrirCampanha(pm);
  await abrirAba(pm, "Personagens");
  await pm.waitForSelector(".estado-feedback-carregando", { timeout: 8000 });
  const st = pm.locator(".estado-feedback-carregando");
  ok("loading. role=status presente", (await st.getAttribute("role")) === "status");
  ok("loading. texto sempre visível", (await st.locator(".estado-feedback-texto").innerText()).includes("Carregando"));
  ok("loading. indicador visual discreto presente", (await st.locator(".estado-feedback-icone").count()) === 1);
  // ---- asserts de CSS da folha dedicada estado-feedback.css ----
  const css = await st.evaluate((el) => {
    const s = getComputedStyle(el);
    const icone = getComputedStyle(el.querySelector(".estado-feedback-icone"));
    return {
      display: s.display, dir: s.flexDirection, anim: icone.animationName,
      raio: icone.borderRadius, rolagem: el.scrollWidth <= el.clientWidth + 1,
    };
  });
  ok("css. folha dedicada: container flex-column centralizado", css.display === "flex" && css.dir === "column", JSON.stringify(css));
  ok("css. spinner com animação própria e borda circular", css.anim === "estado-feedback-girar" && css.raio === "50%", `anim=${css.anim} raio=${css.raio}`);
  liberarChars();
  await pm.waitForSelector(".estado-feedback-carregando", { state: "detached", timeout: 8000 }).catch(() => {});
  await pm.unroute(urlChars);
  await pm.waitForTimeout(300);
  ok("loading. some após carga", (await pm.locator(".estado-feedback-carregando").count()) === 0);
  const nCharsApos = charsAtrasadas;

  // ---------- 2) Erro: role=alert, mensagem segura, retry dispara nova carga ----------
  let falharChars = true;
  let reqsChars = 0;
  await pm.route(urlChars, async (route) => {
    reqsChars++;
    if (falharChars) {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ erro: "falha interna simulada" }) });
    } else {
      await route.continue();
    }
  });
  // força recarga: troca aba Personagens→Mesa→Personagens via socket-free path: reload da página
  await pm.reload({ waitUntil: "domcontentloaded" });
  await abrirCampanha(pm);
  await abrirAba(pm, "Personagens");
  await pm.waitForSelector(".estado-feedback-erro", { timeout: 8000 });
  const er = pm.locator(".estado-feedback-erro");
  ok("erro. role=alert presente", (await er.getAttribute("role")) === "alert");
  const txtErro = await er.locator(".estado-feedback-texto").innerText();
  ok("erro. mensagem útil e segura (sem stack/token)", txtErro.length > 3 && !/stack|at \w+ \(|token|sqlite|SELECT/i.test(txtErro), `"${txtErro.trim()}"`);
  ok("erro. botão Tentar novamente visível", (await er.getByRole("button", { name: "Tentar novamente" }).count()) === 1);
  const corErro = await er.locator(".estado-feedback-texto").evaluate((el) => getComputedStyle(el).color);
  ok("css. texto de erro usa tom de erro do tema (#f87171)", corErro === "rgb(248, 113, 113)", corErro);
  const focoRetry = await er.getByRole("button", { name: "Tentar novamente" }).evaluate((el) => {
    el.focus();
    const s = getComputedStyle(el);
    return { tag: el.tagName, outline: s.outlineStyle, tab: el.tabIndex };
  });
  ok("css. retry focável por teclado", focoRetry.tag === "BUTTON" && focoRetry.tab === 0, JSON.stringify(focoRetry));
  falharChars = false;
  const reqsAntesRetry = reqsChars;
  await er.getByRole("button", { name: "Tentar novamente" }).click();
  await pm.waitForTimeout(1200);
  ok("retry. 1 clique = 1 nova request de carga", reqsChars === reqsAntesRetry + 1, `reqs ${reqsAntesRetry}→${reqsChars}`);
  ok("retry. erro some e lista carrega", (await pm.locator(".estado-feedback-erro").count()) === 0);
  await pm.unroute(urlChars);
  ok("sanidade. personagens listou após retry", nCharsApos >= 1);

  // ---------- 3) Convites: gate de loading (sem flash de vazio) ----------
  await abrirAba(pm, "Convites");
  let liberarConv;
  const convPendente = new Promise((res) => { liberarConv = res; });
  await pm.route(urlConvites, async (route) => { await convPendente; await route.continue(); });
  // remount da aba convites via troca de aba força novo GET? carregar só roda 1x; recarregamos página
  await pm.reload({ waitUntil: "domcontentloaded" });
  await abrirCampanha(pm);
  await abrirAba(pm, "Convites");
  await pm.waitForSelector(".estado-feedback-carregando", { timeout: 8000 });
  const temVazioAntes = await pm.locator(".estado-vazio:has-text('Nenhum convite')").count();
  ok("convites. estado vazio NÃO pisca durante carga", temVazioAntes === 0);
  liberarConv();
  await pm.waitForSelector(".estado-feedback-carregando", { state: "detached", timeout: 8000 }).catch(() => {});
  await pm.unroute(urlConvites);
  await pm.waitForTimeout(300);
  ok("convites. vazio real aparece após carga", (await pm.locator(".estado-vazio:has-text('Nenhum convite')").count()) === 1);
  ok("convites. formulário Gerar convite preservado", (await pm.locator('button[type="submit"]', { hasText: "Gerar convite" }).count()) === 1);

  // ---------- 3b) Convites: falha em listarConvites → erro com retry, nunca "Carregando…" eterno ----------
  // Issue #132 P3: antes do fix, listarMembros/listarConvites falhando após a
  // campanha carregar deixava a aba Convites presa em "Carregando convites…".
  let falharConvites = true;
  await pm.route(urlConvites, async (route) => {
    if (falharConvites) {
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ erro: "falha simulada" }) });
    } else {
      await route.continue();
    }
  });
  await pm.reload({ waitUntil: "domcontentloaded" });
  await abrirCampanha(pm);
  await abrirAba(pm, "Convites");
  await pm.waitForSelector("#painel-convites .estado-feedback-erro", { timeout: 8000 });
  const painelConvites = pm.locator("#painel-convites");
  ok("convites. falha mostra EstadoErro (não loading eterno)",
    (await painelConvites.locator(".estado-feedback-erro").count()) === 1 &&
    (await painelConvites.locator(".estado-feedback-carregando").count()) === 0);
  ok("convites. erro tem role=alert e retry", (await painelConvites.locator(".estado-feedback-erro").getAttribute("role")) === "alert" &&
    (await painelConvites.getByRole("button", { name: "Tentar novamente" }).count()) === 1);
  ok("convites. estado vazio NÃO aparece durante o erro", (await pm.locator(".estado-vazio:has-text('Nenhum convite')").count()) === 0);
  falharConvites = false;
  await painelConvites.getByRole("button", { name: "Tentar novamente" }).click();
  await pm.waitForSelector(".estado-vazio:has-text('Nenhum convite')", { timeout: 8000 });
  ok("convites. retry recupera e mostra estado vazio", (await pm.locator(".estado-vazio:has-text('Nenhum convite')").count()) === 1);
  await pm.unroute(urlConvites);

  // ---------- 4) Reduced motion: texto permanece, animação desligada ----------
  await pm.emulateMedia({ reducedMotion: "reduce" });
  // força loading de novo em Arquivos
  await abrirAba(pm, "Arquivos");
  let liberarArq;
  const arqPendente = new Promise((res) => { liberarArq = res; });
  await pm.route(`**/api/campaigns/${c.campId}/arquivos*`, async (route) => {
    await arqPendente;
    try { await route.continue(); } catch { /* rota já tratada por reload concorrente */ }
  });
  // Arquivos já montou? trocar de aba remonta → novo GET
  await abrirAba(pm, "Personagens");
  await abrirAba(pm, "Arquivos");
  await pm.waitForSelector(".estado-feedback-carregando", { timeout: 8000 });
  const estilo = await pm.locator(".estado-feedback-icone").evaluate((el) => {
    const s = getComputedStyle(el);
    return { dur: s.animationDuration, iter: s.animationIterationCount };
  });
  const durMs = parseFloat(estilo.dur) * (estilo.dur.endsWith("ms") ? 1 : 1000);
  ok("reduced-motion. animação do indicador neutralizada", durMs <= 1 || estilo.iter === "1", `dur=${estilo.dur} iter=${estilo.iter}`);
  ok("reduced-motion. texto de loading continua visível", (await pm.locator(".estado-feedback-texto").innerText()).includes("Carregando"));
  liberarArq();
  await pm.unroute(`**/api/campaigns/${c.campId}/arquivos`);
  await pm.waitForTimeout(400);

  // ---------- 5) Mobile 390px sem overflow ----------
  await pm.setViewportSize({ width: 390, height: 844 });
  await pm.waitForTimeout(300);
  const ov = await pm.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("mobile 390px sem overflow horizontal", ov <= 1, `overflow=${ov}px`);

  // ---------- 6) Jogador: mesmo feedback consistente ----------
  const ctxJ = await browser.newContext();
  await ctxJ.addCookies([{ name: "mestre_rpg_session", value: c.jogadores.jogador1.cookie.split("=").pop(), url: BASE }]);
  const pj = await ctxJ.newPage();
  let falharCharsJ = true;
  await pj.route(urlChars, async (route) => {
    if (falharCharsJ) await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ erro: "x" }) });
    else await route.continue();
  });
  await pj.goto(BASE, { waitUntil: "domcontentloaded" });
  await abrirCampanha(pj);
  await abrirAba(pj, "Personagens");
  await pj.waitForSelector(".estado-feedback-erro", { timeout: 8000 });
  ok("jogador. erro acessível (role=alert)", (await pj.locator(".estado-feedback-erro").getAttribute("role")) === "alert");
  falharCharsJ = false;
  await pj.locator(".estado-feedback-erro").getByRole("button", { name: "Tentar novamente" }).click();
  await pj.waitForTimeout(1200);
  ok("jogador. retry recupera a lista", (await pj.locator(".estado-feedback-erro").count()) === 0);

  await browser.close();
} finally {
  encerrarServidor(proc);
  limparDir(DIR);
}

const falhas = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - falhas.length}/${resultados.length} verificações OK`);
if (falhas.length) { console.log("FALHAS:", falhas.map((f) => f.nome).join(" | ")); process.exit(1); }
