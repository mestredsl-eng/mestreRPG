#!/usr/bin/env node
// FILHO — Frente V (#132): inventário visual real desktop+mobile.
// Capturas das telas principais + métricas objetivas (overflow
// horizontal, console errors, alvos de toque). Não altera produção.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  encerrarServidor,
} from "./teste-base.mjs";

const DIR = dirTeste("132-fv");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const SHOTS = join(process.cwd(), "_evidencias", "frente-v");
mkdirSync(SHOTS, { recursive: true });
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const CAMPANHA = "Campanha FV";
const MODELO = "Ficha FV";
const J1 = { user: "jog_fv", senha: "senha-fv-forte" };
const MESTRE = { user: "mst_fv", senha: "senha-mestre-fv" };

const metricas = [];
const shot = async (page, nome) => { await page.screenshot({ path: join(SHOTS, `${nome}.png`) }).catch(() => {}); };
async function apiFetch(page, m, p, b) {
  return page.evaluate(async ([mm, pp, bb]) => {
    const r = await fetch("/api" + pp, { method: mm, headers: { "content-type": "application/json" }, body: bb !== undefined ? JSON.stringify(bb) : undefined });
    return { status: r.status, json: await r.json().catch(() => null) };
  }, [m, p, b]);
}
async function medir(page, tela) {
  const m = await page.evaluate(() => ({
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2,
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    botoesPequenos: [...document.querySelectorAll("button")].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.height < 32 || r.width < 32); }).length,
    imgsSemAlt: [...document.querySelectorAll("img")].filter((i) => !i.alt).length,
  }));
  metricas.push({ tela, ...m });
  if (m.overflowX) console.log(`  [overflowX] ${tela}: scrollW=${m.scrollW} > clientW=${m.clientW}`);
  if (m.botoesPequenos) console.log(`  [alvos pequenos] ${tela}: ${m.botoesPequenos} botão(ões) <32px`);
  if (m.imgsSemAlt) console.log(`  [img sem alt] ${tela}: ${m.imgsSemAlt}`);
}

let browser, proc;
try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  browser = await chromium.launch();

  for (const [tag, vp] of [["desktop", { width: 1366, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
    const ctx = await browser.newContext({ viewport: vp, isMobile: tag === "mobile", hasTouch: tag === "mobile" });
    const pg = await ctx.newPage();
    const erros = [];
    pg.on("pageerror", (e) => erros.push(String(e).slice(0, 120)));
    pg.on("console", (msg) => { if (msg.type() === "error") erros.push(msg.text().slice(0, 120)); });

    // login mestre (2ª iteração: conta já existe → login direto)
    await pg.goto(BASE);
    await shot(pg, `${tag}-01-login`);
    if (tag === "desktop") {
      await pg.getByText("Primeiro acesso? Criar conta de administrador").click();
      await pg.getByLabel("Usuário").fill(MESTRE.user);
      await pg.getByLabel("Senha").fill(MESTRE.senha);
      await pg.getByRole("button", { name: "Criar administrador" }).click();
      await pg.waitForTimeout(800);
    }
    await pg.getByLabel("Usuário").fill(MESTRE.user);
    await pg.getByLabel("Senha").fill(MESTRE.senha);
    await pg.getByRole("button", { name: "Entrar", exact: true }).click();
    await pg.getByText("Servidor online").waitFor({ timeout: 15000 });
    await shot(pg, `${tag}-02-painel`);
    await medir(pg, `${tag}-painel`);

    // campanha (2ª iteração: campanha já existe → só abrir)
    if (tag === "desktop") {
      await pg.getByRole("button", { name: "Campanhas" }).click();
      await pg.getByRole("button", { name: "Nova campanha" }).click();
      await pg.getByLabel("Nome da campanha").fill(CAMPANHA);
      await pg.getByLabel("Sistema de RPG").fill("Sistema FV");
      await pg.getByRole("button", { name: "Criar campanha" }).click();
      await pg.getByRole("heading", { name: CAMPANHA }).waitFor({ timeout: 15000 });
    } else {
      await pg.getByRole("button", { name: "Campanhas" }).click();
      await pg.getByText(CAMPANHA, { exact: true }).first().click();
    }
    await shot(pg, `${tag}-03-campanha-mesa`);
    await medir(pg, `${tag}-campanha`);

    const lista = await apiFetch(pg, "GET", "/campaigns");
    const cid = lista.json?.campanhas?.find((c) => c.name === CAMPANHA)?.id;
    let codigo = null, verId = null;
    if (tag === "desktop") {
      const tpl = await apiFetch(pg, "POST", `/campaigns/${cid}/sheet-templates`, { name: MODELO });
      const tplId = tpl.json?.modelo?.id, v = tpl.json?.modelo?.versionId ?? tpl.json?.versionId;
      verId = v;
      const estrutura = { versao: 1, secoes: [{ id: "s1", titulo: "Atributos", ordem: 0, campos: [
        { id: "for", label: "FOR", tipo: "inteiro", semantico: "habilidade", minimo: 1, maximo: 30 },
        { id: "vg", label: "VIGOR", tipo: "inteiro", semantico: "vida", minimo: 1, maximo: 30 },
      ] }], pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} } };
      await apiFetch(pg, "PUT", `/campaigns/${cid}/sheet-templates/${tplId}/versions/${verId}`, { estrutura });
      await apiFetch(pg, "POST", `/campaigns/${cid}/sheet-templates/${tplId}/publish`, { versionId: verId });
      await pg.locator(".abas button", { hasText: "Convites" }).first().click();
      await pg.getByRole("button", { name: "Gerar convite" }).click();
      await pg.locator(".convite-criado code").first().waitFor({ timeout: 10000 });
      codigo = (await pg.locator(".convite-criado code").first().textContent()).trim();
    } else {
      // recupera versão publicada p/ criar personagem do jogador
      const tpls = await apiFetch(pg, "GET", `/campaigns/${cid}/sheet-templates`);
      const tpl = (tpls.json?.modelos ?? tpls.json?.templates ?? [])[0];
      verId = tpl?.versaoAtual?.id ?? tpl?.versionId;
    }

    // jogador entra (desktop: convite+signup; mobile: login direto)
    const ctxJ = await browser.newContext({ viewport: vp, isMobile: tag === "mobile", hasTouch: tag === "mobile" });
    const pgJ = await ctxJ.newPage();
    pgJ.on("pageerror", (e) => erros.push("J:" + String(e).slice(0, 100)));
    if (tag === "desktop") {
      await pgJ.goto(`${BASE}/convite?code=${codigo}`);
      await pgJ.getByText(CAMPANHA).first().waitFor({ timeout: 15000 });
      await pgJ.getByLabel("Usuário").fill(J1.user);
      await pgJ.getByLabel("Nome de exibição (opcional)").fill("PJ FV");
      await pgJ.getByLabel("Senha").fill(J1.senha);
      await pgJ.getByRole("button", { name: "Criar conta e entrar" }).click();
      await pgJ.getByRole("button", { name: "Aceitar convite" }).waitFor({ timeout: 15000 });
      await pgJ.getByRole("button", { name: "Aceitar convite" }).click();
      await pgJ.getByRole("button", { name: "Campanhas" }).waitFor({ timeout: 15000 });
      await apiFetch(pgJ, "POST", `/campaigns/${cid}/characters`, { name: "PJ FV", templateVersionId: verId });
    } else {
      await pgJ.goto(BASE);
      await pgJ.getByLabel("Usuário").fill(J1.user);
      await pgJ.getByLabel("Senha").fill(J1.senha);
      await pgJ.getByRole("button", { name: "Entrar", exact: true }).click();
      await pgJ.waitForTimeout(1500);
    }

    // abas da campanha (jogador)
    const abas = ["Personagens", "Diário", "Arquivos", "Histórico"];
    for (const aba of abas) {
      await pgJ.getByRole("button", { name: "Campanhas" }).click().catch(() => {});
      await pgJ.getByText(CAMPANHA, { exact: true }).first().click().catch(() => {});
      const btn = pgJ.locator(".abas button", { hasText: aba }).first();
      if (await btn.count()) { await btn.click(); await pgJ.waitForTimeout(1200); await shot(pgJ, `${tag}-04-${aba.toLowerCase()}`); await medir(pgJ, `${tag}-${aba}`); }
    }
    // ficha + armazém + internet
    await pgJ.locator(".abas button", { hasText: "Personagens" }).first().click().catch(() => {});
    await pgJ.locator("tr", { hasText: "PJ FV" }).first().click().catch(() => {});
    await pgJ.waitForTimeout(1200);
    await shot(pgJ, `${tag}-05-ficha`);
    await medir(pgJ, `${tag}-ficha`);
    const btnEq = pgJ.getByRole("button", { name: "Equipamento/Armazém" });
    if (await btnEq.count()) { await btnEq.click(); await pgJ.waitForTimeout(1200); await shot(pgJ, `${tag}-06-armazem`); await medir(pgJ, `${tag}-armazem`); }
    const btnIn = pgJ.getByRole("button", { name: "Internet", exact: true });
    if (await btnIn.count()) { await btnIn.click(); await pgJ.waitForTimeout(1500); await shot(pgJ, `${tag}-07-internet`); await medir(pgJ, `${tag}-internet`); }

    // abas do mestre (visão mestre: Mesa, Participantes, Convites, Fichas, Regras, Informações)
    for (const aba of ["Mesa", "Participantes", "Convites", "Informações"]) {
      await pg.getByText(CAMPANHA, { exact: true }).first().click().catch(() => {});
      const btn = pg.locator(".abas button", { hasText: aba }).first();
      if (await btn.count()) { await btn.click(); await pg.waitForTimeout(1000); await shot(pg, `${tag}-08-mestre-${aba.toLowerCase()}`); await medir(pg, `${tag}-mestre-${aba}`); }
    }
    // mesa do mestre (rolagens/timer visíveis?)
    await pg.locator(".abas button", { hasText: "Mesa" }).first().click().catch(() => {});
    await pg.waitForTimeout(1500);
    await shot(pg, `${tag}-09-mesa-mestre`);
    await medir(pg, `${tag}-mesa`);

    if (erros.length) { console.log(`  [console/pageerror ${tag}]`, erros.slice(0, 5)); metricas.push({ tela: `${tag}-erros`, erros }); }
    await ctx.close(); await ctxJ.close();
  }

  console.log("\n===== MÉTRICAS =====");
  metricas.forEach((m) => console.log(JSON.stringify(m)));
} catch (e) {
  console.log("EXCEÇÃO:", String(e).slice(0, 400));
} finally {
  if (browser) await browser.close().catch(() => {});
  await encerrarServidor(proc).catch(() => {});
}
console.log("shots em", SHOTS);
