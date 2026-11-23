// P10-C — homologação do primeiro bootstrap pelo BAT real (cmd.exe).
// Usa o autorizador e o avaliador reais, estado isolado e auto-update sentinela.
// Prova S/N, inválido, linha vazia, EOF, instalação já concluída e ordenação.
// Nunca toca em banco/backup real.
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  diagnosticarBootstrap, gravarReciboInstalacao,
  lerAutorizacaoBootstrap, lerProvisionamento,
} from "./scripts/estado-externo.mjs";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) { pass++; console.log("  ok", name); }
  else { fail++; console.error("  FALHOU", name, detail); }
};
const ROOT = process.cwd();
const BAT = join(ROOT, "iniciar-mestre-rpg.bat");
const TEMP = mkdtempSync(join(tmpdir(), "mestre-p10c-bat-"));
const SCRIPTS = [
  "boot-lock.mjs",
  "estado-externo.mjs",
  "autorizar-bootstrap.mjs",
  "avaliar-boot.mjs",
  "protocolo-auto-update.json",
];

let sequencia = 0;
function fixture(nome, recibo = false) {
  const dir = join(TEMP, nome);
  const app = join(dir, "instalacao com espacos");
  const scripts = join(app, "scripts");
  mkdirSync(scripts, { recursive: true });
  copyFileSync(BAT, join(app, "iniciar-mestre-rpg.bat"));
  for (const file of SCRIPTS) copyFileSync(join(ROOT, "scripts", file), join(scripts, file));

  const log = join(dir, "chamadas.log");
  const preload = join(dir, "preload.cjs");
  const updateMarker = join(dir, "auto-update-invocado.flag");
  writeFileSync(preload, [
    'const fs = require("node:fs");',
    'const p = process.env.MESTRE_BOOT_TEST_LOG;',
    'if (p) fs.appendFileSync(p, "node " + process.argv.slice(1).join(" ") + "\n");',
    "",
  ].join("\n"));
  writeFileSync(join(scripts, "auto-update.mjs"), [
    'import { writeFileSync } from "node:fs";',
    'writeFileSync(process.env.MESTRE_BOOT_TEST_UPDATE_MARKER, "called");',
    'console.log("[sentinela] auto-update alcançado");',
    "process.exit(1);",
    "",
  ].join("\n"));

  const porta = String(36000 + (++sequencia));
  const env = {
    ...process.env,
    NODE_OPTIONS: "--require=" + preload.replace(/\\/g, "/"),
    MESTRE_BOOT_TEST_LOG: log,
    MESTRE_BOOT_TEST_UPDATE_MARKER: updateMarker,
    MESTRE_STATE_DIR: join(dir, "state"),
    MESTRE_BANCO: join(dir, "banco", "mestre-rpg.db"),
    MESTRE_BACKUPS: join(dir, "backups"),
    MESTRE_ARQUIVOS: join(dir, "arquivos"),
    MESTRE_PORTA: porta,
  };
  if (recibo) gravarReciboInstalacao(app, env);
  return { dir, app, env, log, updateMarker };
}
function executar(f, input) {
  const comspec = process.env.ComSpec || "cmd.exe";
  const run = spawnSync(comspec, ["/d", "/c", "iniciar-mestre-rpg.bat"], {
    cwd: f.app, env: f.env, input, encoding: "utf8", timeout: 30000, windowsHide: true,
  });
  let out = "";
  try { out = readFileSync(f.log, "utf8"); } catch {}
  const saida = String(run.stdout ?? "") + "\n" + String(run.stderr ?? "");
  return { run, out, saida };
}
const pos = (s, re) => { const m = re.exec(s); return m ? m.index : -1; };
const tem = (s, re) => re.test(s);
const semEfeitos = (f, out) =>
  lerProvisionamento(f.app, f.env).status === "ausente"
  && lerAutorizacaoBootstrap(f.app, f.env).status === "ausente"
  && !existsSync(f.updateMarker)
  && !tem(out, /aplicar-restauracao\.js|db:migrate|npm run start/i);

try {
  if (process.platform !== "win32") {
    console.log("Este teste exige cmd.exe e é executado no job Auto-update — Windows.");
    process.exitCode = 2;
  } else {
    console.log("== P10-C: autorização de primeiro bootstrap pelo BAT / cmd.exe ==");

    // S: deve persistir provisionamento + autorização ANTES de tocar updater.
    {
      const f = fixture("confirma-S");
      const r = executar(f, "S\r\nx\r\n"); // x libera o pause do sentinela updater
      const prov = lerProvisionamento(f.app, f.env);
      const auth = lerAutorizacaoBootstrap(f.app, f.env);
      const iLock = pos(r.out, /boot-lock\.mjs adquirir/i);
      const iAuth = pos(r.out, /autorizar-bootstrap\.mjs --confirmar-provisionamento/i);
      const iEval = pos(r.out, /avaliar-boot\.mjs validar/i);
      const iUpdate = pos(r.out, /auto-update\.mjs/i);
      check("S: cmd.exe terminou sem timeout", !r.run.error || r.run.error.code !== "ETIMEDOUT", r.run.error?.message ?? "");
      check("S: autorização foi emitida", prov.status === "ok" && auth.status === "ok", `prov=${prov.status} auth=${auth.status}`);
      check("S: prompt exibido e confirmação aceita", /Autorizar primeiro bootstrap\? \[S\/N\]/i.test(r.saida) && /autorizar-bootstrap\.mjs --confirmar-provisionamento/i.test(r.out));
      check("S: ordem lock → autorização → revalidação → updater", iLock >= 0 && iAuth > iLock && iEval > iAuth && iUpdate > iEval,
        `lock=${iLock} auth=${iAuth} validar=${iEval} update=${iUpdate}`);
      check("S: updater só foi invocado depois do consentimento", existsSync(f.updateMarker));
      check("S: falha sentinela do updater abortou antes de restore/migrate/start",
        !tem(r.out, /aplicar-restauracao\.js|db:migrate|npm run start/i));
      check("S: lock liberado ao abortar depois do updater", tem(r.out, /boot-lock\.mjs liberar/i));
    }

    // N: recusa explícita não grava marker/autorização e não toca updater.
    {
      const f = fixture("recusa-N");
      const r = executar(f, "N\r\n");
      check("N: recusou e terminou com erro", r.run.status !== 0 && r.run.status !== null, `status=${r.run.status}`);
      check("N: nenhum marker/autorização/atualizador/restore/migrate/start", semEfeitos(f, r.out), r.out.slice(-1000));
      check("N: lock liberado", tem(r.out, /boot-lock\.mjs liberar/i), r.out);
    }

    // Banco presente/estado ambíguo: jamais mostrar o prompt nem tocar no banco.
    {
      const f = fixture("banco-existente");
      mkdirSync(join(f.dir, "banco"), { recursive: true });
      const bytes = "banco preexistente que nao pode ser sobrescrito";
      writeFileSync(f.env.MESTRE_BANCO, bytes);
      const r = executar(f, "S\r\n");
      check("ambíguo: banco existente bloqueia antes do prompt", !/Autorizar primeiro bootstrap\\?/i.test(r.saida), r.saida.slice(-800));
      check("ambíguo: falha encerra o boot antes do atualizador", !existsSync(f.updateMarker) && !tem(r.out, /auto-update\.mjs|aplicar-restauracao\.js|db:migrate|npm run start/i), r.out);
      check("ambíguo: banco preexistente fica byte-idêntico", readFileSync(f.env.MESTRE_BANCO, "utf8") === bytes);
      check("ambíguo: nenhum marcador ou autorização é gravado",
        lerProvisionamento(f.app, f.env).status === "ausente"
        && lerAutorizacaoBootstrap(f.app, f.env).status === "ausente");
    }

    // Inválido: repete a pergunta; N subsequente recusa sem efeito.
    {
      const f = fixture("invalida-depois-N");
      const r = executar(f, "X\r\nN\r\n");
      check("inválida: aviso e nova pergunta", /Resposta invalida/i.test(r.saida)
        && (r.saida.match(/Autorizar primeiro bootstrap\?/gi) ?? []).length >= 2, r.saida.slice(-1000));
      check("inválida→N: nada foi provisionado ou atualizado", semEfeitos(f, r.out), r.out);
    }

    // Linha vazia: deve repetir a pergunta sem criar qualquer estado.
    {
      const f = fixture("vazia-depois-N");
      const r = executar(f, "\r\nN\r\n");
      check("vazia: repetiu a pergunta (não tratou ENTER como S)", (r.saida.match(/Autorizar primeiro bootstrap\?/gi) ?? []).length >= 2, r.saida.slice(-1000));
      check("vazia→N: nenhum efeito de bootstrap", semEfeitos(f, r.out), r.out);
    }

    // EOF / stdin encerrado: fail-closed, sem loop infinito e sem efeitos.
    {
      const f = fixture("eof");
      const r = executar(f, "");
      check("EOF: cmd.exe terminou sem timeout", !r.run.error || r.run.error.code !== "ETIMEDOUT", r.run.error?.message ?? "");
      check("EOF: abortou fail-closed", r.run.status !== 0 && r.run.status !== null && /Entrada terminou/i.test(r.saida),
        `status=${r.run.status} ${r.saida.slice(-800)}`);
      check("EOF: zero provisionamento, autorização, updater, restore, migrate ou start", semEfeitos(f, r.out), r.out);
    }

    // Instalação concluída: não pergunta e não tenta autorizar de novo.
    {
      const f = fixture("instalacao-existente", true);
      const r = executar(f, "x\r\n");
      check("existente: reconhecida como concluída", diagnosticarBootstrap(f.app, f.env) === "instalacao-concluida");
      check("existente: não exibe prompt de primeiro bootstrap", !/Autorizar primeiro bootstrap\?/i.test(r.saida), r.saida.slice(-600));
      check("existente: não emite provisionamento nem autorização novos",
        lerProvisionamento(f.app, f.env).status === "ausente" && lerAutorizacaoBootstrap(f.app, f.env).status === "ausente");
      check("existente: segue para updater após gate seguro", existsSync(f.updateMarker));
    }

    console.log(`\n${pass} ok, ${fail} falhas`);
    if (fail) process.exitCode = 1;
  }
} finally {
  rmSync(TEMP, { recursive: true, force: true });
}
