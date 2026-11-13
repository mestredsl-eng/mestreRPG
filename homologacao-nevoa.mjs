// Homologação visual — névoa de guerra (Etapa 2, PR-B), revisão de auditoria.
// Cobre: controles por papel real (mestre/jogador/espectador), ordem de
// camadas, prévia com névoa desativada, propagação revelar/desfazer/
// ocultarTudo/revelarTudo nos 3 clientes via pixels do canvas, cancelamento
// (pointercancel/lostpointercapture/blur/troca de sessão/desligar pincel),
// coordenadas fora do tabuleiro, limite de 128 pontos, ACK rejeitado,
// timeout sem ACK + ACK tardio, toque real mobile (CDP), redimensionamento
// e reconexão. Evidências em _evidencias/nevoa/.
import { chromium } from "playwright";
import { io as ioClient } from "socket.io-client";
import crypto from "node:crypto";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { hashSenha } from "./servidor/dist/lib/password.js";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, encerrarServidor, limparDir, req, abrirDb, sessao,
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
    // quedas proposital do servidor (testes de reconexão/timeout) geram
    // ERR_CONNECTION_REFUSED e falhas de polling esperadas — não são
    // erros de aplicação
    if (/ERR_CONNECTION_REFUSED|socket\.io.*(failed|refused)|NetworkError|Failed to fetch/i.test(txt)) return;
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
// ops: ["down",fx,fy] ["move",fx,fy] ["up",fx,fy] — sempre no pid base;
//      ["downp",pid,fx,fy] ["movep",pid,fx,fy] ["upp",pid,fx,fy]
//      ["cancel"] ["cancelp",pid] ["lost"] ["lostp",pid] ["blur"]
async function seqPointer(page, pid, ops) {
  await page.evaluate(([pid, ops]) => {
    const cv = document.querySelector(".vtt-nevoa-canvas-pincel") || document.querySelector(".vtt-nevoa-canvas");
    const r = cv.getBoundingClientRect();
    const disparar = (type, xy, alvo, p) => {
      const init = Array.isArray(xy) && typeof xy[0] === "number"
        ? { clientX: r.left + r.width * xy[0], clientY: r.top + r.height * xy[1] }
        : {};
      const e = new PointerEvent(type, { ...init, pointerId: p, pointerType: "touch", bubbles: true, cancelable: true, isPrimary: p === pid });
      (alvo ?? window).dispatchEvent(e);
    };
    for (const op of ops) {
      if (op[0] === "down") disparar("pointerdown", op.slice(1), cv, pid);
      else if (op[0] === "move") disparar("pointermove", op.slice(1), window, pid);
      else if (op[0] === "up") disparar("pointerup", op.slice(1), window, pid);
      else if (op[0] === "downp") disparar("pointerdown", op.slice(2), cv, op[1]);
      else if (op[0] === "movep") disparar("pointermove", op.slice(2), window, op[1]);
      else if (op[0] === "upp") disparar("pointerup", op.slice(2), window, op[1]);
      else if (op[0] === "cancel") disparar("pointercancel", null, window, pid);
      else if (op[0] === "cancelp") disparar("pointercancel", null, window, op[1]);
      else if (op[0] === "lost") disparar("lostpointercapture", null, window, pid);
      else if (op[0] === "lostp") disparar("lostpointercapture", null, window, op[1]);
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

// queda REAL do servidor: mata o processo (todos os sockets morrem de
// verdade — setOffline não derruba WebSocket) e sobe de novo no mesmo
// banco/porta. Os clientes precisam reconectar e re-entrar sozinhos.
async function reiniciarServidor() {
  await encerrarServidor(proc);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", () => {});
  await esperarSaudavel(BASE, proc);
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
  // prova de "mesma página": reload zeraria o estado React e não pode
  // ocorrer em nenhuma seção de tempo real
  let cargasJ = 0;
  pgJ.on("load", () => cargasJ++);

  // Interceptação de emits — registrada ANTES do socket conectar.
  // Cobre os dois transportes do Socket.IO:
  //  · WebSocket (routeWebSocket): mensagens ficam retidas em filas.
  //  · Polling (page.route em POST /socket.io): requests retidas.
  // O match usa aspas ("mesa:vtt:nevoa") para NÃO casar o evento
  // "mesa:vtt:nevoa:sincronizar".
  let segurarNevoa = false;
  const filaNevoa = [];
  const rotasNevoa = [];
  let wsSrvM = null;
  let nevoaInterceptados = 0;
  let nevoaEmitidos = 0; // TODOS os emits de névoa (retidos ou não)
  // perda controlada de ACKs servidor→cliente (pacotes socket.io tipo 3
  // = frames "43…"): o servidor PROCESSA a operação, mas o cliente
  // nunca recebe a confirmação — timeout → estado incerto real
  let derrubarAckM = 0;
  const liberarNevoa = () => {
    segurarNevoa = false;
    const q = filaNevoa.splice(0);
    for (const m of q) { try { wsSrvM?.send(m); } catch { /* conexão morta */ } }
    const rs = rotasNevoa.splice(0);
    for (const r of rs) void r.continue().catch(() => {});
  };
  const descartarNevoa = () => {
    segurarNevoa = false;
    filaNevoa.length = 0;
    const rs = rotasNevoa.splice(0);
    for (const r of rs) void r.abort().catch(() => {});
  };
  const ehMsgNevoa = (msg) => typeof msg === "string" && msg.includes('"mesa:vtt:nevoa"');
  await pgM.routeWebSocket(/\/socket\.io/, (ws) => {
    const srv = ws.connectToServer();
    wsSrvM = srv;
    ws.onMessage((msg) => {
      if (ehMsgNevoa(msg)) nevoaEmitidos++;
      if (segurarNevoa && ehMsgNevoa(msg)) { nevoaInterceptados++; filaNevoa.push(msg); return; }
      srv.send(msg);
    });
    srv.onMessage((m) => {
      if (derrubarAckM > 0 && typeof m === "string" && m.startsWith("43")) { derrubarAckM--; return; }
      ws.send(m);
    });
  });
  await pgM.route("**/socket.io/**", async (route) => {
    const req = route.request();
    const corpo = req.postData() ?? "";
    if (segurarNevoa && req.method() === "POST" && corpo.includes('"mesa:vtt:nevoa"')) {
      nevoaInterceptados++;
      rotasNevoa.push(route);
      return; // segura a request — o emit não chega ao servidor
    }
    await route.continue();
  });
  // estado incerto está ativo enquanto o botão "Sincronizar névoa"
  // existir; ele só some quando a sincronização ordenada responde
  const esperarSemIncerto = (page, timeout = 30000) => page.waitForFunction(() => {
    return ![...document.querySelectorAll("button")].some((b) => /sincronizar n/i.test(b.textContent ?? ""));
  }, null, { timeout });
  let entrarCountJ = 0, wsCountJ = 0;
  // corrida VTT: reter o ACK (pacote "43[..."] ) da sincronização para
  // controlar a ordem de chegada das respostas entre gerações de papel
  let armarRetencaoSyncJ = false, armadoUmaVezJ = false, ackSyncJRetido = null;
  const liberarAckSyncJ = () => { if (ackSyncJRetido) { try { pgJWs?.send(ackSyncJRetido); } catch { /* morto */ } ackSyncJRetido = null; } };
  // retenção genérica de eventos servidor→cliente (pacotes "42[…") —
  // prova de eventos privados produzidos antes da rebaixamento e
  // entregues ao navegador DEPOIS dela
  let reterEvtJ = null; // predicado (msg) => bool
  const filaEvtJ = [];
  const liberarEvtJ = () => { const q = filaEvtJ.splice(0); for (const m of q) { try { pgJWs?.send(m); } catch { /* morto */ } } };
  // retenção de UMA resposta HTTP autenticada (histórico privilegiado)
  let armarHttpJ = false, httpRetidoJ = null;
  const liberarHttpJ = async () => { const r = httpRetidoJ; httpRetidoJ = null; if (r) await r.continue().catch(() => {}); };
  let pgJWs = null;
  await pgJ.routeWebSocket(/\/socket\.io/, (ws) => {
    wsCountJ++;
    pgJWs = ws;
    const srv = ws.connectToServer();
    ws.onMessage((msg) => {
      if (typeof msg === "string" && msg.includes("mesa:entrar")) entrarCountJ++;
      // arma UMA única vez por solicitação do teste — sincronizações
      // posteriores (geração nova) NÃO podem ter o ACK retido
      if (armarRetencaoSyncJ && !armadoUmaVezJ && typeof msg === "string" && msg.includes("nevoa:sincronizar")) {
        armarRetencaoSyncJ = false;
        armadoUmaVezJ = true;
      }
      srv.send(msg);
    });
    srv.onMessage((m) => {
      // ACKs do Socket.IO são pacotes "43[" — retem o primeiro após o
      // emit de sincronização armado (prova da corrida VTT)
      if (armadoUmaVezJ && ackSyncJRetido === null && typeof m === "string" && m.startsWith("43")) {
        armadoUmaVezJ = false;
        ackSyncJRetido = m;
        return; // NÃO entrega — resposta fica retida no cliente
      }
      // eventos privados retidos a pedido do teste (prova de evento
      // atrasado após mudança de autorização)
      if (reterEvtJ && typeof m === "string" && m.startsWith("42") && reterEvtJ(m)) {
        filaEvtJ.push(m);
        return; // NÃO entrega — fica retido no transporte do navegador
      }
      ws.send(m);
    });
  });
  // transporte polling (fallback de reconexão): emits viajam em POSTs
  // HTTP, fora do routeWebSocket — conta "mesa:entrar" nesses corpos
  // para que a métrica de listeners não dependa do transporte ativo
  await pgJ.route("**/socket.io/**", async (route) => {
    const corpo = route.request().postData() ?? "";
    entrarCountJ += corpo.split('"mesa:entrar"').length - 1;
    await route.continue();
  });
  // segura a PRIMEIRA resposta de histórico após o arm — prova de
  // resposta HTTP antiga chegando depois da mudança de papel
  await pgJ.route("**/mensagens*", async (route) => {
    if (armarHttpJ && route.request().method() === "GET") {
      armarHttpJ = false;
      httpRetidoJ = route;
      return; // resposta não chega ao JavaScript
    }
    await route.continue();
  });

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
  // o drag é assíncrono (socket → persistência): aguarda a posição
  // autoritativa convergir em vez de ler o HTTP numa corrida
  let beto = null;
  for (let i = 0; i < 40; i++) {
    const vttPos = await vttStateHttp({ camp: campId, id: sidA, cookie: cookieMestre });
    beto = (vttPos?.tokens ?? []).find((x) => x.nome === "Beto");
    if (beto && Math.abs(beto.x - 0.82) < 0.06 && Math.abs(beto.y - 0.82) < 0.06) break;
    await pgM.waitForTimeout(150);
  }
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
  // segundo ponteiro CANCELADO não interrompe o desenho do primeiro:
  // pid 100 desenha; pid 101 dá down (ignorado) e pointercancel — o gesto
  // do 100 continua e finaliza emitindo exatamente 1 traço persistido.
  const vttAntesP2 = await vttStateHttp({ camp: campId, id: sidA, cookie: cookieMestre });
  const nTracosAntesP2 = (vttAntesP2?.nevoa?.revelados ?? []).length;
  await seqPointer(pgM, 100, [
    ["down", 0.55, 0.55], ["move", 0.6, 0.6],
    ["downp", 101, 0.8, 0.8], ["cancelp", 101], ["upp", 101, 0.8, 0.8],
    ["movep", 101, 0.85, 0.85], // move de ponteiro estranho: ignorado
    ["move", 0.62, 0.62], ["up", 0.62, 0.62],
  ]);
  await pgM.waitForFunction((n) => {
    const txt = document.querySelector(".vtt-nevoa-controles .meta")?.textContent ?? "";
    return txt.includes("desativada") ? n === 0 : Number(txt.match(/ativa \((\d+)/)?.[1]) === n;
  }, n0 + 1, { timeout: 8000 });
  const vttDepoisP2 = await vttStateHttp({ camp: campId, id: sidA, cookie: cookieMestre });
  const tracosDepoisP2 = vttDepoisP2?.nevoa?.revelados ?? [];
  const ultimoP2 = tracosDepoisP2[tracosDepoisP2.length - 1];
  t("pointercancel de 2º ponteiro não cancela o 1º: exatamente 1 traço persistido",
    tracosDepoisP2.length === nTracosAntesP2 + 1
    && Math.abs(ultimoP2?.pontos?.[0]?.x - 0.55) < 0.05
    && Math.abs(ultimoP2?.pontos?.[0]?.y - 0.55) < 0.05,
    `n=${tracosDepoisP2.length} ini=${JSON.stringify(ultimoP2?.pontos?.[0])}`);
  // volta ao baseline
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
  // desenho saindo da área: pontos com fx<0/fx>1 ficam fora do retângulo —
  // devem ser IGNORADOS (não grampeados na borda) e o pointerup externo
  // finaliza com o último ponto válido interno (~0.60,0.60)
  await seqPointer(pgM, 90, [
    ["down", 0.55, 0.55], ["move", 0.6, 0.6],
    ["move", -0.5, 0.5], ["move", 1.5, 0.4], ["up", -0.5, 0.5],
  ]);
  await pgM.waitForTimeout(600);
  const vttFora = await vttStateHttp({ camp: campId, id: sidA, cookie: cookieMestre });
  const tracosFora = vttFora?.nevoa?.revelados ?? [];
  const ultimo = tracosFora[tracosFora.length - 1];
  const coordsOk = ultimo && ultimo.pontos.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1);
  t("movimento fora do tabuleiro não grava coordenadas fora de [0,1]", coordsOk === true,
    JSON.stringify(ultimo?.pontos?.slice(-2)));
  // o frontend deve IGNORAR pontos externos — não grampear na borda:
  // o último ponto persistido é o último ponto válido interno (~0.60,0.60)
  // e nenhum ponto artificial de borda foi criado
  const ptsFora = ultimo?.pontos ?? [];
  const fimValido = ptsFora[ptsFora.length - 1];
  const semBorda = ptsFora.every((p) => p.x > 0.02 && p.x < 0.98 && p.y > 0.02 && p.y < 0.98);
  t("ponto final = último válido interno (~0.60,0.60), sem ponto artificial de borda",
    !!fimValido && Math.hypot(fimValido.x - 0.6, fimValido.y - 0.6) < 0.03 && semBorda === true,
    `fim=${JSON.stringify(fimValido)} n=${ptsFora.length}`);
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

  sec("Timeout ambíguo — estado incerto (servidor cai)");
  // volta à sessão A
  await pgM.getByRole("button", { name: "Sair da mesa" }).click();
  await abrirSessao(pgM, "Mesa Névoa Alfa");
  await pgM.locator(".vtt-tabuleiro").waitFor({ timeout: 10000 });
  await garantirPincel(pgM);
  const nAntesOff = await nTracos(pgM);
  const nHttpAntesOff = ((await vttStateHttp({ camp: campId, id: sidA, cookie: cookieMestre }))?.nevoa?.revelados ?? []).length;
  // o emit é retido na camada de transporte (o cliente acha que enviou)
  // e o SERVIDOR CAI de verdade: o ACK é impossível → timeout → o
  // resultado fica incerto — não é rejeição
  segurarNevoa = true;
  await desenhar(pgM, [[0.62, 0.62], [0.7, 0.62], [0.7, 0.7]]);
  await encerrarServidor(proc);
  // ACK expirou ≠ rejeição: mensagem de resultado DESCONHECIDO e mutações
  // bloqueadas (o botão Sincronizar é a prova persistente do estado
  // incerto — a mensagem de erro pode ser substituída pela falha de
  // sincronização enquanto o servidor está fora)
  await pgM.getByRole("button", { name: /sincronizar névoa/i }).waitFor({ timeout: 20000 });
  const desfezIncerto = await pgM.getByRole("button", { name: "Desfazer traço" }).isEnabled();
  const erroIncerto = await pgM.locator(".erro").last().textContent().catch(() => "");
  t("timeout: mensagem de resultado incerto + controles bloqueados",
    desfezIncerto === false && /desconhecido|sincroniza/i.test(erroIncerto ?? ""),
    `desfazer=${desfezIncerto} erro="${erroIncerto}"`);
  // tentar iniciar outro desenho NÃO envia nada (gesto bloqueado)
  await desenhar(pgM, [[0.2, 0.2], [0.28, 0.28]]);
  await pgM.waitForTimeout(600);
  // sobe o servidor de novo: o socket reconecta → connect → mesa:entrar →
  // estado VTT filtrado autoritativo → libera as mutações. O emit retido
  // morreu com a conexão antiga: o traço NÃO foi aplicado — nunca
  // reenviado, nunca duplicado.
  descartarNevoa();
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", () => {});
  await esperarSaudavel(BASE, proc);
  // a reconciliação só termina quando o estado autoritativo chega:
  // "Sincronizar névoa" some e o vtt exibido passa a ser o do servidor.
  // (esperar por "Desfazer habilitado" aqui seria um falso positivo —
  // o estado VELHO da UI já o satisfaz antes da reconexão)
  await esperarSemIncerto(pgM, 90000);
  const nAposRec = await nTracos(pgM);
  const nHttpApos = ((await vttStateHttp({ camp: campId, id: sidA, cookie: cookieMestre }))?.nevoa?.revelados ?? []).length;
  t("reconciliação pós-timeout: mutações liberadas, estado = servidor, sem traço duplicado",
    nAposRec === nHttpApos && nHttpApos === nHttpAntesOff,
    `ui=${nAposRec} http=${nHttpApos} antes=${nHttpAntesOff} interceptados=${nevoaInterceptados}`);

  sec("ACK perdido com socket CONECTADO — op recebida, sync ordenada libera");
  // G1: o servidor RECEBE e processa a operação, mas os ACKs se perdem
  // (derrubarAckM=2: o da operação E o da 1ª sincronização automática).
  // O estado incerto permanece até a sincronização EXPIRAR — janela
  // determinística de ~3s para verificar bloqueios antes do retry.
  const nAntesHold = ((await vttStateHttp({ camp: campId, id: sidA, cookie: cookieMestre }))?.nevoa?.revelados ?? []).length;
  await esperarSemIncerto(pgM, 10000); // garante que a seção anterior reconciliou
  derrubarAckM = 2;
  await garantirPincel(pgM);
  const nEmAntes = nevoaEmitidos;
  await desenhar(pgM, [[0.15, 0.75], [0.22, 0.75], [0.22, 0.82]]);
  // o broadcast mesa:vtt prova que o servidor aplicou a operação
  await pgM.waitForFunction((n) => {
    const txt = document.querySelector(".vtt-nevoa-controles .meta")?.textContent ?? "";
    return txt.includes("desativada") ? n === 0 : Number(txt.match(/ativa \((\d+)/)?.[1]) === n;
  }, nAntesHold + 1, { timeout: 10000 });
  const nHttpOp = ((await vttStateHttp({ camp: campId, id: sidA, cookie: cookieMestre }))?.nevoa?.revelados ?? []).length;
  t("op c/ ACK perdido: servidor aplicou exatamente uma vez",
    nHttpOp === nAntesHold + 1, `antes=${nAntesHold} depois=${nHttpOp}`);
  // timeout (~5s) → estado incerto → sync automática tem o ACK dropado:
  // a janela de bloqueio fica aberta até o timeout da sync (8s)
  await pgM.getByRole("button", { name: /sincronizar n/i }).waitFor({ timeout: 45000 });
  const desfezBloq = await pgM.getByRole("button", { name: "Desfazer traço" }).isEnabled();
  const ocultarBloq = await pgM.getByRole("button", { name: "Ocultar tudo" }).isEnabled();
  await desenhar(pgM, [[0.3, 0.3], [0.36, 0.36]]);
  await pgM.waitForTimeout(400);
  t("incerto: mutações bloqueadas e 2º desenho não emitido",
    desfezBloq === false && ocultarBloq === false && nevoaEmitidos === nEmAntes + 1,
    `desfazer=${desfezBloq} ocultar=${ocultarBloq} emitidos=${nevoaEmitidos - nEmAntes}`);
  // G4: broadcast de OUTRA mutação (mestre mobile oculta tudo) atualiza
  // a visão mas NÃO libera o estado incerto — só a sync ordenada libera
  await pgM2.getByRole("button", { name: "Ocultar tudo" }).click();
  await pgM.waitForFunction(
    () => /ativa \(0 traços\)/.test(document.querySelector(".vtt-nevoa-controles .meta")?.textContent ?? ""),
    null, { timeout: 10000 });
  const aindaIncerto = await pgM.getByRole("button", { name: /sincronizar n/i }).count();
  const desfezAposBroadcast = await pgM.getByRole("button", { name: "Desfazer traço" }).isEnabled();
  t("broadcast alheio atualiza visão mas não libera estado incerto",
    aindaIncerto > 0 && desfezAposBroadcast === false, `syncBtn=${aindaIncerto} desfazer=${desfezAposBroadcast}`);
  // retry explícito: novo pedido de sincronização ordenada — o ACK
  // passa agora e devolve o estado autoritativo pós-todas-as-operações
  // (0 traços, pois o ocultarTudo do pgM2 já foi aplicado antes)
  await pgM.getByRole("button", { name: /sincronizar n/i }).click();
  await esperarSemIncerto(pgM, 20000);
  const nAposSync = ((await vttStateHttp({ camp: campId, id: sidA, cookie: cookieMestre }))?.nevoa?.revelados ?? []).length;
  t("sync ordenada liberou com estado autoritativo (pós-operações)",
    nAposSync === 0 && (await nTracos(pgM)) === 0,
    `http=${nAposSync} ui=${await nTracos(pgM)}`);

  sec("Operação NÃO recebida — emit retido nunca é entregue; sync retorna estado atual");
  // G2: o emit é retido no transporte e NUNCA entregue (equivalente ao
  // volatile.emit descartado numa desconexão). A sync ordenada devolve
  // o estado atual do servidor — sem a operação — e libera as ações.
  const nAntesOff2 = ((await vttStateHttp({ camp: campId, id: sidA, cookie: cookieMestre }))?.nevoa?.revelados ?? []).length;
  segurarNevoa = true;
  derrubarAckM = 1; // perde o ACK da sync automática (a op retida nunca é respondida)
  await garantirPincel(pgM);
  await desenhar(pgM, [[0.6, 0.6], [0.66, 0.6], [0.66, 0.66]]);
  await pgM.getByRole("button", { name: /sincronizar n/i }).waitFor({ timeout: 45000 });
  const desfezOff2 = await pgM.getByRole("button", { name: "Desfazer traço" }).isEnabled();
  const nEm2 = nevoaEmitidos;
  await desenhar(pgM, [[0.1, 0.1], [0.16, 0.16]]);
  await pgM.waitForTimeout(400);
  t("não recebida: incerto bloqueia e nada mais é emitido",
    desfezOff2 === false && nevoaEmitidos === nEm2,
    `desfazer=${desfezOff2} emitidos=${nevoaEmitidos - nEm2}`);
  // retry explícito: a sync ordenada devolve o estado atual — sem a
  // operação retida — e libera as ações
  await pgM.getByRole("button", { name: /sincronizar n/i }).click();
  await esperarSemIncerto(pgM, 20000);
  const nAposOff2 = ((await vttStateHttp({ camp: campId, id: sidA, cookie: cookieMestre }))?.nevoa?.revelados ?? []).length;
  t("não recebida: sync devolveu estado sem a operação e liberou",
    nAposOff2 === nAntesOff2 && (await nTracos(pgM)) === nAntesOff2,
    `antes=${nAntesOff2} depois=${nAposOff2} ui=${await nTracos(pgM)}`);
  // a operação retida é descartada — NUNCA é entregue depois da sync
  descartarNevoa();
  await pgM.waitForTimeout(800);
  const nFinalOff2 = ((await vttStateHttp({ camp: campId, id: sidA, cookie: cookieMestre }))?.nevoa?.revelados ?? []).length;
  t("operação retida descartada: nenhuma mutação tardia após a sync",
    nFinalOff2 === nAntesOff2, `depois=${nFinalOff2}`);

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
  // redimensionar o JOGADOR também (seu próprio ResizeObserver re-renderiza)
  await pgJ.setViewportSize({ width: 1600, height: 900 });
  await pgJ.waitForTimeout(400);
  // pontos reais do estado persistido: dentro de um traço revelado deve
  // continuar transparente; fora de qualquer traço deve continuar opaco.
  // Verificação por PIXEL do canvas, não por existência do elemento.
  const vttResize = await vttStateHttp({ camp: campId, id: sidA, cookie: cookieMestre });
  const trRev = (vttResize?.nevoa?.revelados ?? [])[0];
  const candEsc = [[0.97, 0.03], [0.03, 0.97], [0.97, 0.5], [0.5, 0.03], [0.5, 0.5]];
  const ptEsc = candEsc.find(([x, y]) => !visivelMapa(vttResize, x, y)) ?? null;
  const dimJ = await pgJ.locator(".vtt-nevoa-canvas").evaluate((cv) => ({ w: cv.width, cw: cv.clientWidth, dpr: window.devicePixelRatio }));
  const okDimJ = Math.abs(dimJ.w - Math.round(dimJ.cw * dimJ.dpr)) <= 1;
  let okPxJ = trRev ? true : false, detJ = "";
  if (trRev) {
    const [rx, ry] = [trRev.pontos[0].x, trRev.pontos[0].y];
    const pRev = await esperarPixel(pgJ, rx, ry, ehTransparente, 5000);
    detJ += `rev=${JSON.stringify(pRev)} `;
    okPxJ = okPxJ && ehTransparente(pRev);
    if (ptEsc) {
      const pEsc = await esperarPixel(pgJ, ptEsc[0], ptEsc[1], ehEscuroOpaco, 5000);
      detJ += `esc=${JSON.stringify(pEsc)}`;
      okPxJ = okPxJ && ehEscuroOpaco(pEsc);
    }
  }
  t("resize: jogador — revelado transparente / oculto opaco / canvas=CSS×DPR",
    okDimJ && okPxJ, JSON.stringify({ dimJ, detJ, ptEsc }));
  await pgJ.setViewportSize({ width: 1920, height: 1080 });
  await pgM.setViewportSize({ width: 1920, height: 1080 });
  await pgE.setViewportSize({ width: 844, height: 390 }); // "paisagem" mobile
  await pgE.waitForTimeout(400);
  const dimE = await pgE.locator(".vtt-nevoa-canvas").evaluate((cv) => ({ w: cv.width, cw: cv.clientWidth, ch: cv.clientHeight }));
  t("rotação mobile: canvas acompanha novo aspecto", dimE.w > 0 && Math.abs(dimE.w - Math.round(dimE.cw * 2)) <= 1, JSON.stringify(dimE));
  // espectador redimensionado: mesma prova por pixel
  if (trRev && ptEsc) {
    const [rx, ry] = [trRev.pontos[0].x, trRev.pontos[0].y];
    const pRevE = await esperarPixel(pgE, rx, ry, ehTransparente, 5000);
    const pEscE = await esperarPixel(pgE, ptEsc[0], ptEsc[1], ehEscuroOpaco, 5000);
    t("resize: espectador — revelado transparente / oculto opaco",
      ehTransparente(pRevE) && ehEscuroOpaco(pEscE), `rev=${pRevE} esc=${pEscE}`);
  }
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

  sec("Reconexão sem reload — sala volta a funcionar");
  // estado determinístico: névoa desativada (tudo visível) antes da queda
  await pgM.getByRole("button", { name: "Revelar tudo" }).click();
  await pgM.waitForFunction(
    () => /desativada/.test(document.querySelector(".vtt-nevoa-controles .meta")?.textContent ?? ""),
    null, { timeout: 8000 });
  // queda real: todos os sockets morrem; os clientes reconectam e
  // re-entrar sozinhos, sem reload — provado por eventos reais depois
  await reiniciarServidor();
  // espera o mestre re-entrar (controles liberados) e manda ocultar tudo:
  // o pixel do jogador só fica opaco se ELE também re-entrar na sala
  await pgM.waitForFunction(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /ocultar tudo/i.test(x.textContent ?? ""));
    return b ? !b.disabled : false;
  }, null, { timeout: 60000 });
  // o socket pode ainda estar na janela de reconexão: tenta até o meta
  // confirmar a mutação autoritativa
  for (let i = 0; i < 4; i++) {
    await pgM.getByRole("button", { name: "Ocultar tudo" }).click();
    const ok = await pgM.waitForFunction(
      () => /ativa \(0 traços\)/.test(document.querySelector(".vtt-nevoa-controles .meta")?.textContent ?? ""),
      null, { timeout: 8000 }).then(() => true).catch(() => false);
    if (ok) break;
  }
  const pxJOpaque = await esperarPixel(pgJ, 0.5, 0.5, ehEscuroOpaco, 60000);
  // chat volta a fluir na sala re-entrada
  await pgJ.locator(".chat-form").getByRole("textbox").fill("ping-reconexao");
  await pgJ.locator(".chat-form button").click();
  await pgM.getByText("ping-reconexao").waitFor({ timeout: 10000 }).catch(() => null);
  const chatOk = await pgM.getByText("ping-reconexao").count();
  t("reconexão sem reload: névoa autoritativa e chat voltam",
    ehEscuroOpaco(pxJOpaque) && chatOk > 0, `px=${pxJOpaque} chat=${chatOk}`);
  // mestre revela tudo → o mesmo ponto fica transparente no jogador
  await pgM.getByRole("button", { name: "Revelar tudo" }).click();
  const pxJTransp = await esperarPixel(pgJ, 0.5, 0.5, ehTransparente, 15000);
  t("reconexão sem reload: propagação de névoa segue funcionando", ehTransparente(pxJTransp), JSON.stringify(pxJTransp));

  sec("Página aberta com servidor fora + rejeição por membership");
  const ctxX = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const pgX = await ctxX.newPage();
  vigiar(pgX, "j2-offline");
  // ACK drop controlado + contagem de mesa:entrar (prova de reentrada
  // mesmo quando o ACK da tentativa anterior nunca chegou)
  let derrubarAckX = 0, entrarCountX = 0;
  await pgX.routeWebSocket(/\/socket\.io/, (ws) => {
    const srv = ws.connectToServer();
    ws.onMessage((msg) => {
      if (typeof msg === "string" && msg.includes('"mesa:entrar"')) entrarCountX++;
      srv.send(msg);
    });
    srv.onMessage((m) => {
      if (derrubarAckX > 0 && typeof m === "string" && m.startsWith("43")) { derrubarAckX--; return; }
      ws.send(m);
    });
  });
  // a primeira entrada pode ir por polling (antes do upgrade p/ WS):
  // conta os POSTs de socket.io também
  await pgX.route("**/socket.io/**", async (route) => {
    const corpo = route.request().postData() ?? "";
    if (route.request().method() === "POST" && corpo.includes('"mesa:entrar"')) entrarCountX++;
    await route.continue();
  });
  await login(pgX, "nv_j2", "senha-jogador-123");
  await irMesa(pgX);
  // a lista precisa estar carregada ANTES da queda — senão o fetch de
  // sessões morre com o servidor e não há linha para clicar
  await pgX.locator("tr.clicavel", { hasText: "Mesa Névoa Alfa" }).first().waitFor({ timeout: 15000 });
  // derruba o servidor ANTES de abrir a sessão: pgX monta a tela com o
  // socket morto — a entrada só pode ocorrer quando o connect acontecer
  await encerrarServidor(proc);
  await abrirSessao(pgX, "Mesa Névoa Alfa");
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", () => {});
  await esperarSaudavel(BASE, proc);
  await pgX.locator(".vtt-tabuleiro").waitFor({ timeout: 30000 });
  await pgX.locator(".vtt-token").first().waitFor({ timeout: 15000 });
  t("socket desconectado ao abrir: entrada acontece no connect", true);
  // G5: o servidor PROCESSA mesa:entrar e junta o socket à sala, mas o
  // ACK se perde. A trava de entrada não pode ficar presa: nas
  // reconexões seguintes novas entradas precisam ocorrer — provado
  // FUNCIONALMENTE: pgX só recebe a mensagem se estiver de volta à sala.
  derrubarAckX = 1;
  await reiniciarServidor();
  await reiniciarServidor();
  // mestre re-entra e manda mensagem; jogador removido? ainda ativo
  await pgM.waitForTimeout(3000);
  for (let i = 0; i < 4; i++) {
    await pgM.locator(".chat-form").getByRole("textbox").fill("ping-ack-perdido");
    await pgM.locator(".chat-form button").click();
    const ok = await pgX.getByText("ping-ack-perdido").waitFor({ timeout: 20000 }).then(() => true).catch(() => false);
    if (ok) break;
  }
  const recebeuAck = await pgX.getByText("ping-ack-perdido").count();
  t("ACK de entrada perdido: reconexão re-entra e sala funciona sem reload",
    recebeuAck > 0, `mensagens=${recebeuAck} entrarCount=${entrarCountX}`);
  // remove o vínculo de nv_j2 e derruba de novo: na reconexão o
  // mesa:entrar é rejeitado — sem reutilizar estado antigo
  const dbRem = abrirDb(BANCO);
  dbRem.prepare("update memberships set status='removido', updated_at=? where campaign_id=? and user_id=?")
    .run(Date.now(), campId, c.jogadores.jogador2.id);
  dbRem.close();
  await reiniciarServidor();
  await pgX.getByText(/não foi possível entrar/i).waitFor({ timeout: 30000 });
  // isolada da sala: mensagem posterior do mestre não chega ao removido
  await pgM.waitForTimeout(3000); // mestre re-entra também
  await pgM.locator(".chat-form").getByRole("textbox").fill("ping-removido");
  await pgM.locator(".chat-form button").click();
  await pgX.waitForTimeout(3000);
  const vazouRemovido = await pgX.getByText("ping-removido").count();
  t("membership removida na reconexão: rejeição + sala isolada",
    vazouRemovido === 0, `vazou=${vazouRemovido}`);
  const dbRem2 = abrirDb(BANCO);
  dbRem2.prepare("update memberships set status='ativo', updated_at=? where campaign_id=? and user_id=?")
    .run(Date.now(), campId, c.jogadores.jogador2.id);
  dbRem2.close();
  await ctxX.close();

  sec("Reconexão após troca de papel (jogador → espectador)");
  // névoa volta a cobrir tudo: jogador vê só o próprio token, espectador nenhum
  for (let i = 0; i < 4; i++) {
    await pgM.getByRole("button", { name: "Ocultar tudo" }).click();
    const ok = await pgM.waitForFunction(
      () => /ativa \(0 traços\)/.test(document.querySelector(".vtt-nevoa-controles .meta")?.textContent ?? ""),
      null, { timeout: 8000 }).then(() => true).catch(() => false);
    if (ok) break;
  }
  const dbRole = abrirDb(BANCO);
  dbRole.prepare("update memberships set role='espectador', updated_at=? where campaign_id=? and user_id=?")
    .run(Date.now(), campId, c.jogadores.jogador1.id);
  dbRole.close();
  const entrarAntesRole = entrarCountJ;
  await reiniciarServidor();
  // rebaixado: nenhum token visível (o próprio "Ana" some)
  await pgJ.waitForFunction(() => document.querySelectorAll(".vtt-token").length === 0, null, { timeout: 30000 }).catch(() => {});
  const titulosRebaixado = await pgJ.locator(".vtt-token").evaluateAll((els) => els.map((e) => e.title));
  t("rebaixado p/ espectador na reconexão: visão filtrada aplicada", titulosRebaixado.length === 0, titulosRebaixado.join(","));
  // restaura o papel e reconecta: a visão de jogador volta
  const dbRole2 = abrirDb(BANCO);
  dbRole2.prepare("update memberships set role='jogador', updated_at=? where campaign_id=? and user_id=?")
    .run(Date.now(), campId, c.jogadores.jogador1.id);
  dbRole2.close();
  await reiniciarServidor();
  await pgJ.waitForFunction(() => document.querySelectorAll(".vtt-token").length === 1, null, { timeout: 30000 }).catch(() => {});
  const titulosRestaurado = await pgJ.locator(".vtt-token").evaluateAll((els) => els.map((e) => e.title));
  t("papel restaurado na reconexão: jogador volta a ver o próprio token",
    titulosRestaurado.includes("Ana"), titulosRestaurado.join(","));
  // 2 reconexões = exatamente 2 mesa:entrar — nenhum listener duplicado.
  // a contagem passa pelo routeWebSocket (assíncrona): espera limitada
  // pelo 2º entrar antes de aferir — delta>2 continua reprovando na hora
  for (let i = 0; i < 100 && entrarCountJ - entrarAntesRole < 2; i++) await new Promise((r) => setTimeout(r, 100));
  t("sem listeners duplicados: 1 mesa:entrar por connect",
    entrarCountJ - entrarAntesRole === 2, `delta=${entrarCountJ - entrarAntesRole}`);

  sec("Interface acompanha o papel atual — controles admin por papel");
  // troca SIMULTÂNEA: mestre→jogador e jogador→mestre numa única
  // reconexão — a UI deve refletir o papel retornado pelo servidor,
  // não a prop inicial
  const dbPapel = abrirDb(BANCO);
  const idMestre = dbPapel.prepare("select id from users where username='mestre_teste'").get()?.id;
  dbPapel.prepare("update memberships set role='jogador', updated_at=? where campaign_id=? and user_id=?")
    .run(Date.now(), campId, idMestre);
  dbPapel.prepare("update memberships set role='mestre', updated_at=? where campaign_id=? and user_id=?")
    .run(Date.now(), campId, c.jogadores.jogador1.id);
  dbPapel.close();
  await reiniciarServidor();
  // rebaixado perde TODOS os controles administrativos
  await pgM.waitForFunction(() => document.querySelectorAll(".vtt-nevoa-controles").length === 0
    && ![...document.querySelectorAll("button")].some((b) => /encerrar/i.test(b.textContent ?? "")),
    null, { timeout: 45000 }).catch(() => {});
  const ctrlMestre = await pgM.locator(".vtt-nevoa-controles").count()
    + await pgM.getByRole("button", { name: "Encerrar" }).count();
  t("mestre→jogador na reconexão: controles administrativos somem",
    ctrlMestre === 0, `controles=${ctrlMestre}`);
  // promovido ganha os controles — inclusive o pincel de névoa
  await pgJ.waitForFunction(() => document.querySelectorAll(".vtt-nevoa-controles").length > 0,
    null, { timeout: 45000 }).catch(() => {});
  const pincelJ = await pgJ.getByRole("button", { name: /pincel de névoa/i }).count();
  const encerrarJ = await pgJ.getByRole("button", { name: "Encerrar" }).count();
  t("jogador→mestre na reconexão: controles administrativos aparecem",
    pincelJ > 0 && encerrarJ > 0, `pincel=${pincelJ} encerrar=${encerrarJ}`);
  // mutação que exigiria mestre continua rejeitada para o rebaixado:
  // o backend é a autoridade — a UI só reflete
  const dbPapel2 = abrirDb(BANCO);
  dbPapel2.prepare("update memberships set role='mestre', updated_at=? where campaign_id=? and user_id=?")
    .run(Date.now(), campId, idMestre);
  dbPapel2.prepare("update memberships set role='jogador', updated_at=? where campaign_id=? and user_id=?")
    .run(Date.now(), campId, c.jogadores.jogador1.id);
  dbPapel2.close();
  await reiniciarServidor();
  await pgM.waitForFunction(() => document.querySelectorAll(".vtt-nevoa-controles").length > 0,
    null, { timeout: 45000 }).catch(() => {});
  const pincelM = await pgM.getByRole("button", { name: /pincel de névoa/i }).count();
  t("papéis restaurados: mestre recupera controles após reconexão",
    pincelM > 0, `pincel=${pincelM}`);

  sec("Papel e permissões em tempo real — MESMA conexão Socket.IO");
  // prova principal da PR: alterações via API REST real (PATCH/DELETE de
  // membership) refletem na UI sem reload, sem reconexão e sem novo
  // mesa:entrar — wsCountJ/entrarCountJ permanecem congelados.
  const wsAntesRT = wsCountJ, entrarAntesRT = entrarCountJ, cargasAntesRT = cargasJ;
  const midJ1 = c.jogadores.jogador1.membershipId;
  const dbEsp = abrirDb(BANCO);
  const midEsp = dbEsp.prepare("select id from memberships where campaign_id=? and user_id=?").get(campId, espId)?.id;
  dbEsp.close();
  t("membershipId do espectador localizado", !!midEsp);

  // 1) jogador → mestre: controles admin e visão completa aparecem ao vivo
  let rRT = await req(BASE, "PATCH", `/campaigns/${campId}/members/${midJ1}`, { cookie: cookieMestre, body: { role: "mestre" } });
  t("PATCH jogador→mestre aceito", rRT.status === 200);
  await pgJ.waitForFunction(() => document.querySelectorAll(".vtt-nevoa-controles").length > 0
    && [...document.querySelectorAll("button")].some((b) => /encerrar/i.test(b.textContent ?? "")),
    null, { timeout: 20000 }).catch(() => {});
  const ctrlAposPromo = await pgJ.locator(".vtt-nevoa-controles").count()
    + await pgJ.getByRole("button", { name: "Encerrar" }).count();
  t("promoção ao vivo: controles administrativos aparecem sem reload", ctrlAposPromo > 0, `controles=${ctrlAposPromo}`);
  // visão completa = mesmos tokens que o mestre vê
  await pgJ.waitForFunction((n) => document.querySelectorAll(".vtt-token").length === n,
    await pgM.locator(".vtt-token").count(), { timeout: 20000 }).catch(() => {});
  const [nTokJ, nTokM] = [await pgJ.locator(".vtt-token").count(), await pgM.locator(".vtt-token").count()];
  t("promoção ao vivo: visão VTT completa (mesma contagem do mestre)", nTokJ === nTokM && nTokM > 0, `jogador=${nTokJ} mestre=${nTokM}`);

  // 2) mestre → jogador: controles somem e visão volta a ser filtrada
  rRT = await req(BASE, "PATCH", `/campaigns/${campId}/members/${midJ1}`, { cookie: cookieMestre, body: { role: "jogador" } });
  t("PATCH mestre→jogador aceito", rRT.status === 200);
  await pgJ.waitForFunction(() => document.querySelectorAll(".vtt-nevoa-controles").length === 0
    && ![...document.querySelectorAll("button")].some((b) => /encerrar/i.test(b.textContent ?? "")),
    null, { timeout: 20000 }).catch(() => {});
  const ctrlAposRebaixa = await pgJ.locator(".vtt-nevoa-controles").count()
    + await pgJ.getByRole("button", { name: "Encerrar" }).count();
  t("rebaixamento ao vivo: controles administrativos somem sem reload", ctrlAposRebaixa === 0, `controles=${ctrlAposRebaixa}`);
  // visão filtrada = contagem devolvida pela API para o papel atual
  const vttJ = await vttStateHttp({ camp: campId, id: sidA, cookie: c.jogadores.jogador1.cookie });
  const nEspJ = (vttJ?.tokens ?? []).length;
  await pgJ.waitForFunction((n) => document.querySelectorAll(".vtt-token").length === n, nEspJ, { timeout: 20000 }).catch(() => {});
  const nTokJ2 = await pgJ.locator(".vtt-token").count();
  t("rebaixamento ao vivo: visão VTT filtrada conforme papel atual",
    nTokJ2 === nEspJ && nTokJ2 < nTokM, `ui=${nTokJ2} esperado=${nEspJ} mestre=${nTokM}`);

  // 3) permissão individual enviarMensagens no espectador conectado (pgE)
  const tinhaFormAntes = await pgE.locator(".chat-form").count();
  rRT = await req(BASE, "PATCH", `/campaigns/${campId}/members/${midEsp}`, { cookie: cookieMestre, body: { permissions: { enviarMensagens: true } } });
  t("PATCH permissões espectador", rRT.status === 200);
  await pgE.waitForFunction(() => document.querySelectorAll(".chat-form").length > 0, null, { timeout: 20000 }).catch(() => {});
  t("enviarMensagens=true ao vivo: formulário de chat aparece", (await pgE.locator(".chat-form").count()) > 0 && tinhaFormAntes === 0);
  rRT = await req(BASE, "PATCH", `/campaigns/${campId}/members/${midEsp}`, { cookie: cookieMestre, body: { permissions: { enviarMensagens: false } } });
  t("PATCH enviarMensagens=false", rRT.status === 200);
  await pgE.waitForFunction(() => document.querySelectorAll(".chat-form").length === 0, null, { timeout: 20000 }).catch(() => {});
  t("enviarMensagens=false ao vivo: formulário de chat some", (await pgE.locator(".chat-form").count()) === 0);

  // mudanças de papel/permissão NÃO podem gerar novo WS nem novo entrar:
  // a prova de "mesma conexão" vale para toda a seção até aqui.
  // tolerância: no máximo 1 reconexão de transporte (engine.io ping
  // timeout ambiental sob proxy WS do Playwright); reload da página
  // continua terminantemente proibido (zeraria o estado React).
  t("papel/permissões ao vivo: sem reload, ≤1 reconexão de transporte, 0 mesa:entrar extra",
    cargasJ === cargasAntesRT
      && wsCountJ - wsAntesRT <= 1 && entrarCountJ - entrarAntesRT <= 1,
    `cargas ${cargasAntesRT}→${cargasJ} ws ${wsAntesRT}→${wsCountJ} entrar ${entrarAntesRT}→${entrarCountJ}`);

  sec("Personagens acompanham o papel — lista filtrada sem reload");
  // Personagem do jogador1 criado DEPOIS da carga inicial da página:
  // a lista só pode se tornar visível via recarga disparada por mudança
  // de papel — exatamente o caminho corrigido.
  const pj1Id = c.novoPersonagem(c.jogadores.jogador1.membershipId, "Heroina J1");
  const charMestreId = c.personagemMestre;
  // socket do mestre titular para produzir testes públicos decididos
  // na sessão atual (sidA), um por personagem
  const tokP = decodeURIComponent(cookieMestre.split("=")[1]);
  const sP = ioClient(BASE, {
    path: "/socket.io", transports: ["websocket"], reconnection: false,
    extraHeaders: { cookie: `mestre_rpg_session=${encodeURIComponent(tokP)}` },
  });
  await new Promise((res, rej) => { sP.on("connect", res); sP.on("connect_error", rej); });
  const emitirP = (ev, p) => new Promise((r) => {
    const to = setTimeout(() => r({ ok: false, erro: "timeout" }), 8000);
    sP.emit(ev, p, (x) => { clearTimeout(to); r(x); });
  });
  sP.emit("entrar-campanha", campId, () => undefined);
  await emitirP("mesa:entrar", { sessionId: sidA });
  const mkTestePublico = async (charId, rotulo) => {
    const ped = await emitirP("mesa:teste:pedir", {
      sessionId: sidA, characterId: charId, rotulo,
      dadosCount: 1, dadosLados: 20, visibilidade: "publica",
      requestId: crypto.randomUUID(),
    });
    if (!ped?.ok || !ped?.id) return null;
    await emitirP("mesa:teste:rolar", { testId: ped.id });
    await emitirP("mesa:teste:decidir", { testId: ped.id, outcome: "sucesso" });
    return ped.id;
  };
  const tMestreP = await mkTestePublico(charMestreId, "PERS-MESTRE-1");
  const tJ1P = await mkTestePublico(pj1Id, "PERS-J1-1");
  t("testes públicos decididos produzidos (mestre + j1)", !!tMestreP && !!tJ1P);
  // conta GETs de personagens na página do jogador a partir daqui
  let charsReqJ = 0;
  pgJ.on("request", (rq) => {
    if (rq.method() === "GET" && /\/characters(\?|$)/.test(rq.url())) charsReqJ++;
  });
  const esperarCharsReq = async (n) => {
    for (let i = 0; i < 100 && charsReqJ < n; i++) await new Promise((r) => setTimeout(r, 100));
  };
  // nomes renderizados na 1ª coluna das decisões recentes, na ordem
  const nomesDecisoes = () => pgJ.locator("section.cartao", { has: pgJ.locator("h3", { hasText: "Decisões recentes" }) }).locator(".tabela tbody tr td:first-child").allInnerTexts();
  await new Promise((r) => setTimeout(r, 1200)); // eventos mesa:teste/decisao assentaram
  // baseline: lista do jogador ainda vazia (personagem criado pós-carga)
  let nomes = await nomesDecisoes();
  t("baseline jogador sem lista: ambos os testes resolvem '?’",
    nomes.length >= 2 && nomes.every((n) => n.trim() === "?"), JSON.stringify(nomes));

  // 1) jogador → mestre: a lista passa a conter TODOS os personagens
  rRT = await req(BASE, "PATCH", `/campaigns/${campId}/members/${midJ1}`, { cookie: cookieMestre, body: { role: "mestre" } });
  t("PATCH jogador→mestre (personagens)", rRT.status === 200);
  await pgJ.waitForFunction(() => document.querySelectorAll(".vtt-nevoa-controles").length > 0,
    null, { timeout: 30000 }).catch(() => {});
  await pgJ.getByRole("button", { name: "+ Teste" }).first().click().catch(() => {});
  await esperarCharsReq(charsReqJ + 1);
  const opcoesMestre = await pgJ.locator("section.cartao", { has: pgJ.locator("h3", { hasText: "Solicitar teste" }) }).locator("option").allInnerTexts();
  t("promoção: select de personagem lista TODOS os personagens",
    opcoesMestre.some((o) => o.includes("Mestre Herói")) && opcoesMestre.some((o) => o.includes("Heroina J1")),
    JSON.stringify(opcoesMestre));
  await new Promise((r) => setTimeout(r, 800));
  nomes = await nomesDecisoes();
  t("promoção: decisões resolvem nomes de todos os personagens",
    nomes.includes("Mestre Herói") && nomes.includes("Heroina J1"), JSON.stringify(nomes));

  // 2) mestre → jogador: personagens alheios saem da lista na hora
  const charsAntesRebaixa = charsReqJ;
  rRT = await req(BASE, "PATCH", `/campaigns/${campId}/members/${midJ1}`, { cookie: cookieMestre, body: { role: "jogador" } });
  t("PATCH mestre→jogador (personagens)", rRT.status === 200);
  await pgJ.waitForFunction(() => document.querySelectorAll(".vtt-nevoa-controles").length === 0,
    null, { timeout: 30000 }).catch(() => {});
  await esperarCharsReq(charsAntesRebaixa + 1);
  await new Promise((r) => setTimeout(r, 800));
  nomes = await nomesDecisoes();
  t("rebaixamento: personagem alheio volta a '?' e o próprio resolve",
    nomes.includes("?") && nomes.includes("Heroina J1") && !nomes.includes("Mestre Herói"),
    JSON.stringify(nomes));

  // 3) jogador → espectador: lista esvaziada SEM consultar o endpoint
  const charsAntesEsp = charsReqJ;
  rRT = await req(BASE, "PATCH", `/campaigns/${campId}/members/${midJ1}`, { cookie: cookieMestre, body: { role: "espectador" } });
  t("PATCH jogador→espectador (personagens)", rRT.status === 200);
  await new Promise((r) => setTimeout(r, 2000)); // janela suficiente p/ um GET indevido
  t("espectador: nenhum GET /characters é disparado", charsReqJ === charsAntesEsp,
    `delta=${charsReqJ - charsAntesEsp}`);
  nomes = await nomesDecisoes();
  t("espectador: nenhum nome de personagem permanece na lista",
    !nomes.includes("Mestre Herói") && !nomes.includes("Heroina J1"), JSON.stringify(nomes));

  // 4) espectador → jogador: lista recarrega filtrada
  rRT = await req(BASE, "PATCH", `/campaigns/${campId}/members/${midJ1}`, { cookie: cookieMestre, body: { role: "jogador" } });
  t("PATCH espectador→jogador (personagens)", rRT.status === 200);
  await esperarCharsReq(charsAntesEsp + 1);
  await new Promise((r) => setTimeout(r, 800));
  nomes = await nomesDecisoes();
  t("volta a jogador: próprio personagem resolve, alheio fica '?'",
    nomes.includes("Heroina J1") && nomes.includes("?") && !nomes.includes("Mestre Herói"),
    JSON.stringify(nomes));

  // 5) mudanças rápidas: resposta HTTP da geração antiga não repovoa
  rRT = await req(BASE, "PATCH", `/campaigns/${campId}/members/${midJ1}`, { cookie: cookieMestre, body: { role: "mestre" } });
  const rRT2 = await req(BASE, "PATCH", `/campaigns/${campId}/members/${midJ1}`, { cookie: cookieMestre, body: { role: "jogador" } });
  t("PATCHs rápidos mestre→jogador aceitos", rRT.status === 200 && rRT2.status === 200);
  await new Promise((r) => setTimeout(r, 3500)); // gerações assentam
  await pgJ.waitForFunction(() => document.querySelectorAll(".vtt-nevoa-controles").length === 0,
    null, { timeout: 20000 }).catch(() => {});
  nomes = await nomesDecisoes();
  t("mudança rápida: estado final = jogador filtrado (sem lista privilegiada)",
    !nomes.includes("Mestre Herói") && (await pgJ.locator(".vtt-nevoa-controles").count()) === 0,
    JSON.stringify(nomes));
  sP.close();

  // 4) remoção da membership: revogação em tempo real na MESMA conexão
  const wsAntesRev = wsCountJ, entrarAntesRev = entrarCountJ;
  rRT = await req(BASE, "DELETE", `/campaigns/${campId}/members/${midEsp}`, { cookie: cookieMestre });
  t("DELETE membership do espectador", rRT.status === 200);
  await pgE.waitForFunction(() => /revogad/i.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
  const corpoE = await pgE.locator("body").innerText();
  t("revogação ao vivo: mensagem de acesso revogado sem reload",
    /revogad/i.test(corpoE) && (await pgE.locator(".mesa-vtt").count()) === 0,
    corpoE.slice(0, 120).replace(/\n/g, " "));
  // reativação: só um caminho de autorização novo restaura — PATCH status
  rRT = await req(BASE, "PATCH", `/campaigns/${campId}/members/${midEsp}`, { cookie: cookieMestre, body: { status: "ativo" } });
  t("PATCH reativação status=ativo", rRT.status === 200);
  await pgE.waitForFunction(() => document.querySelectorAll(".mesa-vtt").length > 0, null, { timeout: 30000 }).catch(() => {});
  t("reativação: mesa retorna via nova entrada autorizada (sem reload)",
    (await pgE.locator(".mesa-vtt").count()) > 0);

  // 5) mudanças rápidas em sequência: estado final = banco
  await req(BASE, "PATCH", `/campaigns/${campId}/members/${midJ1}`, { cookie: cookieMestre, body: { role: "espectador" } });
  await req(BASE, "PATCH", `/campaigns/${campId}/members/${midJ1}`, { cookie: cookieMestre, body: { role: "jogador" } });
  await pgJ.waitForFunction(() => document.querySelectorAll(".vtt-nevoa-controles").length === 0
    && document.querySelectorAll(".chat-form").length > 0,
    null, { timeout: 20000 }).catch(() => {});
  t("mudanças rápidas: UI converge para jogador (sem controles admin, chat visível)",
    (await pgJ.locator(".vtt-nevoa-controles").count()) === 0 && (await pgJ.locator(".chat-form").count()) > 0);

  // revogação→reativação: o ÚNICO mesa:entrar permitido é o novo caminho
  // de autorização disparado pela própria notificação de reativação —
  // na mesma conexão WS, sem reload
  t("revogação/reativação: no máximo 1 mesa:entrar (nova autorização) e conexão preservada",
    entrarCountJ - entrarAntesRev <= 1 && wsCountJ === wsAntesRev,
    `ws ${wsAntesRev}→${wsCountJ} entrar ${entrarAntesRev}→${entrarCountJ}`);

  sec("Corrida VTT — resposta obsoleta não reaplica visão privilegiada");
  // pgJ é jogador; promove a mestre → sync da geração N fica RETIDA;
  // rebaixa → geração N+1; libera a resposta antiga por último.
  // A visão privilegiada NUNCA pode reaparecer.
  const wsAntesCorrida = wsCountJ, entrarAntesCorrida = entrarCountJ;
  armarRetencaoSyncJ = true; // o próximo ACK de sync será retido
  rRT = await req(BASE, "PATCH", `/campaigns/${campId}/members/${midJ1}`, { cookie: cookieMestre, body: { role: "mestre" } });
  t("corrida: PATCH promoção", rRT.status === 200);
  // espera o emit da sync ser armado (cliente→servidor contém o evento)
  // espera o ACK da sync ser retido (polling no lado Node — a mensagem
  // viaja pelo WebSocket interceptado)
  for (let i = 0; i < 100 && ackSyncJRetido === null; i++) await new Promise((r) => setTimeout(r, 100));
  t("corrida: ACK da sync retido no transporte", ackSyncJRetido !== null);
  // enquanto retida, rebaixa — geração N+1
  rRT = await req(BASE, "PATCH", `/campaigns/${campId}/members/${midJ1}`, { cookie: cookieMestre, body: { role: "jogador" } });
  t("corrida: PATCH rebaixamento", rRT.status === 200);
  // visão segura durante a transição: ou o placeholder está visível
  // (tab=0) ou a sync da nova geração já concluiu com a visão FILTRADA.
  // Em ambos os casos a visão privilegiada (contagem do mestre) não
  // pode estar na tela — a janela é curta porque a sync N+1 responde
  // rápido (seu ACK não está retido).
  const tokPrivilegiados = await pgM.locator(".vtt-token").count();
  await pgJ.waitForFunction(() => /Permissões atualizadas/.test(document.body.innerText)
    || document.querySelectorAll(".vtt-tabuleiro").length === 0, null, { timeout: 20000 }).catch(() => {});
  const tabDurante = await pgJ.locator(".vtt-tabuleiro").count();
  const tokensDurante = await pgJ.locator(".vtt-token").count();
  t("corrida: durante rebaixamento a visão privilegiada fica oculta",
    tokensDurante < tokPrivilegiados, `tab=${tabDurante} tokens=${tokensDurante} privilegiados=${tokPrivilegiados}`);
  // libera a resposta OBSOLETA (geração N) — deve ser descartada por inteiro
  liberarAckSyncJ();
  ackSyncJRetido = null;
  // a geração N+1 sincroniza e aplica a visão filtrada de jogador
  const nTokHttpJ = async () => ((await vttStateHttp({ camp: campId, id: sidA, cookie: c.jogadores.jogador1.cookie }))?.tokens ?? []).length;
  const esperadoCorrida = await nTokHttpJ();
  await pgJ.waitForFunction((n) => document.querySelectorAll(".vtt-tabuleiro").length === 1
    && document.querySelectorAll(".vtt-token").length === n, esperadoCorrida, { timeout: 30000 }).catch(() => {});
  await pgJ.waitForFunction(() => !/Permissões atualizadas/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
  const [nTokJC, nTokMC] = [await pgJ.locator(".vtt-token").count(), await pgM.locator(".vtt-token").count()];
  t("corrida: visão final = filtrada de jogador (não a privilegiada retida)",
    nTokJC === esperadoCorrida && nTokJC < nTokMC, `jogador=${nTokJC} esperado=${esperadoCorrida} mestre=${nTokMC}`);
  const ctrlCorrida = await pgJ.locator(".vtt-nevoa-controles").count()
    + await pgJ.getByRole("button", { name: "Encerrar" }).count();
  t("corrida: controles admin NÃO retornaram após resposta obsoleta", ctrlCorrida === 0, `controles=${ctrlCorrida}`);
  t("corrida: mesma conexão (≤1 reconexão de transporte, ≤1 entrar na seção)",
    cargasJ === cargasAntesRT
      && wsCountJ - wsAntesCorrida <= 1 && entrarCountJ - entrarAntesCorrida <= 1,
    `ws ${wsAntesCorrida}→${wsCountJ} entrar ${entrarAntesCorrida}→${entrarCountJ}`);

  sec("Snapshot restaurado revoga membro ausente — UI sem reload");
  // snapshot do estado atual; edita o JSON no banco removendo j1;
  // restaura → j1 (conectado) deve ser revogado ao vivo
  const snapRT = await req(BASE, "POST", `/campaigns/${campId}/snapshots`, { cookie: cookieMestre, body: { description: "sem-j1" } });
  const snapIdRT = snapRT.json?.id;
  t("snapshot p/ revogação criado", snapRT.status === 201 && !!snapIdRT);
  const dbSnap = abrirDb(BANCO);
  const linhaSnap = dbSnap.prepare("select data from snapshots where id=?").get(snapIdRT);
  const dadosSnap = JSON.parse(linhaSnap.data);
  const j1midRT = c.jogadores.jogador1.membershipId;
  dadosSnap.memberships = (dadosSnap.memberships ?? []).filter((m) => m.userId !== c.jogadores.jogador1.id);
  // consistência referencial do pacote editado: o jogador1 passou a ter
  // personagem próprio (seção de personagens) — remover a membership sem
  // remover personagem/testes/rolagens associados geraria FK órfã no
  // restore. Limpa a cadeia characters→fields/itens/testes/rolagens/notas.
  const charsJ1 = new Set((dadosSnap.characters ?? []).filter((ch) => ch.membershipId === j1midRT).map((ch) => ch.id));
  if (charsJ1.size) {
    dadosSnap.characters = (dadosSnap.characters ?? []).filter((ch) => !charsJ1.has(ch.id));
    for (const k of ["characterFields", "inventoryEntries", "equipmentEntries"]) {
      dadosSnap[k] = (dadosSnap[k] ?? []).filter((r) => !charsJ1.has(r.characterId));
    }
    dadosSnap.tests = (dadosSnap.tests ?? []).filter((t2) => !charsJ1.has(t2.characterId));
    dadosSnap.rolls = (dadosSnap.rolls ?? []).filter((r) => !charsJ1.has(r.characterId));
    dadosSnap.notes = (dadosSnap.notes ?? []).map((n) => (charsJ1.has(n.characterId) ? { ...n, characterId: null } : n));
  }
  dbSnap.prepare("update snapshots set data=? where id=?").run(JSON.stringify(dadosSnap), snapIdRT);
  dbSnap.close();
  const wsAntesSnap = wsCountJ;
  const rRestRT = await req(BASE, "POST", `/campaigns/${campId}/snapshots/${snapIdRT}/restaurar`, { cookie: cookieMestre, body: { confirmacao: "RESTAURAR" } });
  t("restore executado", rRestRT.status === 200, JSON.stringify(rRestRT.json).slice(0, 120));
  await pgJ.waitForFunction(() => /revogad/i.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
  t("jogador revogado pelo snapshot: acesso revogado sem reload",
    /revogad/i.test(await pgJ.locator("body").innerText()) && (await pgJ.locator(".mesa-vtt").count()) === 0);
  // mestre segue operando normalmente
  await pgM.waitForFunction(() => document.querySelectorAll(".mesa-vtt").length > 0, null, { timeout: 15000 }).catch(() => {});
  t("mestre mantém a mesa após restore", (await pgM.locator(".mesa-vtt").count()) > 0);

  sec("Importação substituir revoga membro — UI sem reload");
  const expRT = await req(BASE, "GET", `/campaigns/${campId}/exportar`, { cookie: cookieMestre });
  const pacoteRT = expRT.json;
  pacoteRT.estado.memberships = (pacoteRT.estado.memberships ?? []).filter((m) => m.userId !== espId);
  const rImpRT = await req(BASE, "POST", "/campaigns/importar", {
    cookie: cookieMestre,
    body: { pacote: pacoteRT, modo: "substituir", campaignId: campId, confirmacao: "SUBSTITUIR" },
  });
  t("import substituir aceito", rImpRT.status === 200, JSON.stringify(rImpRT.json).slice(0, 140));
  await pgE.waitForFunction(() => /revogad/i.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
  t("espectador revogado pela importação: acesso revogado sem reload",
    /revogad/i.test(await pgE.locator("body").innerText()) && (await pgE.locator(".mesa-vtt").count()) === 0);

  sec("Convite reativa permissões preservadas — UI reflete estado real");
  // garante UMA membership do espectador marcada como removida com
  // enviarMensagens=true (a importação anterior pode tê-la apagado)
  const dbEspRT = abrirDb(BANCO);
  dbEspRT.prepare("delete from memberships where campaign_id=? and user_id=?").run(campId, espId);
  dbEspRT.prepare("insert into memberships (id,campaign_id,user_id,role,status,permissions,joined_at,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), campId, espId, "espectador", "removido",
      JSON.stringify({ enviarMensagens: true }), Date.now(), Date.now(), Date.now());
  dbEspRT.close();
  t("membership do espectador recriada como removida c/ permissão", true);
  const convRT = await req(BASE, "POST", `/campaigns/${campId}/invitations`, { cookie: cookieMestre, body: { role: "espectador", requiresApproval: false } });
  const codigoRT = convRT.json?.convite?.code;
  t("convite criado", convRT.status === 201 && !!codigoRT);
  const cookieEspRT = sessao(BANCO, espId);
  const rAceiteRT = await req(BASE, "POST", `/convites/${codigoRT}/aceitar`, { cookie: cookieEspRT, body: {} });
  t("convite aceito", rAceiteRT.status === 200 || rAceiteRT.status === 201, JSON.stringify(rAceiteRT.json).slice(0, 120));
  // notificação privada → re-entrada autorizada → formulário de chat
  await pgE.waitForFunction(() => document.querySelectorAll(".mesa-vtt").length > 0
    && document.querySelectorAll(".chat-form").length > 0, null, { timeout: 40000 }).catch(() => {});
  t("espectador reativado COM permissão: mesa e chat voltam sem reload",
    (await pgE.locator(".mesa-vtt").count()) > 0 && (await pgE.locator(".chat-form").count()) > 0);

  sec("Privacidade — dados privilegiados invalidados sem reconexão");
  // a seção de snapshot revogou o j1 — recria a membership como jogador
  // ativo e dispara a notificação via PATCH para o cliente reativar
  // (mesmo mecanismo de produção, sem reload)
  const dbPriv = abrirDb(BANCO);
  dbPriv.prepare("delete from memberships where campaign_id=? and user_id=?").run(campId, c.jogadores.jogador1.id);
  const midJ1b = crypto.randomUUID();
  const agoraPriv = Date.now();
  dbPriv.prepare("insert into memberships (id,campaign_id,user_id,role,status,permissions,joined_at,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
    .run(midJ1b, campId, c.jogadores.jogador1.id, "jogador", "ativo", "{}", agoraPriv, agoraPriv, agoraPriv);
  dbPriv.close();
  // PATCH para mestre: além de notificar (reativação), já coloca o j1
  // no papel que recebe conteúdo de visibilidade "mestre"
  const rReativJ = await req(BASE, "PATCH", `/campaigns/${campId}/members/${midJ1b}`, { cookie: cookieMestre, body: { role: "mestre" } });
  t("membership do j1 recriada e promovida a mestre", rReativJ.status === 200, JSON.stringify(rReativJ.json).slice(0, 100));
  await pgJ.waitForFunction(() => document.querySelectorAll(".mesa-vtt").length > 0
    && !/revogad/i.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
  t("j1 reativado como mestre sem reload (mesa visível)", (await pgJ.locator(".mesa-vtt").count()) > 0);
  await pgJ.waitForFunction(() => document.querySelectorAll(".vtt-nevoa-controles").length > 0
    || /Permissões atualizadas/.test(document.body.innerText), null, { timeout: 20000 }).catch(() => {});
  // socket Node do mestre titular para emitir a mensagem secreta
  const tokM = decodeURIComponent(cookieMestre.split("=")[1]);
  const sPriv = ioClient(BASE, {
    path: "/socket.io", transports: ["websocket"], reconnection: false,
    extraHeaders: { cookie: `mestre_rpg_session=${encodeURIComponent(tokM)}` },
  });
  await new Promise((res, rej) => { sPriv.on("connect", res); sPriv.on("connect_error", rej); });
  sPriv.emit("entrar-campanha", campId, () => undefined);
  await new Promise((r) => setTimeout(r, 200));
  sPriv.emit("mesa:entrar", { sessionId: sidA }, () => undefined);
  await new Promise((r) => setTimeout(r, 300));
  sPriv.emit("mesa:mensagem", { sessionId: sidA, content: "SEGREDO-X9", visibilidade: "secreta", clientId: crypto.randomUUID() }, () => undefined);
  await new Promise((r) => setTimeout(r, 300));
  await pgJ.waitForFunction(() => document.body.innerText.includes("SEGREDO-X9"), null, { timeout: 10000 }).catch(() => {});
  t("segredo visível no chat enquanto j1 é mestre", (await pgJ.locator("body").innerText()).includes("SEGREDO-X9"));
  // rebaixa com o ACK da sync RETIDO: o primeiro render já deve estar
  // seguro — placeholder no lugar do tabuleiro, sem tokens privilegiados
  // e sem o conteúdo secreto no DOM
  armarRetencaoSyncJ = true;
  const rRebaixaPriv = await req(BASE, "PATCH", `/campaigns/${campId}/members/${midJ1b}`, { cookie: cookieMestre, body: { role: "jogador" } });
  t("privacidade: PATCH rebaixamento mestre→jogador", rRebaixaPriv.status === 200);
  for (let i = 0; i < 100 && ackSyncJRetido === null; i++) await new Promise((r) => setTimeout(r, 100));
  t("privacidade: ACK da sync retido no transporte", ackSyncJRetido !== null);
  const corpoBloq = await pgJ.locator("body").innerText();
  const nTabBloq = await pgJ.locator(".vtt-tabuleiro").count();
  const nTokBloq = await pgJ.locator(".vtt-token").count();
  t("primeiro render seguro: tabuleiro e tokens privilegiados AUSENTES",
    nTabBloq === 0 && nTokBloq === 0, `tab=${nTabBloq} tok=${nTokBloq}`);
  t("primeiro render seguro: conteúdo secreto removido do DOM", !corpoBloq.includes("SEGREDO-X9"));
  // libera o ACK da geração atual → visão filtrada volta; o segredo
  // NÃO pode reaparecer (histórico recarregado é filtrado pelo servidor
  // e respostas HTTP de geração antiga são descartadas pelo seq)
  liberarAckSyncJ();
  ackSyncJRetido = null;
  await pgJ.waitForFunction(() => document.querySelectorAll(".vtt-tabuleiro").length === 1
    && document.querySelectorAll(".vtt-token").length > 0, null, { timeout: 20000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 400)); // recarga filtrada de histórico assentou
  const corpoPos = await pgJ.locator("body").innerText();
  t("pós-sync: visão filtrada volta e segredo NÃO retorna",
    (await pgJ.locator(".vtt-tabuleiro").count()) === 1 && !corpoPos.includes("SEGREDO-X9"));
  t("pós-sync: controles administrativos ausentes", (await pgJ.locator(".vtt-nevoa-controles").count()) === 0);
  // controle: o mestre titular continua vendo o segredo (estava autorizado)
  t("controle: mestre titular mantém o segredo", (await pgM.locator("body").innerText()).includes("SEGREDO-X9"));
  try { sPriv.close(); } catch {}

  sec("Restauração substitui ID da sessão — UI volta à lista sem abrir a nova");
  // pgJ (jogador) e pgM (mestre) estão dentro da MesaView da sidA
  const snapSub = await req(BASE, "POST", `/campaigns/${campId}/snapshots`, { cookie: cookieMestre, body: { description: "sid-trocado" } });
  const snapSubId = snapSub.json?.id;
  let novoSid = crypto.randomUUID();
  const dbSub = abrirDb(BANCO);
  const linSub = dbSub.prepare("select data from snapshots where id=?").get(snapSubId);
  // troca o ID da sessão em TODO o pacote (id da sessão + sessionId das
  // entidades filhas) — simula restauração que regenera IDs
  const dadosSub = JSON.parse(JSON.stringify(JSON.parse(linSub.data)).split(sidA).join(novoSid));
  dbSub.prepare("update snapshots set data=? where id=?").run(JSON.stringify(dadosSub), snapSubId);
  dbSub.close();
  const rSub = await req(BASE, "POST", `/campaigns/${campId}/snapshots/${snapSubId}/restaurar`, { cookie: cookieMestre, body: { confirmacao: "RESTAURAR" } });
  t("restore com ID de sessão substituído", rSub.status === 200, JSON.stringify(rSub.json).slice(0, 140));
  const listaPosSub = await req(BASE, "GET", `/campaigns/${campId}/sessoes`, { cookie: cookieMestre });
  const idsPosSub = (listaPosSub.json?.sessoes ?? []).map((s) => s.id);
  t("API: sid antigo removido e novo presente", !idsPosSub.includes(sidA) && idsPosSub.includes(novoSid), JSON.stringify(idsPosSub));
  const esperaLista = (p) => p.waitForFunction(
    () => document.querySelectorAll(".mesa-vtt").length === 0 && document.querySelectorAll(".tabela tbody tr").length > 0,
    null, { timeout: 30000 }).catch(() => {});
  await esperaLista(pgJ);
  await esperaLista(pgM);
  t("jogador: MesaView antiga desmontada e lista exibida",
    (await pgJ.locator(".mesa-vtt").count()) === 0 && (await pgJ.locator(".tabela tbody tr").count()) > 0);
  t("jogador: sessão nova NÃO aberta automaticamente", (await pgJ.locator(".mesa-vtt").count()) === 0);
  t("mestre: MesaView antiga desmontada e lista exibida",
    (await pgM.locator(".mesa-vtt").count()) === 0 && (await pgM.locator(".tabela tbody tr").count()) > 0);
  t("lista exibe a sessão substituída pelo nome", (await pgM.locator("body").innerText()).includes("Mesa Névoa Alfa"));
  // reentrada manual do mestre na sessão de ID novo
  await pgM.locator("tr.clicavel", { hasText: "Mesa Névoa Alfa" }).first().click();
  await pgM.locator(".mesa-vtt").waitFor({ timeout: 20000 }).catch(() => {});
  t("mestre re-entrou manualmente na sessão nova", (await pgM.locator(".mesa-vtt").count()) === 1);
  // controle: ID PRESERVADO — snapshot sem edição; a sessão aberta
  // continua aberta com o estado autoritativo novo
  const snapKeep = await req(BASE, "POST", `/campaigns/${campId}/snapshots`, { cookie: cookieMestre, body: { description: "id-preservado" } });
  const rKeep = await req(BASE, "POST", `/campaigns/${campId}/snapshots/${snapKeep.json?.id}/restaurar`, { cookie: cookieMestre, body: { confirmacao: "RESTAURAR" } });
  t("restore com ID preservado", rKeep.status === 200, JSON.stringify(rKeep.json).slice(0, 120));
  await new Promise((r) => setTimeout(r, 1000));
  t("ID preservado: mesa do mestre permanece aberta", (await pgM.locator(".mesa-vtt").count()) === 1);
  // jogador volta a entrar na sessão para as provas de evento atrasado
  await pgJ.locator("tr.clicavel", { hasText: "Mesa Névoa Alfa" }).first().click();
  await pgJ.locator(".mesa-vtt").waitFor({ timeout: 20000 }).catch(() => {});
  t("jogador re-entrou na sessão", (await pgJ.locator(".mesa-vtt").count()) === 1);

  sec("Pós-restauração: ID preservado recarrega TODO o estado; evento perdido é recuperado na reconexão");
  // A) ID preservado + marcador injetado no snapshot: prova que a
  // MesaView NÃO mantém dados do estado antigo — mensagens vêm do
  // servidor pós-restore (restKey força recarga completa)
  const snapPA = await req(BASE, "POST", `/campaigns/${campId}/snapshots`, { cookie: cookieMestre, body: { description: "preservado-marcador" } });
  const idPA = snapPA.json?.id;
  const dbPA = abrirDb(BANCO);
  const dadosPA = JSON.parse(dbPA.prepare("select data from snapshots where id=?").get(idPA).data);
  dadosPA.chatMessages = [...(dadosPA.chatMessages ?? []), {
    id: crypto.randomUUID(), campaignId: campId, sessionId: novoSid,
    authorId: c.adminId, kind: "texto", content: "MARCA-A-REST-1",
    visibility: "publica", recipients: null, createdAt: new Date().toISOString(),
  }];
  dbPA.prepare("update snapshots set data=? where id=?").run(JSON.stringify(dadosPA), idPA);
  dbPA.close();
  const rPA = await req(BASE, "POST", `/campaigns/${campId}/snapshots/${idPA}/restaurar`, { cookie: cookieMestre, body: { confirmacao: "RESTAURAR" } });
  t("restore A (ID preservado + marcador)", rPA.status === 200, JSON.stringify(rPA.json).slice(0, 120));
  await pgM.waitForFunction(() => document.body.innerText.includes("MARCA-A-REST-1"), null, { timeout: 30000 }).catch(() => {});
  await pgJ.waitForFunction(() => document.body.innerText.includes("MARCA-A-REST-1"), null, { timeout: 30000 }).catch(() => {});
  t("mestre: marcador do snapshot aparece sem reload (recarga completa)", (await pgM.locator("body").innerText()).includes("MARCA-A-REST-1"));
  t("jogador: marcador do snapshot aparece sem reload", (await pgJ.locator("body").innerText()).includes("MARCA-A-REST-1"));
  t("ID preservado: mesa continua aberta nos dois clientes",
    (await pgM.locator(".mesa-vtt").count()) === 1 && (await pgJ.locator(".mesa-vtt").count()) === 1);

  // B) cliente DESCONECTADO durante campanha:restaurada com ID
  // substituído: ao reconectar, mesa:entrar é rejeitado ("não
  // encontrada") e a UI volta à lista — sem reload de página
  await pgJ.context().setOffline(true);
  await new Promise((r) => setTimeout(r, 800)); // socket cai de verdade
  const sidC = crypto.randomUUID();
  const snapPB = await req(BASE, "POST", `/campaigns/${campId}/snapshots`, { cookie: cookieMestre, body: { description: "offline-troca-id" } });
  const idPB = snapPB.json?.id;
  const dbPB = abrirDb(BANCO);
  const dadosPB = JSON.parse(JSON.stringify(JSON.parse(dbPB.prepare("select data from snapshots where id=?").get(idPB).data)).split(novoSid).join(sidC));
  dbPB.prepare("update snapshots set data=? where id=?").run(JSON.stringify(dadosPB), idPB);
  dbPB.close();
  const rPB = await req(BASE, "POST", `/campaigns/${campId}/snapshots/${idPB}/restaurar`, { cookie: cookieMestre, body: { confirmacao: "RESTAURAR" } });
  t("restore B (offline, ID substituído)", rPB.status === 200, JSON.stringify(rPB.json).slice(0, 120));
  await pgJ.context().setOffline(false);
  // reconexão: socket.io reconecta → entrar() → mesa:entrar falha →
  // aoSair → lista de sessões (sem reload, sem sessão fantasma)
  await pgJ.waitForFunction(
    () => document.querySelectorAll(".mesa-vtt").length === 0 && document.querySelectorAll(".tabela tbody tr").length > 0,
    null, { timeout: 45000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 1500));
  t("jogador offline: voltou à lista após reconectar (sem reload)",
    (await pgJ.locator(".mesa-vtt").count()) === 0 && (await pgJ.locator(".tabela tbody tr").count()) > 0);
  t("jogador offline: lista exibe a sessão substituída", (await pgJ.locator("body").innerText()).includes("Mesa Névoa Alfa"));
  // mestre (online) também voltou à lista via campanha:restaurada
  await pgM.waitForFunction(
    () => document.querySelectorAll(".mesa-vtt").length === 0 && document.querySelectorAll(".tabela tbody tr").length > 0,
    null, { timeout: 30000 }).catch(() => {});
  t("mestre online: ID substituído desmontou a MesaView", (await pgM.locator(".mesa-vtt").count()) === 0);
  // reentrada manual do jogador na sessão de ID novo (sidC)
  await pgJ.locator("tr.clicavel", { hasText: "Mesa Névoa Alfa" }).first().click();
  await pgJ.locator(".mesa-vtt").waitFor({ timeout: 20000 }).catch(() => {});
  t("jogador re-entrou manualmente na sessão nova", (await pgJ.locator(".mesa-vtt").count()) === 1);
  // mestre também precisa reentrar — o restore B desmontou a MesaView dele
  await pgM.locator("tr.clicavel", { hasText: "Mesa Névoa Alfa" }).first().click();
  await pgM.locator(".mesa-vtt").waitFor({ timeout: 20000 }).catch(() => {});
  t("mestre re-entrou manualmente na sessão nova", (await pgM.locator(".mesa-vtt").count()) === 1);
  novoSid = sidC; // sessão corrente passa a ser sidC nas seções seguintes

  sec("Eventos privados atrasados — produzidos antes, entregues depois do rebaixamento");
  const dbC = abrirDb(BANCO);
  const memJ1 = dbC.prepare("select id from memberships where campaign_id=? and user_id=?").get(campId, c.jogadores.jogador1.id);
  dbC.close();
  // teste privado sobre personagem do MESTRE — j1 não é dono: após o
  // rebaixamento ele não tem nenhuma autorização para recebê-lo
  const charIdJ1 = c.personagemMestre;
  const rPromoC = await req(BASE, "PATCH", `/campaigns/${campId}/members/${memJ1.id}`, { cookie: cookieMestre, body: { role: "mestre" } });
  t("promoção do j1 para mestre", rPromoC.status === 200, JSON.stringify(rPromoC.json).slice(0, 100));
  await pgJ.waitForFunction(() => document.querySelectorAll(".vtt-nevoa-controles").length > 0, null, { timeout: 30000 }).catch(() => {});
  t("j1 vê controles de mestre", (await pgJ.locator(".vtt-nevoa-controles").count()) > 0);
  // socket do mestre titular na sessão nova
  const tokC = decodeURIComponent(cookieMestre.split("=")[1]);
  const sC = ioClient(BASE, {
    path: "/socket.io", transports: ["websocket"], reconnection: false,
    extraHeaders: { cookie: `mestre_rpg_session=${encodeURIComponent(tokC)}` },
  });
  await new Promise((res, rej) => { sC.on("connect", res); sC.on("connect_error", rej); });
  const emitirS = (ev, p) => new Promise((r) => {
    const to = setTimeout(() => r({ ok: false, erro: "timeout" }), 8000);
    sC.emit(ev, p, (x) => { clearTimeout(to); r(x); });
  });
  sC.emit("entrar-campanha", campId, () => undefined);
  await emitirS("mesa:entrar", { sessionId: novoSid });
  // arma a retenção no transporte do pgJ ANTES de produzir os eventos
  reterEvtJ = (m) => ["\"mesa:mensagem\"", "\"mesa:teste\"", "\"mesa:rolagem\"", "\"mesa:decisao\""].some((k) => m.includes(k));
  await emitirS("mesa:mensagem", { sessionId: novoSid, content: "EVT-SEGREDO-77", visibilidade: "secreta", clientId: crypto.randomUUID() });
  const rPedC = await emitirS("mesa:teste:pedir", { sessionId: novoSid, characterId: charIdJ1, rotulo: "PRIV-ROT-99", dadosCount: 1, dadosLados: 20, minimo: 13, visibilidade: "privada" });
  const testIdC = rPedC?.id;
  t("teste privado solicitado pelo mestre", rPedC?.ok === true && !!testIdC, JSON.stringify(rPedC).slice(0, 140));
  if (testIdC) {
    const rRolC = await emitirS("mesa:teste:rolar", { testId: testIdC });
    t("teste privado rolado", rRolC?.ok === true, JSON.stringify(rRolC).slice(0, 120));
    const rDecC = await emitirS("mesa:teste:decidir", { testId: testIdC, outcome: "sucesso", nota: "NOTA-PRIV-66" });
    t("teste privado decidido c/ nota", rDecC?.ok === true, JSON.stringify(rDecC).slice(0, 120));
  }
  await emitirS("mesa:rolar", { sessionId: novoSid, visibilidade: "privada", motivo: "ROLL-PRIV-55", dados: [{ sides: 20, count: 1 }] });
  // os pacotes server→client ficam retidos na fila do ws do navegador
  for (let i = 0; i < 100 && filaEvtJ.length < 5; i++) await new Promise((r) => setTimeout(r, 100));
  t("eventos privados retidos no transporte (≥5 pacotes)", filaEvtJ.length >= 5, `fila=${filaEvtJ.length}`);
  // rebaixa ANTES de liberar — os eventos chegam com papel já revogado
  const rRebaixaC = await req(BASE, "PATCH", `/campaigns/${campId}/members/${memJ1.id}`, { cookie: cookieMestre, body: { role: "jogador" } });
  t("rebaixamento do j1", rRebaixaC.status === 200);
  await esperarSemIncerto(pgJ, 30000).catch(() => {});
  await new Promise((r) => setTimeout(r, 800)); // limpeza + sync filtrada assentaram
  liberarEvtJ();
  reterEvtJ = null;
  await new Promise((r) => setTimeout(r, 1000)); // eventos atrasados entregues
  const corpoAtraso = await pgJ.locator("body").innerText();
  t("msg secreta atrasada NÃO reaparece", !corpoAtraso.includes("EVT-SEGREDO-77"));
  t("teste privado atrasado não repovoa (rótulo)", !corpoAtraso.includes("PRIV-ROT-99"));
  // o anúncio de chat da rolagem privada é endereçado aos destinatários
  // da época (j1 era mestre) — legítimo; o que não pode voltar é o
  // CARD de rolagem com dados/motivo no painel de Rolagens
  t("rolagem privada atrasada não gera card de rolagem",
    (await pgJ.locator(".rolagem-item", { hasText: "ROLL-PRIV-55" }).count()) === 0);
  t("decisão privada atrasada não vaza nota", !corpoAtraso.includes("NOTA-PRIV-66"));
  const corpoMAtraso = await pgM.locator("body").innerText();
  t("controle: mestre titular recebe o evento secreto", corpoMAtraso.includes("EVT-SEGREDO-77"));

  sec("Resposta HTTP antiga não repovoa histórico privilegiado");
  // segredo criado enquanto j1 é jogador — só mestres o recebem ao vivo
  await emitirS("mesa:mensagem", { sessionId: novoSid, content: "HTTP-SEGREDO-88", visibilidade: "secreta", clientId: crypto.randomUUID() });
  await new Promise((r) => setTimeout(r, 300));
  t("segredo HTTP invisível ao jogador antes da promoção",
    !(await pgJ.locator("body").innerText()).includes("HTTP-SEGREDO-88"));
  // promove → a recarga filtrada da NOVA geração busca /mensagens como
  // mestre e a resposta fica RETIDA antes de chegar ao JavaScript
  armarHttpJ = true;
  await req(BASE, "PATCH", `/campaigns/${campId}/members/${memJ1.id}`, { cookie: cookieMestre, body: { role: "mestre" } });
  for (let i = 0; i < 100 && !httpRetidoJ; i++) await new Promise((r) => setTimeout(r, 100));
  t("resposta HTTP de histórico retida", httpRetidoJ !== null);
  await pgJ.waitForFunction(() => document.querySelectorAll(".vtt-nevoa-controles").length > 0, null, { timeout: 30000 }).catch(() => {});
  // rebaixa ANTES de liberar a resposta antiga
  await req(BASE, "PATCH", `/campaigns/${campId}/members/${memJ1.id}`, { cookie: cookieMestre, body: { role: "jogador" } });
  await esperarSemIncerto(pgJ, 30000).catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  await liberarHttpJ();
  await new Promise((r) => setTimeout(r, 1000));
  const corpoHttp = await pgJ.locator("body").innerText();
  t("HTTP-SEGREDO-88 ausente após resposta antiga liberada", !corpoHttp.includes("HTTP-SEGREDO-88"));
  // controle positivo: nova promoção → geração nova busca e MOSTRA
  await req(BASE, "PATCH", `/campaigns/${campId}/members/${memJ1.id}`, { cookie: cookieMestre, body: { role: "mestre" } });
  await pgJ.waitForFunction(() => document.body.innerText.includes("HTTP-SEGREDO-88"), null, { timeout: 30000 }).catch(() => {});
  t("controle: geração nova mostra o segredo ao mestre", (await pgJ.locator("body").innerText()).includes("HTTP-SEGREDO-88"));
  try { sC.close(); } catch {}

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
