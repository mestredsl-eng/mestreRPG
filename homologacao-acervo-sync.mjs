// Homologação E2E — fluxo de sincronização Acervo → campanha (PR #55).
// Servidor isolado + Playwright. Cobre na interface real:
// prévia obrigatória antes de aplicar, decisões manter/usar livro,
// atualização só-no-livro, resultado da sincronização, remoção de
// vínculo e responsividade mobile 390px.
import { chromium } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepararBanco, portaLivre, subirServidor, esperarSaudavel, criarCenario, req, comDb, encerrarServidor, limparDir } from "./teste-base.mjs";

const DIR = mkdtempSync(join(tmpdir(), "mrpg-hom-acervo-sync-"));
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

const cenario = await criarCenario(BASE, BANCO, { campanha: "Campanha Sync UI", jogadores: {} });
const CID = cenario.campId, CM = cenario.cookieMestre;
const NOME = "Campanha Sync UI";

// ---- massa via API real ----
const livro = await req(BASE, "POST", "/biblioteca/livros", {
  cookie: CM,
  body: {
    titulo: "Livro Sync UI", tipo: "livro",
    itens: [
      { kind: "atributo", key: "ui_forca", name: "Força UI", definition: { descricao: "forca v1" } },
      { kind: "talento", key: "ui_talento", name: "Talento UI", definition: {} },
    ],
  },
});
const BOOK = livro.json?.livro?.id;
t("livro de homologação criado", livro.status === 201 && !!BOOK, `status=${livro.status}`);

const elId = (kind, key) => comDb(BANCO, (db) => db.prepare(
  `select rd.id from rule_definitions rd join rule_sets rs on rs.id=rd.rule_set_id
   where rs.campaign_id=? and rd.kind=? and rd.key=?`,
).get(CID, kind, key)?.id);
const defAtual = async (kind, key) => {
  const r = await req(BASE, "GET", `/campaigns/${CID}/regras/elementos`, { cookie: CM });
  return (r.json?.elementos ?? []).find((e) => e.kind === kind && e.key === key);
};

const browser = await chromium.launch();
try {
  async function abrirRegrasAcervo(ctx) {
    const p = await ctx.newPage();
    const erros = [];
    p.on("pageerror", (e) => erros.push(String(e)));
    const [ckN, ckV] = CM.split("=", 2);
    await ctx.addCookies([{ name: ckN, value: decodeURIComponent(ckV), url: BASE }]);
    await p.goto(BASE, { waitUntil: "networkidle" });
    await p.getByRole("button", { name: "Campanhas" }).click();
    await p.waitForTimeout(700);
    await p.locator(".cartao-campanha", { hasText: NOME }).first().click();
    await p.waitForTimeout(1000);
    await p.locator(".abas button", { hasText: "Regras" }).first().click();
    await p.waitForTimeout(900);
    await p.locator(".abas button", { hasText: "Acervo" }).last().click();
    await p.waitForSelector(`text=Livro Sync UI`, { timeout: 10000 });
    return { p, erros };
  }
  const linhaLivro = (p) => p.locator(".elemento", { hasText: "Livro Sync UI" }).first();
  const previa = (p) => p.locator("section.cartao", { has: p.locator("h4", { hasText: "Prévia de sincronização" }) });

  // ---------- DESKTOP — mestre ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const { p, erros } = await abrirRegrasAcervo(ctx);

    sec("Desktop — prévia obrigatória e primeira sincronização");
    await linhaLivro(p).getByRole("button", { name: /Pré-visualizar/ }).click();
    await previa(p).waitFor({ timeout: 10000 });
    t("prévia mostra 2 itens novos", (await previa(p).innerText()).includes("2 novo(s)"));
    t("prévia sem decisões pendentes libera confirmação", await previa(p).getByRole("button", { name: "Confirmar sincronização" }).isEnabled());
    await previa(p).getByRole("button", { name: "Confirmar sincronização" }).click();
    await p.getByText("Sincronização concluída").first().waitFor({ timeout: 10000 });
    t("resultado da sincronização exibido", (await p.getByText("Sincronização concluída").count()) > 0);
    await p.waitForTimeout(800);
    t("livro marcado como aplicado", (await linhaLivro(p).innerText()).includes("Aplicado v"));

    sec("Desktop — divergência só na campanha: decisão usar_livro");
    // campanha diverge manualmente; livro permanece intacto
    await req(BASE, "PATCH", `/campaigns/${CID}/regras/elementos/${elId("atributo", "ui_forca")}`, {
      cookie: CM, body: { definition: { descricao: "forca local custom" } },
    });
    await linhaLivro(p).getByRole("button", { name: /Pré-visualizar/ }).click();
    await previa(p).waitFor({ timeout: 10000 });
    const txtPrevia = await previa(p).innerText();
    t("prévia distingue mudança só na campanha", txtPrevia.includes("Só a campanha mudou") || txtPrevia.includes("conflito(s) pendentes"), txtPrevia.slice(0, 200));
    t("confirmação bloqueada sem decisão", !(await previa(p).getByRole("button", { name: "Confirmar sincronização" }).isEnabled()));
    await previa(p).getByLabel("Decisão para atributo:ui_forca").selectOption("usar_livro");
    await previa(p).getByRole("button", { name: "Confirmar sincronização" }).click();
    await p.getByText("Sincronização concluída").first().waitFor({ timeout: 10000 });
    const elUsar = await defAtual("atributo", "ui_forca");
    t("usar_livro aplicou valor do livro", elUsar?.definition?.descricao === "forca v1", JSON.stringify(elUsar?.definition));

    sec("Desktop — divergência só na campanha: decisão manter_campanha");
    await req(BASE, "PATCH", `/campaigns/${CID}/regras/elementos/${elId("atributo", "ui_forca")}`, {
      cookie: CM, body: { definition: { descricao: "forca local 2" } },
    });
    await linhaLivro(p).getByRole("button", { name: /Pré-visualizar/ }).click();
    await previa(p).waitFor({ timeout: 10000 });
    await previa(p).getByLabel("Decisão para atributo:ui_forca").selectOption("manter_campanha");
    await previa(p).getByRole("button", { name: "Confirmar sincronização" }).click();
    await p.getByText("Sincronização concluída").first().waitFor({ timeout: 10000 });
    const elManter = await defAtual("atributo", "ui_forca");
    t("manter_campanha preservou valor personalizado", elManter?.definition?.descricao === "forca local 2", JSON.stringify(elManter?.definition));

    sec("Desktop — atualização só no livro aplica sem decisão");
    const itForca = (await req(BASE, "GET", `/biblioteca/livros/${BOOK}`, { cookie: CM })).json.itens.find((i) => i.key === "ui_forca");
    await req(BASE, "PATCH", `/biblioteca/livros/${BOOK}/itens/${itForca.id}`, { cookie: CM, body: { definition: { descricao: "forca v2 livro" } } });
    // desfaz a divergência local para isolar "só o livro mudou"
    await req(BASE, "PATCH", `/campaigns/${CID}/regras/elementos/${elId("atributo", "ui_forca")}`, {
      cookie: CM, body: { definition: { descricao: "forca v1" } },
    });
    await linhaLivro(p).getByRole("button", { name: /Pré-visualizar/ }).click();
    await previa(p).waitFor({ timeout: 10000 });
    const txtSL = await previa(p).innerText();
    t("prévia mostra atualização só no livro", txtSL.includes("só no livro") || txtSL.includes("Atualizações do livro"), txtSL.slice(0, 240));
    await previa(p).getByRole("button", { name: "Confirmar sincronização" }).click();
    await p.getByText("Sincronização concluída").first().waitFor({ timeout: 10000 });
    const elSL = await defAtual("atributo", "ui_forca");
    t("valor v2 do livro aplicado automaticamente", elSL?.definition?.descricao === "forca v2 livro", JSON.stringify(elSL?.definition));

    sec("Desktop — remoção de vínculo");
    await linhaLivro(p).getByRole("button", { name: "Remover vínculo" }).click();
    await p.locator(".modal").getByRole("button", { name: "Remover vínculo" }).click();
    await p.getByText(/Vínculo com "Livro Sync UI" removido/).first().waitFor({ timeout: 10000 });
    t("vínculo removido via UI", true);
    await p.waitForTimeout(600);
    t("tag Aplicado desapareceu", !(await linhaLivro(p).innerText()).includes("Aplicado v"));
    const elPreservado = await defAtual("atributo", "ui_forca");
    t("regras da campanha preservadas após remover vínculo", !!elPreservado, "");

    t("desktop: sem erros de página", erros.length === 0, erros.join(" | ").slice(0, 200));
    await ctx.close();
  }

  // ---------- MOBILE 390px — mestre ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const { p, erros } = await abrirRegrasAcervo(ctx);
    sec("Mobile — prévia de sincronização responsiva");
    // revincula o livro para exercitar a prévia no mobile
    await req(BASE, "POST", `/campaigns/${CID}/regras/acervo/${BOOK}/aplicar`, {
      cookie: CM,
      body: { estadoToken: (await req(BASE, "GET", `/campaigns/${CID}/regras/acervo/${BOOK}/diff`, { cookie: CM })).json?.estadoToken },
    });
    await linhaLivro(p).getByRole("button", { name: /Pré-visualizar/ }).click();
    await previa(p).waitFor({ timeout: 10000 });
    const txtMobile = await previa(p).innerText();
    t("mobile: prévia renderiza com totais", txtMobile.includes("item(ns) no livro"), txtMobile.slice(0, 160));
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    t("mobile: sem overflow horizontal na prévia", !overflow);
    t("mobile: sem erros de página", erros.length === 0, erros.join(" | ").slice(0, 200));
    await ctx.close();
  }

  console.log(`\n==== homologação acervo-sync: ${pass} ok, ${fail} falhas ====`);
} finally {
  await browser.close();
  await encerrarServidor(proc);
  limparDir(DIR);
}
process.exit(fail ? 1 : 0);
