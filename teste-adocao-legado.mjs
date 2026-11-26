// Adoção assistida de instalação legada 1.0.8 → 1.0.9 (Issue #274).
// Cobre scripts/adotar-legado.mjs e o novo exit 11 de avaliar-boot.mjs:
// fixture de banco 1.0.8 REAL (34 migrations do journal truncado),
// integridade, esquema exato, backup validado, recibo, idempotência,
// retomada de journal e rejeições fail-closed. Roda em qualquer SO —
// o BAT/cmd.exe é coberto por teste-bat-adocao-legado.mjs (Windows).
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import {
  avaliarCandidatoAdocaoLegada, gravarEstado, lerJournal,
  lerReciboInstalacao,
} from "./scripts/estado-externo.mjs";

let pass = 0, fail = 0;
const t = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  ok", name); }
  else { fail++; console.error("  FALHOU", name, detail); }
};
const ROOT = process.cwd();
const SCRIPTS_NECESSARIOS = [
  "adotar-legado.mjs", "estado-externo.mjs", "boot-lock.mjs",
  "autorizar-bootstrap.mjs", "avaliar-boot.mjs",
  "protocolo-auto-update.json",
];
// Stub do auto-update: avaliar-boot.mjs importa recuperarAtualizacaoPendente
// antes do diagnóstico. O sentinela respeita o contrato de módulo e não
// executa nada — a fixture nunca chega ao updater.
const AUTO_UPDATE_STUB = `export async function recuperarAtualizacaoPendente() {\n  return { ok: true, recuperado: false, motivo: "fixture-sem-journal" };\n}\n`;
const MIGRATIONS = join(ROOT, "servidor", "migrations");
const ULTIMO_IDX_108 = 33;
const ULTIMO_IDX_109 = 35; // 1.0.9: 36 migrations, idx 0..35 (0034/0035 = seeds novidades)

function sha256(caminho) {
  return createHash("sha256").update(readFileSync(caminho)).digest("hex");
}

/** Monta uma "instalação" fixture DENTRO do repo (resolução de
 *  better-sqlite3 sobe até o node_modules da raiz) com banco no esquema
 *  1.0.8 exato: journal truncado nas 34 primeiras entradas. */
async function fixtureLegada(nome, { dados = true, bancoRel = "banco/mestre-rpg.db", ultimoIdx = ULTIMO_IDX_108, popular = null } = {}) {
  const dir = mkdtempSync(join(ROOT, `.tmp-adocao-${nome}-`));
  const app = join(dir, "instalacao legada");
  mkdirSync(join(app, "scripts"), { recursive: true });
  mkdirSync(join(app, "servidor", "migrations", "meta"), { recursive: true });
  for (const s of SCRIPTS_NECESSARIOS) {
    cpSync(join(ROOT, "scripts", s), join(app, "scripts", s));
  }
  writeFileSync(join(app, "scripts", "auto-update.mjs"), AUTO_UPDATE_STUB);
  cpSync(join(MIGRATIONS, "meta", "_journal.json"),
    join(app, "servidor", "migrations", "meta", "_journal.json"));

  const stateDir = join(dir, "state");
  const banco = join(dir, ...bancoRel.split("/"));
  mkdirSync(dirname(banco), { recursive: true });

  // Migrations do esquema alvo: entradas do journal até ultimoIdx.
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8"));
  const antigas = journal.entries.filter((e) => e.idx <= ultimoIdx);
  const pastaAntigas = join(dir, "migrations-108");
  mkdirSync(join(pastaAntigas, "meta"), { recursive: true });
  for (const e of antigas) {
    cpSync(join(MIGRATIONS, `${e.tag}.sql`), join(pastaAntigas, `${e.tag}.sql`));
  }
  writeFileSync(join(pastaAntigas, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: antigas }));

  {
    const sqlite = new Database(banco);
    sqlite.pragma("journal_mode = WAL");
    await migrate(drizzle(sqlite), { migrationsFolder: pastaAntigas });
    const agora = Date.now();
    if (dados) {
      sqlite.prepare("insert into users (id,username,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,1,'ativo',?,?)")
        .run("u-legado-1", "mestre_legado", "x", agora, agora);
      sqlite.prepare("insert into campaigns (id,name,status,owner_id,settings,created_at,updated_at) values (?,?,?,?,?,?,?)")
        .run("c-legado-1", "Campanha 1.0.8", "andamento", "u-legado-1", "{}", agora, agora);
    }
    if (popular) popular(sqlite, agora);
    sqlite.close();
  }

  // Dados de apoio: configuração e arquivos de campanha.
  mkdirSync(join(app, "configuracao"), { recursive: true });
  writeFileSync(join(app, "configuracao", "servidor.json"), JSON.stringify({ porta: 3199 }));
  const arquivos = join(dir, "arquivos", "campanhas", "legada");
  mkdirSync(arquivos, { recursive: true });
  writeFileSync(join(arquivos, "cenario.txt"), "cenario da campanha legada");

  const env = {
    ...process.env,
    MESTRE_STATE_DIR: stateDir,
    MESTRE_BANCO: banco,
    MESTRE_BACKUPS: join(dir, "backups"),
    MESTRE_ARQUIVOS: join(dir, "arquivos", "campanhas"),
  };
  return { dir, app, env, banco, stateDir };
}

function rodarAdocao(f, args = ["--confirmar"]) {
  return spawnSync("node", [join(f.app, "scripts", "adotar-legado.mjs"), ...args], {
    cwd: f.app, env: f.env, encoding: "utf8", timeout: 60000,
  });
}
function rodarPreflight(f) {
  return spawnSync("node", [join(f.app, "scripts", "avaliar-boot.mjs"), "preflight"], {
    cwd: f.app, env: f.env, encoding: "utf8", timeout: 30000,
  });
}
function contarPreAdocao(f) {
  const dirB = f.env.MESTRE_BACKUPS;
  return existsSync(dirB) ? readdirSync(dirB).filter((n) => n.startsWith("pre_adocao_")).length : 0;
}

console.log("== Adoção assistida de instalação legada (1.0.8 → 1.0.9) ==");

try {
  // --- diagnóstico sem flag: nada é escrito ---
  {
    const f = await fixtureLegada("dry");
    const r = rodarAdocao(f, []);
    t("sem --confirmar → exit 2", r.status === 2, `status=${r.status}`);
    t("sem flag → nenhum estado gravado",
      lerReciboInstalacao(f.app, f.env).status === "ausente"
      && lerJournal(f.app, "adocao-legado.json", f.env).status === "ausente"
      && contarPreAdocao(f) === 0);
    rmSync(f.dir, { recursive: true, force: true });
  }

  // --- caminho feliz: adoção completa ---
  {
    const f = await fixtureLegada("ok");
    const hashAntes = sha256(f.banco);
    const pre = rodarPreflight(f);
    t("preflight legado → exit 11", pre.status === 11, `status=${pre.status} ${pre.stderr}`);
    t("preflight legado → candidato adotável",
      avaliarCandidatoAdocaoLegada(f.app, f.env).adotavel === true);

    const r = rodarAdocao(f);
    t("adoção → exit 0", r.status === 0, `status=${r.status} ${r.stderr} ${r.stdout}`);
    const recibo = lerReciboInstalacao(f.app, f.env);
    t("recibo de instalação concluída gravado", recibo.status === "ok" && recibo.dados?.origem === "adocao-legado",
      JSON.stringify(recibo).slice(0, 200));
    const journal = lerJournal(f.app, "adocao-legado.json", f.env);
    t("journal de adoção fase concluida", journal.status === "ok" && journal.dados?.fase === "concluida");
    t("backup pre_adocao criado", contarPreAdocao(f) === 1);
    const manifestPath = join(f.env.MESTRE_BACKUPS,
      readdirSync(f.env.MESTRE_BACKUPS).find((n) => n.startsWith("pre_adocao_")), "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    t("manifest cobre banco+config+arquivos",
      manifest.arquivos.some((e) => e.destino.includes("mestre-rpg.db"))
      && manifest.arquivos.some((e) => e.destino.includes("servidor.json"))
      && manifest.arquivos.some((e) => e.destino.includes("cenario.txt")));
    t("banco fonte byte-idêntico após adoção", sha256(f.banco) === hashAntes);
    const db = new Database(f.banco, { readonly: true });
    t("dados preservados (users+campaigns)",
      db.prepare("select count(*) c from users").get().c === 1
      && db.prepare("select count(*) c from campaigns").get().c === 1);
    db.close();

    // idempotência
    const r2 = rodarAdocao(f);
    t("reexecução → exit 0 idempotente", r2.status === 0 && /já adotada/.test(r2.stdout), r2.stdout);
    t("reexecução → sem backup extra", contarPreAdocao(f) === 1);

    // após adoção, preflight reconhece instalação concluída
    const pre2 = rodarPreflight(f);
    t("preflight pós-adoção → exit 0", pre2.status === 0, `status=${pre2.status} ${pre2.stderr}`);
    rmSync(f.dir, { recursive: true, force: true });
  }

  // --- retomada: journal backup-ok pula etapa de backup ---
  {
    const f = await fixtureLegada("resume");
    const r1 = rodarAdocao(f);
    t("primeira adoção ok (setup retomada)", r1.status === 0);
    // Simula crash entre backup e recibo: remove recibo e volta o
    // journal para backup-ok.
    const dirEstado = join(f.stateDir, (await import("./scripts/boot-lock.mjs")).instalacaoId(f.app));
    rmSync(join(dirEstado, "instalacao-recibo.json"), { force: true });
    const jr = JSON.parse(readFileSync(join(dirEstado, "adocao-legado.json"), "utf8"));
    jr.fase = "backup-ok";
    writeFileSync(join(dirEstado, "adocao-legado.json"), JSON.stringify(jr, null, 2));
    const antes = contarPreAdocao(f);
    const r2 = rodarAdocao(f);
    t("retomada backup-ok → exit 0 sem refazer backup",
      r2.status === 0 && contarPreAdocao(f) === antes, `${r2.status} ${r2.stderr}`);
    t("retomada → recibo regravado", lerReciboInstalacao(f.app, f.env).status === "ok");
    rmSync(f.dir, { recursive: true, force: true });
  }

  // --- esquema desconhecido: fail-closed ---
  {
    const f = await fixtureLegada("esquema-x");
    {
      const db = new Database(f.banco);
      db.prepare("insert into __drizzle_migrations (hash, created_at) values ('adulterado', 1)").run();
      db.close();
    }
    const r = rodarAdocao(f);
    t("esquema adulterado → exit 1", r.status === 1, `status=${r.status}`);
    t("esquema adulterado → motivo correto", /esquema-nao-reconhecido/.test(r.stderr + r.stdout), r.stderr);
    t("esquema adulterado → sem recibo/backup",
      lerReciboInstalacao(f.app, f.env).status === "ausente" && contarPreAdocao(f) === 0);
    rmSync(f.dir, { recursive: true, force: true });
  }

  // --- banco não-SQLite: fail-closed ---
  {
    const f = await fixtureLegada("lixo", { dados: false });
    rmSync(f.banco, { force: true });
    writeFileSync(f.banco, "isto nao e um banco sqlite");
    const r = rodarAdocao(f);
    t("banco inválido → exit 1", r.status === 1, `status=${r.status}`);
    t("banco inválido → sem recibo", lerReciboInstalacao(f.app, f.env).status === "ausente");
    rmSync(f.dir, { recursive: true, force: true });
  }

  // --- Issue #320: MESTRE_BANCO com nome/caminho alternativo ---
  {
    const f = await fixtureLegada("nome-alt", { bancoRel: "dados-legado/legado-2024.db" });
    const r = rodarAdocao(f);
    t("banco nome alternativo → exit 0", r.status === 0, `status=${r.status} ${r.stderr} ${r.stdout}`);
    const dirB = readdirSync(f.env.MESTRE_BACKUPS).find((n) => n.startsWith("pre_adocao_"));
    const manifest = JSON.parse(readFileSync(join(f.env.MESTRE_BACKUPS, dirB, "manifest.json"), "utf8"));
    const entradaBanco = manifest.arquivos.find((e) => e.destino === join("banco", "legado-2024.db"));
    t("manifest aponta para o basename real", !!entradaBanco, JSON.stringify(manifest.arquivos));
    t("sha256 do manifesto confere com a cópia",
      entradaBanco && sha256(join(f.env.MESTRE_BACKUPS, dirB, "banco", "legado-2024.db")) === entradaBanco.sha256);
    const db = new Database(join(f.env.MESTRE_BACKUPS, dirB, "banco", "legado-2024.db"), { readonly: true });
    t("backup reaberto passa integrity_check",
      db.pragma("integrity_check", { simple: true }) === "ok");
    db.close();
    t("recibo gravado com nome alternativo", lerReciboInstalacao(f.app, f.env).status === "ok");
    rmSync(f.dir, { recursive: true, force: true });
  }

  // --- state dir com arquivo desconhecido: nem candidato ---
  {
    const f = await fixtureLegada("state-x");
    mkdirSync(f.stateDir, { recursive: true });
    // dirEstado = <MESTRE_STATE_DIR>/<instalacaoId>; descobre o id.
    const { instalacaoId } = await import("./scripts/boot-lock.mjs");
    const dirId = join(f.stateDir, instalacaoId(f.app));
    mkdirSync(dirId, { recursive: true });
    writeFileSync(join(dirId, "arquivo-estranho.json"), "{}");
    const pre = rodarPreflight(f);
    t("state ambíguo → preflight exit 1 (não oferece adoção)", pre.status === 1, `status=${pre.status}`);
    const r = rodarAdocao(f);
    t("state ambíguo → adoção exit 1", r.status === 1);
    rmSync(f.dir, { recursive: true, force: true });
  }

  // --- regressão 1.0.9 → schema atual (#328 / ordem 7155850015) ---
  // Fixture no schema EXATO da 1.0.9 (journal idx<=35 = 36 migrations)
  // com fixture financeira representativa: 3 contas + 6 transações
  // (account_id + request_id). Fluxo real: adotar-legado.mjs (backup
  // pre_adocao + recibo) → db/migrate.js do build (backup pré-migration
  // + migrations até 0037 + foreign_key_check) → preservação integral.
  {
    const f = await fixtureLegada("109", {
      ultimoIdx: ULTIMO_IDX_109,
      popular: (sqlite, agora) => {
        sqlite.prepare("insert into memberships (id,campaign_id,user_id,role,permissions,status,joined_at,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
          .run("m-109", "c-legado-1", "u-legado-1", "mestre", "{}", "ativo", agora, agora, agora);
        sqlite.prepare("insert into characters (id,campaign_id,membership_id,name,data,overrides,status,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
          .run("ch-109-1", "c-legado-1", "m-109", "Herói 109", "{}", "{}", "aprovada", agora, agora);
        sqlite.prepare("insert into characters (id,campaign_id,membership_id,name,data,overrides,status,created_at,updated_at) values (?,?,?,?,?,?,?,?,?)")
          .run("ch-109-2", "c-legado-1", "m-109", "Aliada 109", "{}", "{}", "aprovada", agora, agora);
        const insConta = sqlite.prepare("insert into financial_accounts (id,character_id,campaign_id,type,name,institution,agency,account_number,holder,currency,balance_cents,credit_limit_cents,data,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
        insConta.run("fin-109-a", "ch-109-1", "c-legado-1", "banco", "Conta Tesouro 109", "Banco Real", "0001", "11111-1", "Herói 109", "BRL", 250000, null, "{}", agora, agora);
        insConta.run("fin-109-b", "ch-109-1", "c-legado-1", "dinheiro", "Bolsa de Viagem", null, null, null, "Herói 109", "BRL", 45250, null, "{}", agora, agora);
        insConta.run("fin-109-c", "ch-109-2", "c-legado-1", "guilda", "Caixa da Guilda", "Guilda dos Ecos", "0002", "22222-2", "Aliada 109", "BRL", 900000, 50000, "{}", agora, agora);
        const insTx = sqlite.prepare("insert into money_transactions (id,character_id,campaign_id,kind,amount,currency,account,description,created_by,created_at,account_id,amount_cents,balance_before_cents,balance_after_cents,request_id) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
        const txs = [
          ["mtx-109-1", "ch-109-1", "saldo_inicial", 2500, "fin-109-a", 0, 250000, "req-109-01"],
          ["mtx-109-2", "ch-109-1", "entrada", 500.5, "fin-109-a", 250000, 300050, "req-109-02"],
          ["mtx-109-3", "ch-109-1", "saida", 49.75, "fin-109-b", 0, 45250, "req-109-03"],
          ["mtx-109-4", "ch-109-2", "saldo_inicial", 9000, "fin-109-c", 0, 900000, "req-109-04"],
          ["mtx-109-5", "ch-109-2", "entrada", 1250, "fin-109-c", 900000, 1025000, "req-109-05"],
          ["mtx-109-6", "ch-109-1", "saida", 300, "fin-109-a", 300050, 0, "req-109-06"],
        ];
        for (const [id, ch, kind, amount, conta, antes, depois, reqId] of txs) {
          insTx.run(id, ch, "c-legado-1", kind, amount, "BRL", "banco",
            `tx ${id} fixture 1.0.9`, "u-legado-1", agora, conta,
            Math.round(amount * 100), antes, depois, reqId);
        }
      },
    });

    // Normalização: remove colunas novas do rebuild 0036 (shop_id) e
    // ordena chaves — comparação exata dos campos legados.
    const norm = (row) => {
      const r = { ...row };
      delete r.shop_id;
      return JSON.stringify(r, Object.keys(r).sort());
    };
    const BASE109 = {};
    {
      const db = new Database(f.banco, { readonly: true });
      const nMig = db.prepare("select count(*) c from __drizzle_migrations").get().c;
      t("fixture 1.0.9: 36 migrations no journal", nMig === 36, String(nMig));
      BASE109.contas = db.prepare("select * from financial_accounts order by id").all().map(norm);
      BASE109.trans = db.prepare("select * from money_transactions order by id").all().map(norm);
      t("fixture 1.0.9: 3 contas + 6 transações semeadas",
        BASE109.contas.length === 3 && BASE109.trans.length === 6,
        `${BASE109.contas.length}/${BASE109.trans.length}`);
      db.close();
    }

    // Adoção real (backup pre_adocao + recibo + journal).
    const r109 = rodarAdocao(f);
    t("adoção 1.0.9 → exit 0", r109.status === 0, `status=${r109.status} ${r109.stderr} ${r109.stdout}`);
    t("adoção 1.0.9 → backup pre_adocao criado", contarPreAdocao(f) === 1);
    t("adoção 1.0.9 → recibo concluído", lerReciboInstalacao(f.app, f.env).status === "ok");

    // Backup pré-migration do migrate real: snapshot do diretório antes.
    const dirsBackupAntes = new Set(
      existsSync(f.env.MESTRE_BACKUPS) ? readdirSync(f.env.MESTRE_BACKUPS) : [],
    );

    // Migrate real — mesmo binário executado pelo boot do servidor.
    const m109 = spawnSync("node", [join(ROOT, "servidor", "dist", "db", "migrate.js")], {
      cwd: ROOT, env: f.env, encoding: "utf8", timeout: 120000,
    });
    t("migrate 1.0.9 → schema atual exit 0", m109.status === 0,
      `status=${m109.status} ${m109.stderr} ${m109.stdout}`.slice(0, 400));

    const db109 = new Database(f.banco, { readonly: true });
    const journal109 = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8"));
    const n109 = db109.prepare("select count(*) c from __drizzle_migrations").get().c;
    t("migrations completas até 0037", n109 === journal109.entries.length,
      `${n109} vs ${journal109.entries.length}`);
    const tabelasComercio = ["shops", "shop_managers", "shop_offers", "shop_orders"]
      .every((tb) => db109.prepare("select count(*) c from sqlite_master where type='table' and name=?").get(tb).c === 1);
    t("tabelas de comércio 0036/0037 criadas", tabelasComercio);

    // Preservação integral: mesmas linhas, mesmos campos legados,
    // shop_id NULL em todo o legado.
    const contas109 = db109.prepare("select * from financial_accounts order by id").all();
    const trans109 = db109.prepare("select * from money_transactions order by id").all();
    t("3 contas preservadas, shop_id NULL",
      contas109.length === 3 && contas109.every((r) => r.shop_id === null),
      JSON.stringify(contas109.map((r) => r.id)));
    t("campos legados das contas idênticos ao baseline",
      JSON.stringify(contas109.map(norm)) === JSON.stringify(BASE109.contas));
    t("6 transações preservadas, shop_id NULL",
      trans109.length === 6 && trans109.every((r) => r.shop_id === null),
      JSON.stringify(trans109.map((r) => r.id)));
    t("account_id/request_id e campos legados idênticos ao baseline",
      JSON.stringify(trans109.map(norm)) === JSON.stringify(BASE109.trans));
    t("foreign_key_check = 0 pós-migrate", db109.pragma("foreign_key_check").length === 0);
    t("integrity_check ok pós-migrate",
      db109.pragma("integrity_check")[0].integrity_check === "ok");
    db109.close();

    // Backup pré-migration criado pelo migrate é válido e íntegro
    // (falha segura do mesmo caminho: sem backup válido, migrate
    // aborta antes de tocar o banco — já coberto acima pelo exit 0).
    const dirsNovos = existsSync(f.env.MESTRE_BACKUPS)
      ? readdirSync(f.env.MESTRE_BACKUPS).filter((d) => !dirsBackupAntes.has(d)) : [];
    const dirPreMig = dirsNovos.find((d) => existsSync(join(f.env.MESTRE_BACKUPS, d, "mestre-rpg.db")));
    t("backup pré-migration criado pelo migrate", !!dirPreMig, dirsNovos.join(","));
    if (dirPreMig) {
      const bkp = new Database(join(f.env.MESTRE_BACKUPS, dirPreMig, "mestre-rpg.db"), { readonly: true });
      t("backup pré-migration íntegro (integrity_check + fixture intacta)",
        bkp.pragma("integrity_check", { simple: true }) === "ok"
        && bkp.prepare("select count(*) c from financial_accounts").get().c === 3
        && bkp.prepare("select count(*) c from money_transactions").get().c === 6);
      bkp.close();
    }
    rmSync(f.dir, { recursive: true, force: true });
  }
} finally {
  // Limpeza de fixtures remanescentes em caso de falha.
  for (const n of readdirSync(ROOT)) {
    if (n.startsWith(".tmp-adocao-")) rmSync(join(ROOT, n), { recursive: true, force: true });
  }
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
