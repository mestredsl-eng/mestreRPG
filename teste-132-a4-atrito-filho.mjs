#!/usr/bin/env node
// FILHO — Lote D (#132-A4): confirmação do atrito "edição no painel
// Patrimônio sem âncora/atalho" + achado extra: tabs internas do
// Patrimônio sem semântica tablist (mesma lacuna do A2).
// Read-only: mede o fluxo real no main, não altera produção.
import { chromium } from "playwright";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  encerrarServidor,
} from "./teste-base.mjs";

const DIR = dirTeste("132-a4");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const CAMPANHA = "Campanha A4";
const MODELO = "Ficha A4";
const J1 = { user: "jog_a4", senha: "senha-a4-forte" };
const MESTRE = { user: "mst_a4", senha: "senha-mestre-a4" };

async function apiFetch(page, m, p, b) {
  return page.evaluate(async ([mm, pp, bb]) => {
    const r = await fetch("/api" + pp, { method: mm, headers: { "content-type": "application/json" }, body: bb !== undefined ? JSON.stringify(bb) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [m, p, b]);
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
  const pg = await ctx1.newPage();
  const ctxMb = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const pgMb = await ctxMb.newPage();

  // setup
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
  await pgM.getByLabel("Sistema de RPG").fill("Sistema A4");
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

  for (const [pgX, tag] of [[pg, "desktop"], [pgMb, "mobile"]]) {
    if (tag === "mobile") {
      await pgX.goto(BASE);
      await pgX.getByLabel("Usuário").fill(J1.user);
      await pgX.getByLabel("Senha").fill(J1.senha);
      await pgX.getByRole("button", { name: "Entrar", exact: true }).click();
      await pgX.waitForTimeout(1500);
    } else {
      await pgX.goto(`${BASE}/convite?code=${codigo}`);
      await pgX.getByText(CAMPANHA).first().waitFor({ timeout: 15000 });
      await pgX.getByLabel("Usuário").fill(J1.user);
      await pgX.getByLabel("Nome de exibição (opcional)").fill("PJ A4");
      await pgX.getByLabel("Senha").fill(J1.senha);
      await pgX.getByRole("button", { name: "Criar conta e entrar" }).click();
      await pgX.getByRole("button", { name: "Aceitar convite" }).waitFor({ timeout: 15000 });
      await pgX.getByRole("button", { name: "Aceitar convite" }).click();
      await pgX.getByRole("button", { name: "Campanhas" }).waitFor({ timeout: 15000 });
    }
    await pgX.getByRole("button", { name: "Campanhas" }).click();
    await pgX.getByText(CAMPANHA, { exact: true }).first().click();
    await pgX.locator(".abas button", { hasText: "Personagens" }).first().click();
    await pgX.getByRole("button", { name: "Novo personagem" }).click();
    await pgX.getByLabel("Nome do personagem").fill("PJ A4");
    await pgX.getByLabel("Modelo de ficha").selectOption({ label: MODELO });
    await pgX.getByRole("button", { name: "Criar e preencher" }).click();
    await pgX.getByRole("button", { name: "Equipamento/Armazém" }).waitFor({ timeout: 15000 }).catch(() => {});
    await pgX.waitForTimeout(1200);

    const r = await pgX.evaluate(() => {
      const secoes = [...document.querySelectorAll("section.cartao h3")].map((h) => h.textContent.trim());
      const patSection = [...document.querySelectorAll("section.cartao")].find((s) => s.querySelector("h3")?.textContent.includes("Patrimônio"));
      const patBox = patSection?.getBoundingClientRect();
      const patId = patSection?.id || patSection?.getAttribute("id") || null;
      const anchors = [...document.querySelectorAll('a[href^="#"], button')].filter((el) => /patrim/i.test(el.textContent)).map((el) => el.textContent.trim().slice(0, 60));
      // tabs internas do Patrimônio
      const patTabs = patSection ? [...patSection.querySelectorAll(":scope > .abas button, :scope > div > button")].map((b) => ({ txt: b.textContent.trim(), role: b.getAttribute("role"), sel: b.getAttribute("aria-selected") })) : [];
      const temTablist = !!patSection?.querySelector("[role=tablist]");
      return {
        secoes,
        patId,
        distanciaAtePatrimonio: patBox ? Math.round(patBox.top + window.scrollY - window.scrollY) : null,
        patTopoRelViewport: patBox ? Math.round(patBox.top) : null,
        viewportH: window.innerHeight,
        anchorsPatrimonio: anchors,
        patTabs, temTablist,
      };
    });
    console.log(`\n== ${tag} ==`);
    console.log("seções:", JSON.stringify(r.secoes));
    console.log("id da seção Patrimônio:", r.patId);
    console.log("topo do Patrimônio vs viewport:", r.patTopoRelViewport, "px (viewport", r.viewportH, "px)");
    console.log("elementos que mencionam 'patrimônio' clicáveis:", JSON.stringify(r.anchorsPatrimonio));
    console.log("tabs internas Patrimônio:", JSON.stringify(r.patTabs), "| tem tablist:", r.temTablist);
  }
} catch (e) {
  console.log("EXCEÇÃO:", String(e).slice(0, 300));
} finally {
  if (browser) await browser.close().catch(() => {});
  await encerrarServidor(proc).catch(() => {});
}
