#!/usr/bin/env node
// Homologação E2E — Central de Novidades (Issue #42).
// Cobre: CRUD admin pela UI, publicação, badge de não lidas no menu,
// leitura individual (A lê / B não), rascunho invisível, responsivo
// desktop e mobile 390px.
import { chromium } from "playwright";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("novidades-e2e");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const SHOTS = join(process.cwd(), "_evidencias", "novidades");
mkdirSync(SHOTS, { recursive: true });
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;

let browser, proc;
async function shot(page, nome) { try { await page.screenshot({ path: join(SHOTS, `${nome}.png`) }); } catch { } }
async function login(page, user, senha) {
  await page.goto(BASE);
  await page.getByLabel("Usuário").fill(user);
  await page.getByLabel("Senha").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByText("Servidor online").waitFor({ timeout: 15000 });
}
const btnNav = (page, nome) => page.locator(".topo nav button", { hasText: nome }).first();

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);

  const cenario = await criarCenario(BASE, BANCO, { campanha: "Campanha Novidades", jogadores: { a: "usuario_a", b: "usuario_b" } });
  console.log("seed ok");

  browser = await chromium.launch();

  // ===== Desktop — administração =====
  sec("Desktop — admin cria e publica");
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const erros = [];
    page.on("pageerror", (e) => erros.push(String(e)));
    await login(page, "mestre_teste", "senha-forte-123");

    // rascunhos via API: um será publicado pela UI, outro permanece oculto
    const rasc = await req(BASE, "POST", "/admin/novidades", {
      cookie: cenario.cookieMestre,
      body: { titulo: "Rascunho secreto", conteudo: "não deve aparecer", estado: "rascunho" },
    });
    t("rascunho criado via API", rasc.status === 201);
    const oculto = await req(BASE, "POST", "/admin/novidades", {
      cookie: cenario.cookieMestre,
      body: { titulo: "Rascunho oculto", conteudo: "invisível para usuários", estado: "rascunho" },
    });
    t("segundo rascunho criado", oculto.status === 201);

    await btnNav(page, "Administração").click();
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "Nova publicação" }).click();
    await page.getByLabel("Título").fill("Central de Novidades no ar");
    await page.getByLabel("Resumo").fill("Agora você acompanha as atualizações aqui.");
    await page.getByLabel("Conteúdo").fill("Linha 1 do conteúdo\nLinha 2 do conteúdo");
    await page.getByLabel("Versão").fill("1.1.0");
    await page.getByLabel("Categoria").selectOption("novidade");
    await page.getByLabel("Estado").selectOption("publicada");
    await page.getByRole("button", { name: "Salvar", exact: true }).click();
    await page.waitForTimeout(800);
    t("publicação aparece na tabela admin", await page.locator("tr", { hasText: "Central de Novidades no ar" }).count() === 1);
    t("badge Publicada visível", await page.locator("tr", { hasText: "Central de Novidades no ar" }).locator(".badge", { hasText: "Publicada" }).count() === 1);
    t("badge Rascunho visível", await page.locator("tr", { hasText: "Rascunho secreto" }).locator(".badge", { hasText: "Rascunho" }).count() === 1);

    // publica o rascunho pela UI
    const linhaRasc = page.locator("tr", { hasText: "Rascunho secreto" });
    await linhaRasc.getByRole("button", { name: "Publicar" }).click();
    await page.waitForTimeout(600);
    t("rascunho publicado pela UI", await linhaRasc.locator(".badge", { hasText: "Publicada" }).count() === 1);

    await shot(page, "01-admin-novidades");
    t("sem erros de console (admin)", erros.length === 0, erros.slice(0, 2).join(" | "));
    await ctx.close();
  }

  // ===== Desktop — usuário comum =====
  sec("Desktop — usuário lê novidades");
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const erros = [];
    page.on("pageerror", (e) => erros.push(String(e)));
    await login(page, "usuario_a", "senha-jogador-123");

    const badge = page.locator(".contador-nao-lidas");
    await page.waitForTimeout(600);
    t("badge de não lidas aparece", await badge.count() === 1, `n=${await badge.count()}`);
    t("badge conta 2 publicadas", (await badge.textContent()) === "2", await badge.textContent());

    await btnNav(page, "Novidades").click();
    await page.waitForTimeout(800);
    const itens = page.locator(".novidade-item");
    t("2 publicações listadas", await itens.count() === 2, `n=${await itens.count()}`);
    t("rascunho não listado", await page.getByText("Rascunho oculto").count() === 0);
    t("itens não lidos marcados", await page.locator(".novidade-item.nao-lida").count() === 2);

    // abre a primeira → marca como lida
    const tituloAberto = (await itens.first().locator(".novidade-titulo").textContent())?.trim() ?? "";
    await itens.first().click();
    await page.waitForTimeout(800);
    t("modal com conteúdo", await page.locator(".conteudo-novidade").count() === 1);
    t("badge diminui para 1", (await badge.textContent()) === "1", await badge.textContent());
    await page.getByRole("button", { name: "Fechar" }).click();
    await page.waitForTimeout(400);
    t("item lido perde destaque", await page.locator(".novidade-item.nao-lida").count() === 1);
    await shot(page, "02-usuario-novidades");

    // refresh → estado persiste
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    await btnNav(page, "Novidades").click();
    await page.waitForTimeout(600);
    t("após refresh: 1 não lida", await page.locator(".novidade-item.nao-lida").count() === 1);
    t("badge persiste = 1", (await badge.textContent()) === "1", await badge.textContent());
    t("sem erros de console (usuário)", erros.length === 0, erros.slice(0, 2).join(" | "));
    await ctx.close();
  }

  // ===== Isolamento A/B =====
  sec("Isolamento por usuário");
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await login(page, "usuario_b", "senha-jogador-123");
    await page.waitForTimeout(500);
    t("B vê as 2 como não lidas", (await page.locator(".contador-nao-lidas").textContent()) === "2");
    await btnNav(page, "Novidades").click();
    await page.waitForTimeout(700);
    t("B: ambas não lidas", await page.locator(".novidade-item.nao-lida").count() === 2);
    await ctx.close();
  }

  // ===== Admin vê contagem de leituras =====
  sec("Admin — contagem de leituras");
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await login(page, "mestre_teste", "senha-forte-123");
    await btnNav(page, "Administração").click();
    await page.waitForTimeout(800);
    // a publicação que A abriu deve ter exatamente 1 leitura; a outra, 0
    const adminList = await req(BASE, "GET", "/admin/novidades", { cookie: cenario.cookieMestre });
    const pubs = adminList.json?.novidades ?? [];
    const lidas = pubs.filter((n) => n.titulo === "Central de Novidades no ar" || n.titulo === "Rascunho secreto").map((n) => n.leituras);
    t("admin vê leituras corretas por publicação", lidas.length === 2 && lidas.reduce((a, b) => a + b, 0) === 1 && Math.max(...lidas) === 1, JSON.stringify(lidas));
    t("contagem visível na tabela admin", await page.locator("td", { hasText: /^1$/ }).count() >= 1);
    await ctx.close();
  }

  // ===== Mobile 390px =====
  sec("Mobile 390px");
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const erros = [];
    page.on("pageerror", (e) => erros.push(String(e)));
    await login(page, "usuario_b", "senha-jogador-123");
    await page.waitForTimeout(500);
    await btnNav(page, "Novidades").click();
    await page.waitForTimeout(700);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    t("mobile: sem overflow horizontal", overflow <= 1, `overflow=${overflow}px`);
    t("mobile: badge visível", await page.locator(".contador-nao-lidas").count() === 1);
    await page.locator(".novidade-item").first().click();
    await page.waitForTimeout(700);
    t("mobile: modal abre com conteúdo", await page.locator(".conteudo-novidade").count() === 1);
    const overflowModal = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    t("mobile: modal sem overflow", overflowModal <= 1, `overflow=${overflowModal}px`);
    await shot(page, "03-mobile-novidade");
    t("sem erros de console (mobile)", erros.length === 0, erros.slice(0, 2).join(" | "));
    await ctx.close();
  }

  await browser.close();
} finally {
  await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
