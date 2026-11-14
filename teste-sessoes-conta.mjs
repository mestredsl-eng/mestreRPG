// Testes — gestão de sessões da conta (GET/DELETE /auth/sessions) e
// hardening do ADMIN principal no PATCH /admin/users/:id.
// Cobre: listagem sem tokens, revogação com perda de autenticação,
// sessão atual protegida, IDOR entre usuários, sessão expirada,
// desconexão de sockets da sessão revogada e proteção do principal.
// Banco temporário + migrations reais; sockets reais via socket.io-client.
import { io as ioClient } from "socket.io-client";
import Database from "better-sqlite3";
import { join } from "node:path";
import { hashToken } from "./servidor/dist/lib/password.js";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  req, sessao, abrirDb, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("sessoes-conta");
const BANCO = join(DIR, "mestre-rpg-teste.db");
await prepararBanco(BANCO);

const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc;
const sockets = [];

function conectar(cookie) {
  const token = decodeURIComponent(cookie.split("=")[1]);
  const s = ioClient(BASE, {
    path: "/socket.io",
    transports: ["websocket", "polling"],
    reconnection: false,
    extraHeaders: { cookie: `mestre_rpg_session=${encodeURIComponent(token)}` },
  });
  sockets.push(s);
  return s;
}
const pronto = (s) => new Promise((res, rej) => { s.on("connect", res); s.on("connect_error", rej); });
const esperarDisconnect = (s, ms = 5000) => new Promise((resolve) => {
  const to = setTimeout(() => resolve(false), ms);
  s.on("disconnect", () => { clearTimeout(to); resolve(true); });
});
const idDe = (username) => {
  const db = abrirDb(BANCO);
  const u = db.prepare("select id from users where username=?").get(username);
  db.close();
  return u?.id;
};
const sessaoIdDe = (cookie) => {
  const token = decodeURIComponent(cookie.split("=")[1]);
  const db = abrirDb(BANCO);
  const s = db.prepare("select id from auth_sessions where token_hash=?").get(hashToken(token));
  db.close();
  return s?.id;
};

try {
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
  await esperarSaudavel(BASE, proc);

  sec("Setup — contas");
  const setup = await req(BASE, "POST", "/auth/setup", { body: { username: "root", password: "senha-forte-123", email: "root@local.dev" } });
  t("setup cria admin principal", setup.status === 201, JSON.stringify(setup.json));
  const cookieRoot = sessao(BANCO, idDe("root"));
  const rootLogin = await req(BASE, "POST", "/auth/login", { body: { username: "root", password: "senha-forte-123" } });
  t("login do principal funciona", rootLogin.status === 200 && rootLogin.json?.usuario?.adminPrincipal === true, JSON.stringify(rootLogin.json).slice(0, 200));
  for (const u of ["alice", "bob", "carol"]) {
    const c = await req(BASE, "POST", "/admin/users", { cookie: cookieRoot, body: { username: u, password: "senha-forte-123" } });
    t(`cria ${u}`, c.status === 201, JSON.stringify(c.json));
  }
  const cookieAlice = sessao(BANCO, idDe("alice"));
  const cookieAlice2 = sessao(BANCO, idDe("alice")); // segunda sessão da mesma conta
  const cookieBob = sessao(BANCO, idDe("bob"));

  sec("GET /auth/sessions — listagem da própria conta");
  const listaAlice = await req(BASE, "GET", "/auth/sessions", { cookie: cookieAlice });
  t("lista sessões da própria conta", listaAlice.status === 200, JSON.stringify(listaAlice.json).slice(0, 200));
  const sessoesAlice = listaAlice.json?.sessoes ?? [];
  t("duas sessões ativas de alice", sessoesAlice.length === 2, JSON.stringify(sessoesAlice).slice(0, 300));
  t("sessão atual marcada", sessoesAlice.filter((s) => s.atual).length === 1);
  t("expõe dispositivo/IP/datas", sessoesAlice.every((s) => "userAgent" in s && "ip" in s && "createdAt" in s && "expiresAt" in s));
  t("nenhum token/hash na resposta", !JSON.stringify(listaAlice.json).match(/token|hash/i), JSON.stringify(listaAlice.json).slice(0, 300));
  const listaBob = await req(BASE, "GET", "/auth/sessions", { cookie: cookieBob });
  t("bob só vê a própria sessão", listaBob.status === 200 && (listaBob.json?.sessoes ?? []).length === 1 && !listaBob.json.sessoes.some((s) => sessoesAlice.some((a) => a.id === s.id)));
  const semAuth = await req(BASE, "GET", "/auth/sessions", {});
  t("sem autenticação → 401", semAuth.status === 401, String(semAuth.status));

  sec("DELETE /auth/sessions/:id — revogação");
  const idAlice2 = sessaoIdDe(cookieAlice2);
  const revOutroUsuario = await req(BASE, "DELETE", `/auth/sessions/${idAlice2}`, { cookie: cookieBob });
  t("revogar sessão alheia → 404", revOutroUsuario.status === 404, String(revOutroUsuario.status));
  const idAtual = sessaoIdDe(cookieAlice);
  const revAtual = await req(BASE, "DELETE", `/auth/sessions/${idAtual}`, { cookie: cookieAlice });
  t("revogar sessão atual → 400", revAtual.status === 400, String(revAtual.status));
  t("sessão atual segue válida", (await req(BASE, "GET", "/auth/me", { cookie: cookieAlice })).status === 200);
  const revInexistente = await req(BASE, "DELETE", "/auth/sessions/id-inexistente", { cookie: cookieAlice });
  t("ID inexistente → 404", revInexistente.status === 404, String(revInexistente.status));

  sec("Sessão expirada — fora da lista e irrevogável");
  const uidAlice = idDe("alice");
  const dbx = abrirDb(BANCO);
  dbx.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), uidAlice, hashToken("exp-" + crypto.randomUUID()), "velho", "127.0.0.1", Date.now() - 1000, Date.now() - 999999);
  dbx.close();
  const listaAposExpirada = await req(BASE, "GET", "/auth/sessions", { cookie: cookieAlice });
  t("expirada não aparece na listagem", (listaAposExpirada.json?.sessoes ?? []).length === 2, JSON.stringify(listaAposExpirada.json?.sessoes?.length));
  const idExpirada = (() => { const d = abrirDb(BANCO); const r = d.prepare("select id from auth_sessions where user_id=? and expires_at<?").get(uidAlice, Date.now()); d.close(); return r?.id; })();
  const revExpirada = await req(BASE, "DELETE", `/auth/sessions/${idExpirada}`, { cookie: cookieAlice });
  t("revogar expirada → 404", revExpirada.status === 404, String(revExpirada.status));

  sec("Revogação derruba autenticação e sockets da sessão");
  const sock = conectar(cookieAlice2);
  await pronto(sock);
  const dis = esperarDisconnect(sock);
  const revOk = await req(BASE, "DELETE", `/auth/sessions/${idAlice2}`, { cookie: cookieAlice });
  t("revogação válida → 200", revOk.status === 200 && revOk.json?.ok === true, JSON.stringify(revOk.json));
  t("sessão revogada perde /auth/me", (await req(BASE, "GET", "/auth/me", { cookie: cookieAlice2 })).status === 401);
  t("socket da sessão revogada desconecta", await dis);
  t("sessão atual de alice segue válida", (await req(BASE, "GET", "/auth/me", { cookie: cookieAlice })).status === 200);
  const listaFinal = await req(BASE, "GET", "/auth/sessions", { cookie: cookieAlice });
  t("listagem final tem só a sessão atual", (listaFinal.json?.sessoes ?? []).length === 1 && listaFinal.json.sessoes[0].atual === true);

  sec("ADMIN secundário não altera dados do principal");
  const concedeCarol = await req(BASE, "PATCH", `/admin/users/${idDe("carol")}`, { cookie: cookieRoot, body: { isAdmin: true } });
  t("principal concede ADMIN a carol", concedeCarol.status === 200 && concedeCarol.json?.usuario?.isAdmin === true, JSON.stringify(concedeCarol.json).slice(0, 200));
  const cookieCarol = sessao(BANCO, idDe("carol"));
  const idRoot = idDe("root");
  for (const [campo, valor] of [["username", "root_sequestrado"], ["email", "invasor@x.dev"], ["displayName", "Nome Roubado"]]) {
    const r = await req(BASE, "PATCH", `/admin/users/${idRoot}`, { cookie: cookieCarol, body: { [campo]: valor } });
    t(`secundário PATCH ${campo} do principal → 403`, r.status === 403, `status=${r.status} body=${JSON.stringify(r.json).slice(0, 120)}`);
  }
  const dbA = abrirDb(BANCO);
  const rootDepois = dbA.prepare("select username,email,display_name from users where id=?").get(idRoot);
  dbA.close();
  t("dados do principal intactos", rootDepois.username === "root" && rootDepois.email === "root@local.dev" && rootDepois.display_name === null, JSON.stringify(rootDepois));
  const bloqueio = await req(BASE, "PATCH", `/admin/users/${idRoot}`, { cookie: cookieCarol, body: { status: "bloqueado" } });
  t("secundário não bloqueia principal → 403", bloqueio.status === 403, String(bloqueio.status));
  const exclusao = await req(BASE, "DELETE", `/admin/users/${idRoot}`, { cookie: cookieCarol });
  t("secundário não exclui principal → 403", exclusao.status === 403, String(exclusao.status));
  const rebaixa = await req(BASE, "PATCH", `/admin/users/${idRoot}`, { cookie: cookieCarol, body: { isAdmin: false } });
  t("secundário não rebaixa principal → 403", rebaixa.status === 403, String(rebaixa.status));
  t("principal segue funcionando", (await req(BASE, "GET", "/auth/me", { cookie: cookieRoot })).status === 200);

  sec("ADMIN secundário administra usuários comuns");
  const editaComum = await req(BASE, "PATCH", `/admin/users/${idDe("bob")}`, { cookie: cookieCarol, body: { displayName: "Bob da Silva" } });
  t("secundário edita usuário comum → 200", editaComum.status === 200 && editaComum.json?.usuario?.displayName === "Bob da Silva", JSON.stringify(editaComum.json).slice(0, 200));
  const autoEdicao = await req(BASE, "PATCH", `/admin/users/${idDe("carol")}`, { cookie: cookieCarol, body: { displayName: "Carol" } });
  t("secundário não edita a própria conta → 400", autoEdicao.status === 400, String(autoEdicao.status));

  sec("Principal preserva autonomia de perfil");
  const selfPerfil = await req(BASE, "PATCH", `/admin/users/${idRoot}`, { cookie: cookieRoot, body: { displayName: "Rafuka", email: "novo@local.dev" } });
  t("principal edita próprio perfil → 200", selfPerfil.status === 200 && selfPerfil.json?.usuario?.displayName === "Rafuka" && selfPerfil.json?.usuario?.email === "novo@local.dev", JSON.stringify(selfPerfil.json).slice(0, 300));
  for (const [campo, valor] of [["isAdmin", false], ["status", "bloqueado"], ["password", "outra-senha-123"]]) {
    const r = await req(BASE, "PATCH", `/admin/users/${idRoot}`, { cookie: cookieRoot, body: { [campo]: valor } });
    t(`principal não altera ${campo} de si → 403/400`, [400, 403].includes(r.status), `status=${r.status}`);
  }
  const loginAposPerfil = await req(BASE, "POST", "/auth/login", { body: { username: "root", password: "senha-forte-123" } });
  t("login do principal segue válido", loginAposPerfil.status === 200, String(loginAposPerfil.status));

  sec("Auditoria");
  const dbF = abrirDb(BANCO);
  const acoes = dbF.prepare("select action, detail from audit_logs").all();
  t("audit registra admin.principal.bloqueado", acoes.filter((a) => a.action === "admin.principal.bloqueado").length >= 4, JSON.stringify(acoes.map((a) => a.action)));
  t("audit registra admin.principal.perfil", acoes.some((a) => a.action === "admin.principal.perfil"), JSON.stringify(acoes.map((a) => a.action)));
  t("audit registra admin.conceder", acoes.some((a) => a.action === "admin.conceder"));
  dbF.close();
} finally {
  for (const s of sockets) { try { s.disconnect(); } catch { } }
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
