#!/usr/bin/env node
// Teste E2E de iconografia das abas de campanha (Issue #233 / #132).
// Cobre: ícones SVG presentes em todas as abas por papel, rótulos
// preservados, abas de mestre ocultas para jogador/espectador,
// troca de aba funcional, foco de teclado e mobile 390px.
// Servidor+SQLite+site descartáveis.
import { chromium } from "playwright";
import Database from "better-sqlite3";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

const DIR = dirTeste("icones-abas");
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

const ABAS_TODAS = [
  ["Informações", "informacoes"],
  ["Mesa", "mesa"],
  ["Personagens", "personagens"],
  ["Diário", "diario"],
  ["Histórico", "historico"],
  ["Arquivos", "arquivos"],
  ["Fichas", "fichas"],
  ["Regras", "regras"],
  ["Participantes", "participantes"],
  ["Convites", "convites"],
];
const ABAS_MESTRE = ["Fichas", "Regras", "Participantes", "Convites"];

// Abre a campanha no app: nav Campanhas → cartão da campanha.
async function abrirCampanha(page, nome = "Campanha Teste") {
  await page.getByRole("button", { name: "Campanhas" }).first().click();
  await page.locator(".cartao-campanha", { hasText: nome }).first().click();
  await page.locator(".abas").waitFor({ timeout: 15000 });
}

// Para cada aba esperada: botão existe, tem svg.icone-interface e o
// rótulo textual permanece (ícone nunca substitui o nome acessível).
async function checarAbas(page, esperadas, papel) {
  const botoes = page.locator(".abas button");
  const total = await botoes.count();
  ok(`${papel}. total de abas visíveis = ${esperadas.length}`, total === esperadas.length, `visíveis=${total}`);
  for (const [rotulo] of esperadas) {
    const btn = botoes.filter({ hasText: rotulo }).first();
    const existe = (await btn.count()) === 1;
    if (!existe) { ok(`${papel}. aba "${rotulo}" presente`, false); continue; }
    const temIcone = await btn.locator("svg.icone-interface").count();
    const texto = (await btn.innerText()).replace(/\s+/g, " ").trim();
    ok(`${papel}. aba "${rotulo}": ícone svg + rótulo`, temIcone === 1 && texto.startsWith(rotulo.slice(0, 4)),
      `icone=${temIcone} texto="${texto.slice(0, 30)}"`);
  }
}

try {
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO, { campanha: "Campanha Teste" });

  // Espectador: promove jogador2 a role=espectador no banco de teste.
  const db = new Database(BANCO);
  db.prepare("update memberships set role='espectador' where user_id=?").run(c.jogadores.jogador2.id);
  db.close();

  const browser = await chromium.launch();

  // ---------- 1. MESTRE: 10 abas, todas com ícone + rótulo ----------
  {
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "mestre_rpg_session", value: c.cookieMestre.split("=").pop(), url: BASE }]);
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "networkidle" });
    await abrirCampanha(page);
    await checarAbas(page, ABAS_TODAS, "mestre");

    // Troca de aba funcional: Diário vira ativo e mostra conteúdo da aba.
    await page.locator(".abas button", { hasText: "Diário" }).click();
    await page.waitForTimeout(400);
    const ativo = await page.locator(".abas button.ativo").first().innerText();
    ok("mestre. troca para Diário marca botão ativo", ativo.includes("Diário"), ativo.trim());

    // Foco de teclado: Tab real dispara :focus-visible (outline 2px solid).
    await page.locator(".abas button").first().focus();
    await page.keyboard.press("Tab");
    const foco = await page.evaluate(() => {
      const el = document.activeElement;
      const cs = getComputedStyle(el);
      return { tag: el.tagName, cls: el.className, outline: `${cs.outlineStyle} ${cs.outlineWidth}` };
    });
    ok("mestre. aba focável por teclado com outline visível", foco.tag === "BUTTON" && /abas|secundario|ativo/.test(foco.cls) && /solid 2px/.test(foco.outline), JSON.stringify(foco));

    // Issue #132 P3 — semântica ARIA: tablist/tab/tabpanel ligados.
    const sem = await page.evaluate(() => {
      const tl = document.querySelector(".abas[role=tablist]");
      const tabs = [...document.querySelectorAll(".abas [role=tab]")];
      const ativoTab = tabs.find((t) => t.getAttribute("aria-selected") === "true");
      const painel = document.querySelector("[role=tabpanel]");
      return {
        tablist: !!tl && tl.getAttribute("aria-label") === "Seções da campanha",
        rolesOk: tabs.length === 10 && tabs.every((t) =>
          t.id && t.getAttribute("aria-controls") &&
          (t.tabIndex === 0) === (t === ativoTab)),
        painelLigado: !!(painel && ativoTab &&
          painel.id === ativoTab.getAttribute("aria-controls") &&
          painel.getAttribute("aria-labelledby") === ativoTab.id),
      };
    });
    ok("mestre. tablist com aria-label; tabs com aria-selected/controls e roving tabindex", sem.tablist && sem.rolesOk, JSON.stringify(sem));
    ok("mestre. painel ativo é tabpanel ligado à aba selecionada", sem.painelLigado);

    // Teclado APG: setas movem foco+seleção; Home/End vão às pontas.
    await page.locator(".abas button", { hasText: "Informações" }).click();
    await page.waitForTimeout(200);
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(200);
    const aposSeta = await page.evaluate(() => ({
      foco: document.activeElement.id,
      sel: document.querySelector(".abas [aria-selected=true]")?.id,
    }));
    ok("mestre. ArrowRight move foco e seleção para Mesa", aposSeta.foco === "aba-mesa" && aposSeta.sel === "aba-mesa", JSON.stringify(aposSeta));
    await page.keyboard.press("End");
    await page.waitForTimeout(200);
    const aposEnd = await page.evaluate(() => ({
      foco: document.activeElement.id,
      painel: document.querySelector("[role=tabpanel]")?.id,
    }));
    ok("mestre. End vai à última aba (Convites) com painel correspondente", aposEnd.foco === "aba-convites" && aposEnd.painel === "painel-convites", JSON.stringify(aposEnd));
    await page.keyboard.press("Home");
    await page.waitForTimeout(200);
    ok("mestre. Home volta à primeira aba (Informações)", (await page.evaluate(() => document.activeElement.id)) === "aba-info");

    // Mobile 390px: abas não estouram a viewport (flex-wrap permite rolagem interna).
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok("mestre. mobile 390px sem overflow horizontal da página", overflow <= 1, `overflow=${overflow}px`);
    await ctx.close();
  }

  // ---------- 2. JOGADOR: abas de mestre ausentes, ícones nas demais ----------
  {
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "mestre_rpg_session", value: c.jogadores.jogador1.cookie.split("=").pop(), url: BASE }]);
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "networkidle" });
    await abrirCampanha(page);
    const esperadas = ABAS_TODAS.filter(([r]) => !ABAS_MESTRE.includes(r));
    await checarAbas(page, esperadas, "jogador");
    for (const rotulo of ABAS_MESTRE) {
      const n = await page.locator(".abas button", { hasText: rotulo }).count();
      ok(`jogador. aba mestre "${rotulo}" ausente`, n === 0, `encontradas=${n}`);
    }
    await ctx.close();
  }

  // ---------- 2b. ESPECTADOR: Personagens também some (403 no backend) ----------
  {
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "mestre_rpg_session", value: c.jogadores.jogador2.cookie.split("=").pop(), url: BASE }]);
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "networkidle" });
    await abrirCampanha(page);
    const rotulos = await page.locator(".abas button").allInnerTexts();
    const nomes = rotulos.map((t) => t.replace(/\s+/g, " ").trim());
    ok("espectador. só abas públicas visíveis", nomes.length === 5 &&
      ["Informações", "Mesa", "Diário", "Histórico", "Arquivos"].every((r) => nomes.some((n) => n.startsWith(r))),
      nomes.join(" | "));
    for (const r of [...ABAS_MESTRE, "Personagens"]) {
      ok(`espectador. aba "${r}" ausente`, !nomes.some((n) => n.startsWith(r)));
    }
    const icones = await page.locator(".abas button svg.icone-interface").count();
    ok("espectador. ícones presentes nas abas visíveis", icones === nomes.length, `icones=${icones}`);
    await ctx.close();
  }

  // ---------- 3. Todos os 10 desenhos são SVGs distintos e válidos ----------
  {
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "mestre_rpg_session", value: c.cookieMestre.split("=").pop(), url: BASE }]);
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "networkidle" });
    await abrirCampanha(page);
    const desenhos = await page.evaluate(() =>
      [...document.querySelectorAll(".abas button svg.icone-interface")].map((s) => s.innerHTML.replace(/\s+/g, "")));
    const unicos = new Set(desenhos);
    ok("mestre. cada aba tem desenho SVG distinto", desenhos.length === 10 && unicos.size === 10,
      `icones=${desenhos.length} unicos=${unicos.size}`);
    const ariaHidden = await page.evaluate(() =>
      [...document.querySelectorAll(".abas button svg.icone-interface")].every((s) => s.getAttribute("aria-hidden") === "true"));
    ok("mestre. ícones aria-hidden (não poluem accessible name)", ariaHidden);
    await ctx.close();
  }

  await browser.close();
} finally {
  encerrarServidor(proc);
  limparDir(DIR);
}

const falhas = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - falhas.length}/${resultados.length} verificações OK`);
if (falhas.length) { console.log("FALHAS:", falhas.map((f) => f.nome).join(" | ")); process.exit(1); }
