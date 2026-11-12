// Homologação E2E — temporizador configurável da Mesa (PR #54).
// Servidor isolado + Playwright. Desktop: mestre configura duração e controla
// (iniciar/pausar/retomar/reiniciar/encerrar); jogador vê o tempo mas não tem
// controles. Mobile 390px sem overflow. Sincronização conferida entre dois
// clientes simultâneos. Sem erros de página.
import { chromium } from "playwright";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepararBanco, portaLivre, subirServidor, esperarSaudavel, criarCenario, req, encerrarServidor, limparDir } from "./teste-base.mjs";

const DIR = mkdtempSync(join(tmpdir(), "mrpg-hom-timer-"));
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

const browser = await chromium.launch();
const erros = [];
try {
  const c = await criarCenario(BASE, BANCO, {
    campanha: "Campanha Timer E2E",
    jogadores: { jogador1: "timer_j1" },
  });
  const CID = c.campId, M = c.cookieMestre, J1 = c.jogadores.jogador1.cookie;

  // sessão de mesa via API (fluxo real)
  const sess = await req(BASE, "POST", `/campaigns/${CID}/sessoes`, { cookie: M, body: { name: "Mesa Timer E2E" } });
  const sid = sess.json?.sessao?.id ?? sess.json?.id;
  t("sessão de mesa criada", !!sid, JSON.stringify(sess.json).slice(0, 160));

  async function abrirMesa(p) {
    await p.goto(BASE, { waitUntil: "networkidle" });
    await p.getByRole("button", { name: "Campanhas" }).click();
    await p.waitForTimeout(700);
    await p.locator(".cartao-campanha", { hasText: "Campanha Timer E2E" }).first().click();
    await p.waitForTimeout(1000);
    await p.getByRole("button", { name: /^Mesa/ }).click();
    await p.waitForTimeout(800);
    await p.locator("tr.clicavel", { hasText: "Mesa Timer E2E" }).first().click();
    await p.waitForSelector(".timer-display", { timeout: 10000 });
    await p.waitForTimeout(500);
  }
  const textoTimer = (p) => p.locator(".timer-display").innerText();
  const secaoTimer = (p) => p.locator("section.cartao").filter({ has: p.locator("h3", { hasText: "Temporizador" }) });
  const segTimer = async (p) => {
    const txt = await textoTimer(p);
    const m = txt.match(/(\d+):(\d{2})/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const semOverflow = (p) => p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

  // ---------- DESKTOP — mestre + jogador simultâneos ----------
  {
    const ctxM = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctxM.addCookies([{ name: "mestre_rpg_session", value: M.split("=")[1], url: BASE }]);
    const pM = await ctxM.newPage();
    pM.on("pageerror", (e) => erros.push("mestre: " + String(e)));

    const ctxJ = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctxJ.addCookies([{ name: "mestre_rpg_session", value: J1.split("=")[1], url: BASE }]);
    const pJ = await ctxJ.newPage();
    pJ.on("pageerror", (e) => erros.push("jogador: " + String(e)));

    sec("Desktop — mestre configura e inicia");
    await abrirMesa(pM);
    await abrirMesa(pJ);

    const st = secaoTimer(pM);
    const inputDur = st.getByLabel("Duração do temporizador em minutos");
    t("mestre vê campo de duração", await inputDur.count() === 1);
    await inputDur.fill("2");
    const btnIniciar = st.getByRole("button", { name: /Iniciar \(2 min\)/ });
    t("botão reflete duração escolhida", await btnIniciar.count() === 1);
    await btnIniciar.click();
    await pM.waitForSelector(".timer-display.rodando", { timeout: 8000 });
    const sM1 = await segTimer(pM);
    t("contador inicia em ~2min", sM1 !== null && sM1 >= 115 && sM1 <= 120, `lido=${sM1}`);

    sec("Sincronização mestre × jogador");
    await pJ.waitForSelector(".timer-display.rodando", { timeout: 8000 });
    const sJ1 = await segTimer(pJ);
    t("jogador vê o mesmo tempo restante", sJ1 !== null && Math.abs(sJ1 - sM1) <= 2, `mestre=${sM1} jogador=${sJ1}`);
    // contador decresce na tela do jogador (tick do servidor a cada 1s)
    const sJAntes = sJ1;
    await pJ.waitForTimeout(2500);
    const sJDepois = await segTimer(pJ);
    t("contador do jogador decresce", sJDepois !== null && sJDepois < sJAntes, `${sJAntes} → ${sJDepois}`);

    sec("Jogador não tem controles");
    t("jogador não vê campo de duração", await secaoTimer(pJ).getByLabel("Duração do temporizador em minutos").count() === 0);
    for (const nome of [/Pausar/, /Retomar/, /Reiniciar com duração/, /Encerrar/]) {
      t(`jogador não vê botão ${nome}`, await secaoTimer(pJ).getByRole("button", { name: nome }).count() === 0);
    }

    sec("Pausar / retomar / reiniciar / encerrar");
    await st.getByRole("button", { name: "Pausar" }).click();
    await pM.waitForSelector(".timer-display", { timeout: 5000 });
    await pM.waitForTimeout(300);
    const txtPausa = await textoTimer(pM);
    t("estado pausado visível", /pausado/i.test(txtPausa), txtPausa);
    await pJ.waitForTimeout(1200);
    t("jogador vê pausa sincronizada", /pausado/i.test(await textoTimer(pJ)), await textoTimer(pJ));
    const sPausa = await segTimer(pM);
    await pJ.waitForTimeout(2000);
    t("tempo parado durante a pausa", (await segTimer(pM)) === sPausa, `${sPausa} → ${await segTimer(pM)}`);

    await st.getByRole("button", { name: "Retomar" }).click();
    await pM.waitForSelector(".timer-display.rodando", { timeout: 8000 });
    t("retomada volta a rodar", !/pausado/i.test(await textoTimer(pM)), await textoTimer(pM));

    await inputDur.fill("3");
    await st.getByRole("button", { name: /Reiniciar com duração escolhida/ }).click();
    await pM.waitForTimeout(800);
    const sRe = await segTimer(pM);
    t("reiniciar usa duração escolhida (3min)", sRe !== null && sRe >= 175 && sRe <= 180, `lido=${sRe}`);

    await st.getByRole("button", { name: "Encerrar", exact: true }).click();
    await pM.waitForTimeout(800);
    t("encerrar → 'Tempo encerrado'", /Tempo encerrado/.test(await textoTimer(pM)), await textoTimer(pM));
    await pJ.waitForTimeout(800);
    t("jogador vê encerramento sincronizado", /Tempo encerrado/.test(await textoTimer(pJ)), await textoTimer(pJ));

    // reinício após encerramento
    await st.getByRole("button", { name: /Iniciar \(3 min\)/ }).click();
    await pM.waitForSelector(".timer-display.rodando", { timeout: 8000 });
    const sRe2 = await segTimer(pM);
    t("reinício após encerramento funciona", sRe2 !== null && sRe2 >= 175 && sRe2 <= 180, `lido=${sRe2}`);
    await st.getByRole("button", { name: "Encerrar", exact: true }).click();

    t("desktop sem overflow horizontal", await semOverflow(pM) && await semOverflow(pJ));
    await ctxM.close(); await ctxJ.close();
  }

  // ---------- MOBILE 390px — jogador ----------
  {
    sec("Mobile 390px — jogador");
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await ctx.addCookies([{ name: "mestre_rpg_session", value: J1.split("=")[1], url: BASE }]);
    const p = await ctx.newPage();
    p.on("pageerror", (e) => erros.push("mobile: " + String(e)));
    await abrirMesa(p);
    t("mobile vê o temporizador", /\d+:\d{2}|—|Tempo encerrado/.test(await textoTimer(p)), await textoTimer(p));
    t("mobile: jogador sem controles do timer",
      await secaoTimer(p).getByLabel("Duração do temporizador em minutos").count() === 0 &&
      await secaoTimer(p).getByRole("button", { name: /Pausar|Retomar|Reiniciar com duração/ }).count() === 0);
    t("mobile sem overflow horizontal", await semOverflow(p));
    await ctx.close();
  }

  t("sem erros de página (console/pageerror)", erros.length === 0, erros.slice(0, 3).join(" | "));
} finally {
  await browser.close();
  await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
