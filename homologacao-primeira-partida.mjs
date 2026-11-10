#!/usr/bin/env node
// Homologação da PRIMEIRA PARTIDA — fluxo real de uso com navegador.
// 3 contextos Playwright independentes (mestre + 2 jogadores), banco e
// dados 100% descartáveis. Cobre: setup admin, campanha, convite com
// aprovação, fichas, aprovação, mesa, chat, rolagens d4–d20, desafio
// D10, patrimônio e persistência após restart do servidor.
// O modelo de ficha é publicado via API (ferramenta de mestre já
// homologada); todo o fluxo do JOGADOR é pela interface.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("partida");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const SHOTS = join(process.cwd(), "_evidencias", "primeira-partida");
mkdirSync(SHOTS, { recursive: true });
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;

const CAMPANHA = "Crônica do Abismo";
const SISTEMA = "Sistema Teste";
const MODELO = "Ficha RPG Teste";
const J1 = { user: "jogador_um", nome: "PJ Um", senha: "senha-jogador-1" };
const J2 = { user: "jogador_dois", nome: "PJ Dois", senha: "senha-jogador-2" };
const MESTRE = { user: "mestre_ana", senha: "senha-mestre-123", nome: "Mestre Ana" };

let browser, proc, campanhaId = null;

async function shot(page, nome) {
  try { await page.screenshot({ path: join(SHOTS, `${nome}.png`), fullPage: false }); } catch { }
}
async function irCampanha(page) {
  await page.getByRole("button", { name: "Campanhas" }).click();
  await page.getByText(CAMPANHA, { exact: true }).first().click();
}
async function aba(page, nome) {
  await page.locator(".abas button", { hasText: nome }).first().click();
}
async function apiFetch(page, metodo, path, body) {
  return page.evaluate(async ([m, p, b]) => {
    const r = await fetch("/api" + p, {
      method: m,
      headers: { "content-type": "application/json" },
      body: b !== undefined ? JSON.stringify(b) : undefined,
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [metodo, path, body]);
}
async function novoJogadorConvite(page, j) {
  // cadastro de jogador pelo link de convite (ConviteCadastro → Convite)
  await page.getByLabel("Usuário").fill(j.user);
  await page.getByLabel("Nome de exibição (opcional)").fill(j.nome);
  await page.getByLabel("Senha").fill(j.senha);
  await page.getByRole("button", { name: "Criar conta e entrar" }).click();
  await page.getByRole("button", { name: "Aceitar convite" }).waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Aceitar convite" }).click();
  await page.waitForTimeout(2500); // redirect automático p/ painel
}
async function criarFichaUI(page, j) {
  await irCampanha(page);
  await aba(page, "Personagens");
  await page.getByRole("button", { name: "Novo personagem" }).click();
  await page.getByLabel("Nome do personagem").fill(j.nome);
  await page.getByLabel("Modelo de ficha").selectOption({ label: MODELO });
  await page.getByRole("button", { name: "Criar e preencher" }).click();
  // detalhe da ficha → editar → preencher FOR → enviar p/ aprovação
  await page.getByRole("button", { name: "Editar ficha" }).waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Editar ficha" }).click();
  try {
    await page.getByRole("button", { name: "Salvar", exact: true }).waitFor({ timeout: 8000 });
  } catch {
    const ainda = await page.getByRole("button", { name: "Editar ficha" }).count();
    console.log(`  [debug] modo edição não ativou; botões 'Editar ficha' restantes=${ainda}`);
    await shot(page, "debug-editar-" + j.user);
    throw new Error("modo edição da ficha não ativou");
  }
  const campoFor = page.locator("div.campo", { has: page.getByText("FOR", { exact: true }) }).locator("input").first();
  try {
    await campoFor.fill("12", { timeout: 10000 });
  } catch (e) {
    const html = await page.locator(".ficha-cartao").innerText().catch(() => "(sem .ficha-cartao)");
    const nInputs = await page.locator(".ficha-cartao input").count();
    const nSelects = await page.locator(".ficha-cartao select").count();
    const htmlFor = await page.locator(".campo", { hasText: "FOR" }).first().evaluate((el) => el.outerHTML.slice(0, 800)).catch(() => "(sem .campo FOR)");
    console.log(`  [debug ficha] inputs=${nInputs} selects=${nSelects} ::`, htmlFor.replace(/\n+/g, " ").slice(0, 800));
    await shot(page, "debug-ficha-" + j.user);
    throw e;
  }
  await page.getByRole("button", { name: "Enviar para aprovação" }).click();
  await page.getByText("Ficha enviada para aprovação").waitFor({ timeout: 10000 });
}

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);

  browser = await chromium.launch();
  const ctxM = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgM = await ctxM.newPage();
  const ctx1 = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pg1 = await ctx1.newPage();
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } }); // jogador 2 no celular
  const pg2 = await ctx2.newPage();
  pgM.on("pageerror", (e) => console.log("  [pgM erro]", String(e).slice(0, 160)));

  // ===== 1. PRIMEIRO ACESSO: mestre cria admin =====
  sec("1. Primeiro acesso — conta do mestre");
  await pgM.goto(BASE);
  await pgM.getByText("Primeiro acesso? Criar conta de administrador").click();
  await pgM.getByLabel("Usuário").fill(MESTRE.user);
  await pgM.getByLabel("Nome de exibição (opcional)").fill(MESTRE.nome);
  await pgM.getByLabel("Senha").fill(MESTRE.senha);
  await pgM.getByRole("button", { name: "Criar administrador" }).click();
  await pgM.waitForTimeout(800);
  await pgM.getByLabel("Usuário").fill(MESTRE.user);
  await pgM.getByLabel("Senha").fill(MESTRE.senha);
  await pgM.getByRole("button", { name: "Entrar", exact: true }).click();
  await pgM.getByText("Servidor online").waitFor({ timeout: 15000 });
  t("mestre criou conta admin e entrou", true);
  await shot(pgM, "01-mestre-painel");

  // ===== 2. CAMPANHA =====
  sec("2. Mestre cria campanha");
  await pgM.getByRole("button", { name: "Campanhas" }).click();
  await pgM.getByRole("button", { name: "Nova campanha" }).click();
  await pgM.getByLabel("Nome da campanha").fill(CAMPANHA);
  await pgM.getByLabel("Sistema de RPG").fill(SISTEMA);
  await pgM.getByRole("button", { name: "Criar campanha" }).click();
  await pgM.getByRole("heading", { name: CAMPANHA }).waitFor({ timeout: 15000 });
  const lista = await apiFetch(pgM, "GET", "/campaigns");
  campanhaId = lista.json?.campanhas?.find((c) => c.name === CAMPANHA)?.id;
  t("campanha criada e aberta", !!campanhaId, JSON.stringify(lista.json).slice(0, 150));
  await shot(pgM, "02-campanha");

  // ===== 3. MODELO DE FICHA publicado (API — ferramenta de mestre) =====
  sec("3. Modelo de ficha publicado (setup via API)");
  const tpl = await apiFetch(pgM, "POST", `/campaigns/${campanhaId}/sheet-templates`, { name: MODELO });
  const tplId = tpl.json?.modelo?.id, verId = tpl.json?.modelo?.versionId ?? tpl.json?.versionId;
  const estrutura = {
    versao: 1,
    secoes: [{ id: "s1", titulo: "Atributos", ordem: 0, campos: [
      { id: "for", label: "FOR", tipo: "inteiro", semantico: "habilidade", minimo: 1, maximo: 30 },
      { id: "agi", label: "AGILIDADE", tipo: "inteiro", semantico: "habilidade", minimo: 1, maximo: 30 },
    ] }],
    pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
  };
  const put = await apiFetch(pgM, "PUT", `/campaigns/${campanhaId}/sheet-templates/${tplId}/versions/${verId}`, { estrutura });
  const pub = await apiFetch(pgM, "POST", `/campaigns/${campanhaId}/sheet-templates/${tplId}/publish`, { versionId: verId });
  t("modelo de ficha criado e publicado", put.status === 200 && pub.status === 200, `put=${put.status} pub=${pub.status}`);

  // ===== 4. CONVITE com aprovação =====
  sec("4. Mestre gera convite");
  await aba(pgM, "Convites");
  await pgM.getByLabel("Exigir aprovação do mestre").check();
  await pgM.getByRole("button", { name: "Gerar convite" }).click();
  await pgM.locator(".convite-criado code").first().waitFor({ timeout: 10000 });
  const codigo = (await pgM.locator(".convite-criado code").first().textContent()).trim();
  t("convite gerado", /^[A-Z0-9-]{6,}$/.test(codigo), codigo);
  await shot(pgM, "04-convite");

  // ===== 5. JOGADORES entram pelo convite =====
  sec("5. Jogadores entram pelo link de convite");
  await pg1.goto(`${BASE}/convite?code=${codigo}`);
  await pg1.getByText(CAMPANHA).first().waitFor({ timeout: 15000 });
  await novoJogadorConvite(pg1, J1);
  await pg1.getByRole("button", { name: "Campanhas" }).waitFor({ timeout: 15000 });
  t("jogador 1 cadastrou e aceitou convite", true);

  await pg2.goto(`${BASE}/convite?code=${codigo}`);
  await pg2.getByText(CAMPANHA).first().waitFor({ timeout: 15000 });
  await novoJogadorConvite(pg2, J2);
  await pg2.getByRole("button", { name: "Campanhas" }).waitFor({ timeout: 15000 });
  t("jogador 2 cadastrou e aceitou convite (mobile)", true);
  await shot(pg2, "05-jogador2-celular");

  // ===== 6. MESTRE aprova ENTRADA dos jogadores (convite exigia aprovação) =====
  sec("6. Mestre aprova entrada dos jogadores");
  await aba(pgM, "Participantes");
  await pgM.locator("tr", { hasText: J1.user }).getByRole("button", { name: "Aprovar" }).click();
  await pgM.locator("tr", { hasText: J2.user }).getByRole("button", { name: "Aprovar" }).click();
  await pgM.waitForTimeout(1200);
  const membros = await apiFetch(pgM, "GET", `/campaigns/${campanhaId}/members`);
  const ativos = (membros.json?.membros ?? []).filter((m) => m.status === "ativo").length;
  t("2 jogadores aprovados como participantes", ativos >= 3, `ativos=${ativos}`);

  // ===== 7. FICHAS criadas pelos jogadores =====
  sec("7. Jogadores criam e enviam fichas");
  await criarFichaUI(pg1, J1);
  t("jogador 1 criou ficha e enviou p/ aprovação", true);
  await criarFichaUI(pg2, J2);
  t("jogador 2 criou ficha e enviou p/ aprovação", true);
  await shot(pg1, "06-j1-ficha");

  // ===== 8. MESTRE aprova as FICHAS =====
  sec("8. Mestre aprova as fichas");
  await aba(pgM, "Personagens");
  try {
    await pgM.locator("tr.clicavel").first().waitFor({ timeout: 30000 });
  } catch {
    const txt = await pgM.locator("main").innerText().catch(() => "(sem main)");
    console.log("  [debug pers] página:", txt.slice(0, 500).replace(/\n+/g, " | "));
    await shot(pgM, "debug-personagens");
    throw new Error("lista de personagens não carregou");
  }
  for (const nome of [J1.nome, J2.nome]) {
    const linha = pgM.locator("tr.clicavel", { hasText: nome }).first();
    try {
      await linha.click({ timeout: 10000 });
    } catch {
      const tabela = await pgM.locator("table.tabela").last().innerText().catch(() => "(sem tabela)");
      console.log(`  [debug pers] tabela:`, tabela.slice(0, 400).replace(/\n+/g, " | "));
      throw new Error(`personagem ${nome} não encontrado na lista`);
    }
    await pgM.getByRole("button", { name: "Aprovar", exact: true }).click();
    await pgM.waitForTimeout(1200);
    // "Voltar" do detalhe fica depois do "Voltar" do cabeçalho da campanha no DOM
    await pgM.getByRole("button", { name: "Voltar" }).last().click();
    try {
      await pgM.locator("tr.clicavel").first().waitFor({ timeout: 30000 });
    } catch {
      const txt = await pgM.locator("main").innerText().catch(() => "(sem main)");
      console.log(`  [debug voltar ${nome}]`, txt.slice(0, 500).replace(/\n+/g, " | "));
      await shot(pgM, "debug-voltar");
      throw new Error(`lista não voltou após Voltar de ${nome}`);
    }
    await pgM.waitForTimeout(500);
  }
  const pers = await apiFetch(pgM, "GET", `/campaigns/${campanhaId}/characters`);
  const aprovadas = (pers.json?.personagens ?? []).filter((p) => p.status === "aprovada").length;
  t("2 fichas aprovadas pelo mestre", aprovadas >= 2, `aprovadas=${aprovadas}`);
  await shot(pgM, "07-fichas-aprovadas");

  // ===== 8. MESA: mestre inicia, jogadores entram =====
  sec("8. Mesa multiplayer");
  await aba(pgM, "Mesa");
  await pgM.getByRole("button", { name: "Iniciar sessão" }).click();
  await pgM.locator(".chat-form").waitFor({ timeout: 15000 });
  t("mestre abriu a mesa", true);
  await shot(pgM, "08-mesa-mestre");

  for (const [pg, j, tag] of [[pg1, J1, "j1"], [pg2, J2, "j2"]]) {
    await irCampanha(pg);
    await aba(pg, "Mesa");
    await pg.locator(".abas ~ * tr.clicavel, table.tabela tr.clicavel").first().click();
    await pg.locator(".chat-form").waitFor({ timeout: 15000 });
    t(`${tag} entrou na mesa`, true);
    await shot(pg, `08-mesa-${tag}`);
  }

  // ===== 9. CHAT =====
  sec("9. Chat entre participantes");
  const msgJ1 = "Olá mesa! Preparados para rolar?";
  await pg1.getByPlaceholder("Mensagem…").fill(msgJ1);
  await pg1.getByRole("button", { name: "Enviar" }).click();
  await pgM.getByText(msgJ1).waitFor({ timeout: 10000 });
  t("chat j1→mestre", true);
  const msgM = "Sessão aberta — pode rolar.";
  await pgM.getByPlaceholder("Mensagem…").fill(msgM);
  await pgM.getByRole("button", { name: "Enviar" }).click();
  await pg2.getByText(msgM).waitFor({ timeout: 10000 });
  t("chat mestre→jogadores", true);
  await shot(pgM, "09-chat");

  // ===== 10. ROLAGENS d4–d20 =====
  sec("10. Rolagens livres d4, d6, d8, d10, d20");
  await aba(pgM, "Mesa"); // já está na mesa? MesaView persiste — garantir
  await pgM.locator(".abas-dados button", { hasText: "Rolagem e dano" }).click();
  for (const d of [4, 6, 8, 10, 20]) {
    await pgM.locator(".rolagem-form select").first().selectOption(String(d));
    await pgM.getByRole("button", { name: /Lançar/ }).click();
    await pgM.locator(".rolagem-resultado .d10-chip-total").waitFor({ timeout: 15000 });
    const total = await pgM.locator(".rolagem-resultado .d10-chip-total").textContent();
    t(`rolagem d${d} exibida (${total?.trim()})`, /Total|Dano total/.test(total ?? ""));
  }
  await shot(pgM, "10-dados");

  // ===== 11. TESTE DE HABILIDADE D10 (desafio do mestre) =====
  sec("11. Desafio D10 de habilidade");
  await pgM.getByRole("button", { name: "+ Desafio" }).click();
  const formD = pgM.locator("form", { has: pgM.getByRole("button", { name: "Enviar desafio" }) });
  const selPers = formD.locator("label", { hasText: "Personagem" }).locator("select");
  const opcoesPers = await selPers.locator("option").allTextContents();
  const idxPers = opcoesPers.findIndex((o) => o.includes(J1.nome));
  await selPers.selectOption({ index: idxPers });
  const selCampo = formD.locator("label", { hasText: "Habilidade/atributo" }).locator("select");
  // aguarda os campos elegíveis da ficha carregarem (opções "FOR (12)" etc.)
  for (let i = 0; i < 30; i++) {
    if ((await selCampo.locator("option").count()) > 1) break;
    await pgM.waitForTimeout(500);
  }
  const opcoesCampo = await selCampo.locator("option").allTextContents();
  const idxCampo = opcoesCampo.findIndex((o) => o.includes("FOR"));
  await selCampo.selectOption({ index: idxCampo });
  await pgM.getByRole("button", { name: "Enviar desafio" }).click();
  await pg1.getByRole("button", { name: "Rolar" }).waitFor({ timeout: 15000 });
  await pg1.getByRole("button", { name: "Rolar" }).click();
  await pg1.locator(".rolagem-item strong").first().waitFor({ timeout: 20000 });
  t("desafio D10 solicitado e rolado pelo jogador", true);
  await shot(pg1, "11-d10-j1");

  // ===== 12. TURNO =====
  sec("12. Turnos na mesa");
  await pgM.getByRole("button", { name: "Iniciar", exact: true }).click();
  await pgM.getByText("é a vez").waitFor({ timeout: 10000 });
  t("ordem de turno iniciada", true);
  await pg1.getByText("é a vez").waitFor({ timeout: 10000 }).catch(() => { });
  await shot(pgM, "12-turno");

  // ===== 13. PATRIMÔNIO/INVENTÁRIO =====
  sec("13. Patrimônio — adicionar item ao inventário");
  await irCampanha(pgM);
  await aba(pgM, "Personagens");
  await pgM.locator("tr.clicavel", { hasText: J1.nome }).first().click();
  await pgM.getByRole("button", { name: "Inventário" }).click();
  await pgM.getByPlaceholder("Nome do item").fill("Poção de cura");
  await pgM.locator(".formulario input[placeholder='Qtd']").fill("3");
  await pgM.getByRole("button", { name: "Adicionar" }).first().click();
  await pgM.getByText("Poção de cura").first().waitFor({ timeout: 10000 });
  t("item adicionado ao inventário do personagem", true);
  await shot(pgM, "13-inventario");

  // ===== 14. PERSISTÊNCIA: restart do servidor =====
  sec("14. Restart do servidor — persistência");
  await encerrarServidor(proc);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  await pgM.reload();
  await pgM.getByText("Servidor online").waitFor({ timeout: 20000 });
  const pers2 = await apiFetch(pgM, "GET", `/campaigns/${campanhaId}/characters`);
  t("personagens persistem após restart", (pers2.json?.personagens ?? []).length >= 2);
  const pers3 = await apiFetch(pgM, "GET", `/campaigns/${campanhaId}/sessoes`);
  t("sessão de mesa persistida", (pers3.json?.sessoes ?? []).length >= 1, JSON.stringify(pers3.json).slice(0, 120));
  // relê a mesa e confirma o chat
  await irCampanha(pgM);
  await aba(pgM, "Mesa");
  await pgM.locator("table.tabela tr.clicavel").first().click();
  await pgM.locator(".chat-form").waitFor({ timeout: 15000 });
  await pgM.getByText(msgJ1).waitFor({ timeout: 10000 });
  t("chat persistido após restart", true);
  await shot(pgM, "14-pos-restart");

} catch (e) {
  fail++;
  console.log("  FALHOU exceção:", String(e).slice(0, 400));
  try { if (browser) await shot(await browser.contexts()[0]?.newPage() ?? pgM, "99-erro"); } catch { }
} finally {
  if (browser) await browser.close().catch(() => { });
  if (proc) await encerrarServidor(proc).catch(() => { });
  limparDir(DIR);
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
