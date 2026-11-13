// Correção da corrida na numeração de sessões (auditoria: MAX(number)+1
// sem constraint única). Cobre:
//   1. criação normal com turno inicial atômico;
//   2. duas criações SIMULTÂNEAS na mesma campanha → números distintos;
//   3. criações simultâneas em campanhas diferentes → sequências
//      independentes;
//   4. banco legado (schema até 0022) com (campaign_id, number)
//      duplicados → migration 0023 renumera sem perder sessões e cria
//      o índice único;
//   5. payload inválido → 400 sem gravar nada; sessões nunca ficam sem
//      a linha de turno inicial.
// Banco temporário + fixtures sintéticas; nunca toca dados reais.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, comDb, req, encerrarServidor, limparDir, abrirDb,
} from "./teste-base.mjs";

const RAIZ = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(RAIZ, "servidor", "migrations");
const MIGRADOR = join(RAIZ, "servidor", "dist", "db", "migrate.js");

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

/** Aplica só as migrations até a idx informada (padrão do teste de upgrade). */
async function prepararBancoAte(banco, idxMax) {
  for (const suf of ["", "-wal", "-shm"]) rmSync(banco + suf, { force: true });
  const pasta = mkdtempSync(join(tmpdir(), "mrpg-mig-"));
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8"));
  const antigas = journal.entries.filter((e) => e.idx <= idxMax);
  const tags = new Set(antigas.map((e) => e.tag));
  for (const f of readdirSync(MIGRATIONS)) {
    if (f.endsWith(".sql") && tags.has(f.replace(/\.sql$/, ""))) cpSync(join(MIGRATIONS, f), join(pasta, f));
  }
  mkdirSync(join(pasta, "meta"), { recursive: true });
  for (const f of readdirSync(join(MIGRATIONS, "meta"))) {
    if (f === "_journal.json") {
      writeFileSync(join(pasta, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: antigas }));
    } else if (tags.has(f.replace(/_snapshot\.json$/, ""))) {
      cpSync(join(MIGRATIONS, "meta", f), join(pasta, "meta", f));
    }
  }
  const sqlite = new Database(banco);
  sqlite.pragma("journal_mode = WAL");
  const db = drizzle(sqlite);
  await migrate(db, { migrationsFolder: pasta });
  sqlite.close();
  rmSync(pasta, { recursive: true, force: true });
}

/** Roda o migrador real do projeto (mesmo do iniciar-mestre-rpg.bat). */
function migrarReal(banco) {
  const r = spawnSync("node", [MIGRADOR], {
    env: { ...process.env, MESTRE_BANCO: banco },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`migrate falhou: ${r.stderr || r.stdout}`);
}

const contarSessoes = (banco, cid) =>
  comDb(banco, (db) => db.prepare("select count(*) c from sessions where campaign_id=?").get(cid).c);
const numeros = (banco, cid) =>
  comDb(banco, (db) => db.prepare("select number from sessions where campaign_id=? order by number").all(cid).map((r) => r.number));
const turnosDe = (banco, sid) =>
  comDb(banco, (db) => db.prepare("select count(*) c from turns where session_id=?").get(sid).c);

// ---------- Parte 1: comportamento via API ----------
const DIR = dirTeste("sessao-numero");
const BANCO = join(DIR, "banco", "mestre-rpg.db");
const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc;

try {
  sec("1. Criação normal e simultânea na mesma campanha");
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: join(DIR, "arq"), backups: join(DIR, "bks") });
  await esperarSaudavel(BASE, proc);
  const c = await criarCenario(BASE, BANCO, { jogadores: {}, ficha: false });
  const cid = c.campId;
  const cookie = c.cookieMestre;
  t("cenário criado", !!cid && !!cookie);

  const s1 = await req(BASE, "POST", `/campaigns/${cid}/sessoes`, { cookie, body: { name: "Sessão 1" } });
  t("criação normal → 201", s1.status === 201, `status ${s1.status}`);
  t("primeira sessão recebe number=1", s1.json?.sessao?.number === 1, JSON.stringify(s1.json?.sessao?.number));
  t("sessão tem turno inicial", turnosDe(BANCO, s1.json.sessao.id) === 1);

  // duas criações simultâneas
  const [s2, s3] = await Promise.all([
    req(BASE, "POST", `/campaigns/${cid}/sessoes`, { cookie, body: {} }),
    req(BASE, "POST", `/campaigns/${cid}/sessoes`, { cookie, body: {} }),
  ]);
  t("duas criações simultâneas → 201", s2.status === 201 && s3.status === 201, `${s2.status}/${s3.status}`);
  const nums = [s2.json?.sessao?.number, s3.json?.sessao?.number].sort();
  t("números simultâneos distintos e sequenciais", JSON.stringify(nums) === "[2,3]", JSON.stringify(nums));
  t("ambas têm turno inicial", turnosDe(BANCO, s2.json.sessao.id) === 1 && turnosDe(BANCO, s3.json.sessao.id) === 1);
  t("banco tem exatamente 3 sessões", contarSessoes(BANCO, cid) === 3);

  sec("2. Campanhas diferentes têm sequências independentes");
  const camp2 = await req(BASE, "POST", "/campaigns", { cookie, body: { name: "Campanha Dois" } });
  const cid2 = camp2.json?.campanha?.id;
  t("segunda campanha criada", !!cid2);
  const [a1, a2] = await Promise.all([
    req(BASE, "POST", `/campaigns/${cid}/sessoes`, { cookie, body: {} }),
    req(BASE, "POST", `/campaigns/${cid2}/sessoes`, { cookie, body: {} }),
  ]);
  t("criações cruzadas → 201", a1.status === 201 && a2.status === 201);
  t("campanha 1 continua sequencial", a1.json?.sessao?.number === 4, String(a1.json?.sessao?.number));
  t("campanha 2 começa em 1", a2.json?.sessao?.number === 1, String(a2.json?.sessao?.number));
  t("números por campanha únicos", JSON.stringify(numeros(BANCO, cid)) === "[1,2,3,4]" && JSON.stringify(numeros(BANCO, cid2)) === "[1]");

  sec("3. Payload inválido não grava nada");
  const antes = contarSessoes(BANCO, cid);
  const inv = await req(BASE, "POST", `/campaigns/${cid}/sessoes`, { cookie, body: { name: 123 } });
  t("name numérico → 400", inv.status === 400, `status ${inv.status}`);
  t("nenhuma sessão gravada", contarSessoes(BANCO, cid) === antes);

  // jogador sem papel de mestre não cria sessão
  if (c.jogadores?.jogador1?.cookie) {
    const neg = await req(BASE, "POST", `/campaigns/${cid}/sessoes`, { cookie: c.jogadores.jogador1.cookie, body: {} });
    t("jogador → negado", neg.status === 403 || neg.status === 401, `status ${neg.status}`);
  }
} finally {
  if (proc) await encerrarServidor(proc);
}

// ---------- Parte 2: banco legado com duplicatas + migration 0023 ----------
sec("4. Banco legado (até 0022) com números duplicados");
const DIR2 = dirTeste("sessao-numero-legado");
const BANCO2 = join(DIR2, "banco", "mestre-rpg.db");
mkdirSync(dirname(BANCO2), { recursive: true });
try {
  await prepararBancoAte(BANCO2, 22);
  const db = abrirDb(BANCO2);
  const agora = Date.now();
  const uid = crypto.randomUUID(), cidL = crypto.randomUUID();
  db.prepare("insert into users (id,username,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,0,'ativo',?,?)")
    .run(uid, "legado_user", "x", agora, agora);
  db.prepare("insert into campaigns (id,name,owner_id,status,created_at,updated_at) values (?,?,?,'andamento',?,?)")
    .run(cidL, "Campanha Legada", uid, agora, agora);
  // sessões antigas com (campaign_id, number) duplicado: duas "Sessão 1",
  // duas "Sessão 2" e uma "Sessão 3"
  const ids = [];
  for (const [i, num] of [[0, 1], [1, 1], [2, 2], [3, 2], [4, 3]]) {
    const id = crypto.randomUUID(); ids.push(id);
    db.prepare("insert into sessions (id,campaign_id,number,name,status,created_at,updated_at) values (?,?,?,?, 'encerrada',?,?)")
      .run(id, cidL, num, `Legada ${num}`, agora + i, agora + i);
  }
  // marca a primeira ocorrência de cada número como a mais antiga
  db.prepare("update sessions set created_at = created_at - 1000 where id = ?").run(ids[0]);
  db.prepare("update sessions set created_at = created_at - 500 where id = ?").run(ids[2]);
  db.close();

  migrarReal(BANCO2);

  const db2 = abrirDb(BANCO2);
  const rows = db2.prepare("select id, number, name from sessions where campaign_id=? order by number, created_at").all(cidL);
  const numsL = rows.map((r) => r.number);
  t("nenhuma sessão perdida", rows.length === 5, `${rows.length} linhas`);
  t("números ficaram únicos", new Set(numsL).size === numsL.length, JSON.stringify(numsL));
  t("duplicatas renumeradas acima do max antigo", numsL.includes(4) && numsL.includes(5), JSON.stringify(numsL));
  t("ocorrência mais antiga preservada", rows.some((r) => r.number === 1 && r.id === ids[0]));
  // índice único existe: insert direto de duplicata deve falhar
  let impediu = false;
  try {
    db2.prepare("insert into sessions (id,campaign_id,number,status,created_at,updated_at) values (?,?,1,'ativa',?,?)")
      .run(crypto.randomUUID(), cidL, Date.now(), Date.now());
  } catch { impediu = true; }
  db2.close();
  t("constraint única ativa pós-migration", impediu);
} finally {
  limparDir(DIR2);
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
