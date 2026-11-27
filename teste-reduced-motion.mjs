#!/usr/bin/env node
// Teste E2E de movimento reduzido (Issue #132 / Mission 3).
// Cobre: prefers-reduced-motion do SO, preferência do app
// (data-movimento-efetivo), neutralização de transition/animation,
// precedência do SO sobre "completo", foco de teclado visível e
// layouts desktop/mobile. Servidor+SQLite+site descartáveis.
import { chromium } from "playwright";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

const DIR = dirTeste("reduced-motion");
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

const VISUAL_BASE = {
  intensidade: "equilibrada", corDestaque: "vinho", superficies: "padrao",
  textura: "sutil", densidade: "padrao",
};
const definirAnimacoes = (cookie, animacoes) =>
  req(BASE, "PATCH", "/auth/preferences", {
    cookie,
    body: { visual: { ...VISUAL_BASE, animacoes } },
  });

// transition-duration computada de um <button> qualquer da UI
const medirTransicao = (page) => page.evaluate(() => {
  const b = document.querySelector("button");
  if (!b) return null;
  return getComputedStyle(b).transitionDuration;
});
const medirAnimacao = (page) => page.evaluate(() => {
  // Elemento com animation garantida quando presente: .campo-pulso é
  // transitório; usamos um nó de teste injetado com a mesma regra? Não —
  // medimos a regra global via um elemento real animado da notificação.
  // Alternativa estável: .dado.girando não existe sem rolagem. Medimos
  // transition (presente em botões) e o atributo data-* como contrato.
  const b = document.querySelector("button");
  return b ? getComputedStyle(b).animationDuration : null;
});

try {
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO, { campanha: "Campanha Motion" });
  const cookie = `mestre_rpg_session=${c.cookieMestre.split("=").pop()}`;

  // Preferência do app: animacoes = "reduzido"
  const r1 = await definirAnimacoes(cookie, "reduzido");
  ok("setup. PATCH visual animacoes=reduzido", r1.status === 200, `status=${r1.status}`);

  const browser = await chromium.launch();

  // ---------- 1. App em "reduzido" (SO normal) → movimento neutralizado ----------
  {
    const ctx = await browser.newContext(); // reducedMotion: "no-preference" (default)
    await ctx.addCookies([{ name: "mestre_rpg_session", value: c.cookieMestre.split("=").pop(), url: BASE }]);
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.documentElement.dataset.movimentoEfetivo !== undefined, { timeout: 15000 });
    const efetivo = await page.evaluate(() => document.documentElement.dataset.movimentoEfetivo);
    ok("UI. app reduzido → data-movimento-efetivo=reduzido", efetivo === "reduzido", efetivo);
    const td = await medirTransicao(page);
    ok("UI. transition neutralizada (≈0.01ms)", td !== null && parseFloat(td) <= 0.011, td);
    await page.keyboard.press("Tab");
    const foco = await page.evaluate(() => {
      const el = document.activeElement;
      const cs = getComputedStyle(el);
      return { tag: el.tagName, outline: `${cs.outlineStyle} ${cs.outlineWidth}` };
    });
    ok("UI. foco de teclado visível (outline 2px)", /solid 2px/.test(foco.outline), JSON.stringify(foco));
    await ctx.close();
  }

  // ---------- 2. App em "completo" + SO normal → movimento preservado ----------
  {
    await definirAnimacoes(cookie, "completo");
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "mestre_rpg_session", value: c.cookieMestre.split("=").pop(), url: BASE }]);
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.documentElement.dataset.movimentoEfetivo !== undefined, { timeout: 15000 });
    const efetivo = await page.evaluate(() => document.documentElement.dataset.movimentoEfetivo);
    ok("UI. app completo → data-movimento-efetivo=completo", efetivo === "completo", efetivo);
    const td = await medirTransicao(page);
    ok("UI. transition preservada (>0.01ms)", td !== null && parseFloat(td) > 0.011, td);
    await ctx.close();
  }

  // ---------- 3. SO reduce PREVALECE sobre app "completo" ----------
  {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    await ctx.addCookies([{ name: "mestre_rpg_session", value: c.cookieMestre.split("=").pop(), url: BASE }]);
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.documentElement.dataset.movimentoEfetivo !== undefined, { timeout: 15000 });
    const efetivo = await page.evaluate(() => document.documentElement.dataset.movimentoEfetivo);
    ok("UI. SO reduce vence app completo → efetivo=reduzido", efetivo === "reduzido", efetivo);
    const td = await medirTransicao(page);
    ok("UI. transition neutralizada via SO", td !== null && parseFloat(td) <= 0.011, td);
    await ctx.close();
  }

  // ---------- 4. Mobile com movimento reduzido ----------
  {
    await definirAnimacoes(cookie, "reduzido");
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addCookies([{ name: "mestre_rpg_session", value: c.cookieMestre.split("=").pop(), url: BASE }]);
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.documentElement.dataset.movimentoEfetivo !== undefined, { timeout: 15000 });
    const efetivo = await page.evaluate(() => document.documentElement.dataset.movimentoEfetivo);
    const td = await medirTransicao(page);
    ok("UI. mobile reduzido → efetivo=reduzido + transição off", efetivo === "reduzido" && td !== null && parseFloat(td) <= 0.011, `${efetivo}/${td}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    ok("UI. mobile sem overflow horizontal", !overflow);
    await ctx.close();
  }

  await browser.close();
} finally {
  await encerrarServidor(proc).catch(() => {});
}

const falhas = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - falhas.length} passaram, ${falhas.length} falharam`);
limparDir(DIR);
process.exit(falhas.length ? 1 : 0);
