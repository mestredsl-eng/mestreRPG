// Testes — Issue #65 PR-C1: corrida do último mestre ativo.
// Prova que PATCH/DELETE /campaigns/:id/members/:membershipId nunca
// deixam a campanha sem mestre ativo, mesmo com duas mutações
// autorizadas disparadas simultaneamente (Promise.all, sem sleeps).
// A proteção real é o WHERE condicional do UPDATE (subquery
// count(*) de mestres ativos) — este teste mede a invariante SQL,
// não apenas os status HTTP.
// Banco temporário + migrations reais + servidor spawnado (teardown seguro).
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  encerrarServidor, limparDir, req, sessao, criarCenario, comDb, abrirDb,
} from "./teste-base.mjs";
import { hashSenha } from "./servidor/dist/lib/password.js";

const DIR = dirTeste("autorizacao-concorrencia");
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

const porta = await portaLivre();
const base = `http://127.0.0.1:${porta}`;
const proc = subirServidor(porta, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
consumirStream(proc.stdout, logsServidor.out);
consumirStream(proc.stderr, logsServidor.err);

const mestresAtivos = (campaignId) => comDb(BANCO, (db) =>
  db.prepare("select count(*) c from memberships where campaign_id=? and role='mestre' and status='ativo'").get(campaignId).c);
const estadoMembro = (membershipId) => comDb(BANCO, (db) =>
  db.prepare("select role||'|'||status r from memberships where id=?").get(membershipId)?.r ?? "ausente");
const estadoMestres = (campaignId) => comDb(BANCO, (db) =>
  db.prepare("select user_id||':'||role||'|'||status e from memberships where campaign_id=? order by role,status").all(campaignId)
    .map((r) => r.e).join(" ; "));

try {
  await esperarSaudavel(base, proc);
  sec("Cenário — campanha com exatamente dois mestres ativos");
  const C = await criarCenario(base, BANCO, { jogadores: { jogador1: "corr_j1", jogador2: "corr_j2" } });
  const { adminId, campId, cookieMestre, jogadores, membMestre } = C;
  const j1 = jogadores.jogador1;

  // Promove jogador1 a mestre via API real → exatamente 2 mestres (admin + j1)
  const promo = await req(base, "PATCH", `/campaigns/${campId}/members/${j1.membershipId}`, {
    cookie: cookieMestre, body: { role: "mestre" },
  });
  t("jogador1 promovido a mestre", promo.status === 200, `status=${promo.status}`);
  t("exatamente 2 mestres ativos", mestresAtivos(campId) === 2, `count=${mestresAtivos(campId)}`);

  sec("Corrida PATCH — A rebaixa B enquanto B rebaixa A (Promise.all, sem sleeps)");
  const [pA, pB] = await Promise.all([
    req(base, "PATCH", `/campaigns/${campId}/members/${j1.membershipId}`, { cookie: cookieMestre, body: { role: "jogador" } }),
    req(base, "PATCH", `/campaigns/${campId}/members/${membMestre}`, { cookie: j1.cookie, body: { role: "jogador" } }),
  ]);
  const aceitasPatch = [pA, pB].filter((r) => r.status === 200).length;
  const negadasPatch = [pA, pB].filter((r) => r.status !== 200).map((r) => r.status);
  console.log(`  resultados: admin→j1=${pA.status} j1→admin=${pB.status} | aceitas=${aceitasPatch} negadas=${JSON.stringify(negadasPatch)}`);
  console.log(`  estado final: ${estadoMestres(campId)}`);
  t("no máximo uma mutação PATCH aceita", aceitasPatch <= 1, `aceitas=${aceitasPatch}`);
  t("pelo menos um mestre ativo permanece", mestresAtivos(campId) >= 1, `count=${mestresAtivos(campId)}`);
  t("exatamente um mestre ativo ao final", mestresAtivos(campId) === 1, `count=${mestresAtivos(campId)}`);
  t("perdedor recebeu 400/403 (não 5xx)", negadasPatch.every((s) => s === 400 || s === 403), JSON.stringify(negadasPatch));

  sec("Cenário DELETE — segunda campanha com exatamente dois mestres ativos");
  const campC = await req(base, "POST", "/campaigns", { cookie: cookieMestre, body: { name: "Campanha Corrida Delete" } });
  const campCId = campC.json?.campanha?.id;
  t("campanha C criada", campC.status === 201 && !!campCId, JSON.stringify(campC.json).slice(0, 200));
  // Segundo mestre sintético na campanha C (admin já é mestre por ser criador)
  const u1 = crypto.randomUUID();
  const agora = Date.now();
  {
    const w = abrirDb(BANCO);
    w.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
      .run(u1, "corr_mestre2", "Mestre Dois", await hashSenha("senha-jogador-123"), agora, agora);
    w.prepare("insert into memberships (id,campaign_id,user_id,role,status,joined_at,created_at,updated_at) values (?,?,?,'mestre','ativo',?,?,?)")
      .run(crypto.randomUUID(), campCId, u1, agora, agora, agora);
    w.close();
  }
  const cookieU1 = sessao(BANCO, u1);
  const membU1 = comDb(BANCO, (db) => db.prepare("select id from memberships where campaign_id=? and user_id=?").get(campCId, u1).id);
  const membAdminC = comDb(BANCO, (db) => db.prepare("select id from memberships where campaign_id=? and user_id=?").get(campCId, adminId).id);
  t("exatamente 2 mestres ativos na campanha C", mestresAtivos(campCId) === 2, `count=${mestresAtivos(campCId)}`);

  sec("Corrida DELETE — cada mestre remove o outro (Promise.all, sem sleeps)");
  const [dA, dB] = await Promise.all([
    req(base, "DELETE", `/campaigns/${campCId}/members/${membU1}`, { cookie: cookieMestre }),
    req(base, "DELETE", `/campaigns/${campCId}/members/${membAdminC}`, { cookie: cookieU1 }),
  ]);
  const aceitasDel = [dA, dB].filter((r) => r.status === 200).length;
  const negadasDel = [dA, dB].filter((r) => r.status !== 200).map((r) => r.status);
  console.log(`  resultados: admin→u1=${dA.status} u1→admin=${dB.status} | aceitas=${aceitasDel} negadas=${JSON.stringify(negadasDel)}`);
  console.log(`  estado final: ${estadoMestres(campCId)}`);
  t("no máximo uma remoção aceita", aceitasDel <= 1, `aceitas=${aceitasDel}`);
  t("pelo menos um mestre ativo permanece em C", mestresAtivos(campCId) >= 1, `count=${mestresAtivos(campCId)}`);
  t("exatamente um mestre ativo ao final em C", mestresAtivos(campCId) === 1, `count=${mestresAtivos(campCId)}`);
  t("perdedor recebeu 400/403 (não 5xx)", negadasDel.every((s) => s === 400 || s === 403), JSON.stringify(negadasDel));
  {
    // o removido deve estar 'removido'; o sobrevivente 'mestre|ativo'
    const estados = comDb(BANCO, (db) => ({
      u1: db.prepare("select role||'|'||status r from memberships where id=?").get(membU1).r,
      admin: db.prepare("select role||'|'||status r from memberships where id=?").get(membAdminC).r,
    }));
    const removidos = [estados.u1, estados.admin].filter((e) => e === "mestre|removido" || e.endsWith("|removido")).length;
    t("exatamente uma membership ficou 'removido'", removidos === 1, JSON.stringify(estados));
    t("sobrevivente continua mestre ativo",
      [estados.u1, estados.admin].some((e) => e === "mestre|ativo"), JSON.stringify(estados));
  }

  sec("Controle sequencial — único mestre ativo não pode se remover");
  // Após a corrida DELETE, campanha C tem exatamente 1 mestre ativo.
  // O único ator possível é o próprio sobrevivente (self PATCH/DELETE).
  const sobrevivente = comDb(BANCO, (db) =>
    db.prepare("select user_id from memberships where campaign_id=? and role='mestre' and status='ativo'").get(campCId).user_id);
  const cookieSobrevivente = sobrevivente === adminId ? cookieMestre : cookieU1;
  const membSobrevivente = sobrevivente === adminId ? membAdminC : membU1;
  t("exatamente um mestre ativo para o controle", mestresAtivos(campCId) === 1, `count=${mestresAtivos(campCId)}`);

  const pSelf = await req(base, "PATCH", `/campaigns/${campCId}/members/${membSobrevivente}`, {
    cookie: cookieSobrevivente, body: { role: "jogador" },
  });
  t("PATCH self role→jogador negado (400)", pSelf.status === 400, `status=${pSelf.status} ${JSON.stringify(pSelf.json).slice(0, 120)}`);
  const dSelf = await req(base, "DELETE", `/campaigns/${campCId}/members/${membSobrevivente}`, { cookie: cookieSobrevivente });
  t("DELETE self negado (400)", dSelf.status === 400, `status=${dSelf.status} ${JSON.stringify(dSelf.json).slice(0, 120)}`);
  t("readback: mestre sobrevivente intacto", estadoMembro(membSobrevivente) === "mestre|ativo", estadoMembro(membSobrevivente));
  t("campanha C segue com 1 mestre ativo", mestresAtivos(campCId) === 1, `count=${mestresAtivos(campCId)}`);
} finally {
  await encerrarServidor(proc);
  limparDir(DIR);
  despejarLogs();
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
