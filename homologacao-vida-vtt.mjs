// Homologação visual — vida (HP/vitalidade) nos tokens da Mesa Virtual
// (Issue #127). Playwright real, desktop 1920 e mobile 390:
//   - HP bar e badge de vitalidade renderizados por papel
//     (mestre vê todos; jogador só o próprio; espectador nenhum com a
//     flag desligada);
//   - toggle "Compartilhar vida" em Regras (mestre-only) persiste e
//     propaga ao vivo via regras:atualizadas → mesa:vtt:sincronizar;
//   - dano de HP reflete no token via personagens:atualizados;
//   - sem erros de console. Banco 100% descartável.
import crypto from "node:crypto";
import { chromium } from "playwright";
import { io as ioClient } from "socket.io-client";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, encerrarServidor, limparDir, abrirDb, sessao,
} from "./teste-base.mjs";
import { hashSenha } from "./servidor/dist/lib/password.js";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("vida-vtt-ui");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const SHOTS = join(process.cwd(), "_evidencias", "vida-vtt");
mkdirSync(SHOTS, { recursive: true });
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");
const PNG_PATH = join(DIR, "mapa.png");
writeFileSync(PNG_PATH, PNG);

const CFG = {
  hp: { habilitado: true, base: 100, porNivel: 10, semantico: "atributo", edicaoPor: "mestre" },
  vitalidade: {
    edicaoPor: "mestre",
    niveis: [
      { nome: "São", penalidadeDados: 0, bloqueiaAcoes: false },
      { nome: "Machucado", penalidadeDados: 1, bloqueiaAcoes: false },
      { nome: "Debilitado", penalidadeDados: 2, bloqueiaAcoes: true },
    ],
  },
};

let browser, proc, ids, sid, sidBGlobal;
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
async function irCampanha(page) {
  await page.getByRole("button", { name: "Campanhas" }).click();
  await page.getByText("Campanha Teste", { exact: true }).first().click();
}
async function irMesa(page) {
  await irCampanha(page);
  await page.locator(".abas button", { hasText: "Mesa" }).first().click();
}
async function abrirSessao(page, nomeSessao) {
  const linha = page.locator("tr.clicavel", { hasText: nomeSessao });
  await linha.first().waitFor({ timeout: 15000 });
  await linha.first().click();
  await page.locator(".vtt-tabuleiro, .mesa-vtt .dica, .mesa-vtt h3").first().waitFor({ timeout: 15000 });
}
async function irRegrasPontuacao(page) {
  await irCampanha(page);
  await page.locator(".abas button", { hasText: "Regras" }).first().click();
  await page.locator(".abas button", { hasText: "Pontuação" }).first().click();
  await page.getByText("Mesa Virtual (VTT)").waitFor({ timeout: 15000 });
}
const semOverflowX = (page) => page.evaluate(() =>
  document.scrollingElement.scrollWidth <= document.documentElement.clientWidth + 1);
// token pelo texto das iniciais dentro do botão .vtt-token
const tokVida = (page, ini) => page.locator(".vtt-token", { hasText: ini });
const hpBar = (page, ini) => tokVida(page, ini).locator(".vtt-token-hp");
const vitBadge = (page, ini) => tokVida(page, ini).locator(".vtt-token-vit");

// socket do mestre só para criar tokens com personagemId (a UI só vincula
// userId/NPC) — o caminho real de emissão é o mesmo socket.io do servidor.
function socketMestre() {
  const token = decodeURIComponent(ids.cookieMestre.split("=")[1]);
  const s = ioClient(BASE, {
    path: "/socket.io", transports: ["websocket", "polling"],
    extraHeaders: { cookie: `mestre_rpg_session=${encodeURIComponent(token)}` },
    reconnection: false,
  });
  return s;
}
const emitirCb = (s, ev, p) => new Promise((r) => {
  const to = setTimeout(() => r({ ok: false, erro: "timeout" }), 8000);
  s.emit(ev, p, (x) => { clearTimeout(to); r(x); });
});

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", () => {});
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO, {
    jogadores: { jogador1: "vd_j1", jogador2: "vd_j2" },
    config: CFG,
  });
  ids = { camp: c.campId, cookieMestre: c.cookieMestre, j1: c.jogadores.jogador1.id, j2: c.jogadores.jogador2.id };

  // espectador real (hash de senha válido para login pela UI)
  {
    const db = abrirDb(BANCO);
    const uid = crypto.randomUUID(), agora = Date.now();
    db.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
      .run(uid, "vd_esp", "Espectador Vida", await hashSenha("senha-espectador-123"), agora, agora);
    db.prepare("insert into memberships (id,campaign_id,user_id,role,status,permissions,joined_at,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), c.campId, uid, "espectador", "ativo", "{}", agora, agora, agora);
    db.close();
  }

  // Personagens com vida semeada: PJ1 "Ana" (j1, HP 120/150, vitalidade 1),
  // PJ2 "Beto" (j2, HP 80/150), NPC "Goblin" (HP 60/180, vitalidade 2).
  const PJ1 = c.novoPersonagem(c.jogadores.jogador1.membershipId, "Ana", { __hp: { atual: 120, historico: [] }, __vitalidade: { nivel: 1, nivelManual: 1 } });
  const PJ2 = c.novoPersonagem(c.jogadores.jogador2.membershipId, "Beto", { __hp: { atual: 80, historico: [] } });
  const PJNpc = c.novoPersonagem(c.membMestre, "Goblin", { for: 8, __hp: { atual: 60, historico: [] }, __vitalidade: { nivel: 2, nivelManual: 2 } });
  {
    const db = abrirDb(BANCO);
    db.prepare("update characters set is_npc=1 where id=?").run(PJNpc);
    db.close();
  }

  const sess = await req(BASE, "POST", `/campaigns/${c.campId}/sessoes`, { cookie: c.cookieMestre, body: { name: "Mesa Vida UI" } });
  sid = sess.json?.sessao?.id ?? sess.json?.id;
  t("sessão criada via API", !!sid, `status=${sess.status}`);

  browser = await chromium.launch();

  // ---------- desktop 1920: fluxo completo ----------
  sec("Desktop 1920 — indicadores por papel (flag OFF)");
  const ctxM = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const ctxA = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const ctxB = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const ctxE = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const pgM = await ctxM.newPage(), pgA = await ctxA.newPage(), pgB = await ctxB.newPage(), pgE = await ctxE.newPage();
  vigiar(pgM, "mestre"); vigiar(pgA, "j1"); vigiar(pgB, "j2"); vigiar(pgE, "esp");

  await login(pgM, "mestre_teste", "senha-forte-123");
  await login(pgA, "vd_j1", "senha-jogador-123");
  await login(pgB, "vd_j2", "senha-jogador-123");
  await login(pgE, "vd_esp", "senha-espectador-123");
  await Promise.all([irMesa(pgM), irMesa(pgA), irMesa(pgB), irMesa(pgE)]);
  await abrirSessao(pgM, "Mesa Vida UI");
  await abrirSessao(pgA, "Mesa Vida UI");
  await abrirSessao(pgB, "Mesa Vida UI");
  await abrirSessao(pgE, "Mesa Vida UI");

  // mapa para habilitar o tabuleiro (só o mestre envia)
  await pgM.locator(".mesa-vtt input[type=file]").setInputFiles(PNG_PATH);
  await pgM.locator(".vtt-tabuleiro").waitFor({ timeout: 10000 });
  await pgA.locator(".vtt-tabuleiro").waitFor({ timeout: 10000 });
  await pgE.locator(".vtt-tabuleiro").waitFor({ timeout: 10000 });

  // tokens via socket real do mestre (personagemId não existe na UI de criação)
  const sM = socketMestre();
  await new Promise((res, rej) => { sM.on("connect", res); sM.on("connect_error", rej); });
  const criarTok = (id, extra) => emitirCb(sM, "mesa:vtt:token", { sessionId: sid, acao: "criar", token: { id, nome: id, cor: "#4f8ef7", x: 0.5, y: 0.5, ...extra } });
  t("tokens PJ1/PJ2/NPC criados",
    (await criarTok("tkana-ui01", { nome: "Ana", personagemId: PJ1, userId: ids.j1 }))?.ok === true
    && (await criarTok("tkbeto-ui2", { nome: "Beto", personagemId: PJ2, userId: ids.j2 }))?.ok === true
    && (await criarTok("tkgoblin3", { nome: "Goblin", personagemId: PJNpc, oculto: false }))?.ok === true
    && (await criarTok("tksem-vd04", { nome: "Fantasma" }))?.ok === true);
  await pgM.locator(".vtt-token", { hasText: "AN" }).waitFor({ timeout: 10000 });
  await pgA.locator(".vtt-token", { hasText: "AN" }).waitFor({ timeout: 10000 });
  await pgE.locator(".vtt-token", { hasText: "AN" }).waitFor({ timeout: 10000 });
  await pgM.waitForTimeout(600);

  // flag OFF: vida só do próprio personagem
  t("mestre: HP bar nos 3 tokens com ficha",
    (await hpBar(pgM, "AN").count()) === 1 && (await hpBar(pgM, "BE").count()) === 1 && (await hpBar(pgM, "GO").count()) === 1);
  t("mestre: badge vitalidade (Ana=1, Goblin=2)",
    (await vitBadge(pgM, "AN").textContent()) === "1" && (await vitBadge(pgM, "GO").textContent()) === "2");
  t("mestre: title HP Ana = 120/150",
    (await hpBar(pgM, "AN").getAttribute("title")) === "HP 120/150");
  t("mestre: token sem vínculo NÃO tem HP bar", (await hpBar(pgM, "FA").count()) === 0);

  t("j1: HP bar só no próprio token (Ana)",
    (await hpBar(pgA, "AN").count()) === 1 && (await hpBar(pgA, "BE").count()) === 0 && (await hpBar(pgA, "GO").count()) === 0);
  t("j1: badge vitalidade no próprio token", (await vitBadge(pgA, "AN").textContent()) === "1");
  t("j1: token do Goblin visível mas sem indicadores", (await pgA.locator(".vtt-token", { hasText: "GO" }).count()) === 1);

  t("j2: HP bar só no próprio token (Beto)",
    (await hpBar(pgB, "BE").count()) === 1 && (await hpBar(pgB, "AN").count()) === 0);

  t("espectador: nenhum indicador de vida",
    (await pgE.locator(".vtt-token-hp").count()) === 0 && (await pgE.locator(".vtt-token-vit").count()) === 0
    && (await pgE.locator(".vtt-token", { hasText: "AN" }).count()) === 1);

  await pgM.screenshot({ path: join(SHOTS, "vida-01-mestre-flag-off.png") });
  await pgA.screenshot({ path: join(SHOTS, "vida-02-j1-flag-off.png") });

  // ---------- A. Token de jogador via formulário UI com ficha concreta ----------
  sec("A. Formulário Adicionar token — ficha do membro + rejeição cross-owner");
  {
    // cross-owner direto no socket: userId de j1 + ficha de j2 deve falhar
    const cross = await emitirCb(sM, "mesa:vtt:token", {
      sessionId: sid, acao: "criar",
      token: { id: "tkcross-01", nome: "Cross", cor: "#ff0000", x: 0.5, y: 0.5, userId: ids.j1, personagemId: PJ2 },
    });
    t("cross-owner (userId j1 + ficha de j2) rejeitado", cross?.ok === false, JSON.stringify(cross));

    const formTok = pgM.locator(".vtt-controles", { has: pgM.locator('input[placeholder="Nome do token"]') });
    const selMembro = formTok.locator("select").nth(0);
    const selFicha = formTok.locator('select[aria-label="Vincular ficha do jogador"]');
    const btnAdd = formTok.getByRole("button", { name: "Adicionar token" });

    // token COM ficha: usuário j1 + Ana (PJ1)
    await formTok.locator('input[placeholder="Nome do token"]').fill("Vera UI");
    await selMembro.selectOption(ids.j1);
    await selFicha.selectOption(PJ1);
    await btnAdd.click();
    await pgM.locator(".vtt-token", { hasText: "VE" }).waitFor({ timeout: 10000 });
    t("UI: token criado com userId+ficha", true);
    t("UI: HP bar no token da UI (mestre)", (await hpBar(pgM, "VE").count()) === 1);
    t("UI: title HP = 120/150", (await hpBar(pgM, "VE").getAttribute("title")) === "HP 120/150");
    await pgA.locator(".vtt-token", { hasText: "VE" }).waitFor({ timeout: 10000 });
    t("UI: dono (j1) vê HP do próprio token criado via UI", (await hpBar(pgA, "VE").count()) === 1);

    // trocar o dono limpa a ficha selecionada (sem inferência)
    await selMembro.selectOption(ids.j2);
    t("UI: trocar dono limpa ficha selecionada",
      (await selFicha.inputValue()) === "", `valor=${await selFicha.inputValue()}`);

    // token SEM ficha: usuário j2 sem selecionar ficha → vida null explícita
    await formTok.locator('input[placeholder="Nome do token"]').fill("Solto UI");
    await btnAdd.click();
    await pgM.locator(".vtt-token", { hasText: "SO" }).waitFor({ timeout: 10000 });
    await pgM.waitForTimeout(500);
    t("UI: token sem ficha NÃO tem HP bar (vida null)", (await hpBar(pgM, "SO").count()) === 0);
  }

  // ---------- C. position:absolute — tokens fora do fluxo, left/top governam ----------
  sec("C. .vtt-token position absolute — coordenadas inline preservadas");
  {
    const pos = await pgM.locator(".vtt-token", { hasText: "AN" }).first().evaluate((el) => {
      const s = getComputedStyle(el);
      return { position: s.position, left: s.left, top: s.top, transform: s.transform };
    });
    t("computed position === absolute", pos.position === "absolute", JSON.stringify(pos));
    // todos os tokens de teste estão em x=0.5,y=0.5: com absolute eles
    // sobrepõem (mesmo rect); com relative empilhariam no fluxo (rects distintos)
    const rects = await pgM.locator(".vtt-token").evaluateAll((els) =>
      els.map((e) => { const r = e.getBoundingClientRect(); return `${Math.round(r.x)},${Math.round(r.y)}`; }));
    const unicos = new Set(rects);
    t("tokens nas mesmas coords sobrepõem (fora do fluxo)", unicos.size === 1 && rects.length >= 6,
      `unicos=${unicos.size} n=${rects.length} rects=${[...unicos].join("|")}`);
  }

  // ---------- toggle vidaCompartilhada pela UI de Regras ----------
  sec("Toggle vidaCompartilhada em Regras → sincronização ao vivo");
  await irRegrasPontuacao(pgM);
  const chk = pgM.getByLabel(/Compartilhar vida \(HP e vitalidade\)/);
  t("checkbox vidaCompartilhada visível e desmarcado", await chk.count() === 1 && !(await chk.isChecked()));
  await chk.check();
  await pgM.getByRole("button", { name: "Salvar configuração" }).click();
  await pgM.getByText("Configuração salva").waitFor({ timeout: 10000 }).catch(() => {});
  // regras:atualizadas → Mesa.tsx debounce → mesa:vtt:sincronizar
  await pgA.locator(".abas button", { hasText: "Mesa" }).first().click().catch(() => {});
  // se saiu da mesa, volta à sessão
  if (await pgA.locator(".vtt-tabuleiro").count() === 0) {
    await abrirSessao(pgA, "Mesa Vida UI");
  }
  try {
    await hpBar(pgA, "BE").waitFor({ timeout: 12000 });
    t("j1 passa a ver HP bar no token do Beto (flag ON, ao vivo)", true);
  } catch {
    t("j1 passa a ver HP bar no token do Beto (flag ON, ao vivo)", false);
  }
  t("j1: HP bar no Goblin com flag ON", await hpBar(pgA, "GO").count() === 1);
  try {
    await pgE.locator(".vtt-token-hp").first().waitFor({ timeout: 12000 });
    t("espectador passa a ver indicadores com flag ON", true);
  } catch {
    t("espectador passa a ver indicadores com flag ON", false);
  }
  await pgA.screenshot({ path: join(SHOTS, "vida-03-j1-flag-on.png") });

  // ---------- atualização após personagens:atualizados ----------
  sec("Dano de HP → barra do token atualiza sem reload");
  const rHp = await req(BASE, "POST", `/characters/${PJ1}/hp`, { cookie: c.cookieMestre, body: { acao: "dano", quantidade: 10, motivo: "homologação" } });
  t("POST /hp dano 10", rHp.status === 200, `status=${rHp.status}`);
  try {
    await pgA.waitForFunction(() => {
      const el = [...document.querySelectorAll(".vtt-token")].find((x) => x.textContent?.includes("AN"));
      return el?.querySelector(".vtt-token-hp")?.getAttribute("title") === "HP 110/150";
    }, null, { timeout: 12000 });
    t("j1: title HP do próprio token vira 110/150", true);
  } catch {
    const title = await hpBar(pgA, "AN").getAttribute("title").catch(() => "ausente");
    t("j1: title HP do próprio token vira 110/150", false, title);
  }

  // ---------- desliga pela UI → vida alheia some ----------
  sec("Desligar compartilhada remove indicadores alheios");
  await irRegrasPontuacao(pgM);
  await pgM.getByLabel(/Compartilhar vida \(HP e vitalidade\)/).uncheck();
  await pgM.getByRole("button", { name: "Salvar configuração" }).click();
  await pgM.getByText("Configuração salva").waitFor({ timeout: 10000 }).catch(() => {});
  await pgA.locator(".abas button", { hasText: "Mesa" }).first().click().catch(() => {});
  if (await pgA.locator(".vtt-tabuleiro").count() === 0) {
    await abrirSessao(pgA, "Mesa Vida UI");
  }
  try {
    await pgA.waitForFunction(() => {
      const el = [...document.querySelectorAll(".vtt-token")].find((x) => x.textContent?.includes("BE"));
      return el && !el.querySelector(".vtt-token-hp");
    }, null, { timeout: 12000 });
    t("j1: HP bar do Beto removida após desligar", true);
  } catch {
    t("j1: HP bar do Beto removida após desligar", false);
  }
  t("j1: HP bar do próprio token permanece", (await hpBar(pgA, "AN").count()) === 1);

  // persistência: reload da página de Regras mostra o checkbox desmarcado
  await irRegrasPontuacao(pgM);
  t("checkbox permanece desmarcado após reload", !(await pgM.getByLabel(/Compartilhar vida \(HP e vitalidade\)/).isChecked()));

  // ---------- callback atrasado A→B não contamina a sessão atual ----------
  sec("Callback atrasado de sincronização não aplica estado de sessão trocada");
  {
    const sessB = await req(BASE, "POST", `/campaigns/${c.campId}/sessoes`, { cookie: c.cookieMestre, body: { name: "Mesa Vida B" } });
    const sidB = sessB.json?.sessao?.id ?? sessB.json?.id;
    sidBGlobal = sidB;
    t("sessão B criada", !!sidB);
    await emitirCb(sM, "mesa:entrar", { sessionId: sidBGlobal });
    t("token Zé (PJ1) criado na sessão B",
      (await emitirCb(sM, "mesa:vtt:token", {
        sessionId: sidBGlobal, acao: "criar",
        token: { id: "tkze-bb77", nome: "Zé", cor: "#22aa55", x: 0.3, y: 0.3, personagemId: PJ1, userId: ids.j1 },
      }))?.ok === true);

    // atrasa deterministicamente o ACK de mesa:vtt:sincronizar da
    // sessão A — socket.volatile retorna o próprio socket, então
    // interceptar emit cobre volatile.emit. A resposta do servidor é
    // real; só a entrega do callback ao componente é retardada.
    await pgA.evaluate((sidA) => {
      const sock = window.__mesaSocket;
      if (!sock || sock.__syncDelayPatched) return;
      const emitirOriginal = sock.emit.bind(sock);
      sock.__syncDelayPatched = true;
      sock.emit = (ev, p, cb) => {
        if (ev === "mesa:vtt:sincronizar" && p?.sessionId === sidA && typeof cb === "function") {
          return emitirOriginal(ev, p, (...args) => setTimeout(() => cb(...args), 4000));
        }
        return emitirOriginal(ev, p, cb);
      };
    }, sid);

    // a sessão B precisa de mapa para renderizar o tabuleiro — o
    // mestre abre a sessão e faz o upload real
    await irMesa(pgM);
    await abrirSessao(pgM, "Mesa Vida B");
    await pgM.locator(".mesa-vtt input[type=file]").setInputFiles(PNG_PATH);
    await pgM.locator(".vtt-tabuleiro").waitFor({ timeout: 15000 });

    // dispara personagens:atualizados → o cliente da sessão A agenda
    // a sincronização (~250ms) cujo ACK chegará ~2,5s depois
    const rHp2 = await req(BASE, "POST", `/characters/${PJ1}/hp`, { cookie: c.cookieMestre, body: { acao: "dano", quantidade: 5, motivo: "callback atrasado" } });
    t("POST /hp dispara atualização", rHp2.status === 200, `status=${rHp2.status}`);

    // troca para a sessão B ANTES do ACK atrasado de A chegar
    await pgA.getByRole("button", { name: "Sair da mesa" }).click();
    await irMesa(pgA);
    await abrirSessao(pgA, "Mesa Vida B");
    await pgA.locator(".vtt-tabuleiro").waitFor({ timeout: 15000 });
    t("sessão B carregada com exatamente 1 token",
      await pgA.locator(".vtt-token").count() === 1,
      `tokens=${await pgA.locator(".vtt-token").count()}`);

    // o ACK atrasado de A dispara aqui — não pode aplicar o vtt de A
    await pgA.waitForTimeout(4600);
    t("estado da sessão B intacto após ACK atrasado de A",
      await pgA.locator(".vtt-token").count() === 1
      && await pgA.locator(".vtt-token", { hasText: "AN" }).count() === 0
      && await pgA.locator(".vtt-token", { hasText: "BE" }).count() === 0,
      `tokens=${await pgA.locator(".vtt-token").allTextContents().then((a) => a.join("|"))}`);

    // o fluxo de B continua: a vida do próprio personagem chega pelo
    // canal correto da sessão B (PJ1: 110 − 5 = 105)
    try {
      await pgA.waitForFunction(() => {
        const el = document.querySelector(".vtt-token");
        return el?.querySelector(".vtt-token-hp")?.getAttribute("title") === "HP 105/150";
      }, null, { timeout: 12000 });
      t("sessão B segue sincronizando vida correta (105/150)", true);
    } catch {
      const title = await pgA.locator(".vtt-token .vtt-token-hp").getAttribute("title").catch(() => "ausente");
      t("sessão B segue sincronizando vida correta (105/150)", false, title);
    }
  }

  // ---------- B. Barra HP fracionária — divisor real, clamp 0–100 ----------
  sec("B. HP fracionário — percentuais corretos na barra");
  {
    // regras hp → base 0, porNivel 0.5: for=1 ⇒ maximo 0.5 (fracionário real)
    const dbf = abrirDb(BANCO);
    const rsRow = dbf.prepare("select id,config from rule_sets where campaign_id=? and is_active=1").get(c.campId);
    const cfgF = JSON.parse(rsRow.config || "{}");
    cfgF.hp = { habilitado: true, base: 0, porNivel: 0.5, semantico: "atributo", edicaoPor: "mestre" };
    dbf.prepare("update rule_sets set config=? where id=?").run(JSON.stringify(cfgF), rsRow.id);
    dbf.close();

    const PF = [
      ["Fraco", 0.25, "FR"], ["Cheio", 0.5, "CH"], ["Vazio", 0, "VA"], ["Excedente", 0.9, "EX"],
    ];
    for (const [nome, atual, ini] of PF) {
      const pid = c.novoPersonagem(c.membMestre, nome, { for: 1, __hp: { atual, historico: [] } });
      const tk = await emitirCb(sM, "mesa:vtt:token", {
        sessionId: sidBGlobal, acao: "criar",
        token: { id: `tk${ini.toLowerCase()}-f1`, nome, cor: "#3366ff", x: 0.5, y: 0.5, personagemId: pid },
      });
      t(`token fracionário ${nome} criado`, tk?.ok === true, JSON.stringify(tk));
    }
    await emitirCb(sM, "mesa:vtt:sincronizar", { sessionId: sidBGlobal });
    await pgM.waitForTimeout(800);
    const larg = async (ini) => pgM.locator(".vtt-token", { hasText: ini })
      .locator(".vtt-token-hp-fill").evaluate((el) => el.style.width).catch(() => "ausente");
    t("B. 0.25/0.5 = 50%", (await larg("FR")) === "50%", await larg("FR"));
    t("B. 0.5/0.5 = 100%", (await larg("CH")) === "100%", await larg("CH"));
    t("B. 0/0.5 = 0%", (await larg("VA")) === "0%", await larg("VA"));
    t("B. acima do máximo (0.9→clamp) = 100%", (await larg("EX")) === "100%", await larg("EX"));
    t("B. title HP fracionário visível", (await pgM.locator(".vtt-token", { hasText: "FR" })
      .locator(".vtt-token-hp").getAttribute("title")) === "HP 0.25/0.5",
      await pgM.locator(".vtt-token", { hasText: "FR" }).locator(".vtt-token-hp").getAttribute("title"));
  }

  await ctxM.close(); await ctxA.close(); await ctxB.close(); await ctxE.close();
  sM.close();

  // ---------- mobile 390px ----------
  sec("Mobile 390×844 — jogador vê a própria vida");
  const ctxMob = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const pgMob = await ctxMob.newPage();
  vigiar(pgMob, "mobile");
  await login(pgMob, "vd_j1", "senha-jogador-123");
  await irMesa(pgMob);
  await abrirSessao(pgMob, "Mesa Vida UI");
  await pgMob.locator(".vtt-tabuleiro").waitFor({ timeout: 10000 });
  try {
    await hpBar(pgMob, "AN").waitFor({ timeout: 10000 });
    t("mobile: HP bar no próprio token", true);
  } catch {
    t("mobile: HP bar no próprio token", false);
  }
  t("mobile: badge vitalidade", (await vitBadge(pgMob, "AN").textContent().catch(() => "")) === "1");
  t("mobile: sem overflow horizontal", await semOverflowX(pgMob));
  await pgMob.screenshot({ path: join(SHOTS, "vida-04-mobile-j1.png") });
  await ctxMob.close();

  t("sem erros de console/pageerror", errosConsole.length === 0, errosConsole.slice(0, 5).join(" | "));
} catch (e) {
  fail++;
  console.log("  FALHOU exceção:", String(e?.stack ?? e).slice(0, 900));
} finally {
  try { await browser?.close(); } catch { }
  await encerrarServidor(proc);
  limparDir(DIR);
}
console.log(`\n==== homologacao-vida-vtt: ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
