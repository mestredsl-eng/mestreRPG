// Verificação visual dos seletores de pontos — desktop + mobile.
// Uso: node homologacao-bolinhas.mjs   (backend :3001 já no ar)
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { hashToken } from "./servidor/dist/lib/password.js";
import { mkdirSync } from "fs";

const BASE = "http://localhost:3001";
const OUT = "C:/Users/mestr/AppData/Local/Temp/capturas-bolinhas";
mkdirSync(OUT, { recursive: true });

const db = new Database("banco/mestre-rpg.db");
const u = db.prepare("select id from users where username='admin'").get();
const token = "bol-" + crypto.randomUUID();
db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
  .run(crypto.randomUUID(), u.id, hashToken(token), "homolog-bol", "127.0.0.1", Date.now() + 3600000, Date.now());

const browser = await chromium.launch();
const resultados = [];

async function cenario(nome, width, height) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.addCookies([{ name: "mestre_rpg_session", value: token, url: BASE }]);
  const page = await ctx.newPage();
  const erros = [];
  page.on("pageerror", (e) => erros.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") erros.push(m.text()); });

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Campanhas" }).click();
  await page.waitForTimeout(800);
  await page.locator(".cartao-campanha", { hasText: "Campanha Teste E4" }).first().click();
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: /Personagens/ }).click();
  await page.waitForTimeout(800);
  await page.locator("tr", { hasText: "Herói Teste" }).first().click();
  await page.waitForTimeout(1000);

  const bolinhas = await page.locator(".seletor-atributos .bolinha").count();
  const painel = await page.locator(".pontos-painel").count();
  const overflow = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
  resultados.push({ cenario: nome, bolinhas, painel, overflow, erros: erros.slice(0, 3) });
  console.log(`${nome}: bolinhas=${bolinhas} painel=${painel} overflowX=${overflow}px erros=${erros.length}`);
  await page.screenshot({ path: `${OUT}/${nome}-leitura.png`, fullPage: false });

  // entra em edição e clica numa bolinha
  const btnEditar = page.getByRole("button", { name: "Editar ficha" });
  if (await btnEditar.count()) {
    await btnEditar.click();
    await page.waitForTimeout(1200); // prévia de pontos
    const bolBtn = page.locator(".seletor-atributos .bolinha").first();
    if (await bolBtn.count()) {
      const rotulo = await page.locator(".seletor-atributos").first().locator("..").locator(".campo-label").textContent().catch(() => "?");
      await bolBtn.click();
      await page.waitForTimeout(900);
    }
    await page.screenshot({ path: `${OUT}/${nome}-edicao.png`, fullPage: true });
    // volta sem salvar
    const btnCancelar = page.getByRole("button", { name: "Cancelar" });
    if (await btnCancelar.count()) await btnCancelar.click();
  }
  await ctx.close();
}

await cenario("desktop-1920", 1920, 1080);
await cenario("mobile-390", 390, 844);
await browser.close();
console.log(JSON.stringify(resultados, null, 1));
