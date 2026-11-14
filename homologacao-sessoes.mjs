#!/usr/bin/env node
// Homologação E2E — gestão de sessões em Conta.tsx: listagem com badge
// "esta sessão", identificação de dispositivo/IP/datas e revogação
// individual com confirmação. Banco descartável + Chromium real.
import { chromium } from "playwright";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, sessao, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("sessoes-e2e");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const SHOTS = join(process.cwd(), "_evidencias", "sessoes");
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

  const cenario = await criarCenario(BASE, BANCO, { campanha: "Campanha Sessões UI", jogadores: { a: "jogadora_s" } });
  console.log("seed ok");

  browser = await chromium.launch();
  const erros = [];

  sec("Conta lista sessões ativas");
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => erros.push(String(e)));
  page.on("dialog", (d) => void d.accept()); // confirma revogações
  await login(page, "jogadora_s", "senha-jogador-123");

  // segunda sessão da mesma conta direto no banco (simula outro dispositivo)
  sessao(BANCO, cenario.jogadores.a.id);

  await btnNav(page, "Conta").click();
  await page.getByRole("heading", { name: "Sessões ativas" }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(800);
  t("seção de sessões visível", await page.getByRole("heading", { name: "Sessões ativas" }).isVisible());
  t("badge desta sessão", await page.locator(".cartao", { hasText: "Sessões ativas" }).getByText("esta sessão").first().isVisible());
  // cenário + login UI + sessão extra = ao menos 2 sessões visíveis
  t("múltiplas sessões listadas", await page.locator(".cartao", { hasText: "Sessões ativas" }).locator("tbody tr").count() >= 2);
  t("IP exibido", await page.locator(".cartao", { hasText: "Sessões ativas" }).getByText("127.0.0.1").first().isVisible());
  await shot(page, "conta-sessoes");

  sec("Revogação individual com confirmação");
  const secao = page.locator(".cartao", { hasText: "Sessões ativas" });
  const linhas = secao.locator("tbody tr");
  const totalAntes = await linhas.count();
  // clica em Encerrar na linha que NÃO é a sessão atual
  const linhaAlvo = linhas.filter({ hasNotText: "esta sessão" }).first();
  await linhaAlvo.getByRole("button", { name: "Encerrar" }).click();
  await page.waitForTimeout(1000);
  const totalDepois = await secao.locator("tbody tr").count();
  t("sessão revogada some da lista", totalDepois === totalAntes - 1, `${totalAntes}→${totalDepois}`);
  t("sessão atual permanece", await secao.getByText("esta sessão").first().isVisible());
  await shot(page, "conta-sessoes-apos-revogacao");

  sec("Mobile — cartões substituem a tabela");
  const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pgM = await ctxM.newPage();
  pgM.on("dialog", (d) => void d.accept());
  await login(pgM, "jogadora_s", "senha-jogador-123");
  await btnNav(pgM, "Conta").click();
  await pgM.getByRole("heading", { name: "Sessões ativas" }).waitFor({ timeout: 10000 });
  await pgM.waitForTimeout(800);
  const secaoM = pgM.locator(".cartao", { hasText: "Sessões ativas" });
  t("tabela oculta no mobile", !(await secaoM.locator("table.tabela-responsiva").isVisible()));
  t("cartões de sessão visíveis", await secaoM.locator(".registro-cartao").first().isVisible());
  t("badge no cartão", await secaoM.locator(".registro-cartao").getByText("esta sessão").first().isVisible());
  t("ação Encerrar no cartão", await secaoM.getByRole("button", { name: "Encerrar" }).first().isVisible());
  await shot(pgM, "conta-sessoes-mobile");
  await ctxM.close();

  sec("Sem erros de página");
  t("sem erros de página", erros.length === 0, erros.join(" | "));
} finally {
  await browser?.close();
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
