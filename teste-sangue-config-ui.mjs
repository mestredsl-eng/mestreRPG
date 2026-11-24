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
await prepararBanco(BANCO);
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
    // Poder na biblioteca de regras (kind="poder") para o editor de custo
    const rs = w.prepare("select id from rule_sets where campaign_id=? and is_active=1").get(campId);
    const agora = Date.now();
    const insPoder = w.prepare("insert into rule_definitions (id,rule_set_id,kind,key,name,category,parent_key,definition,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)");
    insPoder.run(crypto.randomUUID(), rs.id, "poder", "chicote_sanguineo", "Chicote Sanguíneo", null, null, "{}", agora, agora);
    insPoder.run(crypto.randomUUID(), rs.id, "poder", "sede_sanguis", "Sede de Sangue", null, null, "{}", agora, agora);
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
    const avisoEscopo = await painel.textContent();
    ok("UI. aviso de escopo descreve valores configuráveis e runtime",
      avisoEscopo.includes("custos por Poder")
      && avisoEscopo.includes("quantidades de recuperação")
      && avisoEscopo.includes("runtime"));
    ok("UI. config antiga ausente → habilitado desmarcado",
      await painel.locator('input[aria-label="Habilitar Pontos de Sangue"]').isChecked() === false);

    // Habilitar sem campo de capacidade → servidor rejeita (400)
    await painel.locator('input[aria-label="Habilitar Pontos de Sangue"]').check();
    await painel.getByRole("button", { name: "Salvar Pontos de Sangue" }).click();
    await painel.locator(".erro").waitFor({ timeout: 15000 });
    const erroTxt = await painel.locator(".erro").textContent();
    ok("UI. 400 exibido (capacidade exigida)", /capacidade/i.test(erroTxt), erroTxt.slice(0, 100));

    // Ação habilitada sem quantidade → 400 do servidor, sem persistir
    await painel.locator('input[aria-label="Habilitar ação Descansar"]').check();
    await painel.getByRole("button", { name: "Salvar Pontos de Sangue" }).click();
    await painel.locator(".erro").waitFor({ timeout: 15000 });
    const erro2 = await painel.locator(".erro").textContent();
    ok("UI. ação incompleta → 400 (quantidade exigida)", /quantidade/i.test(erro2), erro2.slice(0, 100));

    // Reverter descarta edições locais
    await painel.getByRole("button", { name: "Reverter alterações" }).click();
    ok("UI. reverter desmarca habilitado", await painel.locator('input[aria-label="Habilitar Pontos de Sangue"]').isChecked() === false);
    ok("UI. reverter desmarca ação", await painel.locator('input[aria-label="Habilitar ação Descansar"]').isChecked() === false);
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

    // Custos dos Poderes (2 e 0 — zero é válido)
    await painel.locator('input[aria-label="Custo de Sangue do Poder Chicote Sanguíneo"]').fill("2");
    await painel.locator('input[aria-label="Custo de Sangue do Poder Sede de Sangue"]').fill("0");

    // Ações de recuperação
    await painel.locator('input[aria-label="Habilitar ação Descansar"]').check();
    await painel.locator('input[aria-label="Quantidade de Sangue — Descansar"]').fill("3");
    await painel.locator('input[aria-label="Habilitar ação Alimentar-se"]').check();
    await painel.locator('input[aria-label="Quantidade de Sangue — Alimentar-se"]').fill("1");

    // Natureza + rótulo (ação canônica via select)
    await painel.locator("#sangue-campo-natureza").selectOption("natureza");
    await painel.getByRole("button", { name: "+ natureza" }).click();
    await painel.locator('input[aria-label="Natureza 1 rótulo"]').fill("Vampiro");
    await painel.locator('select[aria-label="Natureza 1 ação de recuperação"]').selectOption("descansar");
    await painel.locator('input[aria-label="Meta humano com Poder natureza 1"]').check();
    // Segunda natureza → ação distinta; terceira sem mapeamento
    await painel.getByRole("button", { name: "+ natureza" }).click();
    await painel.locator('input[aria-label="Natureza 2 rótulo"]').fill("Humano");
    await painel.locator('select[aria-label="Natureza 2 ação de recuperação"]').selectOption("alimentar");
    await painel.getByRole("button", { name: "+ natureza" }).click();
    await painel.locator('input[aria-label="Natureza 3 rótulo"]').fill("Desconhecida");

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
      && s?.naturezas?.Vampiro?.recuperacao === "descansar");
    ok("API. poderes custo", s?.poderes?.chicote_sanguineo?.custo === 2);
    ok("API. acoes descansar", s?.recuperacaoSangue?.acoes?.descansar?.habilitada === true
      && s?.recuperacaoSangue?.acoes?.descansar?.quantidade === 3);
    ok("API. acoes alimentar", s?.recuperacaoSangue?.acoes?.alimentar?.habilitada === true
      && s?.recuperacaoSangue?.acoes?.alimentar?.quantidade === 1);
    ok("API. natureza Humano→alimentar", s?.naturezas?.Humano?.recuperacao === "alimentar");
    ok("API. natureza sem ação", s?.naturezas?.Desconhecida !== undefined && !("recuperacao" in (s?.naturezas?.Desconhecida ?? {})));
    ok("API. poder custo zero válido", s?.poderes?.sede_sanguis?.custo === 0);
    ok("API. recuperacaoSangue", s?.recuperacaoSangue?.habilitado === true);
    ok("API. pontos preservados", JSON.stringify(r.json?.config?.pontos) === JSON.stringify(pontosAntes ?? r.json?.config?.pontos));
  }

  // ---------- 3a. P3: custo inválido não pode apagar config silenciosamente ----------
  {
    const { ctx, page } = await novaPagina(cookie);
    await abrirRegrasSangue(page);
    const painel = page.locator(".painel-sangue");
    const endpoint = `/campaigns/${campId}/regras/config`;
    let putsConfig = 0;
    page.on("request", (request) => {
      if (request.method() === "PUT" && request.url().includes(endpoint)) putsConfig += 1;
    });

    const custo = painel.locator('input[aria-label="Custo de Sangue do Poder Chicote Sanguíneo"]');
    await custo.fill("-1");
    await painel.getByRole("button", { name: "Salvar Pontos de Sangue" }).click();
    await painel.locator(".erro").waitFor({ timeout: 5000 });
    const erroCusto = await painel.locator(".erro").textContent();
    ok("P3. custo negativo identifica o Poder e explica a regra",
      /Chicote Sanguíneo/.test(erroCusto) && /maior ou igual a zero/.test(erroCusto), erroCusto);
    ok("P3. custo inválido não envia PUT", putsConfig === 0, `PUTs=${putsConfig}`);

    const antesZero = await req(BASE, "GET", `/campaigns/${campId}/regras`, { cookie });
    ok("P3. custo anterior permanece após tentativa inválida",
      antesZero.json?.config?.sangue?.poderes?.chicote_sanguineo?.custo === 2);

    const respostaPut = page.waitForResponse((response) =>
      response.request().method() === "PUT" && response.url().includes(endpoint), { timeout: 10000 });
    await custo.fill("0");
    await painel.getByRole("button", { name: "Salvar Pontos de Sangue" }).click();
    const resposta = await respostaPut;
    ok("P3. custo zero é aceito e salva", resposta.ok(), `HTTP ${resposta.status()}`);
    ok("P3. custo zero persiste sem ser tratado como vazio",
      (await req(BASE, "GET", `/campaigns/${campId}/regras`, { cookie }))
        .json?.config?.sangue?.poderes?.chicote_sanguineo?.custo === 0);
    await ctx.close();
  }

  // ---------- 3b. P2: esvaziar seções-objeto realmente limpa (merge parcial) ----------
  {
    const { ctx, page } = await novaPagina(cookie);
    await abrirRegrasSangue(page);
    const painel = page.locator(".painel-sangue");

    // Escalares: opção vazia bloqueada quando há vínculo (não promete limpeza impossível)
    // Enquanto `campos` carrega, o select tem DOIS option[value=""] (placeholder +
    // "Carregando…"): aguardar o término do loading e usar .first() para o
    // locator ser determinístico (o placeholder é sempre o primeiro).
    await painel.locator('#sangue-campo-capacidade option', { hasText: "Carregando campos" })
      .waitFor({ state: "detached", timeout: 15000 });
    const opcaoVaziaCap = await painel.locator('#sangue-campo-capacidade option[value=""]').first().getAttribute("disabled");
    ok("P2. select capacidade: opção vazia desabilitada com vínculo", opcaoVaziaCap !== null, `disabled=${opcaoVaziaCap}`);
    const dicaVinculo = await painel.locator(".meta", { hasText: "não podem ser removidos" }).count();
    ok("P2. dica de vínculo não-removível visível", dicaVinculo >= 1);

    // Esvazia naturezas (3 linhas), custos de Poder e recuperação
    for (let i = 0; i < 3; i++) {
      await painel.locator(".sangue-natureza").first().locator("button", { hasText: "✕" }).click();
    }
    await painel.locator('input[aria-label="Custo de Sangue do Poder Chicote Sanguíneo"]').fill("");
    await painel.locator('input[aria-label="Custo de Sangue do Poder Sede de Sangue"]').fill("");
    await painel.locator('input[aria-label="Habilitar sinalizador de recuperação"]').uncheck();
    await painel.locator('input[aria-label="Habilitar ação Descansar"]').uncheck();
    await painel.locator('input[aria-label="Habilitar ação Alimentar-se"]').uncheck();

    await painel.getByRole("button", { name: "Salvar Pontos de Sangue" }).click();
    await painel.locator(".online").waitFor({ timeout: 15000 });
    await ctx.close();

    const r2 = await req(BASE, "GET", `/campaigns/${campId}/regras`, { cookie });
    const s2 = r2.json?.config?.sangue;
    ok("P2. naturezas esvaziadas persistem vazias", s2?.naturezas !== undefined && Object.keys(s2.naturezas ?? {}).length === 0, JSON.stringify(s2?.naturezas));
    ok("P2. poderes esvaziados persistem vazios", s2?.poderes !== undefined && Object.keys(s2.poderes ?? {}).length === 0, JSON.stringify(s2?.poderes));
    ok("P2. recuperacaoSangue esvaziada persiste vazia", s2?.recuperacaoSangue !== undefined && Object.keys(s2.recuperacaoSangue ?? {}).length === 0, JSON.stringify(s2.recuperacaoSangue));
    ok("P2. escalares preservados (merge parcial)", s2?.campoCapacidadeId === "sangue_nivel" && s2?.campoNaturezaId === "natureza", `cap=${s2?.campoCapacidadeId} nat=${s2?.campoNaturezaId}`);
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
