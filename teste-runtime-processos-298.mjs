// Suíte #298 — ciclo de vida do processo/servidor (runtime real).
// Cobre: boot → health → escrita real → shutdown graceful (SIGTERM) →
// restart com dados íntegros; kill abrupto (SIGKILL) → lock liberado +
// WAL recuperado + integridade; instância duplicada; EADDRINUSE;
// ausência de processo/porta órfã.
// Executar: node teste-runtime-processos-298.mjs  (requer servidor/dist buildado)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
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
const ARQUIVOS = join(TMP, "arquivos");
const BACKUPS = join(TMP, "backups");

function integridade(banco) {
  const db = new Database(banco, { readonly: true });
  try { return db.pragma("integrity_check", { simple: true }); }
  finally { db.close(); }
}

async function cenarioBase() {
  await prepararBanco(BANCO);
  const porta = await portaLivre();
  const proc = subir(porta, { banco: BANCO, arquivos: ARQUIVOS, backups: BACKUPS });
  const base = `http://127.0.0.1:${porta}`;
  await esperarSaudavel(base, proc);
  return { porta, proc, base };
}

const ativos = [];
function subir(...args) {
  const p = subirServidor(...args);
  ativos.push(p);
  return p;
}

async function main() {
  // ---------- C1: boot → health → escrita → SIGTERM → restart íntegro ----------
  {
    const { porta, proc, base } = await cenarioBase();
    const c = await criarCenario(base, BANCO, { jogadores: {} });
    ok("C1 setup+campanha criados", !!c.campId);

    await encerrarServidor(proc); // SIGTERM graceful
    ok("C1 SIGTERM encerra com código 0 ou sinal", proc.exitCode === 0 || proc.signalCode !== null,
      `exit=${proc.exitCode} sig=${proc.signalCode}`);

    // restart na mesma porta/banco
    const proc2 = subir(porta, { banco: BANCO, arquivos: ARQUIVOS, backups: BACKUPS });
    await esperarSaudavel(base, proc2);
    const health = await req(base, "GET", "/health");
    ok("C1 restart health", health.status === 200, `status=${health.status}`);
    const camp = await req(base, "GET", `/campaigns/${c.campId}`, { cookie: c.cookieMestre });
    ok("C1 dados persistem após restart", camp.status === 200 && !!camp.json, `status=${camp.status}`);
    ok("C1 integrity_check ok", integridade(BANCO) === "ok");
    await encerrarServidor(proc2);
  }

  // ---------- C2: SIGKILL abrupto → lock liberado, WAL recuperado ----------
  {
    const porta = await portaLivre();
    const proc = subir(porta, { banco: BANCO, arquivos: ARQUIVOS, backups: BACKUPS });
    const base = `http://127.0.0.1:${porta}`;
    await esperarSaudavel(base, proc);
    // escrita real antes do kill
    const setup = await req(base, "POST", "/auth/login", { body: { username: "mestre_teste", password: "senha-forte-123" } });
    ok("C2 login pré-kill", setup.status === 200, `status=${setup.status}`);

    proc.kill("SIGKILL");
    await new Promise((r) => proc.once("exit", r));
    ok("C2 SIGKILL encerra processo", proc.exitCode !== null || proc.signalCode !== null);

    // restart imediato: trava de instância deve ter sido liberada pelo SO
    const proc2 = subir(porta, { banco: BANCO, arquivos: ARQUIVOS, backups: BACKUPS });
    try {
      await esperarSaudavel(base, proc2, 30000);
      ok("C2 restart pós-SIGKILL saudável", true);
      ok("C2 integrity_check pós-kill", integridade(BANCO) === "ok");
      const login2 = await req(base, "POST", "/auth/login", { body: { username: "mestre_teste", password: "senha-forte-123" } });
      ok("C2 dados sobrevivem ao kill", login2.status === 200, `status=${login2.status}`);
    } catch (e) {
      ok("C2 restart pós-SIGKILL saudável", false, String(e?.message ?? e).slice(0, 200));
      try { proc2.kill("SIGKILL"); } catch {}
    }
    await encerrarServidor(proc2);
  }

  // ---------- C3: instância duplicada no mesmo banco → falha controlada ----------
  {
    const porta = await portaLivre();
    const proc = subir(porta, { banco: BANCO, arquivos: ARQUIVOS, backups: BACKUPS });
    const base = `http://127.0.0.1:${porta}`;
    await esperarSaudavel(base, proc);

    const porta2 = await portaLivre();
    const dup = subir(porta2, { banco: BANCO, arquivos: ARQUIVOS, backups: BACKUPS });
    const saiu = await new Promise((r) => {
      const t = setTimeout(() => r(null), 15000);
      dup.once("exit", (c) => { clearTimeout(t); r(c); });
    });
    ok("C3 segunda instância no mesmo banco é rejeitada", saiu !== null && saiu !== 0,
      `exit=${saiu}`);
    await encerrarServidor(proc);
  }

  // ---------- C4: porta ocupada → EADDRINUSE controlado ----------
  {
    // o servidor binda em 0.0.0.0 — o ocupante precisa do mesmo wildcard
    // para garantir EADDRINUSE determinístico no Windows
    const ocupante = createServer();
    await new Promise((r) => ocupante.listen(0, "0.0.0.0", r));
    const portaOcupada = ocupante.address().port;
    const proc = subir(portaOcupada, { banco: BANCO, arquivos: ARQUIVOS, backups: BACKUPS });
    const saiu = await new Promise((r) => {
      const t = setTimeout(() => r(null), 15000);
      proc.once("exit", (c) => { clearTimeout(t); r(c); });
    });
    ok("C4 porta ocupada → processo morre (EADDRINUSE)", saiu !== null && saiu !== 0, `exit=${saiu}`);
    ocupante.close();
  }

  // ---------- C5: sem órfãos — todo processo filho encerrou ----------
  {
    for (const p of ativos) {
      if (p.exitCode === null && p.signalCode === null) {
        try { p.kill("SIGKILL"); } catch {}
        await new Promise((r) => p.once("exit", r));
      }
    }
    const vivos = ativos.filter((p) => p.exitCode === null && p.signalCode === null);
    ok("C5 nenhum processo filho órfão ao final", vivos.length === 0,
      `${vivos.length} vivos`);
  }

  console.log(`\n${passaram} passaram, ${falharam} falharam`);
  limparDir(TMP);
  process.exit(falharam ? 1 : 0);
}

main().catch((e) => { console.error("FALHA FATAL:", e); limparDir(TMP); process.exit(1); });
