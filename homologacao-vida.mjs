// Homologação: Pontos de Vida (HP) e Vitalidade.
// Cobre cálculo de HP máximo por atributo, dano/recuperação/ajuste,
// limites, histórico, permissões, escala de vitalidade, penalidade de
// dados nas rolagens (socket), bloqueio de incapacitado e independência.
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { io as ioClient } from "socket.io-client";
import { hashToken } from "./servidor/dist/lib/password.js";

const BASE = "http://localhost:3001";
const CID = "179dd61c-6f4e-4c54-bf88-1e255a506743";
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
    .run(crypto.randomUUID(), userId, hashToken(token), "hom-vida", "127.0.0.1", Date.now() + 3600000, Date.now());
  return token;
};
const admin = db.prepare("select id from users where username='administrador'").get();
const jog = db.prepare("select id from users where username='jogador_teste'").get();
if (!db.prepare("select id from memberships where campaign_id=? and user_id=?").get(CID, jog.id)) {
  db.prepare("insert into memberships (id,campaign_id,user_id,role,permissions,status,joined_at,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), CID, jog.id, "jogador", "{}", "ativo", Date.now(), Date.now(), Date.now());
}
const tokM = sessao(admin.id, "vida-m");
const tokJ = sessao(jog.id, "vida-j");
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
const vida = async (id, api = apiJ) => (await api("GET", `/api/characters/${id}`)).json?.ficha?.vida;

// garante config hp+vitalidade na campanha
await apiM("PUT", `/api/campaigns/${CID}/regras/config`, {
  hp: { habilitado: true, base: 100, porNivel: 20, campoId: VIGOR, edicaoPor: "ambos" },
  vitalidade: { edicaoPor: "ambos" },
});

// ---------- cria personagem e confere HP inicial ----------
const novo = await apiJ("POST", `/api/campaigns/${CID}/characters`, { name: "PJ Vida" });
ok("criar PJ Vida", novo.status === 201 || novo.status === 200, `status=${novo.status}`);
const charId = novo.json?.personagem?.id;
let v = await vida(charId);
ok("HP máximo Vigor 0 = 100", v?.hp?.maximo === 100, `max=${v?.hp?.maximo}`);
ok("HP atual começa cheio", v?.hp?.atual === 100, `atual=${v?.hp?.atual}`);
ok("histórico inicial registrado", v?.hp?.historico?.[0]?.tipo === "inicial");
ok("vitalidade nível 0 (Escoriado)", v?.vitalidade?.nivel === 0 && v?.vitalidade?.nome === "Escoriado");

// ---------- muda Vigor -> HP máximo recalcula, atual preservado ----------
await apiJ("PATCH", `/api/characters/${charId}`, { data: { [VIGOR]: 3 } });
v = await vida(charId);
ok("Vigor 3 -> HP máximo 160", v?.hp?.maximo === 160, `max=${v?.hp?.maximo}`);
ok("HP atual preservado em 100 (não cura)", v?.hp?.atual === 100, `atual=${v?.hp?.atual}`);

// ---------- dano / recuperação / limites ----------
{
  let r = await apiJ("POST", `/api/characters/${charId}/hp`, { acao: "dano", quantidade: 25, motivo: "Ferimento em combate" });
  ok("dano 25 -> atual 75", r.json?.hp?.atual === 75, `atual=${r.json?.hp?.atual}`);
  r = await apiJ("POST", `/api/characters/${charId}/hp`, { acao: "recuperar", quantidade: 50, motivo: "Tratamento" });
  ok("recuperar 50 -> atual 125", r.json?.hp?.atual === 125, `atual=${r.json?.hp?.atual}`);
  r = await apiJ("POST", `/api/characters/${charId}/hp`, { acao: "recuperar", quantidade: 999 });
  ok("recuperação não passa do máximo (160)", r.json?.hp?.atual === 160, `atual=${r.json?.hp?.atual}`);
  r = await apiJ("POST", `/api/characters/${charId}/hp`, { acao: "dano", quantidade: 999 });
  ok("dano não deixa HP negativo (0)", r.json?.hp?.atual === 0, `atual=${r.json?.hp?.atual}`);
  r = await apiJ("POST", `/api/characters/${charId}/hp`, { acao: "dano", quantidade: 10 });
  ok("dano em HP zero rejeitado", r.status === 400, `status=${r.status}`);
  r = await apiJ("POST", `/api/characters/${charId}/hp`, { acao: "ajuste", quantidade: -30, motivo: "Correção do mestre" });
  ok("ajuste negativo em HP zero rejeitado", r.status === 400, `status=${r.status} ${r.json?.erro}`);
  r = await apiJ("POST", `/api/characters/${charId}/hp`, { acao: "ajuste", quantidade: 40 });
  ok("ajuste +40 -> atual 40", r.json?.hp?.atual === 40, `atual=${r.json?.hp?.atual}`);
  r = await apiJ("POST", `/api/characters/${charId}/hp`, { acao: "ajuste", quantidade: -30, motivo: "Correção" });
  ok("ajuste -30 -> atual 10", r.json?.hp?.atual === 10, `atual=${r.json?.hp?.atual}`);
  await apiJ("POST", `/api/characters/${charId}/hp`, { acao: "ajuste", quantidade: 30 });
  v = await vida(charId);
  const tipos = (v?.hp?.historico ?? []).map((e) => e.tipo);
  ok("histórico tem dano/recuperacao/ajuste", tipos.includes("dano") && tipos.includes("recuperacao") && tipos.includes("ajuste"), tipos.join(","));
  ok("histórico tem motivo e autor", (v?.hp?.historico ?? []).some((e) => e.motivo === "Ferimento em combate" && e.autorNome));
}

// ---------- permissões HP: config mestre-only ----------
{
  await apiM("PUT", `/api/campaigns/${CID}/regras/config`, { hp: { edicaoPor: "mestre" } });
  const r = await apiJ("POST", `/api/characters/${charId}/hp`, { acao: "dano", quantidade: 5 });
  ok("jogador sem permissão HP -> 403", r.status === 403, `status=${r.status}`);
  const r2 = await apiM("POST", `/api/characters/${charId}/hp`, { acao: "dano", quantidade: 5 });
  ok("mestre aplica dano -> 200", r2.status === 200 && r2.json?.hp?.atual === 35, `atual=${r2.json?.hp?.atual}`);
  await apiM("PUT", `/api/campaigns/${CID}/regras/config`, { hp: { edicaoPor: "ambos" } });
}

// ---------- vitalidade: escala e independência ----------
{
  const r = await apiJ("POST", `/api/characters/${charId}/vitalidade`, { nivel: 3 });
  ok("vitalidade -> Ferido gravemente", r.json?.vitalidade?.nome === "Ferido gravemente" && r.json?.vitalidade?.penalidadeDados === 2, JSON.stringify(r.json?.vitalidade?.nome));
  v = await vida(charId);
  ok("vitalidade não alterou HP", v?.hp?.atual === 35, `hp=${v?.hp?.atual}`);
  ok("7 níveis na escala", v?.vitalidade?.niveis?.length === 7);
  const rInv = await apiJ("POST", `/api/characters/${charId}/vitalidade`, { nivel: 99 });
  ok("nível inválido -> 400", rInv.status === 400, `status=${rInv.status}`);
  await apiM("PUT", `/api/campaigns/${CID}/regras/config`, { vitalidade: { edicaoPor: "mestre" } });
  const r2 = await apiJ("POST", `/api/characters/${charId}/vitalidade`, { nivel: 1 });
  ok("jogador sem permissão vitalidade -> 403", r2.status === 403, `status=${r2.status}`);
  await apiM("POST", `/api/characters/${charId}/vitalidade`, { nivel: 3 });
  await apiM("PUT", `/api/campaigns/${CID}/regras/config`, { vitalidade: { edicaoPor: "ambos" } });
  // HP intacto após troca de vitalidade
  v = await vida(charId);
  ok("HP continua 35 após vitalidade", v?.hp?.atual === 35, `hp=${v?.hp?.atual}`);
}

// ---------- persistência ----------
{
  v = await vida(charId, apiM);
  ok("reload: HP 35/160", v?.hp?.atual === 35 && v?.hp?.maximo === 160, `hp=${v?.hp?.atual}/${v?.hp?.maximo}`);
  ok("reload: vitalidade nível 3", v?.vitalidade?.nivel === 3);
}

// ---------- rolagens com penalidade de vitalidade (socket) ----------
{
  const s = await apiM("POST", `/api/campaigns/${CID}/sessoes`, { name: "Sessão Vida" });
  const SID = s.json?.sessao?.id;
  ok("sessão criada", !!SID, `status=${s.status}`);

  const sockM = ioClient(BASE, { extraHeaders: { cookie: `mestre_rpg_session=${tokM}` }, transports: ["polling", "websocket"] });
  const sockJ = ioClient(BASE, { extraHeaders: { cookie: `mestre_rpg_session=${tokJ}` }, transports: ["polling", "websocket"] });
  await Promise.all([new Promise((r) => sockM.on("connect", r)), new Promise((r) => sockJ.on("connect", r))]);
  const emitirCb = (sock, ev, payload) => new Promise((res) => sock.emit(ev, payload, res));
  const esperar = (sock, ev, pred = () => true, ms = 6000) => new Promise((res) => {
    const h = (d) => { if (pred(d)) { clearTimeout(t); sock.off(ev, h); res(d); } };
    const t = setTimeout(() => { sock.off(ev, h); res(null); }, ms);
    sock.on(ev, h);
  });

  // mestre pede teste de 6d20 para o PJ Vida
  const pedir = await emitirCb(sockM, "mesa:teste:pedir", { sessionId: SID, characterId: charId, dadosLados: 20, dadosCount: 6, requestId: "vida-t1-" + crypto.randomUUID().slice(0, 8) });
  ok("mestre pede teste", pedir?.ok === true, JSON.stringify(pedir));
  const testId = pedir?.id;
  const esperaRoll = esperar(sockJ, "mesa:rolagem", (r) => r.testId === testId);

  // jogador rola: vitalidade nível 3 (−2) -> deve rolar 4d20
  const roll = await emitirCb(sockJ, "mesa:teste:rolar", { testId, requestId: "vida-r1-" + crypto.randomUUID().slice(0, 8) });
  const rol = await esperaRoll;
  ok("rolagem retornou ok", roll?.ok === true, JSON.stringify(roll).slice(0, 200));
  ok("penalidade -2: 6d -> 4d", rol?.vitalidade?.dadosFinais === 4 && rol?.vitalidade?.dadosOriginais === 6, JSON.stringify(rol?.vitalidade));
  ok("4 resultados de dados", rol?.dados?.length === 4, `n=${rol?.dados?.length}`);
  ok("vitalidade identificada no payload", rol?.vitalidade?.nome === "Ferido gravemente", rol?.vitalidade?.nome);

  // Aleijado (nível 5, −5): teste de 3d20 -> 0 dados
  await apiM("POST", `/api/characters/${charId}/vitalidade`, { nivel: 5 });
  const pedir2 = await emitirCb(sockM, "mesa:teste:pedir", { sessionId: SID, characterId: charId, dadosLados: 20, dadosCount: 3, requestId: "vida-t2-" + crypto.randomUUID().slice(0, 8) });
  const testId2 = pedir2?.id;
  const esperaRoll2 = esperar(sockJ, "mesa:rolagem", (r) => r.testId === testId2);
  const roll2 = await emitirCb(sockJ, "mesa:teste:rolar", { testId: testId2, requestId: "vida-r2-" + crypto.randomUUID().slice(0, 8) });
  const rol2 = await esperaRoll2;
  ok("penalidade supera dados -> 0 dados", rol2?.vitalidade?.dadosFinais === 0 && rol2?.dados?.length === 0, JSON.stringify(rol2?.vitalidade));
  ok("total 0 sem dados negativos", rol2?.total === 0, `total=${rol2?.total}`);

  // Incapacitado (nível 6): jogador bloqueado, mestre autoriza exceção
  await apiM("POST", `/api/characters/${charId}/vitalidade`, { nivel: 6 });
  const pedir3 = await emitirCb(sockM, "mesa:teste:pedir", { sessionId: SID, characterId: charId, dadosLados: 20, dadosCount: 2, requestId: "vida-t3-" + crypto.randomUUID().slice(0, 8) });
  const testId3 = pedir3?.id;
  const rollBloq = await emitirCb(sockJ, "mesa:teste:rolar", { testId: testId3 });
  ok("incapacitado bloqueia jogador", rollBloq?.ok === false && /Incapacitado/i.test(rollBloq?.erro ?? ""), JSON.stringify(rollBloq));
  const esperaRoll3 = esperar(sockM, "mesa:rolagem", (r) => r.testId === testId3);
  const rollM = await emitirCb(sockM, "mesa:teste:rolar", { testId: testId3, requestId: "vida-r3-" + crypto.randomUUID().slice(0, 8) });
  const rol3 = await esperaRoll3;
  ok("mestre autoriza exceção", rollM?.ok === true && rol3?.vitalidade?.excecaoMestre === true, JSON.stringify(rol3?.vitalidade));

  // volta vitalidade p/ teste de UI
  await apiM("POST", `/api/characters/${charId}/vitalidade`, { nivel: 3 });
  sockM.close(); sockJ.close();
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
  await p.getByRole("button", { name: /Personagens/ }).click();
  await p.waitForTimeout(800);
  await p.locator("tr", { hasText: "PJ Vida" }).first().click();
  await p.waitForTimeout(1500);

  const hpAtual = await p.locator(".hp-atual").first().textContent().catch(() => null);
  ok("UI. HP 35/160 visível", !!hpAtual && hpAtual.includes("35") && hpAtual.includes("160"), hpAtual);
  const barra = await p.locator(".hp-preenchimento").first().evaluate((el) => el.style.width).catch(() => null);
  ok("UI. barra de vida ~22%", !!barra && barra.startsWith("21"), barra);
  const vitAtual = await p.locator(".vit-nivel.atual .vit-nome").first().textContent().catch(() => null);
  ok("UI. vitalidade atual destacada", vitAtual === "Ferido gravemente", vitAtual);
  const nVit = await p.locator(".vit-nivel").count();
  ok("UI. 7 níveis de vitalidade", nVit === 7, `n=${nVit}`);
  const nHist = await p.locator(".hp-evento").count();
  ok("UI. histórico de HP visível", nHist >= 3, `n=${nHist}`);

  // mobile
  const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx3.addCookies([{ name: "mestre_rpg_session", value: tokM, url: BASE }]);
  const p3 = await ctx3.newPage();
  await p3.goto(BASE, { waitUntil: "networkidle" });
  await p3.getByRole("button", { name: "Campanhas" }).click();
  await p3.waitForTimeout(700);
  await p3.locator(".cartao-campanha", { hasText: "teste-mestree" }).first().click();
  await p3.waitForTimeout(1000);
  await p3.getByRole("button", { name: /Personagens/ }).click();
  await p3.waitForTimeout(800);
  await p3.locator("tr", { hasText: "PJ Vida" }).first().click();
  await p3.waitForTimeout(1500);
  const overflow = await p3.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok("mobile 390px: sem overflow", overflow <= 1, `overflow=${overflow}px`);
  await ctx3.close();
  ok("UI. sem erros de console", erros.length === 0, erros.slice(0, 2).join(" | "));
  await browser.close();
}

await db.close();
const falhas = resultados.filter(r => !r.ok).length;
console.log(`\n${resultados.length - falhas} passaram, ${falhas} falharam`);
process.exit(falhas ? 1 : 0);
