#!/usr/bin/env node
// Teste E2E da UI de configuração de Sangue (Issue #186, C8-A).
// Cobre: aba visível só ao mestre, config antiga ausente (defaults),
// erro 400 do servidor (habilitado sem capacidade), salvamento completo
// (capacidade mapa + bônus qualidade + natureza + naturezas + recuperação),
// preservação das demais chaves de config, jogador sem acesso e mobile.
// Servidor+SQLite+site descartáveis.
import { chromium } from "playwright";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  abrirDb, criarCenario, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

const DIR = dirTeste("sangue-config-ui");
const BANCO = `${DIR}/mestre-rpg-teste.db`;
prepararBanco(BANCO);
const porta = await portaLivre();
const BASE = `http://127.0.0.1:${porta}`;
const proc = subirServidor(porta, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });

const resultados = [];
const ok = (nome, cond, extra = "") => {
  resultados.push({ nome, ok: !!cond });
  console.log(`${cond ? "ok" : "FALHOU"} ${nome}${extra ? " — " + extra : ""}`);
};

try {
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO, {
    campanha: "Campanha Sangue UI",
    jogadores: { j1: "jog_sangue1" },
  });
  const { campId, cookieMestre, jogadores } = c;
  const cookie = `mestre_rpg_session=${cookieMestre.split("=").pop()}`;

  // Enriquece a estrutura publicada da fixture com campos elegíveis:
  // inteiro (for já existe), selecao_nivel (capacidade), selecao_unica
  // (natureza) e inteiro extra (qualidade).
  {
    const w = abrirDb(BANCO);
    const v = w.prepare(`select sv.id, sv.structure from sheet_versions sv
      join sheet_templates st on st.current_version_id = sv.id
      where st.campaign_id=?`).get(campId);
    const est = JSON.parse(v.structure);
    est.secoes[0].campos.push(
      { id: "sangue_nivel", label: "Nível de Sangue", tipo: "selecao_nivel", semantico: "livre", padrao: 0 },
      { id: "natureza", label: "Natureza", tipo: "selecao_unica", semantico: "livre", padrao: null },
      { id: "qualidade_sangue", label: "Qualidade Sangue", tipo: "inteiro", semantico: "livre", padrao: 0 },
    );
    w.prepare("update sheet_versions set structure=? where id=?").run(JSON.stringify(est), v.id);
    w.close();
  }

  const browser = await chromium.launch();
  const novaPagina = async (cookieValor) => {
    const ctx = await browser.newContext();
    await ctx.addCookies([{ name: "mestre_rpg_session", value: cookieValor.split("=").pop(), url: BASE }]);
    return { ctx, page: await ctx.newPage() };
  };
  const abrirRegrasSangue = async (page) => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Campanhas" }).first().click();
    await page.locator(".cartao-campanha", { hasText: "Campanha Sangue UI" }).click();
    await page.getByRole("button", { name: "Regras", exact: true }).click();
    await page.getByRole("button", { name: "Sangue", exact: true }).click();
    await page.waitForSelector(".painel-sangue", { timeout: 15000 });
  };

  // ---------- 1. Mestre: painel, defaults de config ausente, erro 400 ----------
  {
    const { ctx, page } = await novaPagina(cookie);
    await abrirRegrasSangue(page);
    const painel = page.locator(".painel-sangue");
    ok("UI. painel Pontos de Sangue visível ao mestre", await painel.count() === 1);
    ok("UI. aviso de escopo (só vínculos)", (await painel.textContent()).includes("somente vínculos"));
    ok("UI. config antiga ausente → habilitado desmarcado",
      await painel.locator('input[aria-label="Habilitar Pontos de Sangue"]').isChecked() === false);

    // Habilitar sem campo de capacidade → servidor rejeita (400)
    await painel.locator('input[aria-label="Habilitar Pontos de Sangue"]').check();
    await painel.getByRole("button", { name: "Salvar Pontos de Sangue" }).click();
    await painel.locator(".erro").waitFor({ timeout: 15000 });
    const erroTxt = await painel.locator(".erro").textContent();
    ok("UI. 400 exibido (capacidade exigida)", /capacidade/i.test(erroTxt), erroTxt.slice(0, 100));
    await ctx.close();
  }

  let pontosAntes;
  // ---------- 2. Mestre: configuração completa + preservação ----------
  {
    // Baseline: pontos configurado para provar preservação
    const antes = await req(BASE, "GET", `/campaigns/${campId}/regras`, { cookie });
    pontosAntes = antes.json?.config?.pontos;

    const { ctx, page } = await novaPagina(cookie);
    await abrirRegrasSangue(page);
    const painel = page.locator(".painel-sangue");

    await painel.locator('input[aria-label="Habilitar Pontos de Sangue"]').check(); // habilitado
    await painel.locator("#sangue-campo-capacidade").selectOption("sangue_nivel");
    await painel.locator('select[aria-label="Modo de leitura da capacidade"]').selectOption("mapa");
    await painel.getByRole("button", { name: "+ rótulo" }).first().click();
    await painel.locator('input[aria-label="capacidade rótulo 1"]').fill("Lobisomem");
    await painel.locator('input[aria-label="capacidade capacidade 1"]').fill("10");

    // Bônus por qualidade
    await painel.locator('input[aria-label="Configurar bônus de qualidade"]').check();
    await painel.locator("#sangue-campo-qualidade").selectOption("qualidade_sangue");
    await painel.locator('input[aria-label="Coeficiente do bônus de qualidade"]').fill("0.5");

    // Natureza + rótulo
    await painel.locator("#sangue-campo-natureza").selectOption("natureza");
    await painel.getByRole("button", { name: "+ natureza" }).click();
    await painel.locator('input[aria-label="Natureza 1 rótulo"]').fill("Vampiro");
    await painel.locator('input[aria-label="Natureza 1 recuperação"]').fill("sangue_raro");
    await painel.locator('input[aria-label="Meta humano com Poder natureza 1"]').check();

    // Recuperação sinalizador
    await painel.locator('input[aria-label="Habilitar sinalizador de recuperação"]').check();

    await painel.getByRole("button", { name: "Salvar Pontos de Sangue" }).click();
    await painel.locator(".online").waitFor({ timeout: 15000 });
    ok("UI. salvamento concluído", (await painel.locator(".online").textContent()).includes("salva"));
    await ctx.close();
  }

  // ---------- 3. API: config persistida + demais chaves preservadas ----------
  {
    const r = await req(BASE, "GET", `/campaigns/${campId}/regras`, { cookie });
    const s = r.json?.config?.sangue;
    ok("API. sangue.habilitado=true", s?.habilitado === true);
    ok("API. campoCapacidadeId", s?.campoCapacidadeId === "sangue_nivel");
    ok("API. modo mapa + mapa", s?.capacidade?.modo === "mapa" && s?.capacidade?.mapa?.Lobisomem === 10);
    ok("API. bonusQualidade", s?.capacidade?.bonusQualidade?.campoId === "qualidade_sangue"
      && s?.capacidade?.bonusQualidade?.coeficiente === 0.5);
    ok("API. campoNaturezaId", s?.campoNaturezaId === "natureza");
    ok("API. naturezas Vampiro", s?.naturezas?.Vampiro?.metaHumanoComPoder === true
      && s?.naturezas?.Vampiro?.recuperacao === "sangue_raro");
    ok("API. recuperacaoSangue", s?.recuperacaoSangue?.habilitado === true);
    ok("API. pontos preservados", JSON.stringify(r.json?.config?.pontos) === JSON.stringify(pontosAntes ?? r.json?.config?.pontos));
  }

  // ---------- 4. Jogador não tem acesso à aba Regras ----------
  {
    const { ctx, page } = await novaPagina(jogadores.j1.cookie);
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Campanhas" }).first().click();
    await page.locator(".cartao-campanha", { hasText: "Campanha Sangue UI" }).click();
    ok("UI. jogador não vê aba Regras", await page.getByRole("button", { name: "Regras", exact: true }).count() === 0);
    // API direta: jogador → 403 no PUT config
    const r = await req(BASE, "PUT", `/campaigns/${campId}/regras/config`, {
      cookie: `mestre_rpg_session=${jogadores.j1.cookie.split("=").pop()}`,
      body: { sangue: { habilitado: true } },
    });
    ok("API. jogador PUT config → 403", r.status === 403, `status=${r.status}`);
    await ctx.close();
  }

  // ---------- 5. Mobile ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addCookies([{ name: "mestre_rpg_session", value: cookie.split("=").pop(), url: BASE }]);
    const page = await ctx.newPage();
    await abrirRegrasSangue(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    ok("UI. mobile: painel sem overflow horizontal", !overflow);
    await ctx.close();
  }

  await browser.close();
} finally {
  await encerrarServidor(proc).catch(() => {});
}

const falhas = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - falhas.length} passaram, ${falhas.length} falharam`);
limparDir(DIR);
process.exit(falhas.length ? 1 : 0);
