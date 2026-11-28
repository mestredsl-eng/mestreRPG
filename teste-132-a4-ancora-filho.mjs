#!/usr/bin/env node
// FILHO — suíte #132 lote A4: âncora semântica até o painel Patrimônio.
// Vetores: link existe no texto de ajuda do EquipArmazém; clique rola
// até #secao-patrimonio e foca a section; id único; funciona mobile.
import { chromium } from "playwright";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  encerrarServidor,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("132-a4b");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const CAMPANHA = "Campanha A4B";
const MODELO = "Ficha A4B";
const J1 = { user: "jog_a4b", senha: "senha-a4b-forte" };
const MESTRE = { user: "mst_a4b", senha: "senha-mestre-a4b" };

async function apiFetch(page, m, p, b) {
  return page.evaluate(async ([mm, pp, bb]) => {
    const r = await fetch("/api" + pp, { method: mm, headers: { "content-type": "application/json" }, body: bb !== undefined ? JSON.stringify(bb) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [m, p, b]);
}
async function abrirArmazem(page, nome) {
  await page.getByRole("button", { name: "Campanhas" }).click();
  await page.getByText(CAMPANHA, { exact: true }).first().click();
  await page.locator(".abas button", { hasText: "Personagens" }).first().click();
  await page.locator("tr", { hasText: nome }).first().click();
  await page.getByRole("button", { name: "Equipamento/Armazém" }).click();
  await page.waitForTimeout(1500);
}

async function checarAncora(page, rotulo) {
  // 1. link âncora existe no módulo Armazém
  const link = page.locator('a[href="#secao-patrimonio"]');
  t(`${rotulo}: link "Ir para o Patrimônio" existe`, (await link.count()) >= 1);
  // 2. destino existe e é focável
  const destino = page.locator("#secao-patrimonio");
  t(`${rotulo}: #secao-patrimonio existe`, (await destino.count()) === 1);
  const ti = await destino.getAttribute("tabindex");
  t(`${rotulo}: section focável (tabindex=-1)`, ti === "-1", `tabindex=${ti}`);
  // 3. id único na página
  const nIds = await page.locator('[id="secao-patrimonio"]').count();
  t(`${rotulo}: id único`, nIds === 1, `n=${nIds}`);
  // 4. clique rola até o painel e foca
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  const antes = await page.evaluate(() => Math.round(document.getElementById("secao-patrimonio").getBoundingClientRect().top + window.scrollY));
  await link.first().click();
  await page.waitForTimeout(1200); // scroll suave + focus
  const depois = await page.evaluate(() => {
    const el = document.getElementById("secao-patrimonio");
    return { topo: Math.round(el.getBoundingClientRect().top), foco: document.activeElement === el || el.contains(document.activeElement) };
  });
  t(`${rotulo}: após clique, Patrimônio visível próximo ao topo`, Math.abs(depois.topo) < 200, `topo=${depois.topo}`);
  t(`${rotulo}: foco movido para a seção`, depois.foco);
  // 5. link é focável via Tab a partir do módulo? (ordem de tab razoável — opcional)
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
  const ctxMb = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
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
  await pgM.getByLabel("Sistema de RPG").fill("Sistema A4B");
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
  await pgD.getByLabel("Nome de exibição (opcional)").fill("PJ A4B");
  await pgD.getByLabel("Senha").fill(J1.senha);
  await pgD.getByRole("button", { name: "Criar conta e entrar" }).click();
  await pgD.getByRole("button", { name: "Aceitar convite" }).waitFor({ timeout: 15000 });
  await pgD.getByRole("button", { name: "Aceitar convite" }).click();
  await pgD.getByRole("button", { name: "Campanhas" }).waitFor({ timeout: 15000 });
  await apiFetch(pgD, "POST", `/campaigns/${cid}/characters`, { name: "PJ A4B", templateVersionId: verId });

  sec("desktop — âncora");
  await abrirArmazem(pgD, "PJ A4B");
  await checarAncora(pgD, "desktop");

  sec("mobile — âncora");
  await pgMb.goto(BASE);
  await pgMb.getByLabel("Usuário").fill(J1.user);
  await pgMb.getByLabel("Senha").fill(J1.senha);
  await pgMb.getByRole("button", { name: "Entrar", exact: true }).click();
  await pgMb.waitForTimeout(1500);
  await abrirArmazem(pgMb, "PJ A4B");
  await checarAncora(pgMb, "mobile");
} catch (e) {
  fail++;
  console.log("  FALHOU exceção:", String(e).slice(0, 300));
} finally {
  if (browser) await browser.close().catch(() => {});
  await encerrarServidor(proc).catch(() => {});
}
console.log(`\n===== A4 âncora Patrimônio FILHO: ${pass} ok / ${fail} falhas =====`);
process.exit(fail ? 1 : 0);
