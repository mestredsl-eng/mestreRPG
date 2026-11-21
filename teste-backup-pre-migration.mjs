// Testes do backup pré-migration (P10-B / Issue #155).
// Executa o migrate.ts REAL via tsx contra bancos temporários
// (MESTRE_BANCO/MESTRE_BACKUPS/MESTRE_ARQUIVOS/MESTRE_STATE_DIR) —
// prova ordem backup→migrate, bloqueio em falha e ausência de
// backup em instalação nova ou banco em dia. Journal é truncado e
// restaurado dentro do teste para fabricar "migrations pendentes"
// reais, nunca estado falso.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => {
  if (c) { pass++; console.log("  ok", n); }
  else { fail++; console.log("  FALHOU", n, extra); }
};
const sec = (n) => console.log("\n== " + n + " ==");

const ROOT = process.cwd();
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const JOURNAL_PATH = join(ROOT, "servidor", "migrations", "meta", "_journal.json");
const journalOriginal = readFileSync(JOURNAL_PATH, "utf8");
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
const migrar = (env) => spawnSync(process.execPath, [TSX, "servidor/src/db/migrate.ts"], {
  cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8", timeout: 120000,
});
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
const truncarJournal = (k) => {
  const j = JSON.parse(journalOriginal);
  j.entries = j.entries.slice(0, k);
  writeFileSync(JOURNAL_PATH, JSON.stringify(j, null, 2));
};

try {
  sec("1. Instalação nova — sem backup, migra tudo");
  {
    const c = cenario();
    const r = migrar(c.env);
    t("exit 0", r.status === 0, `status=${r.status} stderr=${String(r.stderr).slice(-300)}`);
    t("todas as migrations aplicadas", aplicadas(c.env.MESTRE_BANCO) === totalJournal, `aplicadas=${aplicadas(c.env.MESTRE_BANCO)} total=${totalJournal}`);
    t("nenhum backup criado", backupsPreUpdate(c.dir).length === 0);
  }

  sec("2. Migrations pendentes — backup antes de migrate");
  {
    const c = cenario();
    const K = 15;
    truncarJournal(K);
    const r1 = migrar(c.env);
    t("fase 1 (journal truncado) exit 0", r1.status === 0, `status=${r1.status}`);
    t("fase 1 aplicou só K", aplicadas(c.env.MESTRE_BANCO) === K, `aplicadas=${aplicadas(c.env.MESTRE_BANCO)}`);
    writeFileSync(JOURNAL_PATH, journalOriginal);
    const antes = backupsPreUpdate(c.dir).length;
    const r2 = migrar(c.env);
    t("fase 2 (journal cheio) exit 0", r2.status === 0, `status=${r2.status} stderr=${String(r2.stderr).slice(-300)}`);
    t("backup pré-migration criado", backupsPreUpdate(c.dir).length === antes + 1, `backups=${backupsPreUpdate(c.dir).length}`);
    const man = backupsPreUpdate(c.dir).at(-1);
    t("manifesto presente no backup", !!man && existsSync(join(man, "manifesto.json")));
    t("todas as migrations aplicadas após", aplicadas(c.env.MESTRE_BANCO) === totalJournal);
  }

  sec("3. Banco em dia — segundo boot não repete backup");
  {
    const c = cenario();
    const r1 = migrar(c.env);
    t("primeira migração ok", r1.status === 0);
    const antes = backupsPreUpdate(c.dir).length;
    const r2 = migrar(c.env);
    t("segunda migração exit 0", r2.status === 0);
    t("nenhum backup novo", backupsPreUpdate(c.dir).length === antes, `${antes} → ${backupsPreUpdate(c.dir).length}`);
  }

  sec("4. Backup falhando — zero migrations aplicadas");
  {
    const c = cenario();
    const K = 15;
    truncarJournal(K);
    migrar(c.env);
    writeFileSync(JOURNAL_PATH, journalOriginal);
    // MESTRE_BACKUPS aponta para um ARQUIVO — mkdir do backup falha
    const bloqueio = join(c.dir, "backups-bloqueado");
    writeFileSync(bloqueio, "nao-e-diretorio");
    const env = { ...c.env, MESTRE_BACKUPS: bloqueio };
    const r = migrar(env);
    t("exit não-zero", r.status !== 0, `status=${r.status}`);
    t("zero migrations novas (segue em K)", aplicadas(c.env.MESTRE_BANCO) === K, `aplicadas=${aplicadas(c.env.MESTRE_BANCO)}`);
  }
} finally {
  writeFileSync(JOURNAL_PATH, journalOriginal);
  rmSync(BASE, { recursive: true, force: true });
}

console.log(`\n${pass} ok / ${fail} falhas`);
process.exit(fail ? 1 : 0);
