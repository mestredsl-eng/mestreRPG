// Diagnóstico C7 (issue #365 / PR #298) — corrida de cold-start sobre
// banco + arquivo .trava recém-criados, N rodadas, com monitor de
// /proc/locks DURANTE a corrida para identificar o detentor do lock.
//
// Cenário por rodada (espelha o C7 de teste-runtime-processos-298.mjs):
//   1. banco SQLite novo via prepararBanco() (migrations reais);
//   2. dois `node servidor/dist/index.js` spawnados no mesmo instante,
//      portas distintas, MESMO MESTRE_BANCO → mesma .trava;
//   3. espera health de um OU morte de ambos (30s);
//   4. perdedor deve sair !=0 com "outra instância ... já está ativa";
//   5. teardown dos vivos → terceiro start deve subir saudável.
//
// Em Linux, um monitor lê /proc/locks a cada ~25ms filtrando o inode da
// .trava e registra (rel_ms, pid, tipo) — em falha ambos-falham, a
// timeline mostra QUEM detinha a trava e por quanto tempo.
//
// Uso: node diagnostico-c7-ci.mjs [rodadas=25] [workers=2]
// Requer servidor/dist buildado (npm run build -w servidor).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  dirTeste, prepararBanco, portaLivre,
} from "./teste-base.mjs";

const REPO = dirname(fileURLToPath(import.meta.url));
const RODADAS = Number(process.argv[2] ?? 25);
const WORKERS = Number(process.argv[3] ?? 2);
const TIMEOUT_CORRIDA_MS = 30_000;
const TIMEOUT_PERDEDOR_MS = 15_000;
const TIMEOUT_TERCEIRO_MS = 30_000;

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  ok  ${n}`); } else { fail++; console.log(`FALHOU ${n} ${d}`); } };

const ehLinux = process.platform === "linux";

/** Monitor de /proc/locks do inode da .trava — registra detentores. */
function iniciarMonitorLocks(caminhoTrava, t0) {
  if (!ehLinux) return { parar() {}, eventos: [] };
  const eventos = [];
  let inode = null;
  try { inode = statSync(caminhoTrava).ino.toString(16); } catch { /* ainda não existe */ }
  const timer = setInterval(() => {
    try {
      if (!inode) { try { inode = statSync(caminhoTrava).ino.toString(16); } catch { return; } }
      const linhas = readFileSync("/proc/locks", "utf8").split("\n")
        .filter((l) => l.toLowerCase().includes(inode));
      for (const l of linhas) {
        // formato: "N: POSIX ADVISORY WRITE <pid> maj:min:ino ..."
        const partes = l.trim().split(/\s+/);
        const pid = Number(partes[4]) || 0;
        const tipo = partes.slice(1, 4).join(" "); // ex.: "POSIX ADVISORY WRITE"
        const chave = pid + "|" + tipo;
        const ult = eventos[eventos.length - 1];
        if (!ult || ult.chave !== chave) {
          eventos.push({ rel: Date.now() - t0, pid, tipo, chave });
        }
      }
      // registra liberações (inode some das linhas)
      if (linhas.length === 0) {
        const ult = eventos[eventos.length - 1];
        if (ult && ult.pid !== 0) eventos.push({ rel: Date.now() - t0, pid: 0, tipo: "LIVRE", chave: "0|LIVRE" });
      }
    } catch { /* /proc indisponível neste tick */ }
  }, 25);
  return {
    eventos,
    async parar() {
      clearInterval(timer);
      // flush final
      try {
        if (inode) {
          const linhas = readFileSync("/proc/locks", "utf8").split("\n")
            .filter((l) => l.toLowerCase().includes(inode));
          eventos.push({ rel: Date.now() - t0, pid: linhas.length ? Number(linhas[0].split(/\s+/)[4]) : 0, tipo: linhas.length ? "FINAL" : "LIVRE-FIM" });
        }
      } catch { }
    },
  };
}

function cmdlineDe(pid) {
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").slice(0, 200); }
  catch { return "?"; }
}

function subir(porta, env) {
  const p = spawn(process.execPath, ["servidor/dist/index.js"], {
    cwd: REPO,
    env: { ...process.env, ...env, MESTRE_PORTA: String(porta) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.__log = "";
  p.stdout.on("data", (d) => { p.__log += String(d); });
  p.stderr.on("data", (d) => { p.__log += String(d); });
  return p;
}

async function esperarSaida(proc, timeoutMs) {
  if (proc.exitCode !== null) return { exitCode: proc.exitCode, signalCode: proc.signalCode };
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    proc.once("close", () => { clearTimeout(t); resolve({ exitCode: proc.exitCode, signalCode: proc.signalCode }); });
  });
}

async function matar(proc) {
  if (proc.exitCode === null) { try { proc.kill("SIGKILL"); } catch { } }
  await esperarSaida(proc, 8000);
}

async function healthOk(porta) {
  try {
    const r = await fetch(`http://127.0.0.1:${porta}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch { return false; }
}

async function rodada(i) {
  const dir = dirTeste(`c7diag-${i}`);
  const banco = join(dir, "banco", "mestre-rpg.db");
  mkdirSync(dirname(banco), { recursive: true });
  await prepararBanco(banco);
  const trava = banco + ".trava";
  rmSync(trava, { force: true });
  rmSync(trava + ".recover", { force: true });

  const envBase = {
    NODE_ENV: "test",
    MESTRE_BANCO: banco,
    MESTRE_ARQUIVOS: join(dir, "arquivos"),
    MESTRE_BACKUPS: join(dir, "backups"),
  };
  const portas = await Promise.all(Array.from({ length: WORKERS }, () => portaLivre()));

  const t0 = Date.now();
  const monitor = iniciarMonitorLocks(trava, t0);
  const workers = portas.map((porta, k) => ({
    nome: String.fromCharCode(65 + k), porta, proc: subir(porta, envBase),
  }));

  let vencedor = null;
  const limite = Date.now() + TIMEOUT_CORRIDA_MS;
  while (Date.now() < limite && !vencedor) {
    for (const w of workers) {
      if (await healthOk(w.porta)) { vencedor = w; break; }
    }
    if (workers.every((w) => w.proc.exitCode !== null)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const msVencedor = vencedor ? Date.now() - t0 : null;

  // espera losers/perdedores terminarem
  const t1 = Date.now();
  while (Date.now() - t1 < TIMEOUT_PERDEDOR_MS && workers.some((w) => w !== vencedor && w.proc.exitCode === null)) {
    await new Promise((r) => setTimeout(r, 200));
  }
  await monitor.parar();

  const resultado = {
    rodada: i,
    vencedor: vencedor?.nome ?? "NENHUM",
    msAteSaude: msVencedor,
    fins: workers.map((w) => `${w.nome}:pid=${w.proc.pid}:exit=${w.proc.exitCode}:sig=${w.proc.signalCode}`),
    msgsTrava: workers.map((w) => (w.proc.__log.match(/outra instância[^\n]*/)?.[0] ?? "").slice(0, 90)),
    locks: monitor.eventos.slice(0, 60),
    logs: {},
  };
  for (const w of workers) resultado.logs[w.nome] = w.proc.__log.slice(-500);

  // teardown: mata todos → prova terceiro start
  for (const w of workers) await matar(w.proc);
  const portaC = await portaLivre();
  const procC = subir(portaC, envBase);
  let terceiroOk = false;
  const tC = Date.now();
  while (Date.now() - tC < TIMEOUT_TERCEIRO_MS) {
    if (await healthOk(portaC)) { terceiroOk = true; break; }
    if (procC.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  resultado.terceiroStart = terceiroOk ? "ok" : "FALHOU";
  if (!terceiroOk) resultado.logTerceiro = procC.__log.slice(-500);
  await matar(procC);
  try { rmSync(dir, { recursive: true, force: true }); } catch { }
  return resultado;
}

console.log(`Diagnóstico C7 — rodadas=${RODADAS} workers=${WORKERS} plataforma=${process.platform}`);
const falhasAmbos = [];
for (let i = 0; i < RODADAS; i++) {
  const r = await rodada(i);
  const linha = `rodada ${String(i).padStart(2)}: vencedor=${r.vencedor} ${r.fins.join(" ")} 3o=${r.terceiroStart}`;
  console.log(linha);
  if (r.vencedor === "NENHUM" || r.terceiroStart !== "ok") {
    falhasAmbos.push(r);
    console.log(`  >>> ANOMALIA rodada ${i} — evidência completa abaixo`);
  }
}

console.log(`\n===== RESUMO: ${pass} ok / ${fail} falhas (${RODADAS} rodadas) =====`);
for (const r of falhasAmbos) {
  console.log(`\n----- rodada ${r.rodada} -----`);
  console.log("fins:", r.fins.join(" | "));
  console.log("msgsTrava:", JSON.stringify(r.msgsTrava));
  console.log("locks(/proc):", JSON.stringify(r.locks));
  if (ehLinux) {
    const pids = [...new Set(r.locks.map((e) => e.pid).filter((p) => p > 0))];
    for (const pid of pids) console.log(`cmdline pid=${pid}:`, cmdlineDe(pid));
  }
  for (const [nome, log] of Object.entries(r.logs)) {
    console.log(`--- log${nome} ---\n${log}`);
  }
  if (r.logTerceiro) console.log(`--- logTerceiro ---\n${r.logTerceiro}`);
}
process.exit(falhasAmbos.length ? 1 : 0);
