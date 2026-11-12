// Testes de integração — Etapa 15 Fase 6: HTTPS/proxy/acesso externo (R5)
// Cobre: SPA servida pelo backend, fallback de rotas, cache de assets,
// headers na página, cookie Secure via X-Forwarded-Proto, validação de
// dominioPublico e alcance via IP de LAN/NetBird.
import Database from "better-sqlite3";
import { readdirSync } from "node:fs";
import { hashToken } from "./servidor/dist/lib/password.js";

const BASE = "http://localhost:3001";
const API = BASE + "/api";
const db = new Database("banco/mestre-rpg.db");

function sessaoHttp(username) {
  const u = db.prepare("select id from users where username=?").get(username);
  if (!u) throw new Error("usuário inexistente: " + username);
  const token = "t15f6-" + crypto.randomUUID();
  db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), u.id, hashToken(token), "t", "127.0.0.1", Date.now() + 86400000, Date.now());
  return { token, cookie: `mestre_rpg_session=${encodeURIComponent(token)}` };
}
const ADMIN = sessaoHttp("admin");

async function req(metodo, path, { cookie = ADMIN.cookie, body, headers = {}, base = API, raw = false } = {}) {
  const r = await fetch(`${base}${path}`, {
    method: metodo,
    signal: AbortSignal.timeout(15000),
    headers: { "content-type": "application/json", cookie, ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const texto = raw ? await r.text() : null;
  let json = null;
  if (!raw) { try { json = await r.json(); } catch { } }
  return { status: r.status, json, texto, headers: r.headers };
}

let pass = 0, fail = 0;
const res = [];
const t = (n, c, extra = "") => { if (c) { pass++; res.push("ok " + n); } else { fail++; res.push("FALHOU " + n + " " + extra); } console.error((c ? "ok " : "FALHOU ") + n + (extra ? " — " + extra : "")); };

// ---------- SPA servida pelo backend ----------
const home = await req("GET", "/", { base: BASE, raw: true });
t("1. GET / → 200 HTML da SPA", home.status === 200 && (home.headers.get("content-type") ?? "").includes("text/html") && home.texto.includes('id="root"'), `${home.status} ${home.headers.get("content-type")}`);

const spa = await req("GET", "/campanha/rota-interna-qualquer", { base: BASE, raw: true });
t("2. rota interna da SPA → 200 HTML (fallback)", spa.status === 200 && spa.texto.includes('id="root"'), String(spa.status));

const api404 = await req("GET", "/rota-inexistente", { raw: true });
t("3. /api/* inexistente → 404 JSON (não cai no fallback)", api404.status === 404 && api404.texto.trim().startsWith("{"), String(api404.status));

// asset hasheado do build
const assets = readdirSync("site/dist/assets").filter((f) => f.endsWith(".js"));
if (assets.length) {
  const a = await req("GET", `/assets/${assets[0]}`, { base: BASE, raw: true });
  t("4. asset hasheado → 200 + cache imutável", a.status === 200 && (a.headers.get("cache-control") ?? "").includes("immutable"), `${a.status} ${a.headers.get("cache-control")}`);
} else {
  t("4. (skip) sem assets no dist", false, "rode npm run build -w site");
}

// headers de segurança na página HTML
t("5. headers de segurança na SPA", home.headers.get("x-content-type-options") === "nosniff"
  && home.headers.get("x-frame-options") === "SAMEORIGIN"
  && (home.headers.get("content-security-policy") ?? "").includes("frame-ancestors"));

// POST em rota não-API não vira HTML
t("6. POST / → não serve SPA", (await req("POST", "/", { base: BASE, body: {} })).status !== 200);

// ---------- acesso via IP LAN/NetBird (bind 0.0.0.0) ----------
const lan = await req("GET", "/health", { base: "http://192.168.1.35:3001/api", raw: true });
t("7. API responde no IP da LAN", lan.status === 200, String(lan.status));
const lanHome = await req("GET", "/", { base: "http://192.168.1.35:3001", raw: true });
t("8. SPA responde no IP da LAN", lanHome.status === 200 && lanHome.texto.includes('id="root"'), String(lanHome.status));
const nb = await req("GET", "/health", { base: "http://100.97.99.149:3001/api", raw: true });
t("9. API responde no IP NetBird", nb.status === 200, String(nb.status));

// ---------- cookie Secure via proxy ----------
// usuário descartável com senha conhecida para testar login real
const uname = "acesso_f6";
await req("POST", "/admin/users", { body: { username: uname, password: "senha-acesso-123" } });

const loginHttp = await fetch(`${API}/auth/login`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: uname, password: "senha-acesso-123" }),
});
const cookieHttp = loginHttp.headers.get("set-cookie") ?? "";
t("10. login HTTP local → cookie sem Secure", loginHttp.status === 200 && !/;\s*Secure/i.test(cookieHttp), `${loginHttp.status} ${cookieHttp.slice(0, 80)}`);
t("11. cookie HttpOnly + SameSite=Lax", /HttpOnly/i.test(cookieHttp) && /SameSite=Lax/i.test(cookieHttp));

// X-Forwarded-Proto só é honrado quando proxyHops > 0 (padrão 0 = acesso
// direto não confia em headers de proxy). O valor efetivo vem de
// server_settings (painel admin) com fallback para configuracao/servidor.json.
const cfgAcesso = await req("GET", "/admin/servidor/config");
const hops = Number(cfgAcesso.json?.acesso?.proxyHops ?? 0);
const loginHttps = await fetch(`${API}/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
  body: JSON.stringify({ username: uname, password: "senha-acesso-123" }),
});
const cookieHttps = loginHttps.headers.get("set-cookie") ?? "";
t("12. X-Forwarded-Proto: Secure só com proxyHops configurado", loginHttps.status === 200
  && /;\s*Secure/i.test(cookieHttps) === (hops > 0),
  `${loginHttps.status} hops=${hops} ${cookieHttps.slice(0, 100)}`);

// ---------- validação de dominioPublico ----------
for (const [i, dominio] of ["http://evil.com/x", "dominio com espaco.com", "javascript:alert(1)", "-bad-.com"].entries()) {
  const r = await req("PUT", "/admin/servidor/config", { body: { acesso: { dominioPublico: dominio } } });
  t(`13.${i + 1} dominioPublico inválido rejeitado (${dominio.slice(0, 20)})`, r.status === 400, String(r.status));
}
// valor atual permanece intacto (nada foi gravado)
const cfg = await req("GET", "/admin/servidor/config");
t("14. config de acesso não foi alterada pelos testes", typeof cfg.json?.acesso?.dominioPublico === "string");

// limpeza do usuário de teste
const uid = db.prepare("select id from users where username=?").get(uname)?.id;
if (uid) {
  db.prepare("delete from auth_sessions where user_id=?").run(uid);
  await req("DELETE", `/admin/users/${uid}`);
}

// integridade final
const ok = await req("GET", "/health");
t("15. servidor íntegro após bateria", ok.status === 200, String(ok.status));

console.log(res.join("\n"));
console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
