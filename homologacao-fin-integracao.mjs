#!/usr/bin/env node
// Homologação E2E — integração financeiro ↔ compras/vendas:
// compra sem movimentação (checkbox), saldo exibido na conta,
// estorno pelo histórico (desktop + mobile 390px, sem overflow).
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

const DIR = dirTeste("fin-integracao-e2e");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const SHOTS = join(process.cwd(), "_evidencias", "fin-integracao");
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
const saldoTag = (page, nome = "Carteira") => page.locator(".tag", { hasText: nome }).first().textContent().catch(() => "");
const semOverflowX = async (page) =>
  (await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  const cenario = await criarCenario(BASE, BANCO, { jogadores: { jogador1: "jogador_um" } });
  const charJ = cenario.novoPersonagem(cenario.jogadores.jogador1.membershipId, "Heroína FI");
  const cookieJ = cenario.jogadores.jogador1.cookie;
  const contaR = await req(BASE, "POST", `/characters/${charJ}/financeiro/contas`, {
    cookie: cookieJ, body: { type: "especie", name: "Carteira", balanceReais: 100 },
  });
  const contaId = contaR.json?.id;
  t("conta criada", !!contaId, JSON.stringify(contaR.json));

  browser = await chromium.launch();

  // ---------- DESKTOP ----------
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pg = await ctx.newPage();
  await login(pg, "jogador_um", "senha-jogador-123");
  await irCampanha(pg);
  await abrirPersonagem(pg, "Heroína FI");

  sec("1. Compra sem movimentação financeira (desktop)");
  await abaPatrimonio(pg, "Inventário");
  await pg.getByRole("button", { name: "Comprar…" }).click();
  let modal = pg.locator(".modal");
  await modal.waitFor({ timeout: 5000 });
  await modal.locator('input').first().fill("Relíquia Achada");
  await modal.locator('input[type="number"]').nth(0).fill("1");
  // desmarca "Pagar agora" → modo sem movimentação
  await modal.getByLabel(/Pagar agora/).uncheck();
  const msgSemPag = await modal.locator(".meta", { hasText: "sem movimentação financeira" }).count();
  t("aviso de compra sem movimentação exibido", msgSemPag > 0);
  const visiveisSemConta = await modal.locator("select").count();
  t("seletor de conta oculto sem pagamento", visiveisSemConta === 1, `selects=${visiveisSemConta}`);
  await shot(pg, "01-compra-sem-pagamento");
  await modal.getByRole("button", { name: /Confirmar compra sem pagamento/ }).click();
  await pg.waitForTimeout(1500);
  t("item sem pagamento no inventário", await pg.getByText("Relíquia Achada").first().isVisible().catch(() => false));
  await abaPatrimonio(pg, "Dinheiro");
  const saldo0 = await saldoTag(pg);
  t("saldo intacto após compra sem pagamento (100)", /100/.test(saldo0 ?? ""), saldo0?.trim());
  await shot(pg, "02-saldo-intacto-sem-pagamento");

  sec("2. Compra paga com saldo exibido");
  await abaPatrimonio(pg, "Inventário");
  await pg.getByRole("button", { name: "Comprar…" }).click();
  modal = pg.locator(".modal");
  await modal.waitFor({ timeout: 5000 });
  await modal.locator('input').first().fill("Poção E2E");
  await modal.locator('input[type="number"]').nth(0).fill("2");
  await modal.locator('input[type="number"]').nth(1).fill("15");
  await modal.locator("select").nth(1).selectOption({ index: 1 });
  const saldoExibido = await modal.locator(".meta", { hasText: "Saldo disponível" }).textContent().catch(() => "");
  t("saldo da conta exibido no modal", /100/.test(saldoExibido ?? "") && /30/.test(saldoExibido ?? ""), saldoExibido?.trim());
  await shot(pg, "03-compra-paga-saldo");
  await modal.getByRole("button", { name: "Confirmar compra", exact: true }).click();
  await pg.waitForTimeout(1500);
  await abaPatrimonio(pg, "Dinheiro");
  const saldo1 = await saldoTag(pg);
  t("saldo debitado 100 → 70", /70/.test(saldo1 ?? ""), saldo1?.trim());
  await shot(pg, "04-saldo-pos-compra");

  sec("3. Estorno da compra paga pelo histórico");
  // linha da compra no histórico (tabela desktop)
  const linhaCompra = pg.locator(".tabela-responsiva tbody tr", { hasText: "Compra: Poção E2E" }).first();
  t("compra aparece no histórico", await linhaCompra.count() > 0);
  await linhaCompra.getByRole("button", { name: "Estornar" }).click();
  const conf = pg.locator(".modal");
  await conf.waitFor({ timeout: 5000 });
  const msgConf = await conf.textContent();
  t("confirmação de estorno exibida", /Estornar/i.test(msgConf ?? ""));
  await shot(pg, "05-confirmacao-estorno");
  await conf.getByRole("button", { name: "Estornar", exact: true }).click();
  await pg.waitForTimeout(1500);
  const saldo2 = await saldoTag(pg);
  t("saldo estornado 70 → 100", /100/.test(saldo2 ?? ""), saldo2?.trim());
  const histTxt = (await pg.locator(".tabela-responsiva tbody").textContent()) ?? "";
  t("estorno registrado no histórico", /estorno/i.test(histTxt), histTxt.slice(0, 300));
  t("botão estornar some após estorno", (await pg.locator(".tabela-responsiva tbody tr", { hasText: "Compra: Poção E2E" }).getByRole("button", { name: "Estornar" }).count()) === 0);
  await shot(pg, "06-pos-estorno");
  await abaPatrimonio(pg, "Inventário");
  t("item estornado removido do inventário", (await pg.getByText("Poção E2E").count()) === 0);
  t("item sem pagamento permanece", await pg.getByText("Relíquia Achada").first().isVisible().catch(() => false));

  sec("4. Compra sem pagamento não gera lançamento financeiro");
  // compras sem pagamento não geram transação → não aparecem no
  // histórico financeiro (o rastro fica no item/auditoria). O estorno
  // delas existe na API via operacaoId, mas não é exposto na UI —
  // limitação documentada no relatório.
  await abaPatrimonio(pg, "Dinheiro");
  await pg.waitForTimeout(600);
  const histSemPag = (await pg.locator(".tabela-responsiva tbody").textContent()) ?? "";
  t("histórico financeiro sem registro da compra não paga", !/Relíquia Achada/.test(histSemPag), histSemPag.slice(0, 200));

  await ctx.close();

  // ---------- MOBILE 390px ----------
  sec("5. Mobile 390px — compra sem pagamento + sem overflow");
  const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pgM = await ctxM.newPage();
  await login(pgM, "jogador_um", "senha-jogador-123");
  await irCampanha(pgM);
  await abrirPersonagem(pgM, "Heroína FI");
  await abaPatrimonio(pgM, "Inventário");
  t("mobile sem overflow horizontal", await semOverflowX(pgM));
  await pgM.getByRole("button", { name: "Comprar…" }).click();
  const modalM = pgM.locator(".modal");
  await modalM.waitFor({ timeout: 5000 });
  await modalM.locator('input').first().fill("Amuleto Mobile");
  await modalM.locator('input[type="number"]').nth(0).fill("1");
  await modalM.getByLabel(/Pagar agora/).uncheck();
  t("mobile sem overflow no modal", await semOverflowX(pgM));
  await shot(pgM, "07-mobile-compra-sem-pagamento");
  await modalM.getByRole("button", { name: /Confirmar compra sem pagamento/ }).click();
  await pgM.waitForTimeout(2000);
  const erroMob = await pgM.locator(".erro").first().textContent().catch(() => "");
  const modalAberto = await modalM.isVisible().catch(() => false);
  const itemMob = pgM.locator("text=Amuleto Mobile >> visible=true").first();
  t("item mobile criado", await itemMob.isVisible().catch(() => false),
    `erro=${erroMob?.slice(0, 120)} modalAberto=${modalAberto}`);
  await abaPatrimonio(pgM, "Dinheiro");
  t("mobile sem overflow no dinheiro", await semOverflowX(pgM));
  const saldoM = await saldoTag(pgM);
  t("saldo mobile intacto (100)", /100/.test(saldoM ?? ""), saldoM?.trim());
  await shot(pgM, "08-mobile-dinheiro");
  await ctxM.close();

} catch (e) {
  fail++;
  console.log("  FALHOU exceção:", String(e).slice(0, 500));
} finally {
  if (browser) await browser.close().catch(() => { });
  if (proc) await encerrarServidor(proc).catch(() => { });
  limparDir(DIR);
}
console.log(`\n==== fin-integracao-e2e: ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
