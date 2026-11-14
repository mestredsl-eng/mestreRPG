// Testes — transferência de responsável de guilda (Issue #65, backend).
// PUT /api/guildas/:guildId/responsavel: autorização (responsável atual
// ou ADMIN — GM comum NÃO transfere), alvo obrigatoriamente GM ativo da
// mesma guilda com conta ativa, created_by imutável, papel de ninguém
// muda, auditoria e guilda:atualizada em tempo real.
// Banco temporário + migrations reais; backfill da 0026 testado em
// banco scratch com a SQL real da migration.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { io as ioCliente } from "socket.io-client";
import { hashToken } from "./servidor/dist/lib/password.js";
import { dirTeste, prepararBanco, abrirDb } from "./teste-base.mjs";

const DIR = dirTeste("responsavel-guilda");
const BANCO = join(DIR, "mestre-rpg-teste.db");
await prepararBanco(BANCO);

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

// ---------- backfill da migration 0026 (SQL real, banco scratch) ----------
sec("Backfill 0026 — SQL real da migration");
{
  const scratch = new Database(":memory:");
  scratch.exec(`
    create table users (id text primary key, status text not null);
    create table guilds (id text primary key, created_by text not null);
    create table guild_members (guild_id text not null, user_id text not null,
      role text not null, status text not null, joined_at integer, created_at integer);
    insert into users values ('u1','ativo'),('u2','ativo'),('u3','ativo'),('u4','bloqueado'),('u5','ativo');
    -- g1: criador ainda é GM ativo → responsável = criador
    insert into guilds values ('g1','u1');
    insert into guild_members values ('g1','u1','gm','ativo',1,1),('g1','u2','gm','ativo',2,2);
    -- g2: criador rebaixado a membro; u3 é o GM mais antigo → responsável = u3
    insert into guilds values ('g2','u2');
    insert into guild_members values ('g2','u2','membro','ativo',1,1),('g2','u3','gm','ativo',2,2),('g2','u5','gm','ativo',3,3);
    -- g3: nenhum GM ativo → NULL
    insert into guilds values ('g3','u1');
    insert into guild_members values ('g3','u1','membro','ativo',1,1),('g3','u2','membro','removido',2,2);
    -- g4: criador é GM mas conta bloqueada; u5 GM ativo → u5
    insert into guilds values ('g4','u4');
    insert into guild_members values ('g4','u4','gm','ativo',1,1),('g4','u5','gm','ativo',2,2);
  `);
  const sql = readFileSync(join("servidor", "migrations", "0026_guilda_responsavel.sql"), "utf8");
  scratch.exec("alter table guilds add responsible_user_id text references users(id)");
  scratch.exec(sql.split("--> statement-breakpoint").pop()); // só o UPDATE de backfill
  const resp = (g) => scratch.prepare("select responsible_user_id r from guilds where id=?").get(g).r;
  t("backfill: criador GM ativo vira responsável", resp("g1") === "u1");
  t("backfill: criador rebaixado → GM ativo mais antigo", resp("g2") === "u3");
  t("backfill: sem GM ativo → NULL", resp("g3") === null);
  t("backfill: criador com conta bloqueada → outro GM ativo", resp("g4") === "u5");
  scratch.close();
}

// ---------- harness HTTP/socket ----------
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
const guildaDb = (id) => {
  const db = abrirDb(BANCO);
  const g = db.prepare("select id,name,created_by,responsible_user_id from guilds where id=?").get(id);
  db.close();
  return g;
};
const membroDb = (guildId, userId) => {
  const db = abrirDb(BANCO);
  const m = db.prepare("select role,status from guild_members where guild_id=? and user_id=?").get(guildId, userId);
  db.close();
  return m;
};
const auditsDb = (action) => {
  const db = abrirDb(BANCO);
  const rows = db.prepare("select detail, guild_id from audit_logs where action=? order by rowid").all(action);
  db.close();
  return rows.map((r) => ({ ...r, detail: JSON.parse(r.detail ?? "{}") }));
};
const sqlDb = (sqlText, ...params) => {
  const db = abrirDb(BANCO);
  const out = params.length ? db.prepare(sqlText).run(...params) : db.exec(sqlText);
  db.close();
  return out;
};

const porta = await portaLivre();
const base = `http://127.0.0.1:${porta}`;
const proc = subir(porta);
proc.stderr.on("data", () => { });
await esperarSaudavel(base, proc);

const socketsAbertos = [];
function conectarSocket(cookie) {
  const s = ioCliente(base, { transports: ["websocket"], extraHeaders: { cookie }, reconnection: false });
  socketsAbertos.push(s);
  return s;
}
try {
  sec("Setup — contas e guildas");
  const setup = await req(base, "POST", "/auth/setup", { body: { username: "root", password: "senha-forte-123" } });
  t("setup cria admin", setup.status === 201);
  const cookieRoot = sessaoDb(idDe("root"));
  for (const u of ["alice", "bob", "carol", "dave", "erin", "fred"]) {
    await req(base, "POST", "/admin/users", { cookie: cookieRoot, body: { username: u, password: "senha-forte-123" } });
  }
  const cookieAlice = sessaoDb(idDe("alice"));
  const cookieBob = sessaoDb(idDe("bob"));
  const cookieCarol = sessaoDb(idDe("carol"));
  const cookieDave = sessaoDb(idDe("dave"));
  const cookieErin = sessaoDb(idDe("erin"));
  const cookieFred = sessaoDb(idDe("fred"));
  const idAlice = idDe("alice"), idBob = idDe("bob"), idCarol = idDe("carol");
  const idDave = idDe("dave"), idErin = idDe("erin"), idFred = idDe("fred"), idRoot = idDe("root");

  const gA = await req(base, "POST", "/guildas", { cookie: cookieAlice, body: { name: "Guilda Alfa" } });
  const guildA = gA.json?.guilda?.id;
  const gB = await req(base, "POST", "/guildas", { cookie: cookieCarol, body: { name: "Guilda Beta" } });
  const guildB = gB.json?.guilda?.id;
  t("duas guildas criadas", !!guildA && !!guildB);

  // dave e erin viram GMs da guilda A; bob fica membro comum
  for (const [u, ck] of [["dave", cookieDave], ["erin", cookieErin], ["bob", cookieBob]]) {
    await req(base, "POST", `/guildas/${guildA}/membros`, { cookie: cookieAlice, body: { username: u } });
  }
  for (const u of ["dave", "erin"]) {
    await req(base, "PATCH", `/guildas/${guildA}/membros/${idDe(u)}`, { cookie: cookieAlice, body: { role: "gm" } });
  }
  t("dave e erin promovidos a GM", membroDb(guildA, idDave)?.role === "gm" && membroDb(guildA, idErin)?.role === "gm");

  sec("Criação e estado inicial do responsável");
  const det = await req(base, "GET", `/guildas/${guildA}`, { cookie: cookieBob });
  t("criador vira responsável inicial", det.json?.guilda?.responsavelId === idAlice, JSON.stringify(det.json?.guilda));
  t("created_by permanece o criador", guildaDb(guildA).created_by === idAlice);
  t("meuPapel/souGM intactos", det.json?.guilda?.meuPapel === "membro");

  sec("Autorização — quem NÃO pode transferir");
  const put = (ck, gid, uid) => req(base, "PUT", `/guildas/${gid}/responsavel`, { cookie: ck, body: { userId: uid } });
  t("membro comum → 403", (await put(cookieBob, guildA, idDave)).status === 403);
  t("GM de outra guilda → 403", (await put(cookieCarol, guildA, idDave)).status === 403);
  t("sem autenticação → 401", (await req(base, "PUT", `/guildas/${guildA}/responsavel`, { body: { userId: idDave } })).status === 401);
  t("payload inválido → 400", (await put(cookieAlice, guildA, "")).status === 400);

  sec("Validação do alvo");
  t("alvo membro comum → 409", (await put(cookieAlice, guildA, idBob)).status === 409);
  t("alvo GM de outra guilda → 409", (await put(cookieAlice, guildA, idCarol)).status === 409);
  t("alvo ADMIN global sem GM na guilda → 409", (await put(cookieAlice, guildA, idRoot)).status === 409);
  t("guilda inexistente → 404", (await put(cookieAlice, "00000000-0000-0000-0000-000000000000", idDave)).status === 404);

  sec("Transferência válida + tempo real");
  const sockBob = conectarSocket(cookieBob);
  const eventosBob = [];
  sockBob.on("guilda:atualizada", (d) => eventosBob.push(d));
  await new Promise((r) => setTimeout(r, 300));

  const tr = await put(cookieAlice, guildA, idDave);
  t("responsável transfere para GM ativo", tr.status === 200 && tr.json?.ok === true, JSON.stringify(tr.json));
  t("resposta traz anterior e novo", tr.json?.responsavelAnteriorId === idAlice && tr.json?.responsavelId === idDave);
  t("banco: responsible_user_id atualizado", guildaDb(guildA).responsible_user_id === idDave);
  t("created_by IMUTÁVEL", guildaDb(guildA).created_by === idAlice);
  t("responsável anterior PERMANECECE GM", membroDb(guildA, idAlice)?.role === "gm" && membroDb(guildA, idAlice)?.status === "ativo");
  t("novo responsável já era GM (não foi promovido)", membroDb(guildA, idDave)?.role === "gm");
  t("bob (membro) NÃO virou nada", membroDb(guildA, idBob)?.role === "membro");

  await new Promise((r) => setTimeout(r, 500));
  t("guilda:atualizada emitida (responsavel_alterado)",
    eventosBob.some((e) => e.guildId === guildA && e.tipo === "responsavel_alterado"), JSON.stringify(eventosBob));

  sec("Auditoria");
  const aud = auditsDb("guilda.responsavel.transferir");
  t("auditoria registrou transferência", aud.length === 1, JSON.stringify(aud));
  t("auditoria tem anterior/novo/ator",
    aud[0]?.detail?.anterior === idAlice && aud[0]?.detail?.novo === idDave && aud[0]?.detail?.ator === idAlice);
  t("guild_id preenchido na auditoria", aud[0]?.guild_id === guildA);

  sec("Pós-transferência: permissões mudam");
  t("ex-responsável (GM comum) → 403", (await put(cookieAlice, guildA, idErin)).status === 403);
  t("novo responsável → 200", (await put(cookieDave, guildA, idErin)).status === 200);
  t("responsável agora é erin", guildaDb(guildA).responsible_user_id === idErin);
  t("alice continua GM após tudo", membroDb(guildA, idAlice)?.role === "gm");

  sec("Idempotência");
  const antes = auditsDb("guilda.responsavel.transferir").length;
  const idem = await put(cookieErin, guildA, idErin);
  t("mesmo responsável → 200 idempotente", idem.status === 200 && idem.json?.responsavelId === idErin);
  t("sem auditoria extra", auditsDb("guilda.responsavel.transferir").length === antes);

  sec("Concorrência — duas transferências simultâneas");
  // estado: responsável=erin; alvos válidos dave e alice (ambos GM).
  // Semântica estrita: a autorização é revalidada na execução — se a
  // primeira transferência commitar antes da segunda ler o estado, o
  // ator já não é mais o responsável e recebe 403 (correto: impede que
  // um ex-responsável dispare transferências em rajada). O que não pode
  // acontecer é estado corrompido ou auditoria sem persistência.
  const [r1, r2] = await Promise.all([
    put(cookieErin, guildA, idDave),
    put(cookieErin, guildA, idAlice),
  ]);
  const oks = [r1, r2].filter((r) => r.status === 200).length;
  t("pelo menos uma transferência aplicada", oks >= 1, `${r1.status}|${r2.status}`);
  t("perdedor recebe 403 ou também 200 — nunca 5xx", [r1.status, r2.status].every((s) => s === 200 || s === 403));
  const final = guildaDb(guildA).responsible_user_id;
  t("estado final consistente (sem corrupção)", final === idDave || final === idAlice || final === idErin, final);
  t("auditoria = exatamente os sucessos", auditsDb("guilda.responsavel.transferir").length === antes + oks,
    `audits=${auditsDb("guilda.responsavel.transferir").length} oks=${oks}`);

  sec("ADMIN — recuperação autorizada");
  const adm = await put(cookieRoot, guildA, idAlice);
  t("ADMIN transfere mesmo sem ser GM", adm.status === 200 && adm.json?.responsavelId === idAlice, JSON.stringify(adm.json));
  t("responsável volta a ser alice", guildaDb(guildA).responsible_user_id === idAlice);

  sec("Guilda sem responsável/GM — recuperação ADMIN");
  // guilda C criada por fred; simula inconsistência: fred rebaixado a
  // membro e responsible_user_id NULL direto no banco (a API bloquearia)
  const gC = await req(base, "POST", "/guildas", { cookie: cookieFred, body: { name: "Guilda Gama" } });
  const guildC = gC.json?.guilda?.id;
  sqlDb("update guild_members set role='membro' where guild_id=? and user_id=?", guildC, idFred);
  sqlDb("update guilds set responsible_user_id=null where id=?", guildC);
  sqlDb("insert into guild_members (id,guild_id,user_id,role,status,joined_at,created_at,updated_at) values (?,?,?,?,?,?,?,?)",
    crypto.randomUUID(), guildC, idErin, "gm", "ativo", Date.now(), Date.now(), Date.now());
  t("guilda sem responsável fica NULL", guildaDb(guildC).responsible_user_id === null);
  t("ex-responsável sem privilégio → 403", (await put(cookieFred, guildC, idErin)).status === 403);
  t("GM comum não transfere em guilda sem responsável → 403",
    (await req(base, "PUT", `/guildas/${guildC}/responsavel`, { cookie: sessaoDb(idErin), body: { userId: idErin } })).status === 403);
  const rec = await put(cookieRoot, guildC, idErin);
  t("ADMIN recupera: define responsável", rec.status === 200 && rec.json?.responsavelId === idErin, JSON.stringify(rec.json));
  t("responsável recuperado = erin", guildaDb(guildC).responsible_user_id === idErin);

  sec("Regressão — leitura e listagem intactas");
  const lista = await req(base, "GET", "/guildas", { cookie: cookieBob });
  t("bob lista guildas", lista.status === 200 && lista.json?.guildas?.length >= 1);
  const detA = await req(base, "GET", `/guildas/${guildA}`, { cookie: cookieAlice });
  t("detalhe expõe responsavelId", detA.json?.guilda?.responsavelId === idAlice);

  console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
} finally {
  for (const s of socketsAbertos) s.close();
  proc.kill();
}
process.exit(fail ? 1 : 0);
