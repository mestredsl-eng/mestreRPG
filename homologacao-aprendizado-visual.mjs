// Homologação E2E — aprendizado de preferências visuais (Issue #132).
// Servidor isolado (banco temporário) + frontend buildado. Cobre: opt-in
// real, histórico só em apply, sugestão determinística explicada,
// pré-visualizar sem PATCH, aplicar como única confirmação, apagar
// histórico, desligar coleta e isolamento — desktop e mobile.
import { chromium } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepararBanco, portaLivre, subirServidor, esperarSaudavel, criarCenario, req, comDb, abrirDb, encerrarServidor, limparDir } from "./teste-base.mjs";

const DIR = mkdtempSync(join(tmpdir(), "mrpg-hom-aprend-"));
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
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

const OCULTISMO = {
  intensidade: "imersiva", corDestaque: "violeta", superficies: "elevado",
  textura: "intensa", animacoes: "completo", densidade: "ampla",
};
const ARQUIVO = {
  intensidade: "discreta", corDestaque: "vinho", superficies: "flat",
  textura: "nenhuma", animacoes: "reduzido", densidade: "compacta",
};

const prefsDe = (userId) => {
  const db = abrirDb(BANCO);
  const u = db.prepare("select preferences from users where id=?").get(userId);
  db.close();
  return u ? JSON.parse(u.preferences || "{}") : {};
};
const historicoDe = (userId) => prefsDe(userId)?.visualAprendizado?.historico ?? [];
const optInDe = (userId) => prefsDe(userId)?.visualAprendizado?.optIn === true;

const browser = await chromium.launch();
const tokenDe = (cookie) => decodeURIComponent(cookie.split("=")[1]);
const ctxComCookie = async (cookie, opcoes = {}) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, ...opcoes });
  await ctx.addCookies([{ name: "mestre_rpg_session", value: tokenDe(cookie), url: BASE }]);
  return ctx;
};

try {
  const C = await criarCenario(BASE, BANCO, { jogadores: { jogador1: "apr_ui_j1" } });
  const j1 = C.jogadores.jogador1;
  const ctx = await ctxComCookie(j1.cookie);
  const p = await ctx.newPage();
  const erros = [];
  p.on("pageerror", (e) => erros.push(String(e)));

  const patches = [];
  p.on("request", (r) => {
    if (r.method() === "PATCH" && r.url().includes("/api/auth/preferences")) {
      try { patches.push(JSON.parse(r.postData() ?? "{}")); } catch { patches.push({}); }
    }
  });

  await p.goto(BASE, { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Conta", exact: true }).click();
  await p.locator(".prefs-visuais").waitFor({ timeout: 10000 });

  sec("Estrutura — seção de aprendizado");
  t("opt-in desligado por padrão", await p.locator(".prefs-aprendizado").count() === 1
    && await p.getByRole("button", { name: "Ativar aprendizado" }).count() === 1);
  t("sem sugestão sem opt-in", await p.locator(".prefs-sugestao").count() === 0);
  t("botão opt-in expõe estado", await p.getByRole("button", { name: "Ativar aprendizado" }).getAttribute("aria-pressed") === "false");

  sec("Opt-in — ativar persiste no servidor");
  await p.getByRole("button", { name: "Ativar aprendizado" }).click();
  await p.waitForTimeout(400);
  t("PATCH visualAprendizado enviado", patches.some((b) => b.visualAprendizado?.optIn === true), JSON.stringify(patches));
  t("optIn=true persistido", optInDe(j1.id) === true);
  t("botão reflete ativado", await p.getByRole("button", { name: "Aprendizado ativado" }).count() === 1);

  const aplicarPreset = async (nome) => {
    await p.locator(".prefs-atmosfera", { hasText: nome }).click();
    await p.getByRole("button", { name: "Aplicar aparência" }).click();
    await p.waitForTimeout(400);
  };

  sec("Coleta — histórico só cresce em apply");
  await aplicarPreset("Ocultismo");
  t("apply 1 → histórico [Ocultismo]", historicoDe(j1.id).length === 1, JSON.stringify(historicoDe(j1.id)));
  await aplicarPreset("Arquivo Oculto");
  await aplicarPreset("Ocultismo");
  await aplicarPreset("Arquivo Oculto");
  t("4 applies → histórico com 4 entradas", historicoDe(j1.id).length === 4, JSON.stringify(historicoDe(j1.id).length));
  t("visual salvo = Arquivo Oculto", prefsDe(j1.id)?.visual?.corDestaque === "vinho"
    && prefsDe(j1.id)?.visual?.densidade === "compacta", JSON.stringify(prefsDe(j1.id)?.visual));

  sec("Sugestão — determinística e explicada");
  const sug = p.locator(".prefs-sugestao");
  await sug.waitFor({ timeout: 5000 }).catch(() => null);
  t("sugestão visível", await sug.count() === 1);
  t("motivo explica repetição", /2 vezes/.test(await sug.textContent() ?? ""), (await sug.textContent() ?? "").slice(0, 160));
  t("sugestão nomeia Ocultismo", /Ocultismo/.test(await sug.textContent() ?? ""));
  t("Pré-visualizar e Aplicar sugestão presentes",
    await sug.getByRole("button", { name: "Pré-visualizar" }).count() === 1
    && await sug.getByRole("button", { name: "Aplicar sugestão" }).count() === 1);

  sec("Pré-visualizar — não persiste nem envia PATCH");
  const patchesAntes = patches.length;
  const corAntes = await p.evaluate(() => document.documentElement.dataset.corDestaque);
  await sug.getByRole("button", { name: "Pré-visualizar" }).click();
  await p.waitForTimeout(400);
  t("zero PATCH após pré-visualizar", patches.length === patchesAntes, `antes=${patchesAntes} depois=${patches.length}`);
  t("tema global inalterado", await p.evaluate(() => document.documentElement.dataset.corDestaque) === corAntes);
  t("rascunho virou Ocultismo (prévia violeta)", await p.locator(".pv-visual").getAttribute("data-cor-destaque") === "violeta");
  t("histórico não cresceu", historicoDe(j1.id).length === 4);

  sec("Aplicar sugestão — única confirmação");
  await sug.getByRole("button", { name: "Aplicar sugestão" }).click();
  await p.waitForTimeout(500);
  t("PATCH visual enviado", patches.some((b) => b.visual && b.visual.corDestaque === "violeta"), JSON.stringify(patches.slice(-2)));
  t("tema global aplicado (violeta)", await p.evaluate(() => document.documentElement.dataset.corDestaque) === "violeta");
  t("histórico cresceu para 5", historicoDe(j1.id).length === 5, JSON.stringify(historicoDe(j1.id).length));

  sec("Apagar histórico — sugestão some");
  await p.getByRole("button", { name: "Apagar histórico" }).click();
  await p.waitForTimeout(400);
  t("PATCH historico:[] enviado", patches.some((b) => Array.isArray(b.visualAprendizado?.historico) && b.visualAprendizado.historico.length === 0));
  t("histórico zerado no banco", historicoDe(j1.id).length === 0);
  t("sugestão desapareceu", await p.locator(".prefs-sugestao").count() === 0);

  sec("Desligar — coleta interrompida");
  // repõe histórico (salvo atual = Ocultismo; alterna para gerar applies)
  await aplicarPreset("Arquivo Oculto");
  await aplicarPreset("Ocultismo");
  await aplicarPreset("Arquivo Oculto");
  const antes = historicoDe(j1.id).length;
  await p.getByRole("button", { name: "Aprendizado ativado" }).click();
  await p.waitForTimeout(400);
  await aplicarPreset("Ocultismo"); // salvo atual = Arquivo Oculto → apply válido
  t("opt-in off → apply não coletou", historicoDe(j1.id).length === antes, `antes=${antes} depois=${historicoDe(j1.id).length}`);
  t("optIn=false persistido", optInDe(j1.id) === false);
  t("sugestão oculta com opt-in off", await p.locator(".prefs-sugestao").count() === 0);

  sec("Mobile — área acessível em viewport estreito");
  const ctxM = await ctxComCookie(j1.cookie, { viewport: { width: 390, height: 844 } });
  const pm = await ctxM.newPage();
  await pm.goto(BASE, { waitUntil: "networkidle" });
  await pm.getByRole("button", { name: "Conta", exact: true }).click();
  await pm.locator(".prefs-visuais").waitFor({ timeout: 10000 });
  t("seção aprendizado visível no mobile", await pm.locator(".prefs-aprendizado").count() === 1);
  t("controles nomeados acessíveis", await pm.getByRole("button", { name: /aprendizado/i }).count() >= 1);
  await ctxM.close();

  t("sem erros de página", erros.length === 0, erros.join("|"));
  await ctx.close();
} catch (e) {
  fail++;
  console.log("FALHOU exceção não tratada:", e?.stack ?? e);
} finally {
  let teardownFalhou = false;
  try { await browser.close(); } catch (e) { teardownFalhou = true; console.error("[teardown] browser:", e?.message ?? e); }
  try { if (proc) await encerrarServidor(proc); } catch (e) { teardownFalhou = true; console.error("[teardown] servidor:", e?.message ?? e); }
  try { if (!limparDir(DIR)) teardownFalhou = true; } catch (e) { teardownFalhou = true; console.error("[teardown] limpeza:", e?.message ?? e); }
  if (teardownFalhou) fail++;
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
