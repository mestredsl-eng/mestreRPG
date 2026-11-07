// Testes de integração — Etapa 15 Fase 3: robustez e tratamento de erros
// Cobre entradas malformadas, padronização de erros HTTP e exclusão de usuários.
import Database from "better-sqlite3";
import { hashToken } from "./servidor/dist/lib/password.js";

const BASE = "http://localhost:3001";
const API = BASE + "/api";
const db = new Database("banco/mestre-rpg.db");

function sessaoHttp(username) {
  const u = db.prepare("select id from users where username=?").get(username);
  if (!u) throw new Error("usuário inexistente: " + username);
  const token = "t15e-" + crypto.randomUUID();
  db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), u.id, hashToken(token), "t", "127.0.0.1", Date.now() + 86400000, Date.now());
  return { token, cookie: `mestre_rpg_session=${encodeURIComponent(token)}` };
}
const ADMIN = sessaoHttp("admin");

async function reqBruta(metodo, path, { cookie, body, contentType = "application/json", raw } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (contentType) headers["content-type"] = contentType;
  const r = await fetch(`${API}${path}`, {
    method: metodo, headers,
    body: raw !== undefined ? raw : body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  let json = null;
  try { json = await r.json(); } catch { }
  return { status: r.status, json };
}
const req = (m, p, o = {}) => reqBruta(m, p, { cookie: ADMIN.cookie, ...o });

let pass = 0, fail = 0;
const res = [];
const t = (n, c, extra = "") => { if (c) { pass++; res.push("ok " + n); } else { fail++; res.push("FALHOU " + n + " " + extra); } console.error((c ? "ok " : "FALHOU ") + n + (extra ? " — " + extra : "")); };
const semVazar = (j) => j && typeof j.erro === "string" && !/sqlite|select |insert |C:\\|node_modules|stack/i.test(j.erro);

// ---------- JSON malformado ----------
const j1 = await reqBruta("POST", "/campaigns", { body: "{ nao e json !!!" });
t("1. JSON malformado → 400", j1.status === 400, String(j1.status));
t("1b. resposta não vaza detalhes", semVazar(j1.json), JSON.stringify(j1.json));

const j2 = await reqBruta("POST", "/auth/login", { body: '{"username":' });
t("2. login com JSON quebrado → 400", j2.status === 400, String(j2.status));

// ---------- payload acima do limite (2mb) ----------
const grande = JSON.stringify({ name: "x".repeat(3 * 1024 * 1024) });
const j3 = await reqBruta("POST", "/campaigns", { body: grande });
t("3. payload >2MB → 413", j3.status === 413, String(j3.status));

// ---------- cookie malformado ----------
const c1 = await req("GET", "/campaigns", { cookie: "mestre_rpg_session=%E0%A4%A" });
t("4. cookie com percent-encoding inválido → 401 (não trava)", c1.status === 401, String(c1.status));

const c2 = await req("GET", "/auth/me", { cookie: "mestre_rpg_session=lixo%%qualquer%%coisa" });
t("5. cookie inválido → 401", c2.status === 401, String(c2.status));

const c3 = await req("POST", "/auth/logout", { cookie: "mestre_rpg_session=%E0%A4%A" });
t("6. logout com cookie malformado responde", c3.status === 200 || c3.status === 401, String(c3.status));

// cookie gigante
t("7. cookie gigante não trava", (await req("GET", "/campaigns", { cookie: "mestre_rpg_session=" + "a".repeat(8000) })).status === 401);

// ---------- IDs e parâmetros inválidos ----------
const cidTeste = db.prepare("select id from campaigns order by created_at desc limit 1").get()?.id;
const id1 = await req("GET", `/characters/${crypto.randomUUID()}`);
t("8. personagem inexistente → 404", id1.status === 404, String(id1.status));

const id2 = await req("GET", "/characters/../../etc/passwd");
t("9. id com path traversal → 404/400 sem vazar", [400, 404].includes(id2.status), String(id2.status));

const id3 = await req("PATCH", `/campaigns/${cidTeste}/members/id-inexistente`, { body: { status: "ativo" } });
t("10. membership inexistente → 404", id3.status === 404, String(id3.status));

// ---------- campos ausentes / tipos errados (validação zod) ----------
const v1 = await req("POST", "/campaigns", { body: {} });
t("11. POST campanha sem nome → 400", v1.status === 400, String(v1.status));

const v2 = await req("POST", "/campaigns", { body: { name: 12345 } });
t("12. tipo errado em campo → 400", v2.status === 400, String(v2.status));

const v3 = await req("PATCH", `/campaigns/${cidTeste}/members/x`, { body: { status: "hacker" } });
t("13. status inválido → 400", v3.status === 400, String(v3.status));

const v4 = await req("POST", "/auth/login", { body: { username: "ad", password: "123" } });
t("14. login com credenciais curtas → 400/401", [400, 401].includes(v4.status), String(v4.status));

// ---------- rota inexistente ----------
const r1 = await req("GET", "/rota-que-nao-existe");
t("15. rota API inexistente → 404 JSON", r1.status === 404 && typeof r1.json?.erro === "string", `${r1.status} ${JSON.stringify(r1.json)}`);

const r2 = await req("GET", "/campaigns/nao-existe/personagens");
t("16. sub-rota inexistente → 404/403", [403, 404].includes(r2.status), String(r2.status));

// ---------- não autenticado ----------
const a1 = await reqBruta("GET", "/campaigns");
t("17. sem credenciais → 401", a1.status === 401, String(a1.status));

const a2 = await reqBruta("GET", "/admin/users");
t("18. admin sem auth → 401", a2.status === 401, String(a2.status));

const a3 = await reqBruta("GET", "/admin/servidor/status");
t("19. admin/servidor sem auth → 401", a3.status === 401, String(a3.status));

// ---------- headers inesperados ----------
const h1 = await reqBruta("GET", "/health", { cookie: "x".repeat(70000) });
t("20. header cookie gigante não trava", [200, 401, 431].includes(h1.status), String(h1.status));

// ---------- exclusão de usuários (integridade do banco) ----------
// usuário COM histórico: jog_bloqueio enviou mensagens de chat na suíte anterior
const usuarios = (await req("GET", "/admin/users")).json?.usuarios ?? [];
const comHistorico = usuarios.find((u) => u.username === "jog_bloqueio");
const semHistorico = usuarios.find((u) => u.username === "mest_bloqueio");

if (comHistorico) {
  const d1 = await req("DELETE", `/admin/users/${comHistorico.id}`);
  t("21. delete usuário com chat → 409 (não 500/travado)", d1.status === 409, String(d1.status));
  t("21b. erro 409 não vaza detalhes", semVazar(d1.json), JSON.stringify(d1.json));
  // histórico preservado: mensagens ainda existem
  const msgs = db.prepare("select count(*) n from chat_messages where author_id=?").get(comHistorico.id).n;
  t("21c. mensagens preservadas após 409", msgs > 0, `msgs=${msgs}`);
  const aindaExiste = db.prepare("select id from users where id=?").get(comHistorico.id);
  t("21d. usuário não foi apagado", !!aindaExiste);
} else {
  t("21. (skip) jog_bloqueio não existe", false, "dependência da suíte bloqueio");
}

// usuário SEM histórico → exclusão física permitida
const novo = await req("POST", "/admin/users", { body: { username: "sem_hist_15", password: "senha-teste-123" } });
if (novo.status === 201 || novo.status === 409) {
  const uid = novo.json?.usuario?.id ?? usuarios.find((u) => u.username === "sem_hist_15")?.id
    ?? (await req("GET", "/admin/users")).json?.usuarios?.find((u) => u.username === "sem_hist_15")?.id;
  const d2 = await req("DELETE", `/admin/users/${uid}`);
  t("22. delete usuário sem histórico → 200", d2.status === 200, String(d2.status));
  const sumiu = !db.prepare("select id from users where id=?").get(uid);
  t("22b. usuário removido do banco", sumiu);
} else {
  t("22. (skip) falha ao criar usuário de teste", false, String(novo.status));
}

// delete inexistente / próprio usuário
const d3 = await req("DELETE", "/admin/users/id-inexistente");
t("23. delete usuário inexistente → 404", d3.status === 404, String(d3.status));
const adminId = usuarios.find((u) => u.username === "admin")?.id;
const d4 = await req("DELETE", `/admin/users/${adminId}`);
t("24. admin não remove a si mesmo → 400", d4.status === 400, String(d4.status));

// integridade pós-erros: banco responde e dados intactos
const ok = await req("GET", "/health");
t("25. servidor íntegro após bateria de erros", ok.status === 200, String(ok.status));
const nCamp = db.prepare("select count(*) n from campaigns").get().n;
t("26. campanhas preservadas", nCamp > 0, `n=${nCamp}`);

console.log(res.join("\n"));
console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
