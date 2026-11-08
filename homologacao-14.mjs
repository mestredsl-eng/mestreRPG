// Homologação visual Etapa 14.4 — screenshots + overflow + erros de console.
// Uso: node homologacao-14.mjs   (sobe/reutiliza backend com build de produção;
// não depende de Vite dev nem de terminal manual)
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { hashToken } from "./servidor/dist/lib/password.js";
import { mkdirSync, writeFileSync } from "fs";
import { garantirBackend } from "./homologacao-base.mjs";

const { base: BASE, encerrar: encerrarBackend } = await garantirBackend();
const OUT = "C:/Users/mestr/AppData/Local/Temp/capturas-mestrerpg";
mkdirSync(OUT, { recursive: true });

const db = new Database("banco/mestre-rpg.db");
const u = db.prepare("select id from users where username='admin'").get();
if (!u) { console.error("admin não encontrado"); process.exit(1); }
const token = "h14-" + crypto.randomUUID();
db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
  .run(crypto.randomUUID(), u.id, hashToken(token), "h14", "127.0.0.1", Date.now() + 86400000, Date.now());

const VIEWPORTS = [
  ["1920x1080", 1920, 1080],
  ["1366x768", 1366, 768],
  ["768x1024", 768, 1024],
  ["390x844", 390, 844],
  ["360x800", 360, 800],
  ["844x390", 844, 390],
];

const relatorio = [];
const errosConsole = [];

async function overflow(page) {
  return page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
}

async function snap(page, nome, viewport) {
  const ov = await overflow(page);
  const arq = `${OUT}/${viewport}-${nome}.png`;
  await page.screenshot({ path: arq });
  relatorio.push({ viewport, tela: nome, overflowX: ov, arquivo: arq });
  if (ov > 2) console.log(`  !! OVERFLOW ${ov}px em ${viewport}/${nome}`);
}

async function clicar(page, seletor, texto, timeout = 4000) {
  const loc = page.locator(seletor, { hasText: texto }).first();
  try {
    await loc.click({ timeout });
    return true;
  } catch { return false; }
}

const browser = await chromium.launch({ channel: "msedge", headless: true });

for (const [vp, w, h] of VIEWPORTS) {
  console.log(`=== ${vp} ===`);
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.addCookies([{ name: "mestre_rpg_session", value: token, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") errosConsole.push({ vp, msg: m.text().slice(0, 200) }); });
  page.on("pageerror", (e) => errosConsole.push({ vp, msg: "PAGEERROR " + String(e).slice(0, 200) }));

  try {
    await page.goto(BASE, { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForTimeout(600);
    await snap(page, "01-painel", vp);

    // navegação principal
    if (await clicar(page, ".topo nav button", "Campanhas")) {
      await page.waitForTimeout(500);
      await snap(page, "02-campanhas", vp);
      // abrir campanha do mestre (procurar uma com aba Participantes)
      const cards = page.locator(".cartao-campanha");
      const n = await cards.count();
      let entrou = false;
      for (let i = 0; i < Math.min(n, 6) && !entrou; i++) {
        await cards.nth(i).click();
        await page.waitForTimeout(700);
        const temPart = await page.locator(".abas button", { hasText: "Participantes" }).count();
        if (temPart > 0) { entrou = true; break; }
        // voltar e tentar próxima
        await clicar(page, ".cartao button", "Voltar").catch(() => {});
        const voltar = page.locator("button", { hasText: "Voltar" }).first();
        try { await voltar.click({ timeout: 1500 }); } catch { }
        await page.waitForTimeout(400);
      }
      if (!entrou && n > 0) { await cards.first().click(); await page.waitForTimeout(700); }
      await snap(page, "03-campanha-info", vp);

      // abas da campanha
      const abas = ["Informações", "Mesa", "Personagens", "Diário", "Histórico", "Arquivos", "Fichas", "Regras", "Participantes", "Convites"];
      for (const aba of abas) {
        if (await clicar(page, ".abas button", aba)) {
          await page.waitForTimeout(700);
          await snap(page, `aba-${aba.toLowerCase()}`, vp);
        }
      }
      // dentro da aba Mesa: abrir primeira sessão
      if (await clicar(page, ".abas button", "Mesa")) {
        await page.waitForTimeout(600);
        const sessao = page.locator("table.tabela tbody tr.clicavel").first();
        if (await sessao.count()) {
          await sessao.click();
          await page.waitForTimeout(1200);
          await snap(page, "mesa-sessao", vp);
        }
      }
      // dentro de Personagens: abrir primeiro personagem
      if (await clicar(page, ".abas button", "Personagens")) {
        await page.waitForTimeout(600);
        const pers = page.locator("table.tabela tbody tr.clicavel").first();
        if (await pers.count()) {
          await pers.click();
          await page.waitForTimeout(900);
          await snap(page, "personagem-detalhe", vp);
          // sub-abas do patrimônio
          for (const sub of ["Equipamentos", "Veículos", "Dinheiro"]) {
            if (await clicar(page, ".abas button", sub)) {
              await page.waitForTimeout(600);
              await snap(page, `patrimonio-${sub.toLowerCase()}`, vp);
            }
          }
        }
      }
      // voltar ao painel de campanhas para admin
      await clicar(page, "button", "Voltar");
      await page.waitForTimeout(400);
    }

    // conta
    if (await clicar(page, ".topo nav button", "Conta")) {
      await page.waitForTimeout(500);
      await snap(page, "conta", vp);
    }
    // administração (admin)
    if (await clicar(page, ".topo nav button", "Administração")) {
      await page.waitForTimeout(700);
      await snap(page, "admin-usuarios", vp);
      // sub-aba Servidor (status)
      if (await clicar(page, ".abas button", "Status")) {
        await page.waitForTimeout(500);
        await snap(page, "admin-servidor-status", vp);
      }
      if (await clicar(page, ".abas button", "Configuração")) {
        await page.waitForTimeout(500);
        await snap(page, "admin-servidor-config", vp);
      }
    }
    // página de convite (estado de erro)
    await page.goto(`${BASE}/convite?code=INVALIDO-TESTE`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    await snap(page, "convite-invalido", vp);
  } catch (e) {
    console.log(`  ERRO ${vp}: ${String(e).slice(0, 160)}`);
    try { await snap(page, "ERRO", vp); } catch { }
  }
  await ctx.close();
}

await browser.close();
await encerrarBackend();
writeFileSync(`${OUT}/relatorio.json`, JSON.stringify({ relatorio, errosConsole }, null, 2));
const comOverflow = relatorio.filter((r) => r.overflowX > 2);
console.log(`\nTelas capturadas: ${relatorio.length} · com overflow horizontal: ${comOverflow.length}`);
for (const r of comOverflow) console.log(`  OVERFLOW ${r.viewport}/${r.tela}: ${r.overflowX}px`);
const errosUnicos = [...new Set(errosConsole.map((e) => e.msg))];
console.log(`Erros de console únicos: ${errosUnicos.length}`);
errosUnicos.slice(0, 15).forEach((m) => console.log("  -", m));
