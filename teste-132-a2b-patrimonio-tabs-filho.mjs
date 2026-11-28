#!/usr/bin/env node
// FILHO — suíte TDD #132 lote A2b: tablist ARIA real nas abas do
// painel Patrimônio (Inventário/Equipamentos/Veículos/Dinheiro[/Catálogo]).
// Baseline @ main: buttons sem role/aria — FALHA. Deve passar pós-A2b.
import { chromium } from "playwright";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  encerrarServidor,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("132-a2b");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const CAMPANHA = "Campanha A2B";
const MODELO = "Ficha A2B";
const J1 = { user: "jog_a2b", senha: "senha-a2b-forte" };
const MESTRE = { user: "mst_a2b", senha: "senha-mestre-a2b" };

async function apiFetch(page, m, p, b) {
  return page.evaluate(async ([mm, pp, bb]) => {
    const r = await fetch("/api" + pp, { method: mm, headers: { "content-type": "application/json" }, body: bb !== undefined ? JSON.stringify(bb) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [m, p, b]);
}
async function abrirFicha(page, nome) {
  await page.getByRole("button", { name: "Campanhas" }).click();
  await page.getByText(CAMPANHA, { exact: true }).first().click();
  await page.locator(".abas button", { hasText: "Personagens" }).first().click();
  await page.locator("tr", { hasText: nome }).first().click();
  // Patrimônio é sempre montado — esperar a tablist (ou os botões legados)
  await page.waitForTimeout(1500);
}
function tablistPatrimonio(page) {
  return page.getByRole("tablist").filter({ has: page.getByRole("tab", { name: "Dinheiro" }) });
}
async function checarSemantica(page, rotulo, esperadoTabs) {
  const tablist = tablistPatrimonio(page);
  const tabs = tablist.getByRole("tab");
  const n = await tabs.count();
  t(`${rotulo}: tablist com ${esperadoTabs} tabs`, n === esperadoTabs, `n=${n}`);
  if (n === 0) return;

  let idsOk = true, controlsOk = true, tabindexOk = true;
  for (let i = 0; i < n; i++) {
    const tab = tabs.nth(i);
    const id = await tab.getAttribute("id");
    const controls = await tab.getAttribute("aria-controls");
    const ti = await tab.getAttribute("tabindex");
    const selected = await tab.getAttribute("aria-selected");
    if (!id) idsOk = false;
    if (!controls) controlsOk = false;
    else if (selected === "true") {
      const painel = page.locator(`[id="${controls}"]`);
      const nP = await painel.count();
      const lp = nP ? await painel.first().getAttribute("aria-labelledby") : null;
      if (nP === 0 || lp !== id) controlsOk = false;
    }
    const espTi = selected === "true" ? "0" : "-1";
    if (ti !== espTi) tabindexOk = false;
  }
  t(`${rotulo}: tabs têm id`, idsOk);
  t(`${rotulo}: aria-controls→tabpanel rotulado de volta`, controlsOk);
  t(`${rotulo}: roving tabindex`, tabindexOk);

  const ativa = tablist.getByRole("tab", { selected: true });
  const controlsAtiva = await ativa.getAttribute("aria-controls");
  if (controlsAtiva) {
    const painel = page.locator(`[id="${controlsAtiva}"]`);
    t(`${rotulo}: painel ativo role=tabpanel`, (await painel.getAttribute("role")) === "tabpanel");
  } else t(`${rotulo}: painel ativo role=tabpanel`, false, "sem aria-controls");
}
async function checarTeclado(page, rotulo, nomes) {
  const tablist = tablistPatrimonio(page);
  const [a, b, ...rest] = nomes.map((nm) => tablist.getByRole("tab", { name: nm }));
  const ultima = rest.length ? tablist.getByRole("tab", { name: nomes[nomes.length - 1] }) : b;

  await a.focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(250);
  t(`${rotulo}: ArrowRight → ${nomes[1]}`,
    await b.evaluate((el) => el === document.activeElement) && (await b.getAttribute("aria-selected")) === "true");
  await page.keyboard.press("End");
  await page.waitForTimeout(250);
  t(`${rotulo}: End → última tab`,
    await ultima.evaluate((el) => el === document.activeElement) && (await ultima.getAttribute("aria-selected")) === "true");
  await page.keyboard.press("Home");
  await page.waitForTimeout(250);
  t(`${rotulo}: Home → primeira tab`,
    await a.evaluate((el) => el === document.activeElement) && (await a.getAttribute("aria-selected")) === "true");
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(250);
  t(`${rotulo}: ArrowLeft wrap → última tab`,
    await ultima.evaluate((el) => el === document.activeElement) && (await ultima.getAttribute("aria-selected")) === "true");
}

let browser, proc;
try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  browser = await chromium.launch();
  const ctxM = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgM = await ctxM.newPage();
  const ctx1 = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgD = await ctx1.newPage();
  const ctxMb = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pgMb = await ctxMb.newPage();

  sec("setup");
  await pgM.goto(BASE);
  await pgM.getByText("Primeiro acesso? Criar conta de administrador").click();
  await pgM.getByLabel("Usuário").fill(MESTRE.user);
  await pgM.getByLabel("Senha").fill(MESTRE.senha);
  await pgM.getByRole("button", { name: "Criar administrador" }).click();
  await pgM.waitForTimeout(800);
  await pgM.getByLabel("Usuário").fill(MESTRE.user);
  await pgM.getByLabel("Senha").fill(MESTRE.senha);
  await pgM.getByRole("button", { name: "Entrar", exact: true }).click();
  await pgM.getByText("Servidor online").waitFor({ timeout: 15000 });
  await pgM.getByRole("button", { name: "Campanhas" }).click();
  await pgM.getByRole("button", { name: "Nova campanha" }).click();
  await pgM.getByLabel("Nome da campanha").fill(CAMPANHA);
  await pgM.getByLabel("Sistema de RPG").fill("Sistema A2B");
  await pgM.getByRole("button", { name: "Criar campanha" }).click();
  await pgM.getByRole("heading", { name: CAMPANHA }).waitFor({ timeout: 15000 });
  const lista = await apiFetch(pgM, "GET", "/campaigns");
  const cid = lista.json?.campanhas?.find((c) => c.name === CAMPANHA)?.id;
  const tpl = await apiFetch(pgM, "POST", `/campaigns/${cid}/sheet-templates`, { name: MODELO });
  const tplId = tpl.json?.modelo?.id, verId = tpl.json?.modelo?.versionId ?? tpl.json?.versionId;
  const estrutura = { versao: 1, secoes: [{ id: "s1", titulo: "A", ordem: 0, campos: [{ id: "for", label: "FOR", tipo: "inteiro", semantico: "habilidade", minimo: 1, maximo: 30 }] }], pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} } };
  await apiFetch(pgM, "PUT", `/campaigns/${cid}/sheet-templates/${tplId}/versions/${verId}`, { estrutura });
  await apiFetch(pgM, "POST", `/campaigns/${cid}/sheet-templates/${tplId}/publish`, { versionId: verId });
  await pgM.locator(".abas button", { hasText: "Convites" }).first().click();
  await pgM.getByRole("button", { name: "Gerar convite" }).click();
  await pgM.locator(".convite-criado code").first().waitFor({ timeout: 10000 });
  const codigo = (await pgM.locator(".convite-criado code").first().textContent()).trim();

  await pgD.goto(`${BASE}/convite?code=${codigo}`);
  await pgD.getByText(CAMPANHA).first().waitFor({ timeout: 15000 });
  await pgD.getByLabel("Usuário").fill(J1.user);
  await pgD.getByLabel("Nome de exibição (opcional)").fill("PJ A2B");
  await pgD.getByLabel("Senha").fill(J1.senha);
  await pgD.getByRole("button", { name: "Criar conta e entrar" }).click();
  await pgD.getByRole("button", { name: "Aceitar convite" }).waitFor({ timeout: 15000 });
  await pgD.getByRole("button", { name: "Aceitar convite" }).click();
  await pgD.getByRole("button", { name: "Campanhas" }).waitFor({ timeout: 15000 });
  const c = await apiFetch(pgD, "POST", `/campaigns/${cid}/characters`, { name: "PJ A2B", templateVersionId: verId });
  t("personagem criado", c.status === 200 || c.status === 201, `status=${c.status}`);

  // ===== jogador: 4 tabs =====
  sec("jogador — semântica + teclado");
  await abrirFicha(pgD, "PJ A2B");
  const nomesJ = ["Inventário", "Equipamentos", "Veículos", "Dinheiro"];
  await checarSemantica(pgD, "jogador", 4);
  await checarTeclado(pgD, "jogador", nomesJ);
  // clique funciona
  const tabEq = tablistPatrimonio(pgD).getByRole("tab", { name: "Equipamentos" });
  await tabEq.click();
  await pgD.waitForTimeout(300);
  t("jogador: clique seleciona Equipamentos", (await tabEq.getAttribute("aria-selected")) === "true");
  // jogador NÃO deve ter Catálogo
  t("jogador: sem tab Catálogo", (await tablistPatrimonio(pgD).getByRole("tab", { name: "Catálogo" }).count()) === 0);

  // ===== mestre: 5 tabs (com Catálogo) =====
  sec("mestre — 5 tabs");
  await abrirFicha(pgM, "PJ A2B");
  const nomesM = ["Inventário", "Equipamentos", "Veículos", "Dinheiro", "Catálogo"];
  await checarSemantica(pgM, "mestre", 5);
  await checarTeclado(pgM, "mestre", nomesM);

  // ===== mobile =====
  sec("mobile (390px)");
  await pgMb.goto(BASE);
  await pgMb.getByLabel("Usuário").fill(J1.user);
  await pgMb.getByLabel("Senha").fill(J1.senha);
  await pgMb.getByRole("button", { name: "Entrar", exact: true }).click();
  await pgMb.waitForTimeout(1500);
  await abrirFicha(pgMb, "PJ A2B");
  await pgMb.getByRole("tab", { name: "Veículos" }).click();
  await pgMb.waitForTimeout(300);
  t("mobile: toque troca aba Patrimônio", (await pgMb.getByRole("tab", { name: "Veículos" }).getAttribute("aria-selected")) === "true");
} catch (e) {
  fail++;
  console.log("  FALHOU exceção:", String(e).slice(0, 300));
} finally {
  if (browser) await browser.close().catch(() => {});
  await encerrarServidor(proc).catch(() => {});
}
console.log(`\n===== A2b tabs Patrimônio FILHO: ${pass} ok / ${fail} falhas =====`);
process.exit(fail ? 1 : 0);
