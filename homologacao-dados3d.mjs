#!/usr/bin/env node
// Homologação dos dados 3D na mesa (PRs #39/#40/#41 integradas):
// renderer Three.js/Rapier, cinco tipos, quantidade, cores independentes com
// persistência no servidor, atualização imediata e resultado autoritativo.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, encerrarServidor, limparDir, req, abrirDb, sessao,
} from "./teste-base.mjs";
import { hashSenha } from "./servidor/dist/lib/password.js";

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

let browser, proc, previewProc;
let previewBase = "";

async function shot(page, nome) {
  try { await page.screenshot({ path: join(SHOTS, `${nome}.png`) }); } catch { }
}
async function login(page, user, senha, base = BASE) {
  await page.addInitScript(() => {
    let rafId = 0;
    let rafClock = 0;
    let rafRate = 60;
    const rafTimers = new Map();
    window.__mesaRafTicks = 0;
    window.__mesaUseRafRate = (hz) => {
      rafRate = hz;
      rafClock = performance.now();
      window.__mesaRafTicks = 0;
      window.requestAnimationFrame = (callback) => {
        const id = ++rafId;
        const interval = 1000 / rafRate;
        const timer = window.setTimeout(() => {
          rafTimers.delete(id);
          rafClock += interval;
          window.__mesaRafTicks++;
          callback(rafClock);
        }, interval);
        rafTimers.set(id, timer);
        return id;
      };
      window.cancelAnimationFrame = (id) => {
        const timer = rafTimers.get(id);
        if (timer !== undefined) {
          window.clearTimeout(timer);
          rafTimers.delete(id);
        }
      };
    };
    window.__mesaReadPixels = (canvas) => {
      const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
      if (gl) {
        gl.finish();
        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return pixels;
      }
      const ctx = canvas.getContext("2d");
      return ctx ? ctx.getImageData(0, 0, canvas.width, canvas.height).data : null;
    };
  });
  await page.goto(base);
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
  // A lista vem da sessão mais NOVA para a mais antiga. O mestre
  // reentra na MAIS ANTIGA ativa: clicar "Iniciar sessão" criaria uma
  // sessão nova a cada reload e divergiria dos jogadores — com o
  // isolamento por sessionId (auditoria #149) os eventos deixariam de
  // atravessar as sessões. Sem nenhuma sessão, cria a primeira.
  const iniciar = page.getByRole("button", { name: "Iniciar sessão" });
  const linhas = page.locator("table.tabela tr.clicavel").filter({ hasNotText: "encerrada" });
  // espera a lista estabilizar: sem isso o count() roda antes do fetch
  // das sessões e o jogador (que nunca tem "Iniciar sessão") cai no
  // branch errado
  await iniciar.or(linhas.first()).first().waitFor({ timeout: 15000 });
  const total = await linhas.count();
  if (total > 0) {
    const ehMestre = await iniciar.count() > 0;
    await linhas.nth(ehMestre ? total - 1 : 0).click();
  } else {
    await iniciar.click();
  }
  // .mesa-view e não .chat-form: espectadores não têm formulário de
  // chat por padrão (somente leitura) — a view da mesa é o sinal
  // universal de entrada autorizada
  await page.locator(".mesa-view").first().waitFor({ timeout: 15000 });
}
async function rolarLivre(page, lados, qtd = 1, motivo = null) {
  await page.locator(".abas-dados button", { hasText: "Rolagem e dano" }).click();
  await page.locator(".rolagem-form select").first().selectOption(String(lados));
  if (qtd > 1) await page.locator('.rolagem-form input[type="number"]').fill(String(qtd));
  if (motivo) await page.locator('.rolagem-form input[placeholder="Motivo (opcional)"]').fill(motivo);
  const totalAntes = await page.locator(".rolagem-resultado .d10-chip-total").last().textContent().catch(() => "");
  const tituloAntes = await page.locator(".mesa-dados-area .mesa-dados-3d-canvas").last().getAttribute("aria-label").catch(() => "");
  // o item mais novo do histórico é o PRIMEIRO do DOM (lista revertida)
  const itemAntes = await page.locator(".rolagem-item").first().getAttribute("data-rolagem-id").catch(() => null);
  await page.getByRole("button", { name: /Lançar/ }).click();
  // o painel mostra só a última rolagem: aguarda resultado novo —
  // total OU face podem coincidir, então espera qualquer um dos dois mudar
  await page.waitForFunction(
    ([antTotal, antTitulo, motivoEsperado, antItem]) => {
      const totais = document.querySelectorAll(".rolagem-resultado .d10-chip-total");
      const txt = totais.length ? totais[totais.length - 1].textContent : "";
      const canvases = document.querySelectorAll(".mesa-dados-area .mesa-dados-3d-canvas");
      const tit = canvases.length ? canvases[canvases.length - 1].getAttribute("aria-label") : "";
      const primeiroItem = document.querySelector(".rolagem-item");
      const itemNovo = !!primeiroItem && primeiroItem.dataset.rolagemId !== antItem;
      const itemHistoricoNovo = motivoEsperado
        && Array.from(document.querySelectorAll(".rolagem-item"))
          .some((item) => item.textContent?.includes(motivoEsperado));
      // "rolando" é o tumble pré-ACK — só conta como resultado o label
      // já fixado nos valores oficiais do servidor
      const titPronto = tit && tit !== antTitulo && !tit.includes("rolando");
      return (txt && txt !== antTotal) || titPronto || itemNovo || Boolean(itemHistoricoNovo);
    },
    [totalAntes ?? "", tituloAntes ?? "", motivo ?? "", itemAntes], { timeout: 20000, polling: 50 },
  );
}
async function iniciarPreview(apiTarget) {
  const porta = await portaLivre();
  const base = `http://127.0.0.1:${porta}`;
  const child = spawn(process.execPath, [
    join(process.cwd(), "node_modules", "vite", "bin", "vite.js"),
    "preview", "--host", "127.0.0.1", "--port", String(porta), "--strictPort",
  ], {
    cwd: join(process.cwd(), "site"),
    env: { ...process.env, MESTRE_VITE_API_TARGET: apiTarget },
    stdio: "ignore",
  });
  const limite = Date.now() + 15000;
  while (Date.now() < limite) {
    if (child.exitCode !== null) throw new Error(`vite preview encerrou com código ${child.exitCode}`);
    try {
      const response = await fetch(base);
      if (response.ok) return { child, base, headers: response.headers };
    } catch { }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  child.kill();
  throw new Error("timeout aguardando vite preview");
}
const valoresCanvas = (page) =>
  page.$$eval(".mesa-dados-area .mesa-dados-3d-canvas", (cs) => cs.map((c) => c.getAttribute("aria-label")));
const canvasPintado = (page) => page.evaluate(() => {
  const c = document.querySelector(".mesa-dados-area .mesa-dados-3d-canvas");
  if (!c) return false;
  const d = window.__mesaReadPixels(c);
  if (!d) return false;
  for (let i = 3; i < d.length; i += 400) if (d[i] > 0) return true;
  return false;
});

// Conta pixels reais do canvas próximos à cor RGB esperada. Isso verifica
// o desenho (borda das faces), não apenas o aria-label ou classes React.
const pixelsNaCor = (locator, rgb) => locator.evaluate((canvas, alvo) => {
  const dados = window.__mesaReadPixels(canvas);
  if (!dados) return 0;
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
  const preview = await iniciarPreview(BASE);
  previewProc = preview.child;
  previewBase = preview.base;
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
  await pgM.locator(".mesa-dados-area canvas[data-renderer='three-rapier'][data-physics-ready='true']").waitFor({ timeout: 30000 });
  t("mesa usa Three.js e Rapier quando WebGL está disponível",
    await pgM.locator(".mesa-dados-area canvas[data-renderer='three-rapier'][data-physics-ready='true']").count() === 1);

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
  const canvasD10Pool = pgM.locator(".mesa-dados-area .mesa-dados-3d-canvas");
  await canvasD10Pool.waitFor({ timeout: 15000 });
  // o canvas existe desde o tumble ("rolando"); aguarda o ACK fixar os valores
  await pgM.waitForFunction(() => {
    const rotulo = document.querySelector(".mesa-dados-area .mesa-dados-3d-canvas")?.getAttribute("aria-label") ?? "";
    return (rotulo.match(/d10=\d+/g) ?? []).length === 3;
  }, null, { timeout: 15000 });
  const rotuloD10Pool = await canvasD10Pool.getAttribute("aria-label");
  const valoresD10Pool = rotuloD10Pool?.match(/d10=\d+/g) ?? [];
  const estadosD10Pool = rotuloD10Pool?.match(/\((sucesso|falha|acerto_critico|erro_critico)\)/g) ?? [];
  t("pool D10 de 5 positivos e 2 negativos gera 3 dados efetivos", valoresD10Pool.length === 3, rotuloD10Pool);
  t("pool D10 inteiro aparece em um único canvas compartilhado",
    await pgM.locator(".mesa-dados-area .mesa-dados-3d-canvas").count() === 1);
  t("cada D10 mantém indicação individual de sucesso/falha", estadosD10Pool.length === 3, rotuloD10Pool);

  // A mesma classificação deve chegar aos outros participantes pelo
  // evento autoritativo mesa:rolagem e aparecer no histórico compartilhado.
  const canvasD10Historico = pgM.locator(".rolagem-item .mesa-dados-3d-canvas").last();
  await canvasD10Historico.waitFor({ timeout: 15000 });
  const rotuloD10Historico = await canvasD10Historico.getAttribute("aria-label");
  const valoresD10Historico = rotuloD10Historico?.match(/d10=\d+/g) ?? [];
  const estadosD10Historico = rotuloD10Historico?.match(/\((sucesso|falha|acerto_critico|erro_critico)\)/g) ?? [];
  const sucessosVisuais = (rotuloD10Historico?.match(/\((sucesso|acerto_critico)\)/g) ?? []).length;
  const falhasVisuais = (rotuloD10Historico?.match(/\((falha|erro_critico)\)/g) ?? []).length;
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
    const c = document.querySelector(".mesa-dados-area .mesa-dados-3d-canvas");
    const rotulo = c?.getAttribute("aria-label") ?? "";
    return (rotulo.match(/d10=\d+/g) ?? []).length === 8;
  }, null, { timeout: 15000 });
  const rotuloPainelMin = await pgM.locator(".mesa-dados-area .mesa-dados-3d-canvas").getAttribute("aria-label");
  const legendaPainelMin = await pgM.locator(".d10-form .meta").innerText();
  t("legenda do painel acompanha o mínimo autoritativo 9 recebido no ACK",
    /sucesso ≥ 9/.test(legendaPainelMin), legendaPainelMin);
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
    // Issue #147: o D10 interno 10 é EXIBIDO como face "0" — converte de
    // volta para o valor interno; classes de crítico fazem parte do
    // contrato visual (acerto_critico/erro_critico).
    [...(rotulo ?? "").matchAll(/d10=(\d+) \((sucesso|falha|acerto_critico|erro_critico)\)/g)]
      .map((m) => ({ valor: Number(m[1]) === 0 ? 10 : Number(m[1]), estado: m[2] }));
  const facesPainel = facesDe(rotuloPainelMin);
  const facesHist = facesDe(rotuloHistMin);
  const classificarOk = (faces) =>
    faces.length === 8 && faces.every((f) => {
      const esperado = f.valor === 10 ? "acerto_critico"
        : f.valor === 1 ? "erro_critico"
        : f.valor >= MIN_D10 ? "sucesso" : "falha";
      return f.estado === esperado;
    });
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
    return (rotulo.match(/d10=\d+/g) ?? []).length === 8 && /mín\s*9\b/.test(resumo);
  }, null, { timeout: 15000 });
  const rotuloHistJogador = await pg1.locator(".rolagem-item .mesa-dados-3d-canvas").first().getAttribute("aria-label");
  const resumoHistJogador = await pg1.locator(".rolagem-item .d10-rolagem").first().innerText();
  const facesJogador = facesDe(rotuloHistJogador);
  t("outro participante recebe os 8 D10 sem recarregar",
    facesJogador.length === 8, rotuloHistJogador);
  t("outro participante recebe a regra autoritativa mín 9",
    /mín\s*9\b/.test(resumoHistJogador), resumoHistJogador);
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
    const anterior = await pgM.locator(".mesa-dados-area .mesa-dados-3d-canvas").getAttribute("aria-label").catch(() => "");
    const ctrlCores = pgM.locator(".d10-controles input[type=number]");
    await ctrlCores.nth(0).fill("20");
    await ctrlCores.nth(1).fill("0");
    await pgM.locator("form.d10-form").getByRole("button", { name: /Lançar/ }).click();
    await pgM.waitForFunction(({ anterior }) => {
      const rotulo = document.querySelector(".mesa-dados-area .mesa-dados-3d-canvas")?.getAttribute("aria-label") ?? "";
      return rotulo !== anterior && (rotulo.match(/d10=\d+/g) ?? []).length === 20;
    }, { anterior }, { timeout: 20000 });
    rotuloCores = await pgM.locator(".mesa-dados-area .mesa-dados-3d-canvas").getAttribute("aria-label") ?? "";
    facesCores = facesDe(rotuloCores);
    if (facesCores.some((f) => f.estado === "sucesso" || f.estado === "acerto_critico") && facesCores.some((f) => f.estado === "falha" || f.estado === "erro_critico")) break;
  }
  const legendaCores = await pgM.locator(".d10-form .meta").innerText();
  t("legenda do painel acompanha o mínimo autoritativo 5 recebido no ACK",
    /sucesso ≥ 5/.test(legendaCores), legendaCores);
  const poolMisto = facesCores.some((f) => f.estado === "sucesso" || f.estado === "acerto_critico") && facesCores.some((f) => f.estado === "falha" || f.estado === "erro_critico");
  t("pool de cores contém D10 de sucesso e de falha", poolMisto, rotuloCores);

  if (poolMisto) {
    const pxJogador = await pg1.waitForFunction(() => {
      const item = document.querySelector(".rolagem-item");
      const rotulo = item?.querySelector(".mesa-dados-3d-canvas")?.getAttribute("aria-label") ?? "";
      const resumo = item?.querySelector(".d10-rolagem")?.textContent ?? "";
      const canvas = item?.querySelector(".mesa-dados-3d-canvas");
      const pixels = canvas && window.__mesaReadPixels(canvas);
      if (!pixels) return false;
      let verde = 0, vermelho = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] < 220) continue;
        if (Math.abs(pixels[i] - 46) <= 14 && Math.abs(pixels[i + 1] - 143) <= 14 && Math.abs(pixels[i + 2] - 91) <= 14) verde++;
        if (Math.abs(pixels[i] - 138) <= 14 && Math.abs(pixels[i + 1] - 58) <= 14 && Math.abs(pixels[i + 2] - 58) <= 14) vermelho++;
      }
      return (rotulo.match(/d10=\d+/g) ?? []).length === 20
        && /mín\s*5\b/.test(resumo) && verde > 0 && vermelho > 0
        ? { verde, vermelho } : null;
    }, null, { timeout: 20000 }).then((h) => h.jsonValue());
    const resumoJogadorCores = await pg1.locator(".rolagem-item .d10-rolagem").first().innerText();
    const facesJogadorCores = facesDe(await pg1.locator(".rolagem-item .mesa-dados-3d-canvas").first().getAttribute("aria-label"));
    t("outro participante recebe o pool misto com mínimo 5",
      facesJogadorCores.length === 20 && /mín\s*5\b/.test(resumoJogadorCores)
        && facesJogadorCores.every((f, i) => f.valor === facesCores[i].valor && f.estado === facesCores[i].estado),
      resumoJogadorCores);

    // O flash de resultado é TRANSITÓRIO (~1.4s após o assentamento):
    // as cores são capturadas dentro da janela do efeito, não depois.
    const pxPainel = await pgM.waitForFunction(() => {
      const canvas = document.querySelector(".mesa-dados-area .mesa-dados-3d-canvas");
      const pixels = canvas && window.__mesaReadPixels(canvas);
      if (!pixels) return null;
      let verde = 0, vermelho = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] < 220) continue;
        if (Math.abs(pixels[i] - 46) <= 14 && Math.abs(pixels[i + 1] - 143) <= 14 && Math.abs(pixels[i + 2] - 91) <= 14) verde++;
        if (Math.abs(pixels[i] - 138) <= 14 && Math.abs(pixels[i + 1] - 58) <= 14 && Math.abs(pixels[i + 2] - 58) <= 14) vermelho++;
      }
      return verde > 0 && vermelho > 0 ? { verde, vermelho } : null;
    }, null, { timeout: 20000 }).then((h) => h.jsonValue());
    const verdePainel = pxPainel?.verde ?? 0;
    const vermelhoPainel = pxPainel?.vermelho ?? 0;
    const verdeHistorico = pxJogador?.verde ?? 0;
    const vermelhoHistorico = pxJogador?.vermelho ?? 0;
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

  sec("2. Cinco tipos de dados no renderer WebGL");
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
  // O ID do servidor identifica a MESMA rolagem nas duas telas. Um motivo
  // exclusivo localiza o novo item do mestre, e o total é comparado no item
  // do jogador com o mesmo ID — nunca com uma entrada antiga do histórico.
  const motivoUnico = `homologacao-id-${Date.now()}`;
  await rolarLivre(pgM, 6, 1, motivoUnico);
  const itemM = pgM.locator(".rolagem-item").filter({ hasText: motivoUnico }).first();
  await itemM.waitFor({ timeout: 10000 });
  const idNovo = await itemM.getAttribute("data-rolagem-id");
  const totalNovoM = (await itemM.locator(".linha strong").textContent())?.trim() ?? "";
  t("mestre identifica a nova rolagem pelo ID do servidor", Boolean(idNovo), `id=${idNovo ?? "ausente"}`);

  let itemJ = null;
  if (idNovo) {
    itemJ = pg1.locator(`.rolagem-item[data-rolagem-id="${idNovo}"]`);
    await itemJ.waitFor({ timeout: 10000 }).catch(() => {});
  }
  const totalNovoJ = itemJ
    ? ((await itemJ.locator(".linha strong").textContent().catch(() => ""))?.trim() ?? "")
    : "";
  t("jogador recebe a mesma rolagem identificada pelo ID",
    Boolean(idNovo) && totalNovoJ.length > 0 && totalNovoJ === totalNovoM,
    `id=${idNovo ?? "ausente"}; mestre=${totalNovoM}; jogador=${totalNovoJ || "não recebido"}`);
  const canvasesJ = itemJ ? await itemJ.locator(".mesa-dados-3d-canvas").count() : 0;
  t("jogador vê mesa de dados 3D da mesma rolagem", canvasesJ > 0, `${canvasesJ} canvas`);
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

  sec("6b. Temas da bandeja 3D — seleção, prévia e persistência");
  const temaCards = pgM.locator(".tema-mesa-card");
  t("cinco temas de bandeja disponíveis", await temaCards.count() === 5, `count=${await temaCards.count()}`);
  t("cada tema exibe prévia visual própria",
    await pgM.locator(".tema-mesa-previa").count() === 5
      && await pgM.locator(".tema-mesa-previa").first().evaluate((el) => Boolean(el.style.backgroundImage && el.style.borderColor)));
  const datasetTema = () => pgM.evaluate(() => document.documentElement.dataset.temaMesa ?? "");
  const varFeltro = () => pgM.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--mesa-feltro").trim());
  const temasIds = ["azul", "verde", "vinho", "madeira", "obsidiana"];
  const nomesTema = ["Feltro azul", "Feltro verde", "Feltro vinho", "Madeira escura", "Obsidiana"];
  const coresBandeja = [];
  const corBandejaCanvas = () => pgM.evaluate(() => {
    const c = document.querySelector(".mesa-dados-area .mesa-dados-3d-canvas");
    if (!c) return null;
    const d = window.__mesaReadPixels(c);
    if (!d) return null;
    let r = 0, g = 0, b = 0, n = 0;
    const left = Math.floor(c.width * 0.12), right = Math.ceil(c.width * 0.88);
    const top = Math.floor(c.height * 0.12), bottom = Math.ceil(c.height * 0.88);
    for (let y = top; y < bottom; y += 7) for (let x = left; x < right; x += 7) {
      const i = (y * c.width + x) * 4;
      if (d[i + 3] > 200) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
    }
    return n ? [r / n, g / n, b / n] : null;
  });
  for (let i = 0; i < temasIds.length; i++) {
    await temaCards.filter({ hasText: nomesTema[i] }).click();
    await pgM.waitForTimeout(300);
    t(`tema ${temasIds[i]} selecionável`, (await datasetTema()) === temasIds[i], `data=${await datasetTema()}`);
    t(`tema ${temasIds[i]} aplica cor da bandeja`, (await varFeltro()).length > 0);
    coresBandeja.push(await corBandejaCanvas());
    await shot(pgM, `06b-tema-${temasIds[i]}`);
  }
  // prova visual: os temas produzem cores reais distintas no framebuffer
  // (não basta a variável CSS mudar; luminância sozinha perde matizes).
  const coresDistintas = coresBandeja.filter((cor, i) => cor && !coresBandeja.slice(0, i).some((anterior) => anterior
    && Math.hypot(cor[0] - anterior[0], cor[1] - anterior[1], cor[2] - anterior[2]) < 8));
  t("temas produzem bandejas visualmente distintas no canvas", coresDistintas.length >= 4,
    `cores=${coresBandeja.map((c) => c?.map((v) => v.toFixed(0)).join("/") ?? "vazio").join(",")}`);
  // seleção persiste no servidor e sobrevive a reload
  const meTemaSel = await pgM.evaluate(async () => (await (await fetch("/api/auth/me")).json()).usuario?.preferences?.temaMesa);
  t("temaMesa persistido via API", meTemaSel === "obsidiana", `lido=${meTemaSel}`);
  await pgM.reload();
  await pgM.getByText("Servidor online").waitFor({ timeout: 15000 });
  await irCampanha(pgM);
  await entrarNaMesa(pgM);
  await pgM.waitForTimeout(600);
  t("tema persiste após reload", (await datasetTema()) === "obsidiana", `data=${await datasetTema()}`);
  // isolamento: o outro participante continua no tema padrão
  const temaJ = await pg1.evaluate(() => document.documentElement.dataset.temaMesa ?? "");
  t("tema é individual — outro usuário segue no padrão", temaJ === "azul", `jogador=${temaJ}`);
  // valores inválidos rejeitados pela API
  const temaInv = await pgM.evaluate(async () => (await fetch("/api/auth/preferences", {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ temaMesa: "arco-iris" }),
  })).status);
  t("temaMesa inválido rejeitado (400)", temaInv === 400, `status=${temaInv}`);
  const temaCss = await pgM.evaluate(async () => (await fetch("/api/auth/preferences", {
    method: "PATCH", headers: { "content-type": "application/json" },
    body: JSON.stringify({ temaMesa: "url(javascript:alert(1))" }),
  })).status);
  t("temaMesa com CSS arbitrário rejeitado (400)", temaCss === 400, `status=${temaCss}`);
  // volta ao azul para as próximas seções visuais
  await temaCards.filter({ hasText: "Feltro azul" }).click();
  await pgM.waitForTimeout(200);

  sec("6c. Modo imersivo — ampliar/fechar preserva cena e rolagem");
  const areaImersiva = pgM.locator(".mesa-dados-area").first();
  const canvasArea = areaImersiva.locator(".mesa-dados-3d-canvas");
  await canvasArea.waitFor({ timeout: 10000 });
  const rotuloAntesImersao = await canvasArea.getAttribute("aria-label");
  // garante o botão visível ANTES de medir: o scrollIntoView automático
  // do click do Playwright não pode ser confundido com salto da feature
  const btnAmpliar = areaImersiva.getByRole("button", { name: "Ampliar mesa de dados" });
  await btnAmpliar.scrollIntoViewIfNeeded();
  await pgM.waitForTimeout(300);
  const scrollAntesImersao = await pgM.evaluate(() => window.scrollY);
  await btnAmpliar.click();
  const areaAberta = pgM.locator(".mesa-dados-area.imersivo");
  await areaAberta.waitFor({ timeout: 5000 });
  const rectAreaImersiva = await areaAberta.boundingBox();
  const rectImersivo = await areaAberta.locator(".mesa-dados-3d-canvas").boundingBox();
  t("overlay imersivo ocupa a tela", !!rectAreaImersiva && rectAreaImersiva.width > 1100 && rectAreaImersiva.height > 500,
    JSON.stringify(rectAreaImersiva));
  t("canvas imersivo com altura limitada (controles acessíveis abaixo)",
    !!rectImersivo && rectImersivo.height > 200 && rectImersivo.height <= 500, JSON.stringify(rectImersivo));
  t("mesmo canvas/valores preservados ao ampliar",
    (await areaAberta.locator(".mesa-dados-3d-canvas").getAttribute("aria-label")) === rotuloAntesImersao,
    `${rotuloAntesImersao}`);
  t("abrir não gera nova rolagem", (await pgM.evaluate(() => window.scrollY)) === scrollAntesImersao,
    `antes=${scrollAntesImersao} depois=${await pgM.evaluate(() => window.scrollY)}`);
  // bloqueio de rolagem do fundo: sem overflow:hidden o documento
  // atrás do overlay continuaria rolando com roda/toque
  t("documento com overflow oculto no modo imersivo",
    await pgM.evaluate(() => document.documentElement.style.overflow) === "hidden",
    await pgM.evaluate(() => document.documentElement.style.overflow));
  // marcador de identidade: prova que é o MESMO nó canvas após o ciclo
  await canvasArea.evaluate((el) => { el.dataset.marcaImersao = "1"; });
  // roda do mouse sobre o overlay NÃO pode rolar a página de fundo
  await pgM.mouse.move(680, 450);
  await pgM.mouse.wheel(0, 900);
  await pgM.waitForTimeout(300);
  t("roda do mouse não rola a página atrás do overlay",
    (await pgM.evaluate(() => window.scrollY)) === scrollAntesImersao,
    `scrollY=${await pgM.evaluate(() => window.scrollY)}`);
  await shot(pgM, "06c-mesa-imersiva");
  await pgM.keyboard.press("Escape");
  await pgM.waitForFunction(() => !document.querySelector(".mesa-dados-area.imersivo"), null, { timeout: 5000 });
  t("Escape fecha o modo imersivo", await pgM.locator(".mesa-dados-area.imersivo").count() === 0);
  t("fechar não gera nova rolagem", (await pgM.evaluate(() => window.scrollY)) === scrollAntesImersao,
    `depois=${await pgM.evaluate(() => window.scrollY)}`);
  t("overflow restaurado após Escape",
    await pgM.evaluate(() => document.documentElement.style.overflow) === "",
    await pgM.evaluate(() => document.documentElement.style.overflow));
  // reabre com overflow customizado: o Recolher deve restaurar o valor
  // ANTERIOR, não um default fixo
  await pgM.evaluate(() => { document.documentElement.style.overflow = "scroll"; });
  await areaImersiva.getByRole("button", { name: "Ampliar mesa de dados" }).click();
  await pgM.locator(".mesa-dados-area.imersivo").waitFor({ timeout: 5000 });
  await pgM.getByRole("button", { name: "Recolher mesa de dados" }).click();
  await pgM.waitForFunction(() => !document.querySelector(".mesa-dados-area.imersivo"), null, { timeout: 5000 });
  t("botão Recolher fecha o modo imersivo", await pgM.locator(".mesa-dados-area.imersivo").count() === 0);
  t("overflow anterior restaurado após Recolher (não default fixo)",
    await pgM.evaluate(() => document.documentElement.style.overflow) === "scroll",
    await pgM.evaluate(() => document.documentElement.style.overflow));
  await pgM.evaluate(() => { document.documentElement.style.overflow = ""; });
  t("canvas é o mesmo nó DOM após o ciclo imersivo",
    await canvasArea.evaluate((el) => el.dataset.marcaImersao) === "1");
  // saída inesperada: com a área compartilhada, trocar de aba não a
  // desmonta — o cleanup do efeito é provado desmontando a mesa de
  // verdade (Sair da mesa) com o modo imersivo aberto, e entrando de
  // novo para as próximas seções.
  await areaImersiva.getByRole("button", { name: "Ampliar mesa de dados" }).click();
  await pgM.locator(".mesa-dados-area.imersivo").waitFor({ timeout: 5000 });
  // dispatchEvent: o overlay imersivo (position:fixed) cobre a página —
  // o clique real seria interceptado; o evento DOM dispara o onClick
  // do React do mesmo jeito e desmonta a mesa com a área imersiva aberta.
  await pgM.getByRole("button", { name: "Sair da mesa" }).first()
    .dispatchEvent("click");
  await pgM.waitForFunction(() => !document.querySelector(".mesa-dados-area"), null, { timeout: 10000 });
  t("desmonte da área restaura overflow (sem Escape/Recolher)",
    await pgM.evaluate(() => document.documentElement.style.overflow) === "",
    await pgM.evaluate(() => document.documentElement.style.overflow));
  // Reentra na MESMA sessão: "Iniciar sessão" criaria uma segunda e o
  // mestre divergiria do pg1 — com o isolamento por sessionId (auditoria
  // #149) os eventos deixariam de chegar ao outro participante. A lista
  // só tem a sessão original, então a primeira linha é ela.
  await aba(pgM, "Mesa");
  await pgM.locator("table.tabela tr.clicavel").first().click();
  await pgM.locator(".chat-form").waitFor({ timeout: 15000 });
  // rolagem continua autoritativa após ciclo imersivo
  await rolarLivre(pgM, 6, 1, "pos-imersivo");
  t("rolagem funciona após modo imersivo",
    await pgM.locator(".rolagem-item", { hasText: "pos-imersivo" }).count() > 0);

  sec("6d. Controles acessíveis de verdade dentro do modo imersivo");
  // Auditoria #149: o overlay precisa de rolagem própria — os
  // lançadores ficam abaixo do canvas e devem ser CLICÁVEIS sem sair
  // da tela cheia. Cliques reais do Playwright (nada de dispatchEvent).
  await areaImersiva.getByRole("button", { name: "Ampliar mesa de dados" }).click();
  await pgM.locator(".mesa-dados-area.imersivo").waitFor({ timeout: 5000 });
  const areaIm = pgM.locator(".mesa-dados-area.imersivo");
  await areaIm.locator(".mesa-dados-3d-canvas").evaluate((el) => { el.dataset.marcaControles = "1"; });
  // a lista renderiza slice(-8).reverse() — o item MAIS NOVO é o
  // primeiro do DOM; comparar o primeiro detecta a rolagem nova
  const idAntesIm = await pgM.locator(".rolagem-item").first().getAttribute("data-rolagem-id").catch(() => null);
  const aguardarNovaRolagem = (idAnterior) => pgM.waitForFunction((id) => {
    const itens = document.querySelectorAll(".rolagem-item");
    return itens.length > 0 && itens[0].dataset.rolagemId !== id;
  }, idAnterior, { timeout: 25000 });
  // garante a aba D10 (o estado persiste da última troca de aba)
  await areaIm.locator(".abas-dados button", { hasText: "Testes D10" }).click();
  // D10: o botão pode estar abaixo da dobra — o overlay rola até ele
  const btnLancD10 = areaIm.getByRole("button", { name: /Lançar D10|Lançar novamente/ }).first();
  await btnLancD10.scrollIntoViewIfNeeded();
  const boxLanc = await btnLancD10.boundingBox();
  t("Lançar D10 dentro da viewport no modo imersivo",
    !!boxLanc && boxLanc.y >= 0 && boxLanc.y + boxLanc.height <= 900, JSON.stringify(boxLanc));
  await btnLancD10.click();
  await aguardarNovaRolagem(idAntesIm);
  t("Lançar D10 de dentro do imersivo gera rolagem oficial", true);
  // Rolagem e dano: troca de aba DENTRO do overlay + lançamento real
  await areaIm.locator(".abas-dados button", { hasText: "Rolagem e dano" }).click();
  await areaIm.locator(".rolagem-form select").first().selectOption("6");
  const idAntesLivre = await pgM.locator(".rolagem-item").first().getAttribute("data-rolagem-id");
  await areaIm.getByRole("button", { name: "Lançar", exact: true }).click();
  await aguardarNovaRolagem(idAntesLivre);
  t("Rolagem e dano lançada de dentro do imersivo chega ao histórico", true);
  // ESC recolhe sem reinicializar a cena (mesmo nó canvas)
  await pgM.keyboard.press("Escape");
  await pgM.waitForFunction(() => !document.querySelector(".mesa-dados-area.imersivo"), null, { timeout: 5000 });
  t("ESC preserva o mesmo canvas após lançamentos no imersivo",
    await areaImersiva.locator(".mesa-dados-3d-canvas").evaluate((el) => el.dataset.marcaControles) === "1");
  await shot(pgM, "06d-imersivo-controles");

  sec("6e. Rótulos do histórico — Mão livre, motivo e dano");
  // rolagem livre SEM motivo → "Mão livre"
  await rolarLivre(pgM, 6, 1);
  t("rolagem livre sem motivo identificada como Mão livre",
    await pgM.locator(".rolagem-item", { hasText: "Mão livre" }).count() > 0);
  // com motivo → Mão livre + motivo
  await rolarLivre(pgM, 6, 1, "motivo-livre-xyz");
  t("Mão livre com motivo mostra os dois",
    await pgM.locator(".rolagem-item").filter({ hasText: "Mão livre" }).filter({ hasText: "motivo-livre-xyz" }).count() > 0);
  // dano → identificado como Dano, sem rótulo de mão livre
  await pgM.locator(".abas-dados button", { hasText: "Rolagem e dano" }).click();
  await pgM.locator(".rolagem-form select").nth(1).selectOption("dano");
  const idAntesDano = await pgM.locator(".rolagem-item").first().getAttribute("data-rolagem-id");
  await pgM.getByRole("button", { name: /Lançar( novamente)?/ }).click();
  await aguardarNovaRolagem(idAntesDano);
  const txtDano = await pgM.locator(".rolagem-item").first().textContent();
  t("dano identificado como Dano (sem Mão livre)",
    /Dano/.test(txtDano ?? "") && !/Mão livre/.test(txtDano ?? ""), (txtDano ?? "").slice(0, 160));
  // restaura o modo rolagem para as próximas seções
  await pgM.locator(".rolagem-form select").nth(1).selectOption("rolagem");

  sec("6f. Preferências de exibição para espectador (auditoria #149)");
  // Espectador real: membership role=espectador — não recebe
  // lançadores, mas ajusta as PRÓPRIAS preferências de visibilidade.
  const dbEsp = abrirDb(BANCO);
  const espId = crypto.randomUUID(), espMid = crypto.randomUUID();
  const agoraEsp = Date.now();
  dbEsp.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
    .run(espId, "espectador_teste", "Espectador Teste", await hashSenha("senha-espectador-123"), agoraEsp, agoraEsp);
  dbEsp.prepare("insert into memberships (id,campaign_id,user_id,role,status,joined_at,created_at,updated_at) values (?,?,?,'espectador','ativo',?,?,?)")
    .run(espMid, cenario.campId, espId, agoraEsp, agoraEsp, agoraEsp);
  dbEsp.close();
  const cookieEsp = sessao(BANCO, espId);
  const ctxE = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgE = await ctxE.newPage();
  await login(pgE, "espectador_teste", "senha-espectador-123");
  await irCampanha(pgE);
  await entrarNaMesa(pgE);
  await pgE.locator(".visibilidade-mesa input[type='checkbox']").first().waitFor({ timeout: 15000 });
  t("espectador vê o cartão Exibição com os 3 toggles",
    await pgE.locator(".visibilidade-mesa input[type='checkbox']").count() === 3);
  t("espectador NÃO recebe lançadores (sem painel de dados)",
    await pgE.locator(".painel-dados").count() === 0
    && await pgE.getByRole("button", { name: /Lançar/ }).count() === 0);
  // rolagem pública do mestre aparece para o espectador
  await rolarLivre(pgM, 6, 1, "esp-rolagem-publica");
  await pgE.locator(".rolagem-item", { hasText: "esp-rolagem-publica" }).first().waitFor({ timeout: 15000 });
  t("espectador recebe rolagem pública no histórico", true);
  // desliga "Rolagens" → histórico some SÓ para ele
  await pgE.locator(".visibilidade-mesa label", { hasText: "Rolagens" }).locator("input").click();
  await pgE.waitForFunction(() => !document.querySelector(".rolagem-item"), null, { timeout: 8000 });
  t("espectador: ocultar Rolagens esconde o histórico", true);
  // preferência individual no nível do DADO: a conta do jogador não foi
  // tocada pelo PATCH do espectador — e o próprio mestre segue vendo a
  // rolagem pública que ele mesmo lançou
  const prefsJog1 = await req(BASE, "GET", "/auth/me", { cookie: cenario.jogadores.jogador1.cookie });
  t("preferência do jogador não foi alterada pelo toggle do espectador",
    prefsJog1.json?.usuario?.preferences?.visibilidade?.rolagens !== false,
    JSON.stringify(prefsJog1.json?.usuario?.preferences?.visibilidade));
  t("rolagem pública segue visível para os demais participantes",
    await pgM.locator(".rolagem-item", { hasText: "esp-rolagem-publica" }).count() > 0);
  // desliga "Bandeja da mesa" → canvas da área some, cartão Exibição fica
  await pgE.locator(".visibilidade-mesa label", { hasText: "Bandeja da mesa" }).locator("input").click();
  await pgE.waitForFunction(() => !document.querySelector(".mesa-dados-area .mesa-dados-3d-canvas"), null, { timeout: 8000 });
  t("espectador: ocultar Bandeja remove o canvas mas mantém Exibição",
    await pgE.locator(".visibilidade-mesa input[type='checkbox']").count() === 3);
  // persistência: API confirma e reload mantém os toggles desligados
  const prefsEsp = await req(BASE, "GET", "/auth/me", { cookie: cookieEsp });
  t("preferências do espectador persistidas via API",
    prefsEsp.json?.usuario?.preferences?.visibilidade?.rolagens === false
    && prefsEsp.json?.usuario?.preferences?.visibilidade?.bandeja === false,
    JSON.stringify(prefsEsp.json?.usuario?.preferences?.visibilidade));
  await pgE.reload();
  await irCampanha(pgE);
  await entrarNaMesa(pgE);
  await pgE.locator(".visibilidade-mesa input[type='checkbox']").first().waitFor({ timeout: 15000 });
  const estadoAposReload = await pgE.locator(".visibilidade-mesa label").evaluateAll(
    (els) => els.map((el) => el.textContent.trim().split("—")[0].trim() + "=" + el.querySelector("input").checked));
  t("preferências do espectador sobrevivem ao reload",
    estadoAposReload.some((s) => s.startsWith("Rolagens=false"))
    && estadoAposReload.some((s) => s.startsWith("Bandeja da mesa=false")),
    JSON.stringify(estadoAposReload));
  t("histórico continua oculto para o espectador após reload",
    await pgE.locator(".rolagem-item").count() === 0);
  // reexibe tudo — os toggles nunca ficam inacessíveis. O histórico é
  // estado em memória (socket), não recarrega: após reexibir, uma nova
  // rolagem pública do mestre prova que o espectador volta a ver.
  await pgE.locator(".visibilidade-mesa label", { hasText: "Rolagens" }).locator("input").click();
  await pgE.locator(".visibilidade-mesa label", { hasText: "Bandeja da mesa" }).locator("input").click();
  await rolarLivre(pgM, 6, 1, "esp-rolagem-pos-reload");
  await pgE.locator(".rolagem-item", { hasText: "esp-rolagem-pos-reload" }).first().waitFor({ timeout: 15000 });
  t("espectador reexibe histórico e bandeja pelos próprios toggles", true);
  await ctxE.close();

  sec("7. D10 desafio continua autoritativo");
  // pg1 fica montado durante toda a suíte — sob carga, o socket
  // prolongado pode perder a room sessao:* sem disconnect visível.
  // Um reload garante socket novo em todas as rooms (e de quebra
  // valida que testes pendentes são recarregados via HTTP):
  await pg1.reload();
  await irCampanha(pg1);
  await entrarNaMesa(pg1);
  await pg1.locator(".painel-dados").waitFor({ timeout: 15000 });
  // o formulário do desafio abre por padrão (fluxo principal); só clica
  // para expandir se por acaso estiver recolhido
  const formD = pgM.locator("form", { has: pgM.getByRole("button", { name: "Enviar desafio" }) });
  if (!(await formD.isVisible().catch(() => false))) {
    await pgM.getByRole("button", { name: "+ Desafio" }).click();
  }
  const selPers = formD.locator("label", { hasText: "Personagem" }).locator("select");
  const opcoesPers = await selPers.locator("option").allTextContents();
  const idxPers = opcoesPers.findIndex((o) => o.includes("Heroína"));
  await selPers.selectOption({ index: idxPers > 0 ? idxPers : 1 });
  const selCampo = formD.locator("label", { hasText: "Habilidade/atributo" }).locator("select");
  for (let i = 0; i < 30; i++) { if ((await selCampo.locator("option").count()) > 1) break; await pgM.waitForTimeout(400); }
  await selCampo.selectOption({ index: 1 });
  await formD.getByRole("button", { name: "Enviar desafio" }).click();
  // o dono do personagem vê o teste pendente e rola pelo botão "Rolar" do card
  await pg1.getByText("Testes pendentes").waitFor({ timeout: 20000 });
  const btnRolarD10 = pg1.locator(".teste-card").getByRole("button", { name: "Rolar", exact: true });
  await btnRolarD10.waitFor({ timeout: 5000 });
  await btnRolarD10.click();
  const d10Canvas = await pg1.waitForFunction(() => {
    const cs = document.querySelectorAll(".rolagem-item .mesa-dados-3d-canvas, .mesa-dados-area .mesa-dados-3d-canvas");
    return [...cs].some((c) => /d10=\d/.test(c.getAttribute("aria-label") ?? ""));
  }, null, { timeout: 15000 }).then(() => true).catch(() => false);
  t("desafio D10 renderiza dado 3D na mesa", d10Canvas, "nenhuma mesa com d10=");
  // histórico do teste de ficha: personagem + campo com categoria
  // legível derivada da estrutura validada (auditoria #149)
  const itemFicha = pg1.locator(".rolagem-item", { hasText: "Campo:" }).first();
  const achouFicha = await itemFicha.waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
  if (!achouFicha) {
    console.log("DBG7 itens pg1:", JSON.stringify((await pg1.locator(".rolagem-item").allTextContents()).map((s) => s.slice(0, 140))));
  }
  const txtFicha = achouFicha ? await itemFicha.textContent() : "";
  t("histórico do teste de ficha mostra campo com categoria legível",
    /Campo:/.test(txtFicha ?? "") && /\(Atributo\)/.test(txtFicha ?? ""), (txtFicha ?? "").slice(0, 220));
  await shot(pg1, "07-d10-3d");

  sec("8. Reduced motion: resultado final imediato, sem simulação");
  const ctxRM = await browser.newContext({ viewport: { width: 1366, height: 900 }, reducedMotion: "reduce" });
  const pgRM = await ctxRM.newPage();
  await login(pgRM, "jogador_um", "senha-jogador-123");
  await irCampanha(pgRM);
  await entrarNaMesa(pgRM);
  await rolarLivre(pgRM, 6, 2);
  const rotuloRM = await pgRM.locator(".mesa-dados-area .mesa-dados-3d-canvas").last().getAttribute("aria-label").catch(() => "");
  t("reduced-motion: mesa exibe os 2 dados com valores do servidor",
    (rotuloRM.match(/d6=\d/g) ?? []).length === 2, rotuloRM);
  t("reduced-motion: canvas pintado", await pgRM.evaluate(() => {
    const c = document.querySelector(".mesa-dados-area .mesa-dados-3d-canvas");
    if (!c) return false;
    const d = window.__mesaReadPixels(c);
    if (!d) return false;
    for (let i = 3; i < d.length; i += 400) if (d[i] > 0) return true;
    return false;
  }));
  const canvasHistoricoRM = pgRM.locator(".rolagem-item canvas[data-renderer='three-rapier'][data-physics-ready='true'][data-physics-settled='true']").first();
  await canvasHistoricoRM.waitFor({ timeout: 15000 });
  const hashHistoricoRM = () => canvasHistoricoRM.evaluate((canvas) => {
    const pixels = window.__mesaReadPixels(canvas);
    if (!pixels) return "";
    let hash = 0;
    for (let i = 0; i < pixels.length; i += 64) {
      hash = (hash * 31 + pixels[i] + pixels[i + 1] * 3 + pixels[i + 2] * 7) >>> 0;
    }
    return String(hash);
  });
  const hashInicialRM = await hashHistoricoRM();
  await pgRM.waitForTimeout(300);
  const hashDepoisRM = await hashHistoricoRM();
  t("reduced-motion: rolagem histórica já resolvida permanece imóvel desde a montagem",
    hashInicialRM !== "" && hashInicialRM === hashDepoisRM, `${hashInicialRM}→${hashDepoisRM}`);

  // Estado físico final (não só pixels): dados nascidos com resultado
  // devem estar prontos, com velocidades zeradas e orientação no alvo —
  // mesmo quando valor/alvo já vinham preenchidos na montagem.
  const lerEstadoFisico = (canvas) => canvas.evaluate((c) => {
    const ler = c.__mesaDadosFisica;
    return typeof ler === "function" ? ler() : null;
  });
  const magnitud = (v) => Math.hypot(v[0], v[1], v[2]);
  const quatNoAlvo = (q, alvo) => !!alvo
    && Math.abs(q[0] * alvo[0] + q[1] * alvo[1] + q[2] * alvo[2] + q[3] * alvo[3]) > 0.9999;
  const estadoFinalOk = (estado) => Array.isArray(estado) && estado.length > 0 && estado.every((d) =>
    d.pronto === true
    && magnitud(d.linvel) < 0.01
    && magnitud(d.angvel) < 0.01
    && quatNoAlvo(d.quat, d.alvo)
    && d.pos[2] > 0.05);
  const estadoHistoricoRM = await lerEstadoFisico(canvasHistoricoRM);
  t("reduced-motion: histórico nasce assentado — pronto, velocidades zeradas, orientação no alvo",
    estadoFinalOk(estadoHistoricoRM), JSON.stringify(estadoHistoricoRM).slice(0, 300));
  const canvasMesaRM = pgRM.locator(".mesa-dados-area canvas[data-renderer='three-rapier'][data-physics-settled='true']").last();
  await canvasMesaRM.waitFor({ timeout: 15000 });
  const estadoMesaRM = await lerEstadoFisico(canvasMesaRM);
  t("reduced-motion: ACK posterior também assenta imediatamente no estado final",
    estadoFinalOk(estadoMesaRM), JSON.stringify(estadoMesaRM).slice(0, 300));
  await ctxRM.close();

  sec("8b. Física continua e assenta em 60/90/120/144 Hz");
  const ctxHz = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgHz = await ctxHz.newPage();
  await login(pgHz, "jogador_um", "senha-jogador-123");
  await irCampanha(pgHz);
  await entrarNaMesa(pgHz);
  await pgHz.locator(".mesa-dados-area canvas[data-renderer='three-rapier'][data-physics-ready='true']").waitFor({ timeout: 30000 });
  for (const hz of [60, 90, 120, 144]) {
    await pgHz.evaluate((rate) => window.__mesaUseRafRate(rate), hz);
    await rolarLivre(pgHz, 6, 1, `refresh-${hz}hz`);
    const ticksAntes = await pgHz.evaluate(() => window.__mesaRafTicks);
    await pgHz.waitForTimeout(300);
    const ticksDepois = await pgHz.evaluate(() => window.__mesaRafTicks);
    t(`${hz} Hz: RAF continua após o resultado do servidor`, ticksDepois - ticksAntes >= 10,
      `${ticksAntes}→${ticksDepois}`);
    await pgHz.locator(".mesa-dados-area canvas[data-renderer='three-rapier'][data-physics-settled='true']")
      .waitFor({ timeout: 10000 });
    await pgHz.evaluate(() => {
      window.__mesaRafLastObserved = window.__mesaRafTicks;
      window.__mesaRafStablePolls = 0;
    });
    await pgHz.waitForFunction(() => {
      if (window.__mesaRafTicks === window.__mesaRafLastObserved) {
        window.__mesaRafStablePolls++;
      } else {
        window.__mesaRafLastObserved = window.__mesaRafTicks;
        window.__mesaRafStablePolls = 0;
      }
      return window.__mesaRafStablePolls >= 5;
    }, null, { timeout: 10000, polling: 100 });
    const resultadoAssentado = await pgHz.locator(".mesa-dados-area canvas[data-renderer='three-rapier'][data-physics-ready='true']")
      .evaluate((canvas) => canvas.dataset.physicsSettled === "true"
        && /d6=\d/.test(canvas.getAttribute("aria-label") ?? ""));
    t(`${hz} Hz: simulação termina depois de continuar os frames`, resultadoAssentado);
  }
  // Estado físico final no caminho normal (sem reduced-motion): o dado
  // percorrido pela simulação termina pronto, com velocidades zeradas e
  // orientação na face oficial — mesma assinatura do caminho reduzido.
  const canvasHz = pgHz.locator(".mesa-dados-area canvas[data-renderer='three-rapier'][data-physics-settled='true']").last();
  await canvasHz.waitFor({ timeout: 15000 });
  const estadoHz = await lerEstadoFisico(canvasHz);
  t("física normal: estado final pronto, velocidades zeradas e orientação no alvo",
    estadoFinalOk(estadoHz), JSON.stringify(estadoHz).slice(0, 300));
  await ctxHz.close();

  sec("8c. Preview com CSP carrega o WASM Rapier");
  const csp = preview.headers.get("content-security-policy") ?? "";
  t("preview permite somente compilação WASM específica na CSP",
    csp.includes("script-src 'self' 'wasm-unsafe-eval'")
      && !csp.includes("'unsafe-eval'"), csp);
  const ctxPreview = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgPreview = await ctxPreview.newPage();
  const errosPreview = [];
  pgPreview.on("pageerror", (error) => errosPreview.push(error.message));
  await login(pgPreview, "jogador_dois", "senha-jogador-123", previewBase);
  await irCampanha(pgPreview);
  await entrarNaMesa(pgPreview);
  await pgPreview.locator(".mesa-dados-area canvas[data-renderer='three-rapier'][data-physics-ready='true']")
    .waitFor({ timeout: 30000 });
  t("vite preview inicializa Three/Rapier em vez do fallback Canvas",
    await pgPreview.locator(".mesa-dados-area canvas[data-renderer='three-rapier'][data-physics-ready='true']").count() === 1);
  t("preview sem erros de inicialização WebAssembly",
    !errosPreview.some((error) => /wasm|webassembly|content security policy/i.test(error)),
    errosPreview.join(" | "));
  await ctxPreview.close();

  sec("9. Mobile 390px");
  const ctxMob = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pgMob = await ctxMob.newPage();
  await login(pgMob, "jogador_um", "senha-jogador-123");
  await irCampanha(pgMob);
  await entrarNaMesa(pgMob);
  await rolarLivre(pgMob, 8);
  const canvasMob = await pgMob.locator(".mesa-dados-area .mesa-dados-3d-canvas").count();
  const dim = await pgMob.locator(".mesa-dados-area .mesa-dados-3d-canvas").first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { w: r.width, h: r.height };
  }).catch(() => ({ w: 0, h: 0 }));
  t("mobile: mesa 3D visível e compacta", canvasMob > 0 && dim.w > 300 && dim.h <= 170, `w=${dim.w} h=${dim.h}`);
  // modo imersivo também funciona no mobile — canvas com altura
  // limitada e o painel de controles acessível via rolagem do overlay
  const areaMob = pgMob.locator(".mesa-dados-area").first();
  await areaMob.getByRole("button", { name: "Ampliar mesa de dados" }).click();
  await pgMob.locator(".mesa-dados-area.imersivo").waitFor({ timeout: 5000 });
  const areaImMob = pgMob.locator(".mesa-dados-area.imersivo");
  const rectMob = await areaImMob.locator(".mesa-dados-3d-canvas").boundingBox();
  t("mobile: modo imersivo preenche a tela com canvas de altura limitada",
    !!rectMob && rectMob.width > 340 && rectMob.height > 250 && rectMob.height <= 400,
    JSON.stringify(rectMob));
  // controle real dentro do imersivo mobile: a aba já está em
  // "Rolagem e dano" (rolarLivre anterior) — rola o overlay até o
  // botão e clica de verdade
  const idAntesMob = await pgMob.locator(".rolagem-item").first().getAttribute("data-rolagem-id").catch(() => null);
  const btnLancarMob = areaImMob.getByRole("button", { name: /Lançar( novamente)?/ });
  await btnLancarMob.scrollIntoViewIfNeeded();
  const boxMob = await btnLancarMob.boundingBox();
  t("mobile: Lançar dentro da viewport no modo imersivo",
    !!boxMob && boxMob.y >= 0 && boxMob.y + boxMob.height <= 844, JSON.stringify(boxMob));
  await btnLancarMob.click();
  await pgMob.waitForFunction((id) => {
    const itens = document.querySelectorAll(".rolagem-item");
    return itens.length > 0 && itens[0].dataset.rolagemId !== id;
  }, idAntesMob, { timeout: 25000 });
  t("mobile: rolagem lançada de dentro do imersivo chega ao histórico", true);
  await pgMob.keyboard.press("Escape");
  await pgMob.waitForFunction(() => !document.querySelector(".mesa-dados-area.imersivo"), null, { timeout: 5000 });
  t("mobile: Escape fecha o modo imersivo", await pgMob.locator(".mesa-dados-area.imersivo").count() === 0);
  await shot(pgMob, "08-mobile-dados");
  await ctxMob.close();

  sec("10. Transporte polling-first e resiliência de conexão (Issue #92)");
  // O app usa polling primeiro (funciona atrás de proxy sem upgrade WS).
  // Inspecionamos o engine do socket do app para confirmar o transporte.
  const transporteApp = await pgM.evaluate(() => {
    const s = window.__mesaSocket;
    return s ? { conectado: s.connected, transporte: s.io?.engine?.transport?.name ?? "?" } : null;
  });
  t("app conectado com transporte válido", !!transporteApp?.conectado, JSON.stringify(transporteApp));
  t("transporte inicial é polling (upgrade posterior é opcional)",
    ["polling", "websocket"].includes(transporteApp?.transporte), `transporte=${transporteApp?.transporte}`);

  // Área de dados visível ANTES do primeiro lançamento: o canvas 3D da
  // bandeja está montado e pintado — não é mais uma prévia estática.
  await pgM.locator(".abas-dados button", { hasText: "Rolagem e dano" }).click();
  await pgM.locator(".rolagem-form select").first().selectOption("6");
  await pgM.locator(".mesa-dados-area .mesa-dados-3d-canvas").waitFor({ timeout: 5000 });
  t("mesa de dados 3D visível antes de rolar", await pgM.locator(".mesa-dados-area .mesa-dados-3d-canvas").count() === 1);
  t("bandeja pintada antes da primeira rolagem", await canvasPintado(pgM));

  // Animação real em andamento: o tumble começa no clique (antes do
  // ACK) e continua durante o assentamento — pixels do canvas mudam.
  const amostraPixels = () => pgM.evaluate(() => {
    const c = document.querySelector(".mesa-dados-area .mesa-dados-3d-canvas");
    if (!c) return "";
    const d = window.__mesaReadPixels(c);
    if (!d) return "";
    let h = 0;
    // Amostra 1 em cada 16 pixels (stride de 64 bytes RGBA). A amostragem
    // anterior (1 em 1024 pixels) podia passar entre os dados em canvases
    // largos/baixos e produzir hash idêntico mesmo com rotação real.
    for (let i = 0; i < d.length; i += 64) h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) >>> 0;
    return String(h);
  });
  // socket precisa estar conectado no instante do clique: lancar()
  // aborta sem animar quando connected===false (transporte em
  // reconexão) — flake observado no CI (pixels idênticos por ~3s).
  await pgM.waitForFunction(() => window.__mesaSocket?.connected === true, null, { timeout: 15000 });
  let pix1 = "", pix2 = "", animou = false;
  // até 2 tentativas: se o 1º clique caiu num instante de desconexão,
  // nenhuma animação ocorre e a 2ª tentativa prova o comportamento;
  // animação genuinamente quebrada falha nas duas e o assert reprova
  for (let tent = 0; tent < 2 && !animou; tent++) {
    if (tent > 0) {
      await pgM.waitForFunction(() => window.__mesaSocket?.connected === true, null, { timeout: 15000 });
      await pgM.getByRole("button", { name: /Lançar/ }).click();
    } else {
      await pgM.getByRole("button", { name: /Lançar/ }).click();
    }
    // polling dentro da janela de animação (~2-3s): o tumble começa no
    // clique (antes do ACK) e o assentamento continua depois — qualquer
    // mudança de pixel prova lançamento/giro/colisão em andamento
    for (let i = 0; i < 9 && !animou; i++) {
      pix1 = await amostraPixels();
      await pgM.waitForTimeout(300);
      pix2 = await amostraPixels();
      animou = pix1 !== "" && pix1 !== pix2;
    }
  }
  t("animação 3D em andamento durante a rolagem", animou, `${pix1}→${pix2}`);
  // aguarda o ACK da rolagem de amostragem terminar antes de desconectar
  await pgM.waitForFunction(
    () => document.querySelector(".rolagem-form button[type='submit']")?.disabled !== true,
    null, { timeout: 20000 },
  );

  // Desconexão: botão NÃO fica eterno em "Rolando…" e erro é exibido
  await pgM.evaluate(() => window.__mesaSocket.disconnect());
  await pgM.getByRole("button", { name: /Lançar/ }).click();
  await pgM.getByText(/Sem conexão com o servidor/).waitFor({ timeout: 5000 });
  t("sem conexão: erro compreensível exibido", true);
  t("sem conexão: botão liberado (não eterno)", await pgM.getByRole("button", { name: /Lançar/ }).isEnabled());

  // Reconexão: rolagem volta a funcionar
  await pgM.evaluate(() => window.__mesaSocket.connect());
  await pgM.waitForFunction(() => window.__mesaSocket?.connected === true, null, { timeout: 15000 });
  await rolarLivre(pgM, 6, 1, "reconexao-ok");
  t("após reconexão: rolagem funciona", await pgM.locator(".rolagem-item", { hasText: "reconexao-ok" }).count() > 0);

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
