// Testes do Lançador D10: mecânica de pool (positivos − negativos),
// contagem de sucessos pela meta configurável, persistência no histórico
// e integração com chat/rolagens da mesa.
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { io as ioClient } from "socket.io-client";
import { hashToken } from "./servidor/dist/lib/password.js";

const BASE = "http://localhost:3001";
const CID = "179dd61c-6f4e-4c54-bf88-1e255a506743";
const resultados = [];
const ok = (nome, cond, extra = "") => {
  resultados.push({ nome, ok: !!cond });
  console.log(`${cond ? "ok" : "FALHOU"} ${nome}${extra ? " — " + extra : ""}`);
};

const db = new Database("banco/mestre-rpg.db");
const sessao = (userId, tag) => {
  const token = `${tag}-` + crypto.randomUUID();
  db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), userId, hashToken(token), "teste-d10", "127.0.0.1", Date.now() + 3600000, Date.now());
  return token;
};
const admin = db.prepare("select id from users where username='administrador'").get();
const jog = db.prepare("select id from users where username='jogador_teste'").get();
if (!db.prepare("select id from memberships where campaign_id=? and user_id=?").get(CID, jog.id)) {
  db.prepare("insert into memberships (id,campaign_id,user_id,role,permissions,status,joined_at,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), CID, jog.id, "jogador", "{}", "ativo", Date.now(), Date.now(), Date.now());
}
const tokM = sessao(admin.id, "d10-m");
const tokJ = sessao(jog.id, "d10-j");
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

// ---------- configuração da meta de sucesso ----------
{
  const put = await apiM("PUT", `/api/campaigns/${CID}/regras/config`, { dados: { d10SucessoMinimo: 8 } });
  ok("config D10 salva", put.status === 200, `status=${put.status}`);
  const regras = await apiM("GET", `/api/campaigns/${CID}/regras`);
  ok("config D10 lida", regras.json?.config?.dados?.d10SucessoMinimo === 8, JSON.stringify(regras.json?.config?.dados));
  const putInvalido = await apiM("PUT", `/api/campaigns/${CID}/regras/config`, { dados: { d10SucessoMinimo: 15 } });
  ok("meta fora de 2-10 rejeitada", putInvalido.status === 400, `status=${putInvalido.status}`);
  await apiM("PUT", `/api/campaigns/${CID}/regras/config`, { dados: { d10SucessoMinimo: 6 } });
}

// ---------- sessão e sockets ----------
const s = await apiM("POST", `/api/campaigns/${CID}/sessoes`, { name: "Sessão D10" });
const SID = s.json?.sessao?.id;
ok("sessão criada", !!SID, `status=${s.status}`);

const sockM = ioClient(BASE, { extraHeaders: { cookie: `mestre_rpg_session=${tokM}` }, transports: ["polling", "websocket"] });
const sockJ = ioClient(BASE, { extraHeaders: { cookie: `mestre_rpg_session=${tokJ}` }, transports: ["polling", "websocket"] });
await Promise.all([new Promise((r) => sockM.on("connect", r)), new Promise((r) => sockJ.on("connect", r))]);
const emitirCb = (sock, ev, payload) => new Promise((res) => sock.emit(ev, payload, res));

// ---------- rolagem D10 básica ----------
{
  const roll = await emitirCb(sockJ, "mesa:rolar", {
    sessionId: SID, dados: [{ sides: 10, count: 5 }],
    motivo: "D10 teste", d10: { positivos: 5, negativos: 0, minimo: 6 },
    requestId: "d10-" + crypto.randomUUID().slice(0, 8),
  });
  ok("rolagem D10 ok", roll?.ok === true, JSON.stringify(roll).slice(0, 200));
  const d = roll?.d10;
  const res = roll?.grupos?.[0]?.resultados ?? [];
  ok("5 dados lançados", d?.lancados === 5 && res.length === 5, `lancados=${d?.lancados}`);
  const esperado = res.filter((v) => v >= 6).length;
  ok("sucessos contam valores >= 6", d?.sucessos === esperado && d?.falhas === 5 - esperado, `s=${d?.sucessos} f=${d?.falhas} esp=${esperado}`);
  ok("resultados entre 1 e 10", res.every((v) => v >= 1 && v <= 10), res.join(","));
}

// ---------- dados negativos ----------
{
  const roll = await emitirCb(sockJ, "mesa:rolar", {
    sessionId: SID, dados: [{ sides: 10, count: 2 }],
    motivo: "D10 6-4", d10: { positivos: 6, negativos: 4, minimo: 6 },
    requestId: "d10-" + crypto.randomUUID().slice(0, 8),
  });
  ok("6 positivos − 4 negativos = 2 lançados", roll?.d10?.lancados === 2 && roll?.grupos?.[0]?.resultados?.length === 2, JSON.stringify(roll?.d10));
  ok("negativos registrados", roll?.d10?.negativos === 4 && roll?.d10?.positivos === 6);
}

// ---------- negativos >= positivos ----------
{
  const roll = await emitirCb(sockM, "mesa:rolar", {
    sessionId: SID, dados: [{ sides: 10, count: 1 }],
    motivo: "edge", d10: { positivos: 3, negativos: 5, minimo: 6 },
    requestId: "d10-" + crypto.randomUUID().slice(0, 8),
  });
  ok("efeito negativo total é rejeitado (efetivos=0 ≠ 1 dado)", roll?.ok === false, JSON.stringify(roll));
}

// ---------- validações ----------
{
  const r1 = await emitirCb(sockJ, "mesa:rolar", {
    sessionId: SID, dados: [{ sides: 10, count: 3 }],
    d10: { positivos: 5, negativos: 0, minimo: 6 },
    requestId: "d10-" + crypto.randomUUID().slice(0, 8),
  });
  ok("count inconsistente com pool -> erro", r1?.ok === false, JSON.stringify(r1));
  const r2 = await emitirCb(sockJ, "mesa:rolar", {
    sessionId: SID, dados: [{ sides: 10, count: 3 }],
    d10: { positivos: 3, negativos: 0, minimo: 15 },
    requestId: "d10-" + crypto.randomUUID().slice(0, 8),
  });
  ok("mínimo inválido -> erro", r2?.ok === false, JSON.stringify(r2));
  const r3 = await emitirCb(sockJ, "mesa:rolar", {
    sessionId: SID, dados: [{ sides: 20, count: 3 }],
    d10: { positivos: 3, negativos: 0, minimo: 6 },
    requestId: "d10-" + crypto.randomUUID().slice(0, 8),
  });
  ok("grupo não-d10 -> erro", r3?.ok === false, JSON.stringify(r3));
}

// ---------- persistência e chat ----------
{
  const msgs = await apiM("GET", `/api/campaigns/${CID}/sessoes/${SID}/mensagens?limite=50`);
  const msgD10 = (msgs.json?.mensagens ?? []).find((m) => m.kind === "rolagem" && /D10/.test(m.content ?? ""));
  ok("chat registra rolagem D10 com sucessos", !!msgD10 && /sucessos/.test(msgD10.content), msgD10?.content?.slice(0, 120));
  const hist = await apiM("GET", `/api/campaigns/${CID}/sessoes/${SID}/historico`);
  const txt = JSON.stringify(hist.json ?? {});
  ok("histórico contém rolagem D10", /D10|rolou/.test(txt));
}

// ---------- UI ----------
{
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await ctx.addCookies([{ name: "mestre_rpg_session", value: tokM, url: BASE }]);
  const p = await ctx.newPage();
  const erros = [];
  p.on("pageerror", e => erros.push(String(e)));
  await p.goto(BASE, { waitUntil: "networkidle" });
  await p.getByRole("button", { name: "Campanhas" }).click();
  await p.waitForTimeout(900);
  await p.locator(".cartao-campanha", { hasText: "teste-mestree" }).first().click();
  await p.waitForTimeout(1200);
  await p.getByRole("button", { name: /Mesa/ }).click();
  await p.waitForTimeout(1000);
  await p.locator("tr", { hasText: "Sessão D10" }).first().click();
  await p.waitForTimeout(1500);

  ok("UI. card Lançador D10 presente", await p.locator("text=Lançador D10").count() > 0);
  // define 4 positivos, 1 negativo -> 3 efetivos
  const inputs = p.locator(".d10-controles input");
  await inputs.nth(0).fill("4");
  await inputs.nth(1).fill("1");
  const meta = await p.locator(".d10-form .meta").first().textContent();
  ok("UI. efetivos calculados (4−1=3)", !!meta && meta.includes("3"), meta);
  await p.locator(".d10-form button[type=submit]").click();
  await p.waitForTimeout(2500);
  const nFaces = await p.locator(".d10-face").count();
  ok("UI. 3 dados animados", nFaces === 3, `n=${nFaces}`);
  const resumo = await p.locator(".d10-resumo").textContent();
  ok("UI. resumo com sucessos/falhas/negativos", !!resumo && resumo.includes("Sucessos") && resumo.includes("Negativos"), resumo);
  const chipTotal = await p.locator(".d10-chip-total").textContent();
  ok("UI. resultado final visível", !!chipTotal && /Resultado: \d+ sucesso/.test(chipTotal), chipTotal);

  // dados negativos >= positivos -> mensagem local sem rolagem
  await inputs.nth(0).fill("2");
  await inputs.nth(1).fill("5");
  await p.locator(".d10-form button[type=submit]").click();
  await p.waitForTimeout(400);
  const zero = await p.locator(".d10-resultado .meta").first().textContent().catch(() => "");
  ok("UI. pool zerado mostra aviso", /Nenhum dado efetivo/.test(zero ?? ""), zero);

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
  await p3.locator("tr", { hasText: "Sessão D10" }).first().click();
  await p3.waitForTimeout(1500);
  const overflow = await p3.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("mobile 390px: sem overflow", overflow <= 1, `overflow=${overflow}px`);
  ok("UI. sem erros de console", erros.length === 0, erros.slice(0, 2).join(" | "));
  await ctx3.close();
  await browser.close();
}

await db.close();
const falhas = resultados.filter(r => !r.ok).length;
console.log(`\n${resultados.length - falhas} passaram, ${falhas} falharam`);
process.exit(falhas ? 1 : 0);
