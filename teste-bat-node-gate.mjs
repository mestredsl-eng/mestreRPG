// Homologação real do gate Node mínimo no iniciar-mestre-rpg.bat (Issue #155 / F43).
// Executa o .bat pelo cmd.exe em fixtures isoladas. Usa o Node.exe real do runner
// e NODE_OPTIONS para substituir process.versions.node apenas nos processos-filhos.
// Isso preserva semântica de executável: ao contrário de node.cmd, o BAT retorna
// corretamente ao chamador após node -e / node -p.
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
const temp = mkdtempSync(join(tmpdir(), "mestre-bat-node-gate-"));

function executarCaso(nome, versao, aceita, esperado) {
  const dir = join(temp, nome);
  const bin = join(dir, "bin");
  const app = join(dir, "instalacao com espacos");
  const scripts = join(app, "scripts");
  mkdirSync(bin, { recursive: true });
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(app, "iniciar-mestre-rpg.bat"), readFileSync(batSource));
  writeFileSync(join(scripts, "boot-lock.mjs"), "process.exit(1);\n");
  writeFileSync(join(scripts, "auto-update.mjs"), "process.exit(1);\n");
  const log = join(dir, "chamadas.log");
  const preload = join(dir, "node-preload.cjs");
  writeFileSync(preload, [
    'const fs = require("node:fs");',
    'const log = process.env.MESTRE_BAT_TEST_LOG;',
    'if (log) fs.appendFileSync(log, "node " + process.argv.slice(2).join(" ") + "\\n");',
    'const version = process.env.MESTRE_FAKE_NODE_VERSION;',
    "if (!version) process.exit(1);",
    'Object.defineProperty(process.versions, "node", { value: version, configurable: true });',
    "",
  ].join("\n"));
  const npmShim = [
    "@echo off",
    '>>"%MESTRE_BAT_TEST_LOG%" echo npm %*',
    "exit /b 0",
    "",
  ].join("\r\n");
  writeFileSync(join(bin, "npm.cmd"), npmShim);

  const env = {
    ...process.env,
    PATH: bin + ";" + (process.env.PATH || ""),
    NODE_OPTIONS: "--require=" + preload.replace(/\\/g, "/"),
    MESTRE_BAT_TEST_LOG: log,
    MESTRE_FAKE_NODE_VERSION: versao || "",
  };
  const comspec = process.env.ComSpec || "cmd.exe";
  const run = spawnSync(comspec, ["/d", "/c", "iniciar-mestre-rpg.bat"], {
    cwd: app, env, input: "\r\n", encoding: "utf8", timeout: 15000, windowsHide: true,
  });
  const saida = (run.stdout || "") + "\n" + (run.stderr || "");
  let chamadas = "";
  try { chamadas = readFileSync(log, "utf8"); } catch {}
  check(nome + ": cmd.exe terminou sem timeout", !run.error || run.error.code !== "ETIMEDOUT",
    run.error ? run.error.message : "");
  check(nome + ": " + esperado, run.status === 1 && saida.includes(esperado),
    "status=" + run.status + "; saída=" + saida.slice(-700));
  const tentouLock = /node scripts\\boot-lock\.mjs adquirir/i.test(chamadas);
  const tentouUpdater = /node scripts\\auto-update\.mjs/i.test(chamadas);
  const chamouNpm = /^npm /im.test(chamadas);
  if (aceita) {
    check(nome + ": gate aceitou e chegou ao sentinela do boot-lock", tentouLock, chamadas);
  } else {
    check(nome + ": recusou antes de adquirir lock", !tentouLock, chamadas);
    check(nome + ": recusou antes do atualizador Git", !tentouUpdater, chamadas);
    check(nome + ": recusou antes de invocar npm", !chamouNpm, chamadas);
  }
}

try {
  if (process.platform !== "win32") {
    console.log("Este teste exige cmd.exe e é executado no job Auto-update — Windows.");
    process.exitCode = 2;
  } else {
    console.log("== Gate Node >=20.19 no .bat — cmd.exe real ==");
    executarCaso("node-20.18-rejeitado", "20.18.9", false, "versao minima exigida");
    executarCaso("node-20.19-aceito", "20.19.0", true, "Node.js 20.19.0");
    executarCaso("node-22-aceito", "22.0.0", true, "Node.js 22.0.0");
    executarCaso("node-versao-ilegivel", null, false, "Nao foi possivel ler a versao");
    executarCaso("node-versao-malformada", "20.x", false, "versao minima exigida");
    console.log("\n" + pass + " ok, " + fail + " falhas");
    if (fail) process.exitCode = 1;
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
