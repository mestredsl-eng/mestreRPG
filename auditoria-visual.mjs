#!/usr/bin/env node
// Auditoria visual/acessibilidade essencial (E2E real, Playwright).
// Sobe servidor com banco sintético + SPA de produção (site/dist) e
// percorre as telas em 3 viewports medindo:
//   - rolagem horizontal indevida (scrollWidth > clientWidth)
//   - elementos mais largos que a viewport
//   - botões sem nome acessível
//   - inputs sem label associado
// Não é suíte de assertiva de design: imprime relatório de achados.
import { chromium } from "playwright";
import { join } from "path";
import { mkdirSync } from "fs";
import {
  req, dirTeste, prepararBanco, portaLivre, subirServidor,
  esperarSaudavel, encerrarServidor, limparDir, criarCenario,
} from "./teste-base.mjs";

const DIR = dirTeste("visual");
const BANCO = join(DIR, "mestre-rpg.db");
const ARQ = join(DIR, "arquivos");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc;

const VIEWPORTS = [
  { nome: "desktop", width: 1366, height: 768 },
  { nome: "tablet", width: 768, height: 1024 },
  { nome: "celular", width: 390, height: 844 },
];

const achados = [];
function anotar(tela, viewport, tipo, detalhe) {
  achados.push({ tela, viewport, tipo, detalhe });
  console.log(`  [${viewport}/${tela}] ${tipo}: ${detalhe}`);
}

async function medirPagina(page, tela, vp) {
  await page.waitForTimeout(600);
  const m = await page.evaluate(() => {
    const de = document.documentElement;
    const overflowX = de.scrollWidth > de.clientWidth + 1;
    // elementos visíveis mais largos que a viewport
    const largos = [];
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width > de.clientWidth + 1 && r.height > 0) {
        const cls = (el.className && typeof el.className === "string") ? "." + el.className.split(" ")[0] : el.tagName.toLowerCase();
        largos.push(`${el.tagName.toLowerCase()}${cls} w=${Math.round(r.width)}`);
        if (largos.length >= 5) break;
      }
    }
    // botões sem nome acessível
    const botoesSemNome = [];
    for (const b of document.querySelectorAll("button")) {
      const nome = (b.textContent || "").trim() || b.getAttribute("aria-label") || b.getAttribute("title") || "";
      const r = b.getBoundingClientRect();
      if (!nome && r.width > 0 && r.height > 0) botoesSemNome.push(b.outerHTML.slice(0, 120));
    }
    // inputs sem label/aria
    const inputsSemLabel = [];
    for (const i of document.querySelectorAll("input, select, textarea")) {
      const r = i.getBoundingClientRect();
      if (r.width === 0) continue;
      const id = i.id;
      const temLabel = (id && document.querySelector(`label[for="${id}"]`))
        || i.closest("label")
        || i.getAttribute("aria-label") || i.getAttribute("aria-labelledby")
        || i.getAttribute("placeholder");
      if (!temLabel) inputsSemLabel.push(`${i.tagName.toLowerCase()} type=${i.type || ""} :: ${i.outerHTML.slice(0, 140)}`);
    }
    return { overflowX, scrollW: de.scrollWidth, clientW: de.clientWidth, largos, botoesSemNome, inputsSemLabel };
  });
  if (m.overflowX) anotar(tela, vp.nome, "rolagem-horizontal", `scrollWidth=${m.scrollW} clientWidth=${m.clientW}`);
  for (const l of m.largos) anotar(tela, vp.nome, "elemento-mais-largo", l);
  for (const b of m.botoesSemNome) anotar(tela, vp.nome, "botao-sem-nome", b);
  for (const i of m.inputsSemLabel) anotar(tela, vp.nome, "input-sem-label", i);
  return m;
}

async function clicaSeExiste(page, seletor, timeout = 4000) {
  try { await page.click(seletor, { timeout }); return true; } catch { return false; }
}

try {
  await prepararBanco(BANCO);
  mkdirSync(ARQ, { recursive: true });
  mkdirSync(BKS, { recursive: true });
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO);
  const campId = c.campId;

  const browser = await chromium.launch();
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => anotar("global", vp.nome, "erro-js", String(e).slice(0, 200)));

    // ---- anônimo: login ----
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await medirPagina(page, "login", vp);

    // ---- autenticado como mestre ----
    const [ckNome, ckValor] = c.cookieMestre.split("=", 2);
    await ctx.addCookies([{ name: ckNome, value: decodeURIComponent(ckValor), url: BASE }]);
    await page.goto(BASE + "/", { waitUntil: "networkidle" });
    await page.waitForTimeout(800);

    const telas = [
      ["painel", async () => {}],
      ["campanhas", async () => clicaSeExiste(page, 'button:has-text("Campanhas")')],
      ["acervo", async () => clicaSeExiste(page, 'button:has-text("Acervo")')],
      ["admin", async () => clicaSeExiste(page, 'button:has-text("Administração")')],
      ["conta", async () => clicaSeExiste(page, 'button:has-text("Conta")')],
    ];
    for (const [tela, acao] of telas) {
      await acao();
      await page.waitForTimeout(500);
      await medirPagina(page, tela, vp);
    }

    // ---- dentro da campanha: cada aba ----
    await clicaSeExiste(page, 'button:has-text("Campanhas")');
    await page.waitForTimeout(500);
    // abre o card da campanha (section.clicavel via onClick)
    const abriu = await clicaSeExiste(page, ".cartao-campanha", 3000);
    await page.waitForTimeout(800);
    if (!abriu) anotar("campanha", vp.nome, "campanha-nao-abriu", "");
    const abas = ["Informações", "Mesa", "Personagens", "Diário", "Histórico", "Arquivos", "Fichas", "Regras", "Participantes", "Convites"];
    for (const aba of abas) {
      const ok = await clicaSeExiste(page, `button:has-text("${aba}")`, 3000);
      if (!ok) { anotar(`campanha/${aba.toLowerCase()}`, vp.nome, "aba-nao-encontrada", ""); continue; }
      await page.waitForTimeout(700);
      await medirPagina(page, `campanha/${aba.toLowerCase()}`, vp);
      // Personagens: abre a ficha do mestre para medir patrimônio/ficha
      if (aba === "Personagens") {
        await clicaSeExiste(page, "tr.clicavel", 3000);
        await page.waitForTimeout(700);
        await medirPagina(page, "personagem/detalhe", vp);
      }
    }

    await ctx.close();
  }
  await browser.close();
} finally {
  await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n==== auditoria visual concluída — ${achados.length} achados ====`);
process.exit(0);
