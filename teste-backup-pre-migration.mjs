// Testes do backup pré-migration (P10-B / Issue #155).
// Executa o migrate.ts REAL via tsx contra bancos temporários
// (MESTRE_BANCO/MESTRE_BACKUPS/MESTRE_ARQUIVOS/MESTRE_STATE_DIR) —
// prova ordem backup→migrate, bloqueio em falha e ausência de
// backup em instalação nova ou banco em dia. "Migrations pendentes"
// é fabricado copiando servidor/migrations para %TEMP% e truncando
// o journal DA CÓPIA (MESTRE_MIGRATIONS_FOLDER) — o journal
// versionado nunca é escrito pelo teste.
// Banco vazio SÓ migra com bootstrap explicitamente provisionado
// (gravarProvisionamento + autorizarPrimeiroBootstrap) — o mesmo
// contrato que o .bat usará na P10-C.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import {
  autorizarPrimeiroBootstrap, gravarProvisionamento, gravarReciboInstalacao,
} from "./scripts/estado-externo.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => {
  if (c) { pass++; console.log("  ok", n); }
  else { fail++; console.log("  FALHOU", n, extra); }
};
const sec = (n) => console.log("\n== " + n + " ==");

const ROOT = process.cwd();
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const MIGRATIONS_SRC = join(ROOT, "servidor", "migrations");
const journalOriginal = readFileSync(join(MIGRATIONS_SRC, "meta", "_journal.json"), "utf8");
const totalJournal = JSON.parse(journalOriginal).entries.length;

const BASE = mkdtempSync(join(tmpdir(), "mestre-prebackup-"));
let seq = 0;
const cenario = () => {
  const dir = join(BASE, `c${++seq}`);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    env: {
      MESTRE_BANCO: join(dir, "banco", "mestre-rpg.db"),
      MESTRE_BACKUPS: join(dir, "backups"),
      MESTRE_ARQUIVOS: join(dir, "arquivos"),
      MESTRE_STATE_DIR: join(dir, "state"),
    },
  };
};
// Provisiona o primeiro bootstrap no state dir isolado do cenário —
// repoDir é o repo real (RAIZ do migrate.ts), env isola o state.
const bootstrapar = (c) => {
  gravarProvisionamento(ROOT, c.env);
  const a = autorizarPrimeiroBootstrap(ROOT, c.env);
  if (!a.autorizado) throw new Error(`bootstrap não autorizado: ${a.motivo}`);
};
// Copia a árvore de migrations para dentro do cenário e, se k for
// informado, trunca o journal DA CÓPIA — isolado do repo.
const pastaMigrations = (c, k = null) => {
  const dest = join(c.dir, `migrations-${seq}-${k ?? "full"}`);
  cpSync(MIGRATIONS_SRC, dest, { recursive: true });
  if (k !== null) {
    const jp = join(dest, "meta", "_journal.json");
    const j = JSON.parse(readFileSync(jp, "utf8"));
    j.entries = j.entries.slice(0, k);
    writeFileSync(jp, JSON.stringify(j, null, 2));
  }
  return dest;
};
const migrar = (env) => spawnSync(process.execPath, [TSX, "servidor/src/db/migrate.ts"], {
  cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8", timeout: 120000,
});
// Conta "[db] conexao aberta" no stderr — com MESTRE_DEBUG_CONEXOES=1
// cada criarBanco() loga uma linha; 2 linhas = 2 conexões SQLite.
const conexoesAbertas = (r) => (String(r.stderr).match(/conexao aberta/g) || []).length;
const aplicadas = (banco) => {
  if (!existsSync(banco)) return -1;
  const s = new Database(banco, { readonly: true });
  try {
    const tem = s.prepare("select name from sqlite_master where type='table' and name='__drizzle_migrations'").get();
    return tem ? (s.prepare("select count(*) c from __drizzle_migrations").get()).c : 0;
  } finally { s.close(); }
};
const backupsPreUpdate = (dir) => {
  const base = join(dir, "backups");
  if (!existsSync(base)) return [];
  const achados = [];
  const varrer = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (existsSync(join(p, "manifesto.json"))) achados.push(p); varrer(p); }
    }
  };
  varrer(base);
  return achados;
};

try {
  sec("1. Instalação nova autorizada — sem backup, migra tudo");
  {
    const c = cenario();
    bootstrapar(c);
    c.env.MESTRE_MIGRATIONS_FOLDER = pastaMigrations(c);
    c.env.MESTRE_DEBUG_CONEXOES = "1";
    const r = migrar(c.env);
    t("exit 0", r.status === 0, `status=${r.status} stderr=${String(r.stderr).slice(-300)}`);
    t("todas as migrations aplicadas", aplicadas(c.env.MESTRE_BANCO) === totalJournal, `aplicadas=${aplicadas(c.env.MESTRE_BANCO)} total=${totalJournal}`);
    t("nenhum backup criado", backupsPreUpdate(c.dir).length === 0);
    t("conexão SQLite única", conexoesAbertas(r) === 1, `conexoes=${conexoesAbertas(r)}`);
  }

  sec("2. Migrations pendentes — backup antes de migrate");
  {
    const c = cenario();
    const K = 15;
    bootstrapar(c);
    c.env.MESTRE_MIGRATIONS_FOLDER = pastaMigrations(c, K);
    const r1 = migrar(c.env);
    t("fase 1 (journal truncado) exit 0", r1.status === 0, `status=${r1.status}`);
    t("fase 1 aplicou só K", aplicadas(c.env.MESTRE_BANCO) === K, `aplicadas=${aplicadas(c.env.MESTRE_BANCO)}`);
    // Troca para pasta com journal cheio — banco segue em K ⇒ pendência real
    c.env.MESTRE_MIGRATIONS_FOLDER = pastaMigrations(c);
    c.env.MESTRE_DEBUG_CONEXOES = "1";
    const antes = backupsPreUpdate(c.dir).length;
    const r2 = migrar(c.env);
    t("fase 2 (journal cheio) exit 0", r2.status === 0, `status=${r2.status} stderr=${String(r2.stderr).slice(-300)}`);
    t("backup pré-migration criado", backupsPreUpdate(c.dir).length === antes + 1, `backups=${backupsPreUpdate(c.dir).length}`);
    t("caminho backup usa conexão única", conexoesAbertas(r2) === 1, `conexoes=${conexoesAbertas(r2)}`);
    const man = backupsPreUpdate(c.dir).at(-1);
    t("manifesto presente no backup", !!man && existsSync(join(man, "manifesto.json")));
    t("todas as migrations aplicadas após", aplicadas(c.env.MESTRE_BANCO) === totalJournal);
    // journal versionado intacto
    t("journal versionado não foi tocado", readFileSync(join(MIGRATIONS_SRC, "meta", "_journal.json"), "utf8") === journalOriginal);
  }

  sec("3. Banco em dia — segundo boot não repete backup");
  {
    const c = cenario();
    bootstrapar(c);
    c.env.MESTRE_MIGRATIONS_FOLDER = pastaMigrations(c);
    const r1 = migrar(c.env);
    t("primeira migração ok", r1.status === 0);
    const antes = backupsPreUpdate(c.dir).length;
    const r2 = migrar(c.env);
    t("segunda migração exit 0", r2.status === 0);
    t("nenhum backup novo", backupsPreUpdate(c.dir).length === antes, `${antes} → ${backupsPreUpdate(c.dir).length}`);
  }

  sec("3B. Contagem completa com watermark antigo — backup ainda obrigatório");
  {
    const c = cenario();
    bootstrapar(c);
    const K = totalJournal - 1;
    c.env.MESTRE_MIGRATIONS_FOLDER = pastaMigrations(c, K);
    const r1 = migrar(c.env);
    t("base parcial legítima aplicada", r1.status === 0 && aplicadas(c.env.MESTRE_BANCO) === K,
      `status=${r1.status} aplicadas=${aplicadas(c.env.MESTRE_BANCO)}`);

    // Duplica uma entrada antiga: COUNT(*) agora iguala o tamanho do
    // journal completo, mas o maior created_at continua no penúltimo
    // timestamp. O Drizzle aplica a última migration mesmo assim; logo
    // o preflight precisa criar backup antes de invocar o migrator.
    const db = new Database(c.env.MESTRE_BANCO);
    let watermark: number | undefined;
    try {
      const ultima = db.prepare("select created_at from __drizzle_migrations order by created_at desc limit 1").get() as { created_at: number } | undefined;
      watermark = ultima?.created_at;
      if (watermark === undefined) throw new Error("watermark não encontrado na fixture");
      db.prepare("insert into __drizzle_migrations (hash, created_at) values (?, ?)").run("fixture-duplicata-antiga", watermark);
    } finally { db.close(); }

    t("contagem aparenta completa", aplicadas(c.env.MESTRE_BANCO) === totalJournal,
      `aplicadas=${aplicadas(c.env.MESTRE_BANCO)} total=${totalJournal}`);
    c.env.MESTRE_MIGRATIONS_FOLDER = pastaMigrations(c);
    const antes = backupsPreUpdate(c.dir).length;
    const r2 = migrar(c.env);
    const depois = backupsPreUpdate(c.dir);
    t("migração pendente executa", r2.status === 0 && aplicadas(c.env.MESTRE_BANCO) === totalJournal + 1,
      `status=${r2.status} aplicadas=${aplicadas(c.env.MESTRE_BANCO)}`);
    t("backup criado antes da migration", depois.length === antes + 1);
    const backupLog = String(r2.stdout).indexOf("Backup pré-migration criado e validado");
    const migrateLog = String(r2.stdout).indexOf("Migrações aplicadas");
    t("log comprova backup antes do migrate", backupLog >= 0 && migrateLog > backupLog,
      `backup=${backupLog} migrate=${migrateLog}`);
    const man = depois.at(-1);
    t("manifesto do backup presente", !!man && existsSync(join(man, "manifesto.json")));
  }

  sec("4. Backup falhando — zero migrations aplicadas");
  {
    const c = cenario();
    const K = 15;
    bootstrapar(c);
    c.env.MESTRE_MIGRATIONS_FOLDER = pastaMigrations(c, K);
    migrar(c.env);
    // Banco em K; troca para journal cheio + MESTRE_BACKUPS inválido
    c.env.MESTRE_MIGRATIONS_FOLDER = pastaMigrations(c);
    const bloqueio = join(c.dir, "backups-bloqueado");
    writeFileSync(bloqueio, "nao-e-diretorio");
    const env = { ...c.env, MESTRE_BACKUPS: bloqueio };
    const r = migrar(env);
    t("exit não-zero", r.status !== 0, `status=${r.status}`);
    t("zero migrations novas (segue em K)", aplicadas(c.env.MESTRE_BANCO) === K, `aplicadas=${aplicadas(c.env.MESTRE_BANCO)}`);
  }

  sec("5. Banco vazio SEM bootstrap provisionado — bloqueia");
  {
    const c = cenario();
    // nenhum provisionamento: state dir ausente → diagnóstico
    // "desconhecido" → migrate deve recusar (fail-closed)
    c.env.MESTRE_MIGRATIONS_FOLDER = pastaMigrations(c);
    const r = migrar(c.env);
    t("exit não-zero", r.status !== 0, `status=${r.status}`);
    t("banco NÃO foi criado", !existsSync(c.env.MESTRE_BANCO), c.env.MESTRE_BANCO);
    t("zero migrations aplicadas", aplicadas(c.env.MESTRE_BANCO) === -1);
  }

  sec("6. DB parcial (só __drizzle_migrations) — não é instalação nova");
  {
    const c = cenario();
    bootstrapar(c);
    c.env.MESTRE_MIGRATIONS_FOLDER = pastaMigrations(c);
    // Fabrica DB anômalo: migrations registradas, zero tabelas de
    // usuário — não pode seguir o fast-path de "vazio".
    mkdirSync(dirname(c.env.MESTRE_BANCO), { recursive: true });
    const s = new Database(c.env.MESTRE_BANCO);
    s.exec("create table __drizzle_migrations (id integer primary key, hash text not null, created_at numeric)");
    const ins = s.prepare("insert into __drizzle_migrations (hash, created_at) values (?,?)");
    for (let i = 0; i < 5; i++) ins.run(`hash-${i}`, Date.now());
    s.close();
    const r = migrar(c.env);
    t("exit não-zero (bloqueado ou backup falhou fechado)", r.status !== 0, `status=${r.status} stderr=${String(r.stderr).slice(-300)}`);
    t("migrations NÃO avançaram", aplicadas(c.env.MESTRE_BANCO) === 5, `aplicadas=${aplicadas(c.env.MESTRE_BANCO)}`);
  }

  sec("7. Recibo de instalação concluída + DB vazio — banco PERDIDO, bloqueia");
  {
    const c = cenario();
    // Recibo permanente prova que a instalação existiu; banco vazio
    // aqui é perda — migrate NÃO pode recriar schema vazio.
    gravarReciboInstalacao(ROOT, c.env);
    c.env.MESTRE_MIGRATIONS_FOLDER = pastaMigrations(c);
    const r = migrar(c.env);
    t("exit não-zero", r.status !== 0, `status=${r.status} stderr=${String(r.stderr).slice(-300)}`);
    t("banco NÃO foi recriado", !existsSync(c.env.MESTRE_BANCO), c.env.MESTRE_BANCO);
  }

  sec("8. DB 0 bytes + bootstrap autorizado — classe vazio, migra");
  {
    const c = cenario();
    bootstrapar(c); // banco ainda ausente — autorização exige ausência
    mkdirSync(dirname(c.env.MESTRE_BANCO), { recursive: true });
    writeFileSync(c.env.MESTRE_BANCO, ""); // 0 bytes APÓS autorizar
    c.env.MESTRE_MIGRATIONS_FOLDER = pastaMigrations(c);
    const r = migrar(c.env);
    t("exit 0", r.status === 0, `status=${r.status} stderr=${String(r.stderr).slice(-300)}`);
    t("todas as migrations aplicadas", aplicadas(c.env.MESTRE_BANCO) === totalJournal);
    t("nenhum backup criado", backupsPreUpdate(c.dir).length === 0);
  }

  sec("9. SQLite válido sem tabelas + bootstrap — classe vazio, migra");
  {
    const c = cenario();
    bootstrapar(c);
    mkdirSync(dirname(c.env.MESTRE_BANCO), { recursive: true });
    const s = new Database(c.env.MESTRE_BANCO);
    s.exec("create table _t(x); drop table _t"); // sqlite válido, zero tabelas
    s.close();
    c.env.MESTRE_MIGRATIONS_FOLDER = pastaMigrations(c);
    const r = migrar(c.env);
    t("exit 0", r.status === 0, `status=${r.status} stderr=${String(r.stderr).slice(-300)}`);
    t("todas as migrations aplicadas", aplicadas(c.env.MESTRE_BANCO) === totalJournal);
    t("nenhum backup criado", backupsPreUpdate(c.dir).length === 0);
  }

  sec("10. DB 0 bytes SEM bootstrap — bloqueia como vazio não reconhecido");
  {
    const c = cenario();
    mkdirSync(dirname(c.env.MESTRE_BANCO), { recursive: true });
    writeFileSync(c.env.MESTRE_BANCO, "");
    c.env.MESTRE_MIGRATIONS_FOLDER = pastaMigrations(c);
    const r = migrar(c.env);
    t("exit não-zero", r.status !== 0, `status=${r.status}`);
    t("zero migrations", aplicadas(c.env.MESTRE_BANCO) === 0);
  }
} finally {
  rmSync(BASE, { recursive: true, force: true });
}

console.log(`\n${pass} ok / ${fail} falhas`);
process.exit(fail ? 1 : 0);
