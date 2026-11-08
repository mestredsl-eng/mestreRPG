// Auditoria D3 — responsividade e alvos de toque.
// Percorre as telas principais em 360/390/768/1280 e mede:
//  - overflow horizontal do documento
//  - elementos visíveis que ultrapassam a borda direita
//  - alvos interativos (button/a/[role=button]/input/select) com altura < 24px
// Uso: node auditoria-d3.mjs   (requer backend :3001)
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { hashToken } from "./servidor/dist/lib/password.js";

const BASE = "http://localhost:3001";
const CID = "179dd61c-6f4e-4c54-bf88-1e255a506743"; // campanha de teste (administrador é mestre)

const db = new Database("banco/mestre-rpg.db");
const u = db.prepare("select id from users where username='administrador'").get();
const token = "aud-d3-" + crypto.randomUUID();
db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
  .run(crypto.randomUUID(), u.id, hashToken(token), "aud-d3", "127.0.0.1", Date.now() + 3600000, Date.now());

const VIEWPORTS = [[360, 800], [390, 844], [768, 1024], [1280, 800]];
const problemas = [];

async function medir(page, rotulo, vp) {
  const m = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const overflow = Math.max(0, document.documentElement.scrollWidth - vw);
    // elementos visíveis cortados pela direita
    const cortados = [];
    document.querySelectorAll("body *").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const cs = getComputedStyle(el);
      if (cs.position === "fixed" && el.closest(".notificacoes-viewport")) return;
      if (r.right > vw + 2 && !el.closest(".notificacoes-viewport")) {
        cortados.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} dir=${Math.round(r.right - vw)}px`);
      }
    });
    // alvos pequenos
    const pequenos = [];
    document.querySelectorAll("button, a, select, input:not([type=hidden]), [role=button]").forEach((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || cs.visibility === "hidden" || cs.display === "none") return;
      if (r.height < 24 || r.width < 24) {
        pequenos.push(`${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    });
    return { overflow, cortados: cortados.slice(0, 8), pequenos: pequenos.slice(0, 15), nPequenos: pequenos.length, nCortados: cortados.length };
  });
  if (m.overflow > 2 || m.nCortados > 0 || m.nPequenos > 0) {
    problemas.push({ vp, tela: rotulo, ...m });
    console.log(`  ${vp} ${rotulo}: overflow=${m.overflow}px cortados=${m.nCortados} alvos<24px=${m.nPequenos}`);
    m.cortados.forEach((c) => console.log(`    CORTADO ${c}`));
    m.pequenos.slice(0, 6).forEach((s) => console.log(`    PEQUENO ${s}`));
  } else {
    console.log(`  ${vp} ${rotulo}: ok`);
  }
}

const browser = await chromium.launch({ channel: "msedge", headless: true });

async function novaPagina(w, h) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  await ctx.addCookies([{ name: "mestre_rpg_session", value: token, url: BASE }]);
  const p = await ctx.newPage();
  p.on("pageerror", (e) => problemas.push({ vp: `${w}px`, tela: "PAGEERROR", erro: String(e).slice(0, 120) }));
  return { ctx, p };
}
async function clicar(p, sel, txt, t = 4000) {
  try { await p.locator(sel, { hasText: txt }).first().click({ timeout: t }); return true; } catch { return false; }
}

for (const [w, h] of VIEWPORTS) {
  const vp = `${w}px`;
  console.log(`=== ${vp} ===`);
  const { ctx, p } = await novaPagina(w, h);
  try {
    await p.goto(BASE, { waitUntil: "networkidle", timeout: 20000 });
    await p.waitForTimeout(500);
    await medir(p, "painel", vp);

    if (await clicar(p, ".topo nav button", "Campanhas")) {
      await p.waitForTimeout(600);
      await medir(p, "campanhas", vp);
      const card = p.locator(".cartao-campanha", { hasText: "teste-mestree" }).first();
      if (await card.count()) {
        await card.click();
        await p.waitForTimeout(900);
        await medir(p, "campanha-info", vp);
        for (const aba of ["Mesa", "Personagens", "Diário", "Histórico", "Arquivos", "Fichas", "Regras", "Participantes", "Convites"]) {
          if (await clicar(p, ".abas button", aba)) {
            await p.waitForTimeout(700);
            await medir(p, `aba-${aba.toLowerCase()}`, vp);
          }
        }
        // personagem detalhe
        if (await clicar(p, ".abas button", "Personagens")) {
          await p.waitForTimeout(600);
          const pers = p.locator("table.tabela tbody tr.clicavel, .cartao-personagem, .lista-personagens > *").first();
          if (await pers.count()) {
            await pers.click();
            await p.waitForTimeout(900);
            await medir(p, "personagem", vp);
            // volta para lista
            await clicar(p, "button", "Voltar");
          }
        }
        await clicar(p, "button", "Voltar");
        await p.waitForTimeout(400);
      }
    }
    if (await clicar(p, ".topo nav button", "Conta")) {
      await p.waitForTimeout(500);
      await medir(p, "conta", vp);
    }
    if (await clicar(p, ".topo nav button", "Administração")) {
      await p.waitForTimeout(900);
      await medir(p, "admin-usuarios", vp);
      // sub-abas do painel Servidor
      for (const sub of ["Backups", "Configuração", "Logs"]) {
        if (await clicar(p, ".abas button", sub)) {
          await p.waitForTimeout(600);
          await medir(p, `admin-servidor-${sub.toLowerCase()}`, vp);
        }
      }
    }
  } catch (e) {
    console.log(`  ERRO ${vp}: ${String(e).slice(0, 140)}`);
  }
  await ctx.close();
}

await browser.close();
console.log(`\nProblemas encontrados: ${problemas.filter((x) => x.tela !== "PAGEERROR").length} telas · pageerrors: ${problemas.filter((x) => x.tela === "PAGEERROR").length}`);
problemas.filter((x) => x.tela === "PAGEERROR").forEach((x) => console.log("  PAGEERROR", x.vp, x.erro));
