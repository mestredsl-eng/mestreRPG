// Mesa virtual — E2E D10 canônico + separação OOC/diegético (Issue #293).
// Três contextos Playwright reais (mestre + 2 jogadores) na MESMA sessão:
//  - um jogador rola D10 e todos recebem o MESMO evento mesa:rolagem
//    (mesmo id, mesmos resultados, mesmo total, mesma avaliação D10);
//  - repetir a requisição com o mesmo requestId NÃO duplica rolagem
//    (ACK duplicado, zero novos eventos, uma única linha em `rolls`);
//  - chat OOC (conta do usuário) e fala diegética (personagem) chegam
//    a todos com atribuição distinta — sem se misturar;
//  - após reload do cliente, novo ouvinte não duplica eventos.
import crypto from "node:crypto";
import { chromium } from "playwright";
import { join } from "node:path";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, comDb, encerrarServidor, limparDir, req,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("mesa-d10-e2e");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const ARQ = join(DIR, "arquivos", "campanhas");
const BKS = join(DIR, "backups");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;

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
async function abrirSessao(page, nomeSessao) {
  const linha = page.locator("tr.clicavel", { hasText: nomeSessao });
  await linha.first().waitFor({ timeout: 15000 });
  await linha.first().click();
  await page.locator(".mesa-vtt .dica, .mesa-vtt h3, .mesa-chat").first().waitFor({ timeout: 15000 });
}
// Observador passivo: registra eventos mesa:rolagem/mesa:mensagem sem
// interferir nos listeners da aplicação.
async function escutar(page) {
  await page.waitForFunction(() => window.__mesaSocket?.connected === true, null, { timeout: 20000 });
  await page.evaluate(() => {
    window.__rolagens = [];
    window.__msgs = [];
    const s = window.__mesaSocket;
    s.on("mesa:rolagem", (r) => window.__rolagens.push(r));
    s.on("mesa:mensagem", (m) => window.__msgs.push(m));
  });
}
const contarRolagens = (page) => page.evaluate(() => window.__rolagens.length);
const rolamentos = (page) => page.evaluate(() => window.__rolagens);
const emitirRolar = (page, payload) => page.evaluate((p) => new Promise((res) => {
  window.__mesaSocket.emit("mesa:rolar", p, res);
}), payload);
const emitirMensagem = (page, payload) => page.evaluate((p) => new Promise((res) => {
  window.__mesaSocket.emit("mesa:mensagem", p, res);
}), payload);

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", () => {});
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO);
  // personagem próprio do jogador1 — necessário para a fala diegética
  const charJ1 = c.novoPersonagem(c.jogadores.jogador1.membershipId, "Heroína J1");

  const sess = await req(BASE, "POST", `/campaigns/${c.campId}/sessoes`, { cookie: c.cookieMestre, body: { name: "Mesa D10 E2E" } });
  const sessId = sess.json?.sessao?.id ?? sess.json?.id;
  t("sessão criada via API", sess.status === 200 || sess.status === 201, `status=${sess.status} body=${JSON.stringify(sess.json).slice(0, 200)}`);

  browser = await chromium.launch();
  const ctxM = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const ctxJ1 = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const ctxJ2 = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const pgM = await ctxM.newPage(), pgJ1 = await ctxJ1.newPage(), pgJ2 = await ctxJ2.newPage();
  vigiar(pgM, "mestre"); vigiar(pgJ1, "j1"); vigiar(pgJ2, "j2");

  sec("Três clientes na mesma sessão");
  await login(pgM, "mestre_teste", "senha-forte-123");
  await login(pgJ1, "jogador_um", "senha-jogador-123");
  await login(pgJ2, "jogador_dois", "senha-jogador-123");
  await Promise.all([irMesa(pgM), irMesa(pgJ1), irMesa(pgJ2)]);
  await abrirSessao(pgM, "Mesa D10 E2E");
  await abrirSessao(pgJ1, "Mesa D10 E2E");
  await abrirSessao(pgJ2, "Mesa D10 E2E");
  await Promise.all([escutar(pgM), escutar(pgJ1), escutar(pgJ2)]);
  t("socket conectado nos três clientes", true);

  sec("D10 canônico — mesmo resultado para todos");
  const rid1 = crypto.randomUUID();
  // 5 positivos − 1 negativo = 4 dados efetivos d10 (contrato mesa:rolar)
  const ack1 = await emitirRolar(pgJ1, {
    sessionId: sessId,
    dados: [{ sides: 10, count: 4 }],
    motivo: "D10 e2e canônico",
    d10: { positivos: 5, negativos: 1 },
    requestId: rid1,
  });
  t("ACK da rolagem D10 aceita", ack1?.ok === true, JSON.stringify(ack1).slice(0, 160));

  // todos recebem exatamente um mesa:rolagem com o MESMO conteúdo
  await pgM.waitForFunction(() => window.__rolagens.length === 1, null, { timeout: 10000 });
  await pgJ2.waitForFunction(() => window.__rolagens.length === 1, null, { timeout: 10000 });
  const [rM, rJ1, rJ2] = await Promise.all([rolamentos(pgM), rolamentos(pgJ1), rolamentos(pgJ2)]);
  const canon = (r) => r.length === 1 ? JSON.stringify({
    id: r[0].id, grupos: r[0].grupos, total: r[0].total, d10: r[0].d10,
  }) : null;
  t("mestre recebeu exatamente 1 mesa:rolagem", rM.length === 1, `n=${rM.length}`);
  t("jogador2 recebeu exatamente 1 mesa:rolagem", rJ2.length === 1, `n=${rJ2.length}`);
  t("payload canônico idêntico nos três clientes", !!canon(rM) && canon(rM) === canon(rJ1) && canon(rM) === canon(rJ2));
  const rollId = rM[0]?.id;
  t("id do roll = requestId do cliente", rollId === rid1, `${rollId} vs ${rid1}`);
  const resD10 = rM[0]?.grupos?.[0]?.resultados ?? [];
  t("4 dados efetivos lançados", resD10.length === 4, JSON.stringify(resD10));
  t("avaliação D10 presente e consistente", rM[0]?.d10?.lancados === 4
    && rM[0]?.d10?.sucessos + rM[0]?.d10?.falhas === 4
    && typeof rM[0]?.d10?.minimo === "number", JSON.stringify(rM[0]?.d10).slice(0, 160));
  // UI: item de rolagem visível nos três com o mesmo id
  await Promise.all([
    pgM.locator(`.rolagem-item[data-rolagem-id="${rollId}"]`).waitFor({ timeout: 10000 }),
    pgJ1.locator(`.rolagem-item[data-rolagem-id="${rollId}"]`).waitFor({ timeout: 10000 }),
    pgJ2.locator(`.rolagem-item[data-rolagem-id="${rollId}"]`).waitFor({ timeout: 10000 }),
  ]);
  t("rolagem-item visível nos três clientes", true);
  // chat registra a rolagem para todos (kind=rolagem)
  await Promise.all([
    pgM.locator(".chat-msg.chat-rolagem").first().waitFor({ timeout: 10000 }),
    pgJ1.locator(".chat-msg.chat-rolagem").first().waitFor({ timeout: 10000 }),
    pgJ2.locator(".chat-msg.chat-rolagem").first().waitFor({ timeout: 10000 }),
  ]);
  t("mensagem de rolagem no chat dos três", true);

  sec("Idempotência — mesmo requestId não duplica");
  const ackDup = await emitirRolar(pgJ1, {
    sessionId: sessId,
    dados: [{ sides: 10, count: 4 }],
    motivo: "D10 e2e canônico",
    d10: { positivos: 5, negativos: 1 },
    requestId: rid1,
  });
  t("repetição ACK ok sem novo roll", ackDup?.ok === true, JSON.stringify(ackDup).slice(0, 160));
  await pgM.waitForTimeout(1200); // janela para um eventual evento duplicado chegar
  const [nM, nJ1, nJ2] = await Promise.all([contarRolagens(pgM), contarRolagens(pgJ1), contarRolagens(pgJ2)]);
  t("nenhum cliente recebeu 2º mesa:rolagem", nM === 1 && nJ1 === 1 && nJ2 === 1, `m=${nM} j1=${nJ1} j2=${nJ2}`);
  const nItens = await Promise.all([
    pgM.locator(`.rolagem-item[data-rolagem-id="${rollId}"]`).count(),
    pgJ1.locator(`.rolagem-item[data-rolagem-id="${rollId}"]`).count(),
    pgJ2.locator(`.rolagem-item[data-rolagem-id="${rollId}"]`).count(),
  ]);
  t("UI não duplica o item de rolagem", nItens.every((n) => n === 1), JSON.stringify(nItens));
  const nChatRol = await Promise.all([
    pgM.locator(".chat-msg.chat-rolagem").count(),
    pgJ1.locator(".chat-msg.chat-rolagem").count(),
    pgJ2.locator(".chat-msg.chat-rolagem").count(),
  ]);
  t("chat não duplica a mensagem de rolagem", nChatRol.every((n) => n === 1), JSON.stringify(nChatRol));
  const nDb = comDb(BANCO, (db) => db.prepare("select count(*) c from rolls where request_id=?").get(rid1).c);
  t("banco tem exatamente 1 roll para o requestId", nDb === 1, `n=${nDb}`);

  sec("Chat — OOC e fala diegética não se misturam");
  const marcadorOoc = `ooc-e2e-${crypto.randomUUID().slice(0, 8)}`;
  const marcadorIc = `ic-e2e-${crypto.randomUUID().slice(0, 8)}`;
  // OOC: jogador1 fala pela conta (sem speaker)
  const ackOoc = await emitirMensagem(pgJ1, {
    sessionId: sessId, content: marcadorOoc, clientId: crypto.randomUUID(), tipo: "texto",
  });
  t("mensagem OOC aceita", ackOoc?.ok === true, JSON.stringify(ackOoc).slice(0, 140));
  // diegética: jogador1 fala como o próprio personagem
  const ackIc = await emitirMensagem(pgJ1, {
    sessionId: sessId, content: marcadorIc, clientId: crypto.randomUUID(), tipo: "texto",
    speakerCharacterId: charJ1,
  });
  t("mensagem diegética aceita", ackIc?.ok === true, JSON.stringify(ackIc).slice(0, 140));

  for (const [tag, pg] of [["mestre", pgM], ["j1", pgJ1], ["j2", pgJ2]]) {
    const msgOoc = pg.locator(".chat-msg", { hasText: marcadorOoc });
    const msgIc = pg.locator(".chat-msg", { hasText: marcadorIc });
    await msgOoc.waitFor({ timeout: 10000 });
    await msgIc.waitFor({ timeout: 10000 });
    const [autorOoc, identOoc, autorIc, identIc] = await Promise.all([
      msgOoc.locator(".chat-autor").textContent(),
      msgOoc.locator(".chat-voz-identidade").count(),
      msgIc.locator(".chat-autor").textContent(),
      msgIc.locator(".chat-voz-identidade").count(),
    ]);
    t(`${tag}: OOC atribuído à conta, sem identidade de personagem`,
      (autorOoc ?? "").includes("Jogador") && identOoc === 0, `${autorOoc} ident=${identOoc}`);
    t(`${tag}: diegética atribuída ao personagem, com "por <conta>"`,
      (autorIc ?? "").includes("Heroína J1") && identIc === 1, `${autorIc} ident=${identIc}`);
  }
  // payload dos eventos: OOC sem speakerName; diegética com speaker=personagem
  const msgsJ2 = await pgJ2.evaluate(() => window.__msgs);
  t("jogador2 recebeu os dois eventos de chat", msgsJ2.length >= 2, `msgs=${msgsJ2.length}`);
  const oocEv = (await pgJ2.evaluate(() => window.__msgs)).find((m) => m.content === marcadorOoc);
  const icEv = (await pgJ2.evaluate(() => window.__msgs)).find((m) => m.content === marcadorIc);
  t("evento OOC sem speaker; evento IC com speaker=personagem",
    oocEv && !oocEv.speakerName && icEv && icEv.speakerName === "Heroína J1"
    && icEv.speakerCharacterId === charJ1,
    JSON.stringify({ ooc: oocEv?.speakerName, ic: icEv?.speakerName }));

  sec("Reconexão — reload não duplica listeners");
  await pgJ2.reload();
  await pgJ2.getByText("Servidor online").waitFor({ timeout: 20000 });
  await irMesa(pgJ2);
  await abrirSessao(pgJ2, "Mesa D10 E2E");
  await escutar(pgJ2);
  const antesM = await contarRolagens(pgM), antesJ1 = await contarRolagens(pgJ1);
  const rid2 = crypto.randomUUID();
  const ack2 = await emitirRolar(pgJ1, {
    sessionId: sessId,
    dados: [{ sides: 10, count: 3 }],
    motivo: "D10 e2e pós-reload",
    d10: { positivos: 3, negativos: 0 },
    requestId: rid2,
  });
  t("segunda rolagem aceita", ack2?.ok === true, JSON.stringify(ack2).slice(0, 140));
  await pgM.waitForFunction((n) => window.__rolagens.length === n + 1, antesM, { timeout: 10000 });
  await pgJ2.waitForFunction(() => window.__rolagens.length === 1, null, { timeout: 10000 });
  await pgJ1.waitForTimeout(800);
  const [dM, dJ1, dJ2] = await Promise.all([contarRolagens(pgM), contarRolagens(pgJ1), contarRolagens(pgJ2)]);
  t("após reload cada cliente recebeu exatamente +1 rolagem",
    dM === antesM + 1 && dJ1 === antesJ1 + 1 && dJ2 === 1, `m=${dM} j1=${dJ1} j2=${dJ2}`);

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
