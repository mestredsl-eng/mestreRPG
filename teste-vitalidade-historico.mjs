// Testes — histórico de Vitalidade (nível anterior/novo, data, autor, motivo).
// Banco isolado em porta livre; cobre alterações repetidas, consulta,
// persistência após reinício do servidor, proteção contra PATCH genérico
// e permissões mestre/jogador.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { hashToken } from "./servidor/dist/lib/password.js";

const DIR = "simulacao-limpeza/teste-vitalidade-historico";
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
function subir(porta) {
  return spawn("node", ["servidor/dist/index.js"], {
    env: { ...process.env, MESTRE_PORTA: String(porta), MESTRE_BANCO: BANCO, MESTRE_ARQUIVOS: DIR + "/arq", MESTRE_BACKUPS: DIR + "/bks" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function sessao(userId) {
  const db = new Database(BANCO);
  const token = "t-" + crypto.randomUUID();
  db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), userId, hashToken(token), "t", "127.0.0.1", Date.now() + 86400000, Date.now());
  db.close();
  return `mestre_rpg_session=${encodeURIComponent(token)}`;
}
function comDb(fn) {
  const db = new Database(BANCO, { readonly: true });
  try { return fn(db); } finally { db.close(); }
}
const dadosPersonagem = (id) => JSON.parse(comDb((db) => db.prepare("select data from characters where id=?").get(id).data));

async function req(base, metodo, path, { cookie, body } = {}) {
  const r = await fetch(base + "/api" + path, {
    method: metodo,
    headers: { "content-type": "application/json", cookie: cookie ?? "" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

// ---------- seed ----------
const ids = (() => {
  const db = new Database(BANCO);
  const admin = db.prepare("select id from users where username='administrador'").get().id;
  const jogador = db.prepare("select id from users where username='fernandoqc_@hotmail.com'").get().id;
  const camp = db.prepare("select id from campaigns where name='teste'").get().id;
  const membMestre = db.prepare("select id from memberships where campaign_id=? and user_id=?").get(camp, admin).id;
  // jogador entra na campanha 'teste' como jogador
  let membJogador = db.prepare("select id from memberships where campaign_id=? and user_id=?").get(camp, jogador)?.id;
  if (!membJogador) {
    membJogador = crypto.randomUUID();
    const agora = Date.now();
    db.prepare("insert into memberships (id,campaign_id,user_id,role,status,created_at,updated_at) values (?,?,?,?,?,?,?)")
      .run(membJogador, camp, jogador, "jogador", "ativo", agora, agora);
  }
  const agora = Date.now();
  // Template de ficha mínimo para que GET /characters devolva ficha.vida
  const tplId = crypto.randomUUID(), verId = crypto.randomUUID();
  const estrutura = { versao: 1, secoes: [], pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} } };
  db.prepare("insert into sheet_templates (id,campaign_id,name,description,owner_id,is_active,is_default,created_at,updated_at) values (?,?,?,?,?,1,0,?,?)")
    .run(tplId, camp, "Ficha mínima", null, admin, agora, agora);
  db.prepare("insert into sheet_versions (id,template_id,version,structure,published_at,created_at) values (?,?,1,?,?,?)")
    .run(verId, tplId, JSON.stringify(estrutura), agora, agora);

  const charId = crypto.randomUUID();
  // Personagem ANTIGO: sem __vitalidade — deve funcionar sem migração.
  db.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
    .run(charId, camp, membMestre, verId, "Veterano", "{}", "{}", "aprovada", 0, agora, agora);
  // Personagem do jogador (mesma campanha) para teste de permissão.
  const charJogador = crypto.randomUUID();
  db.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
    .run(charJogador, camp, membJogador, verId, "Personagem do jogador", "{}", "{}", "aprovada", 0, agora, agora);
  db.close();
  return { admin, jogador, camp, charId, charJogador, membJogador };
})();
console.log("seed:", ids);

const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
const cookieMestre = sessao(ids.admin);
const cookieJogador = sessao(ids.jogador);
let proc;

async function vitalidadeDe(charId, cookie = cookieMestre) {
  const r = await req(BASE, "GET", `/characters/${charId}`, { cookie });
  return r.json?.ficha?.vida?.vitalidade ?? null;
}

try {
  proc = subir(porta);
  await esperarSaudavel(BASE, proc);

  // ===== 1. Personagem antigo sem vitalidade =====
  sec("Personagem antigo (sem __vitalidade)");
  {
    const vit = await vitalidadeDe(ids.charId);
    t("resumo existe com nível 0", vit && vit.nivel === 0, JSON.stringify(vit).slice(0, 120));
    t("histórico vazio para personagem antigo", Array.isArray(vit?.historico) && vit.historico.length === 0, `hist=${vit?.historico?.length}`);
  }

  // ===== 2. Alterações repetidas com motivo =====
  sec("Alterações repetidas");
  {
    const r1 = await req(BASE, "POST", `/characters/${ids.charId}/vitalidade`, {
      cookie: cookieMestre, body: { nivel: 2, motivo: "Combate na taverna" },
    });
    t("1ª alteração → 200", r1.status === 200, `status=${r1.status} ${JSON.stringify(r1.json).slice(0, 120)}`);
    const r2 = await req(BASE, "POST", `/characters/${ids.charId}/vitalidade`, {
      cookie: cookieMestre, body: { nivel: 4 },
    });
    t("2ª alteração → 200", r2.status === 200, `status=${r2.status}`);
    const vit = await vitalidadeDe(ids.charId);
    t("nível final = 4", vit?.nivel === 4, `nivel=${vit?.nivel}`);
    t("histórico tem 2 eventos", vit?.historico?.length === 2, `n=${vit?.historico?.length}`);
    const [e1, e2] = vit.historico;
    t("evento 1: 0→2 com motivo e autor", e1.nivelAnterior === 0 && e1.nivelNovo === 2 && e1.motivo === "Combate na taverna" && !!e1.autorId && !!e1.autorNome, JSON.stringify(e1));
    t("evento 2: 2→4 sem motivo", e2.nivelAnterior === 2 && e2.nivelNovo === 4 && e2.motivo === null, JSON.stringify(e2));
    t("data ISO válida", !Number.isNaN(Date.parse(e1.em)) && !Number.isNaN(Date.parse(e2.em)));
    t("ordem cronológica (mais antigo primeiro)", Date.parse(e1.em) <= Date.parse(e2.em));
  }

  // ===== 3. Persistência no banco =====
  sec("Estado persistido em characters.data");
  {
    const dados = dadosPersonagem(ids.charId);
    const vit = dados.__vitalidade;
    t("__vitalidade.nivel = 4", vit?.nivel === 4, JSON.stringify(vit).slice(0, 150));
    t("__vitalidade.historico persistido (2)", vit?.historico?.length === 2, `n=${vit?.historico?.length}`);
    t("alteradoPor = admin", vit?.alteradoPor === ids.admin);
  }

  // ===== 4. PATCH genérico não adultera histórico =====
  sec("PATCH genérico não falsifica/apaga procedência");
  {
    const forjado = await req(BASE, "PATCH", `/characters/${ids.charId}`, {
      cookie: cookieMestre,
      body: { data: { __vitalidade: { nivel: 0, historico: [] }, __hp: { atual: 9999, historico: [] } } },
    });
    t("PATCH aceito", forjado.status === 200, `status=${forjado.status} ${JSON.stringify(forjado.json).slice(0, 150)}`);
    const dados = dadosPersonagem(ids.charId);
    t("__vitalidade.nivel continua 4", dados.__vitalidade?.nivel === 4, `nivel=${dados.__vitalidade?.nivel}`);
    t("histórico continua com 2 eventos", dados.__vitalidade?.historico?.length === 2, `n=${dados.__vitalidade?.historico?.length}`);
    t("__hp forjado não persistiu", dados.__hp?.atual !== 9999, `hp=${dados.__hp?.atual}`);
  }

  // ===== 5. Permissões =====
  sec("Permissões");
  {
    const rJogador = await req(BASE, "POST", `/characters/${ids.charJogador}/vitalidade`, {
      cookie: cookieJogador, body: { nivel: 3 },
    });
    t("jogador dono (edicaoPor=mestre) → 403", rJogador.status === 403, `status=${rJogador.status}`);
    const rMestre = await req(BASE, "POST", `/characters/${ids.charJogador}/vitalidade`, {
      cookie: cookieMestre, body: { nivel: 1, motivo: "Pelo mestre" },
    });
    t("mestre → 200", rMestre.status === 200, `status=${rMestre.status}`);
    const vit = await vitalidadeDe(ids.charJogador, cookieJogador);
    t("jogador lê histórico do próprio personagem", vit?.historico?.length === 1 && vit.historico[0].motivo === "Pelo mestre", JSON.stringify(vit?.historico).slice(0, 150));
    // nível inválido
    const rInv = await req(BASE, "POST", `/characters/${ids.charId}/vitalidade`, {
      cookie: cookieMestre, body: { nivel: 99 },
    });
    t("nível fora da escala → 400", rInv.status === 400, `status=${rInv.status}`);
  }

  // ===== 6. Persistência após reinício =====
  sec("Persistência após reinício do servidor");
  {
    proc.kill();
    await new Promise((r) => setTimeout(r, 800));
    proc = subir(porta);
    await esperarSaudavel(BASE, proc);
    const vit = await vitalidadeDe(ids.charId);
    t("nível 4 mantido após restart", vit?.nivel === 4, `nivel=${vit?.nivel}`);
    t("histórico mantido após restart (2)", vit?.historico?.length === 2, `n=${vit?.historico?.length}`);
    t("evento mais recente por último na resposta", vit?.historico?.[1]?.nivelNovo === 4);
  }
} finally {
  proc?.kill();
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
