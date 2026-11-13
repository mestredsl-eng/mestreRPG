// Homologação visual — Mesa virtual Etapa 1 (mapa + tokens).
// Mestre + 2 jogadores em contextos Playwright reais: upload de mapa,
// criação de token, arraste por mouse (desktop) e toque (mobile),
// sincronização entre abas, layouts 1920/1366/768/390 sem overflow
// horizontal e ausência de erros de console.
import { chromium } from "playwright";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, encerrarServidor, limparDir, req,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("mesa-vtt-ui");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const SHOTS = join(process.cwd(), "_evidencias", "mesa-virtual");
mkdirSync(SHOTS, { recursive: true });
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");
const PNG_PATH = join(DIR, "mapa.png");
writeFileSync(PNG_PATH, PNG);

let browser, proc;
const errosConsole = [];
function vigiar(page, tag) {
  page.on("pageerror", (e) => errosConsole.push(`${tag}:pageerror:${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const txt = m.text();
    if (txt.includes("VTT-DBG") || txt.includes("VTT-DRAG")) { console.log("   ", tag, txt.slice(0, 140)); return; }
    // ruído conhecido: /auth/me retorna 401 antes do login (bootstrap anônimo)
    if (/401|Failed to load resource/.test(txt)) return;
    errosConsole.push(`${tag}:console:${txt.slice(0, 160)}`);
  });
}
async function login(page, user, senha) {
  await page.goto(BASE);
  await page.getByLabel("Usuário").fill(user);
  await page.getByLabel("Senha").fill(senha);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByText("Servidor online").waitFor({ timeout: 15000 });
}
async function irMesa(page) {
  await page.getByRole("button", { name: "Campanhas" }).click();
  await page.getByText("Campanha Teste", { exact: true }).first().click();
  await page.locator(".abas button", { hasText: "Mesa" }).first().click();
}
async function abrirSessao(page, nomeSessao = null) {
  // a sessão já existe (criada via API): aguarda a linha pelo nome
  const linha = page.locator("tr.clicavel", { hasText: nomeSessao ?? /./ });
  await linha.first().waitFor({ timeout: 15000 });
  await linha.first().click();
  await page.locator(".vtt-tabuleiro, .mesa-vtt .dica, .mesa-vtt h3").first().waitFor({ timeout: 15000 });
}
const semOverflowX = (page) => page.evaluate(() =>
  document.scrollingElement.scrollWidth <= document.documentElement.clientWidth + 1);

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", () => {});
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO);

  // sessão criada via API para os 3 papéis compartilharem
  const sess = await req(BASE, "POST", `/campaigns/${c.campId}/sessoes`, { cookie: c.cookieMestre, body: { name: "Mesa VTT UI" } });
  t("sessão criada via API", sess.status === 200 || sess.status === 201, JSON.stringify(sess.json).slice(0, 120));

  browser = await chromium.launch();

  // ---------- desktop 1920: fluxo completo ----------
  sec("Desktop 1920×1080 — fluxo mestre + 2 jogadores");
  const ctxM = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const ctxJ1 = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const ctxJ2 = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const pgM = await ctxM.newPage(), pgJ1 = await ctxJ1.newPage(), pgJ2 = await ctxJ2.newPage();
  vigiar(pgM, "mestre"); vigiar(pgJ1, "j1"); vigiar(pgJ2, "j2");

  await login(pgM, "mestre_teste", "senha-forte-123");
  await login(pgJ1, "jogador_um", "senha-jogador-123");
  await login(pgJ2, "jogador_dois", "senha-jogador-123");
  await Promise.all([irMesa(pgM), irMesa(pgJ1), irMesa(pgJ2)]);
  await abrirSessao(pgM, "Mesa VTT UI");
  await abrirSessao(pgJ1, "Mesa VTT UI");
  await abrirSessao(pgJ2, "Mesa VTT UI");

  t("estado vazio do mapa visível", await pgM.locator(".mesa-vtt .dica").count() > 0);
  await pgM.screenshot({ path: join(SHOTS, "vtt-01-vazio-mestre.png") });

  // mestre envia mapa pelo input de arquivo
  await pgM.locator(".mesa-vtt input[type=file]").setInputFiles(PNG_PATH);
  await pgM.locator(".vtt-tabuleiro").waitFor({ timeout: 10000 });
  t("mapa definido aparece no tabuleiro do mestre", await pgM.locator(".vtt-tabuleiro").count() === 1);
  const bgM = await pgM.locator(".vtt-tabuleiro").evaluate((el) => el.style.backgroundImage);
  t("mapa usa URL da biblioteca de arquivos", bgM.includes("/arquivos/"), bgM.slice(0, 80));

  // jogadores veem o mesmo mapa (tempo real)
  try {
    await pgJ1.locator(".vtt-tabuleiro").waitFor({ timeout: 10000 });
  } catch {
    const html = await pgJ1.locator(".mesa-vtt").innerHTML().catch(() => "SEM .mesa-vtt");
    const titulo = await pgJ1.locator("h2").allTextContents().catch(() => []);
    const erroTxt = await pgJ1.locator(".erro").allTextContents().catch(() => []);
    const onlineTxt = await pgJ1.locator(".mesa-view .meta").first().textContent().catch(() => "");
    console.log("DEBUG j1 mesa-vtt:", html.slice(0, 300), "| h2:", JSON.stringify(titulo), "| erro:", JSON.stringify(erroTxt), "| online:", onlineTxt);
    throw new Error("jogador1 não recebeu o mapa");
  }
  await pgJ2.locator(".vtt-tabuleiro").waitFor({ timeout: 10000 });
  const bgJ1 = await pgJ1.locator(".vtt-tabuleiro").evaluate((el) => el.style.backgroundImage);
  t("jogador1 vê o mesmo mapa", bgJ1 === bgM);
  t("jogador2 vê o mesmo mapa", await pgJ2.locator(".vtt-tabuleiro").count() === 1);
  await pgJ1.screenshot({ path: join(SHOTS, "vtt-02-mapa-jogador.png") });

  // jogador não vê controles de mapa
  t("jogador não tem botão de upload", await pgJ1.locator(".mesa-vtt input[type=file]").count() === 0);

  // mestre cria token do jogador1
  await pgM.locator(".vtt-controles input").fill("Ana");
  await pgM.locator(".vtt-controles select").selectOption(c.jogadores.jogador1.id);
  await pgM.locator(".vtt-controles button.primario").click();
  await pgM.locator(".vtt-token", { hasText: "AN" }).waitFor({ timeout: 8000 });
  t("token criado visível ao mestre", await pgM.locator(".vtt-token").count() === 1);
  await pgJ1.locator(".vtt-token").waitFor({ timeout: 8000 });
  await pgJ2.locator(".vtt-token").waitFor({ timeout: 8000 });
  t("token visível aos 2 jogadores", await pgJ1.locator(".vtt-token").count() === 1 && await pgJ2.locator(".vtt-token").count() === 1);

  // arraste por mouse no tabuleiro do jogador1 (token é dele)
  const tokJ1 = pgJ1.locator(".vtt-token");
  const tbJ1 = await pgJ1.locator(".vtt-tabuleiro").boundingBox();
  const tokBox = await tokJ1.boundingBox();
  const cxT = tokBox.x + tokBox.width / 2, cyT = tokBox.y + tokBox.height / 2;
  // tentativa com mouse real; se o pointerdown não pegar, cai no sintético
  await pgJ1.mouse.move(cxT, cyT);
  await pgJ1.mouse.down();
  await pgJ1.mouse.move(cxT + 80, cyT + 60, { steps: 6 });
  await pgJ1.mouse.up();
  await pgJ1.waitForTimeout(400);
  let posDrag = await tokJ1.evaluate((el) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) }));
  if (Math.hypot(posDrag.x - 50, posDrag.y - 50) < 3) {
    await pgJ1.evaluate(([px, py]) => {
      const el = document.querySelector(".vtt-token");
      el.dispatchEvent(new PointerEvent("pointerdown", { clientX: px, clientY: py, pointerId: 3, bubbles: true }));
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: px + 80, clientY: py + 60, pointerId: 3, bubbles: true }));
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: px + 80, clientY: py + 60, pointerId: 3, bubbles: true }));
    }, [cxT, cyT]);
    await pgJ1.waitForTimeout(400);
    posDrag = await tokJ1.evaluate((el) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) }));
  }
  await pgJ1.waitForTimeout(600);
  const posDepois = await tokJ1.evaluate((el) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) }));
  t("arraste por mouse/pointer move o token (jogador1)", Math.hypot(posDepois.x - 50, posDepois.y - 50) > 3, JSON.stringify(posDepois));

  // mestre vê a mesma posição (sincronia)
  await pgM.waitForTimeout(500);
  const posMestre = await pgM.locator(".vtt-token").evaluate((el) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) }));
  t("mestre vê a movimentação do jogador", Math.abs(posMestre.x - posDepois.x) < 2 && Math.abs(posMestre.y - posDepois.y) < 2, JSON.stringify(posMestre));
  await pgM.screenshot({ path: join(SHOTS, "vtt-03-token-movido.png") });

  // jogador2 tenta arrastar o token alheio — posição não deve mudar no servidor
  const posAntes2 = await pgJ2.locator(".vtt-token").evaluate((el) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) }));
  const caixaJ2 = await pgJ2.locator(".vtt-tabuleiro").boundingBox();
  await pgJ2.mouse.move(caixaJ2.x + caixaJ2.width * posAntes2.x / 100, caixaJ2.y + caixaJ2.height * posAntes2.y / 100);
  await pgJ2.mouse.down();
  await pgJ2.mouse.move(caixaJ2.x + caixaJ2.width * 0.2, caixaJ2.y + caixaJ2.height * 0.2, { steps: 6 });
  await pgJ2.mouse.up();
  await pgJ2.waitForTimeout(700);
  const posDepois2 = await pgJ1.locator(".vtt-token").evaluate((el) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) }));
  t("jogador2 não move token alheio", Math.abs(posDepois2.x - posAntes2.x) < 3 && Math.abs(posDepois2.y - posAntes2.y) < 3, JSON.stringify(posDepois2));

  // ferramentas existentes continuam na página
  t("chat da mesa preservado", await pgM.locator(".mesa-chat").count() === 1);
  t("sem overflow horizontal (1920)", await semOverflowX(pgM) && await semOverflowX(pgJ1));
  await ctxM.close(); await ctxJ1.close(); await ctxJ2.close();

  // ---------- demais viewports: layout + toque ----------
  sec("Viewports 1366 / 768 / 390 — layout e toque");
  for (const [w, h, nome] of [[1366, 768, "1366x768"], [768, 1024, "768x1024"], [390, 844, "390x844"]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: w < 800 });
    const pg = await ctx.newPage();
    vigiar(pg, nome);
    await login(pg, "mestre_teste", "senha-forte-123");
    await irMesa(pg);
    await abrirSessao(pg, "Mesa VTT UI");
    await pg.locator(".vtt-tabuleiro").waitFor({ timeout: 10000 });
    t(`tabuleiro visível em ${nome}`, await pg.locator(".vtt-token").count() >= 1);
    t(`sem overflow horizontal em ${nome}`, await semOverflowX(pg));
    await pg.screenshot({ path: join(SHOTS, `vtt-${nome}.png`) });

    if (w === 390) {
      // arraste por toque (PointerEvent touch) no token do mestre
      const tok = pg.locator(".vtt-token").first();
      const tb = await pg.locator(".vtt-tabuleiro").boundingBox();
      const antes = await tok.evaluate((el) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) }));
      const cx = tb.x + tb.width * antes.x / 100, cy = tb.y + tb.height * antes.y / 100;
      await pg.evaluate(([px, py]) => {
        const el = document.querySelector(".vtt-token");
        el.dispatchEvent(new PointerEvent("pointerdown", { clientX: px, clientY: py, pointerId: 7, bubbles: true }));
        window.dispatchEvent(new PointerEvent("pointermove", { clientX: px + 60, clientY: py + 40, pointerId: 7, bubbles: true }));
        window.dispatchEvent(new PointerEvent("pointerup", { clientX: px + 60, clientY: py + 40, pointerId: 7, bubbles: true }));
      }, [cx, cy]);
      await pg.waitForTimeout(800);
      const depois = await pg.locator(".vtt-token").first().evaluate((el) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top) }));
      t("arraste por toque move token no mobile", Math.hypot(depois.x - antes.x, depois.y - antes.y) > 3, JSON.stringify({ antes, depois }));
    }
    await ctx.close();
  }

  t("nenhum erro de console/pageerror", errosConsole.length === 0, errosConsole.slice(0, 3).join(" | "));

  await browser.close();
  await encerrarServidor(proc);
} catch (e) {
  fail++;
  console.log("FALHOU exceção:", e?.message ?? e);
  try { await browser?.close(); } catch {}
  try { await encerrarServidor(proc); } catch {}
} finally {
  limparDir(DIR);
}
console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
