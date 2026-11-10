// Aplica restauração pendente de backup — executar com o servidor PARADO.
// Uso: node dist/db/aplicar-restauracao.js
// MESTRE_HOME pode apontar para uma raiz alternativa (testes/sandbox).
//
// Ordem de boot (iniciar-mestre-rpg.bat): builds -> ESTE SCRIPT -> db:migrate -> start.
// Garantias:
//  - banco/ e diretórios são criados se ausentes (primeira instalação);
//  - backup é validado (integrity_check) antes de tocar em qualquer arquivo;
//  - estado anterior (banco+sidecars, arquivos, config) é preservado em
//    backups/pre_restore_<ts> ANTES da aplicação;
//  - qualquer falha desfaz banco E arquivos/config e sai com código != 0;
//  - sucesso só é declarado após confirmar que a flag foi removida do banco
//    restaurado; falha na limpeza dispara rollback completo.
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = process.env.MESTRE_HOME ?? resolve(__dirname, "..", "..", "..");
// Mesmos overrides do servidor (db/index.ts) — o restaurador DEVE operar
// sobre os mesmos caminhos que o servidor usará, senão restaura o arquivo errado.
const DB_VIVA = process.env.MESTRE_BANCO ? resolve(process.env.MESTRE_BANCO) : resolve(RAIZ, "banco", "mestre-rpg.db");
const DIR_ARQUIVOS = process.env.MESTRE_ARQUIVOS ? resolve(process.env.MESTRE_ARQUIVOS) : resolve(RAIZ, "arquivos", "campanhas");
const DIR_BACKUPS = process.env.MESTRE_BACKUPS ? resolve(process.env.MESTRE_BACKUPS) : resolve(RAIZ, "backups");
const ARQ_CFG = resolve(RAIZ, "configuracao", "servidor.json");

function log(msg: string) { console.log(`[restauracao] ${msg}`); }

type VerificacaoBanco =
  | { status: "livre" }
  | { status: "em_uso"; pid: string }
  | { status: "indeterminado"; motivo: string };

const PROC_FS = process.env.MESTRE_PROC_FS ?? "/proc";
// MESTRE_PROC_FS permite apontar para uma árvore falsa em testes e força
// a inspeção mesmo fora do Linux.
const INSPECAO_ATIVA = process.platform === "linux" || !!process.env.MESTRE_PROC_FS;

/**
 * Verifica se o banco vivo (ou seus sidecars) está aberto por OUTRO
 * processo — fail-safe: só retorna "livre" quando a inspeção foi
 * concluída por completo. No Windows a trava de arquivo (EPERM) já
 * aborta a remoção; no Linux unlink sempre sucede mesmo com o arquivo
 * aberto — sem esta checagem o restore trocaria o conteúdo sob uma
 * conexão ativa (split-brain). Qualquer falha de leitura que impeça
 * provar que o banco está livre retorna "indeterminado" e o chamador
 * aborta ANTES de qualquer escrita.
 *
 * Processos de outros usuários são ignorados: um uid diferente não
 * consegue abrir um banco dentro do MESTRE_HOME do usuário (permissão
 * de diretório), e o /proc/<pid>/fd deles é ilegível por desenho.
 * Processo que some durante a varredura (ENOENT/ESRCH) já liberou os
 * descritores — ignorá-lo é seguro.
 *
 * Limite do procfs: processos não-dumpable (dumpable=0) têm fd/cmdline
 * ilegíveis por desenho do kernel — NENHUM usuário sem CAP_SYS_PTRACE
 * consegue inspecioná-los. São detectados quando a inspeção de fd falha
 * mas /proc/<pid>/cmdline também está vazio/negado; esses são ignorados
 * (o servidor e qualquer cliente SQLite normal rodam dumpable). Qualquer
 * OUTRA falha de inspeção continua retornando "indeterminado" e aborta.
 */

/**
 * Classifica um pid cuja inspeção de fd falhou:
 *  - "nao_dumpable": cmdline vazio ou negado — limite do procfs, ignora;
 *  - "dumpable": cmdline legível — processo normal com fd quebrado,
 *    inspeção realmente inconclusiva;
 *  - "indeterminado": cmdline ausente/erro inesperado — não dá para
 *    distinguir, fail-safe.
 */
function classePidAposFalha(pid: string): { classe: "nao_dumpable" | "dumpable" | "indeterminado"; cmdline: string } {
  try {
    const cmd = readFileSync(`${PROC_FS}/${pid}/cmdline`, "utf8");
    const trecho = cmd.replace(/\0/g, " ").trim().slice(0, 120);
    return { classe: cmd.trim().length ? "dumpable" : "nao_dumpable", cmdline: trecho };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return { classe: "nao_dumpable", cmdline: "" };
    return { classe: "indeterminado", cmdline: "" };
  }
}

type InspPid = { r: "ok" } | { r: "em_uso" } | { r: "negado"; detalhe: string } | { r: "sumiu" };

function inspecionarPid(pid: string, pidDir: string, alvos: Set<string>, meuUid: number | null): InspPid {
  let uid: number | null = null;
  try { uid = statSync(pidDir).uid; }
  catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { r: "sumiu" };
    return { r: "negado", detalhe: `stat de pid ${pid} falhou: ${code ?? e}` };
  }
  // Processo de outro usuário: não pode deter o banco do MESTRE_HOME.
  if (uid !== null && meuUid !== null && uid !== meuUid) return { r: "ok" };
  let fds: string[];
  try {
    fds = readdirSync(`${pidDir}/fd`);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { r: "sumiu" };
    return { r: "negado", detalhe: `fd de pid ${pid} ilegível (${code ?? e})` };
  }
  for (const fd of fds) {
    let alvo: string;
    try {
      alvo = readlinkSync(`${pidDir}/fd/${fd}`);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue; // fd fechou durante a varredura
      // EACCES num fd individual: alvo não resolvível (O_PATH, fd de
      // outro mount/user namespace, etc.) — os demais fds do processo
      // continuam inspecionados; o risco residual é documentado.
      if (code === "EACCES") continue;
      return { r: "negado", detalhe: `fd ${fd} de pid ${pid} ilegível (${code ?? e})` };
    }
    if (alvos.has(resolve(alvo))) return { r: "em_uso" };
  }
  return { r: "ok" };
}

function verificarBancoEmUso(): VerificacaoBanco {
  if (!INSPECAO_ATIVA) return { status: "livre" };
  const alvos = new Set(["", "-wal", "-shm"].map((s) => resolve(DB_VIVA + s)));
  const meuUid = typeof process.getuid === "function" ? process.getuid() : null;
  let pids: string[];
  try {
    pids = readdirSync(PROC_FS);
  } catch (e) {
    return { status: "indeterminado", motivo: `não foi possível ler ${PROC_FS}: ${e instanceof Error ? e.message : e}` };
  }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    const insp = inspecionarPid(pid, `${PROC_FS}/${pid}`, alvos, meuUid);
    if (insp.r === "em_uso") return { status: "em_uso", pid };
    if (insp.r === "negado") {
      // Só o limite do procfs (processo não-dumpable) é ignorado;
      // qualquer outra falha de inspeção aborta por segurança.
      const { classe, cmdline } = classePidAposFalha(pid);
      if (classe === "nao_dumpable") continue;
      return {
        status: "indeterminado",
        motivo: `${insp.detalhe} — ${classe === "dumpable" ? `dumpable: ${cmdline}` : `cmdline do pid ${pid} indisponível`}`,
      };
    }
  }
  return { status: "livre" };
}

/** Remove a flag de restauração pendente do banco em DB_VIVA e CONFIRMA a remoção. */
function limparFlag() {
  const d = new Database(DB_VIVA);
  try {
    d.prepare("delete from server_settings where key='restauracao_pendente'").run();
    const resto = d.prepare("select value from server_settings where key='restauracao_pendente'").get();
    if (resto) throw new Error("flag restauracao_pendente continua presente após delete");
  } finally { d.close(); }
}

async function principal() {
  // 0) primeira instalação: banco/ pode não existir — cria o diretório pai
  //    do caminho efetivamente configurado (nada fora de MESTRE_*).
  if (!existsSync(DB_VIVA)) {
    mkdirSync(dirname(DB_VIVA), { recursive: true });
    log(`Banco inexistente em ${DB_VIVA} — nada a restaurar (instalação limpa).`);
    return;
  }

  // 1) lê a flag pendente e fecha a conexão ANTES de mexer nos arquivos (Windows trava arquivo aberto)
  let pendente: { filePath?: string } | null = null;
  {
    const db = new Database(DB_VIVA);
    let row: { value: string } | undefined;
    try {
      row = db.prepare("select value from server_settings where key='restauracao_pendente'").get() as { value: string } | undefined;
    } catch {
      db.close();
      log("Banco sem tabela server_settings — nada a restaurar.");
      return;
    }
    db.close();
    if (!row) { log("Nenhuma restauração pendente."); return; }
    pendente = JSON.parse(row.value);
  }
  const backupDir = pendente?.filePath;
  if (!backupDir || !existsSync(backupDir)) {
    // backup alvo não existe mais — nada foi alterado; limpa a flag, mas
    // sai com código de erro para o inicializador NÃO subir sobre um
    // pedido de restauração que não aconteceu (admin precisa decidir).
    log(`ERRO: pasta do backup não existe: ${backupDir} — restauração cancelada, sistema segue com dados atuais.`);
    limparFlag();
    process.exit(2);
  }

  // 2) valida o banco do backup antes de tocar em qualquer coisa
  const dbBackup = join(backupDir, "mestre-rpg.db");
  if (!existsSync(dbBackup)) {
    log("ERRO: backup sem mestre-rpg.db — restauração cancelada.");
    limparFlag();
    process.exit(2);
  }
  let integ = "erro";
  try {
    const chk = new Database(dbBackup, { readonly: true });
    integ = String(chk.pragma("integrity_check", { simple: true }));
    chk.close();
  } catch (e) {
    integ = `exceção: ${e}`;
  }
  if (integ !== "ok") {
    log(`ERRO: backup corrompido (${String(integ).slice(0, 120)}) — restauração cancelada.`);
    limparFlag();
    process.exit(2);
  }

  // 2b) validação estrutural ANTES de tocar em qualquer arquivo vivo:
  //     ausência é intencional (snapshot sem aquele conteúdo); tipo
  //     errado ou link simbólico tornam o backup inválido.
  const dirArqBackup = join(backupDir, "arquivos");
  const dirCfgBackup = join(backupDir, "configuracao");
  const cfgBackup = join(dirCfgBackup, "servidor.json");
  const lst = (p: string) => { try { return lstatSync(p); } catch { return null; } };
  const problemas: string[] = [];
  const stArq = lst(dirArqBackup);
  if (stArq && (stArq.isSymbolicLink() || !stArq.isDirectory())) problemas.push("backup/arquivos não é diretório real");
  const stCfgDir = lst(dirCfgBackup);
  if (stCfgDir && (stCfgDir.isSymbolicLink() || !stCfgDir.isDirectory())) problemas.push("backup/configuracao não é diretório");
  const stCfg = lst(cfgBackup);
  if (stCfg && (stCfg.isSymbolicLink() || !stCfg.isFile())) problemas.push("backup/configuracao/servidor.json não é arquivo regular");
  if (problemas.length) {
    log(`ERRO: estrutura inválida no backup (${problemas.join("; ")}) — restauração cancelada.`);
    limparFlag();
    process.exit(2);
  }

  // 3) fail-safe: o banco vivo não pode estar aberto por outro processo
  //    E a verificação precisa ter sido concluída. "indeterminado" aborta
  //    igual a "em_uso" — falha de inspeção nunca autoriza a escrita.
  //    Nada foi tocado: a flag fica para retry.
  const verif = verificarBancoEmUso();
  if (verif.status === "em_uso") {
    log(`ERRO: banco em uso por pid ${verif.pid} — restauração exige o servidor parado. Nada foi alterado; flag preservada para retry.`);
    process.exit(2);
  }
  if (verif.status === "indeterminado") {
    log(`ERRO: verificação de banco em uso inconclusiva (${verif.motivo}) — restauração abortada por segurança antes de qualquer escrita; flag preservada para retry.`);
    process.exit(2);
  }

  // 4) preserva o estado anterior ANTES de aplicar — SOMENTE CÓPIAS:
  //    banco+sidecars, arquivos de campanha e configuração vão para
  //    backups/pre_restore_<ts>. Os originais ficam no lugar; se a
  //    preservação falhar, nada foi alterado e o boot é abortado.
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const lado = join(DIR_BACKUPS, `pre_restore_${ts}`);
  const tinhaArquivos = existsSync(DIR_ARQUIVOS);
  const tinhaCfg = existsSync(ARQ_CFG);
  try {
    mkdirSync(lado, { recursive: true });
    for (const suf of ["", "-wal", "-shm"]) {
      const atual = DB_VIVA + suf;
      if (existsSync(atual)) copyFileSync(atual, join(lado, `mestre-rpg.db${suf}`));
    }
    if (tinhaArquivos) cpSync(DIR_ARQUIVOS, join(lado, "arquivos"), { recursive: true });
    if (tinhaCfg) {
      mkdirSync(join(lado, "configuracao"), { recursive: true });
      copyFileSync(ARQ_CFG, join(lado, "configuracao", "servidor.json"));
    }
  } catch (e) {
    log(`FALHA ao preservar estado anterior: ${e} — nada foi alterado; backup parcial em ${lado}`);
    process.exit(1);
  }

  // 5) aplicação: banco, arquivos, config e flag — qualquer falha desfaz
  //    TUDO a partir das cópias em `lado` (inclusive removendo o que a
  //    aplicação criou quando não existia antes).
  const reverter = () => {
    // remove sidecars que a tentativa possa ter deixado e restaura
    // somente os que existiam na preservação — nunca mistura WAL de
    // um banco com o arquivo de outro.
    for (const suf of ["-wal", "-shm"]) rmSync(DB_VIVA + suf, { force: true });
    for (const suf of ["", "-wal", "-shm"]) {
      const ladoArq = join(lado, `mestre-rpg.db${suf}`);
      if (existsSync(ladoArq)) copyFileSync(ladoArq, DB_VIVA + suf);
    }
    if (tinhaArquivos) {
      // substituição completa: cpSync mescla e deixaria arquivos do backup
      rmSync(DIR_ARQUIVOS, { recursive: true, force: true });
      cpSync(join(lado, "arquivos"), DIR_ARQUIVOS, { recursive: true });
    } else if (existsSync(DIR_ARQUIVOS)) {
      rmSync(DIR_ARQUIVOS, { recursive: true, force: true });
    }
    const cfgLado = join(lado, "configuracao", "servidor.json");
    if (tinhaCfg) {
      mkdirSync(dirname(ARQ_CFG), { recursive: true });
      copyFileSync(cfgLado, ARQ_CFG);
    } else if (existsSync(ARQ_CFG)) {
      rmSync(ARQ_CFG, { force: true });
    }
  };
  try {
    // remove sidecars do banco anterior ANTES de trocar o arquivo —
    // um WAL/SHM órfão não pode ficar associado ao banco restaurado.
    for (const suf of ["-wal", "-shm"]) rmSync(DB_VIVA + suf, { force: true });
    copyFileSync(dbBackup, DB_VIVA);
    // sidecars do próprio backup (quando existirem) acompanham o banco
    for (const suf of ["-wal", "-shm"]) {
      const bkSide = join(backupDir, `mestre-rpg.db${suf}`);
      if (existsSync(bkSide)) copyFileSync(bkSide, DB_VIVA + suf);
    }
    // Snapshot fiel: o destino vivo passa a ser EXATAMENTE o que o backup
    // contém — se o backup não tem 'arquivos', o vivo fica sem arquivos;
    // se não tem config, o vivo fica sem config (servidor usa os defaults).
    // Tipos já foram validados antes da preservação (etapa 2b).
    rmSync(DIR_ARQUIVOS, { recursive: true, force: true });
    if (existsSync(dirArqBackup)) cpSync(dirArqBackup, DIR_ARQUIVOS, { recursive: true });
    rmSync(ARQ_CFG, { force: true });
    if (existsSync(cfgBackup)) {
      mkdirSync(dirname(ARQ_CFG), { recursive: true });
      copyFileSync(cfgBackup, ARQ_CFG);
    }
    // flag é limpa DENTRO do banco restaurado e a remoção é confirmada —
    // se falhar, o catch abaixo desfaz TUDO (banco antigo volta com a flag).
    limparFlag();
    log(`Restauração aplicada de ${backupDir}`);
    log(`Estado anterior preservado em ${lado}`);
  } catch (e) {
    log(`FALHA: ${e}. Revertendo estado anterior completo...`);
    try {
      reverter();
      log("Rollback concluído — sistema voltou ao estado anterior (banco, arquivos e config).");
    } catch (e2) {
      log(`ROLLBACK FALHOU: ${e2} — estado anterior preservado em ${lado}`);
    }
    process.exit(1);
  }
}

principal().catch((e) => { console.error(e); process.exit(1); });
