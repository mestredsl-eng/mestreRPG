#!/usr/bin/env node
// FILHO — suíte preparada para a #380 (reconhecedor de schema fail-closed).
// Cobre os 6 pontos da ordem do Dono (13:30):
//   S1 LF/CRLF — hash sha256(readFileSync().toString()) aceita os dois
//      formatos canônicos; hash arbitrário bloqueia;
//   S2 when duplicado — created_at repetido em __drizzle_migrations;
//   S3 rowid fora de ordem — inserção fora da ordem cronológica;
//   S4 recibo stale — assinaturaSchema regravada após migrate;
//   S5 sentinela editável — dados legítimos do usuário NÃO bloqueiam;
//   S6 objeto extra — diagnóstico lista extras+ausentes sem mutar o banco.
//
// ADAPTADOR (contrato assumido — ajustar 1 linha se o PAI nomear diferente):
//   módulo `servidor/src/lib/schema-reconhecedor.ts` exportando
//   `reconhecerSchema(dbPath, migrationsDir) -> { ok, codigo?, motivos? }`.
//   Override por env: MESTRE_RECONHECEDOR_380=<path absoluto|relativo>.
// Sem o módulo implementado, os casos de reconhecedor FALHAM com
// "modulo ausente" — estado TDD correto até a PR de código da #380.
// Fixtures 100% descartáveis em os.tmpdir(); produção nunca é tocada.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
  readdirSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import {
  autorizarPrimeiroBootstrap, consumirAutorizacaoBootstrap, gravarProvisionamento,
} from "./scripts/estado-externo.mjs";
import {
  portaLivre, subirServidor, esperarSaudavel, encerrarServidor,
} from "./teste-base.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const MIGRATIONS_SRC = join(ROOT, "servidor", "migrations");
const MODULO = process.env.MESTRE_RECONHECEDOR_380
  ?? join(ROOT, "servidor", "src", "lib", "schema-reconhecedor.ts");

let pass = 0, fail = 0;
const t = (n, c, extra = "") => {
  if (c) { pass++; console.log("  ok", n); }
  else { fail++; console.log("  FALHOU", n, extra); }
};
const sec = (n) => console.log("\n== " + n + " ==");

const BASE = mkdtempSync(join(tmpdir(), "mestre-380-recon-"));
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
const bootstrapar = (c) => {
  gravarProvisionamento(ROOT, c.env);
  const a = autorizarPrimeiroBootstrap(ROOT, c.env);
  if (!a.autorizado) throw new Error(`bootstrap não autorizado: ${a.motivo}`);
};
const pastaMigrations = (c) => {
  const dest = join(c.dir, `migrations-${seq}`);
  cpSync(MIGRATIONS_SRC, dest, { recursive: true });
  return dest;
};
const migrar = (env) => spawnSync(process.execPath, [TSX, "servidor/src/db/migrate.ts"], {
  cwd: ROOT, env: { ...process.env, ...env }, encoding: "utf8", timeout: 120000,
});
const sha256arq = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

// ---------- golden DB: migrator real, 43 entradas ----------
let GOLDEN = null;
function golden() {
  if (GOLDEN) return GOLDEN;
  const c = cenario();
  bootstrapar(c);
  c.env.MESTRE_MIGRATIONS_FOLDER = pastaMigrations(c);
  const r = migrar(c.env);
  if (r.status !== 0) throw new Error(`golden migrate falhou: ${String(r.stderr).slice(-300)}`);
  GOLDEN = c.env.MESTRE_BANCO;
  return GOLDEN;
}
function copiaDb(dest) {
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(golden(), dest);
  for (const suf of ["-wal", "-shm", "-journal"]) {
    if (existsSync(golden() + suf)) cpSync(golden() + suf, dest + suf);
  }
  return dest;
}
function copiaMig(dest) {
  mkdirSync(dest, { recursive: true });
  cpSync(MIGRATIONS_SRC, dest, { recursive: true });
  return dest;
}
const sqlMigrations = () => readdirSync(MIGRATIONS_SRC).filter((f) => f.endsWith(".sql")).sort();
const comDb = (dbPath, fn) => {
  const db = new Database(dbPath);
  try { return fn(db); } finally { db.close(); }
};

// ---------- sonda do reconhecedor (adaptador) ----------
// Escreve um probe .ts descartável que importa o módulo configurado e
// imprime RESULT:<json>. Contrato: reconhecerSchema(db, migDir).
const PROBE = join(BASE, "probe-380.ts");
writeFileSync(PROBE, `
import { pathToFileURL } from "node:url";
const mod = await import(pathToFileURL(process.env.MESTRE_MOD_380!).href);
const fn = mod.reconhecerSchema ?? mod.default;
const r = await fn(process.argv[2], process.argv[3]);
console.log("RESULT:" + JSON.stringify(r ?? null));
`);
function verificar(dbPath, migDir, envExtra = {}) {
  if (!existsSync(MODULO)) {
    return { ok: null, erro: `modulo ausente: ${MODULO} (reconhecedor #380 ainda não implementado)` };
  }
  const r = spawnSync(process.execPath, [TSX, PROBE, dbPath, migDir], {
    cwd: ROOT,
    env: { ...process.env, MESTRE_MOD_380: pathToFileURL(resolve(MODULO)).href, ...envExtra },
    encoding: "utf8", timeout: 60000,
  });
  const m = String(r.stdout ?? "").match(/RESULT:(.*)/);
  if (!m) {
    return { ok: null, erro: `sonda falhou status=${r.status} stderr=${String(r.stderr).slice(-300)}` };
  }
  try { return JSON.parse(m[1]); } catch { return { ok: null, erro: "JSON inválido: " + m[1].slice(0, 200) }; }
}
try {
  sec("0. Baseline estático — journal e golden DB");
  {
    const j = JSON.parse(readFileSync(join(MIGRATIONS_SRC, "meta", "_journal.json"), "utf8"));
    const whens = j.entries.map((e) => e.when);
    t("journal: 43 entradas", j.entries.length === 43, `n=${j.entries.length}`);
    t("journal: when estritamente crescente e único (P1-2)",
      whens.every((w, i) => i === 0 || w > whens[i - 1]),
      JSON.stringify(whens.slice(0, 3)));
    const rows = comDb(golden(), (db) =>
      db.prepare("select created_at from __drizzle_migrations order by rowid").all().map((r) => Number(r.created_at)));
    t("golden: rowid order == when order (baseline)",
      rows.every((w, i) => i === 0 || w > rows[i - 1]), `n=${rows.length}`);
    t("golden: hash = sha256 do .sql correspondente",
      comDb(golden(), (db) => {
        const row = db.prepare("select hash from __drizzle_migrations order by rowid limit 1").get();
        const arq = join(MIGRATIONS_SRC, sqlMigrations()[0]);
        return row.hash === sha256arq(arq);
      }));
  }

  sec("1. LF/CRLF — hash canônico dual (P0-1/P0-2)");
  {
    const c = cenario();
    const mig = copiaMig(join(c.dir, "mig-crlf"));
    // Converte 0042 para LF — mesmo SQL, outro hash canônico previsto.
    const arq42 = sqlMigrations().at(-1);
    const p42 = join(mig, arq42);
    const conteudo = readFileSync(p42, "utf8").replace(/\r\n/g, "\n");
    writeFileSync(p42, conteudo);
    const hashLf = createHash("sha256").update(conteudo).digest("hex");
    const db = copiaDb(join(c.dir, "banco", "db-lf.db"));
    comDb(db, (d) => d.prepare(
      "update __drizzle_migrations set hash=? where rowid=(select max(rowid) from __drizzle_migrations)",
    ).run(hashLf));
    const v = verificar(db, mig);
    t("S1a: .sql LF com hash sha256(LF) é aceito (hash canônico)", v.ok === true, JSON.stringify(v).slice(0, 200));

    // Negativo: hash arbitrário (nem LF nem CRLF do arquivo) → bloqueio.
    const c2 = cenario();
    const mig2 = copiaMig(join(c2.dir, "mig"));
    const db2 = copiaDb(join(c2.dir, "banco", "db-forj.db"));
    comDb(db2, (d) => d.prepare(
      "update __drizzle_migrations set hash=? where rowid=(select max(rowid) from __drizzle_migrations)",
    ).run("0".repeat(64)));
    const v2 = verificar(db2, mig2);
    t("S1b: hash arbitrário bloqueia (hash-divergente)",
      v2.ok === false && /hash/i.test(String(v2.codigo ?? v2.erro ?? "")), JSON.stringify(v2).slice(0, 200));
  }

  sec("2. when duplicado em __drizzle_migrations");
  {
    const c = cenario();
    const mig = copiaMig(join(c.dir, "mig"));
    const db = copiaDb(join(c.dir, "banco", "db-when.db"));
    comDb(db, (d) => d.prepare(
      "update __drizzle_migrations set created_at=(select created_at from __drizzle_migrations order by rowid limit 1 offset 5) where rowid=(select max(rowid) from __drizzle_migrations)",
    ).run());
    const dup = comDb(db, (d) =>
      d.prepare("select created_at, count(*) c from __drizzle_migrations group by created_at having c>1").all().length);
    t("fixture: created_at duplicado presente", dup > 0, `dups=${dup}`);
    const v = verificar(db, mig);
    t("S2: when duplicado bloqueia",
      v.ok === false && /when|ordem|journal|divergente|incomplet/i.test(String(v.codigo ?? v.erro ?? "")),
      JSON.stringify(v).slice(0, 200));
  }

  sec("3. rowid fora de ordem (P1-1: posição = rowid, não created_at)");
  {
    const c = cenario();
    const mig = copiaMig(join(c.dir, "mig"));
    const db = copiaDb(join(c.dir, "banco", "db-rowid.db"));
    // Recria a tabela inserindo em ordem embaralhada — rowid deixa de
    // coincidir com a ordem cronológica dos whens.
    comDb(db, (d) => {
      d.exec(`create table __mig_tmp as select * from __drizzle_migrations`);
      d.exec(`delete from __drizzle_migrations`);
      const rows = d.prepare("select hash, created_at from __mig_tmp order by rowid").all();
      const embaralhado = [...rows];
      [embaralhado[10], embaralhado[11]] = [embaralhado[11], embaralhado[10]];
      const ins = d.prepare("insert into __drizzle_migrations (hash, created_at) values (?,?)");
      for (const r of embaralhado) ins.run(r.hash, r.created_at);
      d.exec(`drop table __mig_tmp`);
    });
    const ordemOk = comDb(db, (d) => {
      const ws = d.prepare("select created_at from __drizzle_migrations order by rowid").all().map((r) => Number(r.created_at));
      return ws.every((w, i) => i === 0 || w > ws[i - 1]);
    });
    t("fixture: rowid order ≠ when order", !ordemOk);
    const v = verificar(db, mig);
    t("S3: rowid fora de ordem bloqueia (comparação posicional)",
      v.ok === false, JSON.stringify(v).slice(0, 200));
  }

  sec("4. Recibo stale após migrate (P1-3)");
  {
    // Integração real: bootstrap → migrate parcial → migrate completo →
    // migrate de novo (idempotente). Recibo deve ser regravado com a
    // assinaturaSchema pós-migration e o segundo boot não pode bloquear.
    const c = cenario();
    bootstrapar(c);
    const migParcial = pastaMigrations(c);
    const jp = join(migParcial, "meta", "_journal.json");
    const j = JSON.parse(readFileSync(jp, "utf8"));
    j.entries = j.entries.slice(0, 40);
    writeFileSync(jp, JSON.stringify(j, null, 2));
    c.env.MESTRE_MIGRATIONS_FOLDER = migParcial;
    const r1 = migrar(c.env);
    t("migrate parcial exit 0", r1.status === 0, String(r1.stderr).slice(-200));
    c.env.MESTRE_MIGRATIONS_FOLDER = pastaMigrations(c);
    const r2 = migrar(c.env);
    t("migrate completo exit 0", r2.status === 0, String(r2.stderr).slice(-200));
    const r3 = migrar(c.env);
    t("migrate repetido exit 0 (sem bloqueio de recibo stale)", r3.status === 0,
      String(r3.stderr).slice(-250));
    // Consome a autorização (fluxo canônico do instalador/restore) →
    // estado "bootstrap-interrompido" até o boot gravar o recibo.
    const consumo = consumirAutorizacaoBootstrap(ROOT, c.env);
    t("S4: autorização de bootstrap consumida", consumo.autorizado === true,
      JSON.stringify(consumo).slice(0, 160));
    // Boot real: concluirBootstrapAposHealth grava o recibo quando o
    // servidor prova escuta (bancoComDados = tabelas presentes).
    const porta = await portaLivre();
    const proc = subirServidor(porta, { banco: c.env.MESTRE_BANCO, arquivos: c.env.MESTRE_ARQUIVOS, backups: c.env.MESTRE_BACKUPS, env: { MESTRE_STATE_DIR: c.env.MESTRE_STATE_DIR } });
    try {
      await esperarSaudavel(`http://127.0.0.1:${porta}`, proc, 90000);
      t("S4: primeiro boot saudável grava recibo", true);
    } catch (e) {
      t("S4: primeiro boot saudável grava recibo", false, String(e).slice(0, 300));
    } finally { await encerrarServidor(proc); }
    // Recibo deve carregar a assinaturaSchema do schema ATUAL (pós-0042).
    const { instalacaoId } = await import("./scripts/estado-externo.mjs");
    const reciboPath = join(c.env.MESTRE_STATE_DIR, instalacaoId(ROOT), "instalacao-recibo.json");
    if (existsSync(reciboPath)) {
      const recibo = JSON.parse(readFileSync(reciboPath, "utf8"));
      t("S4: recibo contém assinaturaSchema regravada",
        typeof recibo.assinaturaSchema === "string" && recibo.assinaturaSchema.length > 0,
        JSON.stringify(Object.keys(recibo)));
    } else {
      t("S4: recibo existe para inspeção", false, reciboPath);
    }
    // Segundo boot não pode bloquear por recibo stale.
    const porta2 = await portaLivre();
    const proc2 = subirServidor(porta2, { banco: c.env.MESTRE_BANCO, arquivos: c.env.MESTRE_ARQUIVOS, backups: c.env.MESTRE_BACKUPS, env: { MESTRE_STATE_DIR: c.env.MESTRE_STATE_DIR } });
    try {
      await esperarSaudavel(`http://127.0.0.1:${porta2}`, proc2, 90000);
      t("S4: segundo boot não bloqueia (recibo atualizado)", true);
    } catch (e) {
      t("S4: segundo boot não bloqueia (recibo atualizado)", false, String(e).slice(0, 300));
    } finally { await encerrarServidor(proc2); }
  }

  sec("5. Sentinela editável — dados do usuário não bloqueiam (P1-4)");
  {
    const c = cenario();
    const mig = copiaMig(join(c.dir, "mig"));
    const db = copiaDb(join(c.dir, "banco", "db-user.db"));
    // Mutações legítimas de dados de usuário — jamais prova estrutural.
    comDb(db, (d) => {
      const agora = Date.now();
      d.prepare("insert into users (id,username,display_name,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,?,0,'ativo',?,?)")
        .run("u-380s5", "usuario_380s5", "Original", "hash", agora, agora);
      d.prepare("update users set display_name=? where id=?").run("Nome Editado Pelo Usuário", "u-380s5");
      d.prepare("insert into server_settings (key, value, updated_at) values ('sonda_usuario','1',?)").run(agora);
    });
    const antes = sha256arq(db);
    const v = verificar(db, mig);
    t("S5: edição de dados do usuário NÃO bloqueia",
      v.ok === true, JSON.stringify(v).slice(0, 200));
    t("S5: diagnóstico não mutou o banco", sha256arq(db) === antes);
  }

  sec("6. Objeto extra — diagnóstico lista extras+ausentes, sem mutar (P1-5)");
  {
    const c = cenario();
    const mig = copiaMig(join(c.dir, "mig"));
    const db = copiaDb(join(c.dir, "banco", "db-extra.db"));
    comDb(db, (d) => {
      d.exec("create table z_sonda_extra_380 (id text primary key)");
      d.exec("alter table users add column sonda_col_extra_380 text");
    });
    const antes = sha256arq(db);
    const v = verificar(db, mig);
    const blob = JSON.stringify(v);
    t("S6: estrutura divergente bloqueia",
      v.ok === false && /estrutura|divergente|ausente/i.test(String(v.codigo ?? v.erro ?? "")),
      blob.slice(0, 200));
    t("S6: diagnóstico lista objeto extra (z_sonda_extra_380)",
      blob.includes("z_sonda_extra_380"), blob.slice(0, 300));
    t("S6: diagnóstico lista coluna extra (sonda_col_extra_380)",
      blob.includes("sonda_col_extra_380"), blob.slice(0, 300));
    t("S6: diagnóstico não mutou o banco", sha256arq(db) === antes);
  }

  console.log(`\n${pass} ok / ${fail} falhas`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("FALHA FATAL:", e);
  process.exit(1);
} finally {
  try { rmSync(BASE, { recursive: true, force: true }); } catch { /* best effort */ }
}
