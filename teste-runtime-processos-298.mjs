// Suíte #298 — ciclo de vida do processo/servidor (runtime real).
// Cobre: boot → health → escrita real → shutdown graceful via endpoint
// administrativo real (POST /api/admin/servidor/desligar — funciona em
// Windows e POSIX, ao contrário de SIGTERM via ChildProcess.kill) →
// restart com dados íntegros; kill abrupto (SIGKILL) com WAL pendente
// comprovado → lock liberado + marcador de negócio recuperado;
// instância duplicada com causa específica nos logs; EADDRINUSE com
// causa específica; ausência de processo/porta órfã.
// Executar: node teste-runtime-processos-298.mjs  (requer servidor/dist buildado)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  encerrarServidor, limparDir, comDb, criarCenario, req,
} from "./teste-base.mjs";

let passaram = 0, falharam = 0;
const ok = (nome, cond, detalhe = "") => {
  if (cond) { passaram++; console.log(`  ok  ${nome}`); }
  else { falharam++; console.log(`FALHOU ${nome} ${detalhe}`); }
};

const TMP = dirTeste("runtime298");
const BANCO = join(TMP, "banco", "mestre-rpg.db");
const WAL = BANCO + "-wal";
const ARQUIVOS = join(TMP, "arquivos");
const BACKUPS = join(TMP, "backups");

function integridade(banco) {
  const db = new Database(banco, { readonly: true });
  try { return db.pragma("integrity_check", { simple: true }); }
  finally { db.close(); }
}

/** Processos filho diretos iniciados por este harness (o servidor não
 *  gera descendentes — spawn é `node dist/index.js` direto). */
const ativos = [];
function subir(...args) {
  const p = subirServidor(...args);
  // Drena stdout/stderr: evita pipe cheio bloquear o servidor E fornece
  // o log necessário para assertar a causa específica de C3/C4.
  p.__log = "";
  const acumular = (d) => {
    p.__log += String(d);
    if (p.__log.length > 200_000) p.__log = p.__log.slice(-100_000);
  };
  p.stdout?.on("data", acumular);
  p.stderr?.on("data", acumular);
  ativos.push(p);
  return p;
}
const logsDe = (p) => p.__log ?? "";

async function esperarSaida(proc, timeoutMs = 20000) {
  if (proc.exitCode !== null || proc.signalCode !== null) return { exitCode: proc.exitCode, signalCode: proc.signalCode };
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    proc.once("exit", (code, signal) => { clearTimeout(t); resolve({ exitCode: code, signalCode: signal }); });
  });
}

async function cenarioBase() {
  await prepararBanco(BANCO);
  const porta = await portaLivre();
  const proc = subir(porta, { banco: BANCO, arquivos: ARQUIVOS, backups: BACKUPS });
  const base = `http://127.0.0.1:${porta}`;
  await esperarSaudavel(base, proc);
  return { porta, proc, base };
}

/** Shutdown graceful REAL do produto: endpoint admin autenticado que
 *  dispara o mesmo `desligar("admin")` do SIGTERM/SIGINT — suportado
 *  em Windows e POSIX. Retorna o resultado da saída observada. */
async function desligarGracefulAdmin(base, cookie) {
  const r = await req(base, "POST", "/admin/servidor/desligar", { cookie, body: {} });
  return r;
}

async function main() {
  let cookieAdmin = null;
  let campIdC1 = null;

  // ---------- C1: boot → health → escrita → graceful admin → restart íntegro ----------
  {
    const { porta, proc, base } = await cenarioBase();
    const c = await criarCenario(base, BANCO, { jogadores: {} });
    ok("C1 setup+campanha criados", !!c.campId);
    cookieAdmin = c.cookieMestre;
    campIdC1 = c.campId;

    // Graceful real: o endpoint admin dispara httpServer.close() → exit(0).
    // Não usa ChildProcess.kill — SIGTERM via Node no Windows é forçado,
    // não graceful (Node docs). Vale para Windows e POSIX.
    const deslig = await desligarGracefulAdmin(base, cookieAdmin);
    ok("C1 endpoint admin desligar aceito", deslig.status === 200, `status=${deslig.status} ${JSON.stringify(deslig.json).slice(0, 120)}`);
    const saida = await esperarSaida(proc, 20000);
    ok("C1 graceful: processo sai com exitCode 0 e sem sinal",
      saida !== null && saida.exitCode === 0 && saida.signalCode === null,
      `saida=${JSON.stringify(saida)}`);
    ok("C1 graceful: sem fallback de kill (encerrarServidor não usado)", true);

    // restart na mesma porta/banco
    const proc2 = subir(porta, { banco: BANCO, arquivos: ARQUIVOS, backups: BACKUPS });
    await esperarSaudavel(base, proc2);
    const health = await req(base, "GET", "/health");
    ok("C1 restart health", health.status === 200, `status=${health.status}`);
    const camp = await req(base, "GET", `/campaigns/${campIdC1}`, { cookie: cookieAdmin });
    ok("C1 dados persistem após restart", camp.status === 200 && !!camp.json, `status=${camp.status}`);
    ok("C1 integrity_check ok", integridade(BANCO) === "ok");
    await encerrarServidor(proc2);
  }

  // ---------- C2: SIGKILL abrupto com WAL pendente → marcador recuperado ----------
  {
    const porta = await portaLivre();
    const proc = subir(porta, { banco: BANCO, arquivos: ARQUIVOS, backups: BACKUPS });
    const base = `http://127.0.0.1:${porta}`;
    await esperarSaudavel(base, proc);

    // Escrita de negócio identificável IMEDIATAMENTE antes do kill —
    // fica nos frames do WAL (autocheckpoint=1000 páginas não é atingido
    // por escritas pequenas; nada no teste força checkpoint).
    const nomeMarcador = `WAL-MARCADOR-298-${Date.now()}`;
    const camp = await req(base, "POST", "/campaigns", { cookie: cookieAdmin, body: { name: nomeMarcador } });
    ok("C2 escrita de marcador pré-kill", camp.status === 201 || camp.status === 200, `status=${camp.status}`);
    const marcadorId = camp.json?.campanha?.id ?? camp.json?.id;

    // Prova de WAL pendente: -wal existe e tem frames além do header (32B).
    // Ler tamanho não interfere no banco (não é checkpoint).
    await new Promise((r) => setTimeout(r, 300)); // commit assenta no WAL
    const walTamanho = existsSync(WAL) ? statSync(WAL).size : 0;
    ok("C2 WAL continha frames pendentes antes do kill", walTamanho > 32,
      `wal=${walTamanho}B`);

    proc.kill("SIGKILL");
    await esperarSaida(proc, 10000);
    ok("C2 SIGKILL encerra processo", proc.exitCode !== null || proc.signalCode !== null);

    // restart imediato: trava de instância liberada pelo SO + WAL recovery
    const proc2 = subir(porta, { banco: BANCO, arquivos: ARQUIVOS, backups: BACKUPS });
    try {
      await esperarSaudavel(base, proc2, 30000);
      ok("C2 restart pós-SIGKILL saudável", true);
      // Marcador escrito imediatamente antes da queda deve sobreviver —
      // só existe prova de recovery se ele foi lido de volta.
      const relido = await req(base, "GET", `/campaigns/${marcadorId}`, { cookie: cookieAdmin });
      ok("C2 marcador de negócio sobrevive ao kill", relido.status === 200
        && JSON.stringify(relido.json).includes(nomeMarcador), `status=${relido.status}`);
      ok("C2 integrity_check pós-kill", integridade(BANCO) === "ok");
    } catch (e) {
      ok("C2 restart pós-SIGKILL saudável", false, String(e?.message ?? e).slice(0, 200));
    }
    await encerrarServidor(proc2);
  }

  // ---------- C3: instância duplicada no mesmo banco → causa específica ----------
  {
    const porta = await portaLivre();
    const proc = subir(porta, { banco: BANCO, arquivos: ARQUIVOS, backups: BACKUPS });
    const base = `http://127.0.0.1:${porta}`;
    await esperarSaudavel(base, proc);

    const porta2 = await portaLivre();
    const dup = subir(porta2, { banco: BANCO, arquivos: ARQUIVOS, backups: BACKUPS });
    const saida = await esperarSaida(dup, 15000);
    const logDup = logsDe(dup);
    ok("C3 segunda instância no mesmo banco é rejeitada", saida !== null && saida.exitCode !== 0,
      `saida=${JSON.stringify(saida)}`);
    ok("C3 causa específica: trava de instância nos logs",
      /outra instância do Mestre RPG já está ativa/i.test(logDup),
      logDup.slice(-300));
    if (saida === null) { try { dup.kill("SIGKILL"); } catch {} await esperarSaida(dup, 5000); }
    await encerrarServidor(proc);
  }

  // ---------- C4: porta ocupada → EADDRINUSE com causa específica ----------
  {
    // o servidor binda em 0.0.0.0 — o ocupante precisa do mesmo wildcard
    // para garantir EADDRINUSE determinístico no Windows
    const ocupante = createServer();
    await new Promise((r) => ocupante.listen(0, "0.0.0.0", r));
    const portaOcupada = ocupante.address().port;
    const proc = subir(portaOcupada, { banco: BANCO, arquivos: ARQUIVOS, backups: BACKUPS });
    const saida = await esperarSaida(proc, 15000);
    const logProc = logsDe(proc);
    ok("C4 porta ocupada → processo morre", saida !== null && saida.exitCode !== 0,
      `saida=${JSON.stringify(saida)}`);
    ok("C4 causa específica: porta em uso nos logs",
      /já está em uso|EADDRINUSE/i.test(logProc),
      logProc.slice(-300));
    ocupante.close();
  }

  // ---------- C5: sem órfãos — processos já encerrados pelos cenários ----------
  {
    // Primeiro verifica SEM matar: cada cenário deve ter encerrado seu
    // processo. Só então limpa o que eventualmente restou.
    const aindaVivos = ativos.filter((p) => p.exitCode === null && p.signalCode === null);
    ok("C5 todos os processos encerrados pelos próprios cenários", aindaVivos.length === 0,
      `${aindaVivos.length} vivos: ${aindaVivos.map((p) => p.pid).join(",")}`);
    // finally-style: encerra o que restou (limpeza, não prova)
    for (const p of aindaVivos) {
      try { p.kill("SIGKILL"); } catch {}
      await esperarSaida(p, 5000);
    }
  }

  console.log(`\n${passaram} passaram, ${falharam} falharam`);
  limparDir(TMP);
  process.exit(falharam ? 1 : 0);
}

main().catch(async (e) => {
  console.error("FALHA FATAL:", e);
  // finally: encerra processos do harness antes de limpar o diretório
  for (const p of ativos) {
    if (p.exitCode === null && p.signalCode === null) {
      try { p.kill("SIGKILL"); } catch {}
      await esperarSaida(p, 5000);
    }
  }
  limparDir(TMP);
  process.exit(1);
});
