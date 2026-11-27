#!/usr/bin/env node
// Teste E2E das microinterações temáticas (Issue #132 — incremento).
// Cobre: entrada de painéis de aba (remontagem por troca), entrada de
// modais, entrada de rolagens, pulso de turno atual e flash de
// HP/vitalidade nos tokens — tudo CSS-only, neutralizado por
// data-movimento-efetivo="reduzido" (app) e prefers-reduced-motion (SO).
// Contrato dos ganchos de remontagem (key por valor) verificado no fonte.
// Servidor+SQLite+site descartáveis.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

const DIR = dirTeste("microinteracoes-132");
const BANCO = `${DIR}/mestre-rpg-teste.db`;
prepararBanco(BANCO);
const porta = await portaLivre();
const BASE = `http://127.0.0.1:${porta}`;
const proc = subirServidor(porta, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });

const RAIZ = join(dirname(fileURLToPath(import.meta.url)));
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

const animNome = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  return el ? getComputedStyle(el).animationName : null;
}, sel);
const animDuracao = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  return el ? getComputedStyle(el).animationDuration : null;
}, sel);

// Injeta um elemento com a classe real e mede a animação computada —
// prova o contrato CSS sem depender de estado completo da mesa.
const animacaoDeClasse = (page, classe, extraHtml = "") => page.evaluate(([c, h]) => {
  const el = document.createElement("div");
  el.className = c;
  if (h) el.setAttribute("style", h);
  document.body.appendChild(el);
  const nome = getComputedStyle(el).animationName;
  el.remove();
  return nome;
}, [classe, extraHtml]);

async function abrirCampanha(page, nome = "Campanha Teste") {
  await page.getByRole("button", { name: "Campanhas" }).first().click();
  await page.locator(".cartao-campanha", { hasText: nome }).first().click();
  await page.locator(".abas").waitFor({ timeout: 15000 });
}

try {
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO, { campanha: "Campanha Teste" });
  const cookie = `mestre_rpg_session=${c.cookieMestre.split("=").pop()}`;

  const browser = await chromium.launch();

  // ---------- 1. Painel de aba: animação presente e remontagem por troca ----------
  {
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "mestre_rpg_session", value: c.cookieMestre.split("=").pop(), url: BASE }]);
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "networkidle" });
    await abrirCampanha(page);
    await page.locator("[role='tabpanel']").first().waitFor({ timeout: 15000 });

    ok("painel. tabpanel usa micro-entra-cima",
      (await animNome(page, "[role='tabpanel']")) === "micro-entra-cima",
      await animNome(page, "[role='tabpanel']"));

    // Marcador de identidade do nó: troca de aba deve produzir OUTRO
    // elemento (remount) — é o que faz a animação de entrada repetir.
    await page.evaluate(() => { window.__painel1 = document.querySelector("[role='tabpanel']"); });
    await page.getByRole("tab", { name: "Diário" }).click();
    await page.locator("#painel-diario").waitFor({ timeout: 15000 });
    const remontou = await page.evaluate(() =>
      window.__painel1 !== document.querySelector("[role='tabpanel']"));
    ok("painel. troca de aba remonta o tabpanel (animação repete)", remontou === true);
    ok("painel. tabpanel do Diário segue animado",
      (await animNome(page, "#painel-diario")) === "micro-entra-cima");
    await ctx.close();
  }

  // ---------- 2. Contrato CSS das demais microinterações ----------
  {
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "mestre_rpg_session", value: c.cookieMestre.split("=").pop(), url: BASE }]);
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "networkidle" });
    await abrirCampanha(page);

    ok("modal. .modal-fundo usa micro-fade",
      (await animacaoDeClasse(page, "modal-fundo")) === "micro-fade");
    ok("modal. .modal usa micro-entra-modal",
      (await animacaoDeClasse(page, "modal")) === "micro-entra-modal");
    ok("rolagem. .rolagem-item usa micro-item-entra",
      (await animacaoDeClasse(page, "rolagem-item")) === "micro-item-entra");
    ok("turno. .tag-atual usa micro-tag-turno",
      (await animacaoDeClasse(page, "tag tag-atual")) === "micro-tag-turno");
    ok("vida. .vtt-token-hp usa micro-vida-muda",
      (await animacaoDeClasse(page, "vtt-token-hp")) === "micro-vida-muda");
    ok("vida. .vtt-token-vit usa micro-vida-muda",
      (await animacaoDeClasse(page, "vtt-token-vit")) === "micro-vida-muda");
    await ctx.close();
  }

  // ---------- 3. App em animacoes="reduzido" → neutralizado ----------
  {
    const r = await definirAnimacoes(cookie, "reduzido");
    ok("setup. PATCH visual animacoes=reduzido", r.status === 200, `status=${r.status}`);
    const ctx = await browser.newContext(); // SO sem preferência
    await ctx.addCookies([{ name: "mestre_rpg_session", value: c.cookieMestre.split("=").pop(), url: BASE }]);
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.documentElement.dataset.movimentoEfetivo !== undefined, { timeout: 15000 });
    const efetivo = await page.evaluate(() => document.documentElement.dataset.movimentoEfetivo);
    ok("reduzido. data-movimento-efetivo=reduzido", efetivo === "reduzido", efetivo);
    await abrirCampanha(page);
    await page.locator("[role='tabpanel']").first().waitFor({ timeout: 15000 });
    const dur = await animDuracao(page, "[role='tabpanel']");
    const ms = parseFloat(dur);
    ok("reduzido. duração de animação do painel ~0", ms <= 0.02 || dur === "0s",
      `animationDuration=${dur}`);
    await ctx.close();
  }

  // ---------- 4. SO prefers-reduced-motion prevalece sobre app "completo" ----------
  {
    const r = await definirAnimacoes(cookie, "completo");
    ok("setup. PATCH visual animacoes=completo", r.status === 200, `status=${r.status}`);
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    await ctx.addCookies([{ name: "mestre_rpg_session", value: c.cookieMestre.split("=").pop(), url: BASE }]);
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "networkidle" });
    await abrirCampanha(page);
    await page.locator("[role='tabpanel']").first().waitFor({ timeout: 15000 });
    const dur = await animDuracao(page, "[role='tabpanel']");
    const ms = parseFloat(dur);
    ok("SO-reduce. duração ~0 mesmo com app completo", ms <= 0.02 || dur === "0s",
      `animationDuration=${dur}`);
    await ctx.close();
  }

  // ---------- 5. Mobile 390px: painéis e animações não quebram layout ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addCookies([{ name: "mestre_rpg_session", value: c.cookieMestre.split("=").pop(), url: BASE }]);
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "networkidle" });
    await abrirCampanha(page);
    await page.locator("[role='tabpanel']").first().waitFor({ timeout: 15000 });
    const visivel = await page.locator("[role='tabpanel']").first().isVisible();
    ok("mobile. tabpanel visível em 390px", visivel === true);
    await ctx.close();
  }

  // ---------- 6. Contrato estático dos ganchos de remontagem ----------
  {
    const mesa = readFileSync(join(RAIZ, "site/src/paginas/Mesa.tsx"), "utf8");
    ok("fonte. tag de turno usa key '#atual'", mesa.includes("}#atual`"));
    ok("fonte. HP do token usa key por valor", /key=\{`hp-\$\{tk\.vida\.hp\.atual\}-\$\{tk\.vida\.hp\.maximo\}`\}/.test(mesa));
    ok("fonte. vitalidade usa key por nível", /key=\{`vit-\$\{tk\.vida\.vitalidade\.nivel\}`\}/.test(mesa));
    const css = readFileSync(join(RAIZ, "site/src/identidade-visual.css"), "utf8");
    for (const kf of ["micro-entra-cima", "micro-entra-modal", "micro-fade", "micro-item-entra", "micro-tag-turno", "micro-vida-muda"]) {
      ok(`css. keyframe ${kf} definido`, css.includes(`@keyframes ${kf}`));
    }
  }

  await browser.close();
} catch (e) {
  console.error("FALHA FATAL:", e);
  resultados.push({ nome: "execução", ok: false });
} finally {
  encerrarServidor(proc);
  limparDir(DIR);
  const falhas = resultados.filter((r) => !r.ok);
  console.log(`\n${resultados.length - falhas.length}/${resultados.length} verificações ok`);
  process.exit(falhas.length ? 1 : 0);
}
