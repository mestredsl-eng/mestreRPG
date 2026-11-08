// Testes — administrador único e permanente (admin_principal + triggers + guards API)
// Roda contra uma CÓPIA isolada do banco real em porta livre — nunca toca o banco definitivo.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { copyFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { hashToken } from "./servidor/dist/lib/password.js";

const DIR = "simulacao-limpeza/admin-unico";
const BANCO = `${DIR}/mestre-rpg-teste.db`;
const ARQ = `${DIR}/arquivos`;
const BKS = `${DIR}/backups`;
mkdirSync(DIR, { recursive: true });
mkdirSync(ARQ, { recursive: true });
mkdirSync(BKS, { recursive: true });
for (const suf of ["", "-wal", "-shm"]) rmSync(BANCO + suf, { force: true });
{
  const orig = new Database("banco/mestre-rpg.db", { readonly: true });
  orig.prepare(`VACUUM INTO '${BANCO.replace(/\\/g, "/")}'`).run();
  orig.close();
}

const ADMIN_ID = "0c3851ef-7ba3-4932-accc-40be964b8d62"; // administrador (admin_principal)

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
  throw new Error("timeout aguardando servidor");
}
function subir(porta) {
  const proc = spawn("node", ["servidor/dist/index.js"], {
    env: { ...process.env, MESTRE_PORTA: String(porta), MESTRE_BANCO: BANCO, MESTRE_ARQUIVOS: ARQ, MESTRE_BACKUPS: BKS },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stderr.on("data", (d) => process.stderr.write("[srv!] " + d));
  return proc;
}
function sessaoDb(username) {
  const db = new Database(BANCO);
  const u = db.prepare("select id from users where username=?").get(username);
  const token = "t-" + crypto.randomUUID();
  db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), u.id, hashToken(token), "teste", "127.0.0.1", Date.now() + 86400000, Date.now());
  db.close();
  return `mestre_rpg_session=${encodeURIComponent(token)}`;
}
async function req(base, metodo, path, { cookie, body } = {}) {
  const r = await fetch(base + "/api" + path, {
    method: metodo,
    headers: { "content-type": "application/json", cookie: cookie ?? "" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await r.json(); } catch { }
  return { status: r.status, json };
}
function dbTest(sql, ...params) {
  const db = new Database(BANCO);
  try { return db.prepare(sql).run(...params); } finally { db.close(); }
}
function dbGet(sql, ...params) {
  const db = new Database(BANCO, { readonly: true });
  try { return db.prepare(sql).get(...params); } finally { db.close(); }
}

const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
let proc = subir(porta);
await esperarSaudavel(BASE, proc);
console.log(`servidor teste em ${BASE} (pid ${proc.pid})`);

try {
  const ADMIN = { cookie: sessaoDb("administrador") };

  sec("1-2. Estado inicial e criação de usuário comum");
  {
    const lista = await req(BASE, "GET", "/admin/users", { cookie: ADMIN.cookie });
    const admins = (lista.json?.usuarios ?? []).filter((u) => u.isAdmin);
    t("somente 1 admin", admins.length === 1 && admins[0].id === ADMIN_ID);
    t("admin marcado como principal", admins[0]?.adminPrincipal === true);
    t("admin_principal no banco = administrador", dbGet("select user_id from admin_principal").user_id === ADMIN_ID);

    const novo = await req(BASE, "POST", "/admin/users", { cookie: ADMIN.cookie, body: { username: "comum_teste", password: "Senha@1234", displayName: "Comum" } });
    t("criar usuário comum", novo.status === 201 && novo.json?.usuario?.isAdmin === false, JSON.stringify(novo.json).slice(0, 120));
    const uidComum = novo.json?.usuario?.id;
    t("persistido como não-admin", dbGet("select is_admin from users where id=?", uidComum).is_admin === 0);
  }

  sec("3-5. Tentativas de promoção via API");
  {
    const uidComum = dbGet("select id from users where username='comum_teste'").id;
    const p1 = await req(BASE, "POST", "/admin/users", { cookie: ADMIN.cookie, body: { username: "admin_fake", password: "Senha@1234", isAdmin: true } });
    t("POST com isAdmin=true rejeitado", p1.status === 400, `status=${p1.status}`);
    t("admin_fake não existe", !dbGet("select id from users where username='admin_fake'"));

    const p2 = await req(BASE, "PATCH", `/admin/users/${uidComum}`, { cookie: ADMIN.cookie, body: { isAdmin: true } });
    t("PATCH promoção rejeitada", p2.status === 400, `status=${p2.status}`);
    t("usuário segue comum", dbGet("select is_admin from users where id=?", uidComum).is_admin === 0);

    const p3 = await req(BASE, "PATCH", `/admin/users/${ADMIN_ID}`, { cookie: ADMIN.cookie, body: { isAdmin: false } });
    t("PATCH rebaixar admin rejeitado", p3.status === 400, `status=${p3.status}`);
    t("admin continua admin", dbGet("select is_admin from users where id=?", ADMIN_ID).is_admin === 1);

    // auto-promoção: PATCH na própria conta já é bloqueado; perfil não aceita isAdmin
    const p4 = await req(BASE, "PATCH", `/admin/users/${ADMIN_ID}`, { cookie: ADMIN.cookie, body: { displayName: "X", isAdmin: true } });
    t("edição c/ isAdmin rejeitada", p4.status === 400);
    const pref = await req(BASE, "PATCH", "/auth/preferences", { cookie: ADMIN.cookie, body: { isAdmin: true, dados: { corExterna: "#112233", corInterna: "#445566" } } });
    t("preferences ignora isAdmin", pref.status === 200 && dbGet("select is_admin from users where id=?", ADMIN_ID).is_admin === 1);
  }

  sec("6-8. Exclusão, bloqueio e identificador protegido");
  {
    const d1 = await req(BASE, "DELETE", `/admin/users/${ADMIN_ID}`, { cookie: ADMIN.cookie });
    t("DELETE admin rejeitado", d1.status === 400 || d1.status === 403, `status=${d1.status}`);
    const b1 = await req(BASE, "PATCH", `/admin/users/${ADMIN_ID}`, { cookie: ADMIN.cookie, body: { status: "bloqueado" } });
    // auto-edição já bloqueada (id === req.usuario) — testa proteção via banco abaixo
    t("bloquear a si mesmo rejeitado", b1.status === 400, `status=${b1.status}`);

    // ---- ataques diretos no banco (triggers) ----
    let abortou = (fn) => { try { fn(); return false; } catch (e) { return /admin|administrador|imutavel|protegido/i.test(e.message); } };
    t("DB: inserir outro admin aborta", abortou(() => dbTest("insert into users (id,username,password_hash,is_admin,status,preferences,created_at,updated_at) values ('x1','fake','h',1,'ativo','{}',1,1)")));
    const uidComum = dbGet("select id from users where username='comum_teste'").id;
    t("DB: promover usuário aborta", abortou(() => dbTest("update users set is_admin=1 where id=?", uidComum)));
    t("DB: rebaixar admin aborta", abortou(() => dbTest("update users set is_admin=0 where id=?", ADMIN_ID)));
    t("DB: excluir admin aborta", abortou(() => dbTest("delete from users where id=?", ADMIN_ID)));
    t("DB: trocar id do admin aborta", abortou(() => dbTest("update users set id='outro' where id=?", ADMIN_ID)));
    t("DB: update admin_principal aborta", abortou(() => dbTest("update admin_principal set user_id='x'")));
    t("DB: delete admin_principal aborta", abortou(() => dbTest("delete from admin_principal")));
    t("DB: segundo admin_principal aborta", abortou(() => dbTest("insert into admin_principal (user_id,created_at) values ('x1',1)")));
    t("DB: usuário comum insere normal", !abortou(() => dbTest("insert into users (id,username,password_hash,is_admin,status,preferences,created_at,updated_at) values ('x2','comum2','h',0,'ativo','{}',1,1)")));
    t("DB: editar nome do admin permitido", !abortou(() => dbTest("update users set display_name='Rafuka O Mestre' where id=?", ADMIN_ID)));
  }

  sec("9. Persistência após restart");
  {
    proc.kill(); await new Promise((r) => proc.once("exit", r));
    proc = subir(porta);
    await esperarSaudavel(BASE, proc);
    const lista = await req(BASE, "GET", "/admin/users", { cookie: sessaoDb("administrador") });
    const admins = (lista.json?.usuarios ?? []).filter((u) => u.isAdmin);
    t("admin segue único após restart", admins.length === 1 && admins[0].id === ADMIN_ID && admins[0].adminPrincipal === true);
    t("triggers seguem ativos", abortou2());
    function abortou2() { try { dbTest("update users set is_admin=0 where id=?", ADMIN_ID); return false; } catch { return true; } }
  }

  sec("10-11. Usuário comum e mestre de campanha");
  {
    const cookieComum = sessaoDb("comum_teste");
    const camp = await req(BASE, "POST", "/campaigns", { cookie: cookieComum, body: { name: "Campanha do Comum" } });
    t("usuário comum cria campanha", camp.status === 201, `status=${camp.status}`);
    const cid = camp.json?.campanha?.id;
    const membros = await req(BASE, "GET", `/campaigns/${cid}/members`, { cookie: cookieComum });
    t("comum é mestre da campanha", JSON.stringify(membros.json).includes("mestre"));
    const inv = await req(BASE, "POST", `/campaigns/${cid}/invitations`, { cookie: cookieComum, body: { role: "jogador" } });
    t("mestre cria convite", inv.status === 201 || inv.status === 200);
  }

  sec("12. Funções legítimas do admin");
  {
    const st = await req(BASE, "GET", "/admin/servidor/status", { cookie: ADMIN.cookie });
    t("status servidor", st.status === 200);
    const cfg = await req(BASE, "GET", "/admin/servidor/config", { cookie: ADMIN.cookie });
    t("config servidor", cfg.status === 200);
    const logs = await req(BASE, "GET", "/admin/servidor/logs?limite=5", { cookie: ADMIN.cookie });
    t("logs servidor", logs.status === 200);
    const edit = await req(BASE, "PATCH", `/admin/users/${ADMIN_ID}`, { cookie: sessaoDb("administrador") });
    // edição de próprio admin via rota é bloqueada por design (id===usuario) — comportamento existente
    const edit2 = await req(BASE, "PATCH", `/admin/users/${dbGet("select id from users where username='comum_teste'").id}`, { cookie: ADMIN.cookie, body: { displayName: "Comum Editado" } });
    t("admin edita usuário comum", edit2.status === 200);
  }
} finally {
  proc.kill();
}

console.log(`\n==== RESULTADO: ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
