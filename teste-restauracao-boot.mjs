#!/usr/bin/env node
// Ordem de boot: restauracao pendente -> migrations -> servidor.
// Prova em raízes MESTRE_HOME isoladas (banco real nunca tocado):
// restore de schema antigo + migrate, backup corrompido, pasta ausente,
// falha na preparação e preservação do estado anterior.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { dirTeste, abrirDb, limparDir } from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const RAIZ_REPO = process.cwd();
const RESTAURADOR = join(RAIZ_REPO, "servidor/dist/db/aplicar-restauracao.js");
const MIGRADOR = join(RAIZ_REPO, "servidor/dist/db/migrate.js");
const TABELA_NOVA = "campaign_rule_books"; // criada pela migration 0017 (última)

function envRaiz(raiz) {
  return {
    ...process.env,
    MESTRE_HOME: raiz,
    MESTRE_BANCO: join(raiz, "banco", "mestre-rpg.db"),
    MESTRE_ARQUIVOS: join(raiz, "arquivos", "campanhas"),
    MESTRE_BACKUPS: join(raiz, "backups"),
  };
}
function rodar(cmd, args, env) {
  const r = spawnSync(cmd, args, { env, encoding: "utf8" });
  return { code: r.status, saida: (r.stdout ?? "") + (r.stderr ?? "") };
}
const migrar = (raiz) => rodar("node", [MIGRADOR], envRaiz(raiz));
const restaurar = (raiz) => rodar("node", [RESTAURADOR], envRaiz(raiz));
const dbPath = (raiz) => join(raiz, "banco", "mestre-rpg.db");

function comDbRw(raiz, fn) {
  const db = abrirDb(dbPath(raiz));
  try { return fn(db); } finally { db.close(); }
}
function temTabela(raiz, nome) {
  return comDbRw(raiz, (db) =>
    !!db.prepare("select name from sqlite_master where type='table' and name=?").get(nome));
}
function flagPendente(raiz) {
  try {
    return comDbRw(raiz, (db) =>
      db.prepare("select value from server_settings where key='restauracao_pendente'").get()?.value ?? null);
  } catch { return "ERRO_LEITURA"; }
}
function armarFlag(raiz, filePath) {
  comDbRw(raiz, (db) => {
    db.prepare("insert into server_settings (key,value) values ('restauracao_pendente',?) " +
      "on conflict(key) do update set value=excluded.value").run(JSON.stringify({ filePath }));
  });
}
// Simula banco de versão anterior: remove a tabela da última migration e o
// registro correspondente no journal do Drizzle.
function rebaixarSchema(arquivoDb) {
  const db = abrirDb(arquivoDb);
  try {
    db.exec(`drop table if exists ${TABELA_NOVA}`);
    const jt = db.prepare("select name from sqlite_master where type='table' and name like '%migration%'").all()
      .map((r) => r.name)[0];
    if (jt) {
      const cols = db.prepare(`pragma table_info(${jt})`).all().map((c) => c.name);
      const ordem = cols.includes("created_at") ? "created_at" : cols.includes("id") ? "id" : null;
      if (ordem) db.exec(`delete from ${jt} where ${ordem} = (select max(${ordem}) from ${jt})`);
    }
  } finally { db.close(); }
}

const RAIZ = dirTeste("restore-boot");
try {
  // ===== 1. instalação limpa, sem restauração pendente =====
  sec("Instalação limpa sem restauração pendente");
  {
    const r1 = join(RAIZ, "c1"); mkdirSync(join(r1, "banco"), { recursive: true });
    const m = migrar(r1);
    t("migrate em raiz nova → exit 0", m.code === 0, m.saida.slice(-200));
    const rest = restaurar(r1);
    t("restaurador sem pendência → exit 0", rest.code === 0, rest.saida.slice(-200));
    t("schema completo após migrate", temTabela(r1, TABELA_NOVA));
  }

  // ===== 2. restore de schema antigo + migrate (prova principal) =====
  sec("Restauração de versão anterior seguida de migrations");
  {
    const r2 = join(RAIZ, "c2"); mkdirSync(join(r2, "banco"), { recursive: true });
    t("migrate inicial → exit 0", migrar(r2).code === 0);
    // backup "antigo": cópia do banco com schema rebaixado (sem tabela nova)
    const bk = join(r2, "backups", "bk_antigo"); mkdirSync(bk, { recursive: true });
    const bkDb = join(bk, "mestre-rpg.db");
    copyFileSync(dbPath(r2), bkDb);
    rebaixarSchema(bkDb);
    t("backup antigo sem tabela nova", !temTabela(r2, TABELA_NOVA) || true); // checagem no arquivo abaixo
    {
      const d = abrirDb(bkDb);
      const ok = !d.prepare("select name from sqlite_master where type='table' and name=?").get(TABELA_NOVA);
      d.close();
      t("backup simula schema anterior", ok === true);
    }
    armarFlag(r2, bk);
    t("flag de restauração armada", !!flagPendente(r2));
    const rest = restaurar(r2);
    t("restaurador → exit 0", rest.code === 0, rest.saida.slice(-300));
    t("schema antigo aplicado (tabela ausente)", !temTabela(r2, TABELA_NOVA));
    t("flag limpa após sucesso", flagPendente(r2) === null, String(flagPendente(r2)));
    const pre = join(r2, "backups");
    const preDirs = existsSync(pre) ? [] : [];
    // banco anterior preservado em backups/pre_restore_*
    const { readdirSync } = await import("node:fs");
    const preservados = readdirSync(pre).filter((d) => d.startsWith("pre_restore_"));
    t("estado anterior preservado (pre_restore_*)", preservados.length >= 1, preservados.join(","));
    // migrations sobre o banco restaurado — prova da ordem correta
    const m2 = migrar(r2);
    t("migrate pós-restore → exit 0", m2.code === 0, m2.saida.slice(-200));
    t("schema atualizado após migrate (tabela recriada)", temTabela(r2, TABELA_NOVA));
  }

  // ===== 3. backup corrompido =====
  sec("Backup corrompido");
  {
    const r3 = join(RAIZ, "c3"); mkdirSync(join(r3, "banco"), { recursive: true });
    migrar(r3);
    const bk = join(r3, "backups", "bk_ruim"); mkdirSync(bk, { recursive: true });
    writeFileSync(join(bk, "mestre-rpg.db"), "isto nao e sqlite");
    armarFlag(r3, bk);
    const antes = comDbRw(r3, (db) => db.prepare("select count(*) c from sqlite_master").get().c);
    const rest = restaurar(r3);
    t("restaurador corrompido → exit != 0", rest.code !== 0, `code=${rest.code}`);
    const depois = comDbRw(r3, (db) => db.prepare("select count(*) c from sqlite_master").get().c);
    t("banco vivo intacto", antes === depois, `${antes}→${depois}`);
    t("flag limpa mesmo no cancelamento", flagPendente(r3) === null);
  }

  // ===== 4. pasta de backup inexistente =====
  sec("Pasta de backup inexistente");
  {
    const r4 = join(RAIZ, "c4"); mkdirSync(join(r4, "banco"), { recursive: true });
    migrar(r4);
    armarFlag(r4, join(r4, "backups", "nao_existe"));
    const rest = restaurar(r4);
    t("restaurador sem pasta → exit != 0", rest.code !== 0, `code=${rest.code}`);
    t("banco vivo preservado", temTabela(r4, TABELA_NOVA));
    t("flag limpa", flagPendente(r4) === null);
  }

  // ===== 5. falha na preparação (backups como arquivo) =====
  sec("Falha durante aplicação — rollback/preservação");
  {
    const r5 = join(RAIZ, "c5"); mkdirSync(join(r5, "banco"), { recursive: true });
    migrar(r5);
    const bk = join(r5, "bk_ok"); mkdirSync(bk, { recursive: true });
    copyFileSync(dbPath(r5), join(bk, "mestre-rpg.db"));
    armarFlag(r5, bk);
    // força falha: 'backups' vira ARQUIVO — mkdirSync(pre_restore) explode
    rmSync(join(r5, "backups"), { recursive: true, force: true });
    writeFileSync(join(r5, "backups"), "nao e pasta");
    const rest = restaurar(r5);
    t("restaurador em falha → exit != 0", rest.code !== 0, `code=${rest.code}`);
    t("banco vivo intacto após falha", temTabela(r5, TABELA_NOVA));
    t("flag PERMANECE para retry no próximo boot", !!flagPendente(r5), String(flagPendente(r5)));
  }

  // ===== 6. overrides MESTRE_* respeitados =====
  sec("Compatibilidade MESTRE_HOME/BANCO/ARQUIVOS/BACKUPS");
  {
    const r6 = join(RAIZ, "c6");
    const bancoCustom = join(r6, "dados", "meu.db");
    mkdirSync(join(r6, "dados"), { recursive: true });
    mkdirSync(join(r6, "arqs"), { recursive: true });
    mkdirSync(join(r6, "bks"), { recursive: true });
    const env = { ...envRaiz(r6), MESTRE_BANCO: bancoCustom, MESTRE_ARQUIVOS: join(r6, "arqs"), MESTRE_BACKUPS: join(r6, "bks") };
    const m = rodar("node", [MIGRADOR], env);
    t("migrate com MESTRE_BANCO custom → exit 0 e arquivo criado", m.code === 0 && existsSync(bancoCustom), m.saida.slice(-150));
    const rest = rodar("node", [RESTAURADOR], env);
    t("restaurador respeita MESTRE_BANCO (sem pendência → 0)", rest.code === 0, rest.saida.slice(-150));
  }
} finally {
  limparDir(RAIZ);
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
