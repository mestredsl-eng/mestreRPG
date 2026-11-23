// Suíte #271 camada A — homologação de COMPONENTES Node em Linux/POSIX.
// Escopo (decisão do Dono 7098313800): boot-lock.mjs, estado-externo
// (XDG/MESTRE_STATE_DIR), migrate.js fail-closed, index.js + SIGKILL.
// NÃO cobre o fluxo user-facing completo (não existe launcher Linux —
// camada B permanece BLOCKED por decisão de produto).
// Saída por cenário: distro, Node, SHA, PASS/FAIL — formato W-matrix.
// Executar: node teste-recovery-linux.mjs  (requer servidor/dist buildado)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir, release } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  encerrarServidor, limparDir, comDb,
} from "./teste-base.mjs";
import {
  dirEstado, diretorioBaseEstado, instalacaoId, gravarEstado, JOURNAL_UPDATE,
} from "./scripts/estado-externo.mjs";

const REPO = dirname(fileURLToPath(import.meta.url));

let passaram = 0, falharam = 0;
const ok = (nome, cond, detalhe = "") => {
  if (cond) { passaram++; console.log(`  ok  ${nome}`); }
  else { falharam++; console.log(`FALHOU ${nome} ${detalhe}`); }
};

function shNode(args, { env, cwd } = {}) {
  return spawnSync("node", args, {
    cwd: cwd ?? REPO,
    env: { ...process.env, ...(env ?? {}) },
    encoding: "utf-8",
    timeout: 60000,
  });
}

function infoAmbiente() {
  let distro = "?";
  try {
    const osr = readFileSync("/etc/os-release", "utf-8");
    distro = (osr.match(/^PRETTY_NAME="?([^"\n]+)/m) ?? [])[1] ?? "?";
  } catch { distro = `${release()} (não-Linux)`; }
  const sha = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf-8" }).stdout.trim();
  return { distro, node: process.version, sha, plataforma: `${process.platform}/${process.arch}` };
}

async function main() {
  const env = infoAmbiente();
  console.log(`== #271 camada A — componentes Node ==`);
  console.log(`distro=${env.distro} node=${env.node} sha=${env.sha} ${env.plataforma}`);

  const TMP = dirTeste("linux271");
  try {
    // ---------- L1: boot-lock adquirir/liberar/concorrência ----------
    {
      const stateDir = join(TMP, "state-l1");
      // cwd fake com configuracao/servidor.json vazio: sem isso o JSON do
      // repo prevalece sobre MESTRE_PORTA e o health-check pode achar um
      // servidor real (exit 20) — isolamento determinístico do lock
      const fakeCwd = join(TMP, "fake-repo-l1");
      mkdirSync(join(fakeCwd, "configuracao"), { recursive: true });
      writeFileSync(join(fakeCwd, "configuracao", "servidor.json"), "{}");
      const portaLock = await portaLivre();
      const envLock = { MESTRE_STATE_DIR: stateDir, MESTRE_PORTA: String(portaLock) };
      const bootLock = join(REPO, "scripts", "boot-lock.mjs");
      const a1 = shNode([bootLock, "adquirir"], { env: envLock, cwd: fakeCwd });
      ok("L1 primeiro adquirir", a1.status === 0, `status=${a1.status} err=${(a1.stderr ?? "").slice(0, 120)}`);
      const a2 = shNode([bootLock, "adquirir"], { env: envLock, cwd: fakeCwd });
      ok("L1 segundo adquirir concorrente recusado", a2.status !== 0, `status=${a2.status}`);
      const l1 = shNode([bootLock, "liberar"], { env: envLock, cwd: fakeCwd });
      ok("L1 liberar", l1.status === 0, `status=${l1.status}`);
      const a3 = shNode([bootLock, "adquirir"], { env: envLock, cwd: fakeCwd });
      ok("L1 re-adquirir após liberar", a3.status === 0, `status=${a3.status}`);
      shNode([bootLock, "liberar"], { env: envLock, cwd: fakeCwd });
    }

    // ---------- L2: estado-externo — XDG, override, isolamento ----------
    {
      const xdg = join(TMP, "xdg-state");
      const envXdg = { ...process.env, XDG_STATE_HOME: xdg };
      delete envXdg.MESTRE_STATE_DIR;
      const base = diretorioBaseEstado(envXdg);
      if (process.platform === "win32") {
        // Windows ignora XDG por desenho — base é LOCALAPPDATA\MestreRPG\state
        ok("L2 base Windows = LOCALAPPDATA (XDG não se aplica)", /MestreRPG/i.test(base), `base=${base}`);
      } else {
        ok("L2 XDG_STATE_HOME respeitado", base.includes(xdg), `base=${base}`);
      }

      const dirA = dirEstado(REPO, { ...process.env, MESTRE_STATE_DIR: join(TMP, "sA") });
      const dirB = dirEstado(REPO, { ...process.env, MESTRE_STATE_DIR: join(TMP, "sB") });
      ok("L2 MESTRE_STATE_DIR override isolado", dirA !== dirB && dirA.includes("sA") && dirB.includes("sB"),
        `${dirA} vs ${dirB}`);

      const repoFake = join(TMP, "outro-repo");
      mkdirSync(repoFake, { recursive: true });
      const idReal = instalacaoId(REPO);
      const idFake = instalacaoId(repoFake);
      ok("L2 instalacaoId difere por caminho canônico", idReal !== idFake);

      // gravação atômica real no state dir isolado
      const stateDir = join(TMP, "state-l2");
      const envL2 = { ...process.env, MESTRE_STATE_DIR: stateDir };
      gravarEstado(REPO, JOURNAL_UPDATE, { fase: "teste", marcador: "l2" }, envL2);
      const journalPath = join(dirEstado(REPO, envL2), JOURNAL_UPDATE);
      ok("L2 journal gravado em dirEstado", existsSync(journalPath), journalPath);
    }

    // ---------- L3: migrate fail-closed sem bootstrap / ok com bootstrap ----------
    {
      const bancoVazio = join(TMP, "vazio", "mestre-rpg.db");
      const stateVazio = join(TMP, "state-l3a");
      const migNeg = spawnSync("node", ["servidor/dist/db/migrate.js"], {
        env: { ...process.env, MESTRE_BANCO: bancoVazio, MESTRE_STATE_DIR: stateVazio, MESTRE_BACKUPS: join(TMP, "bk-l3") },
        encoding: "utf-8", timeout: 60000,
      });
      ok("L3 migrate recusa banco vazio sem bootstrap", migNeg.status !== 0,
        `status=${migNeg.status} err=${(migNeg.stderr ?? "").slice(0, 160)}`);

      const bancoOk = join(TMP, "ok", "mestre-rpg.db");
      await prepararBanco(bancoOk); // provisiona+autoriza+migra (mesmo env isolado)
      ok("L3 migrate com bootstrap autorizado", existsSync(bancoOk), bancoOk);
      const nTabelas = comDb(bancoOk, (db) => db.prepare("select count(*) c from sqlite_master where type='table'").get().c);
      ok("L3 schema aplicado", nTabelas > 10, `tabelas=${nTabelas}`);
    }

    // ---------- L4: index.js boot → SIGKILL → restart (POSIX) ----------
    // Endurecido conforme ordem do Dono (7102568207): listeners de
    // exit/close registrados logo após o spawn; kill aceito assertado;
    // exit E close aguardados com timeout; segundo processo só inicia
    // após close real do primeiro; finally garante close dos dois —
    // timeout nunca vira PASS.
    {
      const observar = (proc) => {
        proc.__closed = false;
        proc.once("close", () => { proc.__closed = true; });
        return proc;
      };
      const esperarFechado = (proc, timeoutMs = 15000) => {
        if (proc.__closed) return Promise.resolve({ exitCode: proc.exitCode, signalCode: proc.signalCode });
        return new Promise((resolve) => {
          const t = setTimeout(() => resolve(null), timeoutMs);
          proc.once("close", () => { clearTimeout(t); resolve({ exitCode: proc.exitCode, signalCode: proc.signalCode }); });
        });
      };

      const banco = join(TMP, "srv", "mestre-rpg.db");
      await prepararBanco(banco);
      const porta = await portaLivre();
      const arquivos = join(TMP, "srv-arquivos");
      const backups = join(TMP, "srv-backups");
      const base = `http://127.0.0.1:${porta}`;
      let proc = null, proc2 = null;
      try {
        proc = observar(subirServidor(porta, { banco, arquivos, backups }));
        await esperarSaudavel(base, proc);

        const killAceito = proc.kill("SIGKILL");
        ok("L4 kill SIGKILL aceito pelo SO", killAceito === true);
        const saida1 = await esperarFechado(proc, 15000);
        ok("L4 primeiro processo: exit+close reais", saida1 !== null,
          "timeout aguardando close — stdio pode não ter drenado");
        if (process.platform === "win32") {
          // Windows: Node mapeia SIGKILL para TerminateProcess —
          // encerramento abrupto equivalente; signalCode POSIX não se aplica.
          console.log("  info L4 Windows: kill abrupto = TerminateProcess (sem signalCode POSIX)");
          ok("L4 encerramento abrupto registrado (Windows)", proc.exitCode !== null || proc.signalCode !== null);
        } else {
          ok("L4 signalCode === SIGKILL (POSIX)", proc.signalCode === "SIGKILL",
            `signalCode=${proc.signalCode} exitCode=${proc.exitCode}`);
        }

        // segundo processo SÓ após close confirmado do primeiro —
        // prova liberação de handles/stdio, não apenas saída lógica
        if (saida1 !== null) {
          proc2 = observar(subirServidor(porta, { banco, arquivos, backups }));
          await esperarSaudavel(base, proc2, 30000);
          ok("L4 restart pós-SIGKILL saudável", true);
        } else {
          ok("L4 restart pós-SIGKILL saudável", false, "primeiro close não confirmado — restart não tentado");
        }
      } catch (e) {
        ok("L4 ciclo SIGKILL→restart saudável", false, String(e?.message ?? e).slice(0, 160));
      } finally {
        // cleanup garantido: mata o que estiver vivo e exige close real
        for (const p of [proc, proc2]) {
          if (p && p.exitCode === null && p.signalCode === null) { try { p.kill("SIGKILL"); } catch {} }
        }
        for (const [nome, p] of [["primeiro", proc], ["segundo", proc2]]) {
          if (!p) continue;
          const s = await esperarFechado(p, 15000);
          if (s === null) {
            falharam++;
            console.log(`FALHOU L4 ${nome} processo: close não chegou pid=${p.pid}`);
          }
        }
      }
    }

    // ---------- L5: permissão negada no state dir → fail-closed ----------
    {
      const stateDir = join(TMP, "state-l5");
      mkdirSync(stateDir, { recursive: true });
      chmodSync(stateDir, 0o000);
      let falhou = false;
      try {
        gravarEstado(REPO, "teste-perm.json", { x: 1 }, { ...process.env, MESTRE_STATE_DIR: stateDir });
      } catch { falhou = true; }
      chmodSync(stateDir, 0o700);
      if (process.platform === "win32" || process.getuid?.() === 0) {
        // chmod 000 não restringe no Windows nem para root — informativo
        console.log("  info L5 chmod 000 inócuo nesta plataforma — cenário informativo");
        ok("L5 permissão negada (informativo)", true);
      } else {
        ok("L5 escrita em state dir 000 recusada (fail-closed)", falhou);
      }
    }
  } finally {
    limparDir(TMP);
  }

  console.log(`\n${passaram} passaram, ${falharam} falharam`);
  process.exit(falharam ? 1 : 0);
}

main().catch((e) => { console.error("FALHA FATAL:", e); process.exit(1); });
