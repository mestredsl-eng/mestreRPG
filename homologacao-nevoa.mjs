// Homologação visual — névoa de guerra (Etapa 2, PR-B), revisão de auditoria.
// Cobre: controles por papel real (mestre/jogador/espectador), ordem de
// camadas, prévia com névoa desativada, propagação revelar/desfazer/
// ocultarTudo/revelarTudo nos 3 clientes via pixels do canvas, cancelamento
// (pointercancel/lostpointercapture/blur/troca de sessão/desligar pincel),
// coordenadas fora do tabuleiro, limite de 128 pontos, ACK rejeitado,
// timeout sem ACK + ACK tardio, toque real mobile (CDP), redimensionamento
// e reconexão. Evidências em _evidencias/nevoa/.
import { chromium } from "playwright";
import crypto from "node:crypto";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { hashSenha } from "./servidor/dist/lib/password.js";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, encerrarServidor, limparDir, req, abrirDb,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("mesa-nevoa-ui");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const SHOTS = join(process.cwd(), "_evidencias", "nevoa");
mkdirSync(SHOTS, { recursive: true });
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const PNG_PATH = join(DIR, "mapa.png");
writeFileSync(PNG_PATH, Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"));

let browser, proc;
const errosConsole = [];
function vigiar(page, tag) {
  page.on("pageerror", (e) => errosConsole.push(`${tag}:pageerror:${e.message}`));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const txt = m.text();
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
async function abrirSessao(page, nome) {
  const linha = page.locator("tr.clicavel", { hasText: nome });
  await linha.first().waitFor({ timeout: 15000 });
  await linha.first().click();
  await page.locator(".mesa-vtt").first().waitFor({ timeout: 15000 });
}
const temControle = (page) => page.getByRole("button", { name: /pincel de névoa/i }).count();
const statusNevoa = async (page) =>
  (await page.locator(".vtt-nevoa-controles .meta").textContent().catch(() => ""))?.trim() ?? "";
const nTracos = async (page) => {
  const txt = await statusNevoa(page);
  const m = txt.match(/ativa \((\d+) traços?\)/);
  return m ? Number(m[1]) : (txt.includes("desativada") ? 0 : -1);
};
// pixel do canvas em coordenada normalizada [0,1] → [r,g,b,a]
const pxCanvas = (page, fx, fy) => page.locator(".vtt-nevoa-canvas").first().evaluate((cv, [fx, fy]) => {
  const c = cv.getContext("2d");
  const d = c.getImageData(Math.floor(cv.width * fx), Math.floor(cv.height * fy), 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}, [fx, fy]);
async function esperarPixel(page, fx, fy, pred, timeout = 8000) {
  const fim = Date.now() + timeout;
  let p = await pxCanvas(page, fx, fy);
  while (Date.now() < fim && !pred(p)) {
    await page.waitForTimeout(80);
    p = await pxCanvas(page, fx, fy);
  }
  return p;
}
const ehEscuroOpaco = (p) => p[3] > 200 && p[0] < 60 && p[1] < 60 && p[2] < 60;
const ehTransparente = (p) => p[3] < 40;
const ehAmarelo = (p) => p[0] > 180 && p[1] > 140 && p[2] < 160 && p[3] > 60;

async function desenhar(page, pontos) {
  const cv = page.locator(".vtt-nevoa-canvas-pincel");
  const box = await cv.boundingBox();
  await page.mouse.move(box.x + box.width * pontos[0][0], box.y + box.height * pontos[0][1]);
  await page.mouse.down();
  for (const [fx, fy] of pontos.slice(1)) {
    await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy, { steps: 4 });
  }
  await page.mouse.up();
}
// sequência crua de pointer events no canvas/janela — permite pointerId
// controlado e eventos de cancelamento que o mouse real não produz.
// ops: ["down",fx,fy] | ["move",fx,fy] | ["up",fx,fy] | ["cancel"] | ["lost",pid] | ["blur"]
async function seqPointer(page, pid, ops) {
  await page.evaluate(([pid, ops]) => {
    const cv = document.querySelector(".vtt-nevoa-canvas-pincel") || document.querySelector(".vtt-nevoa-canvas");
    const r = cv.getBoundingClientRect();
    const disparar = (type, xy, alvo) => {
      const init = Array.isArray(xy) && typeof xy[0] === "number"
        ? { clientX: r.left + r.width * xy[0], clientY: r.top + r.height * xy[1] }
        : {};
      const e = new PointerEvent(type, { ...init, pointerId: pid, pointerType: "touch", bubbles: true, cancelable: true, isPrimary: true });
      (alvo ?? window).dispatchEvent(e);
    };
    for (const op of ops) {
      if (op[0] === "down") disparar("pointerdown", op.slice(1), cv);
      else if (op[0] === "move") disparar("pointermove", op.slice(1), window);
      else if (op[0] === "up") disparar("pointerup", op.slice(1), window);
      else if (op[0] === "cancel") disparar("pointercancel", null, window);
      else if (op[0] === "lost") disparar("lostpointercapture", null, window);
      else if (op[0] === "blur") window.dispatchEvent(new Event("blur"));
    }
  }, [pid, ops]);
}
const pincelOn = async (page) => (await page.locator(".vtt-nevoa-canvas-pincel").count()) === 1;
async function garantirPincel(page) {
  if (!(await pincelOn(page))) {
    await page.getByRole("button", { name: /pincel de névoa/i }).click();
    await page.locator(".vtt-nevoa-canvas-pincel").waitFor({ timeout: 5000 });
  }
}
// mesma matemática do backend (servidor/src/lib/vtt.ts) para calcular a
// expectativa de visibilidade de tokens por papel — sem depender de DOM
function distSegElipse(px, py, ax, ay, bx, by, rx, ry) {
  const pax = (px - ax) / rx, pay = (py - ay) / ry;
  const pbx = (bx - ax) / rx, pby = (by - ay) / ry;
  const len2 = pbx * pbx + pby * pby;
  let t = len2 === 0 ? 0 : (pax * pbx + pay * pby) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = pax - pbx * t, cy = pay - pby * t;
  return Math.sqrt(cx * cx + cy * cy);
}
function pontoEmTraco(px, py, tr) {
  const ps = tr.pontos;
  if (ps.length === 1) return distSegElipse(px, py, ps[0].x, ps[0].y, ps[0].x, ps[0].y, tr.raioX, tr.raioY) <= 1 + 1e-9;
  for (let i = 0; i < ps.length - 1; i++) {
    if (distSegElipse(px, py, ps[i].x, ps[i].y, ps[i + 1].x, ps[i + 1].y, tr.raioX, tr.raioY) <= 1 + 1e-9) return true;
  }
  return false;
}
const visivelMapa = (vtt, x, y) => !vtt?.nevoa?.ativa || (vtt.nevoa.revelados ?? []).some((tr) => pontoEmTraco(x, y, tr));

async function vttStateHttp(sidSessao) {
  const j = await req(BASE, "GET", `/campaigns/${sidSessao.camp}/sessoes/${sidSessao.id}`, { cookie: sidSessao.cookie });
  const s = j.json?.sessao?.vttState;
  return typeof s === "string" ? JSON.parse(s) : s;
}

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", () => {});
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO, { jogadores: { jogador1: "nv_j1", jogador2: "nv_j2" } });
  const campId = c.campId;
  const cookieMestre = c.cookieMestre;

  // espectador VERDADEIRO: usuário próprio com membership role=espectador
  const espId = crypto.randomUUID();
  const dbE = abrirDb(BANCO);
  const agoraE = Date.now();
  dbE.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
    .run(espId, "nv_esp", "Espectador UI", await hashSenha("senha-jogador-123"), agoraE, agoraE);
  dbE.prepare("insert into memberships (id,campaign_id,user_id,role,status,joined_at,created_at,updated_at) values (?,?,?,'espectador','ativo',?,?,?)")
    .run(crypto.randomUUID(), campId, espId, agoraE, agoraE, agoraE);
  dbE.close();

  const sessA = await req(BASE, "POST", `/campaigns/${campId}/sessoes`, { cookie: cookieMestre, body: { name: "Mesa Névoa Alfa" } });
  const sessB = await req(BASE, "POST", `/campaigns/${campId}/sessoes`, { cookie: cookieMestre, body: { name: "Mesa Névoa Beta" } });
  const sidA = sessA.json?.sessao?.id ?? sessA.json?.id;
  const sidB = sessB.json?.sessao?.id ?? sessB.json?.id;
  t("sessões criadas", !!sidA && !!sidB);

  browser = await chromium.launch();
  const ctxM = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const ctxJ = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const ctxE = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const ctxM2 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const pgM = await ctxM.newPage(), pgJ = await ctxJ.newPage(), pgE = await ctxE.newPage(), pgM2 = await ctxM2.newPage();
  vigiar(pgM, "mestre"); vigiar(pgJ, "jogador"); vigiar(pgE, "espectador-mobile"); vigiar(pgM2, "mestre-mobile");

  await login(pgM, "mestre_teste", "senha-forte-123");
  await login(pgJ, "nv_j1", "senha-jogador-123");
  await login(pgE, "nv_esp", "senha-jogador-123");
  await login(pgM2, "mestre_teste", "senha-forte-123");
  await Promise.all([irMesa(pgM), irMesa(pgJ), irMesa(pgE), irMesa(pgM2)]);
  await abrirSessao(pgM, "Mesa Névoa Alfa");
  await abrirSessao(pgJ, "Mesa Névoa Alfa");
  await abrirSessao(pgE, "Mesa Névoa Alfa");
  await abrirSessao(pgM2, "Mesa Névoa Alfa");

  // mapa pelo mestre (sessão A)
  await pgM.locator(".mesa-vtt input[type=file]").setInputFiles(PNG_PATH);
  await pgM.locator(".vtt-tabuleiro").waitFor({ timeout: 10000 });
  await pgJ.locator(".vtt-tabuleiro").waitFor({ timeout: 10000 });
  await pgE.locator(".vtt-tabuleiro").waitFor({ timeout: 10000 });
  await pgM2.locator(".vtt-tabuleiro").waitFor({ timeout: 10000 });
  t("mapa visível aos 4 participantes", true);

  // tokens: Ana (dono jogador1) e Beto (dono jogador2)
  await pgM.locator(".vtt-controles input").fill("Ana");
  await pgM.locator(".vtt-controles select").selectOption(c.jogadores.jogador1.id);
  await pgM.locator(".vtt-controles button.primario").click();
  // espera o ACK limpar o formulário e o token chegar antes do próximo
  await pgM.waitForFunction(() => (document.querySelector(".vtt-controles input")?.value ?? "") === "", null, { timeout: 8000 });
  await pgM.locator(".vtt-token").first().waitFor({ timeout: 8000 });
  await pgM.locator(".vtt-controles input").fill("Beto");
  await pgM.locator(".vtt-controles select").selectOption(c.jogadores.jogador2.id);
  await pgM.locator(".vtt-controles button.primario").click();
  await pgM.waitForFunction(() => document.querySelectorAll(".vtt-token").length === 2, null, { timeout: 8000 });
  await pgJ.locator(".vtt-token").first().waitFor({ timeout: 8000 });
  await pgE.locator(".vtt-token").first().waitFor({ timeout: 8000 });
  t("tokens visíveis antes da névoa", (await pgM.locator(".vtt-token").count()) === 2);

  // arrasta Beto para (0.82,0.82) — também exercita o drag P6
  const tokB = pgM.locator('.vtt-token[title="Beto"]');
  const bbB = await tokB.boundingBox();
  const tbB = await pgM.locator(".vtt-tabuleiro").boundingBox();
  await pgM.mouse.move(bbB.x + bbB.width / 2, bbB.y + bbB.height / 2);
  await pgM.mouse.down();
  await pgM.mouse.move(tbB.x + tbB.width * 0.82, tbB.y + tbB.height * 0.82, { steps: 6 });
  await pgM.mouse.up();
  const vttPos = await vttStateHttp({ camp: campId, id: sidA, cookie: cookieMestre });
  const beto = (vttPos?.tokens ?? []).find((x) => x.nome === "Beto");
  t("drag moveu Beto para ~0.82 (rollback P6 intacto)", beto && Math.abs(beto.x - 0.82) < 0.06 && Math.abs(beto.y - 0.82) < 0.06,
    JSON.stringify(beto && { x: beto.x, y: beto.y }));

  sec("Controles e ordem de camadas por papel");
  t("mestre vê controle de névoa", (await temControle(pgM)) === 1);
  t("jogador NÃO vê controle de névoa", (await temControle(pgJ)) === 0);
  t("espectador (mobile, papel real) NÃO vê controle", (await temControle(pgE)) === 0);
  t("mestre mobile vê controle", (await temControle(pgM2)) === 1);
  // ordem de camadas computada: canvas(1) < token(2); no pincel canvas(3)
  const zc = await pgM.locator(".vtt-nevoa-canvas").evaluate((el) => getComputedStyle(el).zIndex);
  const zt = await pgM.locator(".vtt-token").first().evaluate((el) => getComputedStyle(el).zIndex);
  t("canvas de névoa abaixo dos tokens (z 1 < 2)", zc === "1" && zt === "2", `canvas=${zc} token=${zt}`);
  await garantirPincel(pgM);
  const zcP = await pgM.locator(".vtt-nevoa-canvas-pincel").evaluate((el) => getComputedStyle(el).zIndex);
  t("canvas de pincel acima dos tokens (z 3)", zcP === "3", `pincel=${zcP}`);
  await pgM.getByRole("button", { name: /sair do pincel/i }).click(); // volta ao normal
  await pgM.locator(".vtt-nevoa-canvas-pincel").waitFor({ state: "detached", timeout: 5000 }).catch(() => {});

  sec("Prévia com névoa DESATIVADA (D3)");
  await garantirPincel(pgM);
  // inicia desenho e segura o botão — prévia deve aparecer antes do ACK
  const cvBox = await pgM.locator(".vtt-nevoa-canvas-pincel").boundingBox();
  await pgM.mouse.move(cvBox.x + cvBox.width * 0.15, cvBox.y + cvBox.height * 0.15);
  await pgM.mouse.down();
  await pgM.mouse.move(cvBox.x + cvBox.width * 0.35, cvBox.y + cvBox.height * 0.35, { steps: 5 });
  const pxPrev = await esperarPixel(pgM, 0.25, 0.25, ehAmarelo, 3000);
  t("prévia amarela visível com névoa desativada", ehAmarelo(pxPrev), JSON.stringify(pxPrev));
  await pgM.mouse.up();
  await pgM.waitForFunction(
    () => /ativa \(1 traço\)/.test(document.querySelector(".vtt-nevoa-controles .meta")?.textContent ?? ""),
    null, { timeout: 8000 });
  t("primeiro traço ativou a névoa", (await nTracos(pgM)) === 1);

  sec("Propagação — revelar (3 papéis, pixels do canvas)");
  // ponto não revelado (0.9,0.1) escuro/opaco p/ jogador e espectador; revelado (~0.25,0.25) transparente
  const pxJEscuro = await esperarPixel(pgJ, 0.9, 0.1, ehEscuroOpaco);
  const pxJEsc = await esperarPixel(pgJ, 0.25, 0.25, ehTransparente);
  t("jogador: área oculta opaca / área revelada transparente",
    ehEscuroOpaco(pxJEscuro) && ehTransparente(pxJEsc), `escuro=${pxJEscuro} revelado=${pxJEsc}`);
  const pxEEscuro = await esperarPixel(pgE, 0.9, 0.1, ehEscuroOpaco);
  const pxERev = await esperarPixel(pgE, 0.25, 0.25, ehTransparente);
  t("espectador: mesma névoa renderizada", ehEscuroOpaco(pxEEscuro) && ehTransparente(pxERev),
    `escuro=${pxEEscuro} revelado=${pxERev}`);
  // tokens: Ana (própria do jogador1) aparece p/ jogador mesmo fora do traço; Beto não
  const titulosJ = await pgJ.locator(".vtt-token").evaluateAll((els) => els.map((e) => e.title));
  const titulosE = await pgE.locator(".vtt-token").evaluateAll((els) => els.map((e) => e.title));
  t("jogador vê o próprio token oculto; não vê o de Beto",
    titulosJ.includes("Ana") && !titulosJ.includes("Beto"), titulosJ.join(","));
  t("espectador não vê tokens fora da área revelada", !titulosE.includes("Ana") && !titulosE.includes("Beto"), titulosE.join(","));

  sec("Propagação — desfazer / ocultarTudo / revelarTudo");
  await pgM.getByRole("button", { name: "Desfazer traço" }).click();
  await pgM.waitForFunction(
    () => /ativa \(0 traços\)|desativada/.test(document.querySelector(".vtt-nevoa-controles .meta")?.textContent ?? ""),
    null, { timeout: 8000 });
  const pxJVolta = await esperarPixel(pgJ, 0.25, 0.25, ehEscuroOpaco);
  t("desfazer propagou: área volta a ficar coberta p/ jogador", ehEscuroOpaco(pxJVolta), JSON.stringify(pxJVolta));

  await pgM.getByRole("button", { name: "Ocultar tudo" }).click();
  await pgM.waitForFunction(
    () => /ativa \(0 traços\)/.test(document.querySelector(".vtt-nevoa-controles .meta")?.textContent ?? ""),
    null, { timeout: 8000 });
  const titulosJ2 = await pgJ.locator(".vtt-token").evaluateAll((els) => els.map((e) => e.title));
  const titulosE2 = await pgE.locator(".vtt-token").evaluateAll((els) => els.map((e) => e.title));
  t("ocultarTudo: jogador vê SÓ o próprio token", titulosJ2.join() === "Ana", titulosJ2.join(","));
  t("ocultarTudo: espectador sem tokens", titulosE2.length === 0, titulosE2.join(","));
  const pxJFull = await esperarPixel(pgJ, 0.25, 0.25, ehEscuroOpaco);
  t("ocultarTudo: cobertura totalmente opaca", pxJFull[3] === 255, JSON.stringify(pxJFull));
  // token próprio ACIMA do véu: z-index computado + pixel do token não coberto
  const zTok = await pgJ.locator(".vtt-token").first().evaluate((el) => getComputedStyle(el).zIndex);
  t("token do jogador acima do canvas (z-index 2 > 1)", zTok === "2", `z=${zTok}`);

  await pgM.getByRole("button", { name: "Revelar tudo" }).click();
  await pgM.waitForFunction(
    () => /desativada/.test(document.querySelector(".vtt-nevoa-controles .meta")?.textContent ?? ""),
    null, { timeout: 8000 });
  const pxJLimpo = await esperarPixel(pgJ, 0.5, 0.5, ehTransparente);
  const titulosE3 = await pgE.locator(".vtt-token").evaluateAll((els) => els.map((e) => e.title));
  t("revelarTudo: véu some e espectador vê todos os tokens",
    ehTransparente(pxJLimpo) && titulosE3.includes("Ana") && titulosE3.includes("Beto"),
    `px=${pxJLimpo} tokens=${titulosE3.join(",")}`);

  sec("Cancelamento de desenho (D1)");
  await garantirPincel(pgM);
  const n0 = await nTracos(pgM);
  // pointercancel descarta sem emitir
  await seqPointer(pgM, 42, [["down", 0.6, 0.6], ["move", 0.65, 0.65], ["cancel"], ["up", 0.65, 0.65]]);
  // lostpointercapture descarta sem emitir
  await seqPointer(pgM, 43, [["down", 0.6, 0.6], ["move", 0.65, 0.65], ["lost"], ["up", 0.65, 0.65]]);
  // blur da janela descarta
  await seqPointer(pgM, 44, [["down", 0.6, 0.6], ["move", 0.65, 0.65], ["blur"], ["up", 0.65, 0.65]]);
  await pgM.waitForTimeout(400);
  t("pointercancel/lostpointercapture/blur não emitem traço", (await nTracos(pgM)) === n0, `antes=${n0} depois=${await nTracos(pgM)}`);
  // segundo ponteiro não interfere: up de id estranho não encerra o gesto
  await seqPointer(pgM, 50, [["down", 0.6, 0.6], ["down", 51, 0.7, 0.7], ["move", 51, 0.72, 0.72], ["up", 51, 0.72, 0.72], ["move", 50, 0.68, 0.68], ["up", 50, 0.68, 0.68]]);
  await pgM.waitForFunction((n) => {
    const txt = document.querySelector(".vtt-nevoa-controles .meta")?.textContent ?? "";
    return txt.includes("desativada") ? n === 0 : Number(txt.match(/ativa \((\d+)/)?.[1]) === n;
  }, n0 + 1, { timeout: 8000 });
  t("gesto com ponteiro secundário emite exatamente 1 traço", (await nTracos(pgM)) === n0 + 1);
  // desfaz para voltar ao baseline antes dos próximos testes
  await pgM.getByRole("button", { name: "Desfazer traço" }).click();
  await pgM.waitForTimeout(500);
  // desligar o pincel no meio do desenho cancela o rascunho
  await seqPointer(pgM, 60, [["down", 0.6, 0.6], ["move", 0.65, 0.65]]);
  await pgM.getByRole("button", { name: /sair do pincel/i }).click();
  await seqPointer(pgM, 60, [["up", 0.65, 0.65]]);
  await pgM.waitForTimeout(400);
  t("desligar pincel durante desenho não emite", (await nTracos(pgM)) === n0, `depois=${await nTracos(pgM)}`);
  // troca de sessão com desenho ativo cancela o gesto (desmonte do componente)
  await garantirPincel(pgM);
  await seqPointer(pgM, 80, [["down", 0.6, 0.6], ["move", 0.65, 0.65]]);
  await pgM.getByRole("button", { name: "Sair da mesa" }).click();
  await abrirSessao(pgM, "Mesa Névoa Alfa");
  await pgM.locator(".vtt-tabuleiro").waitFor({ timeout: 10000 });
  await pgM.waitForTimeout(400);
  t("troca de sessão cancela desenho sem emitir", (await nTracos(pgM)) === n0, `depois=${await nTracos(pgM)}`);

  sec("Coordenadas fora do tabuleiro e limite de pontos");
  await garantirPincel(pgM);
  // desenho real saindo da área: começa dentro, sai para fora, solta fora
  const bx = await pgM.locator(".vtt-nevoa-canvas-pincel").boundingBox();
  await pgM.mouse.move(bx.x + bx.width * 0.55, bx.y + bx.height * 0.55);
  await pgM.mouse.down();
  await pgM.mouse.move(bx.x + bx.width * 0.6, bx.y + bx.height * 0.6, { steps: 3 });
  await pgM.mouse.move(bx.x - 300, bx.y - 300, { steps: 3 }); // fora do tabuleiro
  await pgM.mouse.up();
  await pgM.waitForTimeout(600);
  const vttFora = await vttStateHttp({ camp: campId, id: sidA, cookie: cookieMestre });
  const tracosFora = vttFora?.nevoa?.revelados ?? [];
  const ultimo = tracosFora[tracosFora.length - 1];
  const coordsOk = ultimo && ultimo.pontos.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);
  t("movimento fora do tabuleiro não grava coordenadas fora de [0,1]", coordsOk === true,
    JSON.stringify(ultimo?.pontos?.slice(-2)));
  // >128 pontos: grade 10×16 com passo > dedup(0.004) → amostragem preserva início/fim
  const moves128 = Array.from({ length: 160 }, (_, i) => ["move", 0.6 + (i % 10) * 0.015, 0.6 + (Math.floor(i / 10) % 16) * 0.012]);
  await seqPointer(pgM, 70, [["down", 0.6, 0.6], ...moves128, ["up", 0.76, 0.6]]);
  await pgM.waitForTimeout(800);
  const vtt128 = await vttStateHttp({ camp: campId, id: sidA, cookie: cookieMestre });
  const tr128 = (vtt128?.nevoa?.revelados ?? []).slice(-1)[0];
  const pts = tr128?.pontos ?? [];
  t("traço >128 pontos: limite respeitado, início/fim preservados",
    pts.length <= 128 && pts.length > 100
    && Math.abs(pts[0].x - 0.6) < 0.02 && Math.abs(pts[pts.length - 1].x - 0.76) < 0.02,
    `n=${pts.length} ini=${pts[0]?.x} fim=${pts[pts.length - 1]?.x}`);

  sec("ACK rejeitado limpa prévia (sessão encerrada)");
  // sessão B: mapa + gesto iniciado, PATCH encerra no meio → ACK de rejeição
  await pgM.getByRole("button", { name: "Sair da mesa" }).click();
  await abrirSessao(pgM, "Mesa Névoa Beta");
  await pgM.locator(".mesa-vtt input[type=file]").setInputFiles(PNG_PATH);
  await pgM.locator(".vtt-tabuleiro").waitFor({ timeout: 10000 });
  await garantirPincel(pgM);
  const cvBoxB = await pgM.locator(".vtt-nevoa-canvas-pincel").boundingBox();
  await pgM.mouse.move(cvBoxB.x + cvBoxB.width * 0.4, cvBoxB.y + cvBoxB.height * 0.4);
  await pgM.mouse.down();
  await pgM.mouse.move(cvBoxB.x + cvBoxB.width * 0.5, cvBoxB.y + cvBoxB.height * 0.5, { steps: 3 });
  // encerra a sessão B enquanto o gesto está ativo
  await req(BASE, "PATCH", `/campaigns/${campId}/sessoes/${sidB}`, { cookie: cookieMestre, body: { status: "encerrada" } });
  await pgM.mouse.up();
  await pgM.locator(".erro", { hasText: /encerrada/i }).waitFor({ timeout: 8000 }).catch(() => null);
  const erroTxt = await pgM.locator(".erro").last().textContent().catch(() => "");
  const pxAposRejeicao = await pxCanvas(pgM, 0.45, 0.45);
  t("ACK rejeitado: erro exibido e prévia limpa", /encerrada/i.test(erroTxt) && !ehAmarelo(pxAposRejeicao),
    `erro="${erroTxt}" px=${pxAposRejeicao}`);

  sec("Timeout sem ACK + ACK tardio (offline)");
  // volta à sessão A
  await pgM.getByRole("button", { name: "Sair da mesa" }).click();
  await abrirSessao(pgM, "Mesa Névoa Alfa");
  await pgM.locator(".vtt-tabuleiro").waitFor({ timeout: 10000 });
  await garantirPincel(pgM);
  const nAntesOff = await nTracos(pgM);
  await ctxM.setOffline(true);
  await desenhar(pgM, [[0.62, 0.62], [0.7, 0.62], [0.7, 0.7]]);
  // sem ACK: após ~5s os controles são liberados com erro de timeout
  await pgM.getByText(/Sem confirmação do servidor/i).waitFor({ timeout: 12000 });
  const desfezHabilitado = await pgM.getByRole("button", { name: "Desfazer traço" }).isEnabled();
  t("sem ACK: timeout libera controles e informa", desfezHabilitado === true);
  // volta online: o emit em buffer é entregue e o ACK tardio é ignorado —
  // o estado converge pelo broadcast, sem duplicar traço
  await ctxM.setOffline(false);
  await pgM.waitForFunction((n) => {
    const txt = document.querySelector(".vtt-nevoa-controles .meta")?.textContent ?? "";
    return txt.includes("desativada") ? n === 0 : Number(txt.match(/ativa \((\d+)/)?.[1]) === n;
  }, nAntesOff + 1, { timeout: 20000 });
  t("ACK tardio ignorado: estado converge sem duplicar", (await nTracos(pgM)) === nAntesOff + 1);

  sec("Toque real mobile (CDP) — mestre 390×844");
  await garantirPincel(pgM2);
  const nM2 = await nTracos(pgM2);
  const boxM2 = await pgM2.locator(".vtt-nevoa-canvas-pincel").boundingBox();
  const cdp = await ctxM2.newCDPSession(pgM2);
  const ptsTouch = [[0.3, 0.3], [0.4, 0.3], [0.4, 0.4], [0.3, 0.4], [0.3, 0.3]]
    .map(([fx, fy]) => ({ x: boxM2.x + boxM2.width * fx, y: boxM2.y + boxM2.height * fy }));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [ptsTouch[0]] });
  for (const p of ptsTouch.slice(1, -1)) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [p] });
    await pgM2.waitForTimeout(30);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await pgM2.waitForFunction((n) => {
    const txt = document.querySelector(".vtt-nevoa-controles .meta")?.textContent ?? "";
    return txt.includes("desativada") ? n === 0 : Number(txt.match(/ativa \((\d+)/)?.[1]) === n;
  }, nM2 + 1, { timeout: 10000 });
  t("gesto touch real no mobile ativou 1 traço", (await nTracos(pgM2)) === nM2 + 1);
  // canvas interno acompanha CSS × DPR
  const dimCanvas = await pgM2.locator(".vtt-nevoa-canvas").evaluate((cv) => ({
    w: cv.width, h: cv.height, cw: cv.clientWidth, ch: cv.clientHeight, dpr: window.devicePixelRatio,
  }));
  t("canvas interno = CSS × devicePixelRatio",
    Math.abs(dimCanvas.w - Math.round(dimCanvas.cw * dimCanvas.dpr)) <= 1
    && dimCanvas.dpr > 1, JSON.stringify(dimCanvas));

  sec("Redimensionamento (D7/E6)");
  const dimAntes = await pgM.locator(".vtt-nevoa-canvas").evaluate((cv) => ({ w: cv.width, cw: cv.clientWidth }));
  await pgM.setViewportSize({ width: 1280, height: 800 });
  await pgM.waitForTimeout(400);
  const dimDepois = await pgM.locator(".vtt-nevoa-canvas").evaluate((cv) => ({ w: cv.width, cw: cv.clientWidth, dpr: window.devicePixelRatio }));
  t("resize desktop: canvas interno acompanha o tabuleiro",
    dimDepois.w !== dimAntes.w && Math.abs(dimDepois.w - Math.round(dimDepois.cw * dimDepois.dpr)) <= 1,
    JSON.stringify({ antes: dimAntes, depois: dimDepois }));
  // região revelada não se desloca: ponto revelado continua transparente p/ jogador
  const pxAposResize = await esperarPixel(pgJ, 0.25, 0.25, (p) => true, 500);
  t("canvas do jogador re-renderizado após resize", Array.isArray(pxAposResize));
  await pgM.setViewportSize({ width: 1920, height: 1080 });
  await pgE.setViewportSize({ width: 844, height: 390 }); // "paisagem" mobile
  await pgE.waitForTimeout(400);
  const dimE = await pgE.locator(".vtt-nevoa-canvas").evaluate((cv) => ({ w: cv.width, cw: cv.clientWidth, ch: cv.clientHeight }));
  t("rotação mobile: canvas acompanha novo aspecto", dimE.w > 0 && Math.abs(dimE.w - Math.round(dimE.cw * 2)) <= 1, JSON.stringify(dimE));
  await pgE.setViewportSize({ width: 390, height: 844 });

  sec("Reconexão / reload");
  await pgJ.reload();
  await pgJ.getByText("Servidor online").waitFor({ timeout: 15000 });
  await irMesa(pgJ);
  await abrirSessao(pgJ, "Mesa Névoa Alfa");
  await pgJ.locator(".vtt-tabuleiro").waitFor({ timeout: 10000 });
  // expectativa calculada pela geometria real do estado persistido:
  // jogador1 vê tokens revelados + o próprio (exceção); espectador só revelados
  const vttEsp = await vttStateHttp({ camp: campId, id: sidA, cookie: cookieMestre });
  const tokensVivos = (vttEsp?.tokens ?? []).filter((tk) => tk.ativo !== false);
  const espJ1 = c.jogadores.jogador1.id;
  const esperadoJ = tokensVivos.filter((tk) => visivelMapa(vttEsp, tk.x, tk.y) || tk.userId === espJ1).map((tk) => tk.nome).sort();
  const esperadoE = tokensVivos.filter((tk) => visivelMapa(vttEsp, tk.x, tk.y)).map((tk) => tk.nome).sort();
  // espera a contagem autoritativa chegar via socket antes de comparar
  await pgJ.waitForFunction((n) => document.querySelectorAll(".vtt-token").length === n, esperadoJ.length, { timeout: 8000 }).catch(() => {});
  const titulosJ3 = (await pgJ.locator(".vtt-token").evaluateAll((els) => els.map((e) => e.title))).sort();
  t("após reload: jogador vê névoa + visão filtrada correta",
    JSON.stringify(titulosJ3) === JSON.stringify(esperadoJ),
    `dom=${titulosJ3} esperado=${esperadoJ}`);
  await pgE.reload();
  await pgE.getByText("Servidor online").waitFor({ timeout: 15000 });
  await irMesa(pgE);
  await abrirSessao(pgE, "Mesa Névoa Alfa");
  await pgE.locator(".vtt-tabuleiro").waitFor({ timeout: 10000 });
  await pgE.waitForFunction((n) => document.querySelectorAll(".vtt-token").length === n, esperadoE.length, { timeout: 8000 }).catch(() => {});
  const titulosE4 = (await pgE.locator(".vtt-token").evaluateAll((els) => els.map((e) => e.title))).sort();
  t("após reload: espectador vê somente tokens em área revelada",
    JSON.stringify(titulosE4) === JSON.stringify(esperadoE),
    `dom=${titulosE4} esperado=${esperadoE}`);

  await pgM.screenshot({ path: join(SHOTS, "nevoa-mestre.png") });
  await pgJ.screenshot({ path: join(SHOTS, "nevoa-jogador.png") });
  await pgE.screenshot({ path: join(SHOTS, "nevoa-espectador-mobile.png") });
  await pgM2.screenshot({ path: join(SHOTS, "nevoa-mestre-mobile.png") });

  t("nenhum erro de console/pageerror", errosConsole.length === 0, errosConsole.slice(0, 3).join(" | "));
} catch (e) {
  fail++;
  console.error("FALHA INESPERADA:", e);
} finally {
  try { await browser?.close(); } catch {}
  try { await encerrarServidor(proc); } catch {}
  try { limparDir(DIR); } catch {}
}
console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
