#!/usr/bin/env node
// Homologação E2E — compra/venda de patrimônio com conta financeira.
// Cobre: moeda da conta selecionada (BRL/EUR), preço unitário estável
// após venda parcial, rejeição de valor abaixo da menor unidade,
// persistência após reload, conferência do mestre, desktop + mobile.
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
const saldoTag = (page, nome = "Carteira") => page.locator(".tag", { hasText: nome }).first().textContent().catch(() => "");

// Abre o modal de compra já com conta/quantidade/valor preenchidos.
async function abrirCompra(page) {
  await page.getByRole("button", { name: "Comprar…" }).click();
  const modal = page.locator(".modal");
  await modal.waitFor({ timeout: 5000 });
  return modal;
}
async function preencherCompra(page, modal, { item, qtd, valor, contaIdx }) {
  if (item) await modal.locator("select").first().selectOption({ index: 1 });
  else await modal.locator('input').first().fill("Item avulso E2E");
  await modal.locator('input[type="number"]').nth(0).fill(String(qtd));
  await modal.locator('input[type="number"]').nth(1).fill(String(valor));
  await modal.locator("select").nth(1).selectOption({ index: contaIdx ?? 1 });
}
const page_modal = (page) => page.locator(".modal");
// Desktop usa a tabela; mobile usa os cartões — escolhe o botão visível
// dentro do registro do item informado.
async function btnVender(page, item) {
  const porCartao = page.locator(".registro-cartao", { hasText: item }).getByRole("button", { name: "Vender" });
  if (await porCartao.first().isVisible().catch(() => false)) return porCartao.first();
  return page.locator("tr", { hasText: item }).getByRole("button", { name: "Vender" }).first();
}
async function vender(page, { item, qtd, valor, contaIdx = 1 }) {
  await (await btnVender(page, item)).click();
  const modal = page.locator(".modal");
  await modal.waitFor({ timeout: 5000 });
  await modal.locator('input[type="number"]').nth(0).fill(String(qtd));
  await modal.locator('input[type="number"]').nth(1).fill(String(valor));
  await modal.locator("select").first().selectOption({ index: contaIdx });
  return modal;
}

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  const cenario = await criarCenario(BASE, BANCO, { jogadores: { jogador1: "jogador_um" } });
  const charJ = cenario.novoPersonagem(cenario.jogadores.jogador1.membershipId, "Heroína CV");
  const cookieJ = cenario.jogadores.jogador1.cookie;
  // setup via API: contas BRL 100 + EUR 50, EUR configurada, item do catálogo
  await req(BASE, "POST", `/characters/${charJ}/financeiro/contas`, {
    cookie: cookieJ, body: { type: "especie", name: "Carteira", balanceReais: 100 },
  });
  await req(BASE, "PUT", `/campaigns/${cenario.campId}/regras/config`, {
    cookie: cenario.cookieMestre,
    body: { financeiro: { moedas: [{ codigo: "EUR", nome: "Euro", simbolo: "€" }] } },
  });
  await req(BASE, "POST", `/characters/${charJ}/financeiro/contas`, {
    cookie: cookieJ, body: { type: "especie", name: "Euro", balanceReais: 50, currency: "EUR" },
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

  sec("1. Jogador abre a ficha e vê os saldos");
  await abrirPersonagem(pgJ, "Heroína CV");
  await abaPatrimonio(pgJ, "Dinheiro");
  const saldo0 = await saldoTag(pgJ);
  t("saldo BRL inicial 100 visível", /100/.test(saldo0 ?? ""), saldo0?.trim());
  const saldoEur0 = await saldoTag(pgJ, "Euro");
  t("saldo EUR inicial 50 visível", /50/.test(saldoEur0 ?? ""), saldoEur0?.trim());
  await shot(pgJ, "01-saldos-iniciais");

  sec("2. Compra de item do catálogo com débito em BRL");
  await abaPatrimonio(pgJ, "Inventário");
  let modal = await abrirCompra(pgJ);
  await preencherCompra(pgJ, modal, { item: true, qtd: 2, valor: 10, contaIdx: 1 });
  await shot(pgJ, "02-compra-modal-brl");
  await modal.getByRole("button", { name: "Confirmar compra" }).click();
  await pgJ.waitForTimeout(1500);
  t("item comprado visível no inventário", await pgJ.getByText("Poção de Cura").first().isVisible().catch(() => false));
  await abaPatrimonio(pgJ, "Dinheiro");
  const saldo1 = await saldoTag(pgJ);
  t("saldo BRL debitado: 100 → 80", /80/.test(saldo1 ?? ""), saldo1?.trim());
  await shot(pgJ, "03-saldo-pos-compra");

  sec("3. Troca de conta atualiza a moeda exibida (EUR)");
  await abaPatrimonio(pgJ, "Inventário");
  modal = await abrirCompra(pgJ);
  // preenche item avulso e valor, depois alterna entre as contas
  await modal.locator('input').first().fill("Mapa do Tesouro");
  await modal.locator('input[type="number"]').nth(0).fill("1");
  await modal.locator('input[type="number"]').nth(1).fill("5");
  const selConta = modal.locator("select").nth(1);
  await selConta.selectOption({ index: 1 }); // Carteira (BRL)
  const txtBrl = await modal.locator(".meta").allTextContents();
  t("moeda BRL exibida para conta BRL", txtBrl.some((x) => x.includes("BRL")), JSON.stringify(txtBrl));
  await selConta.selectOption({ index: 2 }); // Euro (EUR)
  const txtEur = await modal.locator(".meta").allTextContents();
  t("troca para EUR atualiza rótulos", txtEur.some((x) => x.includes("EUR")), JSON.stringify(txtEur));
  await shot(pgJ, "04-modal-moeda-eur");
  await modal.getByRole("button", { name: "Confirmar compra" }).click();
  await pgJ.waitForTimeout(1500);
  await abaPatrimonio(pgJ, "Dinheiro");
  const saldoEur1 = await saldoTag(pgJ, "Euro");
  t("compra EUR debitou 5 → saldo 45", /45/.test(saldoEur1 ?? ""), saldoEur1?.trim());
  const saldo1b = await saldoTag(pgJ);
  t("saldo BRL inalterado pela compra EUR", /80/.test(saldo1b ?? ""), saldo1b?.trim());
  await shot(pgJ, "05-saldo-eur");

  sec("4. Valor abaixo da menor unidade é rejeitado");
  await abaPatrimonio(pgJ, "Inventário");
  modal = await abrirCompra(pgJ);
  await modal.locator('input').first().fill("Item minúsculo");
  await modal.locator('input[type="number"]').nth(0).fill("1");
  await modal.locator('input[type="number"]').nth(1).fill("0.001");
  await modal.locator("select").nth(1).selectOption({ index: 1 });
  await modal.getByRole("button", { name: "Confirmar compra" }).click();
  await pgJ.waitForTimeout(1200);
  const erroVisivel = await pgJ.locator(".erro").first().textContent().catch(() => "");
  t("erro de valor inválido exibido", /menor unidade|inválido/i.test(erroVisivel ?? ""), erroVisivel?.slice(0, 120));
  t("modal permanece aberto após rejeição", await modal.isVisible().catch(() => false));
  await shot(pgJ, "06-erro-subcentavo");
  await modal.getByRole("button", { name: "Cancelar" }).click();
  await pgJ.waitForTimeout(400);
  await abaPatrimonio(pgJ, "Dinheiro");
  const saldoAposErro = await saldoTag(pgJ);
  t("saldo BRL intacto após rejeição", /80/.test(saldoAposErro ?? ""), saldoAposErro?.trim());
  await abaPatrimonio(pgJ, "Inventário");
  t("item rejeitado não entrou no inventário", !(await pgJ.getByText("Item minúsculo").count()));

  sec("5. Venda parcial e preço unitário estável na reabertura");
  await abaPatrimonio(pgJ, "Inventário");
  modal = await vender(pgJ, { item: "Poção de Cura", qtd: 1, valor: 10 });
  await shot(pgJ, "07-venda-modal");
  await modal.getByRole("button", { name: "Confirmar venda" }).click();
  await pgJ.waitForTimeout(1500);
  await abaPatrimonio(pgJ, "Dinheiro");
  const saldo2 = await saldoTag(pgJ);
  t("saldo creditado: 80 → 90", /90/.test(saldo2 ?? ""), saldo2?.trim());
  const hist2 = (await pgJ.locator(".tabela-responsiva tbody tr").allTextContents()).join(" ");
  t("histórico mostra a venda", /venda/i.test(hist2), hist2.slice(0, 300));
  await shot(pgJ, "08-saldo-pos-venda");
  // reabre a venda SEM preencher: a sugestão deve ser o unitário 10
  // (valueCents=1000 → 10.00), não o total 20 dividido errado.
  await abaPatrimonio(pgJ, "Inventário");
  await (await btnVender(pgJ, "Poção de Cura")).click();
  modal = page_modal(pgJ);
  await modal.waitFor({ timeout: 5000 });
  await pgJ.waitForTimeout(500); // sugestão de preço é preenchida por useEffect
  const valorSugerido = await modal.locator('input[type="number"]').nth(1).inputValue();
  t("reabertura sugere unitário 10 (não 20)", valorSugerido === "10", `valor=${valorSugerido}`);
  await shot(pgJ, "09-venda-reabertura-unitario");
  await modal.getByRole("button", { name: "Cancelar" }).click();
  await pgJ.waitForTimeout(400);

  sec("6. Persistência após recarregar a página");
  await pgJ.reload();
  await pgJ.getByText("Servidor online").waitFor({ timeout: 15000 });
  await irCampanha(pgJ);
  await abrirPersonagem(pgJ, "Heroína CV");
  await abaPatrimonio(pgJ, "Inventário");
  await pgJ.waitForTimeout(800);
  t("item persiste após reload (qtd 1)", await pgJ.getByText("Poção de Cura").first().isVisible().catch(() => false));
  await abaPatrimonio(pgJ, "Dinheiro");
  const saldo3 = await saldoTag(pgJ);
  t("saldo 90 persiste após reload", /90/.test(saldo3 ?? ""), saldo3?.trim());
  const saldoEur3 = await saldoTag(pgJ, "Euro");
  t("saldo EUR 45 persiste após reload", /45/.test(saldoEur3 ?? ""), saldoEur3?.trim());
  await shot(pgJ, "10-persistencia");
  await ctxJ.close();

  // ---------- MESTRE confere os registros ----------
  sec("7. Mestre confere compra e venda");
  const ctxM = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgM = await ctxM.newPage();
  await login(pgM, "mestre_teste", "senha-forte-123");
  await irCampanha(pgM);
  await abrirPersonagem(pgM, "Heroína CV");
  await abaPatrimonio(pgM, "Dinheiro");
  const saldoM = await saldoTag(pgM);
  t("mestre vê saldo 90 idêntico", /90/.test(saldoM ?? ""), saldoM?.trim());
  const histM = (await pgM.locator(".tabela-responsiva tbody tr").allTextContents()).join(" ");
  t("mestre vê compra e venda no histórico", /compra/i.test(histM) && /venda/i.test(histM), histM.slice(0, 300));
  await shot(pgM, "11-mestre-registros");
  await ctxM.close();

  // ---------- MOBILE 390px: jogador vende o restante ----------
  sec("8. Mobile — venda do item restante");
  const ctxMob = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pgMob = await ctxMob.newPage();
  await login(pgMob, "jogador_um", "senha-jogador-123");
  await irCampanha(pgMob);
  await abrirPersonagem(pgMob, "Heroína CV");
  await abaPatrimonio(pgMob, "Inventário");
  await pgMob.waitForTimeout(800);
  t("mobile mostra Poção de Cura", await pgMob.locator("text=Poção de Cura >> visible=true").first().isVisible().catch(() => false));
  modal = await vender(pgMob, { item: "Poção de Cura", qtd: 1, valor: 10 });
  await shot(pgMob, "12-mobile-venda-modal");
  await modal.getByRole("button", { name: "Confirmar venda" }).click();
  await pgMob.waitForTimeout(1500);
  await abaPatrimonio(pgMob, "Dinheiro");
  const saldoMob = await saldoTag(pgMob);
  t("mobile: saldo 90 → 100 após venda total", /100/.test(saldoMob ?? ""), saldoMob?.trim());
  await shot(pgMob, "13-mobile-saldo-final");
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
