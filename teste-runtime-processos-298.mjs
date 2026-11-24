// Suíte #298 — ciclo de vida do processo/servidor (runtime real).
// Cobre: boot → health → escrita real → shutdown graceful via endpoint
// administrativo real (POST /api/admin/servidor/desligar — funciona em
// Windows e POSIX, ao contrário de SIGTERM via ChildProcess.kill) →
// restart com dados íntegros; kill abrupto (SIGKILL) com WAL pendente
// comprovado → lock liberado + marcador de negócio recuperado;
// instância duplicada com causa específica nos logs; EADDRINUSE com
// causa específica; health degradado por FS (503→200); sessão revogada
// permanece revogada após restart (cookie+socket, com controle positivo);
// corrida real de duas inicializações; 3 ciclos start→write→stop→start
// (um com SIGKILL+WAL); ausência de processo/porta órfã.
// Executar: node teste-runtime-processos-298.mjs  (requer servidor/dist buildado)
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { io as ioClient } from "socket.io-client";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  encerrarServidor, limparDir, comDb, criarCenario, req, sessao,
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
  // 'close' (não 'exit') prova stdio drenado — rastreado desde o spawn
  // para esperarSaida aguardar o evento real em TODOS os caminhos.
  p.__closed = false;
  p.once("close", () => { p.__closed = true; });
  ativos.push(p);
  return p;
}
const logsDe = (p) => p.__log ?? "";

/** Aguarda o evento 'close' REAL do processo (stdio drenado) em todos
 *  os caminhos — inclusive quando 'exit' já ocorreu antes da chamada.
 *  Sem sleeps fixos nem fallback silencioso: se 'close' não chegar,
 *  resolve null por timeout e os asserts falham (nunca sucesso). */
async function esperarSaida(proc, timeoutMs = 20000) {
  const fim = () => ({ exitCode: proc.exitCode, signalCode: proc.signalCode });
  if (proc.__closed) return fim();
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    proc.once("close", () => { clearTimeout(t); resolve(fim()); });
  });
}

/** Encerramento com prova de 'close' REAL (stdio drenado): delega o
 *  shutdown a encerrarServidor (SIGTERM→SIGKILL) e exige que
 *  esperarSaida retorne — null por timeout vira exceção, nunca PASS. */
async function encerrarComClose(proc, timeoutMs = 15000) {
  await encerrarServidor(proc, timeoutMs);
  const saida = await esperarSaida(proc, timeoutMs);
  if (saida === null) throw new Error(`close não chegou para pid=${proc.pid}`);
  return saida;
}

/** Encerra exigindo close real; falha de close vira assert FALHOU
 *  (nunca PASS silencioso). Uso em todo shutdown que antecede
 *  restart/remoção de fixture — inclusive dentro de finally. */
async function fecharComAssert(nome, proc) {
  try { await encerrarComClose(proc); }
  catch (e) { ok(`${nome} — close real`, false, String(e?.message ?? e)); }
}

/** Limpeza best-effort para finally/catch: garante kill + espera close,
 *  mas NUNCA transforma falha de close em PASS — registra no stderr. */
async function limparProcesso(p) {
  try {
    if (p.exitCode === null && p.signalCode === null) { try { p.kill("SIGKILL"); } catch {} }
    const s = await esperarSaida(p, 8000);
    if (s === null) console.error(`[limpeza] close não chegou pid=${p.pid}`);
  } catch (e) {
    console.error(`[limpeza] ${e?.message ?? e}`);
  }
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

/** Health que aceita QUALQUER resposta HTTP (inclui 503 degradado) —
 *  esperarSaudavel() exige r.ok e nunca retornaria num servidor
 *  degradado de propósito. */
async function esperarHealth(base, proc, timeoutMs = 30000) {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    try {
      const r = await fetch(base + "/api/health", { signal: AbortSignal.timeout(2000) });
      const json = await r.json().catch(() => null);
      return { status: r.status, json };
    } catch { }
    if (proc.exitCode !== null) throw new Error("servidor morreu: " + proc.exitCode);
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("timeout aguardando /api/health responder");
}

/** Conecta socket.io-client com o cookie de sessão (mesmo padrão de
 *  teste-sessoes-socket.mjs). Retorna {socket, conectado, erro}. */
function conectarSocket(base, cookie) {
  const token = decodeURIComponent(cookie.split("=")[1]);
  const s = ioClient(base, {
    path: "/socket.io", transports: ["websocket", "polling"], reconnection: false,
    extraHeaders: { cookie: `mestre_rpg_session=${encodeURIComponent(token)}` },
  });
  return new Promise((resolve) => {
    const resultado = { socket: s, conectado: false, erro: null };
    s.on("connect", () => { resultado.conectado = true; resolve(resultado); });
    s.on("connect_error", (e) => { resultado.erro = e; resolve(resultado); });
  });
}

async function main() {
  let cookieAdmin = null;
  let adminId = null;
  let campIdC1 = null;

  // ---------- C1: boot → health → escrita → graceful admin → restart íntegro ----------
  {
    const { porta, proc, base } = await cenarioBase();
    const c = await criarCenario(base, BANCO, { jogadores: {} });
    ok("C1 setup+campanha criados", !!c.campId);
    cookieAdmin = c.cookieMestre;
    adminId = c.adminId;
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
    // (sem assert tautológico: a prova de "sem fallback" é o próprio
    // exitCode===0 + signalCode===null observados acima)

    // restart na mesma porta/banco
    const proc2 = subir(porta, { banco: BANCO, arquivos: ARQUIVOS, backups: BACKUPS });
    await esperarSaudavel(base, proc2);
    const health = await req(base, "GET", "/health");
    ok("C1 restart health", health.status === 200, `status=${health.status}`);
    const camp = await req(base, "GET", `/campaigns/${campIdC1}`, { cookie: cookieAdmin });
    ok("C1 dados persistem após restart", camp.status === 200 && !!camp.json, `status=${camp.status}`);
    ok("C1 integrity_check ok", integridade(BANCO) === "ok");
    await fecharComAssert("C1 teardown restart", proc2);
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
    // Frame WAL completo = header 32B + frame header 24B + página inteira.
    // 32B sozinhos não provam frame; o mínimo real depende do page_size.
    const pageSize = comDb(BANCO, (db) => db.pragma("page_size", { simple: true }));
    const walMinimo = 32 + 24 + pageSize;
    ok("C2 WAL continha frames pendentes antes do kill", walTamanho >= walMinimo,
      `wal=${walTamanho}B min=${walMinimo}B (page=${pageSize})`);

    proc.kill("SIGKILL");
    const saidaKill = await esperarSaida(proc, 10000);
    ok("C2 SIGKILL: close real após kill", saidaKill !== null, "timeout aguardando close");
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
    await fecharComAssert("C2 teardown restart", proc2);
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
    if (saida === null) await limparProcesso(dup);
    await fecharComAssert("C3 teardown", proc);
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

  // ---------- C6: health degradado por FS → 503 → correção → 200 ----------
  // Fixture determinística Windows/Linux: `.healthcheck` como DIRETÓRIO
  // dentro do dir de arquivos faz writeFileSync(<dir>/.healthcheck) falhar
  // (EISDIR/ENOTDIR) → checagens.arquivos=false → 503. (Apontar
  // MESTRE_ARQUIVOS para um arquivo regular derrubaria o boot: index.ts
  // faz mkdirSync sem try/catch — verificado.)
  {
    const ARQ_C6 = join(TMP, "arquivos-c6");
    mkdirSync(ARQ_C6, { recursive: true });
    const porta = await portaLivre();
    const proc = subir(porta, { banco: BANCO, arquivos: ARQ_C6, backups: BACKUPS });
    const base = `http://127.0.0.1:${porta}`;
    try {
      // degrada: .healthcheck existe como diretório → probe de escrita falha
      mkdirSync(join(ARQ_C6, ".healthcheck"), { recursive: true });
      const h1 = await esperarHealth(base, proc);
      ok("C6 health degradado → HTTP 503", h1.status === 503, `status=${h1.status}`);
      ok("C6 status=indisponivel + banco ok + arquivos false",
        h1.json?.status === "indisponivel" && h1.json?.checagens?.banco === true
          && h1.json?.checagens?.arquivos === false,
        JSON.stringify(h1.json?.checagens));
      ok("C6 alerta de diretório de arquivos", (h1.json?.alertas ?? []).includes("diretorio_arquivos_indisponivel"),
        JSON.stringify(h1.json?.alertas));

      // recupera: remove o diretório-sentinela → probe volta a passar
      rmSync(join(ARQ_C6, ".healthcheck"), { recursive: true, force: true });
      const h2 = await esperarHealth(base, proc);
      ok("C6 health recuperado → HTTP 200", h2.status === 200, `status=${h2.status}`);
      ok("C6 checagens.arquivos=true após correção", h2.json?.checagens?.arquivos === true);
      ok("C6 probe não deixou artefato", !existsSync(join(ARQ_C6, ".healthcheck")));
    } finally {
      await fecharComAssert("C6 teardown", proc);
    }
  }

  // ---------- C6b: sessão revogada continua revogada após restart ----------
  {
    const porta = await portaLivre();
    const proc = subir(porta, { banco: BANCO, arquivos: ARQUIVOS, backups: BACKUPS });
    const base = `http://127.0.0.1:${porta}`;
    const sockets = [];
    try {
      await esperarSaudavel(base, proc);
      // sessões reais da conta admin criada no C1 (setup só roda 1x/banco):
      // uma será revogada por logout, a outra é o controle positivo.
      const cookieRevogada = sessao(BANCO, adminId);
      const cookieValida = sessao(BANCO, adminId);

      // socket real com a sessão que será revogada
      const s1 = await conectarSocket(base, cookieRevogada);
      sockets.push(s1.socket);
      ok("C6b socket conecta antes do logout", s1.conectado, String(s1.erro));
      // espera o disconnect REAL do socket existente (evento, não sleep)
      const desconectou = new Promise((res) => {
        const to = setTimeout(() => res(false), 8000);
        s1.socket.once("disconnect", () => { clearTimeout(to); res(true); });
      });

      // revogação real via endpoint de logout
      const lo = await req(base, "POST", "/auth/logout", { cookie: cookieRevogada, body: {} });
      ok("C6b logout revoga sessão", lo.status === 200 || lo.status === 204, `status=${lo.status}`);
      ok("C6b socket existente é desconectado pelo logout", await desconectou);

      // restart no mesmo banco/porta — close real exigido antes de subir
      await fecharComAssert("C6b shutdown pré-restart", proc);
      const proc2 = subir(porta, { banco: BANCO, arquivos: ARQUIVOS, backups: BACKUPS });
      try {
        await esperarSaudavel(base, proc2);

        // cookie revogado → rota autenticada rejeita
        const negado = await req(base, "GET", `/campaigns/${campIdC1}`, { cookie: cookieRevogada });
        ok("C6b cookie revogado → 401 após restart", negado.status === 401, `status=${negado.status}`);
        // novo handshake com cookie revogado → rejeitado
        const sRev = await conectarSocket(base, cookieRevogada);
        sockets.push(sRev.socket);
        ok("C6b handshake com cookie revogado rejeitado após restart",
          !sRev.conectado && !!sRev.erro, `conectado=${sRev.conectado} erro=${sRev.erro}`);
        // controle positivo: outra sessão da mesma conta volta a autenticar/reconectar
        const okHttp = await req(base, "GET", `/campaigns/${campIdC1}`, { cookie: cookieValida });
        ok("C6b sessão válida da mesma conta autentica após restart", okHttp.status === 200, `status=${okHttp.status}`);
        const sOk = await conectarSocket(base, cookieValida);
        sockets.push(sOk.socket);
        ok("C6b socket da sessão válida reconecta após restart", sOk.conectado, String(sOk.erro));
      } finally {
        await fecharComAssert("C6b teardown restart", proc2);
      }
    } finally {
      for (const s of sockets) { try { s.disconnect(); } catch {} }
      await limparProcesso(proc);
    }
  }

  // ---------- C7: corrida real de duas inicializações ----------
  {
    const portaA = await portaLivre();
    const portaB = await portaLivre();
    const procA = subir(portaA, { banco: BANCO, arquivos: ARQUIVOS, backups: BACKUPS });
    const procB = subir(portaB, { banco: BANCO, arquivos: ARQUIVOS, backups: BACKUPS });
    const baseA = `http://127.0.0.1:${portaA}`;
    const baseB = `http://127.0.0.1:${portaB}`;
    try {
      // Espera até um dos dois responder health OU ambos morrerem (30s)
      const limite = Date.now() + 30000;
      let vencedor = null, perdedor = null;
      while (Date.now() < limite && !vencedor) {
        for (const [base, proc, nome] of [[baseA, procA, "A"], [baseB, procB, "B"]]) {
          try {
            const r = await fetch(base + "/api/health", { signal: AbortSignal.timeout(1500) });
            if (r.ok) { vencedor = { base, proc, nome, porta: nome === "A" ? portaA : portaB }; break; }
          } catch { }
        }
        if (procA.exitCode !== null && procB.exitCode !== null) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      ok("C7 exatamente uma inicialização vence a corrida", !!vencedor,
        `A exit=${procA.exitCode} sig=${procA.signalCode} | B exit=${procB.exitCode} sig=${procB.signalCode}` +
        `\n--- logA ---\n${logsDe(procA).slice(-800)}\n--- logB ---\n${logsDe(procB).slice(-800)}`);
      if (vencedor) {
        perdedor = vencedor.nome === "A" ? procB : procA;
        const saidaPerdedor = await esperarSaida(perdedor, 15000);
        ok("C7 perdedor termina !=0 com diagnóstico de trava",
          saidaPerdedor !== null && saidaPerdedor.exitCode !== 0,
          `saida=${JSON.stringify(saidaPerdedor)}`);
        const logPerdedor = logsDe(perdedor);
        ok("C7 causa específica: trava de instância nos logs do perdedor",
          /outra instância do Mestre RPG já está ativa|instância/i.test(logPerdedor),
          logPerdedor.slice(-300));
        // vencedor permanece saudável + dados íntegros
        const h = await req(vencedor.base, "GET", "/health");
        ok("C7 vencedor saudável após a corrida", h.status === 200, `status=${h.status}`);
        ok("C7 integrity_check pós-corrida", integridade(BANCO) === "ok");
      }
    } finally {
      for (const p of [procA, procB]) await limparProcesso(p);
    }
    // lock liberado após teardown: terceira instância sobe normalmente
    const portaC = await portaLivre();
    const procC = subir(portaC, { banco: BANCO, arquivos: ARQUIVOS, backups: BACKUPS });
    try {
      await esperarSaudavel(`http://127.0.0.1:${portaC}`, procC, 30000);
      ok("C7 lock liberado: terceira instância sobe após teardown", true);
    } catch (e) {
      ok("C7 lock liberado: terceira instância sobe após teardown", false, String(e?.message ?? e).slice(0, 150));
    }
    await fecharComAssert("C7 teardown", procC);
  }

  // ---------- C8: ciclos repetidos start→write→stop→start (3 ciclos) ----------
  {
    const porta = await portaLivre();
    const base = `http://127.0.0.1:${porta}`;
    const ts = Date.now();
    let todosOk = true;
    const detalhesCiclos = [];
    for (let ciclo = 1; ciclo <= 3; ciclo++) {
      const proc = subir(porta, { banco: BANCO, arquivos: ARQUIVOS, backups: BACKUPS });
      try {
        await esperarSaudavel(base, proc);
        // marcador único por ciclo
        const nome = `CICLO-${ciclo}-${ts}`;
        const camp = await req(base, "POST", "/campaigns", { cookie: cookieAdmin, body: { name: nome } });
        const gravou = camp.status === 201 || camp.status === 200;
        const marcadorId = camp.json?.campanha?.id ?? camp.json?.id;

        if (ciclo === 2) {
          // ciclo alternado com kill abrupto + prova de WAL
          await new Promise((r) => setTimeout(r, 300));
          const walT = existsSync(WAL) ? statSync(WAL).size : 0;
          const pageSize = comDb(BANCO, (db) => db.pragma("page_size", { simple: true }));
          const walOk = walT >= 32 + 24 + pageSize;
          proc.kill("SIGKILL");
          const saidaKill = await esperarSaida(proc, 10000);
          const killOk = saidaKill !== null && (proc.exitCode !== null || proc.signalCode !== null);
          const procR = subir(porta, { banco: BANCO, arquivos: ARQUIVOS, backups: BACKUPS });
          try {
            await esperarSaudavel(base, procR, 30000);
            const relido = await req(base, "GET", `/campaigns/${marcadorId}`, { cookie: cookieAdmin });
            const integ = integridade(BANCO) === "ok";
            const cicloOk = gravou && walOk && killOk && relido.status === 200 && integ;
            todosOk &&= cicloOk;
            detalhesCiclos.push(`ciclo2 kill: gravou=${gravou} wal=${walT}B close=${saidaKill !== null} relido=${relido.status} integ=${integ}`);
          } finally { await fecharComAssert(`C8 ciclo${ciclo} restart`, procR); }
        } else {
          // shutdown graceful → exit 0 → restart → reler marcador
          const deslig = await desligarGracefulAdmin(base, cookieAdmin);
          const saida = await esperarSaida(proc, 20000);
          const gracioso = deslig.status === 200 && saida?.exitCode === 0 && saida?.signalCode === null;
          const procR = subir(porta, { banco: BANCO, arquivos: ARQUIVOS, backups: BACKUPS });
          try {
            await esperarSaudavel(base, procR, 30000);
            const relido = await req(base, "GET", `/campaigns/${marcadorId}`, { cookie: cookieAdmin });
            const integ = integridade(BANCO) === "ok";
            const cicloOk = gravou && gracioso && relido.status === 200 && integ;
            todosOk &&= cicloOk;
            detalhesCiclos.push(`ciclo${ciclo}: gravou=${gravou} graceful=${gracioso} relido=${relido.status} integ=${integ}`);
          } finally { await fecharComAssert(`C8 ciclo${ciclo} restart`, procR); }
        }
      } finally {
        await limparProcesso(proc);
      }
    }
    ok("C8 3 ciclos start→write→stop→start íntegros", todosOk, detalhesCiclos.join(" | "));
    // prova extra: marcador do ciclo 1 ainda legível no banco final
    const restante = comDb(BANCO, (db) =>
      db.prepare("select count(*) n from campaigns where name like ?").get(`CICLO-%-${ts}`).n);
    ok("C8 marcadores de todos os ciclos persistiram", restante >= 3, `encontrados=${restante}`);
  }

  // ---------- C5: sem órfãos — processos já encerrados pelos cenários ----------
  {
    // Primeiro verifica SEM matar: cada cenário deve ter encerrado seu
    // processo. Só então limpa o que eventualmente restou.
    const aindaVivos = ativos.filter((p) => p.exitCode === null && p.signalCode === null);
    ok("C5 todos os processos encerrados pelos próprios cenários", aindaVivos.length === 0,
      `${aindaVivos.length} vivos: ${aindaVivos.map((p) => p.pid).join(",")}`);
    // finally-style: encerra o que restou (limpeza best-effort + log)
    for (const p of aindaVivos) await limparProcesso(p);
  }

  console.log(`\n${passaram} passaram, ${falharam} falharam`);
  limparDir(TMP);
  process.exit(falharam ? 1 : 0);
}

main().catch(async (e) => {
  console.error("FALHA FATAL:", e);
  // finally: encerra processos do harness antes de limpar o diretório
  for (const p of ativos) await limparProcesso(p);
  limparDir(TMP);
  process.exit(1);
});
