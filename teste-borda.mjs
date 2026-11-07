// Testes de integração — Etapa 15 Fase 5: proteção de borda (R2+R3+R4)
// Cobre headers de segurança, política de origem do Socket.IO e rate limiting.
import Database from "better-sqlite3";
import { io as ioClient } from "socket.io-client";
import { hashToken } from "./servidor/dist/lib/password.js";

const BASE = "http://localhost:3001";
const API = BASE + "/api";
const db = new Database("banco/mestre-rpg.db");

function sessaoHttp(username) {
  const u = db.prepare("select id from users where username=?").get(username);
  if (!u) throw new Error("usuário inexistente: " + username);
  const token = "t15b-" + crypto.randomUUID();
  db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), u.id, hashToken(token), "t", "127.0.0.1", Date.now() + 86400000, Date.now());
  return { token, cookie: `mestre_rpg_session=${encodeURIComponent(token)}` };
}
const ADMIN = sessaoHttp("admin");

async function req(metodo, path, { cookie = ADMIN.cookie, body, headers = {} } = {}) {
  const r = await fetch(`${API}${path}`, {
    method: metodo,
    signal: AbortSignal.timeout(15000),
    headers: { "content-type": "application/json", cookie, ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch { }
  return { status: r.status, json, headers: r.headers };
}

let pass = 0, fail = 0;
const res = [];
const t = (n, c, extra = "") => { if (c) { pass++; res.push("ok " + n); } else { fail++; res.push("FALHOU " + n + " " + extra); } console.error((c ? "ok " : "FALHOU ") + n + (extra ? " — " + extra : "")); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- R2: headers de segurança ----------
const h = await req("GET", "/health");
const hd = h.headers;
t("1. X-Content-Type-Options: nosniff", hd.get("x-content-type-options") === "nosniff");
t("2. Referrer-Policy presente", !!hd.get("referrer-policy"));
t("3. Permissions-Policy presente", (hd.get("permissions-policy") ?? "").includes("camera=()"));
t("4. X-Frame-Options SAMEORIGIN (preserva preview same-origin)", hd.get("x-frame-options") === "SAMEORIGIN");
t("5. CSP frame-ancestors 'self' na API", (hd.get("content-security-policy") ?? "").includes("frame-ancestors 'self'"));

// headers também em respostas de erro
const hErr = await req("GET", "/rota-inexistente-borda");
t("6. headers presentes em 404", hErr.headers.get("x-content-type-options") === "nosniff" && hErr.status === 404);

// ---------- R3: origem do Socket.IO ----------
function tentarSocket({ cookie, origin, transporte = "websocket" }) {
  return new Promise((resolve) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (origin) headers.origin = origin;
    const s = ioClient(BASE, {
      path: "/socket.io", transports: [transporte], extraHeaders: headers,
      reconnection: false, timeout: 6000,
    });
    const timer = setTimeout(() => { s.close(); resolve({ ok: false, motivo: "timeout" }); }, 8000);
    s.on("connect", () => { clearTimeout(timer); s.close(); resolve({ ok: true }); });
    s.on("connect_error", (e) => { clearTimeout(timer); s.close(); resolve({ ok: false, motivo: String(e?.message ?? e) }); });
  });
}

const SESS = sessaoHttp("admin");

// origem localhost (dev)
let r = await tentarSocket({ cookie: SESS.cookie, origin: "http://localhost:5173" });
t("7. socket origem localhost:5173 conecta", r.ok, r.motivo);

// origem LAN (IP privado)
r = await tentarSocket({ cookie: SESS.cookie, origin: "http://192.168.15.10:5173" });
t("8. socket origem IP privado (LAN) conecta", r.ok, r.motivo);

// origem externa → rejeitada (websocket e polling)
r = await tentarSocket({ cookie: SESS.cookie, origin: "https://evil.example.com" });
t("9. socket origem externa rejeitada (ws)", !r.ok, r.motivo);
r = await tentarSocket({ cookie: SESS.cookie, origin: "https://evil.example.com", transporte: "polling" });
t("10. socket origem externa rejeitada (polling)", !r.ok, r.motivo);

// origem forjada no formato do domínio público não configurado
r = await tentarSocket({ cookie: SESS.cookie, origin: "https://mestre-rpg.falso.com" });
t("11. origem de domínio não configurado rejeitada", !r.ok, r.motivo);

// sem Origin (cliente não-browser) → permitido, mas exige sessão
r = await tentarSocket({ cookie: SESS.cookie });
t("12. socket sem Origin conecta (não-browser)", r.ok, r.motivo);

// sessão inválida continua rejeitada mesmo com origem permitida
r = await tentarSocket({ cookie: "mestre_rpg_session=token-invalido-123", origin: "http://localhost:5173" });
t("13. origem ok + sessão inválida → rejeitado", !r.ok, r.motivo);

// reconexão funciona
{
  const s = ioClient(BASE, { path: "/socket.io", transports: ["websocket"], extraHeaders: { cookie: SESS.cookie }, reconnection: false });
  await new Promise((res2) => s.on("connect", res2));
  const pong1 = await new Promise((res2) => s.emit("ping", res2));
  s.disconnect();
  await sleep(300);
  const s2 = ioClient(BASE, { path: "/socket.io", transports: ["websocket"], extraHeaders: { cookie: SESS.cookie }, reconnection: false });
  const ok2 = await new Promise((res2) => { s2.on("connect", () => res2(true)); s2.on("connect_error", () => res2(false)); setTimeout(() => res2(false), 6000); });
  const pong2 = ok2 ? await new Promise((res2) => s2.emit("ping", res2)) : null;
  s2.close();
  t("14. reconexão socket funciona", pong1 === "pong" && ok2 && pong2 === "pong", `p1=${pong1} p2=${pong2}`);
}

// ---------- R4: rate limiting ----------
// cria dois usuários de teste para limites por usuário
const u1 = await req("POST", "/admin/users", { body: { username: "bord_lim_a", password: "senha-teste-123" } });
const u2 = await req("POST", "/admin/users", { body: { username: "bord_lim_b", password: "senha-teste-123" } });
// idempotente: 409 = usuário já existe de execução anterior — reutiliza
if ([201, 409].includes(u1.status) && [201, 409].includes(u2.status)) {
  const A = sessaoHttp("bord_lim_a");
  const B = sessaoHttp("bord_lim_b");

  // aceite de convite: limite 20/5min por usuário — código inválido conta igual
  let ultimo = null;
  for (let i = 0; i < 21; i++) {
    ultimo = await req("POST", "/convites/CODIGO-FALSO-0000/aceitar", { cookie: A.cookie });
  }
  t("15. 21ª tentativa de aceite → 429", ultimo.status === 429, String(ultimo.status));
  t("16. Retry-After presente no 429", !!ultimo.headers.get("retry-after"), ultimo.headers.get("retry-after"));

  // falsificar X-Forwarded-For não contorna (chave é o usuário)
  ultimo = await req("POST", "/convites/CODIGO-FALSO-0000/aceitar", {
    cookie: A.cookie, headers: { "x-forwarded-for": "6.6.6." + Math.floor(Math.random() * 250) },
  });
  t("17. XFF rotacionado não contorna limite por usuário", ultimo.status === 429, String(ultimo.status));

  // outro usuário não é afetado (limite independente)
  const outro = await req("POST", "/convites/CODIGO-FALSO-0000/aceitar", { cookie: B.cookie });
  t("18. outro usuário não bloqueado", outro.status === 404, String(outro.status));

  // endpoints fora do limite continuam funcionando para o usuário limitado
  const lista = await req("GET", "/campaigns", { cookie: A.cookie });
  t("19. endpoints não limitados seguem ok", lista.status === 200, String(lista.status));

  // consulta de convite tem limite próprio (30/5min): usuário A já tem 22 aceites,
  // mas a consulta usa contador separado — deve funcionar
  const consulta = await req("GET", "/convites/CODIGO-FALSO-0000", { cookie: A.cookie });
  t("20. limite de consulta é independente do aceite", consulta.status === 404, String(consulta.status));

  // login: excesso por username → 429 mesmo rotacionando IP/XFF
  let lg = null;
  for (let i = 0; i < 21; i++) {
    lg = await req("POST", "/auth/login", {
      cookie: "", body: { username: "bord_lim_a", password: "errada-123" },
      headers: { "x-forwarded-for": `10.9.9.${i}` },
    });
  }
  t("21. login: 21ª tentativa no mesmo username → 429", lg.status === 429, String(lg.status));
  t("22. login 429 traz Retry-After", !!lg.headers.get("retry-after"));
} else {
  t("15-22. (skip) falha ao criar usuários de teste", false, `u1=${u1.status} u2=${u2.status}`);
}

// integridade final
const ok = await req("GET", "/health");
t("23. servidor íntegro após bateria", ok.status === 200, String(ok.status));

console.log(res.join("\n"));
console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
