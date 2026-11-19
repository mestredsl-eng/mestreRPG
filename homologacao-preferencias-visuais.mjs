// Homologação E2E — preferências visuais da conta (Issue #132, etapa 2.2b).
// Servidor isolado (banco temporário) + frontend buildado. Cobre: carga de
// preferências persistidas, prévia sem persistência, PATCH do objeto visual
// completo, cancelamento, restaurar padrões, preservação das demais chaves,
// isolamento entre usuários, os cinco presets, prefers-reduced-motion,
// erro de API, salvamento repetido, desktop e mobile.
import { chromium } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepararBanco, portaLivre, subirServidor, esperarSaudavel, criarCenario, req, encerrarServidor, limparDir } from "./teste-base.mjs";

const DIR = mkdtempSync(join(tmpdir(), "mrpg-hom-visual-"));
const BANCO = join(DIR, "mestre-rpg.db");
await prepararBanco(BANCO);
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const proc = subirServidor(PORTA, { banco: BANCO, arquivos: join(DIR, "arq"), backups: join(DIR, "bks") });
proc.stderr.on("data", (d) => process.stderr.write(d));
await esperarSaudavel(BASE, proc);

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const OCULTISMO = {
  intensidade: "imersiva", corDestaque: "violeta", superficies: "elevado",
  textura: "intensa", animacoes: "completo", densidade: "ampla",
};
const PADRAO = {
  intensidade: "equilibrada", corDestaque: "vinho", superficies: "padrao",
  textura: "sutil", animacoes: "normal", densidade: "padrao",
};

const browser = await chromium.launch();

/** Conta PATCHes de /auth/preferences disparados pela página. */
function vigiarPatch(p, corpos = []) {
  p.on("request", (r) => {
    if (r.method() === "PATCH" && r.url().includes("/api/auth/preferences")) {
      try { corpos.push(JSON.parse(r.postData() ?? "{}")); } catch { corpos.push({}); }
    }
  });
}

async function abrirConta(p) {
  await p.goto(BASE, { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Conta", exact: true }).click();
  await p.locator(".prefs-visuais").waitFor({ timeout: 10000 });
}

const tokenDe = (cookie) => decodeURIComponent(cookie.split("=")[1]);
const ctxComCookie = async (cookie, opcoes = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...opcoes });
  await ctx.addCookies([{ name: "mestre_rpg_session", value: tokenDe(cookie), url: BASE }]);
  return ctx;
};

try {
  const c = await criarCenario(BASE, BANCO, {
    campanha: "Campanha Visual E2E",
    jogadores: { jogador1: "jogador_um", jogador2: "jogador_dois" },
  });
  const M = c.cookieMestre;
  const J1 = c.jogadores.jogador1.cookie;

  // Chaves legadas que precisam ser preservadas pelo PATCH visual.
  await req(BASE, "PATCH", "/auth/preferences", {
    cookie: M,
    body: { dados: { corExterna: "#112233", corInterna: "#445566" }, temaMesa: "vinho", visibilidade: { aparencia: false } },
  });

  // ================= DESKTOP — mestre =================
  {
    const ctx = await ctxComCookie(M);
    const p = await ctx.newPage();
    const erros = [];
    p.on("pageerror", (e) => erros.push(String(e)));
    const patches = [];
    vigiarPatch(p, patches);

    sec("Desktop — estrutura do editor");
    await abrirConta(p);
    t("seção Aparência presente", await p.locator(".prefs-visuais").count() === 1);
    t("5 presets de atmosfera", await p.locator(".prefs-atmosfera").count() === 5);
    t("6 dimensões (radiogroups)", await p.locator(".prefs-dimensao").count() === 6);
    t("19 opções de rádio no total", await p.getByRole("radio").count() === 19);
    const nomesPresets = await p.locator(".prefs-atmosfera strong").allInnerTexts();
    for (const n of ["Arquivo Oculto", "Investigação Noturna", "Ocultismo", "Terror Psicológico", "Mistério Sobrenatural"]) {
      t(`preset "${n}"`, nomesPresets.includes(n));
    }

    sec("Desktop — prévia não persiste");
    t("documentElement inicia no padrão (vinho)", await p.evaluate(() => document.documentElement.dataset.corDestaque) === "vinho");
    await p.locator(".prefs-atmosfera", { hasText: "Ocultismo" }).click();
    await p.waitForTimeout(300);
    t("prévia reflete violeta", (await p.locator(".pv-visual").evaluate((el) => getComputedStyle(el).getPropertyValue("--horror-destaque").trim())) === "#7a5f9e");
    t("prévia tem data-cor-destaque=violeta", await p.locator(".pv-visual").getAttribute("data-cor-destaque") === "violeta");
    t("prévia tem data-animacoes=completo", await p.locator(".pv-visual").getAttribute("data-animacoes") === "completo");
    t("zero PATCH antes de aplicar", patches.length === 0, JSON.stringify(patches));
    t("tema global intacto após prévia", await p.evaluate(() => document.documentElement.dataset.corDestaque) === "vinho");
    t("botão Aplicar habilitado (rascunho sujo)", await p.getByRole("button", { name: "Aplicar aparência" }).isEnabled());

    sec("Desktop — aplicar salva objeto completo");
    await p.getByRole("button", { name: "Aplicar aparência" }).click();
    await p.waitForTimeout(1200);
    t("exatamente 1 PATCH", patches.length === 1, JSON.stringify(patches));
    const enviado = patches[0]?.visual;
    t("PATCH enviou objeto visual completo", enviado && Object.keys(enviado).length === 6 &&
      enviado.intensidade === "imersiva" && enviado.corDestaque === "violeta" &&
      enviado.superficies === "elevado" && enviado.textura === "intensa" &&
      enviado.animacoes === "completo" && enviado.densidade === "ampla", JSON.stringify(enviado));
    t("tema global aplicado (violeta)", await p.evaluate(() => document.documentElement.dataset.corDestaque) === "violeta");
    t("movimento efetivo completo", await p.evaluate(() => document.documentElement.dataset.movimentoEfetivo) === "completo");
    t("sem erros de página", erros.length === 0, erros.join("|"));

    sec("Desktop — persistência e recarga");
    const me = await req(BASE, "GET", "/auth/me", { cookie: M });
    const prefs = me.json?.usuario?.preferences ?? {};
    t("GET /me retorna visual salvo", JSON.stringify(prefs.visual) === JSON.stringify(OCULTISMO), JSON.stringify(prefs.visual));
    t("dados preservado", prefs.dados?.corExterna === "#112233" && prefs.dados?.corInterna === "#445566", JSON.stringify(prefs.dados));
    t("temaMesa preservado", prefs.temaMesa === "vinho", JSON.stringify(prefs.temaMesa));
    t("visibilidade preservada", prefs.visibilidade?.aparencia === false, JSON.stringify(prefs.visibilidade));

    await p.reload({ waitUntil: "networkidle" });
    await p.getByRole("button", { name: "Conta", exact: true }).click();
    await p.locator(".prefs-visuais").waitFor({ timeout: 10000 });
    t("após reload, tema global = violeta", await p.evaluate(() => document.documentElement.dataset.corDestaque) === "violeta");
    t("preset Ocultismo marcado como ativo", await p.locator(".prefs-atmosfera.ativo", { hasText: "Ocultismo" }).count() === 1);
    t("Ocultismo expõe aria-pressed=true", await p.locator('.prefs-atmosfera[aria-pressed="true"]').count() === 1);
    t("rádio violeta marcado", await p.locator("#pv-corDestaque-violeta").isChecked());
    t("Aplicar desabilitado sem alterações", await p.getByRole("button", { name: "Aplicar aparência" }).isDisabled());

    sec("Desktop — cancelar descarta");
    await p.locator(".prefs-atmosfera", { hasText: "Arquivo Oculto" }).click();
    await p.waitForTimeout(200);
    t("rascunho mudou (âmbar? não — vinho/flat)", await p.locator(".prefs-atmosfera.ativo", { hasText: "Arquivo Oculto" }).count() === 1);
    t("prévia mudou p/ flat", await p.locator(".pv-visual").getAttribute("data-superficies") === "flat");
    await p.getByRole("button", { name: "Cancelar", exact: true }).click();
    await p.waitForTimeout(200);
    t("cancelar restaura Ocultismo", await p.locator(".prefs-atmosfera.ativo", { hasText: "Ocultismo" }).count() === 1);
    t("prévia voltou a elevado", await p.locator(".pv-visual").getAttribute("data-superficies") === "elevado");

    sec("Desktop — erro de API e nova tentativa");
    await p.locator('label[for="pv-corDestaque-ambar"]').click();
    await p.waitForTimeout(200);
    await p.route("**/api/auth/preferences", (route) =>
      route.request().method() === "PATCH"
        ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ erro: "falha simulada" }) })
        : route.continue());
    await p.getByRole("button", { name: "Aplicar aparência" }).click();
    await p.locator(".prefs-visuais .erro[role=alert]").waitFor({ timeout: 8000 });
    t("erro de API exibido", (await p.locator(".prefs-visuais .erro[role=alert]").innerText()).includes("falha simulada"));
    t("tema global NÃO mudou após erro", await p.evaluate(() => document.documentElement.dataset.corDestaque) === "violeta");
    await p.unroute("**/api/auth/preferences");
    await p.getByRole("button", { name: "Aplicar aparência" }).click();
    await p.waitForTimeout(1200);
    t("segunda tentativa salvou", await p.evaluate(() => document.documentElement.dataset.corDestaque) === "ambar");
    const me2 = await req(BASE, "GET", "/auth/me", { cookie: M });
    t("visual persistido = âmbar/violeta base", me2.json?.usuario?.preferences?.visual?.corDestaque === "ambar");

    sec("Desktop — salvar repetido é seguro");
    const patches2 = [];
    vigiarPatch(p, patches2);
    // atrasa o PATCH para tentar clique duplo durante o salvamento
    await p.route("**/api/auth/preferences", async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      await new Promise((r) => setTimeout(r, 600));
      return route.continue();
    });
    await p.locator('label[for="pv-densidade-ampla"]').click(); // já é ampla? muda p/ compacta primeiro
    await p.locator('label[for="pv-densidade-compacta"]').click();
    await p.waitForTimeout(200);
    await p.getByRole("button", { name: "Aplicar aparência" }).click();
    await p.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("Salvando"));
      if (b) b.click();
    });
    await p.waitForTimeout(1500);
    await p.unroute("**/api/auth/preferences");
    const patchesVisual = patches2.filter((b) => b.visual);
    t("duplo clique gerou no máximo 1 PATCH visual", patchesVisual.length <= 1, JSON.stringify(patchesVisual));

    sec("Desktop — restaurar padrões");
    const patches3 = [];
    vigiarPatch(p, patches3);
    await p.getByRole("button", { name: "Restaurar padrões" }).click();
    await p.waitForTimeout(1200);
    const enviadoPadrao = patches3.find((b) => b.visual)?.visual;
    t("restaurar envia VISUAL_PADRAO completo", JSON.stringify(enviadoPadrao) === JSON.stringify(PADRAO), JSON.stringify(enviadoPadrao));
    t("tema global voltou ao padrão", await p.evaluate(() => document.documentElement.dataset.corDestaque) === "vinho");
    t("movimento efetivo normal", await p.evaluate(() => document.documentElement.dataset.movimentoEfetivo) === "normal");

    sec("Desktop — acessibilidade");
    const focoOk = await p.evaluate(() => {
      const inp = document.getElementById("pv-corDestaque-ambar");
      inp.focus();
      const opcao = inp.closest(".prefs-opcao");
      return getComputedStyle(opcao).outlineStyle !== "none" || getComputedStyle(opcao).boxShadow !== "none";
    });
    t("foco visível na opção de rádio", focoOk);
    t("radiogroup tem aria-label", await p.locator("[role=radiogroup][aria-label='Cor de destaque']").count() === 1);
    t("todos os presets expõem aria-pressed", await p.locator(".prefs-atmosfera[aria-pressed]").count() === 5);

    await ctx.close();
  }

  // ================= prefers-reduced-motion =================
  {
    // Mestre com Ocultismo salvo (animacoes=completo) via API.
    await req(BASE, "PATCH", "/auth/preferences", { cookie: M, body: { visual: OCULTISMO } });

    const ctxRed = await ctxComCookie(M, { reducedMotion: "reduce" });
    const p = await ctxRed.newPage();
    await p.goto(BASE, { waitUntil: "networkidle" });
    await p.getByRole("button", { name: "Conta", exact: true }).click();
    await p.locator(".prefs-visuais").waitFor({ timeout: 10000 });
    t("SO reduce → movimento efetivo reduzido", await p.evaluate(() => document.documentElement.dataset.movimentoEfetivo) === "reduzido");
    t("nota de movimento reduzido visível", await p.getByText("movimento reduzido").count() > 0);
    await ctxRed.close();

    const ctxNorm = await ctxComCookie(M);
    const p2 = await ctxNorm.newPage();
    await p2.goto(BASE, { waitUntil: "networkidle" });
    await p2.waitForTimeout(800);
    t("sem reduce → movimento efetivo completo", await p2.evaluate(() => document.documentElement.dataset.movimentoEfetivo) === "completo");
    await ctxNorm.close();
  }

  // ================= ISOLAMENTO entre usuários =================
  {
    const ctx = await ctxComCookie(J1);
    const p = await ctx.newPage();
    await p.goto(BASE, { waitUntil: "networkidle" });
    await p.waitForTimeout(800);
    t("jogador1 NÃO herda visual do mestre", await p.evaluate(() => document.documentElement.dataset.corDestaque) === "vinho");
    t("jogador1 movimento efetivo normal", await p.evaluate(() => document.documentElement.dataset.movimentoEfetivo) === "normal");
    await p.getByRole("button", { name: "Conta", exact: true }).click();
    await p.locator(".prefs-visuais").waitFor({ timeout: 10000 });
    t("jogador1 vê editor com padrão", await p.locator("#pv-corDestaque-vinho").isChecked());
    t("jogador1 sem visual salvo no /me", (await req(BASE, "GET", "/auth/me", { cookie: J1 })).json?.usuario?.preferences?.visual === undefined);
    await ctx.close();
  }

  // ================= MOBILE 390px =================
  {
    const ctx = await ctxComCookie(M, { viewport: { width: 390, height: 844 } });
    const p = await ctx.newPage();
    const erros = [];
    p.on("pageerror", (e) => erros.push(String(e)));
    await abrirConta(p);
    t("mobile: seção Aparência presente", await p.locator(".prefs-visuais").count() === 1);
    t("mobile: 5 presets empilhados", await p.locator(".prefs-atmosfera").count() === 5);
    t("mobile: prévia renderiza", await p.locator(".pv-visual").count() === 1);
    await p.locator(".prefs-atmosfera", { hasText: "Investigação Noturna" }).click();
    await p.waitForTimeout(200);
    t("mobile: preset altera prévia", await p.locator(".pv-visual").getAttribute("data-cor-destaque") === "ambar");
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    t("mobile: sem overflow horizontal", !overflow);
    t("mobile: sem erros de página", erros.length === 0, erros.join("|"));
    await ctx.close();
  }
} finally {
  await browser.close();
  await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n${pass} ok / ${fail} falhas`);
process.exit(fail ? 1 : 0);
