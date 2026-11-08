// Homologação visual da ficha definitiva — desktop + mobile.
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { hashToken } from "./servidor/dist/lib/password.js";
import { mkdirSync } from "fs";

const BASE = "http://localhost:3001";
const OUT = "C:/Users/mestr/AppData/Local/Temp/capturas-ficha-def";
mkdirSync(OUT, { recursive: true });
const PID = "c31be31f-752a-4f4d-bbae-bb85cc52ffe1";

const db = new Database("banco/mestre-rpg.db");
const u = db.prepare("select id from users where username='admin'").get();
const token = "fd-" + crypto.randomUUID();
db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
  .run(crypto.randomUUID(), u.id, hashToken(token), "hom-fd", "127.0.0.1", Date.now() + 3600000, Date.now());

const browser = await chromium.launch();
const rel = [];

async function abrirFicha(page, w, h, nome) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.addCookies([{ name: "mestre_rpg_session", value: token, url: BASE }]);
  const p = await ctx.newPage();
  const erros = [];
  p.on("pageerror", (e) => erros.push(String(e)));
  p.on("console", (m) => { if (m.type() === "error") erros.push(m.text()); });
  await p.goto(BASE, { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Campanhas" }).click();
  await p.waitForTimeout(700);
  await p.locator(".cartao-campanha", { hasText: "Caçadores" }).first().click();
  await p.waitForTimeout(1000);
  await p.getByRole("button", { name: /Personagens/ }).click();
  await p.waitForTimeout(800);
  await p.locator("tr", { hasText: "PJ Ficha Definitiva" }).first().click();
  await p.waitForTimeout(1200);

  const nBolinhas = await p.locator(".seletor-atributos .bolinha").count();
  const temPainel = await p.locator(".pontos-painel").count();
  const temJogador = await p.locator("text=Jogador:").count();
  const secoes = await p.locator(".ficha-secao h3, .ficha-subsecao h4").allTextContents();
  const ov = await p.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
  rel.push({ nome, bolinhas: nBolinhas, painel: temPainel, jogador: temJogador, secoes: secoes.length, overflow: ov, erros: erros.length });
  console.log(`${nome}: bolinhas=${nBolinhas} painel=${temPainel} jogador=${temJogador} secoes=${secoes.length} overflow=${ov} erros=${erros.length}`);
  console.log("  secoes:", secoes.join(" | "));
  await p.screenshot({ path: `${OUT}/${nome}-ficha.png`, fullPage: true });

  // modo edição + clique em bolinha
  const editar = p.getByRole("button", { name: "Editar ficha" });
  if (await editar.count()) {
    await editar.click();
    await p.waitForTimeout(1200);
    const primeira = p.locator(".seletor-atributos .bolinha").first();
    if (await primeira.count()) { await primeira.click(); await p.waitForTimeout(800); }
    await p.screenshot({ path: `${OUT}/${nome}-edicao.png`, fullPage: true });
    const cancelar = p.getByRole("button", { name: "Cancelar" });
    if (await cancelar.count()) await cancelar.click();
  }
  await ctx.close();
}

// editor de fichas (aba Fichas)
async function abrirEditor(w, h, nome) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.addCookies([{ name: "mestre_rpg_session", value: token, url: BASE }]);
  const p = await ctx.newPage();
  await p.goto(BASE, { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Campanhas" }).click();
  await p.waitForTimeout(700);
  await p.locator(".cartao-campanha", { hasText: "Caçadores" }).first().click();
  await p.waitForTimeout(1000);
  await p.getByRole("button", { name: /Fichas/ }).click();
  await p.waitForTimeout(1200);
  // seleciona o modelo definitivo
  const item = p.locator(".cartao-item", { hasText: "Ficha Caçadores" }).first();
  if (await item.count()) { await item.click(); await p.waitForTimeout(1000); }
  await p.screenshot({ path: `${OUT}/${nome}-editor.png`, fullPage: true });
  const ov = await p.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
  console.log(`${nome}-editor: overflow=${ov}`);
  await ctx.close();
}

await abrirFicha(null, 1920, 1080, "desktop");
await abrirFicha(null, 1366, 768, "notebook");
await abrirFicha(null, 390, 844, "mobile");
await abrirEditor(1920, 1080, "desktop");
await abrirEditor(390, 844, "mobile");
await browser.close();
console.log(JSON.stringify(rel, null, 1));
