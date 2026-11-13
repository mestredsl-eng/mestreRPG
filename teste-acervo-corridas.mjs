#!/usr/bin/env node
// Corridas assíncronas da tela Acervo (E2E real, Playwright + respostas
// atrasadas artificialmente via page.route). Prova que respostas antigas
// não sobrescrevem telas novas e que o fluxo normal continua funcionando.
import { chromium } from "playwright";
import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import {
  req, dirTeste, prepararBanco, portaLivre, subirServidor,
  esperarSaudavel, encerrarServidor, limparDir, criarCenario,
} from "./teste-base.mjs";

const DIR = dirTeste("acervo-corridas");
const BANCO = join(DIR, "mestre-rpg.db");
const ARQ = join(DIR, "arquivos");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc;
let browser;
let pass = 0, fail = 0;

function t(desc, ok, details = "") {
  if (ok) { console.log(`  ok ${desc}`); pass++; }
  else { console.log(`  FALHOU ${desc} ${details}`); fail++; }
}
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Intercepta GET /api/biblioteca/livros/:id (detalhe) e atrasa a resposta.
async function atrasarDetalhe(page, bookId, ms) {
  await page.route(`**/api/biblioteca/livros/${bookId}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await dormir(ms);
    const resp = await route.fetch();
    await route.fulfill({ response: resp });
  });
}

// Intercepta GET /api/biblioteca/livros?* (lista/busca) com atraso por query.
async function atrasarLista(page, mapaQueryParaMs) {
  await page.route("**/api/biblioteca/livros?*", async (route) => {
    const u = new URL(route.request().url());
    const q = u.searchParams.get("q") ?? "";
    const ms = mapaQueryParaMs(q) ?? 0;
    if (ms) await dormir(ms);
    const resp = await route.fetch();
    await route.fulfill({ response: resp });
  });
}

// Intercepta GET /api/biblioteca/livros/:id/backups com resposta sintética atrasada.
async function atrasarBackups(page, bookId, ms, motivo) {
  await page.route(`**/api/biblioteca/livros/${bookId}/backups`, async (route) => {
    await dormir(ms);
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ backups: [{ id: `bk-${bookId}`, motivo, createdAt: new Date().toISOString(), itens: 3 }] }),
    });
  });
}

try {
  await prepararBanco(BANCO);
  mkdirSync(ARQ, { recursive: true });
  mkdirSync(BKS, { recursive: true });
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO);
  const cm = c.cookieMestre;

  // ---- massa de dados via API real ----
  const mkLivro = async (titulo, itemNome, key) => {
    const r = await req(BASE, "POST", "/biblioteca/livros", {
      cookie: cm,
      body: { titulo, tipo: "livro", itens: [{ kind: "regra", key, name: itemNome, ordem: 0 }] },
    });
    if (r.status !== 200 && r.status !== 201) throw new Error("criar livro falhou: " + JSON.stringify(r.json));
    return r.json.livro.id;
  };
  const idA = await mkLivro("Livro Alfa Corrida", "Item Alfa Unico", "item_alfa");
  const idB = await mkLivro("Livro Beta Corrida", "Item Beta Unico", "item_beta");
  const idLento = await mkLivro("Livro Lento Corrida", "Item Lento Unico", "item_lento");

  browser = await chromium.launch();
  // MRPG_CORRIDAS_FALHO=1: falha controlada logo após abrir o browser —
  // prova que finally fecha browser, servidor e diretório temporário.
  if (process.env.MRPG_CORRIDAS_FALHO === "1") throw new Error("falha controlada de limpeza");
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await ctx.newPage();
  const errosJs = [];
  page.on("pageerror", (e) => errosJs.push(String(e)));
  page.on("dialog", (d) => void d.accept());
  const [ckN, ckV] = cm.split("=", 2);
  await ctx.addCookies([{ name: ckN, value: decodeURIComponent(ckV), url: BASE }]);
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.click('button:has-text("Acervo")');
  await page.waitForSelector("text=Livro Alfa Corrida", { timeout: 10000 });

  // ===== 1. abrir A (lento) depois B (rápido): resposta de A não pode sobrescrever B =====
  await atrasarDetalhe(page, idA, 900);
  await atrasarDetalhe(page, idB, 120);
  await page.click(`tr:has-text("Livro Alfa Corrida") button:has-text("Abrir")`);
  await page.click(`tr:has-text("Livro Beta Corrida") button:has-text("Abrir")`);
  await page.waitForSelector("text=Item Beta Unico", { timeout: 8000 });
  await dormir(1200); // deixa a resposta atrasada de A chegar
  t("troca rápida A→B mantém livro B aberto", await page.locator('h2:has-text("Livro Beta Corrida")').count() === 1);
  t("itens exibidos são de B", await page.locator("text=Item Beta Unico").count() >= 1 && await page.locator("text=Item Alfa Unico").count() === 0);
  await page.click('button:has-text("Fechar")');

  // ===== 2. busca rápida: resposta antiga não substitui a nova =====
  await atrasarLista(page, (q) => (q.includes("alfa") ? 800 : q ? 60 : 0));
  await page.fill('input[type="search"]', "alfa");
  await dormir(150);
  await page.fill('input[type="search"]', "beta");
  await page.waitForSelector("text=Livro Beta Corrida", { timeout: 8000 });
  await dormir(1000); // resposta de "alfa" chega atrasada
  t("busca nova prevalece sobre resposta antiga", await page.locator("td:has-text('Livro Alfa Corrida')").count() === 0
    && await page.locator("td:has-text('Livro Beta Corrida')").count() >= 1);
  await page.fill('input[type="search"]', "");
  await page.waitForSelector("text=Livro Alfa Corrida", { timeout: 8000 });
  await page.unroute("**/api/biblioteca/livros?*");

  // ===== 3. backups de A não aparecem no livro B =====
  await atrasarBackups(page, idA, 800, "BACKUP-DO-LIVRO-A");
  await page.route(`**/api/biblioteca/livros/${idB}/backups`, async (route) => {
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ backups: [{ id: "bk-b", motivo: "BACKUP-DO-LIVRO-B", createdAt: new Date().toISOString(), itens: 1 }] }),
    });
  });
  await page.click(`tr:has-text("Livro Alfa Corrida") button:has-text("Abrir")`);
  await page.waitForSelector("text=Item Alfa Unico", { timeout: 8000 });
  await page.click('button:has-text("Backups")'); // dispara backups de A (lento)
  await dormir(200);
  await page.click('button:has-text("Fechar")');
  await page.click(`tr:has-text("Livro Beta Corrida") button:has-text("Abrir")`);
  await page.waitForSelector("text=Item Beta Unico", { timeout: 8000 });
  await page.click('button:has-text("Backups")'); // dispara backups de B (rápido)
  await page.waitForSelector("text=BACKUP-DO-LIVRO-B", { timeout: 8000 });
  await dormir(1000); // resposta de A chega atrasada
  t("backup de B visível", await page.locator("text=BACKUP-DO-LIVRO-B").count() >= 1);
  t("backup de A não aparece no livro B", await page.locator("text=BACKUP-DO-LIVRO-A").count() === 0);
  await page.click('button:has-text("Fechar")');
  await page.unroute(`**/api/biblioteca/livros/${idA}/backups`);
  await page.unroute(`**/api/biblioteca/livros/${idB}/backups`);

  // ===== 4. fechar painel durante carregamento: resposta tardia não reabre =====
  await atrasarDetalhe(page, idLento, 1200);
  await page.click(`tr:has-text("Livro Lento Corrida") button:has-text("Abrir")`);
  await page.click('button:has-text("Fechar")'); // fecha antes da resposta
  await dormir(1500); // resposta chega depois
  t("fechar durante load não reabre detalhe", await page.locator('h2:has-text("Livro Lento Corrida")').count() === 0
    && await page.locator("text=Item Lento Unico").count() === 0);
  await page.unroute(`**/api/biblioteca/livros/${idLento}`);

  // ===== 5. fluxo normal: criar → editar → excluir → restaurar → exportar → importar =====
  await page.click('button:has-text("+ Novo livro")');
  await page.fill('.formulario input >> nth=0', "Livro UI Corrida"); // Título (1º campo do modal)
  await page.click('.modal button:has-text("Salvar"), [class*=modal] button:has-text("Salvar")');
  await page.waitForSelector("text=Livro UI Corrida", { timeout: 8000 });
  t("criar livro via UI", await page.locator("td:has-text('Livro UI Corrida')").count() >= 1);

  // editar
  await page.click(`tr:has-text("Livro UI Corrida") button:has-text("Abrir")`);
  await page.waitForSelector('h2:has-text("Livro UI Corrida")', { timeout: 8000 });
  await page.click('button:has-text("Editar")');
  await page.fill('.formulario input >> nth=0', "Livro UI Corrida Editado");
  await page.click('button:has-text("Salvar")');
  await page.waitForSelector("text=Livro UI Corrida Editado", { timeout: 8000 });
  t("editar livro via UI", await page.locator("h2:has-text('Livro UI Corrida Editado')").count() >= 1);

  // excluir (soft) — confirm dialog já é aceito pelo handler
  await page.click('button.perigo:has-text("Excluir"), button:has-text("Excluir")');
  await dormir(800);
  t("excluir livro via UI", await page.locator('h2:has-text("Livro UI Corrida Editado")').count() === 0);

  // mostrar excluídos → restaurar
  await page.click('label:has-text("Mostrar excluídos") input');
  await page.waitForSelector("text=Livro UI Corrida Editado", { timeout: 8000 });
  t("livro excluído aparece na lista de excluídos", await page.locator("td:has-text('Livro UI Corrida Editado')").count() >= 1);
  await page.click(`tr:has-text("Livro UI Corrida Editado") button:has-text("Restaurar")`);
  await dormir(800);
  await page.click('label:has-text("Mostrar excluídos") input'); // desmarca
  await page.waitForSelector("text=Livro UI Corrida Editado", { timeout: 8000 });
  t("restaurar livro via UI", await page.locator("td:has-text('Livro UI Corrida Editado')").count() >= 1);

  // exportar (download do livro)
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 8000 }),
    page.click(`tr:has-text("Livro UI Corrida Editado") button:has-text("Exportar")`),
  ]);
  t("exportar livro via UI", !!download.suggestedFilename());

  // importar envelope JSON
  const envelope = {
    formato: "mestre-rpg-biblioteca", versao: 1, exportadoEm: new Date().toISOString(),
    livros: [{ titulo: "Livro Importado UI", tipo: "livro", itens: [{ kind: "regra", key: "imp1", name: "Item Importado", ordem: 0 }] }],
  };
  const arqImport = join(DIR, "import.json");
  writeFileSync(arqImport, JSON.stringify(envelope));
  await page.setInputFiles('input[type="file"]', arqImport);
  await page.waitForSelector("text=Prévia da importação", { timeout: 10000 });
  const [respImport] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/biblioteca/importar/confirmar"), { timeout: 10000 }),
    page.click('button:has-text("Confirmar importação")'),
  ]);
  const corpoImport = await respImport.json().catch(() => null);
  await page.waitForTimeout(1200);
  if (await page.locator("td:has-text('Livro Importado UI')").count() === 0) {
    const notif = await page.locator(".notificacao, [class*=notific], .toast").allTextContents().catch(() => []);
    console.log("  DEBUG import status:", respImport.status(), JSON.stringify(corpoImport)?.slice(0, 300), "| notif:", JSON.stringify(notif).slice(0, 300));
  }
  t("importar livro via UI", await page.locator("td:has-text('Livro Importado UI')").count() >= 1);

  t("sem erros de JS na página", errosJs.length === 0, errosJs.join(" | ").slice(0, 300));
} finally {
  if (browser) await browser.close().catch(() => {});
  await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
