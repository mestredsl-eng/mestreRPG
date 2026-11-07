// Complemento 14.4: mesa ao vivo + verificações DOM de cartões vs tabelas.
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { hashToken } from "./servidor/dist/lib/password.js";
import { mkdirSync, writeFileSync } from "fs";

const BASE = "http://localhost:5173";
const OUT = "C:/Users/mestr/AppData/Local/Temp/capturas-mestrerpg";
mkdirSync(OUT, { recursive: true });

const db = new Database("banco/mestre-rpg.db");
const u = db.prepare("select id from users where username='admin'").get();
const token = "h14b-" + crypto.randomUUID();
db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
  .run(crypto.randomUUID(), u.id, hashToken(token), "h14", "127.0.0.1", Date.now() + 86400000, Date.now());

const VIEWPORTS = [
  ["1920x1080", 1920, 1080], ["1366x768", 1366, 768], ["768x1024", 768, 1024],
  ["390x844", 390, 844], ["360x800", 360, 800], ["844x390", 844, 390],
];

const rel = [];
const browser = await chromium.launch({ channel: "msedge", headless: true });

async function overflow(page) {
  return page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
}
async function snap(page, nome, vp) {
  const ov = await overflow(page);
  await page.screenshot({ path: `${OUT}/${vp}-${nome}.png` });
  rel.push({ vp, tela: nome, overflowX: ov });
  if (ov > 2) console.log(`  !! OVERFLOW ${ov}px ${vp}/${nome}`);
}
async function clicar(page, seletor, texto) {
  try { await page.locator(seletor, { hasText: texto }).first().click({ timeout: 4000 }); return true; } catch { return false; }
}

for (const [vp, w, h] of VIEWPORTS) {
  console.log(`=== ${vp} ===`);
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.addCookies([{ name: "mestre_rpg_session", value: token, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();
  try {
    await page.goto(BASE, { waitUntil: "networkidle", timeout: 20000 });
    await clicar(page, ".topo nav button", "Campanhas");
    await page.waitForTimeout(500);
    const cards = page.locator(".cartao-campanha");
    const alvo = page.locator(".cartao-campanha", { hasText: "Caçadores" }).first();
    if (await alvo.count()) await alvo.click();
    else await cards.first().click();
    await page.waitForTimeout(900);

    // mesa: abrir sessão ativa
    if (await clicar(page, ".abas button", "Mesa")) {
      await page.waitForTimeout(800);
      const ativa = page.locator("table.tabela tbody tr.clicavel", { hasText: "ativa" }).first();
      if (await ativa.count()) {
        await ativa.click();
        await page.waitForTimeout(1500);
        await snap(page, "mesa-sessao-ativa", vp);
        // rolagem rápida funcional: preencher e submeter
        const qtd = page.locator(".rolagem-form input[type=number]").first();
        if (await qtd.count()) {
          await qtd.fill("1");
          await page.locator(".rolagem-form button[type=submit]").click();
          await page.waitForTimeout(800);
        }
      } else {
        console.log(`  (sem sessão ativa visível em ${vp})`);
      }
    }

    // verificações DOM de cartões vs tabela em páginas com tabela-responsiva
    const checar = async (rotulo) => {
      if (w > 800) return;
      const checks = await page.evaluate(() => {
        const res = {};
        document.querySelectorAll(".tabela-responsiva").forEach((t) => {
          res["tabela_visivel"] = (res["tabela_visivel"] ?? 0) + (getComputedStyle(t).display !== "none" ? 1 : 0);
        });
        document.querySelectorAll(".cartoes-registro").forEach((c) => {
          res["cartoes_visiveis"] = (res["cartoes_visiveis"] ?? 0) + (getComputedStyle(c).display !== "none" ? c.children.length : 0);
        });
        return res;
      });
      rel.push({ vp, tela: `dom-${rotulo}`, ...checks });
      console.log(`  dom ${rotulo}:`, JSON.stringify(checks));
    };

    if (await clicar(page, ".abas button", "Participantes")) {
      await page.waitForTimeout(800);
      await snap(page, "participantes-cartoes", vp);
      await checar("participantes");
    }
    if (await clicar(page, ".abas button", "Personagens")) {
      await page.waitForTimeout(700);
      const pers = page.locator("table.tabela tbody tr.clicavel").first();
      if (await pers.count()) {
        await pers.click();
        await page.waitForTimeout(900);
        if (await clicar(page, ".abas button", "Veículos")) {
          await page.waitForTimeout(700);
          await snap(page, "patrimonio-veiculos-cartoes", vp);
          await checar("veiculos");
        }
        if (await clicar(page, ".abas button", "Dinheiro")) {
          await page.waitForTimeout(700);
          await checar("dinheiro");
        }
      }
    }
  } catch (e) {
    console.log(`  ERRO ${vp}: ${String(e).slice(0, 140)}`);
  }
  await ctx.close();
}
await browser.close();
writeFileSync(`${OUT}/relatorio-mesa.json`, JSON.stringify(rel, null, 2));
console.log("fim");
