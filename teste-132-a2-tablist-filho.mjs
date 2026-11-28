#!/usr/bin/env node
// FILHO — suíte TDD #132 lote A2: tablist ARIA real em
// EquipamentoArmazem (padrão de referência: Campanha.tsx).
// Hoje FALHA (lacuna diagnosticada pelo Dono): tabs têm role=tab e
// aria-selected, mas sem id/aria-controls, sem role=tabpanel,
// sem roving tabindex e sem navegação por setas/Home/End.
// Deve passar quando o PAI implementar A2.
import { chromium } from "playwright";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  encerrarServidor,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("132-a2");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;

const CAMPANHA = "Campanha A2";
const MODELO = "Ficha A2";
const J1 = { user: "jog_a2", senha: "senha-a2-forte" };
const MESTRE = { user: "mst_a2", senha: "senha-mestre-a2" };

let browser, proc, campanhaId = null;

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

// abre a ficha do jogador e o módulo Equipamento/Armazém
async function abrirArmazem(page) {
  await page.getByRole("button", { name: "Campanhas" }).click();
  await page.getByText(CAMPANHA, { exact: true }).first().click();
  await page.locator(".abas button", { hasText: "Personagens" }).first().click();
  await page.locator("tr", { hasText: "PJ A2" }).first().click();
  await page.getByRole("button", { name: "Equipamento/Armazém" }).click();
  await page.getByRole("tab", { name: "Inventário" }).waitFor({ timeout: 15000 });
  await page.locator('section[aria-label="Equipamento e Armazém"] [role=tabpanel]').first().waitFor({ timeout: 15000 });
}

async function checarSemantica(page, rotulo) {
  const tablist = page.getByRole("tablist").filter({ has: page.getByRole("tab", { name: "Veículos" }) });
  const tabs = tablist.getByRole("tab");
  const n = await tabs.count();
  t(`${rotulo}: tablist com 3 tabs`, n === 3, `n=${n}`);

  // ids + aria-controls + tabindex (roving)
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
      // só o painel ativo existe no DOM (render condicional — mesmo
      // padrão de Campanha.tsx); inativos exigem apenas o atributo.
      const painel = page.locator(`[id="${controls}"]`);
      const nP = await painel.count();
      const lp = nP ? await painel.first().getAttribute("aria-labelledby") : null;
      if (nP === 0 || lp !== id) { controlsOk = false; console.log(`  [dbg] tab=${id} controls=${controls} nP=${nP} lp=${lp}`); }
    }
    // roving: selecionada=0, demais=-1 (ou ausente só se padrão manual — exigimos roving)
    const esperado = selected === "true" ? "0" : "-1";
    if (ti !== esperado) tabindexOk = false;
  }
  t(`${rotulo}: tabs têm id`, idsOk);
  t(`${rotulo}: aria-controls aponta p/ tabpanel rotulado de volta`, controlsOk,
    await tablist.evaluate((el) => [...el.querySelectorAll("[role=tab]")].map((b) => `${b.id}|${b.getAttribute("aria-controls")}|${b.getAttribute("aria-selected")}|${document.getElementById(b.getAttribute("aria-controls") || "")?.getAttribute("aria-labelledby")}`).join(" ; ")));
  t(`${rotulo}: roving tabindex (selecionada=0, demais=-1)`, tabindexOk);

  // role=tabpanel no painel ativo
  const ativa = tablist.getByRole("tab", { selected: true });
  const controlsAtiva = await ativa.getAttribute("aria-controls");
  if (controlsAtiva) {
    const painel = page.locator(`[id="${controlsAtiva}"]`);
    t(`${rotulo}: painel ativo é role=tabpanel`, (await painel.getAttribute("role")) === "tabpanel");
  } else {
    t(`${rotulo}: painel ativo é role=tabpanel`, false, "sem aria-controls");
  }
}

async function checarTeclado(page, rotulo) {
  const tablist = page.getByRole("tablist").filter({ has: page.getByRole("tab", { name: "Veículos" }) });
  const inv = tablist.getByRole("tab", { name: "Inventário" });
  const eqp = tablist.getByRole("tab", { name: "Equipamentos" });
  const veic = tablist.getByRole("tab", { name: "Veículos" });

  await inv.focus();
  // ArrowRight → Equipamentos (foco+seleção)
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(200);
  t(`${rotulo}: ArrowRight move foco+seleção p/ Equipamentos`,
    await eqp.evaluate((el) => el === document.activeElement) && (await eqp.getAttribute("aria-selected")) === "true");
  // ArrowRight de novo → Veículos
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(200);
  t(`${rotulo}: ArrowRight → Veículos`,
    await veic.evaluate((el) => el === document.activeElement) && (await veic.getAttribute("aria-selected")) === "true");
  // wrap: ArrowRight → Inventário
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(200);
  t(`${rotulo}: ArrowRight faz wrap p/ Inventário`,
    await inv.evaluate((el) => el === document.activeElement) && (await inv.getAttribute("aria-selected")) === "true");
  // End → Veículos
  await inv.focus();
  await page.keyboard.press("End");
  await page.waitForTimeout(200);
  t(`${rotulo}: End → Veículos`,
    await veic.evaluate((el) => el === document.activeElement) && (await veic.getAttribute("aria-selected")) === "true");
  // Home → Inventário
  await page.keyboard.press("Home");
  await page.waitForTimeout(200);
  t(`${rotulo}: Home → Inventário`,
    await inv.evaluate((el) => el === document.activeElement) && (await inv.getAttribute("aria-selected")) === "true");
  // ArrowLeft de Inventário → wrap p/ Veículos
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(200);
  t(`${rotulo}: ArrowLeft faz wrap p/ Veículos`,
    await veic.evaluate((el) => el === document.activeElement) && (await veic.getAttribute("aria-selected")) === "true");
}

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);

  browser = await chromium.launch();
  const ctxM = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgM = await ctxM.newPage();
  const ctx1 = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgD = await ctx1.newPage();
  const ctxMob = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pgMb = await ctxMob.newPage();

  // ===== setup =====
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
  await pgM.getByLabel("Sistema de RPG").fill("Sistema A2");
  await pgM.getByRole("button", { name: "Criar campanha" }).click();
  await pgM.getByRole("heading", { name: CAMPANHA }).waitFor({ timeout: 15000 });
  const lista = await apiFetch(pgM, "GET", "/campaigns");
  campanhaId = lista.json?.campanhas?.find((c) => c.name === CAMPANHA)?.id;

  const tpl = await apiFetch(pgM, "POST", `/campaigns/${campanhaId}/sheet-templates`, { name: MODELO });
  const tplId = tpl.json?.modelo?.id, verId = tpl.json?.modelo?.versionId ?? tpl.json?.versionId;
  const estrutura = {
    versao: 1,
    secoes: [{ id: "s1", titulo: "Atributos", ordem: 0, campos: [
      { id: "for", label: "FOR", tipo: "inteiro", semantico: "habilidade", minimo: 1, maximo: 30 },
    ] }],
    pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
  };
  await apiFetch(pgM, "PUT", `/campaigns/${campanhaId}/sheet-templates/${tplId}/versions/${verId}`, { estrutura });
  await apiFetch(pgM, "POST", `/campaigns/${campanhaId}/sheet-templates/${tplId}/publish`, { versionId: verId });

  await pgM.locator(".abas button", { hasText: "Convites" }).first().click();
  await pgM.getByRole("button", { name: "Gerar convite" }).click();
  await pgM.locator(".convite-criado code").first().waitFor({ timeout: 10000 });
  const codigo = (await pgM.locator(".convite-criado code").first().textContent()).trim();

  // jogador desktop
  await pgD.goto(`${BASE}/convite?code=${codigo}`);
  await pgD.getByText(CAMPANHA).first().waitFor({ timeout: 15000 });
  await pgD.getByLabel("Usuário").fill(J1.user);
  await pgD.getByLabel("Nome de exibição (opcional)").fill("PJ A2");
  await pgD.getByLabel("Senha").fill(J1.senha);
  await pgD.getByRole("button", { name: "Criar conta e entrar" }).click();
  await pgD.getByRole("button", { name: "Aceitar convite" }).waitFor({ timeout: 15000 });
  await pgD.getByRole("button", { name: "Aceitar convite" }).click();
  await pgD.getByRole("button", { name: "Campanhas" }).waitFor({ timeout: 15000 });
  const c = await apiFetch(pgD, "POST", `/campaigns/${campanhaId}/characters`, { name: "PJ A2", templateVersionId: verId });
  t("personagem criado", c.status === 200 || c.status === 201, `status=${c.status}`);

  // ===== desktop: semântica + teclado =====
  sec("desktop — semântica tablist");
  await abrirArmazem(pgD);
  await checarSemantica(pgD, "desktop");
  await checarTeclado(pgD, "desktop");

  // clique continua funcionando (regressão)
  await pgD.getByRole("tab", { name: "Veículos" }).click();
  await pgD.waitForTimeout(300);
  t("desktop: clique em Veículos seleciona", (await pgD.getByRole("tab", { name: "Veículos" }).getAttribute("aria-selected")) === "true");

  // ===== mobile: tabs alcançáveis + troca por toque =====
  sec("mobile (390px)");
  await pgMb.goto(BASE);
  await pgMb.getByLabel("Usuário").fill(J1.user);
  await pgMb.getByLabel("Senha").fill(J1.senha);
  await pgMb.getByRole("button", { name: "Entrar", exact: true }).click();
  await pgMb.waitForTimeout(1500);
  await abrirArmazem(pgMb);
  await pgMb.getByRole("tab", { name: "Equipamentos" }).click();
  await pgMb.waitForTimeout(300);
  t("mobile: toque troca de aba", (await pgMb.getByRole("tab", { name: "Equipamentos" }).getAttribute("aria-selected")) === "true");
  const box = await pgMb.getByRole("tab", { name: "Veículos" }).boundingBox();
  t("mobile: tabs visíveis/alcançáveis", !!box && box.width > 0 && box.height > 0);
} catch (e) {
  fail++;
  console.log("  FALHOU exceção:", String(e).slice(0, 300));
} finally {
  if (browser) await browser.close().catch(() => {});
  await encerrarServidor(proc).catch(() => {});
}

console.log(`\n===== A2 tablist ARIA FILHO (TDD): ${pass} ok / ${fail} falhas =====`);
process.exit(fail ? 1 : 0);
