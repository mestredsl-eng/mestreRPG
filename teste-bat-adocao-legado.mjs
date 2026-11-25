// P0 #274 — homologação da adoção assistida de instalação legada pelo
// BAT real (cmd.exe). Fixture = instalação 1.0.8 autêntica: banco com
// as 34 migrations do journal truncado + dados, sem nenhum artefato do
// protocolo novo. Prova o fluxo completo S/N/inválido/EOF/ambíguo e a
// ordem lock → preflight(exit 11) → consentimento → adotar-legado →
// validar → auto-update sentinela. Nunca toca instalação real.
import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { instalacaoId } from "./scripts/boot-lock.mjs";
import {
  lerJournal, lerReciboInstalacao,
} from "./scripts/estado-externo.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  ok", name); }
  else { fail++; console.error("  FALHOU", name, detail); }
};
const ROOT = process.cwd();
const BAT = join(ROOT, "iniciar-mestre-rpg.bat");
const TEMP = mkdtempSync(join(ROOT, ".tmp-bat-adocao-"));
const MIGRATIONS = join(ROOT, "servidor", "migrations");
const ULTIMO_IDX_108 = 33;
const SCRIPTS = [
  "boot-lock.mjs", "estado-externo.mjs", "autorizar-bootstrap.mjs",
  "avaliar-boot.mjs", "adotar-legado.mjs", "protocolo-auto-update.json",
];

function sha256(caminho) {
  return createHash("sha256").update(readFileSync(caminho)).digest("hex");
}

/** Fixture de instalação 1.0.8 real dentro do repo (resolução de
 *  better-sqlite3). Retorna caminhos e env isolados. */
async function fixture(nome) {
  const dir = join(TEMP, nome);
  const app = join(dir, "instalacao com espacos");
  const scripts = join(app, "scripts");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(join(app, "servidor", "migrations", "meta"), { recursive: true });
  copyFileSync(BAT, join(app, "iniciar-mestre-rpg.bat"));
  for (const s of SCRIPTS) copyFileSync(join(ROOT, "scripts", s), join(scripts, s));
  copyFileSync(join(MIGRATIONS, "meta", "_journal.json"),
    join(app, "servidor", "migrations", "meta", "_journal.json"));

  const log = join(dir, "chamadas.log");
  const preload = join(dir, "preload.cjs");
  const updateMarker = join(dir, "auto-update-invocado.flag");
  writeFileSync(preload, [
    'const fs = require("node:fs");',
    'const p = process.env.MESTRE_BOOT_TEST_LOG;',
    'if (p) fs.appendFileSync(p, "node " + process.argv.slice(1).join(" ") + "\\n");',
    "",
  ].join("\n"));
  const autoUpdateStub = String.raw`import { writeFileSync } from "node:fs";
export async function recuperarAtualizacaoPendente() {
  return { ok: true, recuperado: false, motivo: "fixture-sem-journal" };
}
if ((process.argv[1] ?? "").toLowerCase().endsWith("auto-update.mjs")) {
  writeFileSync(process.env.MESTRE_BOOT_TEST_UPDATE_MARKER, "called");
  console.log("[sentinela] auto-update alcançado");
  process.exit(1);
}
`;
  writeFileSync(join(scripts, "auto-update.mjs"), autoUpdateStub);

  // Banco 1.0.8: 34 migrations + dados reais.
  const stateDir = join(dir, "state");
  const banco = join(dir, "banco", "mestre-rpg.db");
  mkdirSync(dirname(banco), { recursive: true });
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, "meta", "_journal.json"), "utf8"));
  const antigas = journal.entries.filter((e) => e.idx <= ULTIMO_IDX_108);
  const pastaAntigas = join(dir, "migrations-108");
  mkdirSync(join(pastaAntigas, "meta"), { recursive: true });
  for (const e of antigas) {
    copyFileSync(join(MIGRATIONS, `${e.tag}.sql`), join(pastaAntigas, `${e.tag}.sql`));
  }
  writeFileSync(join(pastaAntigas, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries: antigas }));
  {
    const sqlite = new Database(banco);
    sqlite.pragma("journal_mode = WAL");
    await migrate(drizzle(sqlite), { migrationsFolder: pastaAntigas });
    const agora = Date.now();
    sqlite.prepare("insert into users (id,username,password_hash,is_admin,status,created_at,updated_at) values (?,?,?,1,'ativo',?,?)")
      .run("u-bat-legado", "mestre_legado", "x", agora, agora);
    sqlite.prepare("insert into campaigns (id,name,status,owner_id,settings,created_at,updated_at) values (?,?,?,?,?,?,?)")
      .run("c-bat-legado", "Campanha Legada", "andamento", "u-bat-legado", "{}", agora, agora);
    sqlite.close();
  }
  mkdirSync(join(app, "configuracao"), { recursive: true });
  writeFileSync(join(app, "configuracao", "servidor.json"), JSON.stringify({ porta: 3299 }));
  const arquivos = join(dir, "arquivos", "campanhas", "legada");
  mkdirSync(arquivos, { recursive: true });
  writeFileSync(join(arquivos, "mapa.txt"), "mapa legado");

  const env = {
    ...process.env,
    PATH: dirname(process.execPath) + ";" + (process.env.PATH || ""),
    NODE_OPTIONS: "--require=" + preload.replace(/\\/g, "/"),
    MESTRE_BOOT_TEST_LOG: log,
    MESTRE_BOOT_TEST_UPDATE_MARKER: updateMarker,
    MESTRE_STATE_DIR: stateDir,
    MESTRE_BANCO: banco,
    MESTRE_BACKUPS: join(dir, "backups"),
    MESTRE_ARQUIVOS: join(dir, "arquivos", "campanhas"),
    MESTRE_PORTA: "3299",
  };
  return { dir, app, env, banco, stateDir, log, updateMarker };
}

function executar(f, input) {
  const comspec = process.env.ComSpec || "cmd.exe";
  writeFileSync(f.log, "");
  const run = spawnSync(comspec, ["/d", "/c", "iniciar-mestre-rpg.bat"], {
    cwd: f.app, env: f.env, input, encoding: "utf8", timeout: 60000, windowsHide: true,
  });
  let out = "";
  try { out = readFileSync(f.log, "utf8"); } catch {}
  const saida = String(run.stdout ?? "") + "\n" + String(run.stderr ?? "");
  return { run, out, saida };
}
const pos = (s, re) => { const m = re.exec(s); return m ? m.index : -1; };
const tem = (s, re) => re.test(s);
function semEfeitosAdocao(f, out) {
  return lerReciboInstalacao(f.app, f.env).status === "ausente"
    && lerJournal(f.app, "adocao-legado.json", f.env).status === "ausente"
    && !existsSync(f.env.MESTRE_BACKUPS)
    && !existsSync(f.updateMarker)
    && !tem(out, /adotar-legado\.mjs|auto-update\.mjs|db:migrate|npm run start/i);
}
function estadoDirId(f) {
  return join(f.stateDir, instalacaoId(f.app));
}

try {
  if (process.platform !== "win32") {
    console.log("Este teste exige cmd.exe e é executado no job Auto-update — Windows.");
    process.exitCode = 2;
  } else {
    console.log("== Adoção de instalação legada 1.0.8 pelo BAT / cmd.exe ==");

    // S: adoção executa, backup+recibo gravados, updater alcançado depois.
    {
      const f = await fixture("confirma-S");
      const hashAntes = sha256(f.banco);
      const r = executar(f, "S\r\nx\r\n");
      const iLock = pos(r.out, /boot-lock\.mjs adquirir/i);
      const iPre = pos(r.out, /avaliar-boot\.mjs preflight/i);
      const iAdocao = pos(r.out, /adotar-legado\.mjs --confirmar/i);
      const iValidar = pos(r.out, /avaliar-boot\.mjs validar/i);
      const iUpdate = pos(r.out, /auto-update\.mjs/i);
      check("S: cmd.exe terminou sem timeout", !r.run.error || r.run.error.code !== "ETIMEDOUT", r.run.error?.message ?? "");
      check("S: prompt de adoção exibido", /Adotar esta instalacao existente\? \[S\/N\]/i.test(r.saida), r.saida.slice(-1200));
      check("S: ordem lock → preflight → adoção → validar → updater",
        iLock >= 0 && iPre > iLock && iAdocao > iPre && iValidar > iAdocao && iUpdate > iValidar,
        `lock=${iLock} pre=${iPre} adocao=${iAdocao} validar=${iValidar} update=${iUpdate}`);
      check("S: recibo de instalação concluída gravado", lerReciboInstalacao(f.app, f.env).status === "ok");
      check("S: journal de adoção concluida", lerJournal(f.app, "adocao-legado.json", f.env).dados?.fase === "concluida");
      const backups = readdirSync(f.env.MESTRE_BACKUPS).filter((n) => n.startsWith("pre_adocao_"));
      check("S: backup pre_adocao criado", backups.length === 1, backups.join(","));
      const manifest = JSON.parse(readFileSync(join(f.env.MESTRE_BACKUPS, backups[0], "manifest.json"), "utf8"));
      check("S: manifest cobre banco+config+arquivos",
        manifest.arquivos.some((e) => e.destino.includes("mestre-rpg.db"))
        && manifest.arquivos.some((e) => e.destino.includes("servidor.json"))
        && manifest.arquivos.some((e) => e.destino.includes("mapa.txt")));
      check("S: banco fonte byte-idêntico", sha256(f.banco) === hashAntes);
      check("S: updater alcançado (sentinela aborta depois)", existsSync(f.updateMarker));
      check("S: falha sentinela abortou antes de restore/migrate/start",
        !tem(r.out, /aplicar-restauracao\.js|db:migrate|npm run start/i));
      const db = new Database(f.banco, { readonly: true });
      check("S: dados 1.0.8 preservados",
        db.prepare("select count(*) c from users").get().c === 1
        && db.prepare("select count(*) c from campaigns").get().c === 1);
      db.close();
      rmSync(f.dir, { recursive: true, force: true });
    }

    // N: recusa explícita — nada é gravado, banco intacto.
    {
      const f = await fixture("recusa-N");
      const hashAntes = sha256(f.banco);
      const r = executar(f, "N\r\n");
      check("N: recusou e terminou com erro", r.run.status !== 0 && r.run.status !== null, `status=${r.run.status}`);
      check("N: nenhum efeito de adoção", semEfeitosAdocao(f, r.out), r.out.slice(-1000));
      check("N: banco byte-idêntico", sha256(f.banco) === hashAntes);
      check("N: lock liberado", tem(r.out, /boot-lock\.mjs liberar/i), r.out);
      rmSync(f.dir, { recursive: true, force: true });
    }

    // Inválido → repete; N subsequente recusa sem efeito.
    {
      const f = await fixture("invalida-N");
      const r = executar(f, "X\r\nN\r\n");
      check("inválida: aviso e nova pergunta",
        /Resposta invalida/i.test(r.saida)
        && (r.saida.match(/Adotar esta instalacao existente\?/gi) ?? []).length >= 2, r.saida.slice(-1200));
      check("inválida→N: nenhum efeito", semEfeitosAdocao(f, r.out), r.out);
      rmSync(f.dir, { recursive: true, force: true });
    }

    // EOF: fail-closed após 3 entradas vazias.
    {
      const f = await fixture("eof");
      const r = executar(f, "");
      check("EOF: terminou sem timeout", !r.run.error || r.run.error.code !== "ETIMEDOUT", r.run.error?.message ?? "");
      check("EOF: abortou fail-closed", r.run.status !== 0 && /Entrada terminou/i.test(r.saida), r.saida.slice(-800));
      check("EOF: zero efeitos de adoção", semEfeitosAdocao(f, r.out), r.out);
      rmSync(f.dir, { recursive: true, force: true });
    }

    // State dir ambíguo: nem oferece adoção — bloqueio direto.
    {
      const f = await fixture("state-ambiguo");
      const dirId = estadoDirId(f);
      mkdirSync(dirId, { recursive: true });
      writeFileSync(join(dirId, "arquivo-estranho.json"), "{}");
      const r = executar(f, "S\r\n");
      check("ambíguo: sem prompt de adoção", !/Adotar esta instalacao existente\?/i.test(r.saida), r.saida.slice(-800));
      check("ambíguo: boot abortado sem efeitos", semEfeitosAdocao(f, r.out), r.out);
      rmSync(f.dir, { recursive: true, force: true });
    }
  }
} finally {
  rmSync(TEMP, { recursive: true, force: true });
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
