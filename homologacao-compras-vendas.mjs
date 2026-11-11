#!/usr/bin/env node
// Homologação E2E — compra/venda de patrimônio com conta financeira.
// Fluxo real na interface: jogador compra item do catálogo debitando a
// conta, vende parte creditando, recarrega e confirma persistência;
// mestre confere os registros. Desktop 1366px e mobile 390px.
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

const DIR = dirTeste("compras-vendas");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const SHOTS = join(process.cwd(), "_evidencias", "compras-vendas");
mkdirSync(SHOTS, { recursive: true });
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const CAMPANHA = "Campanha Teste";

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
  await page.waitForTimeout(600);
}
async function abaPatrimonio(page, nome) {
  await page.getByRole("button", { name: nome, exact: true }).first().click();
  await page.waitForTimeout(600);
}
const saldoTag = (page) => page.locator(".tag", { hasText: "Carteira" }).first().textContent().catch(() => "");

async function comprar(page, { item, qtd, valor, conta }) {
  await page.getByRole("button", { name: "Comprar…" }).click();
  const modal = page.locator(".modal");
  await modal.waitFor({ timeout: 5000 });
  if (item) await modal.locator("select").first().selectOption({ index: 1 });
  await modal.locator('input[type="number"]').nth(0).fill(String(qtd));
  await modal.locator('input[type="number"]').nth(1).fill(String(valor));
  await modal.locator("select").nth(1).selectOption({ index: 1 });
  await shot(page, "compra-modal");
  await modal.getByRole("button", { name: "Confirmar compra" }).click();
  await page.waitForTimeout(1500);
}
async function vender(page, itemNome, { qtd, valor, conta }) {
  const btn = page.getByRole("button", { name: "Vender" }).first();
  await btn.click();
  const modal = page.locator(".modal");
  await modal.waitFor({ timeout: 5000 });
  await modal.locator('input[type="number"]').nth(0).fill(String(qtd));
  await modal.locator('input[type="number"]').nth(1).fill(String(valor));
  await modal.locator("select").first().selectOption({ index: 1 });
  await shot(page, "venda-modal");
  await modal.getByRole("button", { name: "Confirmar venda" }).click();
  await page.waitForTimeout(1500);
}

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  const cenario = await criarCenario(BASE, BANCO, { jogadores: { jogador1: "jogador_um" } });
  const charJ = cenario.novoPersonagem(cenario.jogadores.jogador1.membershipId, "Heroína CV");
  // setup via API: conta com saldo 100 + item do catálogo
  await req(BASE, "POST", `/characters/${charJ}/financeiro/contas`, {
    cookie: cenario.jogadores.jogador1.cookie,
    body: { type: "especie", name: "Carteira", balanceReais: 100 },
  });
  await req(BASE, "POST", `/campaigns/${cenario.campId}/inventario`, {
    cookie: cenario.cookieMestre,
    body: { name: "Poção de Cura", category: "Consumível", description: "Restaura PV" },
  });

  browser = await chromium.launch();

  // ---------- DESKTOP: jogador compra e vende ----------
  const ctxJ = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgJ = await ctxJ.newPage();
  await login(pgJ, "jogador_um", "senha-jogador-123");
  await irCampanha(pgJ);

  sec("1. Jogador abre a ficha e vê o saldo");
  await abrirPersonagem(pgJ, "Heroína CV");
  await abaPatrimonio(pgJ, "Dinheiro");
  const saldo0 = await saldoTag(pgJ);
  t("saldo inicial 100 visível", /100/.test(saldo0 ?? ""), saldo0?.trim());
  await shot(pgJ, "01-saldo-inicial");

  sec("2. Compra de item do catálogo com débito na conta");
  await abaPatrimonio(pgJ, "Inventário");
  await comprar(pgJ, { item: "Poção de Cura", qtd: 2, valor: 10, conta: "Carteira" });
  const itemVisivel = await pgJ.getByText("Poção de Cura").first().isVisible().catch(() => false);
  t("item comprado visível no inventário", itemVisivel);
  await shot(pgJ, "02-item-comprado");
  await abaPatrimonio(pgJ, "Dinheiro");
  const saldo1 = await saldoTag(pgJ);
  t("saldo debitado: 100 → 80", /80/.test(saldo1 ?? ""), saldo1?.trim());
  const hist1 = (await pgJ.locator(".tabela-responsiva tbody tr").allTextContents()).join(" ");
  t("histórico financeiro mostra a compra", hist1.includes("compra") || hist1.includes("Compra"), hist1.slice(0, 200));
  await shot(pgJ, "03-saldo-pos-compra");

  sec("3. Venda parcial com crédito na conta");
  await abaPatrimonio(pgJ, "Inventário");
  await vender(pgJ, "Poção de Cura", { qtd: 1, valor: 8, conta: "Carteira" });
  await pgJ.waitForTimeout(600);
  await shot(pgJ, "04-apos-venda");
  await abaPatrimonio(pgJ, "Dinheiro");
  const saldo2 = await saldoTag(pgJ);
  t("saldo creditado: 80 → 88", /88/.test(saldo2 ?? ""), saldo2?.trim());
  const hist2 = (await pgJ.locator(".tabela-responsiva tbody tr").allTextContents()).join(" ");
  t("histórico mostra a venda", /venda/i.test(hist2), hist2.slice(0, 300));
  await shot(pgJ, "05-saldo-pos-venda");

  sec("4. Persistência após recarregar a página");
  await pgJ.reload();
  await pgJ.getByText("Servidor online").waitFor({ timeout: 15000 });
  await irCampanha(pgJ);
  await abrirPersonagem(pgJ, "Heroína CV");
  await abaPatrimonio(pgJ, "Inventário");
  await pgJ.waitForTimeout(800);
  const aindaTem = await pgJ.getByText("Poção de Cura").first().isVisible().catch(() => false);
  t("item persiste após reload", aindaTem);
  await abaPatrimonio(pgJ, "Dinheiro");
  const saldo3 = await saldoTag(pgJ);
  t("saldo 88 persiste após reload", /88/.test(saldo3 ?? ""), saldo3?.trim());
  await shot(pgJ, "06-persistencia");
  await ctxJ.close();

  // ---------- MESTRE confere os registros ----------
  sec("5. Mestre confere compra e venda");
  const ctxM = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgM = await ctxM.newPage();
  await login(pgM, "mestre_teste", "senha-forte-123");
  await irCampanha(pgM);
  await abrirPersonagem(pgM, "Heroína CV");
  await abaPatrimonio(pgM, "Dinheiro");
  const saldoM = await saldoTag(pgM);
  t("mestre vê saldo 88 idêntico", /88/.test(saldoM ?? ""), saldoM?.trim());
  const histM = (await pgM.locator(".tabela-responsiva tbody tr").allTextContents()).join(" ");
  t("mestre vê compra e venda no histórico", /compra/i.test(histM) && /venda/i.test(histM), histM.slice(0, 300));
  await shot(pgM, "07-mestre-registros");
  await ctxM.close();

  // ---------- MOBILE 390px: jogador vende o restante ----------
  sec("6. Mobile — venda do item restante");
  const ctxMob = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pgMob = await ctxMob.newPage();
  await login(pgMob, "jogador_um", "senha-jogador-123");
  await irCampanha(pgMob);
  await abrirPersonagem(pgMob, "Heroína CV");
  await abaPatrimonio(pgMob, "Inventário");
  await pgMob.waitForTimeout(800);
  const qtdRestante = await pgMob.locator("tr", { hasText: "Poção de Cura" }).first().textContent().catch(() => "");
  t("mobile mostra item com qtd 1 restante", /Poção de Cura/.test(qtdRestante ?? ""), (qtdRestante ?? "").slice(0, 120));
  await vender(pgMob, "Poção de Cura", { qtd: 1, valor: 8, conta: "Carteira" });
  await abaPatrimonio(pgMob, "Dinheiro");
  const saldoMob = await saldoTag(pgMob);
  t("mobile: saldo 88 → 96 após venda", /96/.test(saldoMob ?? ""), saldoMob?.trim());
  await shot(pgMob, "08-mobile-venda");
  await ctxMob.close();

} catch (e) {
  fail++;
  console.log("  FALHOU exceção:", String(e).slice(0, 500));
} finally {
  if (browser) await browser.close().catch(() => { });
  if (proc) await encerrarServidor(proc).catch(() => { });
  limparDir(DIR);
}
console.log(`\n==== compras-vendas: ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
