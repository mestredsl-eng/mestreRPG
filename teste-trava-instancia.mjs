#!/usr/bin/env node
// Trava de instância única (servidor/src/db/trava-instancia.ts).
// Prova, em raízes MESTRE_* isoladas (banco real nunca tocado):
//  - segunda instância do servidor NÃO sobe no mesmo banco;
//  - servidor ativo IMPDE restauração (exit != 0, nada alterado);
//  - encerramento gracioso e kill -9 liberam a trava (locks do SO);
//  - trava corrompida/inconclusiva aborta por segurança;
//  - restauração normal sem servidor continua funcionando.
// Não há PID file: a prova de "dono morto" é o próprio lock do SQLite,
// liberado pelo SO na morte do processo — PID reutilizado é irrelevante.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, readdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel, encerrarServidor, limparDir } from "./teste-base.mjs";
import { adquirirTravaInstancia, liberarTravaInstancia, verificarTravaInstancia, caminhoTrava } from "./servidor/dist/db/trava-instancia.js";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const RAIZ_REPO = process.cwd();
const RESTAURADOR = join(RAIZ_REPO, "servidor/dist/db/aplicar-restauracao.js");
const INDICE = join(RAIZ_REPO, "servidor/dist/index.js");

const RAIZ = dirTeste("trava-instancia");
const dbEm = (r) => join(r, "banco", "mestre-rpg.db");
const travaEm = (r) => caminhoTrava(dbEm(r));
const envRaiz = (raiz, extra = {}) => ({
  ...process.env,
  MESTRE_HOME: raiz,
  MESTRE_BANCO: dbEm(raiz),
  MESTRE_ARQUIVOS: join(raiz, "arquivos", "campanhas"),
  MESTRE_BACKUPS: join(raiz, "backups"),
  ...extra,
});
const restaurar = (raiz, env) => {
  const r = spawnSync("node", [RESTAURADOR], { env: env ?? envRaiz(raiz), encoding: "utf8" });
  return { code: r.status, saida: (r.stdout ?? "") + (r.stderr ?? "") };
};
const comDbRw = (arq, fn) => { const d = new Database(arq); try { return fn(d); } finally { d.close(); } };
const flagPendente = (arq) => {
  try { return comDbRw(arq, (d) => d.prepare("select value from server_settings where key='restauracao_pendente'").get()?.value ?? null); }
  catch { return "ERRO_LEITURA"; }
};
const armarFlag = (raiz, filePath) => comDbRw(dbEm(raiz), (d) => {
  d.prepare("insert into server_settings (key,value) values ('restauracao_pendente',?) " +
    "on conflict(key) do update set value=excluded.value").run(JSON.stringify({ filePath }));
});
const fazerBackup = (raiz, nome) => {
  const bk = join(raiz, "backups", nome);
  mkdirSync(bk, { recursive: true });
  copyFileSync(dbEm(raiz), join(bk, "mestre-rpg.db"));
  mkdirSync(join(bk, "arquivos"), { recursive: true });
  writeFileSync(join(bk, "arquivos", "doc_bk.txt"), "conteudo-do-backup");
  mkdirSync(join(bk, "configuracao"), { recursive: true });
  writeFileSync(join(bk, "configuracao", "servidor.json"), JSON.stringify({ backup: true }));
  return bk; // filePath da flag é o DIRETÓRIO do backup
};
const marcadorDb = (raiz) => comDbRw(dbEm(raiz), (d) =>
  d.prepare("select count(*) c from server_settings where key='restauracao_pendente'").get().c);

// Restaurador ASSÍNCRONO com coleta de saída — permite inspecionar o
// processo ENQUANTO ele está pausado no gate de trava.
function restaurarProc(raiz, env) {
  const p = spawn("node", [RESTAURADOR], { env: env ?? envRaiz(raiz), stdio: ["ignore", "pipe", "pipe"] });
  let saida = "";
  p.stdout.on("data", (d) => saida += d);
  p.stderr.on("data", (d) => saida += d);
  const fim = new Promise((res) => p.on("exit", (code) => res({ code, saida })));
  return { p, fim, saida: () => saida };
}
async function esperarCond(fn, timeoutMs = 15000, passo = 100) {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) { if (fn()) return true; await new Promise((r) => setTimeout(r, passo)); }
  return false;
}

try {
  sec("Trava em processo (unidade)");
  {
    const r = join(RAIZ, "unidade");
    mkdirSync(join(r, "banco"), { recursive: true });
    const banco = dbEm(r);
    t("verificar sem arquivo de trava → livre", verificarTravaInstancia(banco) === "livre");
    adquirirTravaInstancia(banco);
    t("após adquirir → em_uso", verificarTravaInstancia(banco) === "em_uso");
    t("segunda aquisição no mesmo processo → lança", (() => {
      // conexão separada no mesmo processo também deve falhar (BUSY)
      const db2 = new Database(caminhoTrava(banco));
      db2.pragma("busy_timeout = 0");
      try { db2.exec("BEGIN EXCLUSIVE"); db2.exec("ROLLBACK"); db2.close(); return false; }
      catch { try { db2.close(); } catch { } return true; }
    })());
    liberarTravaInstancia();
    t("após liberar → livre", verificarTravaInstancia(banco) === "livre");
    // "PID reutilizado" não se aplica: não existe PID file — um arquivo de
    // trava qualquer sem lock ativo nunca é removido nem bloqueia indevidamente.
    writeFileSync(travaEm(r), "lixo-nao-sqlite");
    t("trava corrompida → indeterminado (fail-safe)", verificarTravaInstancia(banco) === "indeterminado");
  }

  sec("Segunda instância do servidor");
  {
    const r = join(RAIZ, "segunda");
    mkdirSync(r, { recursive: true });
    const banco = dbEm(r);
    await prepararBanco(banco);
    const porta = await portaLivre();
    const env = envRaiz(r, { MESTRE_PORTA: String(porta) });
    const p1 = subirServidor(porta, { banco, arquivos: join(r, "arquivos", "campanhas"), backups: join(r, "backups") });
    await esperarSaudavel(`http://127.0.0.1:${porta}`, p1);
    t("primeira instância saudável", true);
    t("arquivo de trava existe enquanto servidor roda", existsSync(travaEm(r)));
    t("verificarTravaInstancia → em_uso", verificarTravaInstancia(banco) === "em_uso");

    // segunda instância: porta livre, MESMO banco → deve morrer na trava
    const porta2 = await portaLivre();
    const p2 = spawn("node", [INDICE], { env: { ...env, MESTRE_PORTA: String(porta2) }, stdio: ["ignore", "pipe", "pipe"] });
    let saida2 = "";
    p2.stdout.on("data", (d) => saida2 += d);
    p2.stderr.on("data", (d) => saida2 += d);
    const code2 = await Promise.race([
      new Promise((res) => p2.on("exit", res)),
      new Promise((res) => setTimeout(() => { try { p2.kill("SIGKILL"); } catch { } res("TIMEOUT"); }, 20000)),
    ]);
    if (code2 === "TIMEOUT") { fail++; console.log("  FALHOU segunda instância não morreu em 20s"); }
    else t("segunda instância morre (exit != 0)", code2 !== 0, `code=${code2}`);
    t("mensagem indica trava de instância", /instância|trava/i.test(saida2), saida2.slice(-200));

    // primeiro servidor continua intacto
    const h = await fetch(`http://127.0.0.1:${porta}/api/health`).then((x) => x.ok).catch(() => false);
    t("primeira instância segue saudável", h);
    await encerrarServidor(p1);
    t("após encerrar → trava livre", verificarTravaInstancia(banco) === "livre");
  }

  sec("Servidor ativo impede restauração");
  {
    const r = join(RAIZ, "ativo");
    mkdirSync(r, { recursive: true });
    const banco = dbEm(r);
    await prepararBanco(banco);
    mkdirSync(join(r, "arquivos", "campanhas"), { recursive: true });
    writeFileSync(join(r, "arquivos", "campanhas", "doc_vivo.txt"), "vivo");
    const bk = fazerBackup(r, "bk_com_servidor");
    armarFlag(r, bk);
    const antes = {
      flag: flagPendente(banco),
      doc: readFileSync(join(r, "arquivos", "campanhas", "doc_vivo.txt"), "utf8"),
      cfg: existsSync(join(r, "configuracao", "servidor.json")) ? readFileSync(join(r, "configuracao", "servidor.json"), "utf8") : null,
      preRestore: readdirSyncSafe(join(r, "backups")).filter((f) => f.startsWith("pre_restore_")),
    };

    const porta = await portaLivre();
    const p = subirServidor(porta, { banco, arquivos: join(r, "arquivos", "campanhas"), backups: join(r, "backups") });
    await esperarSaudavel(`http://127.0.0.1:${porta}`, p);
    const rest = restaurar(r);
    t("restaurador aborta com servidor ativo (exit != 0)", rest.code !== 0, `code=${rest.code} ${rest.saida.slice(-200)}`);
    t("flag preservada para retry", flagPendente(banco) === antes.flag);
    t("documento vivo intacto", readFileSync(join(r, "arquivos", "campanhas", "doc_vivo.txt"), "utf8") === antes.doc);
    t("nenhum pre_restore_* criado", readdirSyncSafe(join(r, "backups")).filter((f) => f.startsWith("pre_restore_")).length === 0);
    await encerrarServidor(p);
    // após encerrar, a mesma restauração pendente é aplicada no retry
    const rest2 = restaurar(r);
    t("após encerrar, retry restaura (exit 0)", rest2.code === 0, rest2.saida.slice(-300));
    t("flag limpa após sucesso", flagPendente(banco) === null, String(flagPendente(banco)));
    t("arquivo do backup aplicado", existsSync(join(r, "arquivos", "campanhas", "doc_bk.txt")));
  }

  sec("Encerramento inesperado (kill -9) libera a trava");
  {
    const r = join(RAIZ, "kill9");
    mkdirSync(r, { recursive: true });
    const banco = dbEm(r);
    await prepararBanco(banco);
    const bk = fazerBackup(r, "bk_kill");
    armarFlag(r, bk);
    const porta = await portaLivre();
    const p = subirServidor(porta, { banco, arquivos: join(r, "arquivos", "campanhas"), backups: join(r, "backups") });
    await esperarSaudavel(`http://127.0.0.1:${porta}`, p);
    t("trava em_uso com servidor", verificarTravaInstancia(banco) === "em_uso");
    p.kill("SIGKILL");
    await new Promise((res) => p.on("exit", res));
    t("após kill -9 → trava livre (lock do SO liberado)", verificarTravaInstancia(banco) === "livre");
    const rest = restaurar(r);
    t("restauração prossegue sem servidor", rest.code === 0, rest.saida.slice(-200));
    t("flag limpa", flagPendente(banco) === null);
  }

  sec("Trava corrompida → aborto seguro");
  {
    const r = join(RAIZ, "corrompida");
    mkdirSync(join(r, "banco"), { recursive: true });
    await prepararBanco(dbEm(r));
    const bk = fazerBackup(r, "bk_corr");
    armarFlag(r, bk);
    writeFileSync(travaEm(r), "isto-nao-e-um-sqlite-db");
    const antes = flagPendente(dbEm(r));
    const rest = restaurar(r);
    t("restaurador aborta (exit != 0)", rest.code !== 0, `code=${rest.code}`);
    t("flag preservada", flagPendente(dbEm(r)) === antes);
    t("nenhum pre_restore_* criado", readdirSyncSafe(join(r, "backups")).filter((f) => f.startsWith("pre_restore_")).length === 0);
    t("doc do backup NÃO aplicado", !existsSync(join(r, "arquivos", "campanhas", "doc_bk.txt")));
  }

  sec("Concorrência real — restaurador ADQUIRE e MANTÉM a trava");
  {
    const r = join(RAIZ, "concorrencia");
    mkdirSync(join(r, "arquivos", "campanhas"), { recursive: true });
    writeFileSync(join(r, "arquivos", "campanhas", "doc_vivo.txt"), "vivo");
    await prepararBanco(dbEm(r));
    const bk = fazerBackup(r, "bk_corrida");
    armarFlag(r, bk);
    const gate = join(r, "gate");
    mkdirSync(gate, { recursive: true });
    const env = envRaiz(r, { MESTRE_TRAVA_GATE_DIR: gate });

    // 1º restaurador: adquire a trava e pausa no gate "apos-trava"
    const r1 = restaurarProc(r, env);
    const travou = await esperarCond(() => verificarTravaInstancia(dbEm(r)) === "em_uso");
    t("restaurador adquiriu a trava (em_uso enquanto pausado)", travou);

    // Com a trava segurada, um SEGUNDO SERVIDOR não pode iniciar
    const porta = await portaLivre();
    const p2 = spawn("node", [INDICE], {
      env: { ...env, MESTRE_PORTA: String(porta) }, stdio: ["ignore", "pipe", "pipe"],
    });
    let saida2 = "";
    p2.stdout.on("data", (d) => saida2 += d);
    p2.stderr.on("data", (d) => saida2 += d);
    const code2 = await Promise.race([
      new Promise((res) => p2.on("exit", res)),
      new Promise((res) => setTimeout(() => { try { p2.kill("SIGKILL"); } catch { } res("TIMEOUT"); }, 20000)),
    ]);
    t("2º servidor bloqueado pela trava do restaurador", code2 !== 0 && code2 !== "TIMEOUT", `code=${code2}`);
    t("mensagem de trava no 2º servidor", /instância|trava/i.test(saida2));

    // E uma SEGUNDA restauração simultânea também é bloqueada
    const r3 = restaurarProc(r, env);
    const fim3 = await Promise.race([
      r3.fim,
      new Promise((res) => setTimeout(() => res({ code: "TIMEOUT", saida: "" }), 20000)),
    ]);
    t("2ª restauração simultânea aborta (exit 2)", fim3.code === 2, `code=${fim3.code}`);
    t("nada alterado pela tentativa bloqueada", flagPendente(dbEm(r)) !== null &&
      readFileSync(join(r, "arquivos", "campanhas", "doc_vivo.txt"), "utf8") === "vivo");

    // Libera o gate: o 1º restaurador conclui e libera a trava
    writeFileSync(join(gate, "apos-trava"), "1");
    const fim1 = await Promise.race([
      r1.fim,
      new Promise((res) => setTimeout(() => { try { r1.p.kill("SIGKILL"); } catch { } res({ code: "TIMEOUT", saida: "" }); }, 30000)),
    ]);
    t("1ª restauração conclui (exit 0)", fim1.code === 0, `code=${fim1.code} ${fim1.saida.slice(-300)}`);
    t("flag limpa após sucesso", flagPendente(dbEm(r)) === null);
    t("arquivo do backup aplicado", existsSync(join(r, "arquivos", "campanhas", "doc_bk.txt")));
    t("trava livre após sucesso", verificarTravaInstancia(dbEm(r)) === "livre");
  }

  sec("Rollback mantém a trava até o fim (POSIX)");
  if (process.platform === "win32") {
    t("cenário de permissões POSIX — pulado no Windows (coberto no CI Linux)", true);
  } else {
    const r = join(RAIZ, "rollback");
    mkdirSync(join(r, "arquivos", "campanhas"), { recursive: true });
    mkdirSync(join(r, "configuracao"), { recursive: true });
    writeFileSync(join(r, "arquivos", "campanhas", "doc_vivo.txt"), "vivo");
    writeFileSync(join(r, "configuracao", "servidor.json"), JSON.stringify({ cfg: "viva" }));
    await prepararBanco(dbEm(r));
    const bk = fazerBackup(r, "bk_rollback");
    armarFlag(r, bk);
    const gate = join(r, "gate");
    mkdirSync(gate, { recursive: true });
    const env = envRaiz(r, { MESTRE_TRAVA_GATE_DIR: gate });

    // configuracao/ somente-leitura E o arquivo 0444: a aplicação falha
    // ao remover a config e o rollback falha ao sobrescrevê-la
    // (copyFileSync precisa de escrita no ARQUIVO, não no diretório) →
    // ROLLBACK FALHOU de verdade.
    chmodSync(join(r, "configuracao"), 0o555);
    chmodSync(join(r, "configuracao", "servidor.json"), 0o444);
    const r1 = restaurarProc(r, env);
    try {
      await esperarCond(() => verificarTravaInstancia(dbEm(r)) === "em_uso");
      writeFileSync(join(gate, "apos-trava"), "1"); // passa o 1º gate → vai para aplicação
      // espera o processo chegar ao gate pós-rollback (log de rollback antes dele)
      const chegou = await esperarCond(() => /Rollback (concluído|FALHOU)/.test(r1.saida()), 30000, 100);
      t("rollback executado e processo pausado no gate pós-rollback", chegou, r1.saida().slice(-300));

      // Trava AINDA segurada durante a pausa pós-rollback: 2º restaurador bloqueado
      t("trava ainda em_uso durante pausa pós-rollback", verificarTravaInstancia(dbEm(r)) === "em_uso");
      const r3 = restaurarProc(r, env);
      const fim3 = await Promise.race([
        r3.fim,
        new Promise((res) => setTimeout(() => res({ code: "TIMEOUT", saida: "" }), 20000)),
      ]);
      t("2ª restauração bloqueada mesmo após falha do 1º", fim3.code === 2, `code=${fim3.code}`);

      writeFileSync(join(gate, "apos-rollback"), "1");
      const fim1 = await Promise.race([
        r1.fim,
        new Promise((res) => setTimeout(() => { try { r1.p.kill("SIGKILL"); } catch { } res({ code: "TIMEOUT", saida: "" }); }, 20000)),
      ]);
      t("restaurador sai com erro após rollback falho", fim1.code === 1, `code=${fim1.code}`);
      t("log confirma ROLLBACK FALHOU", /ROLLBACK FALHOU/.test(fim1.saida), fim1.saida.slice(-300));
      t("estado anterior preservado em pre_restore_*", readdirSyncSafe(join(r, "backups")).some((f) => f.startsWith("pre_restore_")));
      t("flag preservada para retry manual", flagPendente(dbEm(r)) !== null);
      t("trava liberada só após encerramento", verificarTravaInstancia(dbEm(r)) === "livre");
    } finally {
      chmodSync(join(r, "configuracao", "servidor.json"), 0o644);
      chmodSync(join(r, "configuracao"), 0o755);
      try { r1.p.kill("SIGKILL"); } catch { }
    }
  }

  sec("Inicialização limpa sem trava prévia");
  {
    const r = join(RAIZ, "limpa");
    mkdirSync(r, { recursive: true });
    const banco = dbEm(r);
    await prepararBanco(banco);
    const porta = await portaLivre();
    const p = subirServidor(porta, { banco, arquivos: join(r, "arquivos", "campanhas"), backups: join(r, "backups") });
    await esperarSaudavel(`http://127.0.0.1:${porta}`, p);
    t("servidor sobe e cria trava", existsSync(travaEm(r)));
    const h = await fetch(`http://127.0.0.1:${porta}/api/health`).then((x) => x.ok).catch(() => false);
    t("health OK", h);
    await encerrarServidor(p);
    t("trava liberada no encerramento", verificarTravaInstancia(banco) === "livre");
    rmSync(travaEm(r), { force: true }); // limpeza do diretório de teste
  }
} finally {
  limparDir(RAIZ);
  console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
  process.exit(fail ? 1 : 0);
}

function readdirSyncSafe(dir) {
  try { return readdirSync(dir); } catch { return []; }
}
