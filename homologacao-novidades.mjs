#!/usr/bin/env node
// Homologação E2E — Central de Novidades (Issue #42).
// Cobre: CRUD admin pela UI, publicação, badge de não lidas no menu,
// leitura individual (A lê / B não), rascunho invisível, responsivo
// desktop e mobile 390px.
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

const DIR = dirTeste("novidades-e2e");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const SHOTS = join(process.cwd(), "_evidencias", "novidades");
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

  const cenario = await criarCenario(BASE, BANCO, { campanha: "Campanha Novidades", jogadores: { a: "usuario_a", b: "usuario_b" } });
  console.log("seed ok");

  browser = await chromium.launch();

  // ===== Desktop — administração =====
  sec("Desktop — admin cria e publica");
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const erros = [];
    page.on("pageerror", (e) => erros.push(String(e)));
    await login(page, "mestre_teste", "senha-forte-123");

    // rascunhos via API: um será publicado pela UI, outro permanece oculto
    const rasc = await req(BASE, "POST", "/admin/novidades", {
      cookie: cenario.cookieMestre,
      body: { titulo: "Rascunho secreto", conteudo: "não deve aparecer", estado: "rascunho" },
    });
    t("rascunho criado via API", rasc.status === 201);
    const oculto = await req(BASE, "POST", "/admin/novidades", {
      cookie: cenario.cookieMestre,
      body: { titulo: "Rascunho oculto", conteudo: "invisível para usuários", estado: "rascunho" },
    });
    t("segundo rascunho criado", oculto.status === 201);

    await btnNav(page, "Administração").click();
    await page.waitForTimeout(800);
    await page.getByRole("button", { name: "Nova publicação" }).click();
    await page.getByLabel("Título").fill("Central de Novidades no ar");
    await page.getByLabel("Resumo").fill("Agora você acompanha as atualizações aqui.");
    await page.getByLabel("Conteúdo").fill("Linha 1 do conteúdo\nLinha 2 do conteúdo");
    await page.getByLabel("Versão").fill("1.1.0");
    await page.getByLabel("Categoria").selectOption("novidade");
    await page.getByLabel("Estado").selectOption("publicada");
    await page.getByRole("button", { name: "Salvar", exact: true }).click();
    await page.waitForTimeout(800);
    t("publicação aparece na tabela admin", await page.locator("tr", { hasText: "Central de Novidades no ar" }).count() === 1);
    t("badge Publicada visível", await page.locator("tr", { hasText: "Central de Novidades no ar" }).locator(".badge", { hasText: "Publicada" }).count() === 1);
    t("badge Rascunho visível", await page.locator("tr", { hasText: "Rascunho secreto" }).locator(".badge", { hasText: "Rascunho" }).count() === 1);

    // publica o rascunho pela UI
    const linhaRasc = page.locator("tr", { hasText: "Rascunho secreto" });
    await linhaRasc.getByRole("button", { name: "Publicar" }).click();
    await page.waitForTimeout(600);
    t("rascunho publicado pela UI", await linhaRasc.locator(".badge", { hasText: "Publicada" }).count() === 1);

    await shot(page, "01-admin-novidades");
    t("sem erros de console (admin)", erros.length === 0, erros.slice(0, 2).join(" | "));
    await ctx.close();
  }

  // ===== Desktop — usuário comum =====
  sec("Desktop — usuário lê novidades");
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const erros = [];
    page.on("pageerror", (e) => erros.push(String(e)));
    await login(page, "usuario_a", "senha-jogador-123");

    const badge = page.locator(".contador-nao-lidas");
    await page.waitForTimeout(600);
    t("badge de não lidas aparece", await badge.count() === 1, `n=${await badge.count()}`);
    t("badge conta 2 publicadas", (await badge.textContent()) === "2", await badge.textContent());

    await btnNav(page, "Novidades").click();
    await page.waitForTimeout(800);
    const itens = page.locator(".novidade-item");
    t("2 publicações listadas", await itens.count() === 2, `n=${await itens.count()}`);
    t("rascunho não listado", await page.getByText("Rascunho oculto").count() === 0);
    t("itens não lidos marcados", await page.locator(".novidade-item.nao-lida").count() === 2);

    // abre a primeira → marca como lida
    const tituloAberto = (await itens.first().locator(".novidade-titulo").textContent())?.trim() ?? "";
    await itens.first().click();
    await page.waitForTimeout(800);
    t("modal com conteúdo", await page.locator(".conteudo-novidade").count() === 1);
    t("badge diminui para 1", (await badge.textContent()) === "1", await badge.textContent());
    await page.getByRole("button", { name: "Fechar" }).click();
    await page.waitForTimeout(400);
    t("item lido perde destaque", await page.locator(".novidade-item.nao-lida").count() === 1);
    await shot(page, "02-usuario-novidades");

    // refresh → estado persiste
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(600);
    await btnNav(page, "Novidades").click();
    await page.waitForTimeout(600);
    t("após refresh: 1 não lida", await page.locator(".novidade-item.nao-lida").count() === 1);
    t("badge persiste = 1", (await badge.textContent()) === "1", await badge.textContent());
    t("sem erros de console (usuário)", erros.length === 0, erros.slice(0, 2).join(" | "));
    await ctx.close();
  }

  // ===== Isolamento A/B =====
  sec("Isolamento por usuário");
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await login(page, "usuario_b", "senha-jogador-123");
    await page.waitForTimeout(500);
    t("B vê as 2 como não lidas", (await page.locator(".contador-nao-lidas").textContent()) === "2");
    await btnNav(page, "Novidades").click();
    await page.waitForTimeout(700);
    t("B: ambas não lidas", await page.locator(".novidade-item.nao-lida").count() === 2);
    await ctx.close();
  }

  // ===== Admin vê contagem de leituras =====
  sec("Admin — contagem de leituras");
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await login(page, "mestre_teste", "senha-forte-123");
    await btnNav(page, "Administração").click();
    await page.waitForTimeout(800);
    // a publicação que A abriu deve ter exatamente 1 leitura; a outra, 0
    const adminList = await req(BASE, "GET", "/admin/novidades", { cookie: cenario.cookieMestre });
    const pubs = adminList.json?.novidades ?? [];
    const lidas = pubs.filter((n) => n.titulo === "Central de Novidades no ar" || n.titulo === "Rascunho secreto").map((n) => n.leituras);
    t("admin vê leituras corretas por publicação", lidas.length === 2 && lidas.reduce((a, b) => a + b, 0) === 1 && Math.max(...lidas) === 1, JSON.stringify(lidas));
    t("contagem visível na tabela admin", await page.locator("td", { hasText: /^1$/ }).count() >= 1);
    await ctx.close();
  }

  // ===== Admin em telas pequenas — cartões com todas as ações =====
  sec("Admin mobile — ações em cartões");
  {
    // rascunho dedicado para exercitar publicar/despublicar/remover no mobile
    const mob = await req(BASE, "POST", "/admin/novidades", {
      cookie: cenario.cookieMestre,
      body: { titulo: "Rascunho mobile", conteudo: "editável pelo celular", estado: "rascunho" },
    });
    t("rascunho mobile criado", mob.status === 201);

    for (const largura of [390, 600]) {
      // cada viewport precisa do seu próprio rascunho (o de 390px é removido no fluxo)
      const tituloAlvo = largura === 390 ? "Rascunho mobile" : "Rascunho mobile 600";
      if (largura === 600) {
        await req(BASE, "POST", "/admin/novidades", {
          cookie: cenario.cookieMestre,
          body: { titulo: tituloAlvo, conteudo: "ações em 600px", estado: "rascunho" },
        });
      }
      const ctx = await browser.newContext({ viewport: { width: largura, height: 844 } });
      const page = await ctx.newPage();
      const erros = [];
      page.on("pageerror", (e) => erros.push(String(e)));
      await login(page, "mestre_teste", "senha-forte-123");
      await btnNav(page, "Administração").click();
      await page.waitForTimeout(800);

      const tabela = page.locator("table.tabela-novidades");
      const cartoes = page.locator(".cartoes-registro .registro-cartao");
      t(`${largura}px: tabela ocultada`, !(await tabela.isVisible()));
      t(`${largura}px: cartões visíveis`, await cartoes.count() >= 3, `n=${await cartoes.count()}`);

      const cartao = page.locator(".registro-cartao", { hasText: tituloAlvo });
      t(`${largura}px: cartão do rascunho existe`, await cartao.count() === 1);
      const acoes = cartao.locator(".registro-acoes");
      for (const rotulo of ["Editar", "Publicar", "Remover"]) {
        t(`${largura}px: ação '${rotulo}' acessível`, await acoes.getByRole("button", { name: rotulo, exact: true }).isVisible());
      }

      if (largura === 390) {
        // publicar -> despublicar -> editar -> remover, tudo pelo celular
        await acoes.getByRole("button", { name: "Publicar", exact: true }).click();
        await page.waitForTimeout(600);
        t("390px: publicou pelo cartão", await cartao.locator(".badge", { hasText: "Publicada" }).count() === 1);
        await cartao.locator(".registro-acoes").getByRole("button", { name: "Despublicar", exact: true }).click();
        await page.waitForTimeout(600);
        t("390px: despublicou pelo cartão", await cartao.locator(".badge", { hasText: "Rascunho" }).count() === 1);
        await cartao.locator(".registro-acoes").getByRole("button", { name: "Editar", exact: true }).click();
        await page.waitForTimeout(500);
        await page.getByLabel("Título").fill("Rascunho mobile (editado)");
        await page.getByRole("button", { name: "Salvar", exact: true }).click();
        await page.waitForTimeout(700);
        t("390px: editou pelo modal", await page.locator(".registro-cartao", { hasText: "Rascunho mobile (editado)" }).count() === 1);
        await page.locator(".registro-cartao", { hasText: "Rascunho mobile (editado)" })
          .locator(".registro-acoes").getByRole("button", { name: "Remover", exact: true }).click();
        await page.waitForTimeout(400);
        await page.locator(".modal").getByRole("button", { name: "Remover", exact: true }).click(); // ModalConfirmar
        await page.waitForTimeout(700);
        t("390px: removeu com confirmação", await page.locator(".registro-cartao", { hasText: "Rascunho mobile" }).count() === 0);
        await shot(page, "04-admin-mobile-390");
      } else {
        await shot(page, "05-admin-mobile-600");
      }
      t(`${largura}px: sem erros de console`, erros.length === 0, erros.slice(0, 2).join(" | "));
      await ctx.close();
    }
  }

  // ===== Mobile 390px — usuário =====
  sec("Mobile 390px — usuário");
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const erros = [];
    page.on("pageerror", (e) => erros.push(String(e)));
    await login(page, "usuario_b", "senha-jogador-123");
    await page.waitForTimeout(500);
    await btnNav(page, "Novidades").click();
    await page.waitForTimeout(700);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    t("mobile: sem overflow horizontal", overflow <= 1, `overflow=${overflow}px`);
    t("mobile: badge visível", await page.locator(".contador-nao-lidas").count() === 1);
    await page.locator(".novidade-item").first().click();
    await page.waitForTimeout(700);
    t("mobile: modal abre com conteúdo", await page.locator(".conteudo-novidade").count() === 1);
    const overflowModal = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    t("mobile: modal sem overflow", overflowModal <= 1, `overflow=${overflowModal}px`);
    await shot(page, "03-mobile-novidade");
    t("sem erros de console (mobile)", erros.length === 0, erros.slice(0, 2).join(" | "));
    await ctx.close();
  }

  // ===== Tempo real — toast + contador sem navegar =====
  sec("Tempo real — notificação push");
  {
    // usuário comum fica na aba Painel (fora de Novidades); admin publica via API
    const ctxU = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageU = await ctxU.newPage();
    const errosU = [];
    pageU.on("pageerror", (e) => errosU.push(String(e)));
    // "Failed to load resource ... 401" é o /auth/me anônimo do bootstrap —
    // ruído de rede esperado antes do login, não erro da aplicação.
    const erroUtil = (m) => m.type() === "error" && !/Failed to load resource/.test(m.text());
    pageU.on("console", (m) => { if (erroUtil(m)) errosU.push(m.text()); });
    await login(pageU, "usuario_a", "senha-jogador-123");
    await pageU.waitForTimeout(800);
    const badgeAntes = await pageU.locator(".contador-nao-lidas").textContent().catch(() => null);

    const pubRT = await req(BASE, "POST", "/admin/novidades", {
      cookie: cenario.cookieMestre,
      body: { titulo: "Novidade em tempo real", conteudo: "corpo secreto não vai no evento", estado: "publicada", categoria: "novidade" },
    });
    t("publicação RT criada", pubRT.status === 201);
    const toast = pageU.locator(".notificacao-info", { hasText: "Nova publicação: Novidade em tempo real" });
    t("toast aparece fora da aba Novidades", await toast.count() === 1, `n=${await toast.count()}`);
    await pageU.waitForTimeout(600);
    const badgeDepois = await pageU.locator(".contador-nao-lidas").textContent();
    t("contador incrementado sem navegação", badgeAntes && badgeDepois && Number(badgeDepois) === Number(badgeAntes) + 1, `${badgeAntes} -> ${badgeDepois}`);
    t("usuário continua na aba Painel", await pageU.locator(".topo nav button.ativo").textContent().then((x) => /Painel/i.test(x ?? "")));

    // edição de conteúdo publicada -> nova revisão -> novo toast (dedup por revisão)
    await req(BASE, "PATCH", `/admin/novidades/${pubRT.json.novidade.id}`, {
      cookie: cenario.cookieMestre, body: { conteudo: "conteúdo revisado RT" },
    });
    const toasts2 = pageU.locator(".notificacao-info", { hasText: "Nova publicação: Novidade em tempo real" });
    // O primeiro toast ainda deve estar visível; a edição precisa criar um segundo.
    await pageU.waitForFunction(() =>
      [...document.querySelectorAll(".notificacao-info")].filter((el) =>
        el.textContent?.includes("Nova publicação: Novidade em tempo real")
      ).length === 2,
      null,
      { timeout: 4000 },
    ).catch(() => {});
    const toastsAposRevisao = await toasts2.count();
    t("nova revisão gera segundo toast", toastsAposRevisao === 2, `n=${toastsAposRevisao}`);

    // despublicar não gera toast
    await req(BASE, "POST", `/admin/novidades/${pubRT.json.novidade.id}/despublicar`, { cookie: cenario.cookieMestre });
    await pageU.waitForTimeout(800);
    t("despublicar não gera toast", await toasts2.count() === toastsAposRevisao && toastsAposRevisao === 2, `n=${await toasts2.count()}`);
    await shot(pageU, "06-tempo-real-desktop");
    t("sem erros de console (RT desktop)", errosU.length === 0, errosU.slice(0, 2).join(" | "));
    await ctxU.close();

    // mobile 390px — mesmo fluxo
    const ctxM = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const pageM = await ctxM.newPage();
    const errosM = [];
    pageM.on("pageerror", (e) => errosM.push(String(e)));
    pageM.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errosM.push(m.text()); });
    await login(pageM, "usuario_b", "senha-jogador-123");
    await pageM.waitForTimeout(800);
    await req(BASE, "POST", "/admin/novidades", {
      cookie: cenario.cookieMestre,
      body: { titulo: "RT mobile 390", conteudo: "x", estado: "publicada" },
    });
    const toastM = pageM.locator(".notificacao-info", { hasText: "Nova publicação: RT mobile 390" });
    t("mobile 390px: toast aparece", await toastM.count() === 1, `n=${await toastM.count()}`);
    await pageM.waitForTimeout(500);
    t("mobile: badge atualizado", await pageM.locator(".contador-nao-lidas").count() === 1);
    const ov = await pageM.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    t("mobile RT: sem overflow", ov <= 1, `overflow=${ov}px`);
    await shot(pageM, "07-tempo-real-mobile");
    t("sem erros de console (RT mobile)", errosM.length === 0, errosM.slice(0, 2).join(" | "));
    await ctxM.close();
  }

  // ===== Tempo real — lista aberta atualiza sozinha =====
  sec("Tempo real — lista de novidades ao vivo");
  {
    const ctxL = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageL = await ctxL.newPage();
    const errosL = [];
    pageL.on("pageerror", (e) => errosL.push(String(e)));
    pageL.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errosL.push(m.text()); });
    await login(pageL, "usuario_a", "senha-jogador-123");
    await btnNav(pageL, "Novidades").click();
    await pageL.waitForTimeout(800);
    const lista = pageL.locator(".lista-novidades .novidade-item");
    const nAntes = await lista.count();

    // A) nova publicação aparece na lista SEM navegar
    const pubLista = await req(BASE, "POST", "/admin/novidades", {
      cookie: cenario.cookieMestre,
      body: { titulo: "Publicada com aba aberta", conteudo: "corpo", estado: "publicada", categoria: "melhoria" },
    });
    t("A: publicação criada", pubLista.status === 201);
    const itemNovo = pageL.locator(".novidade-item", { hasText: "Publicada com aba aberta" });
    await itemNovo.waitFor({ timeout: 6000 }).catch(() => {});
    t("A: item aparece na lista sem refresh", await itemNovo.count() === 1, `n=${await itemNovo.count()}`);
    t("A: lista cresceu em 1", (await lista.count()) === nAntes + 1, `${nAntes} -> ${await lista.count()}`);
    t("A: toast emitido", await pageL.locator(".notificacao-info", { hasText: "Nova publicação: Publicada com aba aberta" }).count() === 1);
    t("A: permanece na aba Novidades", await pageL.locator(".topo nav button.ativo").textContent().then((x) => /Novidades/i.test(x ?? "")));

    // B) nova revisão: leitura anterior não vale para a nova versão
    const itemLido = pageL.locator(".novidade-item", { hasText: "Publicada com aba aberta" });
    await itemLido.click();
    await pageL.waitForTimeout(600);
    t("B: modal abriu", await pageL.locator(".conteudo-novidade").count() === 1);
    await pageL.getByRole("button", { name: "Fechar", exact: true }).click();
    await pageL.waitForTimeout(300);
    await req(BASE, "PATCH", `/admin/novidades/${pubLista.json.novidade.id}`, {
      cookie: cenario.cookieMestre, body: { conteudo: "corpo revisado v2" },
    });
    // a revisão gera toast + recarrega a lista; o item volta a não-lido
    await pageL.waitForFunction(() =>
      [...document.querySelectorAll(".novidade-item")].some((el) =>
        el.textContent?.includes("Publicada com aba aberta") && el.classList.contains("nao-lida")),
      null, { timeout: 6000 }).catch(() => {});
    t("B: revisão torna item não-lido novamente", await itemLido.evaluate((el) => el.classList.contains("nao-lida")));

    // C) modal aberto durante revisão → conteúdo antigo não fica visível
    await itemLido.click();
    await pageL.waitForTimeout(500);
    t("C: modal reaberto", await pageL.locator(".conteudo-novidade").count() === 1);
    await req(BASE, "PATCH", `/admin/novidades/${pubLista.json.novidade.id}`, {
      cookie: cenario.cookieMestre, body: { conteudo: "corpo revisado v3" },
    });
    await pageL.waitForFunction(() =>
      !document.querySelector(".conteudo-novidade") ||
      document.body.textContent?.includes("atualizada"),
      null, { timeout: 6000 }).catch(() => {});
    await pageL.waitForTimeout(400);
    const modalAindaAbertoComVelho = await pageL.locator(".conteudo-novidade").count();
    const avisoAtualizada = await pageL.locator(".notificacao-info", { hasText: "atualizada" }).count();
    t("C: modal antigo fechado ou aviso de atualização", modalAindaAbertoComVelho === 0 || avisoAtualizada >= 1,
      `modal=${modalAindaAbertoComVelho} avisos=${avisoAtualizada}`);
    t("C: usuário permanece na aba", await pageL.locator(".topo nav button.ativo").textContent().then((x) => /Novidades/i.test(x ?? "")));
    t("sem erros de console (lista viva)", errosL.length === 0, errosL.slice(0, 2).join(" | "));

    // F) mobile 390px — mesmo contexto/sessão, viewport reduzido
    // (reuso evita estourar o rate limit de login por IP)
    await pageL.setViewportSize({ width: 390, height: 844 });
    await pageL.waitForTimeout(500);
    await req(BASE, "POST", "/admin/novidades", {
      cookie: cenario.cookieMestre,
      body: { titulo: "Mobile lista viva", conteudo: "x", estado: "publicada" },
    });
    const itemMV = pageL.locator(".novidade-item", { hasText: "Mobile lista viva" });
    await itemMV.waitFor({ timeout: 6000 }).catch(() => {});
    t("F: mobile — item aparece na lista aberta", await itemMV.count() === 1, `n=${await itemMV.count()}`);
    const ovMV = await pageL.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    t("F: mobile — sem overflow", ovMV <= 1, `overflow=${ovMV}px`);
    t("F: sem erros de console (mobile lista)", errosL.length === 0, errosL.slice(0, 2).join(" | "));
    await ctxL.close();
  }

  await browser.close();
} finally {
  await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
