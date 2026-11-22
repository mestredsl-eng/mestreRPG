// Homologação E2E — leitor de NPC revelado NÃO monta Patrimônio.
// Prova no navegador real que:
//  - a ficha pública do NPC aparece para o jogador;
//  - o painel Patrimônio não é montado e NENHUMA consulta de
//    inventário/equipamentos/veículos/financeiro é disparada;
//  - nenhum 403 aparece na tela e não há botão "Editar ficha";
//  - o mestre continua vendo o Patrimônio normalmente (consultas ok).
import { chromium } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepararBanco, portaLivre, subirServidor, esperarSaudavel, criarCenario, comDb, req, encerrarServidor } from "./teste-base.mjs";

const DIR = mkdtempSync(join(tmpdir(), "mrpg-hom-npcpat-"));
const BANCO = join(DIR, "mestre-rpg.db");
await prepararBanco(BANCO);
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const proc = subirServidor(PORTA, { banco: BANCO, arquivos: join(DIR, "arq"), backups: join(DIR, "bks") });
proc.stderr.on("data", (d) => process.stderr.write(d));
await esperarSaudavel(BASE, proc);

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };

const browser = await chromium.launch();
try {
  const c = await criarCenario(BASE, BANCO, {
    campanha: "Campanha NPC Patrimônio",
    jogadores: { jogador1: "jogador_um" },
  });
  const CID = c.campId, M = c.cookieMestre, J = c.jogadores.jogador1.cookie;
  const NOME = "Campanha NPC Patrimônio";

  const verId = comDb(BANCO, (db) => db.prepare("select id from sheet_versions limit 1").get()?.id);
  const npc = await req(BASE, "POST", `/campaigns/${CID}/characters`, {
    cookie: M, body: { name: "Bruto do Patrimônio", templateVersionId: verId, isNpc: true },
  });
  const IDNPC = npc.json?.personagem?.id;
  t("NPC criado", npc.status === 201 && !!IDNPC, JSON.stringify(npc.json).slice(0, 160));
  const rev = await req(BASE, "POST", `/characters/${IDNPC}/npc-visibilidade`, { cookie: M, body: { visivel: true } });
  t("ficha do NPC revelada", rev.status === 200);

  const RE_PROTEGIDA = /\/characters\/[^/]+\/(inventario|equipamentos|veiculos|financeiro)/;

  const RE_SANGUE = /\/characters\/[^/]+\/sangue/;

  async function abrirFichaNpc(ctx) {
    const protegidas = [];
    const erros403 = [];
    const sangueReqs = [];
    const p = await ctx.newPage();
    p.on("request", (r) => {
      if (RE_PROTEGIDA.test(r.url())) protegidas.push(r.url());
      if (RE_SANGUE.test(r.url())) sangueReqs.push(r.url());
    });
    p.on("response", (r) => { if (r.status() === 403) erros403.push(r.url()); });
    await p.goto(BASE, { waitUntil: "networkidle" });
    await p.getByRole("button", { name: "Campanhas" }).click();
    await p.waitForTimeout(700);
    await p.locator(".cartao-campanha", { hasText: NOME }).first().click();
    await p.waitForTimeout(1000);
    await p.getByRole("button", { name: /Personagens/ }).click();
    await p.waitForTimeout(800);
    await p.locator("tr", { hasText: "Bruto do Patrimônio" }).first().click();
    await p.waitForTimeout(1500);
    return { p, protegidas, erros403, sangueReqs };
  }

  const painelPatrimonio = (p) => p.locator("section.cartao").filter({ has: p.locator("h3", { hasText: "Patrimônio" }) });

  // ---------- JOGADOR: ficha pública SEM Patrimônio ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addCookies([{ name: "mestre_rpg_session", value: J.split("=")[1], url: BASE }]);
    const { p, protegidas, erros403, sangueReqs } = await abrirFichaNpc(ctx);

    t("jogador vê a ficha pública do NPC", await p.locator("h2", { hasText: "Bruto do Patrimônio" }).count() > 0);
    t("jogador vê badge de NPC", (await p.locator(".badge-npc").count()) > 0);
    t("jogador NÃO vê painel Patrimônio", (await painelPatrimonio(p).count()) === 0);
    t("jogador NÃO dispara consultas de Patrimônio", protegidas.length === 0, protegidas.join(" | "));
    // F25B/#232: jogador lendo NPC público não pode emitir GET /sangue
    // (o servidor negaria com 403) — zero requests, zero 403 de sangue.
    t("jogador NÃO dispara GET /sangue", sangueReqs.length === 0, sangueReqs.join(" | "));
    t("jogador NÃO vê painel Pontos de Sangue", (await p.locator(".painel-sangue-leitura").count()) === 0);
    t("jogador NÃO recebe nenhum 403", erros403.length === 0, erros403.join(" | "));
    t("jogador NÃO vê botão Editar ficha no NPC", (await p.getByRole("button", { name: "Editar ficha" }).count()) === 0);
    t("jogador NÃO vê toggle de visibilidade", (await p.getByRole("button", { name: /Exibir ficha|Ocultar ficha/ }).count()) === 0);
    await ctx.close();
  }

  // ---------- MESTRE: Patrimônio normal ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addCookies([{ name: "mestre_rpg_session", value: M.split("=")[1], url: BASE }]);
    const { p, protegidas, erros403, sangueReqs } = await abrirFichaNpc(ctx);

    t("mestre vê a ficha do NPC", await p.locator("h2", { hasText: "Bruto do Patrimônio" }).count() > 0);
    t("mestre vê painel Patrimônio", (await painelPatrimonio(p).count()) === 1);
    t("mestre dispara consultas de Patrimônio", protegidas.length > 0, "esperava >0, veio " + protegidas.length);
    t("mestre dispara GET /sangue", sangueReqs.length > 0, "esperava >0, veio " + sangueReqs.length);
    t("mestre vê painel Pontos de Sangue", (await p.locator(".painel-sangue-leitura").count()) === 1);
    t("mestre sem 403 nas rotas de Patrimônio", erros403.length === 0, erros403.join(" | "));
    await ctx.close();
  }
} finally {
  await browser.close();
  await encerrarServidor(proc);
  rmSync(DIR, { recursive: true, force: true });
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
