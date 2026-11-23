// Homologação do caminho de FALHA da restauração no iniciar-mestre-rpg.bat
// (Issue #155 / #270). Executa o .bat real pelo cmd.exe em fixtures
// descartáveis, com sentinelas que substituem os estágios mutáveis:
//   - scripts/boot-lock.mjs  -> adquirir/liberar retornam 0 (semântica real
//     do lock é coberta por teste-boot-lock.mjs / #265);
//   - scripts/auto-update.mjs -> sai 0;
//   - servidor/dist/db/aplicar-restauracao.js -> código configurável por caso;
//   - npm.cmd shim            -> registra "npm <args>" e pode falhar sob demanda
//     via MESTRE_NPM_FAIL (padrão findstr sobre os argumentos).
// Todo processo node/npm invocado é registrado pelo preload NODE_OPTIONS —
// a prova usa o log de chamadas reais, não o texto do console.
//
// O que este teste prova (ordem #270 / gate W14):
//   1. restaurador sentinela com exit != 0  -> BAT termina exit != 0;
//   2. o BAT chama `boot-lock.mjs liberar` depois da falha;
//   3. NENHUM `npm run db:migrate`, `npm run start` ou entrypoint do
//      servidor é invocado após a falha da restauração;
//   4. falha no migrate também libera o lock e não inicia o servidor;
//   5. caminho feliz preserva a ordem adquirir -> ... -> restaurar ->
//      migrate -> start -> liberar.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  ok", name); }
  else { fail++; console.error("  FALHOU", name, detail); }
};
const root = process.cwd();
const batSource = join(root, "iniciar-mestre-rpg.bat");
const temp = mkdtempSync(join(tmpdir(), "mestre-bat-restauracao-"));

const BOOT_LOCK_SENTINELA = [
  'const c = process.argv[2];',
  'process.exit(c === "adquirir" || c === "liberar" ? 0 : 3);',
  "",
].join("\n");
const AUTO_UPDATE_SENTINELA = "process.exit(0);\n";

function executarCaso(nome, { codigoRestaurador, falhaNpm }) {
  const dir = join(temp, nome);
  const bin = join(dir, "bin");
  const app = join(dir, "instalacao com espacos");
  const scripts = join(app, "scripts");
  const distDb = join(app, "servidor", "dist", "db");
  mkdirSync(bin, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  mkdirSync(distDb, { recursive: true });
  writeFileSync(join(app, "iniciar-mestre-rpg.bat"), readFileSync(batSource));
  writeFileSync(join(scripts, "boot-lock.mjs"), BOOT_LOCK_SENTINELA);
  // O teste isola restauração/migration: o novo gate de bootstrap fica aprovado.
  writeFileSync(join(scripts, "avaliar-boot.mjs"), "process.exit(0);\n");
  writeFileSync(join(scripts, "auto-update.mjs"), AUTO_UPDATE_SENTINELA);
  writeFileSync(join(distDb, "aplicar-restauracao.js"), `process.exit(${codigoRestaurador});\n`);
  const log = join(dir, "chamadas.log");
  const preload = join(dir, "node-preload.cjs");
  writeFileSync(preload, [
    'const fs = require("node:fs");',
    'const log = process.env.MESTRE_BAT_TEST_LOG;',
    'if (log) fs.appendFileSync(log, "node " + process.argv.slice(1).join(" ") + "\\n");',
    "",
  ].join("\n"));
  // npm.cmd real executável: registra a invocação e honra MESTRE_NPM_FAIL
  // como padrão findstr (sem regex exótica — só substring literal).
  const npmShim = [
    "@echo off",
    '>>"%MESTRE_BAT_TEST_LOG%" echo npm %*',
    'if defined MESTRE_NPM_FAIL echo %*| findstr /i /c:"%MESTRE_NPM_FAIL%" >nul && exit /b 1',
    "exit /b 0",
    "",
  ].join("\r\n");
  writeFileSync(join(bin, "npm.cmd"), npmShim);

  const env = {
    ...process.env,
    PATH: bin + ";" + (process.env.PATH || ""),
    NODE_OPTIONS: "--require=" + preload.replace(/\\/g, "/"),
    MESTRE_BAT_TEST_LOG: log,
    ...(falhaNpm ? { MESTRE_NPM_FAIL: falhaNpm } : {}),
  };
  const comspec = process.env.ComSpec || "cmd.exe";
  const run = spawnSync(comspec, ["/d", "/c", "iniciar-mestre-rpg.bat"], {
    cwd: app, env, input: "\r\n", encoding: "utf8", timeout: 30000, windowsHide: true,
  });
  const saida = (run.stdout || "") + "\n" + (run.stderr || "");
  let chamadas = "";
  try { chamadas = readFileSync(log, "utf8"); } catch {}
  return { run, saida, chamadas };
}

const idx = (log, re) => { const m = log.match(re); return m ? m.index : -1; };
const tem = (log, re) => re.test(log);

try {
  if (process.platform !== "win32") {
    console.log("Este teste exige cmd.exe e é executado no job Auto-update — Windows.");
    process.exitCode = 2;
  } else {
    console.log("== Falha da restauração no iniciar-mestre-rpg.bat — cmd.exe real ==");

    // CASO 1 — restaurador falha (exit != 0): boot deve abortar com erro,
    // liberar o lock e NÃO migrar/iniciar o servidor.
    {
      const c = executarCaso("restauracao-falha", { codigoRestaurador: 1 });
      const { run, saida, chamadas } = c;
      check("restauracao-falha: cmd.exe terminou sem timeout", !run.error || run.error.code !== "ETIMEDOUT",
        run.error ? run.error.message : "");
      check("restauracao-falha: BAT retornou exit != 0", run.status !== 0 && run.status !== null,
        "status=" + run.status);
      check("restauracao-falha: sentinela do restaurador foi invocado", tem(chamadas, /aplicar-restauracao\.js/i), chamadas.slice(-800));
      check("restauracao-falha: lock foi liberado após a falha", tem(chamadas, /boot-lock\.mjs\s+liberar/i), chamadas);
      check("restauracao-falha: db:migrate NÃO foi chamado", !tem(chamadas, /db:migrate/i), chamadas);
      check("restauracao-falha: npm run start NÃO foi chamado", !tem(chamadas, /npm run start/i), chamadas);
      check("restauracao-falha: entrypoint do servidor NÃO foi invocado", !tem(chamadas, /dist[/\\]index\.js/i), chamadas);
      const iRest = idx(chamadas, /aplicar-restauracao\.js/i);
      const iLib = idx(chamadas, /boot-lock\.mjs\s+liberar/i);
      check("restauracao-falha: liberar ocorreu DEPOIS da falha do restaurador", iRest >= 0 && iLib > iRest,
        `restaurador@${iRest} liberar@${iLib}`);
      check("restauracao-falha: mensagem de erro visível no console", /restauracao de backup FALHOU/i.test(saida), saida.slice(-500));
    }

    // CASO 2 — restaurador ok, migrate falha: lock liberado, servidor não sobe.
    {
      const c = executarCaso("migrate-falha", { codigoRestaurador: 0, falhaNpm: "db:migrate" });
      const { run, chamadas } = c;
      check("migrate-falha: cmd.exe terminou sem timeout", !run.error || run.error.code !== "ETIMEDOUT",
        run.error ? run.error.message : "");
      check("migrate-falha: BAT retornou exit != 0", run.status !== 0 && run.status !== null,
        "status=" + run.status);
      check("migrate-falha: restaurador executou antes do migrate", (() => {
        const iRest = idx(chamadas, /aplicar-restauracao\.js/i);
        const iMig = idx(chamadas, /npm run db:migrate/i);
        return iRest >= 0 && iMig > iRest;
      })(), chamadas);
      check("migrate-falha: lock foi liberado após a falha", tem(chamadas, /boot-lock\.mjs\s+liberar/i), chamadas);
      check("migrate-falha: npm run start NÃO foi chamado", !tem(chamadas, /npm run start/i), chamadas);
      check("migrate-falha: entrypoint do servidor NÃO foi invocado", !tem(chamadas, /dist[/\\]index\.js/i), chamadas);
    }

    // CASO 3 — caminho feliz: prova que o harness chega aos estágios certos
    // e a ordem é adquirir -> auto-update -> build -> restaurar -> migrate
    // -> start -> liberar (guarda contra falso-positivo por falha precoce).
    {
      const c = executarCaso("caminho-feliz", { codigoRestaurador: 0 });
      const { run, chamadas } = c;
      check("caminho-feliz: cmd.exe terminou sem timeout", !run.error || run.error.code !== "ETIMEDOUT",
        run.error ? run.error.message : "");
      check("caminho-feliz: BAT retornou exit 0", run.status === 0, "status=" + run.status);
      const ordem = [
        /boot-lock\.mjs\s+adquirir/i,
        /auto-update\.mjs/i,
        /npm run build -w servidor/i,
        /aplicar-restauracao\.js/i,
        /npm run db:migrate/i,
        /npm run start/i,
        /boot-lock\.mjs\s+liberar/i,
      ];
      let pos = -1, ordemOk = true;
      for (const re of ordem) {
        const i = idx(chamadas, re);
        if (i < 0 || i <= pos) { ordemOk = false; break; }
        pos = i;
      }
      check("caminho-feliz: ordem adquirir->update->build->restaurar->migrate->start->liberar", ordemOk, chamadas);
    }

    console.log(`\n${pass} passaram, ${fail} falharam`);
    if (fail > 0) process.exitCode = 1;
  }
} finally {
  try { rmSync(temp, { recursive: true, force: true }); } catch {}
}
