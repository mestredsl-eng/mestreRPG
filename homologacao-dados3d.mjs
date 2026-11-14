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
  const tituloAntes = await page.locator(".rolagem-resultado .mesa-dados-3d-canvas").last().getAttribute("aria-label").catch(() => "");
  await page.getByRole("button", { name: /Lançar/ }).click();
  // o painel mostra só a última rolagem: aguarda resultado novo —
  // total OU face podem coincidir, então espera qualquer um dos dois mudar
  await page.waitForFunction(
    ([antTotal, antTitulo]) => {
      const totais = document.querySelectorAll(".rolagem-resultado .d10-chip-total");
      const txt = totais.length ? totais[totais.length - 1].textContent : "";
      const canvases = document.querySelectorAll(".rolagem-resultado .mesa-dados-3d-canvas");
      const tit = canvases.length ? canvases[canvases.length - 1].getAttribute("aria-label") : "";
      return (txt && txt !== antTotal) || (tit && tit !== antTitulo);
    },
    [totalAntes ?? "", tituloAntes ?? ""], { timeout: 20000 },
  );
}
const valoresCanvas = (page) =>
  page.$$eval(".rolagem-resultado .mesa-dados-3d-canvas", (cs) => cs.map((c) => c.getAttribute("aria-label")));
const canvasPintado = (page) => page.evaluate(() => {
  const c = document.querySelector(".rolagem-resultado .mesa-dados-3d-canvas");
  if (!c) return false;
  const ctx = c.getContext("2d");
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 400) if (d[i] > 0) return true;
  return false;
});

// Conta pixels reais do canvas próximos à cor RGB esperada. Isso verifica
// o desenho (borda das faces), não apenas o aria-label ou classes React.
const pixelsNaCor = (locator, rgb) => locator.evaluate((canvas, alvo) => {
  const ctx = canvas.getContext("2d");
  if (!ctx) return 0;
  const dados = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let total = 0;
  for (let i = 0; i < dados.length; i += 4) {
    if (dados[i + 3] < 220) continue;
    if (Math.abs(dados[i] - alvo[0]) <= 14
      && Math.abs(dados[i + 1] - alvo[1]) <= 14
      && Math.abs(dados[i + 2] - alvo[2]) <= 14) total++;
  }
  return total;
}, rgb);

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

  // O segundo participante entra ANTES dos pools D10. Assim, a suíte
  // valida o evento/histórico recebido em tempo real, não uma leitura
  // tardia que só acontece depois de o resultado já existir.
  const ctx1 = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pg1 = await ctx1.newPage();
  await login(pg1, "jogador_um", "senha-jogador-123");
  await irCampanha(pg1);
  await entrarNaMesa(pg1);
  await pg1.locator(".painel-dados").waitFor({ timeout: 15000 });
  const temAbaLivre = await pgM.locator(".abas-dados button", { hasText: "Rolagem e dano" }).count();
  t("aba Rolagem e dano acessível", temAbaLivre > 0);

  sec("1b. Pool D10 também usa uma única mesa compartilhada");
  const controlesD10 = pgM.locator(".d10-controles input[type=number]");
  await controlesD10.nth(0).fill("5");
  await controlesD10.nth(1).fill("2");
  await pgM.getByRole("button", { name: "Lançar D10" }).click();
  const canvasD10Pool = pgM.locator(".d10-resultado .mesa-dados-3d-canvas");
  await canvasD10Pool.waitFor({ timeout: 15000 });
  const rotuloD10Pool = await canvasD10Pool.getAttribute("aria-label");
  const valoresD10Pool = rotuloD10Pool?.match(/d10=\d+/g) ?? [];
  const estadosD10Pool = rotuloD10Pool?.match(/\((sucesso|falha)\)/g) ?? [];
  t("pool D10 de 5 positivos e 2 negativos gera 3 dados efetivos", valoresD10Pool.length === 3, rotuloD10Pool);
  t("pool D10 inteiro aparece em um único canvas compartilhado",
    await pgM.locator(".d10-resultado .mesa-dados-3d-canvas").count() === 1);
  t("cada D10 mantém indicação individual de sucesso/falha", estadosD10Pool.length === 3, rotuloD10Pool);

  // A mesma classificação deve chegar aos outros participantes pelo
  // evento autoritativo mesa:rolagem e aparecer no histórico compartilhado.
  const canvasD10Historico = pgM.locator(".rolagem-item .mesa-dados-3d-canvas").last();
  await canvasD10Historico.waitFor({ timeout: 15000 });
  const rotuloD10Historico = await canvasD10Historico.getAttribute("aria-label");
  const valoresD10Historico = rotuloD10Historico?.match(/d10=\d+/g) ?? [];
  const estadosD10Historico = rotuloD10Historico?.match(/\((sucesso|falha)\)/g) ?? [];
  const sucessosVisuais = (rotuloD10Historico?.match(/\(sucesso\)/g) ?? []).length;
  const falhasVisuais = (rotuloD10Historico?.match(/\(falha\)/g) ?? []).length;
  const resumoD10Historico = await pgM.locator(".rolagem-item .d10-rolagem").last().innerText();
  const sucessosServidor = Number(resumoD10Historico.match(/(\d+) sucesso/)?.[1] ?? NaN);
  const falhasServidor = Number(resumoD10Historico.match(/\/\s*(\d+) falha/)?.[1] ?? NaN);
  t("histórico compartilhado mostra os três D10 do pool", valoresD10Historico.length === 3, rotuloD10Historico);
  t("histórico compartilhado preserva sucesso/falha individual", estadosD10Historico.length === 3, rotuloD10Historico);
  t("cores individuais coincidem com a contagem autoritativa do servidor",
    sucessosVisuais === sucessosServidor && falhasVisuais === falhasServidor,
    `visuais=${sucessosVisuais}/${falhasVisuais}; servidor=${sucessosServidor}/${falhasServidor}`);
  await shot(pgM, "01b-pool-d10-mesa-compartilhada");

  sec("1c. Mínimo autoritativo do servidor na classificação visual");
  // Muda a regra da campanha com a Mesa aberta: o painel local NÃO
  // recarrega regras — só o ACK do servidor pode trazer o mínimo novo.
  // Painel e histórico devem classificar cada dado de forma idêntica.
  const MIN_D10 = 9;
  const cfgMin = await pgM.evaluate(async ({ cid, min }) => {
    const put = await fetch(`/api/campaigns/${cid}/regras/config`, {
      method: "PUT", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dados: { d10SucessoMinimo: min } }),
    });
    const get = await fetch(`/api/campaigns/${cid}/regras`, { credentials: "same-origin" });
    const regras = get.ok ? await get.json() : null;
    return { putStatus: put.status, minLido: regras?.config?.dados?.d10SucessoMinimo };
  }, { cid: cenario.campId, min: MIN_D10 });
  t("PUT /regras/config aceito (HTTP 200)", cfgMin.putStatus === 200, `status=${cfgMin.putStatus}`);
  t(`regra persistida: d10SucessoMinimo=${MIN_D10} confirmado por leitura`,
    cfgMin.minLido === MIN_D10, `lido=${cfgMin.minLido}`);
  const ctrlD10b = pgM.locator(".d10-controles input[type=number]");
  await ctrlD10b.nth(0).fill("8");
  await ctrlD10b.nth(1).fill("0");
  await pgM.locator("form.d10-form").getByRole("button", { name: /Lançar/ }).click();
  await pgM.waitForFunction(() => {
    const c = document.querySelector(".d10-resultado .mesa-dados-3d-canvas");
    const rotulo = c?.getAttribute("aria-label") ?? "";
    return (rotulo.match(/d10=\d+/g) ?? []).length === 8;
  }, null, { timeout: 15000 });
  const rotuloPainelMin = await pgM.locator(".d10-resultado .mesa-dados-3d-canvas").getAttribute("aria-label");
  // espera o histórico receber ESTA rolagem (8 dados), não a anterior.
  // Mesa.tsx usa rolagens.slice(-8).reverse(): a mais nova é a PRIMEIRA.
  await pgM.waitForFunction(() => {
    const c = document.querySelector(".rolagem-item .mesa-dados-3d-canvas");
    const rotulo = c?.getAttribute("aria-label") ?? "";
    return (rotulo.match(/d10=\d+/g) ?? []).length === 8;
  }, null, { timeout: 15000 });
  const rotuloHistMin = await pgM.locator(".rolagem-item .mesa-dados-3d-canvas").first().getAttribute("aria-label");
  const resumoHistMin = await pgM.locator(".rolagem-item .d10-rolagem").first().innerText();
  const facesDe = (rotulo) =>
    [...(rotulo ?? "").matchAll(/d10=(\d+) \((sucesso|falha)\)/g)]
      .map((m) => ({ valor: Number(m[1]), estado: m[2] }));
  const facesPainel = facesDe(rotuloPainelMin);
  const facesHist = facesDe(rotuloHistMin);
  const classificarOk = (faces) =>
    faces.length === 8 && faces.every((f) =>
      f.estado === (f.valor >= MIN_D10 ? "sucesso" : "falha"));
  t("pool D10 com regra alterada: painel classifica os 8 dados",
    facesPainel.length === 8, rotuloPainelMin);
  t("painel: cada face sucesso sse valor >= 9, falha sse valor < 9",
    classificarOk(facesPainel), rotuloPainelMin);
  t("histórico: cada face sucesso sse valor >= 9, falha sse valor < 9",
    classificarOk(facesHist), rotuloHistMin);
  t("histórico registra o mínimo autoritativo 9",
    /mín\s*9\b/.test(resumoHistMin ?? ""), resumoHistMin);
  t("painel e histórico classificam cada dado de forma idêntica",
    facesPainel.length === facesHist.length &&
      facesPainel.every((f, i) => f.valor === facesHist[i].valor && f.estado === facesHist[i].estado),
    `painel=${rotuloPainelMin} historico=${rotuloHistMin}`);

  // O jogador já estava conectado antes da rolagem. Verifica o evento
  // compartilhado, o mínimo autoritativo e a classificação individual.
  await pg1.waitForFunction(() => {
    const item = document.querySelector(".rolagem-item");
    const canvas = item?.querySelector(".mesa-dados-3d-canvas");
    const rotulo = canvas?.getAttribute("aria-label") ?? "";
    const resumo = item?.querySelector(".d10-rolagem")?.textContent ?? "";
    return (rotulo.match(/d10=\\d+/g) ?? []).length === 8 && /mín\\s*9\\b/.test(resumo);
  }, null, { timeout: 15000 });
  const rotuloHistJogador = await pg1.locator(".rolagem-item .mesa-dados-3d-canvas").first().getAttribute("aria-label");
  const resumoHistJogador = await pg1.locator(".rolagem-item .d10-rolagem").first().innerText();
  const facesJogador = facesDe(rotuloHistJogador);
  t("outro participante recebe os 8 D10 sem recarregar",
    facesJogador.length === 8, rotuloHistJogador);
  t("outro participante recebe a regra autoritativa mín 9",
    /mín\\s*9\\b/.test(resumoHistJogador), resumoHistJogador);
  t("outro participante vê a mesma classificação individual do mestre",
    facesJogador.length === facesPainel.length &&
      facesJogador.every((f, i) => f.valor === facesPainel[i].valor && f.estado === facesPainel[i].estado),
    `mestre=${rotuloPainelMin} jogador=${rotuloHistJogador}`);

  sec("1d. Cores de sucesso/falha verificadas nos pixels do canvas");
  // Para obter as duas classes visuais no mesmo pool, usa uma dificuldade
  // equilibrada e repete somente se os valores aleatórios vierem todos
  // do mesmo lado. O servidor continua sorteando e classificando.
  const MINIMO_CORES = 5;
  const cfgCores = await pgM.evaluate(async ({ cid, min }) => {
    const put = await fetch(`/api/campaigns/${cid}/regras/config`, {
      method: "PUT", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dados: { d10SucessoMinimo: min } }),
    });
    const get = await fetch(`/api/campaigns/${cid}/regras`, { credentials: "same-origin" });
    const regras = get.ok ? await get.json() : null;
    return { putStatus: put.status, minLido: regras?.config?.dados?.d10SucessoMinimo };
  }, { cid: cenario.campId, min: MINIMO_CORES });
  t("mínimo de cores persistido e relido", cfgCores.putStatus === 200 && cfgCores.minLido === MINIMO_CORES,
    JSON.stringify(cfgCores));

  let rotuloCores = "";
  let facesCores = [];
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    const anterior = await pgM.locator(".d10-resultado .mesa-dados-3d-canvas").getAttribute("aria-label").catch(() => "");
    const ctrlCores = pgM.locator(".d10-controles input[type=number]");
    await ctrlCores.nth(0).fill("20");
    await ctrlCores.nth(1).fill("0");
    await pgM.locator("form.d10-form").getByRole("button", { name: /Lançar/ }).click();
    await pgM.waitForFunction(({ anterior }) => {
      const rotulo = document.querySelector(".d10-resultado .mesa-dados-3d-canvas")?.getAttribute("aria-label") ?? "";
      return rotulo !== anterior && (rotulo.match(/d10=\\d+/g) ?? []).length === 20;
    }, { anterior }, { timeout: 20000 });
    rotuloCores = await pgM.locator(".d10-resultado .mesa-dados-3d-canvas").getAttribute("aria-label") ?? "";
    facesCores = facesDe(rotuloCores);
    if (facesCores.some((f) => f.estado === "sucesso") && facesCores.some((f) => f.estado === "falha")) break;
  }
  const poolMisto = facesCores.some((f) => f.estado === "sucesso") && facesCores.some((f) => f.estado === "falha");
  t("pool de cores contém D10 de sucesso e de falha", poolMisto, rotuloCores);

  if (poolMisto) {
    await pg1.waitForFunction(() => {
      const item = document.querySelector(".rolagem-item");
      const rotulo = item?.querySelector(".mesa-dados-3d-canvas")?.getAttribute("aria-label") ?? "";
      const resumo = item?.querySelector(".d10-rolagem")?.textContent ?? "";
      const dados = item?.querySelector(".mesa-dados-3d-canvas")?.getContext("2d");
      if (!dados) return false;
      const pixels = dados.getImageData(0, 0, dados.canvas.width, dados.canvas.height).data;
      let verde = 0, vermelho = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] < 220) continue;
        if (Math.abs(pixels[i] - 46) <= 14 && Math.abs(pixels[i + 1] - 143) <= 14 && Math.abs(pixels[i + 2] - 91) <= 14) verde++;
        if (Math.abs(pixels[i] - 138) <= 14 && Math.abs(pixels[i + 1] - 58) <= 14 && Math.abs(pixels[i + 2] - 58) <= 14) vermelho++;
      }
      return (rotulo.match(/d10=\\d+/g) ?? []).length === 20
        && /mín\\s*5\\b/.test(resumo) && verde > 0 && vermelho > 0;
    }, null, { timeout: 20000 });
    const resumoJogadorCores = await pg1.locator(".rolagem-item .d10-rolagem").first().innerText();
    const facesJogadorCores = facesDe(await pg1.locator(".rolagem-item .mesa-dados-3d-canvas").first().getAttribute("aria-label"));
    t("outro participante recebe o pool misto com mínimo 5",
      facesJogadorCores.length === 20 && /mín\\s*5\\b/.test(resumoJogadorCores)
        && facesJogadorCores.every((f, i) => f.valor === facesCores[i].valor && f.estado === facesCores[i].estado),
      resumoJogadorCores);

    await pgM.waitForFunction(() => {
      const canvas = document.querySelector(".d10-resultado .mesa-dados-3d-canvas");
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return false;
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let verde = 0, vermelho = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] < 220) continue;
        if (Math.abs(pixels[i] - 46) <= 14 && Math.abs(pixels[i + 1] - 143) <= 14 && Math.abs(pixels[i + 2] - 91) <= 14) verde++;
        if (Math.abs(pixels[i] - 138) <= 14 && Math.abs(pixels[i + 1] - 58) <= 14 && Math.abs(pixels[i + 2] - 58) <= 14) vermelho++;
      }
      return verde > 0 && vermelho > 0;
    }, null, { timeout: 20000 });
    const verdePainel = await pixelsNaCor(pgM.locator(".d10-resultado .mesa-dados-3d-canvas"), [46, 143, 91]);
    const vermelhoPainel = await pixelsNaCor(pgM.locator(".d10-resultado .mesa-dados-3d-canvas"), [138, 58, 58]);
    const verdeHistorico = await pixelsNaCor(pg1.locator(".rolagem-item .mesa-dados-3d-canvas").first(), [46, 143, 91]);
    const vermelhoHistorico = await pixelsNaCor(pg1.locator(".rolagem-item .mesa-dados-3d-canvas").first(), [138, 58, 58]);
    t("canvas do painel desenha borda verde real para sucesso", verdePainel > 0, `pixels verdes=${verdePainel}`);
    t("canvas do painel desenha borda vermelha real para falha", vermelhoPainel > 0, `pixels vermelhos=${vermelhoPainel}`);
    t("canvas do histórico de outro participante desenha as duas cores",
      verdeHistorico > 0 && vermelhoHistorico > 0,
      `pixels verdes=${verdeHistorico}; vermelhos=${vermelhoHistorico}`);
  }
  await shot(pgM, "01d-d10-cores-segundo-participante");

  await pgM.evaluate(async (cid) => {
    await fetch(`/api/campaigns/${cid}/regras/config`, {
      method: "PUT", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dados: { d10SucessoMinimo: 6 } }),
    });
  }, cenario.campId);
  await shot(pgM, "01c-d10-minimo-servidor");

  await shot(pgM, "01-mesa-dados");

  sec("2. Cinco tipos de dados em canvas 3D");
  for (const d of [4, 6, 8, 10, 20]) {
    await rolarLivre(pgM, d);
    const titulos = await valoresCanvas(pgM);
    const ultimo = titulos[titulos.length - 1] ?? "";
    const total = await pgM.locator(".rolagem-resultado .d10-chip-total").last().textContent();
    t(`d${d}: mesa 3D compartilhada exibida (${ultimo})`, new RegExp(`d${d}=\\d`).test(ultimo), ultimo);
    t(`d${d}: canvas da mesa não está em branco`, await canvasPintado(pgM));
    t(`d${d}: total autoritativo exibido`, /Total:\s*\d+/.test(total ?? ""), total?.trim());
    await shot(pgM, `02-dado-d${d}`);
  }

  sec("3. Múltiplos dados");
  await rolarLivre(pgM, 20, 3);
  const titulos3 = await valoresCanvas(pgM);
  const ultimo3 = titulos3[titulos3.length - 1] ?? "";
  t("3×d20 = 3 dados na mesma mesa", (ultimo3.match(/d20=\d/g) ?? []).length >= 3, ultimo3);

  sec("4. Jogador vê a mesma rolagem (servidor autoritativo)");
  // pg1 já entrou antes dos pools D10 e permanece conectado para os
  // demais cenários de histórico/visibilidade da suíte.
  const totalM = await pgM.locator(".rolagem-resultado .d10-chip-total").last().textContent();
  await rolarLivre(pgM, 6);
  const totalNovoM = await pgM.locator(".rolagem-resultado .d10-chip-total").last().textContent();
  // histórico compartilhado: o jogador deve ver a mesma rolagem (= total)
  const alvo = (totalNovoM ?? "").replace(/\D/g, "");
  await pg1.locator(".rolagem-item").last().waitFor({ timeout: 10000 }).catch(() => {});
  const itens = await pg1.locator(".rolagem-item strong").allTextContents();
  t("total da rolagem aparece para o jogador", itens.some((x) => x.includes(`= ${alvo}`)), `${alvo} | vistos: ${itens.slice(-3).join(" | ")}`);
  const canvasesJ = await pg1.locator(".rolagem-item .mesa-dados-3d-canvas").count();
  t("jogador vê mesa de dados 3D no histórico", canvasesJ > 0, `${canvasesJ} canvas`);
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
  const d10Canvas = await pg1.waitForFunction(() => {
    const cs = document.querySelectorAll(".rolagem-item .mesa-dados-3d-canvas, .rolagem-resultado .mesa-dados-3d-canvas");
    return [...cs].some((c) => /d10=\d/.test(c.getAttribute("aria-label") ?? ""));
  }, null, { timeout: 15000 }).then(() => true).catch(() => false);
  t("desafio D10 renderiza dado 3D na mesa", d10Canvas, "nenhuma mesa com d10=");
  await shot(pg1, "07-d10-3d");

  sec("8. Reduced motion: resultado final imediato, sem simulação");
  const ctxRM = await browser.newContext({ viewport: { width: 1366, height: 900 }, reducedMotion: "reduce" });
  const pgRM = await ctxRM.newPage();
  await login(pgRM, "jogador_um", "senha-jogador-123");
  await irCampanha(pgRM);
  await entrarNaMesa(pgRM);
  await rolarLivre(pgRM, 6, 2);
  const rotuloRM = await pgRM.locator(".rolagem-resultado .mesa-dados-3d-canvas").last().getAttribute("aria-label").catch(() => "");
  t("reduced-motion: mesa exibe os 2 dados com valores do servidor",
    (rotuloRM.match(/d6=\d/g) ?? []).length === 2, rotuloRM);
  t("reduced-motion: canvas pintado", await pgRM.evaluate(() => {
    const c = document.querySelector(".rolagem-resultado .mesa-dados-3d-canvas");
    if (!c) return false;
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 400) if (d[i] > 0) return true;
    return false;
  }));
  await ctxRM.close();

  sec("9. Mobile 390px");
  const ctxMob = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pgMob = await ctxMob.newPage();
  await login(pgMob, "jogador_um", "senha-jogador-123");
  await irCampanha(pgMob);
  await entrarNaMesa(pgMob);
  await rolarLivre(pgMob, 8);
  const canvasMob = await pgMob.locator(".rolagem-resultado .mesa-dados-3d-canvas").count();
  const dim = await pgMob.locator(".rolagem-resultado .mesa-dados-3d-canvas").first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }).catch(() => ({ w: 0, h: 0 }));
  t("mobile: mesa 3D visível e compacta", canvasMob > 0 && dim.w > 300 && dim.h <= 170, `w=${dim.w} h=${dim.h}`);
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
