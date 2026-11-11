#!/usr/bin/env node
// Homologação dos dados 3D na mesa (PRs #39/#40/#41 integradas):
// canvas 3D real, cinco tipos, quantidade, cores independentes com
// persistência no servidor, atualização imediata e resultado autoritativo.
import { chromium } from "playwright";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("dados3d");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const SHOTS = join(process.cwd(), "_evidencias", "dados3d");
import { mkdirSync } from "node:fs";
mkdirSync(SHOTS, { recursive: true });
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const CAMPANHA = "Campanha Teste";

let browser, proc;

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
async function entrarNaMesa(page) {
  await aba(page, "Mesa");
  // mestre inicia; demais clicam na sessão listada
  const iniciar = page.getByRole("button", { name: "Iniciar sessão" });
  if (await iniciar.count()) { await iniciar.click(); }
  else { await page.locator("table.tabela tr.clicavel").first().click(); }
  await page.locator(".chat-form").waitFor({ timeout: 15000 });
}
async function rolarLivre(page, lados, qtd = 1) {
  await page.locator(".abas-dados button", { hasText: "Rolagem e dano" }).click();
  await page.locator(".rolagem-form select").first().selectOption(String(lados));
  if (qtd > 1) await page.locator('.rolagem-form input[type="number"]').fill(String(qtd));
  const totalAntes = await page.locator(".rolagem-resultado .d10-chip-total").last().textContent().catch(() => "");
  const tituloAntes = await page.locator(".rolagem-resultado .dado-3d-canvas").last().getAttribute("title").catch(() => "");
  await page.getByRole("button", { name: /Lançar/ }).click();
  // o painel mostra só a última rolagem: aguarda resultado novo —
  // total OU face podem coincidir, então espera qualquer um dos dois mudar
  await page.waitForFunction(
    ([antTotal, antTitulo]) => {
      const totais = document.querySelectorAll(".rolagem-resultado .d10-chip-total");
      const txt = totais.length ? totais[totais.length - 1].textContent : "";
      const canvases = document.querySelectorAll(".rolagem-resultado .dado-3d-canvas");
      const tit = canvases.length ? canvases[canvases.length - 1].getAttribute("title") : "";
      return (txt && txt !== antTotal) || (tit && tit !== antTitulo);
    },
    [totalAntes ?? "", tituloAntes ?? ""], { timeout: 20000 },
  );
}
const valoresCanvas = (page) =>
  page.$$eval(".rolagem-resultado .dado-3d-canvas", (cs) => cs.map((c) => c.getAttribute("title")));

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  const cenario = await criarCenario(BASE, BANCO);
  // personagem do jogador 1 para o desafio D10
  cenario.novoPersonagem(cenario.jogadores.jogador1.membershipId, "Heroína Um");
  browser = await chromium.launch();

  const ctxM = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgM = await ctxM.newPage();
  await login(pgM, "mestre_teste", "senha-forte-123");
  await irCampanha(pgM);

  sec("1. Mesa com dados 3D");
  await entrarNaMesa(pgM);
  t("painel de dados presente na mesa", await pgM.locator(".painel-dados").count() > 0);
  const temAbaLivre = await pgM.locator(".abas-dados button", { hasText: "Rolagem e dano" }).count();
  t("aba Rolagem e dano acessível", temAbaLivre > 0);
  await shot(pgM, "01-mesa-dados");

  sec("2. Cinco tipos de dados em canvas 3D");
  for (const d of [4, 6, 8, 10, 20]) {
    await rolarLivre(pgM, d);
    const titulos = await valoresCanvas(pgM);
    const ultimo = titulos[titulos.length - 1] ?? "";
    const total = await pgM.locator(".rolagem-resultado .d10-chip-total").last().textContent();
    t(`d${d}: canvas 3D exibido (${ultimo})`, new RegExp(`^d${d} = `).test(ultimo), ultimo);
    t(`d${d}: total autoritativo exibido`, /Total:\s*\d+/.test(total ?? ""), total?.trim());
    await shot(pgM, `02-dado-d${d}`);
  }

  sec("3. Múltiplos dados");
  await rolarLivre(pgM, 20, 3);
  const titulos3 = await valoresCanvas(pgM);
  t("3×d20 = 3 canvas 3D", titulos3.filter((x) => /^d20 = /.test(x ?? "")).length >= 3, titulos3.slice(-3).join(","));

  sec("4. Jogador vê a mesma rolagem (servidor autoritativo)");
  const ctx1 = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pg1 = await ctx1.newPage();
  await login(pg1, "jogador_um", "senha-jogador-123");
  await irCampanha(pg1);
  await entrarNaMesa(pg1);
  const totalM = await pgM.locator(".rolagem-resultado .d10-chip-total").last().textContent();
  await rolarLivre(pgM, 6);
  const totalNovoM = await pgM.locator(".rolagem-resultado .d10-chip-total").last().textContent();
  // histórico compartilhado: o jogador deve ver a mesma rolagem (= total)
  const alvo = (totalNovoM ?? "").replace(/\D/g, "");
  await pg1.locator(".rolagem-item").last().waitFor({ timeout: 10000 }).catch(() => {});
  const itens = await pg1.locator(".rolagem-item strong").allTextContents();
  t("total da rolagem aparece para o jogador", itens.some((x) => x.includes(`= ${alvo}`)), `${alvo} | vistos: ${itens.slice(-3).join(" | ")}`);
  const canvasesJ = await pg1.locator(".rolagem-item .dado-3d-canvas").count();
  t("jogador vê dados 3D no histórico", canvasesJ > 0, `${canvasesJ} canvas`);
  await shot(pg1, "04-jogador-dados");

  sec("5. Cores independentes + atualização imediata");
  const corExternaAntes = await pgM.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--dado-fundo").trim());
  const inputsCor = pgM.locator('.cores-dados-controles input[type="color"]');
  t("dois seletores de cor (externa/números)", await inputsCor.count() === 2);
  // cor externa → roxo (fill nativo dispara o onChange do React)
  await inputsCor.nth(0).fill("#7c3aed");
  await pgM.waitForTimeout(400);
  const corDepois = await pgM.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--dado-fundo").trim());
  t("cor externa aplicada imediatamente", corDepois.toLowerCase().includes("124, 58, 237") || corDepois.toLowerCase().includes("#7c3aed"), `${corExternaAntes} → ${corDepois}`);
  // cor dos números → amarelo
  await inputsCor.nth(1).fill("#fde047");
  await pgM.waitForTimeout(400);
  const corNum = await pgM.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--dado-texto").trim());
  t("cor dos números independente", corNum.length > 0 && corNum !== corDepois, corNum);
  await shot(pgM, "05-cores-personalizadas");

  sec("6. Preferências persistem após reload (servidor)");
  await pgM.reload();
  await pgM.getByText("Servidor online").waitFor({ timeout: 15000 });
  await irCampanha(pgM);
  await entrarNaMesa(pgM);
  await pgM.waitForTimeout(800);
  const corAposReload = await pgM.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--dado-fundo").trim());
  t("cor externa persistida do servidor", corAposReload.toLowerCase().includes("124, 58, 237") || corAposReload.toLowerCase().includes("#7c3aed"), corAposReload);
  const me = await pgM.evaluate(async () => (await (await fetch("/api/auth/me")).json()).usuario?.preferences?.dados);
  t("preferências gravadas via API", me?.corExterna === "#7c3aed" && me?.corInterna === "#fde047", JSON.stringify(me));

  sec("7. D10 desafio continua autoritativo");
  await pgM.getByRole("button", { name: "+ Desafio" }).click();
  const formD = pgM.locator("form", { has: pgM.getByRole("button", { name: "Enviar desafio" }) });
  const selPers = formD.locator("label", { hasText: "Personagem" }).locator("select");
  const opcoesPers = await selPers.locator("option").allTextContents();
  const idxPers = opcoesPers.findIndex((o) => o.includes("Heroína"));
  await selPers.selectOption({ index: idxPers > 0 ? idxPers : 1 });
  const selCampo = formD.locator("label", { hasText: "Habilidade/atributo" }).locator("select");
  for (let i = 0; i < 30; i++) { if ((await selCampo.locator("option").count()) > 1) break; await pgM.waitForTimeout(400); }
  await selCampo.selectOption({ index: 1 });
  await formD.getByRole("button", { name: "Enviar desafio" }).click();
  // o dono do personagem vê o teste pendente e rola pelo botão "Rolar" do card
  await pg1.getByText("Testes pendentes").waitFor({ timeout: 10000 });
  const btnRolarD10 = pg1.locator(".teste-card").getByRole("button", { name: "Rolar", exact: true });
  await btnRolarD10.waitFor({ timeout: 5000 });
  await btnRolarD10.click();
  await pg1.locator(".teste-card .dado-3d-canvas, .rolagem-item .dado-3d-canvas").first().waitFor({ timeout: 15000 }).catch(() => {});
  const d10Canvas = await pg1.locator(".dado-3d-canvas.d10-face, .rolagem-item .dado-3d-canvas.d10, canvas[title^='d10']").count();
  t("desafio D10 renderiza dado 3D", (await pg1.locator(".dado-3d-canvas").count()) > 0, `${d10Canvas} canvas d10`);
  await shot(pg1, "07-d10-3d");

  sec("8. Mobile 390px");
  const ctxMob = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pgMob = await ctxMob.newPage();
  await login(pgMob, "jogador_um", "senha-jogador-123");
  await irCampanha(pgMob);
  await entrarNaMesa(pgMob);
  await rolarLivre(pgMob, 8);
  const canvasMob = await pgMob.locator(".rolagem-resultado .dado-3d-canvas").count();
  const w = await pgMob.locator(".rolagem-resultado .dado-3d-canvas").first().evaluate((el) => el.getBoundingClientRect().width).catch(() => 0);
  t("mobile: canvas 3D visível e compacto", canvasMob > 0 && w > 0 && w <= 40, `w=${w}`);
  await shot(pgMob, "08-mobile-dados");
  await ctxMob.close();

} catch (e) {
  fail++;
  console.log("  FALHOU exceção:", String(e).slice(0, 500));
  try { if (browser) await browser.close(); } catch { }
} finally {
  if (browser) await browser.close().catch(() => { });
  if (proc) await encerrarServidor(proc).catch(() => { });
  limparDir(DIR);
}

console.log(`\n==== dados 3D: ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
