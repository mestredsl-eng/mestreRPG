#!/usr/bin/env node
// Homologação E2E — conversão de ferimentos em Vitalidade.
// Cobre: seção de configuração em Regras (desktop), dano via ficha que
// cruza limiar de HP, vitalidade e histórico "por ferimento" na UI,
// e viewport mobile 390px.
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

const DIR = dirTeste("conversao-vida");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const SHOTS = join(process.cwd(), "_evidencias", "conversao-vida");
mkdirSync(SHOTS, { recursive: true });
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const CAMPANHA = "Campanha Teste";

const CONFIG = {
  hp: { habilitado: true, base: 100, porNivel: 20, campoId: "for", edicaoPor: "ambos" },
  vitalidade: {
    edicaoPor: "ambos",
    niveis: [
      { nome: "São", penalidadeDados: 0, bloqueiaAcoes: false },
      { nome: "Machucado", penalidadeDados: 1, bloqueiaAcoes: false },
      { nome: "Ferido", penalidadeDados: 1, bloqueiaAcoes: false },
      { nome: "Incapacitado", penalidadeDados: 0, bloqueiaAcoes: true },
    ],
  },
  conversaoFerimento: {
    habilitada: true,
    limiares: [
      { ate: 50, nivel: 1 },
      { ate: 25, nivel: 2 },
      { ate: 10, nivel: 3 },
    ],
  },
};

let browser, proc;
async function shot(page, nome) { try { await page.screenshot({ path: join(SHOTS, `${nome}.png`) }); } catch { } }
async function login(page, user, senha) {
  await page.goto(BASE);
  await page.getByLabel("Usuário").fill(user);
  await page.getByLabel("Senha").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByText("Servidor online").waitFor({ timeout: 15000 });
}
async function irCampanha(page) {
  await page.getByRole("button", { name: "Campanhas" }).click();
  await page.getByText(CAMPANHA, { exact: true }).first().click();
}
async function aba(page, nome) {
  await page.locator(".abas button", { hasText: nome }).first().click();
}
async function abrirPersonagem(page, nome) {
  await aba(page, "Personagens");
  await page.locator("tr.clicavel", { hasText: nome }).first().click();
  await page.waitForTimeout(800);
}

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);

  const cenario = await criarCenario(BASE, BANCO, { config: CONFIG });
  const charM = cenario.personagemMestre; // "Mestre Herói", FOR=5 -> HP máx 200
  console.log("seed:", { camp: cenario.campId, charM });

  browser = await chromium.launch();

  // ===== Desktop =====
  sec("Desktop — configuração em Regras");
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const erros = [];
    page.on("pageerror", (e) => erros.push(String(e)));
    await login(page, "mestre_teste", "senha-forte-123");
    await irCampanha(page);
    await aba(page, "Regras");
    await page.waitForTimeout(800);
    // O editor de configuração fica na sub-aba "Pontuação" dentro de Regras.
    await page.locator(".abas button", { hasText: "Pontuação" }).first().click();
    await page.waitForTimeout(1200);

    const secao = page.locator("h4", { hasText: "Conversão de ferimentos" });
    t("seção de conversão visível", await secao.count() === 1);
    const chk = page.locator(".checkbox input[type=checkbox]").first();
    // localiza o checkbox específico da conversão pelo texto
    const convBox = page.locator("label.checkbox", { hasText: "Ativar conversão automática" }).locator("input");
    t("conversão ativada na config", await convBox.isChecked().catch(() => false));
    t("3 limiares renderizados", await page.locator(".linha-ferramentas", { hasText: "HP restante" }).count() === 3,
      `n=${await page.locator(".linha-ferramentas", { hasText: "HP restante" }).count()}`);
    t("texto explicativo presente", await page.getByText("Recuperar HP não reduz a Vitalidade").count() >= 1);
    await shot(page, "01-regras-conversao");
    await ctx.close();

    sec("Desktop — dano cruza limiar na ficha");
    {
      const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const p2 = await ctx2.newPage();
      const erros2 = [];
      p2.on("pageerror", (e) => erros2.push(String(e)));
      await login(p2, "mestre_teste", "senha-forte-123");
      await irCampanha(p2);
      await abrirPersonagem(p2, "Mestre Herói");

      const hpAntes = await p2.locator(".hp-atual").first().textContent().catch(() => "");
      t("HP inicial 200 visível", hpAntes.includes("200"), hpAntes);
      const vitAntes = await p2.locator(".vit-nivel.atual .vit-nome").first().textContent().catch(() => "");
      t("vitalidade inicial São", vitAntes === "São", vitAntes);

      // dano 150 -> HP 50 (25%) -> cruza limiares 50% e 25% -> nível Ferido (2)
      await p2.locator(".hp-acoes input[type=number]").first().fill("150");
      await p2.getByRole("button", { name: "Dano", exact: true }).click();
      // aguarda a vitalidade refletir na UI (estado atualizado via resposta)
      await p2.locator(".vit-nivel.atual .vit-nome", { hasText: "Ferido" }).waitFor({ timeout: 8000 }).catch(() => {});
      await p2.waitForTimeout(500);

      const hpDepois = await p2.locator(".hp-atual").first().textContent().catch(() => "");
      t("HP 50/200 após dano", hpDepois.includes("50") && hpDepois.includes("200"), hpDepois);
      const vitDepois = await p2.locator(".vit-nivel.atual .vit-nome").first().textContent().catch(() => "");
      t("vitalidade subiu para Ferido", vitDepois === "Ferido", vitDepois);
      // confere o histórico persistido via API (origem da conversão)
      const vidaApi = (await req(BASE, "GET", `/characters/${charM}`, { cookie: cenario.cookieMestre })).json?.ficha?.vida;
      const evConv = (vidaApi?.vitalidade?.historico ?? []).find((e) => e.origem === "conversao-ferimento");
      t("API: evento de conversão persistido", !!evConv && evConv.nivelNovo === 2, JSON.stringify(evConv).slice(0, 150));
      const badge = await p2.locator(".vit-origem", { hasText: "por ferimento" }).count();
      t("histórico marca 'por ferimento'", badge >= 1, `n=${badge}`);
      const motivo = await p2.locator(".hp-motivo", { hasText: "dano de 150 HP" }).count();
      t("motivo do evento referencia o dano", motivo >= 1, `n=${motivo}`);
      await shot(p2, "02-ficha-apos-dano");
      t("sem erros de console (desktop)", erros2.length === 0, erros2.slice(0, 2).join(" | "));
      await ctx2.close();
    }
  }

  // ===== Mobile 390px =====
  sec("Mobile 390px");
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await login(page, "mestre_teste", "senha-forte-123");
    await irCampanha(page);
    await abrirPersonagem(page, "Mestre Herói");
    await page.waitForTimeout(800);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    t("mobile: sem overflow horizontal", overflow <= 1, `overflow=${overflow}px`);
    const vit = await page.locator(".vit-nivel.atual .vit-nome").first().textContent().catch(() => "");
    t("mobile: vitalidade Ferido persistida", vit === "Ferido", vit);
    const badge = await page.locator(".vit-origem").count();
    t("mobile: badge por ferimento visível", badge >= 1, `n=${badge}`);
    await shot(page, "03-mobile-ficha");
    await ctx.close();
  }

  await browser.close();
} finally {
  await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
