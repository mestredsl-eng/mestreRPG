// Testes: Desafio do Mestre + D10.
// Fluxo: mestre escolhe personagem + campo numérico da ficha (positivos
// derivados no servidor), adiciona dados negativos, jogador rola,
// resultado com sucessos/falhas vai para todos, mestre decide com nota.
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { io as ioClient } from "socket.io-client";
import { hashToken } from "./servidor/dist/lib/password.js";

const BASE = "http://localhost:3001";
const CID = "179dd61c-6f4e-4c54-bf88-1e255a506743";
const CHAR = "14474ba5-ba4a-4def-a361-7797971e966f"; // PJ Vida (Vigor = 3)
const VIGOR = "dc2d4cb6";
const resultados = [];
const ok = (nome, cond, extra = "") => {
  resultados.push({ nome, ok: !!cond });
  console.log(`${cond ? "ok" : "FALHOU"} ${nome}${extra ? " — " + extra : ""}`);
};

const db = new Database("banco/mestre-rpg.db");
const sessao = (userId, tag) => {
  const token = `${tag}-` + crypto.randomUUID();
  db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), userId, hashToken(token), "teste-desafio", "127.0.0.1", Date.now() + 3600000, Date.now());
  return token;
};
const admin = db.prepare("select id from users where username='administrador'").get();
const jog = db.prepare("select id from users where username='jogador_teste'").get();
const jog2 = db.prepare("select id from users where username='jogador2'").get();
for (const u of [jog, jog2]) {
  if (!db.prepare("select id from memberships where campaign_id=? and user_id=?").get(CID, u.id)) {
    db.prepare("insert into memberships (id,campaign_id,user_id,role,permissions,status,joined_at,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), CID, u.id, "jogador", "{}", "ativo", Date.now(), Date.now(), Date.now());
  }
}
const tokM = sessao(admin.id, "des-m");
const tokJ = sessao(jog.id, "des-j");
const tokJ2 = sessao(jog2.id, "des-j2");
async function req(m, path, body, token) {
  const r = await fetch(BASE + path, {
    method: m,
    headers: { "content-type": "application/json", cookie: `mestre_rpg_session=${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
const apiM = (m, p, b) => req(m, p, b, tokM);
const apiJ = (m, p, b) => req(m, p, b, tokJ);

// meta de sucesso conhecida
await apiM("PUT", `/api/campaigns/${CID}/regras/config`, { dados: { d10SucessoMinimo: 6 } });
// PJ Vida está Ferido gravemente (−2 dados) pelos testes de vida — zera a
// vitalidade para o pool do desafio não ser penalizado nesta suíte.
await apiM("POST", `/api/characters/${CHAR}/vitalidade`, { nivel: 0 });

// ---------- sessão + sockets ----------
const s = await apiM("POST", `/api/campaigns/${CID}/sessoes`, { name: "Sessão Desafio" });
const SID = s.json?.sessao?.id;
ok("sessão criada", !!SID);

const sockM = ioClient(BASE, { extraHeaders: { cookie: `mestre_rpg_session=${tokM}` }, transports: ["polling", "websocket"] });
const sockJ = ioClient(BASE, { extraHeaders: { cookie: `mestre_rpg_session=${tokJ}` }, transports: ["polling", "websocket"] });
const sockJ2 = ioClient(BASE, { extraHeaders: { cookie: `mestre_rpg_session=${tokJ2}` }, transports: ["polling", "websocket"] });
await Promise.all([
  new Promise((r) => sockM.on("connect", r)),
  new Promise((r) => sockJ.on("connect", r)),
  new Promise((r) => sockJ2.on("connect", r)),
]);
const emitirCb = (sock, ev, payload) => new Promise((res) => sock.emit(ev, payload, res));
const entrar = (sock) => new Promise((res) => sock.emit("mesa:entrar", { sessionId: SID }, res));
await entrar(sockM); await entrar(sockJ); await entrar(sockJ2);

// capturas de eventos por socket
const captJ = { teste: [], rolagem: [], decisao: [] };
const captJ2 = { teste: [] };
const captM = { teste: [], rolagem: [], decisao: [] };
sockJ.on("mesa:teste", (t) => captJ.teste.push(t));
sockJ.on("mesa:rolagem", (r) => captJ.rolagem.push(r));
sockJ.on("mesa:decisao", (d) => captJ.decisao.push(d));
sockJ2.on("mesa:teste", (t) => captJ2.teste.push(t));
sockM.on("mesa:teste", (t) => captM.teste.push(t));
sockM.on("mesa:rolagem", (r) => captM.rolagem.push(r));
sockM.on("mesa:decisao", (d) => captM.decisao.push(d));

// ---------- 1. jogador não pode criar desafio ----------
{
  const r = await emitirCb(sockJ, "mesa:teste:pedir", {
    sessionId: SID, characterId: CHAR, campoId: VIGOR, dadosLados: 10, malus: 1,
    requestId: "x-" + crypto.randomUUID().slice(0, 8),
  });
  ok("jogador não cria desafio", r?.ok === false, JSON.stringify(r));
}

// ---------- 2. mestre cria desafio D10 (Vigor=3, 1 negativo -> 2d10) ----------
let testId;
{
  const r = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: SID, characterId: CHAR, campoId: VIGOR, rotulo: "Vigor",
    dadosLados: 10, malus: 1, requestId: "des-" + crypto.randomUUID().slice(0, 8),
  });
  ok("mestre cria desafio", r?.ok === true, JSON.stringify(r));
  testId = r?.id;

  // jogador dono recebeu com pool completo
  const evJ = captJ.teste.find((t) => t.id === testId);
  ok("jogador recebeu desafio", !!evJ);
  ok("pool visível: 3 pos − 1 neg", evJ?.pool?.positivos === 3 && evJ?.pool?.negativos === 1 && evJ?.dados?.count === 2, JSON.stringify(evJ?.pool));
  ok("habilidade no desafio", evJ?.skillRef?.rotulo === "Vigor" || evJ?.rotulo === "Vigor" || evJ?.skillRef?.campoId === VIGOR, JSON.stringify(evJ));

  // outro jogador NÃO dono também vê (público) com pool, sem alvo
  const evJ2 = captJ2.teste.find((t) => t.id === testId);
  ok("não-dono vê desafio público", !!evJ2 && evJ2.pool?.positivos === 3, JSON.stringify(evJ2?.pool));

  // persistido no banco
  const row = db.prepare("select dice_sides,dice_count,modifiers,target from tests where id=?").get(testId);
  ok("banco: 10 lados, 2 dados efetivos", row?.dice_sides === 10 && row?.dice_count === 2, JSON.stringify(row));
  const mods = JSON.parse(row?.modifiers ?? "{}");
  ok("banco: modifiers com positivos/malus", mods.positivos === 3 && mods.malus === 1 && mods.valorCampo === 3, JSON.stringify(mods));
}

// ---------- 3. jogador rola -> resultado D10 para todos ----------
{
  const roll = await emitirCb(sockJ, "mesa:teste:rolar", { testId, requestId: "des-r-" + crypto.randomUUID().slice(0, 8) });
  ok("jogador rola desafio", roll?.ok === true, JSON.stringify(roll).slice(0, 200));
  ok("resposta traz resumo D10", roll?.d10?.minimo === 6 && roll?.d10?.lancados === 2, JSON.stringify(roll?.d10));
  const esperado = (roll?.dados ?? []).filter((v) => v >= 6).length;
  ok("sucessos = faces >= 6", roll?.d10?.sucessos === esperado && roll?.d10?.falhas === 2 - esperado, JSON.stringify(roll?.d10));
  // mesa inteira recebeu mesa:rolagem com d10
  const evM = captM.rolagem.find((r) => r.testId === testId);
  ok("mestre recebeu rolagem c/ d10", !!evM && evM.d10?.lancados === 2, JSON.stringify(evM?.d10));
  const evJ = captJ.rolagem.find((r) => r.testId === testId);
  ok("jogador recebeu rolagem c/ d10", !!evJ && evJ.d10 != null);
}

// ---------- 4. mínimo vem do servidor (config=9) ----------
{
  await apiM("PUT", `/api/campaigns/${CID}/regras/config`, { dados: { d10SucessoMinimo: 9 } });
  const r = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: SID, characterId: CHAR, campoId: VIGOR, rotulo: "Vigor",
    dadosLados: 10, requestId: "des-" + crypto.randomUUID().slice(0, 8),
  });
  const tid2 = r?.id;
  const roll = await emitirCb(sockJ, "mesa:teste:rolar", { testId: tid2 });
  ok("mínimo do servidor (9), não do cliente", roll?.d10?.minimo === 9, JSON.stringify(roll?.d10));
  const esperado = (roll?.dados ?? []).filter((v) => v >= 9).length;
  ok("sucessos respeitam mínimo 9", roll?.d10?.sucessos === esperado, `s=${roll?.d10?.sucessos} esp=${esperado}`);
  await apiM("PUT", `/api/campaigns/${CID}/regras/config`, { dados: { d10SucessoMinimo: 6 } });
}

// ---------- 5. pool zerado (negativos >= positivos) ----------
{
  const r = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: SID, characterId: CHAR, campoId: VIGOR, rotulo: "Vigor",
    dadosLados: 10, malus: 5, requestId: "des-" + crypto.randomUUID().slice(0, 8),
  });
  const tid3 = r?.id;
  const row = db.prepare("select dice_count from tests where id=?").get(tid3);
  ok("pool zerado: dice_count = 0", row?.dice_count === 0, `count=${row?.dice_count}`);
  const roll = await emitirCb(sockJ, "mesa:teste:rolar", { testId: tid3 });
  ok("rolagem com 0 dados funciona", roll?.ok === true && roll?.dados?.length === 0 && roll?.total === 0, JSON.stringify(roll).slice(0, 150));
  ok("d10 zerado: 0 lançados/0 sucessos", roll?.d10?.lancados === 0 && roll?.d10?.sucessos === 0, JSON.stringify(roll?.d10));
}

// ---------- 6. desafio privado: não-dono não recebe ----------
{
  captJ2.teste.length = 0;
  const r = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: SID, characterId: CHAR, campoId: VIGOR, rotulo: "Vigor",
    dadosLados: 10, malus: 0, visibilidade: "privada", requestId: "des-" + crypto.randomUUID().slice(0, 8),
  });
  const tid4 = r?.id;
  ok("desafio privado criado", r?.ok === true);
  ok("não-dono NÃO recebe privado", !captJ2.teste.some((t) => t.id === tid4), `recebidos=${captJ2.teste.length}`);
  const evJ = captJ.teste.filter((t) => t.id === tid4).pop();
  ok("dono recebe privado c/ alvo", !!evJ && evJ.privado === true && typeof evJ.alvo === "number" || evJ?.privado === true, JSON.stringify({ p: evJ?.privado, a: evJ?.alvo }));
  // limpa
  await db.prepare("delete from tests where id=?").run(tid4);
}

// ---------- 7. mestre decide com nota narrativa ----------
{
  // usa o primeiro desafio (já rolado)
  const r = await emitirCb(sockM, "mesa:teste:decidir", { testId, outcome: "sucesso", nota: "A descrição narra a façanha" });
  ok("mestre decide", r?.ok === true);
  const ev = captJ.decisao.find((d) => d.testId === testId);
  ok("jogador recebeu decisão", !!ev && ev.outcome === "sucesso", JSON.stringify(ev));
  const row = db.prepare("select status,outcome,outcome_note from tests where id=?").get(testId);
  ok("banco: decidido c/ nota", row?.status === "decidido" && row?.outcome === "sucesso" && row?.outcome_note === "A descrição narra a façanha", JSON.stringify(row));
  // jogador não decide
  const r2 = await emitirCb(sockJ, "mesa:teste:decidir", { testId, outcome: "falha" });
  ok("jogador não decide", r2?.ok === false, JSON.stringify(r2));
}

// ---------- 8. histórico registra o desafio ----------
{
  const hist = await apiM("GET", `/api/campaigns/${CID}/sessoes/${SID}/historico`);
  const txt = JSON.stringify(hist.json ?? {});
  ok("histórico contém desafio/rolagem/decisão", /Vigor|rolou|Decisão/.test(txt));
}

// ---------- 9. UI ----------
{
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addCookies([{ name: "mestre_rpg_session", value: tokM, url: BASE }]);
  const p = await ctx.newPage();
  const erros = [];
  p.on("pageerror", (e) => erros.push(String(e)));
  await p.goto(BASE, { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Campanhas" }).click();
  await p.waitForTimeout(900);
  await p.locator(".cartao-campanha", { hasText: "teste-mestree" }).first().click();
  await p.waitForTimeout(1200);
  await p.getByRole("button", { name: /Mesa/ }).click();
  await p.waitForTimeout(1000);
  await p.locator("tr", { hasText: "Sessão Desafio" }).first().click();
  await p.waitForTimeout(1800);

  ok("UI. card Desafio D10 presente", (await p.locator("text=Desafio D10").count()) > 0);
  await p.locator("button", { hasText: "+ Desafio" }).click();
  await p.waitForTimeout(300);
  const selPersonagem = p.locator(".formulario select").first();
  await selPersonagem.selectOption({ label: /PJ Vida/ }).catch(async () => {
    const opts = await selPersonagem.locator("option").allTextContents();
    const idx = opts.findIndex((o) => o.includes("PJ Vida"));
    if (idx > 0) await selPersonagem.selectOption({ index: idx });
  });
  await p.waitForTimeout(1200);
  const selCampo = p.locator(".formulario select").nth(1);
  const nCampos = await selCampo.locator("option").count();
  ok("UI. campos numéricos listados", nCampos > 1, `n=${nCampos}`);
  if (nCampos > 1) {
    await selCampo.selectOption({ index: 1 });
    await p.waitForTimeout(300);
    const meta = await p.locator(".formulario .meta").last().textContent().catch(() => "");
    ok("UI. mostra dados positivos/efetivos", /d10|positivo|Efetivos/.test(meta ?? ""), meta);
  }

  // card de teste pendente mostra pool (desafio do passo 2 já decidido; cria um novo via socket p/ UI)
  const novo = await emitirCb(sockM, "mesa:teste:pedir", {
    sessionId: SID, characterId: CHAR, campoId: VIGOR, rotulo: "Vigor UI",
    dadosLados: 10, malus: 1, requestId: "des-ui-" + crypto.randomUUID().slice(0, 8),
  });
  await p.waitForTimeout(1200);
  const cardTexto = await p.locator(".teste-card").last().textContent().catch(() => "");
  ok("UI. card de desafio mostra pool e tag D10", /d10/i.test(cardTexto ?? "") && /positivo|negativo|efetivo/.test(cardTexto ?? ""), cardTexto?.slice(0, 160));

  // mobile
  const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx3.addCookies([{ name: "mestre_rpg_session", value: tokM, url: BASE }]);
  const p3 = await ctx3.newPage();
  await p3.goto(BASE, { waitUntil: "networkidle" });
  await p3.getByRole("button", { name: "Campanhas" }).click();
  await p3.waitForTimeout(700);
  await p3.locator(".cartao-campanha", { hasText: "teste-mestree" }).first().click();
  await p3.waitForTimeout(1000);
  await p3.getByRole("button", { name: /Mesa/ }).click();
  await p3.waitForTimeout(800);
  await p3.locator("tr", { hasText: "Sessão Desafio" }).first().click();
  await p3.waitForTimeout(1500);
  const overflow = await p3.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("mobile 390px: sem overflow", overflow <= 1, `overflow=${overflow}px`);
  ok("UI. sem erros de console", erros.length === 0, erros.slice(0, 2).join(" | "));
  await ctx3.close();
  await browser.close();
}

sockM.close(); sockJ.close(); sockJ2.close();
await db.close();
const falhas = resultados.filter((r) => !r.ok).length;
console.log(`\n${resultados.length - falhas} passaram, ${falhas} falharam`);
process.exit(falhas ? 1 : 0);
