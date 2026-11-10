// Homologação — histórico completo de HP na ficha (PR #26).
// Sobe o servidor buildado contra CÓPIA isolada do banco, semeia um
// personagem com 12 eventos de HP e valida a UI com Playwright real:
// 8 eventos iniciais, "Ver histórico completo", "Mostrar recentes",
// histórico vazio e histórico curto — desktop e mobile.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { chromium } from "playwright";
import { hashToken } from "./servidor/dist/lib/password.js";

const DIR = "simulacao-limpeza/teste-hp-historico";
const BANCO = `${DIR}/mestre-rpg-teste.db`;
mkdirSync(DIR, { recursive: true });
for (const suf of ["", "-wal", "-shm"]) rmSync(BANCO + suf, { force: true });
{
  const orig = new Database("banco/mestre-rpg.db", { readonly: true });
  orig.prepare(`VACUUM INTO '${BANCO.replace(/\\/g, "/")}'`).run();
  orig.close();
}

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

function portaLivre() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
  });
}
async function esperarSaudavel(base, proc) {
  const limite = Date.now() + 30000;
  while (Date.now() < limite) {
    try { const r = await fetch(base + "/api/health", { signal: AbortSignal.timeout(2000) }); if (r.ok) return; } catch { }
    if (proc.exitCode !== null) throw new Error("servidor morreu: " + proc.exitCode);
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("timeout");
}

// ---------- seed no banco isolado ----------
const dbw = new Database(BANCO);
const admin = dbw.prepare("select id from users where username='administrador'").get();
const camp = dbw.prepare("select id from campaigns where name='teste'").get();
const memb = dbw.prepare(
  "select id from memberships where campaign_id=? and user_id=? and status='ativo'"
).get(camp.id, admin.id)
  ?? dbw.prepare(
    "select m.id from memberships m join users u on u.id=m.user_id where m.campaign_id=? and u.username='administrador' and m.status='ativo'"
  ).get(camp.id);

// 1) regra da campanha: HP habilitado (base 100 + FOR×10)
const rs = dbw.prepare("select id, config from rule_sets where campaign_id=? and is_active=1").get(camp.id);
const cfg = JSON.parse(rs.config);
cfg.hp = { habilitado: true, base: 100, porNivel: 10, campoId: "for", edicaoPor: "ambos" };
dbw.prepare("update rule_sets set config=? where id=?").run(JSON.stringify(cfg), rs.id);

// 2) template de ficha publicado com campo "for" inteiro
const estrutura = {
  versao: 1,
  secoes: [{ id: "s1", titulo: "Atributos", ordem: 0, campos: [{ id: "for", label: "FOR", tipo: "inteiro", semantico: "atributo" }] }],
  pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
};
const agora = Date.now();
const tplId = crypto.randomUUID(), verId = crypto.randomUUID();
dbw.prepare("insert into sheet_templates (id,campaign_id,name,description,owner_id,is_active,is_default,created_at,updated_at) values (?,?,?,?,?,1,0,?,?)")
  .run(tplId, camp.id, "Ficha teste HP", null, admin.id, agora, agora);
dbw.prepare("insert into sheet_versions (id,template_id,version,structure,published_at,created_at) values (?,?,1,?,?,?)")
  .run(verId, tplId, JSON.stringify(estrutura), agora, agora);
dbw.prepare("update sheet_templates set current_version_id=? where id=?").run(verId, tplId);

// 3) personagem com 12 eventos de HP
const mkHistorico = (n) => Array.from({ length: n }, (_, i) => ({
  em: new Date(agora - (n - i) * 3600_000).toISOString(),
  tipo: i % 3 === 0 ? "dano" : i % 3 === 1 ? "recuperacao" : "ajuste",
  quantidade: i % 3 === 0 ? -10 : i % 3 === 1 ? 15 : 5,
  motivo: `Evento ${i + 1}`,
  autorId: admin.id, autorNome: "administrador",
}));
const char12 = crypto.randomUUID();
dbw.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
  .run(char12, camp.id, memb.id, verId, "Herói 12 eventos",
    JSON.stringify({ for: 5, __hp: { atual: 120, historico: mkHistorico(12) } }),
    "{}", "aprovada", 0, agora, agora);
const charVazio = crypto.randomUUID();
dbw.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
  .run(charVazio, camp.id, memb.id, verId, "Herói HP zerado",
    JSON.stringify({ for: 5, __hp: { atual: 0, historico: [] } }),
    "{}", "aprovada", 0, agora, agora);
const charCurto = crypto.randomUUID();
dbw.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
  .run(charCurto, camp.id, memb.id, verId, "Herói 3 eventos",
    JSON.stringify({ for: 5, __hp: { atual: 140, historico: mkHistorico(3) } }),
    "{}", "aprovada", 0, agora, agora);
dbw.close();
console.log("seed ok:", { char12, charVazio, charCurto });

// sessão do admin
const token = "t-" + crypto.randomUUID();
{
  const s = new Database(BANCO);
  s.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), admin.id, hashToken(token), "t", "127.0.0.1", Date.now() + 86400000, Date.now());
  s.close();
}

const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
let proc;
const browser = await chromium.launch();

async function abrirFicha(nomePersonagem, { mobile = false } = {}) {
  const ctx = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1366, height: 900 } });
  await ctx.addCookies([{ name: "mestre_rpg_session", value: token, url: BASE }]);
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Campanhas" }).click();
  await page.getByText("teste", { exact: false }).first().click();
  await page.getByRole("button", { name: "Personagens" }).click();
  await page.getByText(nomePersonagem, { exact: false }).first().click();
  await page.waitForSelector(".hp-historico", { timeout: 15000 });
  return { ctx, page };
}

async function contarEventos(page) {
  return page.locator(".hp-historico .hp-evento").count();
}

try {
  proc = spawn("node", ["servidor/dist/index.js"], {
    env: { ...process.env, MESTRE_PORTA: String(porta), MESTRE_BANCO: BANCO, MESTRE_ARQUIVOS: DIR + "/arq", MESTRE_BACKUPS: DIR + "/bks" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);

  // ===== Desktop: 12 eventos =====
  sec("Desktop — 12 eventos de HP");
  {
    const { ctx, page } = await abrirFicha("Herói 12 eventos");
    t("exibe no máximo 8 eventos inicialmente", (await contarEventos(page)) === 8, `n=${await contarEventos(page)}`);
    const rotulo = await page.locator(".hp-historico strong").first().textContent().catch(() => "");
    t("rótulo mostra total (12)", /12/.test(rotulo ?? ""), `rotulo=${rotulo}`);
    const btn = page.getByRole("button", { name: /histórico completo/i });
    t("botão 'Ver histórico completo' presente", await btn.count() === 1);
    await btn.click();
    await page.waitForTimeout(200);
    t("expandido mostra os 12 eventos", (await contarEventos(page)) === 12, `n=${await contarEventos(page)}`);
    const primeiro = await page.locator(".hp-historico .hp-evento").first().textContent();
    t("ordem: mais recente primeiro", /Evento 12/.test(primeiro ?? ""), `primeiro=${primeiro?.slice(0, 60)}`);
    const ultimo = await page.locator(".hp-historico .hp-evento").last().textContent();
    t("ordem: mais antigo por último", /Evento 1(?!2)/.test(ultimo ?? "") || /Evento 1\b/.test(ultimo ?? ""), `ultimo=${ultimo?.slice(0, 60)}`);
    const btn2 = page.getByRole("button", { name: /Mostrar recentes/i });
    t("botão vira 'Mostrar recentes'", await btn2.count() === 1);
    await btn2.click();
    await page.waitForTimeout(200);
    t("recolhido volta a 8 eventos", (await contarEventos(page)) === 8, `n=${await contarEventos(page)}`);
    await ctx.close();
  }

  // ===== Desktop: histórico vazio =====
  sec("Desktop — histórico vazio");
  {
    const { ctx, page } = await abrirFicha("Herói HP zerado");
    // resumoHp injeta o evento virtual "HP inicial" quando não há histórico
    // persistido — comportamento correto, não é evento real gravado.
    const n = await contarEventos(page);
    t("histórico vazio renderiza só o evento virtual inicial", n === 1, `n=${n}`);
    const texto = await page.locator(".hp-historico .hp-evento").first().textContent().catch(() => "");
    t("evento virtual é 'HP inicial'", /inicial/i.test(texto ?? ""), `texto=${texto?.slice(0, 80)}`);
    t("sem botão de expandir", (await page.getByRole("button", { name: /histórico completo/i }).count()) === 0);
    await ctx.close();
  }

  // ===== Desktop: histórico curto (3 eventos) =====
  sec("Desktop — 3 eventos");
  {
    const { ctx, page } = await abrirFicha("Herói 3 eventos");
    t("exibe os 3 eventos", (await contarEventos(page)) === 3, `n=${await contarEventos(page)}`);
    t("sem botão de expandir (<=8)", (await page.getByRole("button", { name: /histórico completo/i }).count()) === 0);
    await ctx.close();
  }

  // ===== Mobile: 12 eventos =====
  sec("Mobile — 12 eventos");
  {
    const { ctx, page } = await abrirFicha("Herói 12 eventos", { mobile: true });
    t("mobile: 8 eventos inicialmente", (await contarEventos(page)) === 8, `n=${await contarEventos(page)}`);
    await page.getByRole("button", { name: /histórico completo/i }).click();
    await page.waitForTimeout(200);
    t("mobile: expandido mostra 12", (await contarEventos(page)) === 12, `n=${await contarEventos(page)}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
    t("mobile: sem overflow horizontal", !overflow);
    await ctx.close();
  }
} finally {
  await browser.close().catch(() => {});
  proc?.kill();
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
