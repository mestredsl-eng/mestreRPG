// Testes — Issue #65: corrida do CAS de responsável de guilda.
// Prova que guilds.responsible_user_id nunca aponta para não-GM/inativo,
// mesmo com operações concorrentes:
//   A) PUT /responsavel do responsável atual para DOIS GMs ao mesmo tempo
//      → exatamente um 200, o outro 409 (CAS responsible_user_id IS <lido>);
//   B) PUT transferência × PATCH rebaixamento do GM alvo → uma vence;
//   C) PUT transferência × DELETE remoção do GM alvo → uma vence.
// Mecanismo real: gravarResponsavelGuilda (CAS + EXISTS do alvo GM ativo)
// e gravarPapelStatusMembro (revalida user_id IS NOT responsible no UPDATE).
// Banco temporário + migrations reais + servidor spawnado (teardown seguro).
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  encerrarServidor, limparDir, req, sessao, abrirDb, comDb,
} from "./teste-base.mjs";

const DIR = dirTeste("guilda-responsavel-cas");
const BANCO = `${DIR}/mestre-rpg-teste.db`;
await prepararBanco(BANCO);

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");
const LOG_LIMITE = 200;
const logsServidor = { out: [], err: [] };
function consumirStream(stream, destino) {
  if (!stream) return;
  let resto = "";
  stream.on("data", (chunk) => {
    resto += String(chunk);
    const linhas = resto.split("\n");
    resto = linhas.pop() ?? "";
    for (const l of linhas) {
      if (l.trim()) { destino.push(l); if (destino.length > LOG_LIMITE) destino.shift(); }
    }
  });
}
function despejarLogs() {
  const cauda = (arr) => arr.slice(-15).join("\n");
  if (logsServidor.err.length) console.log("--- stderr do servidor (cauda) ---\n" + cauda(logsServidor.err));
  if (logsServidor.out.length) console.log("--- stdout do servidor (cauda) ---\n" + cauda(logsServidor.out));
}

const idDe = (username) => comDb(BANCO, (db) => db.prepare("select id from users where username=?").get(username)?.id);
const guildaDb = (id) => comDb(BANCO, (db) =>
  db.prepare("select id,name,created_by,responsible_user_id from guilds where id=?").get(id));
const membroDb = (guildId, userId) => comDb(BANCO, (db) =>
  db.prepare("select role,status from guild_members where guild_id=? and user_id=?").get(guildId, userId));
const auditsDb = (action) => comDb(BANCO, (db) =>
  db.prepare("select count(*) c from audit_logs where action=?").get(action).c);
// responsável precisa apontar para GM ativo com conta ativa — a invariante central
const responsavelValido = (guildId) => comDb(BANCO, (db) => {
  const g = db.prepare("select responsible_user_id r, created_by c from guilds where id=?").get(guildId);
  if (!g || !g.r) return { ok: false, motivo: "responsible_user_id nulo", g };
  const m = db.prepare(`select gm.role, gm.status, u.status us
    from guild_members gm join users u on u.id = gm.user_id
    where gm.guild_id=? and gm.user_id=?`).get(guildId, g.r);
  const ok = m && m.role === "gm" && m.status === "ativo" && m.us === "ativo";
  return { ok, motivo: ok ? "gm ativo" : `responsável inválido: ${JSON.stringify(m)}`, g };
});

const porta = await portaLivre();
const base = `http://127.0.0.1:${porta}`;
const proc = subirServidor(porta, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
consumirStream(proc.stdout, logsServidor.out);
consumirStream(proc.stderr, logsServidor.err);

try {
  await esperarSaudavel(base, proc);
  sec("Setup — admin, contas e helper de guilda com 3 GMs");
  const setup = await req(base, "POST", "/auth/setup", { body: { username: "root", password: "senha-forte-123" } });
  t("setup cria admin", setup.status === 201);
  const cookieRoot = sessao(BANCO, idDe("root"));
  for (const u of ["resp", "alvo_bob", "alvo_carol", "alvo_dave"]) {
    const r = await req(base, "POST", "/admin/users", { cookie: cookieRoot, body: { username: u, password: "senha-forte-123" } });
    if (r.status !== 201 && r.status !== 200) throw new Error(`criar ${u} falhou: ${r.status}`);
  }
  const U = {};
  for (const u of ["resp", "alvo_bob", "alvo_carol", "alvo_dave", "root"]) {
    U[u] = { id: idDe(u), cookie: sessao(BANCO, idDe(u)) };
  }

  // cria guilda cujo criador vira responsável+GM; adiciona 2 alvos e promove a GM
  async function guildaComGMs(nome, alvos) {
    const g = await req(base, "POST", "/guildas", { cookie: U.resp.cookie, body: { name: nome } });
    const gid = g.json?.guilda?.id;
    if (!gid) throw new Error("guilda não criada: " + JSON.stringify(g.json));
    for (const a of alvos) {
      await req(base, "POST", `/guildas/${gid}/membros`, { cookie: U.resp.cookie, body: { username: a } });
      await req(base, "PATCH", `/guildas/${gid}/membros/${U[a].id}`, { cookie: U.resp.cookie, body: { role: "gm" } });
    }
    return gid;
  }
  const putResp = (ck, gid, uid) => req(base, "PUT", `/guildas/${gid}/responsavel`, { cookie: ck, body: { userId: uid } });
  const patchM = (ck, gid, uid, body) => req(base, "PATCH", `/guildas/${gid}/membros/${uid}`, { cookie: ck, body });
  const delM = (ck, gid, uid) => req(base, "DELETE", `/guildas/${gid}/membros/${uid}`, { cookie: ck });

  sec("A — CAS: responsável dispara PUT para dois GMs simultaneamente");
  const gA = await guildaComGMs("Guilda CAS Alfa", ["alvo_bob", "alvo_carol"]);
  t("guilda A com responsável=criador", guildaDb(gA).responsible_user_id === U.resp.id);
  const auditsAntesA = auditsDb("guilda.responsavel.transferir");
  const [a1, a2] = await Promise.all([
    putResp(U.resp.cookie, gA, U.alvo_bob.id),
    putResp(U.resp.cookie, gA, U.alvo_carol.id),
  ]);
  const oksA = [a1, a2].filter((r) => r.status === 200).length;
  console.log(`  resultados: →bob=${a1.status} →carol=${a2.status} | 200s=${oksA}`);
  t("EXATAMENTE uma transferência aceita", oksA === 1, `${a1.status}|${a2.status}`);
  // perdedora: 403 se releu responsible_user_id já transferido na
  // autorização, ou 409 se passou na auth e perdeu o CAS — ambos corretos
  t("perdedora recebe 403 ou 409", [a1.status, a2.status].every((s) => s === 200 || s === 403 || s === 409), `${a1.status}|${a2.status}`);
  {
    const fin = guildaDb(gA);
    const vencedor = a1.status === 200 ? U.alvo_bob.id : U.alvo_carol.id;
    t("responsible_user_id = alvo vencedor", fin.responsible_user_id === vencedor, `final=${fin.responsible_user_id} vencedor=${vencedor}`);
    t("created_by intacto (criador)", fin.created_by === U.resp.id);
    t("ambos os alvos seguem GM ativos",
      membroDb(gA, U.alvo_bob.id)?.role === "gm" && membroDb(gA, U.alvo_bob.id)?.status === "ativo" &&
      membroDb(gA, U.alvo_carol.id)?.role === "gm" && membroDb(gA, U.alvo_carol.id)?.status === "ativo");
    t("exatamente UMA auditoria de transferência", auditsDb("guilda.responsavel.transferir") === auditsAntesA + 1);
    t("responsável final válido (GM ativo)", responsavelValido(gA).ok, responsavelValido(gA).motivo);
  }

  sec("B — corrida: transferência × rebaixamento (PATCH) do alvo");
  const gB = await guildaComGMs("Guilda CAS Beta", ["alvo_bob", "alvo_carol"]);
  const auditsAntesB = { tr: auditsDb("guilda.responsavel.transferir"), mem: auditsDb("guilda.membro.atualizar") };
  // ator do PATCH: carol (GM comum, não o responsável) — gestão válida
  const [bTr, bPatch] = await Promise.all([
    putResp(U.resp.cookie, gB, U.alvo_bob.id),
    patchM(U.alvo_carol.cookie, gB, U.alvo_bob.id, { role: "membro" }),
  ]);
  const oksB = [bTr, bPatch].filter((r) => r.status === 200).length;
  console.log(`  resultados: PUT→bob=${bTr.status} PATCH bob→membro=${bPatch.status} | 200s=${oksB}`);
  t("EXATAMENTE uma operação vence", oksB === 1, `${bTr.status}|${bPatch.status}`);
  t("perdedor recebe 409", [bTr.status, bPatch.status].includes(409), `${bTr.status}|${bPatch.status}`);
  {
    const fin = guildaDb(gB);
    const bob = membroDb(gB, U.alvo_bob.id);
    if (bTr.status === 200) {
      // transferência venceu → bob é responsável e NÃO pode ser rebaixado
      t("matriz: transferência venceu → bob responsável", fin.responsible_user_id === U.alvo_bob.id);
      t("matriz: rebaixamento bloqueado → bob segue GM ativo", bob?.role === "gm" && bob?.status === "ativo", JSON.stringify(bob));
    } else {
      // rebaixamento venceu → CAS da transferência perdeu
      t("matriz: rebaixamento venceu → bob virou membro", bob?.role === "membro", JSON.stringify(bob));
      t("matriz: responsável permanece o criador", fin.responsible_user_id === U.resp.id, `final=${fin.responsible_user_id}`);
    }
    t("created_by intacto", fin.created_by === U.resp.id);
    t("responsável final válido (GM ativo)", responsavelValido(gB).ok, responsavelValido(gB).motivo);
    t("auditoria coerente: transferências +≤1, membro.atualizar +≤1",
      auditsDb("guilda.responsavel.transferir") - auditsAntesB.tr <= 1 &&
      auditsDb("guilda.membro.atualizar") - auditsAntesB.mem <= 1,
      `tr=${auditsDb("guilda.responsavel.transferir") - auditsAntesB.tr} mem=${auditsDb("guilda.membro.atualizar") - auditsAntesB.mem}`);
  }

  sec("C — corrida: transferência × remoção (DELETE) do alvo");
  const gC = await guildaComGMs("Guilda CAS Gama", ["alvo_dave", "alvo_carol"]);
  const auditsAntesC = { tr: auditsDb("guilda.responsavel.transferir"), rem: auditsDb("guilda.membro.remover") };
  const [cTr, cDel] = await Promise.all([
    putResp(U.resp.cookie, gC, U.alvo_dave.id),
    delM(U.alvo_carol.cookie, gC, U.alvo_dave.id),
  ]);
  const oksC = [cTr, cDel].filter((r) => r.status === 200).length;
  console.log(`  resultados: PUT→dave=${cTr.status} DELETE dave=${cDel.status} | 200s=${oksC}`);
  t("EXATAMENTE uma operação vence", oksC === 1, `${cTr.status}|${cDel.status}`);
  t("perdedor recebe 409", [cTr.status, cDel.status].includes(409), `${cTr.status}|${cDel.status}`);
  {
    const fin = guildaDb(gC);
    const dave = membroDb(gC, U.alvo_dave.id);
    if (cTr.status === 200) {
      t("matriz: transferência venceu → dave responsável GM ativo",
        fin.responsible_user_id === U.alvo_dave.id && dave?.role === "gm" && dave?.status === "ativo", JSON.stringify(dave));
    } else {
      t("matriz: remoção venceu → dave removido", dave?.status === "removido", JSON.stringify(dave));
      t("matriz: responsável permanece o criador", fin.responsible_user_id === U.resp.id, `final=${fin.responsible_user_id}`);
    }
    t("created_by intacto", fin.created_by === U.resp.id);
    t("responsável final válido (GM ativo)", responsavelValido(gC).ok, responsavelValido(gC).motivo);
    t("auditoria coerente: transferências +≤1, membro.remover +≤1",
      auditsDb("guilda.responsavel.transferir") - auditsAntesC.tr <= 1 &&
      auditsDb("guilda.membro.remover") - auditsAntesC.rem <= 1,
      `tr=${auditsDb("guilda.responsavel.transferir") - auditsAntesC.tr} rem=${auditsDb("guilda.membro.remover") - auditsAntesC.rem}`);
  }

  sec("Invariante global — nenhuma guilda com responsável órfão");
  const orfaos = comDb(BANCO, (db) => db.prepare(`
    select g.id from guilds g
    left join guild_members gm on gm.guild_id = g.id and gm.user_id = g.responsible_user_id
    left join users u on u.id = g.responsible_user_id
    where g.responsible_user_id is not null
      and (gm.role is null or gm.role <> 'gm' or gm.status <> 'ativo' or u.status <> 'ativo')
  `).all());
  t("zero guildas com responsável apontando para não-GM/inativo", orfaos.length === 0, JSON.stringify(orfaos));
} finally {
  await encerrarServidor(proc);
  limparDir(DIR);
  despejarLogs();
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
