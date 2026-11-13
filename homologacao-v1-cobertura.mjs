#!/usr/bin/env node
// Cobertura v1.0 — funcionalidades fora do fluxo principal da primeira
// partida, verificadas na interface real (Playwright):
// patrimônio (veículos, financeiro), diário, snapshots, acervo global
// (livro+item), aplicação de livro à campanha e espectador.
// Setup via criarCenario (API); todas as ações abaixo são pela UI.
import { chromium } from "playwright";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("cobertura");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const SHOTS = join(process.cwd(), "_evidencias", "cobertura-v1");
import { mkdirSync } from "node:fs";
mkdirSync(SHOTS, { recursive: true });
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;

const MESTRE = { user: "mestre_teste", senha: "senha-forte-123" };
const J1 = { user: "jogador_um", senha: "senha-jogador-123" };
const CAMPANHA = "Campanha Teste";

let browser, proc, cenario;

async function shot(page, nome) {
  try { await page.screenshot({ path: join(SHOTS, `${nome}.png`) }); } catch { }
}
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
async function apiFetch(page, metodo, path, body) {
  return page.evaluate(async ([m, p, b]) => {
    const r = await fetch("/api" + p, {
      method: m, headers: { "content-type": "application/json" },
      body: b !== undefined ? JSON.stringify(b) : undefined,
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [metodo, path, body]);
}

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  cenario = await criarCenario(BASE, BANCO);

  browser = await chromium.launch();
  const ctxM = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgM = await ctxM.newPage();
  pgM.on("pageerror", (e) => console.log("  [pgM erro]", String(e).slice(0, 160)));

  // ===== 1. LOGIN + CAMPANHA =====
  sec("1. Login e abertura de campanha");
  await login(pgM, MESTRE.user, MESTRE.senha);
  t("mestre logou", true);
  await irCampanha(pgM);
  await pgM.getByRole("heading", { name: CAMPANHA }).waitFor({ timeout: 15000 });
  t("campanha aberta", true);

  // ===== 2. PATRIMÔNIO: veículos =====
  sec("2. Patrimônio — veículo");
  await aba(pgM, "Personagens");
  await pgM.locator("tr.clicavel", { hasText: "Mestre Herói" }).first().click();
  await pgM.getByRole("button", { name: "Veículos" }).click();
  await pgM.getByLabel("Nome", { exact: true }).first().fill("Opala Diplomata");
  await pgM.getByRole("button", { name: "Adicionar veículo" }).click();
  await pgM.getByText("Opala Diplomata").first().waitFor({ timeout: 10000 });
  t("veículo adicionado", true);

  // ===== 3. PATRIMÔNIO: financeiro =====
  sec("3. Patrimônio — conta e movimentação");
  await pgM.getByRole("button", { name: "Dinheiro" }).click();
  await pgM.getByRole("button", { name: "Nova conta" }).click();
  await pgM.getByPlaceholder("Nome (ex.: Carteira, Banco X)").fill("Carteira");
  await pgM.locator("form.formulario", { has: pgM.getByPlaceholder("Nome (ex.: Carteira, Banco X)") })
    .getByRole("button", { name: "Criar" }).click();
  await pgM.waitForTimeout(1200);
  // movimentação
  const formMov = pgM.locator("form.formulario", { has: pgM.getByRole("button", { name: "Registrar" }) });
  await formMov.locator("select").first().selectOption({ label: "Carteira" });
  await formMov.locator("input[placeholder='Valor']").fill("50");
  await formMov.locator("input[placeholder='Descrição']").fill("Bônus da sessão");
  await formMov.getByRole("button", { name: "Registrar" }).click();
  await pgM.getByText("Bônus da sessão").first().waitFor({ timeout: 10000 });
  t("conta criada + movimentação registrada", true);
  await shot(pgM, "03-dinheiro");

  // ===== 4. DIÁRIO =====
  sec("4. Diário da campanha");
  await pgM.getByRole("button", { name: "Voltar" }).last().click(); // sai do detalhe do personagem
  await pgM.locator("tr.clicavel").first().waitFor({ timeout: 15000 });
  await aba(pgM, "Diário");
  await pgM.getByRole("button", { name: "Nova anotação" }).click();
  await pgM.getByPlaceholder("Título").fill("Sessão 1 — o encontro");
  await pgM.getByPlaceholder("Conteúdo").fill("O grupo encontrou o informante no cais.");
  await pgM.getByRole("button", { name: "Salvar" }).click();
  await pgM.getByText("Sessão 1 — o encontro").first().waitFor({ timeout: 10000 });
  t("anotação de diário criada", true);
  await shot(pgM, "04-diario");

  // ===== 5. SNAPSHOT =====
  sec("5. Histórico — ponto de recuperação");
  await aba(pgM, "Histórico");
  await pgM.getByPlaceholder("Nome do ponto de recuperação (opcional)").fill("Antes da sessão 2");
  await pgM.getByRole("button", { name: "Criar ponto de recuperação" }).click();
  await pgM.getByText("Antes da sessão 2").first().waitFor({ timeout: 15000 });
  t("snapshot criado e listado", true);
  await shot(pgM, "05-snapshot");

  // ===== 6. ACERVO GLOBAL: livro + item =====
  sec("6. Acervo global — livro e item");
  await pgM.getByRole("button", { name: "Acervo", exact: true }).first().click();
  await pgM.getByRole("button", { name: "+ Novo livro" }).click();
  await pgM.getByLabel("Título").fill("Regras do Abismo");
  await pgM.locator(".modal").getByRole("button", { name: "Salvar" }).click();
  await pgM.getByText("Regras do Abismo").first().waitFor({ timeout: 10000 });
  t("livro criado no acervo", true);
  await pgM.getByRole("button", { name: "Abrir" }).first().click();
  await pgM.getByRole("button", { name: "+ Item" }).click();
  await pgM.getByLabel(/Tipo \(kind\)/).fill("atributo");
  await pgM.getByLabel(/Chave \(key\)/).fill("forca");
  await pgM.getByLabel("Nome", { exact: true }).fill("Força");
  await pgM.locator(".modal").getByRole("button", { name: "Salvar" }).click();
  await pgM.getByText("Força").first().waitFor({ timeout: 10000 });
  t("item adicionado ao livro", true);
  await shot(pgM, "06-acervo");

  // ===== 7. APLICAR LIVRO À CAMPANHA =====
  sec("7. Regras — aplicar livro do acervo à campanha");
  await irCampanha(pgM);
  await aba(pgM, "Regras");
  await pgM.locator(".abas button, div button", { hasText: "Acervo" }).last().click();
  await pgM.getByRole("button", { name: /Pré-visualizar/ }).first().click();
  await pgM.getByRole("button", { name: "Confirmar sincronização" }).click();
  await pgM.getByText(/Sincronização concluída|Aplicado v/).first().waitFor({ timeout: 15000 });
  t("livro aplicado à campanha", true);
  await shot(pgM, "07-aplicar-livro");

  // ===== 8. ESPECTADOR =====
  sec("8. Espectador — acesso de leitura");
  await apiFetch(pgM, "PATCH", `/campaigns/${cenario.campId}/members/${cenario.jogadores.jogador1.membershipId}`, { role: "espectador" });
  const ctxE = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgE = await ctxE.newPage();
  await login(pgE, J1.user, J1.senha);
  await irCampanha(pgE);
  await pgE.getByRole("heading", { name: CAMPANHA }).waitFor({ timeout: 15000 });
  t("espectador abre a campanha", true);
  // Personagens exige papel mestre/jogador (403 para espectador por design);
  // o acesso do espectador é a mesa/sessão em modo leitura.
  await aba(pgE, "Mesa");
  await pgE.waitForTimeout(2000);
  const txtMesa = await pgE.locator("main").innerText();
  t("espectador acessa a aba Mesa", /sess|mesa|Nenhuma/i.test(txtMesa), txtMesa.slice(0, 200));
  const erro403 = await pgE.getByText("Sem permissão").count();
  t("sem erro de permissão na mesa", erro403 === 0);
  await shot(pgE, "08-espectador");

} catch (e) {
  fail++;
  console.log("  FALHOU exceção:", String(e).slice(0, 400));
  try { await shot(pgM, "99-erro"); } catch { }
} finally {
  if (browser) await browser.close().catch(() => { });
  if (proc) await encerrarServidor(proc).catch(() => { });
  limparDir(DIR);
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
