#!/usr/bin/env node
// FILHO — homologação independente da PR #385 (microinterações #132) @ SHA destacado.
// Escopo: SOMENTE os fluxos alterados — tabpanel, modal, rolagem, tag de
// turno, HP/vitalidade do token — mais reduced-motion (app e SO),
// isolamento de HP entre usuários, mobile 390px e regressões dos fluxos.
// Diferença da suíte do PAI: verifica elementos REAIS da UI (não injetados),
// remontagem por troca de valor (HP/turno) e privacidade do HP manual.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

const DIR = dirTeste("132-micro-filho");
const BANCO = `${DIR}/mestre-rpg-teste.db`;
prepararBanco(BANCO);
const porta = await portaLivre();
const BASE = `http://127.0.0.1:${porta}`;
const proc = subirServidor(porta, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });

let passaram = 0, falharam = 0;
const ok = (nome, cond, detalhe = "") => {
  if (cond) { passaram++; console.log(`  ok  ${nome}`); }
  else { falharam++; console.log(`FALHOU ${nome} ${detalhe}`); }
};
const cookieDe = (c) => c.split("=").pop();

const VISUAL_BASE = {
  intensidade: "equilibrada", corDestaque: "vinho", superficies: "padrao",
  textura: "sutil", densidade: "padrao",
};
const definirAnimacoes = (cookie, animacoes) =>
  req(BASE, "PATCH", "/auth/preferences", {
    cookie,
    body: { visual: { ...VISUAL_BASE, animacoes } },
  });

const animNome = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  return el ? getComputedStyle(el).animationName : null;
}, sel);
const animDuracao = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  return el ? getComputedStyle(el).animationDuration : null;
}, sel);
const animRodando = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return false;
  return el.getAnimations().some((a) => a.playState === "running" || a.playState === "pending");
}, sel);

const PNG_PATH = join(DIR, "mapa.png");
writeFileSync(PNG_PATH, Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"));

async function abrirCampanha(page) {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Campanhas" }).first().click();
  await page.locator(".cartao-campanha", { hasText: "Campanha Teste" }).first().click();
  await page.locator("[role=tablist]").waitFor({ timeout: 20000 });
}
async function aba(page, nome) {
  await page.locator("[role=tab]", { hasText: nome }).first().click();
}
async function semOverflowX(page) {
  return page.evaluate(() =>
    document.scrollingElement.scrollWidth <= document.documentElement.clientWidth + 1);
}

const browser = await chromium.launch();
try {
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO, { campanha: "Campanha Teste" });
  const sess = await req(BASE, "POST", `/campaigns/${c.campId}/sessoes`, {
    cookie: c.cookieMestre, body: { name: "Sessão Micro" },
  });
  const sessId = sess.json?.sessao?.id ?? sess.json?.id;
  const nota = await req(BASE, "POST", `/campaigns/${c.campId}/anotacoes`, {
    cookie: c.cookieMestre,
    body: { title: "Nota Exclusão Modal", kind: "diario", visibility: "publica" },
  });
  const notaId = nota.json?.anotacao?.id ?? nota.json?.id;
  const nota2 = await req(BASE, "POST", `/campaigns/${c.campId}/anotacoes`, {
    cookie: c.cookieMestre,
    body: { title: "Nota Mobile Modal", kind: "diario", visibility: "publica" },
  });
  const nota2Id = nota2.json?.anotacao?.id ?? nota2.json?.id;
  if (!sessId || !notaId || !nota2Id) throw new Error(`setup falhou sess=${sess.status} nota=${nota.status}`);

  // ================= MESTRE — fluxos reais alterados =================
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addCookies([{ name: "mestre_rpg_session", value: cookieDe(c.cookieMestre), url: BASE }]);
    const page = await ctx.newPage();
    await abrirCampanha(page);

    // --- 1. Tabpanel: animação real + remontagem a cada troca ---
    for (const nomeAba of ["Diário", "Personagens", "Arquivos"]) {
      await aba(page, nomeAba);
      const painel = page.locator("[role=tabpanel]").first();
      await painel.waitFor({ state: "visible", timeout: 10000 });
      const nome = await animNome(page, "[role=tabpanel]");
      ok(`tabpanel[${nomeAba}]: micro-entra-cima`, nome === "micro-entra-cima", nome);
      ok(`tabpanel[${nomeAba}]: animação em execução`, await animRodando(page, "[role=tabpanel]"));
      // regressão ARIA: painel continua ligado à aba
      const ctrl = await painel.getAttribute("id");
      ok(`tabpanel[${nomeAba}]: id painel-*`, /^painel-/.test(ctrl ?? ""), ctrl);
    }
    // remontagem: identidade do nó muda a cada troca
    await page.evaluate(() => { window.__p = document.querySelector("[role=tabpanel]"); });
    await aba(page, "Diário");
    await page.locator("#painel-diario").waitFor({ timeout: 10000 });
    ok("tabpanel: remontagem real na troca de aba",
      await page.evaluate(() => window.__p !== document.querySelector("[role=tabpanel]")));

    // --- 2. Modal real (Excluir anotação no Diário) ---
    await aba(page, "Diário");
    const itemNota = page.locator("li", { hasText: "Nota Exclusão Modal" }).first();
    await itemNota.waitFor({ timeout: 10000 });
    await itemNota.getByRole("button", { name: "Excluir" }).click();
    await page.locator(".modal-fundo").waitFor({ timeout: 8000 });
    ok("modal: .modal-fundo usa micro-fade",
      (await animNome(page, ".modal-fundo")) === "micro-fade");
    ok("modal: .modal usa micro-entra-modal",
      (await animNome(page, ".modal")) === "micro-entra-modal");
    ok("modal: .modal animação em execução",
      await animRodando(page, ".modal"));
    // confirma exclusão — regressão funcional + fechamento
    await page.locator(".modal").getByRole("button", { name: "Excluir", exact: true }).click();
    await page.locator(".modal-fundo").waitFor({ state: "detached", timeout: 8000 });
    ok("modal: exclusão confirmada e modal fechado",
      await page.locator("li", { hasText: "Nota Exclusão Modal" }).count() === 0);

    // --- 3. Mesa: turnos (tag-atual) + rolagem real via socket ---
    await aba(page, "Mesa");
    await page.locator("tr.clicavel", { hasText: "Sessão Micro" }).first().click();
    await page.locator(".mesa-view, .mesa-lateral").first().waitFor({ timeout: 20000 });
    await page.getByRole("button", { name: "Iniciar", exact: true }).click();
    const tagAtual = page.locator(".tag-atual").first();
    await tagAtual.waitFor({ timeout: 10000 });
    ok("turno: .tag-atual usa micro-tag-turno",
      (await animNome(page, ".tag-atual")) === "micro-tag-turno");
    await page.evaluate(() => {
      window.__tag = document.querySelector(".tag-atual");
      window.__vez = document.querySelector(".mesa-lateral .meta, .mesa-lateral p")?.textContent;
    });
    await page.getByRole("button", { name: "Avançar", exact: true }).click();
    await page.waitForTimeout(400);
    ok("turno: Avançar remonta o span do turno atual",
      await page.evaluate(() => window.__tag !== document.querySelector(".tag-atual")));
    ok("turno: novo turno atual segue animado",
      (await animNome(page, ".tag-atual")) === "micro-tag-turno");
    const animNaoAtuais = await page.evaluate(() =>
      [...document.querySelectorAll(".tag:not(.tag-atual)")].map((el) => getComputedStyle(el).animationName));
    ok("turno: pulso APENAS no ator corrente (demais .tag sem micro-tag-turno)",
      animNaoAtuais.length > 0 && animNaoAtuais.every((n) => n !== "micro-tag-turno"),
      JSON.stringify(animNaoAtuais));
    const vezDepois = await page.evaluate(() =>
      [...document.querySelectorAll(".mesa-lateral p, .mesa-lateral .meta")].map((e) => e.textContent).join(" "));
    ok("turno: 'é a vez' reflete avanço (regressão)", vezDepois.includes("é a vez"), vezDepois.slice(0, 80));

    // rolagem real: emite pelo socket do app → servidor → mesa:rolagem → .rolagem-item
    // Dois rolls: prova que SÓ o item novo anima — o anterior já terminou.
    await page.evaluate((sid) => {
      window.__mesaSocket.emit("mesa:rolar", {
        sessionId: sid, dados: [{ sides: 20, count: 1 }],
        motivo: "prova FILHO um", visibilidade: "publica",
      });
    }, sessId);
    await page.locator(".rolagem-item", { hasText: "prova FILHO um" }).first().waitFor({ timeout: 10000 });
    await page.waitForTimeout(600); // micro-item-entra (.3s) do 1º item termina
    await page.evaluate((sid) => {
      window.__mesaSocket.emit("mesa:rolar", {
        sessionId: sid, dados: [{ sides: 20, count: 1 }],
        motivo: "prova FILHO dois", visibilidade: "publica",
      });
    }, sessId);
    const rolNovo = page.locator(".rolagem-item", { hasText: "prova FILHO dois" }).first();
    await rolNovo.waitFor({ timeout: 10000 });
    ok("rolagem: item novo usa micro-item-entra",
      (await animNome(page, ".rolagem-item")) === "micro-item-entra");
    ok("rolagem: animação do item novo em execução", await animRodando(page, ".rolagem-item"));
    const animVelho = await page.evaluate(() => {
      const velho = [...document.querySelectorAll(".rolagem-item")]
        .find((el) => el.textContent.includes("prova FILHO um"));
      if (!velho) return "ausente";
      return velho.getAnimations().map((a) => a.playState).join(",") || "sem-animacoes";
    });
    ok("rolagem: item anterior NÃO re-anima (só o novo)",
      !/running|pending/.test(animVelho), animVelho);

    // --- 4. VTT: token com HP manual → flash real na mudança de valor ---
    await page.locator(".mesa-vtt input[type=file]").setInputFiles(PNG_PATH);
    await page.locator(".vtt-tabuleiro").waitFor({ timeout: 10000 });
    await page.locator('.vtt-controles input[placeholder="Nome do token"]').fill("Ana");
    await page.locator(".vtt-controles select").first().selectOption(c.jogadores.jogador1.id);
    await page.locator('.vtt-controles input[aria-label="HP atual do token"]').fill("7");
    await page.locator('.vtt-controles input[aria-label="HP máximo do token"]').fill("20");
    await page.getByRole("button", { name: "Adicionar token" }).click();
    const tok = page.locator(".vtt-token", { hasText: "AN" }).first();
    await tok.waitFor({ timeout: 10000 });
    const hpSpan = page.locator(".vtt-token-hp").first();
    await hpSpan.waitFor({ timeout: 8000 });
    ok("vida: .vtt-token-hp usa micro-vida-muda",
      (await animNome(page, ".vtt-token-hp")) === "micro-vida-muda");
    ok("vida: HP inicial 7/20 renderizado",
      (await hpSpan.getAttribute("title")) === "HP 7/20", await hpSpan.getAttribute("title"));
    await page.evaluate(() => { window.__hp = document.querySelector(".vtt-token-hp"); });
    // mestre altera HP → valor muda → span remonta → flash dispara de novo
    await tok.click();
    await page.locator('.vtt-hp-manual input[aria-label="HP atual do token selecionado"]').fill("5");
    await page.locator('.vtt-hp-manual input[aria-label="HP máximo do token selecionado"]').fill("20");
    await page.getByRole("button", { name: "Salvar HP" }).click();
    await page.waitForFunction(() =>
      document.querySelector(".vtt-token-hp")?.getAttribute("title") === "HP 5/20", { timeout: 10000 });
    ok("vida: HP 5/20 persistido no token (regressão)", true);
    ok("vida: span de HP remonta na mudança de valor",
      await page.evaluate(() => window.__hp !== document.querySelector(".vtt-token-hp")));
    ok("vida: flash rejogado após mudança",
      (await animNome(page, ".vtt-token-hp")) === "micro-vida-muda");
    await ctx.close();
  }

  // ================= JOGADORES — isolamento do HP manual =================
  // Token tem dono=jogador1: o DONO vê o próprio HP (paridade com ficha);
  // jogador2 (mesma campanha, não-dono) NÃO pode ver — vidaCompartilhada off.
  for (const [apelido, esperaHp, esperado] of [
    ["jogador1", true, "dono vê o próprio HP"],
    ["jogador2", false, "não-dono NÃO vê HP alheio"],
  ]) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addCookies([{ name: "mestre_rpg_session", value: cookieDe(c.jogadores[apelido].cookie), url: BASE }]);
    const page = await ctx.newPage();
    await abrirCampanha(page, "Campanha Teste");
    await page.locator("[role=tab]", { hasText: "Mesa" }).first().click();
    await page.locator("tr.clicavel", { hasText: "Sessão Micro" }).first().click();
    await page.locator(".vtt-token").first().waitFor({ timeout: 20000 });
    ok(`isolamento[${apelido}]: token visível`, await page.locator(".vtt-token").count() === 1);
    const nHp = await page.locator(".vtt-token-hp").count();
    ok(`isolamento[${apelido}]: ${esperado}`, esperaHp ? nHp === 1 : nHp === 0, `hpSpans=${nHp}`);
    await ctx.close();
  }

  // ================= REDUCED-MOTION — app =================
  {
    const r = await definirAnimacoes(c.cookieMestre, "reduzido");
    ok("setup: PATCH animacoes=reduzido", r.status === 200, `status=${r.status}`);
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "mestre_rpg_session", value: cookieDe(c.cookieMestre), url: BASE }]);
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.documentElement.dataset.movimentoEfetivo !== undefined, { timeout: 15000 });
    ok("reduzido: data-movimento-efetivo=reduzido",
      (await page.evaluate(() => document.documentElement.dataset.movimentoEfetivo)) === "reduzido");
    await abrirCampanha(page);
    await aba(page, "Diário");
    await page.locator("[role=tabpanel]").first().waitFor({ timeout: 10000 });
    const dur = parseFloat(await animDuracao(page, "[role=tabpanel]"));
    ok("reduzido: duração ~0 no tabpanel real", dur <= 0.02, `dur=${dur}`);
    ok("reduzido: tabpanel permanece visível (não trava em opacity 0)",
      await page.locator("[role=tabpanel]").first().isVisible());
    // troca de aba continua funcionando sob movimento reduzido
    await aba(page, "Personagens");
    await page.locator("#painel-personagens").waitFor({ timeout: 10000 });
    ok("reduzido: troca de aba funciona", true);

    // fluxos de turno e token sob movimento reduzido (ordem Dono 06:41)
    await aba(page, "Mesa");
    await page.locator("tr.clicavel", { hasText: "Sessão Micro" }).first().click();
    await page.locator(".tag-atual").first().waitFor({ timeout: 20000 });
    await page.locator(".vtt-token-hp").first().waitFor({ timeout: 10000 });
    const durTag = parseFloat(await animDuracao(page, ".tag-atual"));
    const durHp = parseFloat(await animDuracao(page, ".vtt-token-hp"));
    ok("reduzido: .tag-atual duração ~0", durTag <= 0.02, `dur=${durTag}`);
    ok("reduzido: .vtt-token-hp duração ~0", durHp <= 0.02, `dur=${durHp}`);
    ok("reduzido: turno atual e HP visíveis", 
      await page.locator(".tag-atual").first().isVisible() && await page.locator(".vtt-token-hp").first().isVisible());
    // mudança de HP sob reduzido: span ainda remonta por valor, flash neutralizado
    await page.locator(".vtt-token").first().click();
    await page.locator('.vtt-hp-manual input[aria-label="HP atual do token selecionado"]').fill("4");
    await page.locator('.vtt-hp-manual input[aria-label="HP máximo do token selecionado"]').fill("20");
    await page.getByRole("button", { name: "Salvar HP" }).click();
    await page.waitForFunction(() =>
      document.querySelector(".vtt-token-hp")?.getAttribute("title") === "HP 4/20", { timeout: 10000 });
    const durHp2 = parseFloat(await animDuracao(page, ".vtt-token-hp"));
    ok("reduzido: HP 4/20 persistido + flash neutralizado", durHp2 <= 0.02, `dur=${durHp2}`);
    await ctx.close();
    await definirAnimacoes(c.cookieMestre, "completo");
  }

  // ================= REDUCED-MOTION — SO prevalece =================
  {
    const ctx = await browser.newContext({ reducedMotion: "reduce" });
    await ctx.addCookies([{ name: "mestre_rpg_session", value: cookieDe(c.cookieMestre), url: BASE }]);
    const page = await ctx.newPage();
    await abrirCampanha(page);
    await aba(page, "Diário");
    await page.locator("[role=tabpanel]").first().waitFor({ timeout: 10000 });
    const dur = parseFloat(await animDuracao(page, "[role=tabpanel]"));
    ok("SO-reduce: duração ~0 mesmo com app completo", dur <= 0.02, `dur=${dur}`);
    // mesmos fluxos de turno/token sob SO-reduce
    await aba(page, "Mesa");
    await page.locator("tr.clicavel", { hasText: "Sessão Micro" }).first().click();
    await page.locator(".tag-atual").first().waitFor({ timeout: 20000 });
    await page.locator(".vtt-token-hp").first().waitFor({ timeout: 10000 });
    const durTag = parseFloat(await animDuracao(page, ".tag-atual"));
    const durHp = parseFloat(await animDuracao(page, ".vtt-token-hp"));
    ok("SO-reduce: .tag-atual duração ~0", durTag <= 0.02, `dur=${durTag}`);
    ok("SO-reduce: .vtt-token-hp duração ~0", durHp <= 0.02, `dur=${durHp}`);
    await ctx.close();
  }

  // ================= MOBILE 390px =================
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addCookies([{ name: "mestre_rpg_session", value: cookieDe(c.cookieMestre), url: BASE }]);
    const page = await ctx.newPage();
    await abrirCampanha(page);
    await page.locator("[role=tabpanel]").first().waitFor({ timeout: 10000 });
    ok("mobile: tabpanel visível em 390px",
      await page.locator("[role=tabpanel]").first().isVisible());
    ok("mobile: sem overflow horizontal", await semOverflowX(page));
    await aba(page, "Diário");
    await page.locator("#painel-diario").waitFor({ timeout: 10000 });
    ok("mobile: troca de aba funciona", true);
    ok("mobile: sem overflow após troca", await semOverflowX(page));
    // modal real também em 390px (fluxo alterado)
    const itemNota2 = page.locator("li", { hasText: "Nota Mobile Modal" }).first();
    await itemNota2.waitFor({ timeout: 10000 });
    await itemNota2.getByRole("button", { name: "Excluir" }).click();
    await page.locator(".modal-fundo").waitFor({ timeout: 8000 });
    ok("mobile: modal abre com micro-entra-modal",
      (await animNome(page, ".modal")) === "micro-entra-modal");
    ok("mobile: modal sem overflow horizontal", await semOverflowX(page));
    await page.locator(".modal").getByRole("button", { name: "Excluir", exact: true }).click();
    await page.locator(".modal-fundo").waitFor({ state: "detached", timeout: 8000 });
    ok("mobile: modal fecha após confirmar", true);
    // mesa no mobile: turno atual e HP do token visíveis sem overflow
    await aba(page, "Mesa");
    await page.locator("tr.clicavel", { hasText: "Sessão Micro" }).first().click();
    await page.locator(".vtt-token").first().waitFor({ timeout: 20000 });
    ok("mobile: token VTT visível", await page.locator(".vtt-token").first().isVisible());
    ok("mobile: mesa sem overflow horizontal", await semOverflowX(page));
    await ctx.close();
  }

  await browser.close();
} catch (e) {
  console.error("FALHA FATAL:", e);
  falharam++;
} finally {
  encerrarServidor(proc);
  limparDir(DIR);
  console.log(`\n${passaram} ok / ${falharam} falhas`);
  process.exit(falharam ? 1 : 0);
}
