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

    // F9 — semântica acessível das abas (P3 do relatório integrado):
    // tablist + role=tab + aria-selected, exatamente uma selecionada.
    const semMestre = await page.evaluate(() => {
      const lista = document.querySelector(".abas[role=tablist]");
      const tabs = [...document.querySelectorAll(".abas[role=tablist] button")];
      return {
        tablist: lista?.getAttribute("role") === "tablist",
        todasTabs: tabs.every((b) => b.getAttribute("role") === "tab" && b.getAttribute("type") === "button"),
        selecionadas: tabs.filter((b) => b.getAttribute("aria-selected") === "true").map((b) => b.textContent.trim()),
      };
    });
    ok("mestre. container .abas expõe role=tablist", semMestre.tablist);
    ok("mestre. todas as abas têm role=tab + type=button", semMestre.todasTabs);
    ok("mestre. exatamente uma aba aria-selected=true", semMestre.selecionadas.length === 1 && semMestre.selecionadas[0].startsWith("Diário"), semMestre.selecionadas.join("|"));

    // Troca por teclado (Enter na aba focada) atualiza aria-selected.
    await page.locator(".abas button", { hasText: "Histórico" }).focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    const selTeclado = await page.evaluate(() =>
      [...document.querySelectorAll(".abas[role=tablist] button")].filter((b) => b.getAttribute("aria-selected") === "true").map((b) => b.textContent.trim()));
    ok("mestre. troca por teclado move aria-selected", selTeclado.length === 1 && selTeclado[0].startsWith("Histórico"), selTeclado.join("|"));

    // Foco de teclado: Tab real dispara :focus-visible (outline 2px solid).
    await page.locator(".abas button").first().focus();
    await page.keyboard.press("Tab");
    const foco = await page.evaluate(() => {
      const el = document.activeElement;
      const cs = getComputedStyle(el);
      return { tag: el.tagName, cls: el.className, outline: `${cs.outlineStyle} ${cs.outlineWidth}` };
    });
    ok("mestre. aba focável por teclado com outline visível", foco.tag === "BUTTON" && /abas|secundario|ativo/.test(foco.cls) && /solid 2px/.test(foco.outline), JSON.stringify(foco));

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
    // F9 — semântica acessível também vale para jogador (abas de mestre
    // ausentes não podem deixar tab órfã/selecionada).
    const semJogador = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll(".abas[role=tablist] button")];
      return {
        tablist: document.querySelector(".abas[role=tablist]")?.getAttribute("role") === "tablist",
        todasTabs: tabs.every((b) => b.getAttribute("role") === "tab"),
        selecionadas: tabs.filter((b) => b.getAttribute("aria-selected") === "true").length,
      };
    });
    ok("jogador. tablist + role=tab em todas as abas visíveis", semJogador.tablist && semJogador.todasTabs);
    ok("jogador. exatamente uma aba selecionada", semJogador.selecionadas === 1, `selecionadas=${semJogador.selecionadas}`);
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
    // F9 — espectador também recebe semântica de aba correta.
    const semEspectador = await page.evaluate(() => {
      const tabs = [...document.querySelectorAll(".abas[role=tablist] button")];
      return {
        tablist: document.querySelector(".abas[role=tablist]")?.getAttribute("role") === "tablist",
        todasTabs: tabs.every((b) => b.getAttribute("role") === "tab"),
        selecionadas: tabs.filter((b) => b.getAttribute("aria-selected") === "true").length,
      };
    });
    ok("espectador. tablist + role=tab + exatamente uma selecionada",
      semEspectador.tablist && semEspectador.todasTabs && semEspectador.selecionadas === 1,
      JSON.stringify(semEspectador));
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
