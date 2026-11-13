#!/usr/bin/env node
// HOMOLOGAÇÃO DE ATUALIZAÇÃO DE INSTALAÇÃO EXISTENTE (Issue #33, Etapa 5)
//
// Prova, em raízes 100% descartáveis, que uma instalação criada numa
// versão ANTERIOR do projeto (schema até a migration 0013) pode ser:
//   1. semeada com dados reais (usuário admin, campanha, personagem);
//   2. copiada como backup pré-atualização;
//   3. atualizada pelo procedimento real (`servidor/dist/db/migrate.js`,
//      o mesmo executado pelo iniciar-mestre-rpg.bat);
//   4. comparada registro a registro — nada se perde;
//   5. inicializada — servidor sobe e os dados aparecem na API;
//   6. restaurada a partir do backup pré-update via restaurador real
//      (aplicar-restauracao.js) e re-atualizada — recuperação comprovada.
//
// Nunca toca banco/, arquivos/ ou backups/ reais do usuário.
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { randomUUID, createHash } from "node:crypto";
import { hashSenha } from "./servidor/dist/lib/password.js";

const RAIZ_REPO = dirname(fileURLToPath(import.meta.url));
const MIGRADOR = join(RAIZ_REPO, "servidor/dist/db/migrate.js");
const RESTAURADOR = join(RAIZ_REPO, "servidor/dist/db/aplicar-restauracao.js");
const INDICE = join(RAIZ_REPO, "servidor/dist/index.js");
const MIGRATIONS = join(RAIZ_REPO, "servidor/migrations");
// Total de migrations do journal atual — derivado do arquivo, não de
// número mágico, para não quebrar a cada migration nova.
const TOTAL_MIGRATIONS = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8")).entries.length;
const ULTIMA_MIGRACAO_ANTIGA = "0013"; // instalação anterior: schema até 0013

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

function dirTeste(nome) { return mkdtempSync(join(tmpdir(), `mrpg-upgrade-${nome}-`)); }
function envRaiz(raiz) {
  return {
    ...process.env,
    MESTRE_HOME: raiz,
    MESTRE_BANCO: join(raiz, "banco", "mestre-rpg.db"),
    MESTRE_ARQUIVOS: join(raiz, "arquivos", "campanhas"),
    MESTRE_BACKUPS: join(raiz, "backups"),
  };
}
const rodar = (cmd, args, env) => {
  const r = spawnSync(cmd, args, { env, encoding: "utf8" });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
};
const dbPath = (raiz) => join(raiz, "banco", "mestre-rpg.db");
const abrirDb = (p) => new Database(p);
const tabelas = (db) => db.prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name").all().map((r) => r.name);
const dumpTudo = (dbPathArq) => {
  const db = abrirDb(dbPathArq);
  try {
    const out = {};
    for (const tb of tabelas(db)) {
      try { out[tb] = db.prepare(`select * from "${tb}" order by rowid`).all(); } catch { out[tb] = "ERRO"; }
    }
    return out;
  } finally { db.close(); }
};
const contarJournal = (dbPathArq) => {
  const db = abrirDb(dbPathArq);
  try {
    const jt = tabelas(db).find((n) => n.includes("migration"));
    return jt ? db.prepare(`select count(*) c from "${jt}"`).get().c : -1;
  } finally { db.close(); }
};

// Aplica as migrations ANTIGAS (até ULTIMA_MIGRACAO_ANTIGA) via o mesmo
// migrador Drizzle, mas apontando para uma pasta com o subconjunto real.
function prepararMigracoesAntigas(destino) {
  mkdirSync(join(destino, "meta"), { recursive: true });
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta/_journal.json"), "utf8"));
  const antigas = journal.entries.filter((e) => parseInt(e.tag.slice(0, 4), 10) <= parseInt(ULTIMA_MIGRACAO_ANTIGA, 10));
  for (const e of antigas) {
    const arq = `${e.tag}.sql`;
    cpSync(join(MIGRATIONS, arq), join(destino, arq));
  }
  writeFileSync(join(destino, "meta/_journal.json"), JSON.stringify({ ...journal, entries: antigas }));
  return antigas.length;
}
async function migrarVersaoAntiga(banco, pastaMigracoes) {
  mkdirSync(dirname(banco), { recursive: true });
  const sqlite = new Database(banco);
  try {
    sqlite.pragma("journal_mode = WAL");
    const db = drizzle(sqlite);
    await migrate(db, { migrationsFolder: pastaMigracoes });
  } finally { sqlite.close(); }
}

async function esperarSaudavel(base, proc, timeoutMs = 30000) {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    try { const r = await fetch(base + "/api/health", { signal: AbortSignal.timeout(2000) }); if (r.ok) return; } catch { }
    if (proc.exitCode !== null) throw new Error("servidor morreu: " + proc.exitCode);
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("timeout aguardando /api/health");
}

const RAIZ = dirTeste("upgrade");
let proc = null;

try {
  // ===== 1. INSTALAÇÃO ANTERIOR (schema até 0013) =====
  sec("1. Instalação de versão anterior (migrations até 0013)");
  const ANTIGAS = join(RAIZ, "migrations-0013");
  const nAntigas = prepararMigracoesAntigas(ANTIGAS);
  t("subconjunto de migrations antigas montado", nAntigas === 14, `${nAntigas} migrations`);
  const BANCO_VELHO = dbPath(RAIZ);
  await migrarVersaoAntiga(BANCO_VELHO, ANTIGAS);
  {
    const db = abrirDb(BANCO_VELHO);
    const ts = tabelas(db);
    t("schema antigo aplicado (sem campaign_rule_books)", !ts.includes("campaign_rule_books"), ts.filter((x) => x.includes("rule")).join(","));
    t("journal antigo registra 14 migrations", contarJournal(BANCO_VELHO) === 14, String(contarJournal(BANCO_VELHO)));
    db.close();
  }

  // ===== 2. DADOS REAIS SEMEADOS NA VERSÃO ANTIGA =====
  sec("2. Dados reais na versão anterior");
  const agora = Date.now();
  const uid = randomUUID(), cid = randomUUID(), mid = randomUUID(), chid = randomUUID(), jid = randomUUID(), jmid = randomUUID(), jchid = randomUUID();
  {
    const db = abrirDb(BANCO_VELHO);
    try {
      const senhaHash = await hashSenha("senha-antiga-123");
      db.prepare("insert into users (id,username,email,display_name,password_hash,is_admin,status,preferences,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
        .run(uid, "mestre_antigo", "mestre@antigo.test", "Mestre Antigo", senhaHash, 1, "ativo", "{}", agora, agora);
      // trigger da migração 0013 registra admin_principal automaticamente
    db.prepare("insert into campaigns (id,name,description,system,status,owner_id,settings,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
      .run(cid, "Campanha Legada", "Campanha criada antes da atualização", "Sistema Livre", "andamento", uid, "{}", agora, agora);
    db.prepare("insert into memberships (id,campaign_id,user_id,role,permissions,status,joined_at,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
      .run(mid, cid, uid, "mestre", "{}", "ativo", agora, agora, agora);
    db.prepare("insert into characters (id,campaign_id,membership_id,name,data,overrides,status,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
      .run(chid, cid, mid, "Herói Legado", JSON.stringify({ forca: 14, vida: 30 }), "{}", "aprovada", agora, agora);
    // jogador + personagem
    db.prepare("insert into users (id,username,email,display_name,password_hash,is_admin,status,preferences,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?)")
      .run(jid, "jogador_antigo", null, "Jogador Antigo", senhaHash, 0, "ativo", "{}", agora, agora);
    db.prepare("insert into memberships (id,campaign_id,user_id,role,permissions,status,joined_at,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
      .run(jmid, cid, jid, "jogador", "{}", "ativo", agora, agora, agora);
      db.prepare("insert into characters (id,campaign_id,membership_id,name,data,overrides,status,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
        .run(jchid, cid, jmid, "Aventureira Antiga", JSON.stringify({ agilidade: 12 }), "{}", "aprovada", agora, agora);
    } finally { db.close(); }
  }
  const antes = dumpTudo(BANCO_VELHO);
  t("dados legados semeados (2 users, 1 campanha, 2 personagens)",
    antes.users?.length === 2 && antes.campaigns?.length === 1 && antes.characters?.length === 2,
    JSON.stringify({ u: antes.users?.length, c: antes.characters?.length }));

  // ===== 3. BACKUP PRÉ-ATUALIZAÇÃO =====
  sec("3. Backup antes de atualizar");
  const BK = join(RAIZ, "backups", "pre-update");
  mkdirSync(join(BK, "arquivos"), { recursive: true });
  mkdirSync(join(BK, "configuracao"), { recursive: true });
  copyFileSync(BANCO_VELHO, join(BK, "mestre-rpg.db"));
  writeFileSync(join(BK, "arquivos", "lore_legado.txt"), "anotações da campanha antiga");
  writeFileSync(join(BK, "configuracao", "servidor.json"), JSON.stringify({ porta: 3001 }));
  const hashAntes = createHash("sha256").update(readFileSync(BANCO_VELHO)).digest("hex");
  t("backup pré-update criado", existsSync(join(BK, "mestre-rpg.db")));

  // ===== 4. ATUALIZAÇÃO REAL (migrate do projeto atual) =====
  sec("4. Procedimento real de atualização (db:migrate)");
  const mig = rodar("node", [MIGRADOR], envRaiz(RAIZ));
  t("migrate executou com sucesso", mig.code === 0, mig.out.slice(-300));
  t(`journal agora registra ${TOTAL_MIGRATIONS} migrations`, contarJournal(BANCO_VELHO) === TOTAL_MIGRATIONS, String(contarJournal(BANCO_VELHO)));
  {
    const db = abrirDb(BANCO_VELHO);
    const ts = tabelas(db);
    for (const nova of ["campaign_rule_books", "rule_book_items", "rule_book_backups"]) {
      t(`tabela nova ${nova} existe`, ts.includes(nova));
    }
    t("characters.is_npc adicionado (0014)", db.prepare("pragma table_info(characters)").all().some((c) => c.name === "is_npc"));
    t("rule_books.excluido_em presente", db.prepare("pragma table_info(rule_books)").all().some((c) => c.name === "excluido_em"));
    db.close();
  }

  // ===== 5. COMPARAÇÃO REGISTRO A REGISTRO =====
  sec("5. Preservação de dados");
  const depois = dumpTudo(BANCO_VELHO);
  let divergencias = [];
  for (const [tb, rows] of Object.entries(antes)) {
    if (tb.includes("migration")) continue; // journal do drizzle MUDA por definição
    const d = depois[tb];
    if (JSON.stringify(rows) !== JSON.stringify(d)) {
      // tolera colunas novas em linhas antigas? migrations só ADD em tabelas novas
      // ou colunas com default — comparar chaves presentes no antes
      const norm = (rs) => (rs ?? []).map((r) => Object.fromEntries(Object.keys(r).filter((k) => rows[0] ? k in rows[0] : true).map((k) => [k, r[k]])));
      if (JSON.stringify(norm(rows)) !== JSON.stringify(norm(d))) divergencias.push(tb);
    }
  }
  t("nenhuma linha pré-existente alterada ou perdida", divergencias.length === 0, divergencias.join(","));
  t("2 users preservados", depois.users?.length === 2);
  t("1 campanha preservada", depois.campaigns?.[0]?.name === "Campanha Legada");
  t("2 personagens preservados", depois.characters?.length === 2 && depois.characters.every((c) => c.status === "aprovada"));
  t("dados JSON das fichas intactos", depois.characters?.some((c) => c.name === "Herói Legado" && JSON.parse(c.data).forca === 14));
  t("journal do drizzle consistente", depois.__drizzle_migrations?.length === TOTAL_MIGRATIONS || contarJournal(BANCO_VELHO) === TOTAL_MIGRATIONS);

  // ===== 6. INICIALIZAÇÃO DO SISTEMA ATUALIZADO =====
  sec("6. Servidor atualizado inicializa e serve os dados");
  const PORTA = await new Promise((res) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
  proc = spawn("node", [INDICE], { env: { ...envRaiz(RAIZ), MESTRE_PORTA: String(PORTA) }, stdio: ["ignore", "pipe", "pipe"] });
  const BASE = `http://localhost:${PORTA}`;
  try {
    await esperarSaudavel(BASE, proc);
    t("/api/health OK após update", true);
    const login = await fetch(BASE + "/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "mestre_antigo", password: "senha-antiga-123" }),
    });
    const lj = await login.json();
    t("login do usuário legado funciona", login.ok && !!lj.usuario, `status ${login.status}`);
    const setCookie = login.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";")[0];
    const camps = await (await fetch(BASE + "/api/campaigns", { headers: { cookie } })).json();
    const lista = camps.campanhas ?? camps.campaigns ?? (Array.isArray(camps) ? camps : []);
    const camp = lista.find((c) => c.name === "Campanha Legada");
    t("campanha legada listada na API", !!camp, JSON.stringify(camps).slice(0, 120));
    if (camp?.id) {
      const pers = await (await fetch(`${BASE}/api/campaigns/${camp.id}/characters`, { headers: { cookie } })).json();
      const nomes = (pers.personagens ?? pers ?? []).map((p) => p.name);
      t("personagens legados visíveis", nomes.includes("Herói Legado") && nomes.includes("Aventureira Antiga"), nomes.join(","));
    }
  } finally {
    if (proc) { proc.kill(); await new Promise((r) => proc.once("exit", r)); proc = null; }
  }

  // ===== 7. RECUPERAÇÃO: restaurar backup pré-update e re-atualizar =====
  sec("7. Restauração do backup pré-update + nova atualização");
  const RAIZ2 = join(RAIZ, "pos-restore");
  // simula estado atual corrompido/pós-update problemático: banco atual + flag apontando p/ backup
  const env2 = {
    ...process.env,
    MESTRE_HOME: RAIZ2,
    MESTRE_BANCO: dbPath(RAIZ2),
    MESTRE_ARQUIVOS: join(RAIZ2, "arquivos", "campanhas"),
    MESTRE_BACKUPS: join(RAIZ2, "backups"),
  };
  mkdirSync(dirname(dbPath(RAIZ2)), { recursive: true });
  // banco "vivo" pós-update (cópia do migrado)
  copyFileSync(BANCO_VELHO, dbPath(RAIZ2));
  // backup acessível pela flag
  const BK2 = join(RAIZ2, "backups", "pre-update");
  mkdirSync(BK2, { recursive: true });
  cpSync(BK, BK2, { recursive: true });
  // arma flag de restauração
  {
    const db = abrirDb(dbPath(RAIZ2));
    db.prepare("insert into server_settings (key,value) values ('restauracao_pendente',?) on conflict(key) do update set value=excluded.value")
      .run(JSON.stringify({ filePath: BK2 })); // filePath = DIRETÓRIO do backup
    db.close();
  }
  const res = rodar("node", [RESTAURADOR], env2);
  t("restaurador executou", res.code === 0, res.out.slice(-300));
  {
    const db = abrirDb(dbPath(RAIZ2));
    const ts = tabelas(db);
    t("restore voltou ao schema antigo (sem campaign_rule_books)", !ts.includes("campaign_rule_books"));
    const c = db.prepare("select name from campaigns").all();
    t("dados legados intactos após restore", c.length === 1 && c[0].name === "Campanha Legada");
    t("arquivo do backup restaurado", existsSync(join(RAIZ2, "arquivos", "campanhas", "lore_legado.txt")));
    db.close();
  }
  // re-atualização pós-restore
  const mig2 = rodar("node", [MIGRADOR], env2);
  t("re-atualização pós-restore OK", mig2.code === 0, mig2.out.slice(-200));
  t(`journal ${TOTAL_MIGRATIONS} novamente`, contarJournal(dbPath(RAIZ2)) === TOTAL_MIGRATIONS);
  {
    const db = abrirDb(dbPath(RAIZ2));
    const pers = db.prepare("select count(*) c from characters").get().c;
    t("personagens preservados após ciclo restore+update", pers === 2, String(pers));
    db.close();
  }

} catch (e) {
  fail++;
  console.log("  FALHOU exceção:", String(e).slice(0, 600));
} finally {
  if (proc) { try { proc.kill(); } catch { } }
  rmSync(RAIZ, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

console.log(`\n==== atualização de instalação: ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
