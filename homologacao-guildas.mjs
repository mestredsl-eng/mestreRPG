#!/usr/bin/env node
// Homologação E2E — hierarquia de contas (Issue #65): guildas, GM e
// multi-ADMIN na interface. Cobre criação de guilda pela UI, gestão de
// membros com escopo de papel, badges de GM/ADMIN no painel e
// concessão/revogação de ADMIN pelo administrador principal.
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

const DIR = dirTeste("guildas-e2e");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const SHOTS = join(process.cwd(), "_evidencias", "guildas");
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

  const cenario = await criarCenario(BASE, BANCO, { campanha: "Campanha Guildas", jogadores: { a: "jogadora_a", b: "jogador_b", c: "jogador_c" } });
  console.log("seed ok");

  browser = await chromium.launch();

  sec("Admin cria guilda pela UI");
  const ctxAdmin = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pgAdmin = await ctxAdmin.newPage();
  const erros = [];
  pgAdmin.on("pageerror", (e) => erros.push(String(e)));
  await login(pgAdmin, "mestre_teste", "senha-forte-123");

  await btnNav(pgAdmin, "Guildas").click();
  await pgAdmin.getByRole("button", { name: "Nova guilda" }).click();
  await pgAdmin.getByLabel("Nome da guilda").fill("Guilda do Trono");
  await pgAdmin.getByRole("button", { name: "Criar guilda" }).click();
  await pgAdmin.waitForTimeout(800);
  t("guilda criada e aberta", await pgAdmin.getByRole("heading", { name: "Guilda do Trono" }).isVisible());
  t("papel GM exibido", await pgAdmin.getByText("GM", { exact: true }).first().isVisible());
  const listaGuildasCriadas = await req(BASE, "GET", "/guildas", { cookie: cenario.cookieMestre });
  const guildId = listaGuildasCriadas.json?.guildas?.find((g) => g.name === "Guilda do Trono")?.id;
  t("ID real da guilda disponível para a homologação Socket.IO", !!guildId);
  // <option> dentro de <select> fechado não tem caixa visível — a
  // asserção é por presença no DOM, não por waitFor de visibilidade
  await pgAdmin.waitForTimeout(500);
  t("ADMIN vê campanhas candidatas de terceiros",
    (await pgAdmin.locator("option", { hasText: "Campanha Guildas" }).count()) > 0);
  await shot(pgAdmin, "guilda-detalhe");

  sec("GM adiciona e promove membro pela UI");
  await pgAdmin.getByPlaceholder("Nome de usuário existente").fill("jogadora_a");
  await pgAdmin.getByRole("button", { name: "Adicionar", exact: true }).click();
  await pgAdmin.waitForTimeout(800);
  t("membro adicionada à tabela", await pgAdmin.getByText("jogadora_a").isVisible());
  const linhaA = pgAdmin.locator("tr", { hasText: "jogadora_a" });
  await linhaA.getByRole("button", { name: "Promover a GM" }).click();
  await pgAdmin.waitForTimeout(800);
  t("jogadora promovida a GM", await linhaA.getByText("GM", { exact: true }).isVisible());
  // jogador_b entra como MEMBRO comum (sem promoção) — cobre a leitura
  // de detalhes da guilda por quem não tem papel de gestão
  await pgAdmin.getByPlaceholder("Nome de usuário existente").fill("jogador_b");
  await pgAdmin.getByRole("button", { name: "Adicionar", exact: true }).click();
  await pgAdmin.waitForTimeout(800);
  t("jogador_b adicionado como membro comum", await pgAdmin.locator("tr", { hasText: "jogador_b" }).isVisible());

  sec("Membro comum não gerencia — UI esconde ações");
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pgA = await ctxA.newPage();
  await login(pgA, "jogadora_a", "senha-jogador-123");
  await btnNav(pgA, "Guildas").click();
  await pgA.locator("tr", { hasText: "Guilda do Trono" }).getByRole("button", { name: "Abrir" }).click();
  await pgA.waitForTimeout(800);
  t("membro vê a guilda", await pgA.getByRole("heading", { name: "Guilda do Trono" }).isVisible());
  t("membro vê próprio papel GM", await pgA.getByText(/GM — você gerencia/).isVisible().catch(() => pgA.getByText("GM").first().isVisible()));
  t("sem formulário de adicionar para... (ela é GM agora)", await pgA.getByPlaceholder("Nome de usuário existente").isVisible());
  // GM não é ADMIN nem mestre da "Campanha Guildas" — ela não pode
  // aparecer como candidata de vínculo (vazamento seria visível aqui)
  t("GM não vê campanhas que não opera como candidatas", (await pgA.getByRole("option", { name: /Campanha Guildas/ }).count()) === 0);

  sec("Membro comum abre a guilda sem controles de gestão");
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pgB = await ctxB.newPage();
  await login(pgB, "jogador_b", "senha-jogador-123");
  await btnNav(pgB, "Guildas").click();
  await pgB.waitForTimeout(800);
  await pgB.locator("tr", { hasText: "Guilda do Trono" }).getByRole("button", { name: "Abrir" }).click();
  await pgB.waitForTimeout(1000);
  t("membro comum vê o detalhe da guilda", await pgB.getByRole("heading", { name: "Guilda do Trono" }).isVisible());
  t("membro comum vê o roster", await pgB.getByRole("heading", { name: /Membros \(/ }).isVisible());
  t("membro comum vê campanhas vinculadas", await pgB.getByRole("heading", { name: /Campanhas vinculadas/ }).isVisible());
  t("sem formulário de gestão para membro comum", (await pgB.getByPlaceholder("Nome de usuário existente").count()) === 0);
  t("sem coluna de ações para membro comum", (await pgB.getByRole("columnheader", { name: "Ações" }).count()) === 0);
  t("sem erro de carregamento para membro comum", (await pgB.locator(".erro").count()) === 0);
  await shot(pgB, "guilda-membro-comum");

  sec("Mudanças de papel e remoção propagadas em tempo real");
  const linhaBNoAdmin = pgAdmin.locator("tr", { hasText: "jogador_b" });
  await linhaBNoAdmin.getByRole("button", { name: "Promover a GM" }).click();
  // Sem refresh manual: o membro afetado e outro membro já conectado
  // devem reler os papéis persistidos ao receber guilda:atualizada.
  await pgB.getByText(/GM — você gerencia membros/).waitFor({ timeout: 10000 });
  await pgA.locator("tr", { hasText: "jogador_b" }).getByText("GM", { exact: true }).waitFor({ timeout: 10000 });
  t("promoção a GM aparece no cliente afetado sem recarregar", await pgB.getByText(/GM — você gerencia membros/).isVisible());
  t("promoção a GM aparece para outro membro conectado sem recarregar",
    await pgA.locator("tr", { hasText: "jogador_b" }).getByText("GM", { exact: true }).isVisible());

  // Segura uma leitura 200 iniciada antes da remoção. A resposta 403
  // disparada pelo evento de remoção deve vencer; ao liberar o 200 antigo,
  // ele não pode repovoar a tela com dados obsoletos.
  let liberarRespostaAntiga = () => {};
  let sinalizarRespostaAntiga = () => {};
  const esperaLiberacaoAntiga = new Promise((resolve) => { liberarRespostaAntiga = resolve; });
  const respostaAntigaRetida = new Promise((resolve) => { sinalizarRespostaAntiga = resolve; });
  let reterProximaLeitura = true;
  let statusRespostaAntiga = 0;
  await pgB.route(`${BASE}/api/guildas/${guildId}`, async (route) => {
    if (route.request().method() !== "GET" || !reterProximaLeitura) return route.continue();
    reterProximaLeitura = false;
    const resposta = await route.fetch();
    statusRespostaAntiga = resposta.status();
    sinalizarRespostaAntiga();
    await esperaLiberacaoAntiga;
    return route.fulfill({ response: resposta });
  });
  const atualizarDescricao = await req(BASE, "PATCH", `/guildas/${guildId}`, {
    cookie: cenario.cookieMestre,
    body: { description: "Atualização usada para testar resposta HTTP obsoleta" },
  });
  t("mutação de guilda aceita para iniciar leitura antiga", atualizarDescricao.status === 200);
  await Promise.race([
    respostaAntigaRetida,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout segurando leitura antiga da guilda")), 10000)),
  ]);
  t("leitura 200 antiga foi retida antes da remoção", statusRespostaAntiga === 200);

  await linhaBNoAdmin.getByRole("button", { name: "Remover", exact: true }).click();
  // A API passa a responder 403 para o removido; a tela limpa dados e
  // controles antigos assim que chega o evento privado do servidor.
  await pgB.getByRole("button", { name: "Voltar", exact: true }).waitFor({ timeout: 10000 });
  await pgB.getByText(/Sem acesso a esta guilda/).waitFor({ timeout: 10000 });

  // Entrega por último a resposta 200 iniciada quando o usuário ainda era
  // membro. A geração mais nova deve descartar esse resultado obsoleto.
  liberarRespostaAntiga();
  await pgB.waitForTimeout(250);
  await pgB.unroute(`${BASE}/api/guildas/${guildId}`);
  await pgA.locator("tr", { hasText: "jogador_b" }).waitFor({ state: "detached", timeout: 10000 });
  t("remoção revoga a tela aberta do membro sem refresh manual",
    (await pgB.getByRole("heading", { name: "Guilda do Trono" }).count()) === 0
      && (await pgB.locator(".erro").count()) > 0);
  t("resposta 200 antiga não repovoa o detalhe após 403", statusRespostaAntiga === 200
    && (await pgB.getByRole("heading", { name: "Guilda do Trono" }).count()) === 0
    && (await pgB.getByText(/Sem acesso a esta guilda/).count()) > 0);
  t("outro membro conectado recebe roster atualizado sem o removido",
    (await pgA.locator("tr", { hasText: "jogador_b" }).count()) === 0);


  sec("Transferência de campanha entre guildas propaga para origem e destino");
  const campId = cenario.campId;
  // guilda de destino criada via API — o ADMIN é GM das duas
  const criaB = await req(BASE, "POST", "/guildas", { cookie: cenario.cookieMestre, body: { name: "Guilda do Abismo" } });
  const guildBId = criaB.json?.guilda?.id;
  t("guilda de destino criada", criaB.status === 201 && !!guildBId, JSON.stringify(criaB.json));

  // gravador de eventos privados guilda:atualizada no socket do ADMIN
  // (ele recebe eventos de todas as guildas por ser admin ativo)
  await pgAdmin.evaluate(() => {
    window.__evtGuilda = [];
    window.__mesaSocket?.on("guilda:atualizada", (e) => { window.__evtGuilda.push(e); });
  });
  const eventosGuilda = () => pgAdmin.evaluate(() => window.__evtGuilda ?? []);

  // vínculo inicial na guilda A — somente A pode ser notificada
  const vincA = await req(BASE, "PUT", `/guildas/${guildId}/campanhas/${campId}`, { cookie: cenario.cookieMestre, body: { acao: "vincular" } });
  t("campanha vinculada à guilda A", vincA.status === 200, String(vincA.status));
  await pgAdmin.getByRole("heading", { name: "Campanhas vinculadas (1)" }).waitFor({ timeout: 10000 });
  await pgAdmin.waitForTimeout(400);
  let evts = await eventosGuilda();
  t("vínculo inicial notifica só a guilda A",
    evts.length === 1 && evts[0].guildId === guildId && evts[0].tipo === "campanha_vinculada",
    JSON.stringify(evts));

  // operação idempotente (já vinculada à A) não pode gerar eventos
  const vincA2 = await req(BASE, "PUT", `/guildas/${guildId}/campanhas/${campId}`, { cookie: cenario.cookieMestre, body: { acao: "vincular" } });
  t("vínculo repetido aceito sem efeito", vincA2.status === 200, String(vincA2.status));
  await pgAdmin.waitForTimeout(400);
  evts = await eventosGuilda();
  t("vínculo idempotente não emite eventos", evts.length === 1, JSON.stringify(evts));

  // segunda tela ADMIN aberta já no detalhe da guilda B
  const ctxAdmin2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pgAdmin2 = await ctxAdmin2.newPage();
  await login(pgAdmin2, "mestre_teste", "senha-forte-123");
  await btnNav(pgAdmin2, "Guildas").click();
  await pgAdmin2.waitForTimeout(800);
  await pgAdmin2.locator("tr", { hasText: "Guilda do Abismo" }).getByRole("button", { name: "Abrir" }).click();
  await pgAdmin2.getByRole("heading", { name: "Guilda do Abismo" }).waitFor({ timeout: 10000 });
  await pgAdmin2.getByRole("heading", { name: "Campanhas vinculadas (0)" }).waitFor({ timeout: 10000 });

  // transferência A → B: origem remove sem reload, destino recebe sem reload
  const transf = await req(BASE, "PUT", `/guildas/${guildBId}/campanhas/${campId}`, { cookie: cenario.cookieMestre, body: { acao: "vincular" } });
  t("transferência A→B aceita", transf.status === 200, String(transf.status));
  await pgAdmin.getByRole("heading", { name: "Campanhas vinculadas (0)" }).waitFor({ timeout: 10000 });
  await pgAdmin2.getByRole("heading", { name: "Campanhas vinculadas (1)" }).waitFor({ timeout: 10000 });
  await pgAdmin2.locator("tr", { hasText: "Campanha Guildas" }).waitFor({ timeout: 10000 });
  t("guilda de origem remove a campanha sem reload", (await pgAdmin.locator("tr", { hasText: "Campanha Guildas" }).count()) === 0);
  t("guilda de destino recebe a campanha sem reload", (await pgAdmin2.locator("tr", { hasText: "Campanha Guildas" }).count()) === 1);

  await pgAdmin.waitForTimeout(400);
  evts = await eventosGuilda();
  // multiconjunto exato: vínculo inicial em A + par origem/destino da
  // transferência. Qualquer evento extra (duplicado, guilda errada,
  // tipo trocado) reprova.
  const contagem = {};
  for (const e of evts) { const k = `${e.guildId}:${e.tipo}`; contagem[k] = (contagem[k] ?? 0) + 1; }
  const esperados = [`${guildId}:campanha_vinculada`, `${guildId}:campanha_desvinculada`, `${guildBId}:campanha_vinculada`];
  const semEventosInadequados = evts.length === esperados.length
    && esperados.every((k) => contagem[k] === 1);
  t("origem notificada como desvinculada e destino como vinculada", semEventosInadequados, JSON.stringify(evts));
  await shot(pgAdmin2, "guilda-destino-transferencia");

  const ctxC = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pgC = await ctxC.newPage();
  await login(pgC, "jogador_c", "senha-jogador-123");
  await btnNav(pgC, "Guildas").click();
  await pgC.waitForTimeout(800);
  t("não-membro não vê a guilda", !(await pgC.getByText("Guilda do Trono").count()));
  await shot(pgC, "guildas-vazio");

  sec("Painel ADMIN — badges e concessão de ADMIN");
  await btnNav(pgAdmin, "Administração").click();
  await pgAdmin.waitForTimeout(1000);
  t("badge GM visível no painel", await pgAdmin.getByText("GM — Guilda do Trono").first().isVisible());
  const linhaJogadora = pgAdmin.locator("tr", { hasText: "jogadora_a" });
  await linhaJogadora.getByRole("button", { name: "Tornar ADMIN" }).click();
  await pgAdmin.waitForTimeout(1000);
  t("jogadora vira ADMIN", await linhaJogadora.getByText("Administrador", { exact: false }).first().isVisible());

  sec("Novo ADMIN acessa painel; revogação derruba acesso");
  const ctxA2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pgA2 = await ctxA2.newPage();
  await login(pgA2, "jogadora_a", "senha-jogador-123");
  t("aba Administração visível para novo ADMIN", await btnNav(pgA2, "Administração").isVisible());
  await shot(pgA2, "admin-badge");

  const linhaJogadora2 = pgAdmin.locator("tr", { hasText: "jogadora_a" });
  await linhaJogadora2.getByRole("button", { name: "Revogar ADMIN" }).click();
  await pgAdmin.waitForTimeout(1000);
  // sessão da jogadora é derrubada na revogação — /auth/me passa a falhar
  const me = await req(BASE, "GET", "/auth/me", { cookie: cenario.jogadores.a.cookie });
  t("sessão derrubada após revogação", me.status === 401, String(me.status));

  sec("Conta exibe escopo de guilda");
  await btnNav(pgAdmin, "Conta").click();
  await pgAdmin.getByRole("button", { name: "Atualizar" }).click();
  await pgAdmin.waitForTimeout(800);
  t("conta mostra ADMIN principal", await pgAdmin.getByText("Administrador principal").first().isVisible());
  t("conta lista guilda com papel GM", await pgAdmin.getByText(/GM — Guilda do Trono/).isVisible());
  await shot(pgAdmin, "conta-escopo");

  t("sem erros de página", erros.length === 0, erros.join(" | "));
} finally {
  await browser?.close();
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
