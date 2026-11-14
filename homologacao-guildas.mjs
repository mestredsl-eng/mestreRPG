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
