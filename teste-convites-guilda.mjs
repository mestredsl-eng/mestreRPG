// Testes — convites internos de guilda (Issue #65, backend).
// Cobre o contrato /api/guildas/:id/convites-internos e
// /api/convites-guilda/:codigo: permissões GM/ADMIN, hash SHA-256,
// expiração/revogação/limite de usos, consumo atômico em concorrência,
// papel exclusivo `membro`, payload forjado e auditoria.
// Banco temporário + migrations reais (sem fixture local).
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import { hashToken } from "./servidor/dist/lib/password.js";
import { dirTeste, prepararBanco, limparDir, abrirDb } from "./teste-base.mjs";

const DIR = dirTeste("convites-guilda");
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
const membroDb = (guildId, userId) => {
  const db = abrirDb(BANCO);
  const m = db.prepare("select role,status from guild_members where guild_id=? and user_id=?").get(guildId, userId);
  db.close();
  return m;
};
const conviteDb = (id) => {
  const db = abrirDb(BANCO);
  const c = db.prepare("select * from guild_invites where id=?").get(id);
  db.close();
  return c;
};
const auditDb = (action) => {
  const db = abrirDb(BANCO);
  const rows = db.prepare("select action, detail, guild_id from audit_logs where action=?").all(action);
  db.close();
  return rows;
};

const porta = await portaLivre();
const base = `http://127.0.0.1:${porta}`;
const proc = subir(porta);
proc.stderr.on("data", () => { });
await esperarSaudavel(base, proc);

try {
  sec("Setup — contas, guildas e migration 0025");
  const setup = await req(base, "POST", "/auth/setup", { body: { username: "root", password: "senha-forte-123" } });
  t("setup cria admin", setup.status === 201, JSON.stringify(setup.json));
  const cookieRoot = sessaoDb(idDe("root"));

  for (const u of ["alice", "bob", "carol", "dave", "erin", "fred", "gina", "hank", "ivan"]) {
    const c = await req(base, "POST", "/admin/users", { cookie: cookieRoot, body: { username: u, password: "senha-forte-123" } });
    t(`cria ${u}`, c.status === 201, JSON.stringify(c.json));
  }
  const cookieAlice = sessaoDb(idDe("alice"));
  const cookieBob = sessaoDb(idDe("bob"));
  const cookieCarol = sessaoDb(idDe("carol"));
  const cookieDave = sessaoDb(idDe("dave"));
  const cookieErin = sessaoDb(idDe("erin"));
  const cookieFred = sessaoDb(idDe("fred"));
  const cookieGina = sessaoDb(idDe("gina"));
  const cookieHank = sessaoDb(idDe("hank"));
  const cookieIvan = sessaoDb(idDe("ivan"));

  const gA = await req(base, "POST", "/guildas", { cookie: cookieAlice, body: { name: "Guilda Alfa" } });
  const guildA = gA.json?.guilda?.id;
  const gB = await req(base, "POST", "/guildas", { cookie: cookieCarol, body: { name: "Guilda Beta" } });
  const guildB = gB.json?.guilda?.id;
  t("duas guildas criadas", !!guildA && !!guildB);
  // bob = membro comum de A; erin e fred sem vínculo
  await req(base, "POST", `/guildas/${guildA}/membros`, { cookie: cookieAlice, body: { username: "bob" } });

  {
    const db = abrirDb(BANCO);
    const tabela = db.prepare("select name from sqlite_master where type='table' and name='guild_invites'").get();
    db.close();
    t("migration 0025 criou guild_invites", !!tabela);
  }

  sec("Gerenciamento — permissões");
  t("membro comum não lista convites", (await req(base, "GET", `/guildas/${guildA}/convites-internos`, { cookie: cookieBob })).status === 403);
  t("membro comum não cria convite", (await req(base, "POST", `/guildas/${guildA}/convites-internos`, { cookie: cookieBob, body: {} })).status === 403);
  t("GM de outra guilda não acessa", (await req(base, "GET", `/guildas/${guildA}/convites-internos`, { cookie: cookieCarol })).status === 403);
  t("não-membro não acessa", (await req(base, "GET", `/guildas/${guildA}/convites-internos`, { cookie: cookieDave })).status === 403);
  t("ADMIN lista convites da guilda", (await req(base, "GET", `/guildas/${guildA}/convites-internos`, { cookie: cookieRoot })).status === 200);
  t("validação rejeita limites fora do contrato",
    (await req(base, "POST", `/guildas/${guildA}/convites-internos`, { cookie: cookieAlice, body: { validadeHoras: 0 } })).status === 400
    && (await req(base, "POST", `/guildas/${guildA}/convites-internos`, { cookie: cookieAlice, body: { maxUsos: 51 } })).status === 400);

  sec("Criação — contrato, hash e auditoria");
  const criacao = await req(base, "POST", `/guildas/${guildA}/convites-internos`, { cookie: cookieAlice, body: {} });
  t("GM cria convite", criacao.status === 201, JSON.stringify(criacao.json));
  const inv1 = criacao.json?.convite;
  t("resposta traz codigo somente na criação", typeof inv1?.codigo === "string" && inv1.codigo.length >= 12);
  t("defaults 168h/1 uso refletidos", inv1?.maxUsos === 1 && inv1?.status === "ativo");
  const gravado = conviteDb(inv1.id);
  t("banco guarda apenas hash SHA-256", !!gravado && /^[0-9a-f]{64}$/.test(gravado.code) && gravado.code !== inv1.codigo);
  const criacao2 = await req(base, "POST", `/guildas/${guildA}/convites-internos`, { cookie: cookieAlice, body: { validadeHoras: 24, maxUsos: 3 } });
  const inv2 = criacao2.json?.convite;
  t("criação com parâmetros customizados", criacao2.status === 201 && inv2?.maxUsos === 3);

  const lista = await req(base, "GET", `/guildas/${guildA}/convites-internos`, { cookie: cookieAlice });
  t("listagem não expõe codigo", lista.status === 200 && lista.json?.convites?.length === 2
    && lista.json.convites.every((c) => !("codigo" in c)));
  t("auditoria registrou criação", auditDb("guilda.convite.criar").length === 2);

  sec("Consulta pública do convite");
  const consulta = await req(base, "GET", `/convites-guilda/${inv1.codigo}`, { cookie: cookieDave });
  t("consulta retorna guilda mínima", consulta.status === 200
    && consulta.json?.convite?.guilda?.id === guildA && consulta.json?.convite?.guilda?.nome === "Guilda Alfa"
    && consulta.json?.convite?.status === "ativo" && consulta.json?.convite?.usosRestantes === 1,
    JSON.stringify(consulta.json));
  t("consulta não vaza roster/membros", !JSON.stringify(consulta.json).includes("membros") && !JSON.stringify(consulta.json).includes("bob"));
  t("código inexistente → 404", (await req(base, "GET", "/convites-guilda/codigo-inexistente", { cookie: cookieDave })).status === 404);
  t("sem autenticação → 401", (await req(base, "GET", `/convites-guilda/${inv1.codigo}`)).status === 401);

  sec("Aceitação — papel membro e idempotência");
  const aceite = await req(base, "POST", `/convites-guilda/${inv1.codigo}/aceitar`, { cookie: cookieDave, body: { role: "gm", isAdmin: true } });
  t("aceite concede membro", aceite.status === 200 && aceite.json?.ok === true && aceite.json?.papel === "membro" && aceite.json?.guildaId === guildA, JSON.stringify(aceite.json));
  const memDave = membroDb(guildA, idDe("dave"));
  t("guild_members persistiu papel membro", memDave?.role === "membro" && memDave?.status === "ativo");
  const userDave = (() => { const db = abrirDb(BANCO); const u = db.prepare("select is_admin from users where id=?").get(idDe("dave")); db.close(); return u; })();
  t("payload forjado não elevou privilégio", userDave?.is_admin === 0);
  t("uso consumido uma vez", conviteDb(inv1.id).uses === 1);
  t("auditoria registrou aceitação", auditDb("guilda.convite.aceitar").length === 1);

  const reaceite = await req(base, "POST", `/convites-guilda/${inv1.codigo}/aceitar`, { cookie: cookieDave });
  t("membro ativo não consome outro uso", reaceite.status === 200 && conviteDb(inv1.id).uses === 1);

  sec("Limite de usos e concorrência");
  // inv2: maxUsos=3 — erin e fred consomem; sobra 1
  const aErin = await req(base, "POST", `/convites-guilda/${inv2.codigo}/aceitar`, { cookie: cookieErin });
  const aFred = await req(base, "POST", `/convites-guilda/${inv2.codigo}/aceitar`, { cookie: cookieFred });
  t("dois aceites dentro do limite", aErin.status === 200 && aFred.status === 200 && conviteDb(inv2.id).uses === 2);
  // dave já é membro — não consome; bob é membro — também não consome.
  // cria terceiro usuário para estourar o limite? maxUsos=3, uses=2 → carol (GM de B, sem vínculo com A) aceita
  const aCarol = await req(base, "POST", `/convites-guilda/${inv2.codigo}/aceitar`, { cookie: cookieCarol });
  t("terceiro aceite consome última vaga", aCarol.status === 200 && conviteDb(inv2.id).uses === 3);
  const aIvan = await req(base, "POST", `/convites-guilda/${inv2.codigo}/aceitar`, { cookie: cookieIvan });
  t("convite esgotado recusa novo aceite", aIvan.status === 410, String(aIvan.status));

  // corrida real: convite uso único, dois NÃO-membros simultâneos
  // (gina e hank nunca tiveram vínculo com a Guilda Alfa)
  const criacao3 = await req(base, "POST", `/guildas/${guildA}/convites-internos`, { cookie: cookieAlice, body: { maxUsos: 1 } });
  const inv3 = criacao3.json?.convite;
  const [r1, r2] = await Promise.all([
    req(base, "POST", `/convites-guilda/${inv3.codigo}/aceitar`, { cookie: cookieGina }),
    req(base, "POST", `/convites-guilda/${inv3.codigo}/aceitar`, { cookie: cookieHank }),
  ]);
  const oks = [r1, r2].filter((r) => r.status === 200).length;
  const recusas = [r1, r2].filter((r) => r.status === 410).length;
  t("corrida uso único: exatamente um aceite", oks === 1 && recusas === 1, `statuses=${r1.status},${r2.status} bodies=${JSON.stringify(r1.json)}|${JSON.stringify(r2.json)}`);
  t("corrida uso único: uses=1 persistido", conviteDb(inv3.id).uses === 1);
  const membrosCorrida = [idDe("gina"), idDe("hank")].filter((u) => membroDb(guildA, u)?.status === "ativo").length;
  t("corrida uso único: só um virou membro", membrosCorrida === 1);

  sec("Expiração e revogação");
  // convite expirado: insere direto no banco (API não permite <1h)
  const db = abrirDb(BANCO);
  const idExp = crypto.randomUUID();
  const codigoExp = "CODIGO-EXPIRADO-TESTE";
  const { createHash } = await import("node:crypto");
  db.prepare("insert into guild_invites (id,guild_id,code,created_by,expires_at,max_uses,uses,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
    .run(idExp, guildA, createHash("sha256").update(codigoExp.trim().toUpperCase()).digest("hex"), idDe("alice"), Date.now() - 1000, 1, 0, Date.now(), Date.now());
  db.close();
  const consultaExp = await req(base, "GET", `/convites-guilda/${codigoExp}`, { cookie: cookieDave });
  t("consulta mostra status expirado", consultaExp.json?.convite?.status === "expirado", JSON.stringify(consultaExp.json));
  t("aceite de expirado → 410", (await req(base, "POST", `/convites-guilda/${codigoExp}/aceitar`, { cookie: cookieIvan })).status === 410);

  const del = await req(base, "DELETE", `/guildas/${guildA}/convites-internos/${inv2.id}`, { cookie: cookieAlice });
  t("GM revoga convite", del.status === 200);
  t("revogação auditada", auditDb("guilda.convite.revogar").length === 1);
  t("convite revogado não pode ser usado", (await req(base, "POST", `/convites-guilda/${inv2.codigo}/aceitar`, { cookie: cookieIvan })).status === 410);
  t("membro comum não revoga", (await req(base, "DELETE", `/guildas/${guildA}/convites-internos/${inv3.id}`, { cookie: cookieBob })).status === 403);
  t("convite de outra guilda não é revogável por ID trocado",
    (await req(base, "DELETE", `/guildas/${guildB}/convites-internos/${inv3.id}`, { cookie: cookieCarol })).status === 404);

  sec("Reativação como membro (nunca eleva papel)");
  // bob é membro; GM o remove; bob aceita novo convite → volta como membro
  const bobId = idDe("bob");
  await req(base, "DELETE", `/guildas/${guildA}/membros/${bobId}`, { cookie: cookieAlice });
  const memBobRemovido = membroDb(guildA, bobId);
  t("remoção marcou status removido", memBobRemovido?.status === "removido");
  const criacao4 = await req(base, "POST", `/guildas/${guildA}/convites-internos`, { cookie: cookieAlice, body: { maxUsos: 5 } });
  const inv4 = criacao4.json?.convite;
  const aceiteBob = await req(base, "POST", `/convites-guilda/${inv4.codigo}/aceitar`, { cookie: cookieBob, body: { role: "gm" } });
  const memBobVolta = membroDb(guildA, bobId);
  t("reativação por convite volta como membro", aceiteBob.status === 200 && memBobVolta?.role === "membro" && memBobVolta?.status === "ativo", JSON.stringify(aceiteBob.json));

  sec("Regressão — permissões atuais intactas");
  const guildasBob = await req(base, "GET", "/guildas", { cookie: cookieBob });
  t("bob vê Guilda Alfa na listagem", guildasBob.json?.guildas?.some((g) => g.id === guildA));
  t("lista de convites da guilda B vazia para GM Beta", (await req(base, "GET", `/guildas/${guildB}/convites-internos`, { cookie: cookieCarol })).json?.convites?.length === 0);

  t("sem erros fatais", proc.exitCode === null);
} finally {
  proc.kill();
  await new Promise((r) => setTimeout(r, 500));
  limparDir(DIR);
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
