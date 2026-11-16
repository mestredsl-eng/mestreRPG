#!/usr/bin/env node
// Homologação de patrimônio/financeiro na interface:
// jogador movimenta a própria ficha, saldo anterior → operação → saldo final
// visíveis no histórico, e o mestre vê o mesmo estado autoritativo.
import { chromium } from "playwright";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, abrirDb, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("patrimonio");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const SHOTS = join(process.cwd(), "_evidencias", "patrimonio");
import { mkdirSync } from "node:fs";
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
  await page.waitForTimeout(500);
}
async function registrarMov(page, conta, tipo, valor, desc) {
  const form = page.locator("form.formulario", { has: page.getByRole("button", { name: "Registrar" }) });
  await form.locator("select").first().selectOption({ label: conta });
  await form.locator("select").nth(1).selectOption(tipo);
  await form.locator('input[placeholder="Valor"]').fill(String(valor));
  await form.locator('input[placeholder="Descrição"]').fill(desc);
  await form.getByRole("button", { name: "Registrar" }).click();
  await page.waitForTimeout(1200);
}
const saldoTag = (page) => page.locator(".tag", { hasText: "Carteira" }).first().textContent().catch(() => "");

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  const cenario = await criarCenario(BASE, BANCO);
  cenario.novoPersonagem(cenario.jogadores.jogador1.membershipId, "Heroína Um");
  browser = await chromium.launch();

  const ctxJ = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgJ = await ctxJ.newPage();
  await login(pgJ, "jogador_um", "senha-jogador-123");
  await irCampanha(pgJ);

  sec("1. Jogador acessa o próprio patrimônio");
  await abrirPersonagem(pgJ, "Heroína Um");
  const temDinheiro = await pgJ.getByRole("button", { name: "Dinheiro", exact: true }).count();
  t("aba Dinheiro disponível na ficha", temDinheiro > 0);
  await abaPatrimonio(pgJ, "Dinheiro");
  await pgJ.getByRole("button", { name: "Nova conta" }).click();
  await pgJ.getByPlaceholder("Nome (ex.: Carteira, Banco X)").fill("Carteira");
  const formConta = pgJ.locator("form.formulario", { has: pgJ.getByPlaceholder("Nome (ex.: Carteira, Banco X)") });
  await formConta.locator('input[placeholder="Saldo inicial"]').fill("100");
  await formConta.getByRole("button", { name: "Criar" }).click();
  await pgJ.waitForTimeout(1200);
  const saldo0 = await saldoTag(pgJ);
  t("conta criada com saldo inicial 100 visível", /100/.test(saldo0 ?? ""), saldo0?.trim());
  await shot(pgJ, "01-conta-criada");

  sec("2. Movimentação real: saldo anterior → operação → saldo final");
  await registrarMov(pgJ, "Carteira", "entrada", 50, "Bônus da sessão");
  const saldo1 = await saldoTag(pgJ);
  t("entrada +50 → saldo 150", /150/.test(saldo1 ?? ""), saldo1?.trim());
  await registrarMov(pgJ, "Carteira", "saida", 30, "Compra de suprimentos");
  const saldo2 = await saldoTag(pgJ);
  t("saída −30 → saldo 120", /120/.test(saldo2 ?? ""), saldo2?.trim());
  // histórico com "Saldo após"
  const linhas = await pgJ.locator(".tabela-responsiva tbody tr").allTextContents();
  const histTxt = linhas.join(" ");
  t("histórico mostra Bônus e Compra", histTxt.includes("Bônus da sessão") && histTxt.includes("Compra de suprimentos"));
  t("histórico mostra saldo após (120)", /120/.test(histTxt));
  await shot(pgJ, "02-historico-saldos");

  sec("3. Transferência de item entre personagens (UI, mestre)");
  // Jogador só enxerga o próprio personagem — transferência é visão do mestre.
  const ctxM2 = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgM2 = await ctxM2.newPage();
  await login(pgM2, "mestre_teste", "senha-forte-123");
  await irCampanha(pgM2);
  await abrirPersonagem(pgM2, "Mestre Herói");
  await abaPatrimonio(pgM2, "Inventário");
  await pgM2.getByRole("button", { name: /Adicionar|Novo item/i }).first().click().catch(() => {});
  await pgM2.waitForTimeout(400);
  const inpNome = pgM2.locator('input[placeholder*="Nome"], input[placeholder*="Item"]').first();
  if (await inpNome.count()) {
    await inpNome.fill("Corda 10m");
    await pgM2.getByRole("button", { name: /Adicionar|Salvar|Criar/ }).last().click();
    await pgM2.waitForTimeout(1000);
  }
  const btnTransf = pgM2.getByRole("button", { name: "Transferir" }).first();
  if (await btnTransf.count()) {
    await btnTransf.click();
    await pgM2.locator(".modal").waitFor({ timeout: 5000 });
    const selDest = pgM2.locator(".modal select");
    const ops = await selDest.locator("option").allTextContents();
    const idx = ops.findIndex((o) => o.includes("Heroína Um"));
    t("destino da transferência listado", idx > 0, ops.join(" | "));
    await selDest.selectOption({ index: idx });
    await pgM2.locator(".modal").getByRole("button", { name: "Confirmar" }).click();
    await pgM2.waitForTimeout(1500);
    // volta ao nível da lista antes de abrir outro personagem
    const voltar = pgM2.getByRole("button", { name: "Voltar" }).last();
    if (await voltar.count()) await voltar.click();
    await pgM2.waitForTimeout(600);
    // confirma o item no inventário da Heroína
    await abrirPersonagem(pgM2, "Heroína Um");
    await abaPatrimonio(pgM2, "Inventário");
    await pgM2.waitForTimeout(800);
    t("item transferido visível no destino", await pgM2.getByText("Corda 10m").first().isVisible().catch(() => false));
    await shot(pgM2, "03-transferencia");
  } else t("botão Transferir visível no inventário", false);
  await ctxM2.close();

  sec("4. Mestre vê o mesmo saldo (estado autoritativo compartilhado)");
  const ctxM = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgM = await ctxM.newPage();
  await login(pgM, "mestre_teste", "senha-forte-123");
  await irCampanha(pgM);
  await abrirPersonagem(pgM, "Heroína Um");
  await abaPatrimonio(pgM, "Dinheiro");
  await pgM.waitForTimeout(800);
  const saldoM = await saldoTag(pgM);
  t("mestre vê saldo 120 idêntico", /120/.test(saldoM ?? ""), saldoM?.trim());
  const histM = (await pgM.locator(".tabela-responsiva tbody tr").allTextContents()).join(" ");
  t("mestre vê o mesmo histórico", histM.includes("Compra de suprimentos"));
  await shot(pgM, "04-mestre-mesmo-saldo");

  sec("5. Mobile 390px — patrimônio");
  const ctxMob = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pgMob = await ctxMob.newPage();
  await login(pgMob, "jogador_um", "senha-jogador-123");
  await irCampanha(pgMob);
  await abrirPersonagem(pgMob, "Heroína Um");
  await abaPatrimonio(pgMob, "Dinheiro");
  const saldoMob = await saldoTag(pgMob);
  t("mobile mostra mesmo saldo", /120/.test(saldoMob ?? ""), saldoMob?.trim());
  await shot(pgMob, "05-mobile-dinheiro");
  await ctxMob.close();

  // ===== 6. Restaurar referência do Acervo (Issue #119) =====
  sec("6. Catálogo — override econômico e restaurar referência do Acervo");
  // Elemento do Acervo com referência econômica, inserido como as
  // regras reais fazem (rule_definitions do rule_set ativo).
  const rsPat = abrirDb(BANCO).prepare("select id from rule_sets where campaign_id=? and is_active=1").get(cenario.campId).id;
  {
    const w = abrirDb(BANCO);
    try {
      w.prepare("insert into rule_definitions (id,rule_set_id,kind,key,name,category,parent_key,definition,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
        .run(crypto.randomUUID(), rsPat, "item", "pistola_ui_teste", "Pistola UI Teste", null, null,
          JSON.stringify({
            descricao: "", prerequisitos: [],
            weight: 0.9, valueCents: 25000,
            economia: { moeda: "BRL", precoReferenciaBRL: 250, faixaPrecoBRL: { min: 200, max: 300 } },
          }), Date.now(), Date.now());
    } finally { w.close(); }
  }
  const ctxCat = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgCat = await ctxCat.newPage();
  await login(pgCat, "mestre_teste", "senha-forte-123");
  await irCampanha(pgCat);
  await abrirPersonagem(pgCat, "Mestre Herói");
  await abaPatrimonio(pgCat, "Catálogo");
  await pgCat.waitForTimeout(800);
  // Cria template vinculado com overrides de peso e preço.
  await pgCat.getByLabel("Vínculo do Acervo").selectOption({ label: "Pistola UI Teste" });
  await pgCat.waitForTimeout(400);
  await pgCat.getByPlaceholder("Peso override (kg)").fill("1.5");
  await pgCat.getByPlaceholder("Preço override (R$)").fill("300");
  await pgCat.getByRole("button", { name: "Adicionar ao catálogo" }).click();
  await pgCat.waitForTimeout(1200);
  const linhaTpl = pgCat.locator("table.tabela tbody tr", { hasText: "Pistola UI Teste" });
  t("template com overrides aparece no catálogo", await linhaTpl.count() === 1);
  // Reabre a edição: overrides persistem nos campos.
  await linhaTpl.getByRole("button", { name: "Editar" }).click();
  await pgCat.waitForTimeout(500);
  const pesoEdit = await pgCat.getByPlaceholder("Peso override (kg)").inputValue();
  const precoEdit = await pgCat.getByPlaceholder("Preço override (R$)").inputValue();
  t("reabrir mostra overrides persistidos (1.5 / 300)", pesoEdit === "1.5" && precoEdit === "300", `${pesoEdit}/${precoEdit}`);
  // Modal de compra sugere o OVERRIDE vigente (R$ 300), não a referência.
  await pgCat.getByRole("button", { name: "Cancelar edição" }).click();
  await pgCat.waitForTimeout(400);
  await abaPatrimonio(pgCat, "Inventário");
  await pgCat.getByRole("button", { name: "Comprar…" }).click();
  await pgCat.locator(".modal").waitFor({ timeout: 8000 });
  const selCat1 = pgCat.locator(".modal select").first();
  const valTpl = await selCat1.locator("option", { hasText: "Pistola UI Teste" }).getAttribute("value");
  await selCat1.selectOption(valTpl);
  await pgCat.waitForTimeout(500);
  const modalTxt1 = await pgCat.locator(".modal").innerText();
  t("modal sugere override vigente R$ 300.00", /Referência do Acervo: R\$ 300\.00/.test(modalTxt1), modalTxt1.slice(0, 200));
  await pgCat.locator(".modal").getByRole("button", { name: /Fechar|Cancelar|×/ }).first().click().catch(async () => {
    await pgCat.keyboard.press("Escape");
  });
  await pgCat.waitForTimeout(400);
  // Restaura a referência do Acervo e salva.
  await abaPatrimonio(pgCat, "Catálogo");
  await pgCat.locator("table.tabela tbody tr", { hasText: "Pistola UI Teste" }).getByRole("button", { name: "Editar" }).click();
  await pgCat.waitForTimeout(500);
  await pgCat.getByRole("button", { name: "Restaurar referência do Acervo" }).click();
  await pgCat.waitForTimeout(300);
  const pesoRest = await pgCat.getByPlaceholder("Peso override (kg)").inputValue();
  const precoRest = await pgCat.getByPlaceholder("Preço override (R$)").inputValue();
  t("restaurar limpa os campos de override", pesoRest === "" && precoRest === "", `${pesoRest}/${precoRest}`);
  const metaRef = await pgCat.locator("span.meta", { hasText: "Ref. Acervo" }).first().innerText().catch(() => "");
  t("referência do Acervo exibida após restaurar", /0\.9|R\$ 250/.test(metaRef), metaRef);
  await pgCat.getByRole("button", { name: "Salvar alterações" }).click();
  await pgCat.waitForTimeout(1200);
  // Prova pela API real: template.data voltou aos valores do Acervo.
  const catApi = await fetch(`${BASE}/api/campaigns/${cenario.campId}/inventario`, { headers: { cookie: cenario.cookieMestre } }).then((r) => r.json());
  const tplUi = (catApi.itens ?? []).find((i) => i.name === "Pistola UI Teste");
  t("API: peso/preço restaurados ao Acervo",
    tplUi?.data?.weight === 0.9 && tplUi?.data?.valueCents === 25000 && tplUi?.data?.economia?.precoReferenciaBRL === 250,
    JSON.stringify({ w: tplUi?.data?.weight, v: tplUi?.data?.valueCents, e: tplUi?.data?.economia?.precoReferenciaBRL }));
  // Modal agora sugere a REFERÊNCIA original (R$ 250).
  await abaPatrimonio(pgCat, "Inventário");
  await pgCat.getByRole("button", { name: "Comprar…" }).click();
  await pgCat.locator(".modal").waitFor({ timeout: 8000 });
  const selCat2 = pgCat.locator(".modal select").first();
  const valTpl2 = await selCat2.locator("option", { hasText: "Pistola UI Teste" }).getAttribute("value");
  await selCat2.selectOption(valTpl2);
  await pgCat.waitForTimeout(500);
  const modalTxt2 = await pgCat.locator(".modal").innerText();
  t("modal sugere referência original R$ 250.00 após restaurar", /Referência do Acervo: R\$ 250\.00/.test(modalTxt2), modalTxt2.slice(0, 200));
  t("sugestão continua sem débito automático (texto informativo)", /apenas sugestão|sem conversão/i.test(modalTxt2));
  await shot(pgCat, "06-catalogo-restaurar-referencia");
  await ctxCat.close();

} catch (e) {
  fail++;
  console.log("  FALHOU exceção:", String(e).slice(0, 500));
} finally {
  if (browser) await browser.close().catch(() => { });
  if (proc) await encerrarServidor(proc).catch(() => { });
  limparDir(DIR);
}
console.log(`\n==== patrimônio: ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
