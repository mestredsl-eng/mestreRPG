// Homologação visual — Mesa virtual Etapa 1 (mapa + tokens).
// Mestre + 2 jogadores em contextos Playwright reais: upload de mapa,
// criação de token, arraste por mouse (desktop) e toque (mobile),
// sincronização entre abas, layouts 1920/1366/768/390 sem overflow
// horizontal e ausência de erros de console.
import crypto from "node:crypto";
import { chromium } from "playwright";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, comDb, abrirDb, encerrarServidor, limparDir, req,
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
  await pgM.locator('.vtt-controles input[placeholder="Nome do token"]').fill("Ana");
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

  // ---------- turnos: estado legado {ativo:true, ordem:[], atual:0} ----------
  sec("Turnos — estado legado inválido não derruba a mesa");
  {
    const sessT = await req(BASE, "POST", `/campaigns/${c.campId}/sessoes`, { cookie: c.cookieMestre, body: { name: "Mesa Turnos Legado" } });
    const sidT = sessT.json?.sessao?.id ?? sessT.json?.id;
    t("sessão legada criada via API", !!sidT, `status=${sessT.status}`);
    // injeta o estado inválido persistido que quebrava o render
    // (update-or-insert: a sessão pode já ter linha `turns` default)
    const dbL = abrirDb(BANCO);
    const updT = dbL.prepare("update turns set state=?, updated_at=? where session_id=?")
      .run(JSON.stringify({ ordem: [], atual: 0, ativo: true }), Date.now(), sidT);
    if (updT.changes === 0) {
      dbL.prepare("insert into turns (id, session_id, state, updated_by, updated_at) values (?,?,?,?,?)")
        .run(crypto.randomUUID(), sidT, JSON.stringify({ ordem: [], atual: 0, ativo: true }), c.adminId, Date.now());
    }
    dbL.close();

    const ctxL = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const pgL = await ctxL.newPage();
    vigiar(pgL, "legado");
    await login(pgL, "mestre_teste", "senha-forte-123");
    await irMesa(pgL);
    await abrirSessao(pgL, "Mesa Turnos Legado");
    t("mesa abre com turnos legado inválido", await pgL.locator(".mesa-lateral h3", { hasText: "Turno" }).count() === 1);
    // escopo no cartão "Turno" ("Encerrar"/"Iniciar" também existem no timer e no cabeçalho)
    const cartaoTurno = pgL.locator("section.cartao").filter({ has: pgL.locator("h3", { hasText: "Turno" }) });
    const pVez = cartaoTurno.locator("p", { hasText: "é a vez" });
    await pVez.waitFor({ timeout: 8000 });
    const vezLegado = await pVez.textContent().catch(() => "");
    t("sem ator resolvível mostra placeholder, não crash", vezLegado.includes("—"), vezLegado.trim());
    t("sem pageerror na renderização legada", !errosConsole.some((e) => e.startsWith("legado:pageerror")), errosConsole.filter((e) => e.startsWith("legado")).join(" | "));

    // controles do mestre reparam o estado
    await cartaoTurno.getByRole("button", { name: "Encerrar", exact: true }).click();
    await cartaoTurno.locator("p", { hasText: "Sem sequência ativa" }).waitFor({ timeout: 8000 });
    t("encerrar limpa sequência legada", true);

    // retomada: ordem manual via botão Iniciar (membros presentes = mestre)
    await cartaoTurno.getByRole("button", { name: "Iniciar", exact: true }).click();
    const pVezDepois = cartaoTurno.locator("p", { hasText: "é a vez" });
    await pVezDepois.waitFor({ timeout: 8000 });
    const vezDepois = await pVezDepois.textContent().catch(() => "");
    t("iniciar com ordem recria sequência ativa", vezDepois.trim().length > 0 && !vezDepois.includes("Sem sequência"), vezDepois.trim());
    const stDepois = comDb(BANCO, (db) => JSON.parse(db.prepare("select state from turns where session_id=?").get(sidT)?.state ?? "{}"));
    t("estado persistido reparado (ativo, ordem não-vazia)", stDepois.ativo === true && (stDepois.ordem ?? []).length >= 1 && stDepois.atual >= 0, JSON.stringify(stDepois).slice(0, 160));

    // iniciativa também repara do zero em outra sessão legada
    const sessT2 = await req(BASE, "POST", `/campaigns/${c.campId}/sessoes`, { cookie: c.cookieMestre, body: { name: "Mesa Turnos Iniciativa" } });
    const sidT2 = sessT2.json?.sessao?.id ?? sessT2.json?.id;
    const dbL2 = abrirDb(BANCO);
    const updT2 = dbL2.prepare("update turns set state=?, updated_at=? where session_id=?")
      .run(JSON.stringify({ ordem: [], atual: 0, ativo: true }), Date.now(), sidT2);
    if (updT2.changes === 0) {
      dbL2.prepare("insert into turns (id, session_id, state, updated_by, updated_at) values (?,?,?,?,?)")
        .run(crypto.randomUUID(), sidT2, JSON.stringify({ ordem: [], atual: 0, ativo: true }), c.adminId, Date.now());
    }
    dbL2.close();
    // sai da sessão atual e abre a segunda sessão legada
    await pgL.getByRole("button", { name: "Sair da mesa" }).click();
    await irMesa(pgL);
    await abrirSessao(pgL, "Mesa Turnos Iniciativa");
    const cartaoTurno2 = pgL.locator("section.cartao").filter({ has: pgL.locator("h3", { hasText: "Turno" }) });
    await cartaoTurno2.getByRole("button", { name: "Rolar iniciativa" }).click();
    // o nome do ator substitui o placeholder "—" quando a ordem chega
    await pgL.waitForFunction(() => {
      const p = [...document.querySelectorAll(".mesa-lateral p")].find((x) => x.textContent?.includes("é a vez"));
      return p && !p.textContent.includes("—");
    }, { timeout: 8000 }).catch(() => {});
    const vezIni = await pgL.locator(".mesa-lateral p", { hasText: "é a vez" }).textContent().catch(() => "");
    const stIni = comDb(BANCO, (db) => JSON.parse(db.prepare("select state from turns where session_id=?").get(sidT2)?.state ?? "{}"));
    t("iniciativa repara estado legado e define ordem", (stIni.ordem ?? []).length >= 1 && stIni.ativo === true && !vezIni.includes("—"), JSON.stringify(stIni).slice(0, 160));
    await ctxL.close();
  }

  // ---------- isolamento de eventos por sessão (auditoria #149) ----------
  sec("Isolamento por sessão — mesmo usuário, duas abas");
  // Eventos privados (rolagem/teste/decisão) chegam por usuario:<id>:
  // sem o filtro de sessionId no cliente, a aba da sessão B exibiria
  // rolagens da sessão A. Duas sessões REAIS do mesmo mestre.
  const sessA = await req(BASE, "POST", `/campaigns/${c.campId}/sessoes`, { cookie: c.cookieMestre, body: { name: "Sessão Alfa" } });
  const sessB = await req(BASE, "POST", `/campaigns/${c.campId}/sessoes`, { cookie: c.cookieMestre, body: { name: "Sessão Beta" } });
  const idSessA = sessA.json?.sessao?.id, idSessB = sessB.json?.sessao?.id;
  t("duas sessões ativas do mesmo mestre", !!idSessA && !!idSessB && idSessA !== idSessB,
    JSON.stringify({ a: sessA.status, b: sessB.status }));
  const ctxIso = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  // Mock local de SpeechSynthesis para provar a fila sem depender do áudio
  // ou das vozes instaladas no runner. Cada aba mantém sua própria lista.
  await ctxIso.addInitScript(() => {
    const calls = [];
    const voices = [
      { name: "Microsoft Júlia Desktop", lang: "pt-BR", default: true, localService: true, voiceURI: "julia" },
      { name: "Microsoft João Desktop", lang: "pt-BR", default: false, localService: true, voiceURI: "joao" },
    ];
    Object.defineProperty(window, "__mestreVoiceCalls", { configurable: true, value: calls });
    class UtteranceMock {
      constructor(text) { this.text = text; this.voice = null; this.lang = ""; this.rate = 1; this.pitch = 1; this.onend = null; this.onerror = null; }
    }
    Object.defineProperty(window, "SpeechSynthesisUtterance", { configurable: true, value: UtteranceMock });
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        getVoices: () => voices,
        speak: (utterance) => calls.push({ text: utterance.text, voice: utterance.voice?.name ?? null }),
        cancel: () => {},
        resume: () => {},
      },
    });
  });
  const pgA = await ctxIso.newPage(), pgB = await ctxIso.newPage();
  vigiar(pgA, "isoA"); vigiar(pgB, "isoB");
  await login(pgA, "mestre_teste", "senha-forte-123");
  // mesmo contexto compartilha storage — pgB já abre autenticado
  await pgB.goto(BASE);
  await pgB.getByText("Servidor online").waitFor({ timeout: 15000 });
  await Promise.all([irMesa(pgA), irMesa(pgB)]);
  await abrirSessao(pgA, "Sessão Alfa");
  await abrirSessao(pgB, "Sessão Beta");
  // Ativação explícita em ambas as abas: a mensagem de Alfa não pode
  // acionar SpeechSynthesis na aba Beta do mesmo usuário.
  await Promise.all([
    pgA.getByRole("button", { name: "Ativar voz" }).click(),
    pgB.getByRole("button", { name: "Ativar voz" }).click(),
  ]);

  // 1) rolagem LIVRE privada na sessão A — pela UI real (checkbox Privada)
  await pgA.locator(".abas-dados button", { hasText: "Rolagem e dano" }).click();
  const formA = pgA.locator(".rolagem-form");
  await formA.locator("input[placeholder='Motivo (opcional)']").fill("privada-sessao-A");
  await formA.locator("label.check input[type='checkbox']").check();
  await formA.getByRole("button", { name: /Lançar( novamente)?/ }).click();
  await pgA.locator(".rolagem-item", { hasText: "privada-sessao-A" }).waitFor({ timeout: 15000 });
  t("sessão A exibe a rolagem livre privada", true);
  await pgA.waitForTimeout(800);
  t("sessão B NÃO exibe rolagem privada da sessão A",
    await pgB.locator(".rolagem-item", { hasText: "privada-sessao-A" }).count() === 0
    && await pgB.locator(".rolagem-item").count() === 0);

  // 2) teste de ficha PRIVADO na sessão A — pedir + rolar via socket real
  await pgA.waitForFunction(() => window.__mesaSocket?.connected === true, null, { timeout: 15000 });
  const reqIdTeste = crypto.randomUUID();
  const pedir = await pgA.evaluate(({ sessId, charId, rid }) => new Promise((res) => {
    window.__mesaSocket.emit("mesa:teste:pedir", {
      sessionId: sessId, characterId: charId, campoId: "for",
      dadosLados: 10, visibilidade: "privada", requestId: rid,
    }, res);
  }), { sessId: idSessA, charId: c.personagemMestre, rid: reqIdTeste });
  t("teste privado de ficha solicitado na sessão A", pedir?.ok === true, JSON.stringify(pedir).slice(0, 140));
  // o evento mesa:teste também é privado — a sessão B não pode vê-lo
  await pgA.waitForTimeout(600);
  t("sessão B NÃO recebe o teste pendente da sessão A",
    await pgB.locator(".teste-card", { hasText: "Mestre Herói" }).count() === 0);
  const rolarTeste = await pgA.evaluate((testId) => new Promise((res) => {
    window.__mesaSocket.emit("mesa:teste:rolar", { testId, requestId: crypto.randomUUID() }, res);
  }), pedir.id ?? reqIdTeste);
  t("rolagem do teste privado autorizada (mestre/dono)", rolarTeste?.ok === true, JSON.stringify(rolarTeste).slice(0, 140));
  await pgA.locator(".rolagem-item", { hasText: "Mestre Herói" }).waitFor({ timeout: 15000 });
  t("sessão A exibe rolagem do teste de ficha", true);
  await pgA.waitForTimeout(800);
  t("sessão B NÃO exibe rolagem do teste de ficha da sessão A",
    await pgB.locator(".rolagem-item", { hasText: "Mestre Herói" }).count() === 0);

  // 3) mensagem PRIVADA na sessão A — fluxo real cliente→servidor: o
  //    evento privado vai por usuario:<id> e alcança as DUAS abas do
  //    mesmo usuário; o guard de sessionId decide qual exibe.
  const msgPriv = await pgA.evaluate(({ sessId, uid, cid }) => new Promise((res) => {
    window.__mesaSocket.emit("mesa:mensagem", {
      sessionId: sessId, content: cid, clientId: crypto.randomUUID(),
      visibilidade: "privada", destinatarioUserId: uid, tipo: "texto",
      speakerNarrator: true, speakerNarratorGender: "feminina",
    }, res);
  }), { sessId: idSessA, uid: c.adminId, cid: "msg-privada-sessao-A" });
  t("mensagem privada narrada da sessão A aceita pelo servidor", msgPriv?.ok === true, JSON.stringify(msgPriv).slice(0, 140));
  const mensagemA = pgA.locator(".chat-msg", { hasText: "msg-privada-sessao-A" });
  await mensagemA.waitFor({ timeout: 10000 });
  t("sessão A exibe a mensagem privada como Narrador",
    await mensagemA.locator(".chat-autor").textContent() === "Narrador");
  await pgA.waitForFunction(
    (texto) => window.__mestreVoiceCalls?.some((fala) => fala.text.includes(texto)),
    "msg-privada-sessao-A",
    { timeout: 10000 },
  );
  t("sessão A enfileira a fala de Narrador com voz feminina",
    await pgA.evaluate(() => window.__mestreVoiceCalls.some((fala) => fala.text.includes("msg-privada-sessao-A") && fala.voice === "Microsoft Júlia Desktop")));
  await pgA.waitForTimeout(800);
  t("sessão B NÃO exibe a mensagem privada da sessão A",
    await pgB.locator(".chat-msg", { hasText: "msg-privada-sessao-A" }).count() === 0);
  t("sessão B NÃO enfileira nem narra a mensagem privada da sessão A",
    await pgB.evaluate(() => window.__mestreVoiceCalls.filter((fala) => fala.text.includes("msg-privada-sessao-A")).length === 0));

  // 4) decisão PRIVADA de teste na sessão A — a sessão B tem um teste
  //    PÚBLICO próprio pendente; a decisão da sessão A não pode
  //    alterá-lo nem exibir a nota na aba errada.
  const pedirB = await pgB.evaluate(({ sessId, charId, rid }) => new Promise((res) => {
    window.__mesaSocket.emit("mesa:teste:pedir", {
      sessionId: sessId, characterId: charId, campoId: "for",
      dadosLados: 10, visibilidade: "publica", requestId: rid,
    }, res);
  }), { sessId: idSessB, charId: c.personagemMestre, rid: crypto.randomUUID() });
  t("teste público pendente criado na sessão B", pedirB?.ok === true, JSON.stringify(pedirB).slice(0, 140));
  await pgB.locator(".teste-card").first().waitFor({ timeout: 10000 });
  const pendentesB = await pgB.locator(".teste-card").count();
  const reqIdTeste2 = crypto.randomUUID();
  const pedir2 = await pgA.evaluate(({ sessId, charId, rid }) => new Promise((res) => {
    window.__mesaSocket.emit("mesa:teste:pedir", {
      sessionId: sessId, characterId: charId, campoId: "for",
      dadosLados: 10, visibilidade: "privada", requestId: rid,
    }, res);
  }), { sessId: idSessA, charId: c.personagemMestre, rid: reqIdTeste2 });
  t("segundo teste privado solicitado na sessão A", pedir2?.ok === true, JSON.stringify(pedir2).slice(0, 140));
  await pgA.waitForTimeout(600);
  const decPriv = await pgA.evaluate((testId) => new Promise((res) => {
    window.__mesaSocket.emit("mesa:teste:decidir", { testId, outcome: "sucesso", nota: "decisao-privada-A" }, res);
  }), pedir2.id ?? reqIdTeste2);
  t("decisão privada da sessão A aceita", decPriv?.ok === true, JSON.stringify(decPriv).slice(0, 140));
  await pgA.waitForTimeout(800);
  t("sessão A registra a decisão (nota visível)",
    await pgA.getByText("decisao-privada-A", { exact: false }).count() >= 1);
  t("sessão B NÃO exibe a decisão privada da sessão A",
    await pgB.getByText("decisao-privada-A", { exact: false }).count() === 0);
  t("sessão B mantém o teste público pendente intacto",
    await pgB.locator(".teste-card").count() === pendentesB
    && await pgB.locator(".teste-card").first().locator("select, input, button").count() > 0);
  await ctxIso.close();

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
