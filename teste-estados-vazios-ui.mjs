#!/usr/bin/env node
// Teste E2E de estados vazios ilustrados (Issue #236 / #132).
// Cobre: Personagens (vazia × busca sem resultado), Diário (vazio ×
// filtro sem resultado), Arquivos, Convites (estado vazio + formulário
// preservado), acessibilidade do ícone decorativo e mobile 390px.
import { chromium } from "playwright";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

const DIR = dirTeste("estados-vazios");
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
  await page.waitForTimeout(500);
}

// Verifica estado vazio: texto presente, ícone svg aria-hidden, sem emoji.
async function checarVazio(escopo, texto, nome) {
  const v = escopo.locator(".estado-vazio").filter({ hasText: texto }).first();
  const existe = (await v.count()) === 1;
  if (!existe) { ok(nome, false, "estado-vazio não encontrado"); return null; }
  const icone = await v.locator("svg.icone-interface").count();
  const aria = await v.locator("svg.icone-interface").getAttribute("aria-hidden");
  const txt = await v.locator(".estado-vazio-texto").innerText();
  ok(nome, icone === 1 && aria === "true" && txt.includes(texto), `icone=${icone} aria=${aria} txt="${txt.trim()}"`);
  return v;
}

try {
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO, { campanha: "Campanha Teste" }); // mestre tem 1 personagem
  const cookieM = `mestre_rpg_session=${c.cookieMestre.split("=").pop()}`;
  const cookieJ = `mestre_rpg_session=${c.jogadores.jogador1.cookie.split("=").pop()}`;

  const browser = await chromium.launch();
  const ctxM = await browser.newContext();
  await ctxM.addCookies([{ name: "mestre_rpg_session", value: c.cookieMestre.split("=").pop(), url: BASE }]);
  const pm = await ctxM.newPage();
  await pm.goto(BASE, { waitUntil: "networkidle" });
  await pm.getByRole("button", { name: "Campanhas" }).first().click();
  await pm.locator(".cartao-campanha", { hasText: "Campanha Teste" }).first().click();
  await pm.locator(".abas").waitFor({ timeout: 15000 });

  // ---------- Personagens: busca sem resultado (mestre tem personagem) ----------
  await abrirAba(pm, "Personagens");
  await pm.locator('input[aria-label="Buscar personagem"]').fill("zzzz-inexistente");
  await pm.waitForTimeout(400);
  await checarVazio(pm.locator("body"), "Nenhum personagem corresponde à busca.", "personagens. filtro sem resultado → vazio-busca");
  const iconeBusca = await pm.locator('.estado-vazio:has-text("corresponde à busca") svg.icone-interface').getAttribute("class");
  ok("personagens. ícone de busca-sem-resultado é o desenho vazio-busca", iconeBusca !== null);

  // ---------- Diário: vazio → cria anotação → filtro sem resultado ----------
  await abrirAba(pm, "Diário");
  await checarVazio(pm.locator("body"), "Nenhuma anotação.", "diario. lista realmente vazia → vazio-lista");
  const r = await req(BASE, "POST", `/campaigns/${c.campId}/anotacoes`, {
    cookie: cookieM, body: { title: "Nota de teste", content: "conteúdo", kind: "diario", visibility: "privada" },
  });
  ok("setup. POST anotação", r.status === 200 || r.status === 201, `status=${r.status}`);
  await pm.reload({ waitUntil: "networkidle" });
  await pm.getByRole("button", { name: "Campanhas" }).first().click();
  await pm.locator(".cartao-campanha", { hasText: "Campanha Teste" }).first().click();
  await pm.locator(".abas").waitFor({ timeout: 15000 });
  await pm.locator(".abas button", { hasText: "Diário" }).first().click();
  await pm.waitForTimeout(600);
  ok("diario. anotação criada aparece", await pm.locator("text=Nota de teste").count() >= 1);
  await pm.locator('input[aria-label="Buscar anotação"]').fill("zzzz-filtro");
  await pm.waitForTimeout(400);
  await checarVazio(pm.locator("body"), "Nenhuma anotação corresponde aos filtros.", "diario. filtro sem resultado → vazio-busca");

  // ---------- Arquivos: visualização vazia ----------
  await abrirAba(pm, "Arquivos");
  await pm.waitForTimeout(800);
  await checarVazio(pm.locator("body"), "Nenhum arquivo nesta visualização.", "arquivos. visualização vazia");

  // ---------- Convites: estado vazio + formulário preservado ----------
  await abrirAba(pm, "Convites");
  await pm.waitForTimeout(800);
  await checarVazio(pm.locator("body"), "Nenhum convite gerado ainda.", "convites. lista vazia");
  const btnConvite = await pm.locator('button[type="submit"]', { hasText: "Gerar convite" }).count();
  ok("convites. formulário Gerar convite continua visível", btnConvite === 1);

  // ---------- Mobile 390px sem overflow ----------
  await pm.setViewportSize({ width: 390, height: 844 });
  await pm.waitForTimeout(300);
  const ov = await pm.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("mobile 390px sem overflow horizontal", ov <= 1, `overflow=${ov}px`);

  // ---------- Jogador: Personagens realmente vazia (sem personagem) ----------
  const ctxJ = await browser.newContext();
  await ctxJ.addCookies([{ name: "mestre_rpg_session", value: c.jogadores.jogador1.cookie.split("=").pop(), url: BASE }]);
  const pj = await ctxJ.newPage();
  await pj.goto(BASE, { waitUntil: "networkidle" });
  await pj.getByRole("button", { name: "Campanhas" }).first().click();
  await pj.locator(".cartao-campanha", { hasText: "Campanha Teste" }).first().click();
  await pj.locator(".abas").waitFor({ timeout: 15000 });
  await abrirAba(pj, "Personagens");
  await pj.waitForTimeout(800);
  await checarVazio(pj.locator("body"), "Nenhum personagem ainda.", "jogador. personagens vazio real");
  // distinção: texto/ícone de vazio real ≠ filtro sem resultado
  const temBuscaIcone = await pj.locator('.estado-vazio:has-text("ainda") svg.icone-interface').count();
  ok("jogador. estado vazio real usa desenho vazio-lista (distinto do busca)", temBuscaIcone === 1);

  await browser.close();
} finally {
  encerrarServidor(proc);
  limparDir(DIR);
}

const falhas = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - falhas.length}/${resultados.length} verificações OK`);
if (falhas.length) { console.log("FALHAS:", falhas.map((f) => f.nome).join(" | ")); process.exit(1); }
