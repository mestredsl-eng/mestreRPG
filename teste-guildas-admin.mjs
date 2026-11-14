// Testes — hierarquia de contas Issue #65: guildas, GUILD MASTER (GM) e
// multi-ADMIN com ADMIN principal protegido. Cobre IDOR entre guildas,
// proteção do último GM, vínculo de campanhas, concessão/revogação de
// ADMIN somente pelo principal, revogação de sessões e trilha de auditoria.
// Banco temporário + migrations reais (sem fixture local).
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import Database from "better-sqlite3";
import { join } from "node:path";
import { hashToken } from "./servidor/dist/lib/password.js";
import { dirTeste, prepararBanco, limparDir, abrirDb } from "./teste-base.mjs";

const DIR = dirTeste("guildas-admin");
const BANCO = join(DIR, "mestre-rpg-teste.db");
await prepararBanco(BANCO);

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
    env: { ...process.env, MESTRE_PORTA: String(porta), MESTRE_BANCO: BANCO, MESTRE_ARQUIVOS: DIR + "/arq", MESTRE_BACKUPS: DIR + "/bks", MESTRE_SQL_TRACE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
function sessaoDb(userId) {
  const db = abrirDb(BANCO);
  const token = "t-" + crypto.randomUUID();
  db.prepare("insert into auth_sessions (id,user_id,token_hash,user_agent,ip,expires_at,created_at) values (?,?,?,?,?,?,?)")
    .run(crypto.randomUUID(), userId, hashToken(token), "t", "127.0.0.1", Date.now() + 86400000, Date.now());
  db.close();
  return `mestre_rpg_session=${encodeURIComponent(token)}`;
}
async function req(base, metodo, path, { cookie, body } = {}) {
  const r = await fetch(base + "/api" + path, {
    method: metodo,
    headers: { "content-type": "application/json", cookie: cookie ?? "" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const idDe = (username) => {
  const db = abrirDb(BANCO);
  const u = db.prepare("select id from users where username=?").get(username);
  db.close();
  return u?.id;
};
const principalId = () => {
  const db = abrirDb(BANCO);
  const p = db.prepare("select user_id from admin_principal").get();
  db.close();
  return p?.user_id;
};

const porta = await portaLivre();
const base = `http://127.0.0.1:${porta}`;
const proc = subir(porta);
// evidência de N+1: conta SELECTs diretos em "memberships" emitidos no
// stderr (MESTRE_SQL_TRACE). O JOIN de campanhas-candidatas usa
// `left join "memberships"` e NÃO casa com /from "memberships"/.
let sqlBuf = "", sqlMemberships = 0;
proc.stderr.on("data", (d) => {
  sqlBuf += d;
  let i;
  while ((i = sqlBuf.indexOf("\n")) >= 0) {
    const linha = sqlBuf.slice(0, i);
    sqlBuf = sqlBuf.slice(i + 1);
    if (linha.includes("[sql]") && /from "memberships"/.test(linha)) sqlMemberships++;
  }
});
await esperarSaudavel(base, proc);

try {
  sec("Setup — ADMIN principal e contas comuns");
  const setup = await req(base, "POST", "/auth/setup", { body: { username: "root", password: "senha-forte-123" } });
  t("setup cria admin", setup.status === 201, JSON.stringify(setup.json));
  const cookieRoot = sessaoDb(idDe("root"));
  const pid = principalId();
  t("admin_principal registrado", !!pid && pid === idDe("root"));

  for (const u of ["alice", "bob", "carol"]) {
    const c = await req(base, "POST", "/admin/users", { cookie: cookieRoot, body: { username: u, password: "senha-forte-123" } });
    t(`cria ${u}`, c.status === 201, JSON.stringify(c.json));
  }
  const cookieAlice = sessaoDb(idDe("alice"));
  const cookieBob = sessaoDb(idDe("bob"));
  const cookieCarol = sessaoDb(idDe("carol"));

  sec("Escopo em /auth/me");
  const meRoot = await req(base, "GET", "/auth/me", { cookie: cookieRoot });
  t("root: isAdmin + adminPrincipal", meRoot.json?.usuario?.isAdmin === true && meRoot.json?.usuario?.adminPrincipal === true);
  const meAlice = await req(base, "GET", "/auth/me", { cookie: cookieAlice });
  t("alice: sem escopos", meAlice.json?.usuario?.isAdmin === false && meAlice.json?.usuario?.adminPrincipal === false && (meAlice.json?.usuario?.guildas ?? []).length === 0);

  sec("Guildas — criação e papéis");
  const gA = await req(base, "POST", "/guildas", { cookie: cookieAlice, body: { name: "Guilda A", description: "teste" } });
  t("alice cria Guilda A", gA.status === 201 && gA.json?.guilda?.souGM === true, JSON.stringify(gA.json));
  const guildA = gA.json.guilda.id;
  const gB = await req(base, "POST", "/guildas", { cookie: cookieCarol, body: { name: "Guilda B" } });
  t("carol cria Guilda B", gB.status === 201);
  const guildB = gB.json.guilda.id;
  t("nome duplicado recusado", (await req(base, "POST", "/guildas", { cookie: cookieBob, body: { name: "Guilda A" } })).status === 409);

  const addBob = await req(base, "POST", `/guildas/${guildA}/membros`, { cookie: cookieAlice, body: { username: "bob" } });
  t("GM adiciona bob como membro", addBob.status === 201, JSON.stringify(addBob.json));
  const bobPromove = await req(base, "PATCH", `/guildas/${guildA}/membros/${idDe("bob")}`, { cookie: cookieBob, body: { role: "gm" } });
  t("membro comum NÃO gerencia guilda", bobPromove.status === 403, String(bobPromove.status));
  const bobLeMembros = await req(base, "GET", `/guildas/${guildA}/membros`, { cookie: cookieBob });
  t("membro lê roster", bobLeMembros.status === 200 && bobLeMembros.json?.membros?.length === 2);

  sec("IDOR — GM da Guilda A não toca a Guilda B");
  t("GET guilda B negado a alice", (await req(base, "GET", `/guildas/${guildB}`, { cookie: cookieAlice })).status === 403);
  t("PATCH guilda B negada a alice", (await req(base, "PATCH", `/guildas/${guildB}`, { cookie: cookieAlice, body: { name: "invadida" } })).status === 403);
  t("membros guilda B negados a alice", (await req(base, "GET", `/guildas/${guildB}/membros`, { cookie: cookieAlice })).status === 403);
  t("alice não lista guilda B no /me", !(await req(base, "GET", "/auth/me", { cookie: cookieAlice })).json?.usuario?.guildas?.some((g) => g.guildId === guildB));
  const adminVeTodas = await req(base, "GET", "/guildas?todas=1", { cookie: cookieRoot });
  t("ADMIN lista todas as guildas", adminVeTodas.status === 200 && adminVeTodas.json?.guildas?.length === 2);
  t("não-admin não lista todas", (await req(base, "GET", "/guildas?todas=1", { cookie: cookieAlice })).status === 403);

  sec("Último GM protegido");
  const gSolo = await req(base, "POST", "/guildas", { cookie: cookieBob, body: { name: "Guilda Solo" } });
  const guildSolo = gSolo.json.guilda.id;
  const selfRem = await req(base, "DELETE", `/guildas/${guildSolo}/membros/${idDe("bob")}`, { cookie: cookieBob });
  t("remover único GM recusado", selfRem.status === 409, JSON.stringify(selfRem.json));
  const selfRebaixa = await req(base, "PATCH", `/guildas/${guildSolo}/membros/${idDe("bob")}`, { cookie: cookieBob, body: { role: "membro" } });
  t("rebaixar único GM recusado", selfRebaixa.status === 409);
  await req(base, "POST", `/guildas/${guildSolo}/membros`, { cookie: cookieBob, body: { username: "carol" } });
  await req(base, "PATCH", `/guildas/${guildSolo}/membros/${idDe("carol")}`, { cookie: cookieBob, body: { role: "gm" } });
  const selfRem2 = await req(base, "DELETE", `/guildas/${guildSolo}/membros/${idDe("bob")}`, { cookie: cookieBob });
  t("remoção do GM ok após sucessão", selfRem2.status === 200, JSON.stringify(selfRem2.json));

  sec("Campanhas e guilda — escopos separados");
  // promove bob a GM da Guilda A (por alice, GM ativa) para isolar a regra
  // de vínculo: GM SEM papel de mesa não pode vincular campanha alheia
  await req(base, "PATCH", `/guildas/${guildA}/membros/${idDe("bob")}`, { cookie: cookieAlice, body: { role: "gm" } });
  const campAlice = await req(base, "POST", "/campaigns", { cookie: cookieAlice, body: { name: "Campanha Alice" } });
  t("alice cria campanha sem guilda", campAlice.status === 201 && campAlice.json?.campanha?.guildId === null);
  const campId = campAlice.json.campanha.id;
  const vincBob = await req(base, "PUT", `/guildas/${guildA}/campanhas/${campId}`, { cookie: cookieBob, body: { acao: "vincular" } });
  t("GM sem papel de mesa NÃO vincula campanha alheia", vincBob.status === 403, String(vincBob.status));
  const vincAlice = await req(base, "PUT", `/guildas/${guildA}/campanhas/${campId}`, { cookie: cookieAlice, body: { acao: "vincular" } });
  t("mestre+GM vincula campanha própria", vincAlice.status === 200 && vincAlice.json?.campanha?.guildId === guildA, JSON.stringify(vincAlice.json));
  const campFora = await req(base, "POST", "/campaigns", { cookie: cookieCarol, body: { name: "Campanha Carol", guildId: guildA } });
  t("não-GM não cria campanha na guilda", campFora.status === 403, String(campFora.status));
  const campCarol = await req(base, "POST", "/campaigns", { cookie: cookieCarol, body: { name: "Campanha Carol" } });
  const vincAdmin = await req(base, "PUT", `/guildas/${guildA}/campanhas/${campCarol.json.campanha.id}`, { cookie: cookieRoot, body: { acao: "vincular" } });
  t("ADMIN vincula campanha alheia", vincAdmin.status === 200, JSON.stringify(vincAdmin.json));
  // mover entre guildas: exclusivo do ADMIN (revisão Devin — antes o 409
  // vinha antes da checagem de privilégio e o ADMIN nunca movia)
  const moveCarol = await req(base, "PUT", `/guildas/${guildB}/campanhas/${campCarol.json.campanha.id}`, { cookie: cookieCarol, body: { acao: "vincular" } });
  t("GM não move campanha entre guildas", moveCarol.status === 409, String(moveCarol.status));
  const moveAdmin = await req(base, "PUT", `/guildas/${guildB}/campanhas/${campCarol.json.campanha.id}`, { cookie: cookieRoot, body: { acao: "vincular" } });
  t("ADMIN move campanha entre guildas", moveAdmin.status === 200 && moveAdmin.json?.campanha?.guildId === guildB, JSON.stringify(moveAdmin.json));
  const desvGM = await req(base, "PUT", `/guildas/${guildA}/campanhas/${campId}`, { cookie: cookieAlice, body: { acao: "desvincular" } });
  t("GM não desvincula (só ADMIN)", desvGM.status === 403);
  const desvAdmin = await req(base, "PUT", `/guildas/${guildA}/campanhas/${campId}`, { cookie: cookieRoot, body: { acao: "desvincular" } });
  t("ADMIN desvincula", desvAdmin.status === 200);
  t("campanha volta a guildId null", (await req(base, "GET", `/campaigns/${campId}`, { cookie: cookieAlice })).json?.campanha?.guildId === null);

  sec("Importação — guildId do pacote exige GM/ADMIN da guilda");
  // pacote mínimo válido: entidades vazias (ids do pacote colidiriam
  // com a campanha original — importação entre instalações é o caso real)
  const pacoteMin = (cid, guildId) => ({
    versao: 1,
    campanhaId: cid,
    estado: {
      campanha: { name: `Importada ${cid}`, description: null, system: null, coverImage: null, status: "ativa", guildId, settings: {}, summary: null },
      memberships: [], characters: [],
    },
    arquivos: {},
  });
  // bob é GM da Guilda A mas NÃO da B: pacote apontando para B perde o vínculo
  const impBob = await req(base, "POST", "/campaigns/importar", { cookie: cookieBob, body: { pacote: pacoteMin(`imp-${crypto.randomUUID().slice(0, 8)}`, guildB), modo: "nova" } });
  const cidBob = impBob.json?.campaignId;
  const campBob = cidBob ? await req(base, "GET", `/campaigns/${cidBob}`, { cookie: cookieBob }) : null;
  t("import sem GM da guilda → guildId ignorado", (impBob.status === 200 || impBob.status === 201) && (campBob?.json?.campanha?.guildId ?? null) === null, JSON.stringify({ gid: campBob?.json?.campanha?.guildId, resp: campBob?.json }).slice(0, 300));
  // carol É GM da Guilda B: o vínculo do pacote é honrado
  const impCarol = await req(base, "POST", "/campaigns/importar", { cookie: cookieCarol, body: { pacote: pacoteMin(`imp-${crypto.randomUUID().slice(0, 8)}`, guildB), modo: "nova" } });
  const cidCarol = impCarol.json?.campaignId;
  const campImpCarol = cidCarol ? await req(base, "GET", `/campaigns/${cidCarol}`, { cookie: cookieCarol }) : null;
  t("GM da guilda importa vínculo honrado", (impCarol.status === 200 || impCarol.status === 201) && campImpCarol?.json?.campanha?.guildId === guildB, JSON.stringify({ st: impCarol.status, erro: impCarol.json?.erro, gid: campImpCarol?.json?.campanha?.guildId }));

  sec("Multi-ADMIN — somente o principal concede/revoga");
  const concedeBob = await req(base, "PATCH", `/admin/users/${idDe("bob")}`, { cookie: cookieAlice, body: { isAdmin: true } });
  t("não-admin não concede ADMIN", concedeBob.status === 403);
  const concedeAlice = await req(base, "PATCH", `/admin/users/${idDe("alice")}`, { cookie: cookieRoot, body: { isAdmin: true } });
  t("principal concede ADMIN a alice", concedeAlice.status === 200 && concedeAlice.json?.usuario?.isAdmin === true, JSON.stringify(concedeAlice.json));
  const cookieAliceAdmin = sessaoDb(idDe("alice"));
  const aliceViraAdmin = await req(base, "GET", "/auth/me", { cookie: cookieAliceAdmin });
  t("alice agora éAdmin, não principal", aliceViraAdmin.json?.usuario?.isAdmin === true && aliceViraAdmin.json?.usuario?.adminPrincipal === false);
  const aliceConcede = await req(base, "PATCH", `/admin/users/${idDe("carol")}`, { cookie: cookieAliceAdmin, body: { isAdmin: true } });
  t("ADMIN não-principal NÃO concede ADMIN", aliceConcede.status === 403, String(aliceConcede.status));
  const aliceAlteraProprio = await req(base, "PATCH", `/admin/users/${pid}`, { cookie: cookieAliceAdmin, body: { isAdmin: false } });
  t("ADMIN não-principal não rebaixa o principal", aliceAlteraProprio.status === 403);
  // takeover do principal via troca de senha — bloqueado (revisão Devin)
  const senhaPrincipal = await req(base, "PATCH", `/admin/users/${pid}`, { cookie: cookieAliceAdmin, body: { password: "senha-sequestrada-123" } });
  t("ADMIN secundário NÃO troca senha do principal", senhaPrincipal.status === 403, String(senhaPrincipal.status));
  const rootSeAuto = await req(base, "PATCH", `/admin/users/${pid}`, { cookie: cookieRoot, body: { isAdmin: false } });
  // autoedição de perfil passou a ser permitida ao principal, mas
  // privilégio/bloqueio/senha do alvo protegido seguem barrados (403)
  t("principal não rebaixa a si mesmo", rootSeAuto.status === 403, String(rootSeAuto.status));
  const revogaAlice = await req(base, "PATCH", `/admin/users/${idDe("alice")}`, { cookie: cookieRoot, body: { isAdmin: false } });
  t("principal revoga ADMIN", revogaAlice.status === 200 && revogaAlice.json?.usuario?.isAdmin === false);
  const meAposRevoga = await req(base, "GET", "/auth/me", { cookie: cookieAliceAdmin });
  t("sessões derrubadas na revogação", meAposRevoga.status === 401, String(meAposRevoga.status));
  const cookieAlicePos = sessaoDb(idDe("alice"));
  const meAliceNova = await req(base, "GET", "/auth/me", { cookie: cookieAlicePos });
  t("nova sessão de alice sem isAdmin", meAliceNova.json?.usuario?.isAdmin === false);

  sec("Triggers do banco — proteção em profundidade");
  const db = abrirDb(BANCO);
  let triggerOk = false;
  try { db.prepare("update users set is_admin=0 where id=?").run(pid); } catch { triggerOk = true; }
  t("trigger impede rebaixar admin_principal", triggerOk);
  let insertOk = false;
  try {
    db.prepare("insert into users (id,username,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,?,?,?)")
      .run(crypto.randomUUID(), "admin_invasor", "x", 1, "ativo", Date.now(), Date.now());
  } catch { insertOk = true; }
  t("trigger impede INSERT direto de admin", insertOk);
  db.close();

  sec("Último GM capaz — conta bloqueada não sustenta a guilda");
  const gBloq = await req(base, "POST", "/guildas", { cookie: cookieBob, body: { name: "Guilda Bloqueio" } });
  const guildBloq = gBloq.json.guilda.id;
  await req(base, "POST", `/guildas/${guildBloq}/membros`, { cookie: cookieBob, body: { username: "alice" } });
  await req(base, "PATCH", `/guildas/${guildBloq}/membros/${idDe("alice")}`, { cookie: cookieBob, body: { role: "gm" } });
  // bloqueia a conta da alice: ela não consegue mais autenticar
  await req(base, "PATCH", `/admin/users/${idDe("alice")}`, { cookie: cookieRoot, body: { status: "bloqueado" } });
  const bobSome = await req(base, "DELETE", `/guildas/${guildBloq}/membros/${idDe("bob")}`, { cookie: cookieBob });
  t("GM bloqueado não conta — remoção do último capaz recusada", bobSome.status === 409, JSON.stringify(bobSome.json));
  await req(base, "PATCH", `/admin/users/${idDe("alice")}`, { cookie: cookieRoot, body: { status: "ativo" } });
  const bobSome2 = await req(base, "DELETE", `/guildas/${guildBloq}/membros/${idDe("bob")}`, { cookie: cookieBob });
  t("com GM capaz, a remoção passa", bobSome2.status === 200, JSON.stringify(bobSome2.json));

  sec("GM de conta bloqueada pode ser removido/rebaixado");
  const gBk = await req(base, "POST", "/guildas", { cookie: cookieBob, body: { name: "Guilda Bloqueada" } });
  const guildBk = gBk.json.guilda.id;
  await req(base, "POST", `/guildas/${guildBk}/membros`, { cookie: cookieBob, body: { username: "alice" } });
  await req(base, "POST", `/guildas/${guildBk}/membros`, { cookie: cookieBob, body: { username: "carol" } });
  await req(base, "PATCH", `/guildas/${guildBk}/membros/${idDe("alice")}`, { cookie: cookieBob, body: { role: "gm" } });
  await req(base, "PATCH", `/guildas/${guildBk}/membros/${idDe("carol")}`, { cookie: cookieBob, body: { role: "gm" } });
  // bloqueia as contas de alice e carol — só bob segue como GM capaz
  await req(base, "PATCH", `/admin/users/${idDe("alice")}`, { cookie: cookieRoot, body: { status: "bloqueado" } });
  await req(base, "PATCH", `/admin/users/${idDe("carol")}`, { cookie: cookieRoot, body: { status: "bloqueado" } });
  const remAliceBk = await req(base, "DELETE", `/guildas/${guildBk}/membros/${idDe("alice")}`, { cookie: cookieBob });
  t("remover GM de conta bloqueada passa (resta GM capaz)", remAliceBk.status === 200, JSON.stringify(remAliceBk.json));
  const rebCarolBk = await req(base, "PATCH", `/guildas/${guildBk}/membros/${idDe("carol")}`, { cookie: cookieBob, body: { role: "membro" } });
  t("rebaixar GM de conta bloqueada passa", rebCarolBk.status === 200, JSON.stringify(rebCarolBk.json));
  const remBobBk = await req(base, "DELETE", `/guildas/${guildBk}/membros/${idDe("bob")}`, { cookie: cookieBob });
  t("remover o último GM capaz continua recusado", remBobBk.status === 409);
  await req(base, "PATCH", `/admin/users/${idDe("alice")}`, { cookie: cookieRoot, body: { status: "ativo" } });
  await req(base, "PATCH", `/admin/users/${idDe("carol")}`, { cookie: cookieRoot, body: { status: "ativo" } });
  // desbloqueio revoga as sessões — é preciso recertificar cookies
  const cookieAlice2 = sessaoDb(idDe("alice"));
  const cookieCarol2 = sessaoDb(idDe("carol"));

  sec("Campanhas candidatas — ADMIN vê todas, GM só as operáveis");
  const candRoot = await req(base, "GET", `/guildas/${guildB}/campanhas-candidatas`, { cookie: cookieRoot });
  t("ADMIN lista candidatas de qualquer usuário", candRoot.status === 200 && (candRoot.json?.campanhas ?? []).some((c) => c.id === campId), JSON.stringify(candRoot.json).slice(0, 200));
  // controle positivo: o vínculo via PUT já consultou memberships —
  // se o contador estivesse quebrado, o delta abaixo passaria à toa
  t("instrumentação SQL registrou consultas a memberships", sqlMemberships > 0, `total=${sqlMemberships}`);
  const antesN1 = sqlMemberships;
  const candCarol = await req(base, "GET", `/guildas/${guildB}/campanhas-candidatas`, { cookie: cookieCarol2 });
  t("listagem de candidatas do GM não faz N+1 em memberships", sqlMemberships - antesN1 === 0, `consultas diretas em memberships: ${sqlMemberships - antesN1}`);
  const idsCarol = (candCarol.json?.campanhas ?? []).map((c) => c.id);
  t("GM vê a própria e não vê campanha alheia", candCarol.status === 200 && idsCarol.includes(campCarol.json.campanha.id) && !idsCarol.includes(campId), JSON.stringify({ st: candCarol.status, ids: idsCarol, resp: candCarol.json }).slice(0, 300));
  const candAlice = await req(base, "GET", `/guildas/${guildB}/campanhas-candidatas`, { cookie: cookieAlice2 });
  t("não-gestor não lista candidatas", candAlice.status === 403, `status=${candAlice.status} body=${JSON.stringify(candAlice.json)}`);

  sec("Membro comum le a guilda sem permissoes de gestao");
  // carol e GM da Guilda B, mas na Guilda A entra como MEMBRO comum
  const addCarolA = await req(base, "POST", `/guildas/${guildA}/membros`, { cookie: cookieAlice2, body: { username: "carol" } });
  t("alice adiciona carol como membro comum da Guilda A", addCarolA.status === 201, JSON.stringify(addCarolA.json));
  const detCarol = await req(base, "GET", `/guildas/${guildA}`, { cookie: cookieCarol2 });
  t("membro comum abre detalhe da guilda", detCarol.status === 200 && detCarol.json?.guilda?.meuPapel === "membro" && detCarol.json?.guilda?.souGM === false, JSON.stringify(detCarol.json).slice(0, 200));
  const memCarol = await req(base, "GET", `/guildas/${guildA}/membros`, { cookie: cookieCarol2 });
  t("membro comum le roster", memCarol.status === 200 && (memCarol.json?.membros ?? []).length === 3, JSON.stringify(memCarol.json).slice(0, 200));
  const campVincCarol = await req(base, "GET", `/guildas/${guildA}/campanhas`, { cookie: cookieCarol2 });
  t("membro comum le campanhas vinculadas", campVincCarol.status === 200, JSON.stringify(campVincCarol.json).slice(0, 200));
  const candCarolComum = await req(base, "GET", `/guildas/${guildA}/campanhas-candidatas`, { cookie: cookieCarol2 });
  t("membro comum NAO lista candidatas (403)", candCarolComum.status === 403, String(candCarolComum.status));

  sec("Auditoria");
  const db2 = abrirDb(BANCO);
  const audits = db2.prepare("select action from audit_logs").all().map((r) => r.action);
  t("audit registra admin.conceder", audits.includes("admin.conceder"));
  t("audit registra admin.revogar", audits.includes("admin.revogar"));
  t("audit registra guilda.criar", audits.includes("guilda.criar"));
  const auditGuild = db2.prepare("select guild_id from audit_logs where action='guilda.criar' limit 1").get();
  t("audit de criação grava guild_id", !!auditGuild?.guild_id, JSON.stringify(auditGuild));
  t("audit registra guilda.campanha.vincular", audits.includes("guilda.campanha.vincular"));
  db2.close();
} finally {
  proc.kill();
  limparDir(DIR);
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
