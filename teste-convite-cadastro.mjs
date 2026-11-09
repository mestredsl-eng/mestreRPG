// Testes — cadastro de jogador por convite (fluxo anônimo → registrar → aceitar).
// Cobre: preview público, registro só com convite ativo, sessão automática,
// proteção anti-admin, login de jogador existente, limite de usos e
// concorrência no aceite. Cópia isolada do banco.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { hashToken } from "./servidor/dist/lib/password.js";

const DIR = "simulacao-limpeza/teste-convite-cadastro";
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
function sessaoDb() {
  const db = new Database(BANCO);
  const admin = db.prepare("select id from users where username='administrador'").get();
  const token = "t-" + crypto.randomUUID();
  db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), admin.id, hashToken(token), "t", "127.0.0.1", Date.now() + 86400000, Date.now());
  db.close();
  return `mestre_rpg_session=${encodeURIComponent(token)}`;
}
async function req(base, metodo, path, { cookie, body } = {}) {
  const r = await fetch(base + "/api" + path, {
    method: metodo,
    headers: { "content-type": "application/json", cookie: cookie ?? "" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = r.headers.get("set-cookie") ?? "";
  const cookieNova = /mestre_rpg_session=([^;]+)/.exec(setCookie)?.[1];
  return { status: r.status, json: await r.json().catch(() => null), cookieNova };
}
const cookieDe = (r) => r.cookieNova ? `mestre_rpg_session=${r.cookieNova}` : null;

const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
const proc = subir(porta);
await esperarSaudavel(BASE, proc);
const M = sessaoDb();
console.log(`servidor teste em ${BASE}`);

sec("Setup: campanha e convites");
const camp = await req(BASE, "POST", "/campaigns", { cookie: M, body: { name: "Campanha Convite" } });
const cid = camp.json?.campanha?.id;
t("mestre cria campanha", camp.status === 201 && !!cid, JSON.stringify(camp.json).slice(0, 200));

const inv = await req(BASE, "POST", `/campaigns/${cid}/invitations`, { cookie: M, body: { role: "jogador", requiresApproval: false } });
const CODE = inv.json?.convite?.code;
t("mestre cria convite", inv.status === 201 && !!CODE, JSON.stringify(inv.json).slice(0, 200));

const inv1 = await req(BASE, "POST", `/campaigns/${cid}/invitations`, { cookie: M, body: { role: "jogador", maxUses: 1 } });
const CODE1 = inv1.json?.convite?.code;
t("convite unitário criado", inv1.status === 201 && !!CODE1);

const invExp = await req(BASE, "POST", `/campaigns/${cid}/invitations`, { cookie: M, body: { role: "jogador", expiresInHours: 1 } });
const CODE_EXP = invExp.json?.convite?.code;
t("convite c/ expiração criado", invExp.status === 201 && !!CODE_EXP);
// Força expiração no banco de teste (expiresInHours mínimo é 1h)
{
  const db = new Database(BANCO);
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(CODE_EXP.trim().toUpperCase()).digest("hex");
  db.prepare("update invitations set expires_at=? where code=?").run(Date.now() - 1000, hash);
  db.close();
}

sec("Prévia pública do convite (anônimo)");
const pv = await req(BASE, "GET", `/convites/${CODE}/preview`, {});
t("preview sem auth -> 200", pv.status === 200, JSON.stringify(pv.json).slice(0, 200));
t("preview mostra campanha e papel", pv.json?.convite?.campanha?.name === "Campanha Convite" && pv.json?.convite?.role === "jogador", JSON.stringify(pv.json).slice(0, 200));
t("preview não vaza membership", !("jaParticipa" in (pv.json?.convite ?? {})) && !("meuStatus" in (pv.json?.convite ?? {})));
const pvInvalido = await req(BASE, "GET", "/convites/XXXX-XXXX-XXXX/preview", {});
t("preview código inexistente -> 404", pvInvalido.status === 404);
const pvExp = await req(BASE, "GET", `/convites/${CODE_EXP}/preview`, {});
t("preview convite expirado -> status expirado", pvExp.status === 200 && pvExp.json?.convite?.status === "expirado", JSON.stringify(pvExp.json).slice(0, 200));

sec("Rotas autenticadas seguem protegidas");
const semAuth = await req(BASE, "GET", `/convites/${CODE}`, {});
t("GET /convites/:code sem auth -> 401", semAuth.status === 401);
const aceitarSemAuth = await req(BASE, "POST", `/convites/${CODE}/aceitar`, {});
t("aceitar sem auth -> 401", aceitarSemAuth.status === 401);

sec("Registro de jogador por convite");
const regSemCodigo = await req(BASE, "POST", "/auth/registrar", { body: { username: "abc123", password: "senha12345" } });
t("registro sem código -> 400", regSemCodigo.status === 400);
const regInvalido = await req(BASE, "POST", "/auth/registrar", { body: { codigo: "XXXX-XXXX-XXXX", username: "abc123", password: "senha12345" } });
t("registro código inexistente -> 404", regInvalido.status === 404);
const regExp = await req(BASE, "POST", "/auth/registrar", { body: { codigo: CODE_EXP, username: "abc123", password: "senha12345" } });
t("registro convite expirado -> 410", regExp.status === 410, JSON.stringify(regExp.json).slice(0, 150));

const reg = await req(BASE, "POST", "/auth/registrar", {
  body: { codigo: CODE, username: "jogadora1", password: "senha12345", displayName: "Jogadora Um", isAdmin: true },
});
t("registro válido -> 201", reg.status === 201, JSON.stringify(reg.json).slice(0, 250));
t("usuário criado NÃO é admin (isAdmin no body ignorado)", reg.json?.usuario?.isAdmin === false, JSON.stringify(reg.json?.usuario).slice(0, 200));
t("registro abre sessão (cookie)", !!cookieDe(reg));
const C1 = cookieDe(reg);

const me = await req(BASE, "GET", "/auth/me", { cookie: C1 });
t("sessão do registro autentica /me", me.status === 200 && me.json?.usuario?.username === "jogadora1", JSON.stringify(me.json).slice(0, 200));

const regDup = await req(BASE, "POST", "/auth/registrar", { body: { codigo: CODE, username: "jogadora1", password: "outrasenha1" } });
t("username duplicado -> 409", regDup.status === 409);

// Uso do convite NÃO é consumido no registro
{
  const db = new Database(BANCO, { readonly: true });
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(CODE.trim().toUpperCase()).digest("hex");
  const row = db.prepare("select uses from invitations where code=?").get(hash);
  db.close();
  t("registro não consumiu uso do convite", row?.uses === 0, `uses=${row?.uses}`);
}

sec("Aceite do convite pelo jogador registrado");
const infoAuth = await req(BASE, "GET", `/convites/${CODE}`, { cookie: C1 });
t("convidado vê campanha/papel autenticado", infoAuth.status === 200 && infoAuth.json?.convite?.campanha?.name === "Campanha Convite", JSON.stringify(infoAuth.json).slice(0, 200));

const acc = await req(BASE, "POST", `/convites/${CODE}/aceitar`, { cookie: C1 });
t("aceitar convite -> 201 ativo", acc.status === 201 && acc.json?.status === "ativo", JSON.stringify(acc.json).slice(0, 200));

const membros = await req(BASE, "GET", `/campaigns/${cid}/members`, { cookie: M });
const membroJog = membros.json?.membros?.find?.((m) => m.username === "jogadora1");
t("jogadora1 consta como membro jogador ativo", !!membroJog && membroJog.role === "jogador" && membroJog.status === "ativo", JSON.stringify(membros.json?.membros).slice(0, 300));

const acc2 = await req(BASE, "POST", `/convites/${CODE}/aceitar`, { cookie: C1 });
t("segundo aceite -> 409 já participa", acc2.status === 409, String(acc2.status));

sec("Login de jogador existente retorna ao convite");
const login = await req(BASE, "POST", "/auth/login", { body: { username: "jogadora1", password: "senha12345" } });
t("login jogador existente -> 200", login.status === 200 && login.json?.usuario?.isAdmin === false, JSON.stringify(login.json).slice(0, 200));
const C1b = cookieDe(login);
const infoLogin = await req(BASE, "GET", `/convites/${CODE}`, { cookie: C1b });
t("após login, convite mostra já participante", infoLogin.status === 200 && infoLogin.json?.convite?.jaParticipa === true, JSON.stringify(infoLogin.json).slice(0, 200));

sec("Limite de usos e concorrência");
// dois jogadores disputam convite unitário
const regA = await req(BASE, "POST", "/auth/registrar", { body: { codigo: CODE1, username: "corrida_a", password: "senha12345" } });
const regB = await req(BASE, "POST", "/auth/registrar", { body: { codigo: CODE1, username: "corrida_b", password: "senha12345" } });
t("dois registros com convite unitário -> ambos 201", regA.status === 201 && regB.status === 201);
const [accA, accB] = await Promise.all([
  req(BASE, "POST", `/convites/${CODE1}/aceitar`, { cookie: cookieDe(regA) }),
  req(BASE, "POST", `/convites/${CODE1}/aceitar`, { cookie: cookieDe(regB) }),
]);
const sucessos = [accA, accB].filter((r) => r.status === 201).length;
const falhas = [accA, accB].filter((r) => r.status === 410 || r.status === 409).length;
t("concorrência: exatamente 1 aceite vence", sucessos === 1 && falhas === 1, `A=${accA.status} B=${accB.status}`);
{
  const db = new Database(BANCO, { readonly: true });
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(CODE1.trim().toUpperCase()).digest("hex");
  const row = db.prepare("select uses from invitations where code=?").get(hash);
  db.close();
  t("uses=1 após corrida (sem estouro)", row?.uses === 1, `uses=${row?.uses}`);
}

sec("Proteção administrativa");
const setup2 = await req(BASE, "POST", "/auth/setup", { body: { username: "admin2", password: "senha12345678" } });
t("/auth/setup bloqueado (admin já existe) -> 403", setup2.status === 403, String(setup2.status));
const adminDb = new Database(BANCO, { readonly: true });
const admins = adminDb.prepare("select count(*) c from users where is_admin=1").get().c;
const adminsCriados = adminDb.prepare("select count(*) c from users where is_admin=1 and username in ('jogadora1','corrida_a','corrida_b')").get().c;
adminDb.close();
t("nenhum admin extra criado pelo registro", adminsCriados === 0, `adminsNovos=${adminsCriados}`);
t("admin principal preservado", admins >= 1, `admins=${admins}`);

proc.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 800));

console.log(`\n==== RESULTADO: ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
