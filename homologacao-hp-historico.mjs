// Homologação — histórico completo de HP na ficha (PR #26).
// Banco criado do zero em diretório temporário + migrations + fixtures
// sintéticas (teste-base.mjs) — nunca copia banco/mestre-rpg.db.
// Sobe o servidor buildado, semeia personagens com eventos de HP e
// valida a UI com Playwright real: 8 eventos iniciais, "Ver histórico
// completo", "Mostrar recentes", histórico vazio e curto — desktop/mobile.
import { chromium } from "playwright";
import { rmSync } from "node:fs";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, sessao, req,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("hp-historico");
const BANCO = `${DIR}/teste.db`;
const ARQ = `${DIR}/arq`, BKS = `${DIR}/bks`;

await prepararBanco(BANCO);
const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
let proc;
const browser = await chromium.launch();

async function abrirFicha(nomePersonagem, { mobile = false } = {}) {
  const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1366, height: 900 } });
  await ctx.addCookies([{ name: "mestre_rpg_session", value: token, url: BASE }]);
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Campanhas" }).click();
  await page.getByText("Campanha Teste", { exact: false }).first().click();
  await page.getByRole("button", { name: "Personagens" }).click();
  await page.getByText(nomePersonagem, { exact: false }).first().click();
  await page.waitForSelector(".hp-historico", { timeout: 15000 });
  return { ctx, page };
}

async function contarEventos(page) {
  return page.locator(".hp-historico .hp-evento").count();
}

let token;

try {
  proc = subirServidor(porta, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);

  // Cenário sintético: admin + campanha + regra de HP habilitada + ficha
  const cenario = await criarCenario(BASE, BANCO, {
    config: { hp: { habilitado: true, base: 100, porNivel: 10, campoId: "for", edicaoPor: "ambos" } },
  });
  token = decodeURIComponent(cenario.cookieMestre.split("=")[1]);
  const agora = Date.now();
  const mkHistorico = (n) => Array.from({ length: n }, (_, i) => ({
    em: new Date(agora - (n - i) * 3600_000).toISOString(),
    tipo: i % 3 === 0 ? "dano" : i % 3 === 1 ? "recuperacao" : "ajuste",
    quantidade: i % 3 === 0 ? -10 : i % 3 === 1 ? 15 : 5,
    motivo: `Evento ${i + 1}`,
    autorId: cenario.adminId, autorNome: "Mestre Teste",
  }));
  const char12 = cenario.novoPersonagem(cenario.membMestre, "Herói 12 eventos",
    { __hp: { atual: 120, historico: mkHistorico(12) } });
  cenario.novoPersonagem(cenario.membMestre, "Herói HP zerado",
    { __hp: { atual: 0, historico: [] } });
  cenario.novoPersonagem(cenario.membMestre, "Herói 3 eventos",
    { __hp: { atual: 140, historico: mkHistorico(3) } });
  console.log("seed:", { char12 });

  // ===== Desktop: 12 eventos =====
  sec("Desktop — 12 eventos de HP");
  {
    const { ctx, page } = await abrirFicha("Herói 12 eventos");
    t("exibe no máximo 8 eventos inicialmente", (await contarEventos(page)) === 8, `n=${await contarEventos(page)}`);
    const rotulo = await page.locator(".hp-historico strong").first().textContent().catch(() => "");
    t("rótulo mostra total (12)", /12/.test(rotulo ?? ""), `rotulo=${rotulo}`);
    const btn = page.getByRole("button", { name: /histórico completo/i });
    t("botão 'Ver histórico completo' presente", await btn.count() === 1);
    await btn.click();
    await page.waitForTimeout(200);
    t("expandido mostra os 12 eventos", (await contarEventos(page)) === 12, `n=${await contarEventos(page)}`);
    const primeiro = await page.locator(".hp-historico .hp-evento").first().textContent();
    t("ordem: mais recente primeiro", /Evento 12/.test(primeiro ?? ""), `primeiro=${primeiro?.slice(0, 60)}`);
    const ultimo = await page.locator(".hp-historico .hp-evento").last().textContent();
    t("ordem: mais antigo por último", /Evento 1(?!2)/.test(ultimo ?? "") || /Evento 1\b/.test(ultimo ?? ""), `ultimo=${ultimo?.slice(0, 60)}`);
    const btn2 = page.getByRole("button", { name: /Mostrar recentes/i });
    t("botão vira 'Mostrar recentes'", await btn2.count() === 1);
    await btn2.click();
    await page.waitForTimeout(200);
    t("recolhido volta a 8 eventos", (await contarEventos(page)) === 8, `n=${await contarEventos(page)}`);
    await ctx.close();
  }

  // ===== Desktop: histórico vazio =====
  sec("Desktop — histórico vazio");
  {
    const { ctx, page } = await abrirFicha("Herói HP zerado");
    // resumoHp injeta o evento virtual "HP inicial" quando não há histórico
    // persistido — comportamento correto, não é evento real gravado.
    const n = await contarEventos(page);
    t("histórico vazio renderiza só o evento virtual inicial", n === 1, `n=${n}`);
    const texto = await page.locator(".hp-historico .hp-evento").first().textContent().catch(() => "");
    t("evento virtual é 'HP inicial'", /inicial/i.test(texto ?? ""), `texto=${texto?.slice(0, 80)}`);
    t("sem botão de expandir", (await page.getByRole("button", { name: /histórico completo/i }).count()) === 0);
    await ctx.close();
  }

  // ===== Desktop: histórico curto (3 eventos) =====
  sec("Desktop — 3 eventos");
  {
    const { ctx, page } = await abrirFicha("Herói 3 eventos");
    t("exibe os 3 eventos", (await contarEventos(page)) === 3, `n=${await contarEventos(page)}`);
    t("sem botão de expandir (<=8)", (await page.getByRole("button", { name: /histórico completo/i }).count()) === 0);
    await ctx.close();
  }

  // ===== Mobile: 12 eventos =====
  sec("Mobile — 12 eventos");
  {
    const { ctx, page } = await abrirFicha("Herói 12 eventos", { mobile: true });
    t("mobile: 8 eventos inicialmente", (await contarEventos(page)) === 8, `n=${await contarEventos(page)}`);
    await page.getByRole("button", { name: /histórico completo/i }).click();
    await page.waitForTimeout(200);
    t("mobile: expandido mostra 12", (await contarEventos(page)) === 12, `n=${await contarEventos(page)}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
    t("mobile: sem overflow horizontal", !overflow);
    await ctx.close();
  }
} finally {
  await browser.close().catch(() => {});
  proc?.kill();
  await new Promise((r) => setTimeout(r, 1200));
  rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
