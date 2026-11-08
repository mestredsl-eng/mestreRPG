// Testes: elegibilidade de campos para Desafio D10 (Etapa C).
// Cobre: usadoEmTestes true/false/ausente, fallback por semântica, tipos
// não numéricos, moeda/item, e rejeição no backend via socket real.
import Database from "better-sqlite3";
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
const admin = db.prepare("select id from users where username='administrador'").get();
const jog = db.prepare("select id from users where username='jogador_teste'").get();

// ---------- fixture: modelo com todos os casos de elegibilidade ----------
const campos = [
  // [id, label, tipo, semantico, usadoEmTestes (undefined = chave ausente), valor]
  ["el_true_livre",   "Teste True Livre",   "inteiro", "livre",       true,   4],
  ["el_false_attr",   "Teste False Atributo","inteiro", "atributo",    false,  9],
  ["el_fb_attr",      "Teste FB Atributo",   "inteiro", "atributo",    undefined, 3],
  ["el_fb_hab",       "Teste FB Habilidade", "inteiro", "habilidade", undefined, 5],
  ["el_fb_conh",      "Teste FB Conhec",     "inteiro", "conhecimento",undefined, 6],
  ["el_fb_tal",       "Teste FB Talento",    "inteiro", "talento",     undefined, 7],
  ["el_fb_livre",     "Teste FB Livre",      "inteiro", "livre",       undefined, 8],
  ["el_fb_prof",      "Teste FB Profissao",  "inteiro", "profissao",   undefined, 9],
  ["el_moeda",        "Teste Moeda",         "moeda",   "moeda",       true,   10],
  ["el_item",         "Teste Item",          "inteiro", "item",        true,   11],
  ["el_texto",        "Teste Texto",         "texto",   "livre",       true,   null],
  ["el_calc",         "Teste Calculado",     "calculado","atributo",   true,   null],
];
const estrutura = {
  versao: 1,
  pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
  secoes: [{
    id: "s1", titulo: "Atributos", ordem: 0,
    campos: campos.map(([id, label, tipo, semantico, flag]) => ({
      id, label, tipo, semantico,
      ...(flag === undefined ? {} : { usadoEmTestes: flag }),
      padrao: 0,
    })),
  }],
};
const dados = {};
for (const [id, , , , , v] of campos) if (typeof v === "number") dados[id] = v;

const mem = db.prepare("select id from memberships where campaign_id=? and user_id=? and status='ativo'").get(CID, jog.id);
if (!mem) { console.error("membership de jogador_teste ausente — rode teste-d10-desafio antes"); process.exit(1); }

const tplId = crypto.randomUUID();
const verId = crypto.randomUUID();
const charId = crypto.randomUUID();
const agora = Date.now();
db.prepare("insert into sheet_templates (id,name,description,owner_id,current_version_id,created_at,updated_at,campaign_id,is_active,is_default) values (?,?,?,?,?,?,?,?,?,?)")
  .run(tplId, "MODELO-ELEGIBILIDADE-TESTE", "fixture temporário", admin.id, verId, agora, agora, CID, 1, 0);
db.prepare("insert into sheet_versions (id,template_id,version,structure,published_at,created_at) values (?,?,?,?,?,?)")
  .run(verId, tplId, 1, JSON.stringify(estrutura), agora, agora);
db.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,status,created_at,updated_at,overrides) values (?,?,?,?,?,?,?,?,?,?)")
  .run(charId, CID, mem.id, verId, "Perso Elegibilidade", JSON.stringify(dados), "aprovada", agora, agora, "{}");

// sessão + tokens + socket do mestre
const token = "eleg-" + crypto.randomUUID();
db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
  .run(crypto.randomUUID(), admin.id, hashToken(token), "teste-eleg", "127.0.0.1", Date.now() + 3600000, Date.now());

async function req(m, path, body) {
  const r = await fetch(BASE + path, {
    method: m,
    headers: { "content-type": "application/json", cookie: `mestre_rpg_session=${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}

const s = await req("POST", `/api/campaigns/${CID}/sessoes`, { name: "Sessão Elegibilidade" });
const SID = s.json?.sessao?.id;
ok("sessão criada", !!SID, JSON.stringify(s.json ?? s.status));

const sock = ioClient(BASE, { extraHeaders: { cookie: `mestre_rpg_session=${token}` }, transports: ["polling", "websocket"] });
await new Promise((r) => sock.on("connect", r));
const entrar = await new Promise((res) => sock.emit("mesa:entrar", { sessionId: SID }, res));
ok("mestre entrou na mesa", entrar?.ok === true, JSON.stringify(entrar));
const emitir = (ev, payload) => new Promise((res) => sock.emit(ev, payload, res));
const criados = [];

// ---------- elegibilidade via backend ----------
const casos = [
  ["el_true_livre",   true,  "usadoEmTestes:true com semântica livre → elegível"],
  ["el_false_attr",   false, "usadoEmTestes:false com semântica atributo → NÃO elegível"],
  ["el_fb_attr",      true,  "sem flag + atributo → elegível (fallback)"],
  ["el_fb_hab",       true,  "sem flag + habilidade → elegível (fallback)"],
  ["el_fb_conh",      true,  "sem flag + conhecimento → elegível (fallback)"],
  ["el_fb_tal",       true,  "sem flag + talento → elegível (fallback)"],
  ["el_fb_livre",     false, "sem flag + livre numérico → NÃO elegível"],
  ["el_fb_prof",      false, "sem flag + profissão → NÃO elegível"],
  ["el_moeda",        false, "moeda mesmo com usadoEmTestes:true → NÃO elegível"],
  ["el_item",         false, "item mesmo com usadoEmTestes:true → NÃO elegível"],
  ["el_texto",        false, "texto mesmo com usadoEmTestes:true → NÃO elegível"],
  ["el_calc",         false, "calculado mesmo com usadoEmTestes:true → NÃO elegível"],
  ["nao_existe",      false, "campo inexistente → rejeitado"],
];
for (const [campoId, esperado, nome] of casos) {
  const r = await emitir("mesa:teste:pedir", {
    sessionId: SID, characterId: charId, campoId, rotulo: campoId,
    dadosLados: 10, requestId: "eleg-" + crypto.randomUUID().slice(0, 8),
  });
  const elegivel = r?.ok === true;
  ok(nome, elegivel === esperado, JSON.stringify(r));
  if (elegivel && r?.id) criados.push(r.id);
}

// pool efetivo zero: campo elegível com valor 0 não pode gerar dados
{
  db.prepare("update characters set data=? where id=?")
    .run(JSON.stringify({ ...dados, el_fb_attr: 0 }), charId);
  const r = await emitir("mesa:teste:pedir", {
    sessionId: SID, characterId: charId, campoId: "el_fb_attr", rotulo: "Zerado",
    dadosLados: 10, malus: 0, requestId: "eleg-" + crypto.randomUUID().slice(0, 8),
  });
  const row = r?.id ? db.prepare("select dice_count,dice_sides from tests where id=?").get(r.id) : null;
  ok("pool zero → 0 dados (ou rejeitado)", r?.ok === false || (row && row.dice_count === 0 && row.dice_sides === 10), JSON.stringify(row ?? r));
  if (r?.id) criados.push(r.id);
  db.prepare("update characters set data=? where id=?").run(JSON.stringify(dados), charId);
}

// ---------- frontend: seletor mostra só elegíveis ----------
try {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: "mestre_rpg_session", value: token, url: BASE }]);
  const p = await ctx.newPage();
  await p.goto(BASE, { waitUntil: "networkidle" });
  const clicou = async (sel, txt) => { try { await p.locator(sel, { hasText: txt }).first().click({ timeout: 4000 }); return true; } catch { return false; } };
  await clicou(".topo nav button", "Campanhas");
  await p.waitForTimeout(600);
  const card = p.locator(".cartao-campanha", { hasText: "teste-mestree" }).first();
  if (await card.count()) await card.click(); else await p.locator(".cartao-campanha").first().click();
  await p.waitForTimeout(900);
  await clicou(".abas button", "Mesa");
  await p.waitForTimeout(700);
  const sessaoRow = p.locator("table.tabela tbody tr.clicavel", { hasText: "Elegibilidade" }).first();
  if (await sessaoRow.count()) {
    await sessaoRow.click();
    await p.waitForTimeout(1200);
    await clicou("button", "+ Desafio");
    await p.waitForTimeout(300);
    await p.locator(".formulario select").first().selectOption(charId);
    await p.waitForTimeout(900);
    const opcoes = await p.locator(".formulario select").nth(1).locator("option").allTextContents();
    const tem = (txt) => opcoes.some((o) => o.includes(txt));
    ok("UI: true-livre aparece", tem("Teste True Livre"));
    ok("UI: fb atributo aparece", tem("Teste FB Atributo"));
    ok("UI: fb habilidade aparece", tem("Teste FB Habilidade"));
    ok("UI: fb conhecimento aparece", tem("Teste FB Conhec"));
    ok("UI: fb talento aparece", tem("Teste FB Talento"));
    ok("UI: false NÃO aparece", !tem("Teste False Atributo"));
    ok("UI: livre NÃO aparece", !tem("Teste FB Livre"));
    ok("UI: profissão NÃO aparece", !tem("Teste FB Profissao"));
    ok("UI: moeda NÃO aparece", !tem("Teste Moeda"));
    ok("UI: item NÃO aparece", !tem("Teste Item"));
  } else {
    console.log("  (sessão não encontrada na UI — pulando verificação visual)");
    resultados.push({ nome: "UI: sessão encontrada", ok: false });
  }
  await browser.close();
} catch (e) {
  console.log("  UI indisponível:", String(e).slice(0, 120));
  resultados.push({ nome: "UI executada", ok: false });
}

// ---------- limpeza ----------
sock.disconnect();
for (const id of criados) db.prepare("delete from tests where id=?").run(id);
db.prepare("delete from characters where id=?").run(charId);
db.prepare("delete from sheet_versions where id=?").run(verId);
db.prepare("delete from sheet_templates where id=?").run(tplId);

const falhas = resultados.filter((r) => !r.ok);
console.log(`\n${resultados.length - falhas.length} passaram, ${falhas.length} falharam`);
process.exit(falhas.length ? 1 : 0);
