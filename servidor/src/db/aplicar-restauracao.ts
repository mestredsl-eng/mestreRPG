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
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { fileURLToPath, pathToFileURL } from "node:url";
import { adquirirTravaRestauracao, aguardarGateTrava, TravaIndisponivel } from "./trava-instancia.js";
import { validarBackup } from "../lib/validar-backup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// RAIZ = raiz de DADOS (MESTRE_HOME em testes/sandbox). REPO_ROOT é a
// instalação real — usada para identidade do estado externo.
const RAIZ = process.env.MESTRE_HOME ?? resolve(__dirname, "..", "..", "..");
const REPO_ROOT = resolve(__dirname, "..", "..", "..");
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
 * Limite do procfs: quando o kernel nega a inspeção de fd de um
 * processo (não-dumpable, helper de sessão como sd-pam, outro mount/
 * user namespace), NENHUM usuário sem CAP_SYS_PTRACE consegue ver seus
 * descritores — não existe inspeção "mais completa" possível. Esses
 * processos são ignorados e contados no log. O que continua fail-safe:
 * procfs ausente/ilegível, estrutura malformada e erros inesperados
 * retornam "indeterminado" e abortam ANTES de qualquer escrita.
 * Risco residual documentado: um processo capaz de esconder seus fds
 * do procfs poderia teoricamente deter o banco sem ser detectado —
 * mitigado porque só o servidor abre o banco e o boot o exige parado.
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
  let ignorados = 0;
  for (const pid of pids) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    const insp = inspecionarPid(pid, `${PROC_FS}/${pid}`, alvos, meuUid);
    if (insp.r === "em_uso") return { status: "em_uso", pid };
    if (insp.r === "negado") {
      // O kernel negou a inspeção de fd: limite do procfs, não falha de
      // leitura. Confirmamos a classe via cmdline — se nem isso for
      // legível de forma classificável, a estrutura é inesperada e
      // abortamos (fail-safe). Processos ignorados são contados.
      const { classe, cmdline } = classePidAposFalha(pid);
      if (classe === "indeterminado") {
        return { status: "indeterminado", motivo: `${insp.detalhe} — cmdline do pid ${pid} indisponível` };
      }
      ignorados++;
      if (ignorados <= 3) log(`pid ${pid} não inspecionável via procfs (${insp.detalhe})${cmdline ? ` — ${cmdline}` : ""}`);
      continue;
    }
  }
  if (ignorados) log(`${ignorados} processo(s) não inspecionáveis ignorados (limite do procfs)`);
  return { status: "livre" };
}

/** Remove a flag de restauração pendente do banco em DB_VIVA e CONFIRMA a remoção. */
function limparFlag() {
  // Sem arquivo de banco não existe flag — nada a confirmar.
  if (!existsSync(DB_VIVA)) return;
  const d = new Database(DB_VIVA);
  try {
    d.prepare("delete from server_settings where key='restauracao_pendente'").run();
    const resto = d.prepare("select value from server_settings where key='restauracao_pendente'").get();
    if (resto) throw new Error("flag restauracao_pendente continua presente após delete");
  } finally { d.close(); }
}

// ---------- journal externo de restauração (Issue #155) ----------
// O banco vivo NÃO é a única fonte de verdade: a intenção e os checkpoints
// por componente (banco, sidecars, arquivos, configuracao, flag) ficam em
// <stateDir>/restauracao-externa.json — fora do worktree e do banco,
// gravados atomicamente ANTES de cada substituição. Uma queda no meio da
// aplicação ou do rollback é retomada a partir deste journal.
// NÃO há atomicidade conjunta entre os componentes: a retomada refaz
// apenas os componentes ainda não concluídos.

interface EeModulo {
  dirEstado(repoDir: string, env?: NodeJS.ProcessEnv): string;
  instalacaoId(repoDir: string): string;
  caminhoCanonico(repoDir: string): string;
  gravarJsonAtomico(caminho: string, obj: unknown): void;
  gravarEstado(repoDir: string, nome: string, dados: unknown, env?: NodeJS.ProcessEnv): unknown;
  lerJournal(repoDir: string, nome: string, env?: NodeJS.ProcessEnv): {
    status: string; dados?: Record<string, unknown>; quarentena?: string | null;
  };
  provarInstalacaoNova(repoDir: string, env?: NodeJS.ProcessEnv): { nova: boolean; motivo?: string };
}

const JOURNAL_REST = "restauracao-externa.json";
const FASES_FINAIS = new Set(["concluido", "rollback-concluido"]);
const COMPONENTES = ["banco", "sidecars", "arquivos", "configuracao", "flag"] as const;
type Componente = (typeof COMPONENTES)[number];

let ee: EeModulo | null = null;
async function estadoExterno(): Promise<EeModulo> {
  if (ee) return ee;
  const mod = await import(pathToFileURL(join(REPO_ROOT, "scripts", "estado-externo.mjs")).href);
  ee = mod as unknown as EeModulo;
  return ee;
}

interface JournalRest {
  fase: string;
  backupDir?: string;
  preRestoreDir?: string;
  tinhaArquivos?: boolean;
  tinhaCfg?: boolean;
  componentes: Record<string, { estado: string }>;
  em?: string;
  atualizadoEm?: string;
}

function componentesPendentes(): Record<string, { estado: string }> {
  return Object.fromEntries(COMPONENTES.map((c) => [c, { estado: "pendente" }]));
}

function journalBase(): JournalRest {
  return {
    fase: "intencao",
    componentes: componentesPendentes(),
    atualizadoEm: new Date().toISOString(),
  };
}

async function gravarJournal(parcial: Partial<JournalRest> & { fase: string }) {
  const atual = journalCarregado ?? journalBase();
  const mesclado: JournalRest = {
    ...atual, ...parcial,
    componentes: { ...atual.componentes, ...(parcial.componentes ?? {}) },
    atualizadoEm: new Date().toISOString(),
  };
  // fase final nunca retrocede para pendente por merge acidental
  if (FASES_FINAIS.has(atual.fase) && !FASES_FINAIS.has(parcial.fase) && parcial.fase !== atual.fase) {
    // nova operação sobre journal concluído: componentes recomeçam
    mesclado.componentes = { ...componentesPendentes(), ...(parcial.componentes ?? {}) };
  }
  const mod = await estadoExterno();
  mod.gravarEstado(REPO_ROOT, JOURNAL_REST, mesclado, process.env);
  journalCarregado = mesclado;
}

let journalCarregado: JournalRest | null = null;

async function lerJournalRest(): Promise<{ status: string; dados?: JournalRest }> {
  const mod = await estadoExterno();
  const r = mod.lerJournal(REPO_ROOT, JOURNAL_REST, process.env);
  if (r.status === "ok" && r.dados) journalCarregado = r.dados as unknown as JournalRest;
  return r as { status: string; dados?: JournalRest };
}

async function checkpoint(componente: Componente, estado: string) {
  await gravarJournal({
    fase: journalCarregado?.fase ?? "intencao",
    componentes: { [componente]: { estado } } as JournalRest["componentes"],
  });
}

async function principal() {
  // 0) JOURNAL EXTERNO PRIMEIRO — antes de qualquer fast path por
  //    ausência do banco. O journal é a fonte de verdade para
  //    aplicação/rollback interrompidos: um journal pendente NUNCA pode
  //    ser ignorado só porque DB_VIVA não existe no disco.
  const jr = await lerJournalRest();
  if (jr.status !== "ausente" && jr.status !== "ok") {
    log(`ERRO: journal externo de restauração ${jr.status} — abortando por segurança (estado preservado em quarentena).`);
    process.exit(2);
  }
  const journalPendente = jr.status === "ok" && jr.dados?.fase && !FASES_FINAIS.has(jr.dados.fase);
  const faseJournal = journalPendente ? String(jr.dados?.fase) : "";
  const retomarRollback = faseJournal.startsWith("rollback");
  const retomarAplicacao = journalPendente && !retomarRollback;

  // 0b) banco ausente: só é "nada a restaurar" com recibo durável de
  //     instalação. Com journal pendente, segue para retomada — o
  //     backupDir/preRestoreDir vêm do journal, não do banco.
  const dbExiste = existsSync(DB_VIVA);
  if (!dbExiste && !journalPendente) {
    const mod = await estadoExterno();
    const prova = mod.provarInstalacaoNova(REPO_ROOT, process.env);
    if (!prova.nova) {
      log(`ERRO: banco inexistente, sem journal e sem recibo de instalação verificável (${prova.motivo ?? "sem prova"}) — estado ambíguo, restauração abortada por segurança.`);
      process.exit(2);
    }
    mkdirSync(dirname(DB_VIVA), { recursive: true });
    log("Banco inexistente — instalação inicial comprovada por recibo; nada a restaurar.");
    return;
  }

  // 1) lê a flag pendente e fecha a conexão ANTES de mexer nos arquivos
  //    (Windows trava arquivo aberto). FAIL-CLOSED: qualquer erro de
  //    leitura/SQL/corrupção aborta — nunca classificado como ausência.
  //    Exceção: com journal de aplicação pendente, banco ilegível/corrompido
  //    não é "nada a restaurar" — é estado intermediário → rollback ao
  //    estado preservado (o journal é a fonte de verdade).
  let pendente: { filePath?: string } | null = null;
  let forcarRollback = retomarRollback;
  // Sem arquivo de banco não há flag a ler — journal pendente segue
  // adiante com backupDir/preRestoreDir do próprio journal.
  if (dbExiste && !retomarRollback) {
    let db: Database.Database | null = null;
    try {
      db = new Database(DB_VIVA);
    } catch (e) {
      if (!journalPendente) {
        log(`ERRO: banco existente não pôde ser aberto (${e}) — restauração abortada por segurança.`);
        process.exit(2);
      }
      forcarRollback = true;
    }
    if (db) {
      try {
        // prova de instalação inicial: banco vazio (zero tabelas) — não há
        // flag nem dados a perder; ausência de server_settings sozinha NÃO
        // prova inicialização.
        const total = (db.prepare("select count(*) as c from sqlite_master where type='table'").get() as { c: number }).c;
        if (total === 0) {
          db.close();
          if (journalPendente) {
            forcarRollback = true; // journal pendente + banco vazio = inesperado
          } else {
            // Banco vazio (0 tabelas) só é instalação inicial COM recibo
            // durável — banco vazio sozinho não prova nada.
            const mod = await estadoExterno();
            const prova = mod.provarInstalacaoNova(REPO_ROOT, process.env);
            if (!prova.nova) {
              log(`ERRO: banco vazio sem recibo de instalação verificável (${prova.motivo ?? "sem prova"}) — estado ambíguo, restauração abortada por segurança.`);
              process.exit(2);
            }
            log("Banco vazio — instalação inicial comprovada por recibo; nada a restaurar.");
            return;
          }
        } else {
          const temSettings = db.prepare("select name from sqlite_master where type='table' and name='server_settings'").get();
          if (!temSettings) {
            db.close();
            if (journalPendente) {
              forcarRollback = true;
            } else {
              log("ERRO: banco existente sem tabela server_settings — estado desconhecido, restauração abortada por segurança.");
              process.exit(2);
            }
          } else {
            const row = db.prepare("select value from server_settings where key='restauracao_pendente'").get() as { value: string } | undefined;
            db.close();
            if (row) {
              try {
                pendente = JSON.parse(row.value);
              } catch {
                if (journalPendente) forcarRollback = true;
                else {
                  log("ERRO: flag restauracao_pendente ilegível — abortando por segurança.");
                  process.exit(2);
                }
              }
            }
          }
        }
      } catch (e) {
        try { db.close(); } catch { /* ignora */ }
        if (journalPendente) forcarRollback = true;
        else {
          log(`ERRO: falha ao ler flag de restauração (${e}) — abortando por segurança.`);
          process.exit(2);
        }
      }
    }
  }

  if (!pendente && !retomarAplicacao && !forcarRollback) {
    log("Nenhuma restauração pendente.");
    return;
  }

  // Journal pendente SEM flag: a substituição pode ter ocorrido e a flag
  // sumido com o banco antigo — o journal manda; retoma a aplicação.
  const backupDir = retomarAplicacao
    ? ((jr.dados?.backupDir as string | undefined) ?? pendente?.filePath)
    : pendente?.filePath;
  if (!forcarRollback && (!backupDir || !existsSync(backupDir))) {
    if (retomarAplicacao) {
      log(`ERRO: journal indica restauração pendente mas backup '${backupDir}' não existe — abortando por segurança.`);
      process.exit(2);
    }
    // backup alvo não existe mais — nada foi alterado; limpa a flag, mas
    // sai com código de erro para o inicializador NÃO subir sobre um
    // pedido de restauração que não aconteceu (admin precisa decidir).
    log(`ERRO: pasta do backup não existe: ${backupDir} — restauração cancelada, sistema segue com dados atuais.`);
    limparFlag();
    process.exit(2);
  }
  const lado = jr.dados?.preRestoreDir as string | undefined;
  if (forcarRollback && (!lado || !existsSync(lado))) {
    log(`ERRO: rollback necessário mas estado preservado '${lado}' não existe — recuperação manual obrigatória.`);
    process.exit(2);
  }

  // 2) validação integral do backup que SERÁ aplicado, antes de tocar
  //    no estado vivo — manifesto v2, inventário real × declarado,
  //    tamanho+SHA-256, integridade SQLite, tipos de arquivo e rejeição
  //    de symlinks/traversal. Mesmo validador de backup.ts/verificarBackup
  //    (módulo neutro, sem banco/locks). Não confiamos em validação
  //    anterior da API: o backup é revalidado aqui, offline.
  //    (somente na aplicação — rollback usa o estado preservado `lado`,
  //    que é artefato nosso e não passa por manifesto).
  const dirArqBackup = join(String(backupDir), "arquivos");
  const dirCfgBackup = join(String(backupDir), "configuracao");
  const cfgBackup = join(dirCfgBackup, "servidor.json");
  if (!forcarRollback) {
    const v = validarBackup(String(backupDir));
    if (!v.ok) {
      log(`ERRO: backup inválido (${v.problemas.slice(0, 3).join("; ")}) — restauração cancelada antes de tocar no estado vivo.`);
      if (journalPendente) forcarRollback = true;
      else { limparFlag(); process.exit(2); }
    }
  }
  if (forcarRollback && !lado) {
    log("ERRO: rollback necessário mas journal não registra estado preservado — recuperação manual obrigatória.");
    process.exit(2);
  }

  // 3) exclusividade REAL antes de qualquer escrita: o restaurador
  //    ADQUIRE a mesma trava exclusiva do servidor e a mantém durante
  //    TODA a operação — preservação, substituição de banco/sidecars/
  //    arquivos/config e limpeza da flag, inclusive no rollback. Sem
  //    janela TOCTOU: nenhum servidor consegue iniciar enquanto a
  //    restauração estiver em curso, e nenhuma segunda restauração
  //    concorrente obtém a trava. O SO libera o lock na morte do
  //    processo, cobrindo também saídas abruptas.
  //    A liberação acontece no handler de 'exit' (process.exit não
  //    executa finally) e implicitamente no encerramento natural —
  //    sempre DEPOIS de preservação/aplicação/rollback concluídos.
  let trava: { liberar(): void } | null = null;
  try {
    trava = adquirirTravaRestauracao(DB_VIVA);
  } catch (e) {
    if (e instanceof TravaIndisponivel && e.estado === "em_uso") {
      log("ERRO: trava de instância detida — há um servidor Mestre RPG ativo neste banco. Nada foi alterado; flag preservada para retry.");
    } else {
      const motivo = e instanceof TravaIndisponivel ? e.message : String(e);
      log(`ERRO: ${motivo} — restauração abortada por segurança antes de qualquer escrita; flag preservada para retry.`);
    }
    process.exit(2);
  }
  process.once("exit", () => { try { trava?.liberar(); } catch { /* ignora */ } });

  // 3b) diagnóstico complementar: banco aberto por processo estranho
  //     ao servidor (cliente SQLite direto). Fail-safe onde o procfs
  //     permite inspeção; processos que o kernel torna invisíveis são
  //     contados no log — a garantia de exclusividade é a trava acima.
  const verif = verificarBancoEmUso();
  if (verif.status === "em_uso") {
    log(`ERRO: banco em uso por pid ${verif.pid} — restauração exige o servidor parado. Nada foi alterado; flag preservada para retry.`);
    process.exit(2);
  }
  if (verif.status === "indeterminado") {
    log(`ERRO: verificação de banco em uso inconclusiva (${verif.motivo}) — restauração abortada por segurança antes de qualquer escrita; flag preservada para retry.`);
    process.exit(2);
  }

  // Rollback (retomado ou disparado por falha/estado ilegível): restaura
  // o estado preservado em `lado` com checkpoints por componente.
  if (forcarRollback) {
    await executarRollback(String(lado), jr.dados?.tinhaArquivos, jr.dados?.tinhaCfg);
    return; // executarRollback termina com process.exit
  }

  // 4) preserva o estado anterior ANTES de aplicar — SOMENTE CÓPIAS:
  //    banco+sidecars, arquivos de campanha e configuração vão para
  //    backups/pre_restore_<ts>. Journal registra a intenção ANTES da
  //    primeira escrita; se já houve preservação concluída (retomada),
  //    reutiliza o mesmo diretório.
  let ladoFinal = jr.dados?.preRestoreDir as string | undefined;
  let tinhaArquivos = jr.dados?.tinhaArquivos ?? existsSync(DIR_ARQUIVOS);
  let tinhaCfg = jr.dados?.tinhaCfg ?? existsSync(ARQ_CFG);
  if (ladoFinal && existsSync(ladoFinal)) {
    await gravarJournal({ fase: "preservacao-concluida", backupDir: String(backupDir), preRestoreDir: ladoFinal, tinhaArquivos, tinhaCfg });
  } else {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    ladoFinal = join(DIR_BACKUPS, `pre_restore_${ts}`);
    try {
      await gravarJournal({ fase: "preservacao-iniciada", backupDir: String(backupDir) });
      if (existsSync(ladoFinal)) rmSync(ladoFinal, { recursive: true, force: true });
      mkdirSync(ladoFinal, { recursive: true });
      for (const suf of ["", "-wal", "-shm"]) {
        const atual = DB_VIVA + suf;
        if (existsSync(atual)) copyFileSync(atual, join(ladoFinal, `mestre-rpg.db${suf}`));
      }
      if (tinhaArquivos) cpSync(DIR_ARQUIVOS, join(ladoFinal, "arquivos"), { recursive: true });
      if (tinhaCfg) {
        mkdirSync(join(ladoFinal, "configuracao"), { recursive: true });
        copyFileSync(ARQ_CFG, join(ladoFinal, "configuracao", "servidor.json"));
      }
    } catch (e) {
      log(`FALHA ao preservar estado anterior: ${e} — nada foi alterado; backup parcial em ${ladoFinal}`);
      process.exit(1);
    }
    await gravarJournal({ fase: "preservacao-concluida", backupDir: String(backupDir), preRestoreDir: ladoFinal, tinhaArquivos, tinhaCfg });
  }
  const ladoOk = ladoFinal as string;
  await gravarJournal({ fase: "substituicao-iniciada", backupDir: String(backupDir), preRestoreDir: ladoOk, tinhaArquivos, tinhaCfg });

  // 5) aplicação com checkpoints por componente — qualquer falha desfaz
  //    TUDO a partir das cópias em `ladoOk` (rollback journalado).
  const falhou: { e: unknown } = { e: null };
  try {
    // sidecars: remove os do banco anterior ANTES de trocar o arquivo —
    // um WAL/SHM órfão não pode ficar associado ao banco restaurado.
    if (journalCarregado?.componentes.sidecars.estado !== "concluido") {
      await checkpoint("sidecars", "em-andamento");
      for (const suf of ["-wal", "-shm"]) rmSync(DB_VIVA + suf, { force: true });
    }
    // banco: staging + rename atômico no mesmo volume (não há atomicidade
    // conjunta com os demais componentes — o journal cobre a retomada).
    if (journalCarregado?.componentes.banco.estado !== "concluido") {
      await checkpoint("banco", "em-andamento");
      const staging = `${DB_VIVA}.restaurando-${process.pid}`;
      copyFileSync(join(String(backupDir), "mestre-rpg.db"), staging);
      renameSync(staging, DB_VIVA);
      // sidecars do próprio backup (quando existirem) acompanham o banco
      for (const suf of ["-wal", "-shm"]) {
        const bkSide = join(String(backupDir), `mestre-rpg.db${suf}`);
        if (existsSync(bkSide)) copyFileSync(bkSide, DB_VIVA + suf);
      }
      await checkpoint("banco", "concluido");
      await checkpoint("sidecars", "concluido");
    } else if (journalCarregado?.componentes.sidecars.estado !== "concluido") {
      await checkpoint("sidecars", "concluido");
    }
    // Snapshot fiel: o destino vivo passa a ser EXATAMENTE o que o backup
    // contém — se o backup não tem 'arquivos', o vivo fica sem arquivos;
    // se não tem config, o vivo fica sem config (servidor usa os defaults).
    if (journalCarregado?.componentes.arquivos.estado !== "concluido") {
      await checkpoint("arquivos", "em-andamento");
      rmSync(DIR_ARQUIVOS, { recursive: true, force: true });
      if (existsSync(dirArqBackup)) cpSync(dirArqBackup, DIR_ARQUIVOS, { recursive: true });
      await checkpoint("arquivos", "concluido");
    }
    if (journalCarregado?.componentes.configuracao.estado !== "concluido") {
      await checkpoint("configuracao", "em-andamento");
      rmSync(ARQ_CFG, { force: true });
      if (existsSync(cfgBackup)) {
        mkdirSync(dirname(ARQ_CFG), { recursive: true });
        copyFileSync(cfgBackup, ARQ_CFG);
      }
      await checkpoint("configuracao", "concluido");
    }
    // flag é limpa DENTRO do banco restaurado e a remoção é confirmada —
    // se falhar, o catch abaixo desfaz TUDO (banco antigo volta com a flag).
    if (journalCarregado?.componentes.flag.estado !== "concluido") {
      await checkpoint("flag", "em-andamento");
      limparFlag();
      await checkpoint("flag", "concluido");
    }
    // validação pós-aplicação: integridade do banco restaurado antes de
    // declarar sucesso — falha dispara o rollback journalado.
    const chk = new Database(DB_VIVA, { readonly: true });
    const integ = String(chk.pragma("integrity_check", { simple: true }));
    chk.close();
    if (integ !== "ok") throw new Error(`integrity_check do banco restaurado: ${integ}`);
    await gravarJournal({ fase: "concluido", backupDir: String(backupDir), preRestoreDir: ladoOk });
    // restauração concluída e validada: o alvo não precisa mais de
    // proteção contra retenção (journal concluído também deixa de
    // protegê-lo na varredura — dupla garantia).
    try {
      const { desprotegerBackupContraRetencao } = await import("../lib/protecao-backup.js");
      await desprotegerBackupContraRetencao(String(backupDir));
    } catch { /* proteção é best-effort na conclusão */ }
    log(`Restauração aplicada de ${backupDir}`);
    log(`Estado anterior preservado em ${ladoOk}`);
  } catch (e) {
    falhou.e = e;
  }
  if (falhou.e) {
    log(`FALHA: ${falhou.e}. Revertendo estado anterior completo...`);
    await executarRollback(ladoOk, tinhaArquivos, tinhaCfg);
    return; // executarRollback termina com process.exit
  }
  // Sucesso: libera explicitamente — o handler de 'exit' cobre os
  // caminhos process.exit(1|2) sem finally.
  try { trava?.liberar(); } catch { /* ignora */ }
}

/**
 * Rollback journalado: restaura banco+sidecars, arquivos e config a partir
 * do estado preservado em `lado` (backups/pre_restore_<ts>). Cada
 * componente tem checkpoint próprio; uma queda no meio é retomada pelo
 * journal (fase rollback-*) na próxima execução. Termina sempre com
 * process.exit — o boot NÃO pode subir sobre estado revertido sem nova
 * decisão do operador.
 */
async function executarRollback(lado: string, tinhaArquivosArg?: boolean, tinhaCfgArg?: boolean) {
  const tinhaArquivos = tinhaArquivosArg ?? existsSync(join(lado, "arquivos"));
  const tinhaCfg = tinhaCfgArg ?? existsSync(join(lado, "configuracao", "servidor.json"));
  await gravarJournal({ fase: "rollback-iniciado", preRestoreDir: lado, tinhaArquivos, tinhaCfg });

  const reverterComponente = async (comp: Componente, fn: () => void) => {
    if (journalCarregado?.componentes[comp]?.estado === "rollback-concluido") return;
    await checkpoint(comp, "rollback-em-andamento");
    fn();
    await checkpoint(comp, "rollback-concluido");
  };

  try {
    // remove sidecars que a tentativa possa ter deixado e restaura
    // somente os que existiam na preservação — nunca mistura WAL de
    // um banco com o arquivo de outro.
    await reverterComponente("sidecars", () => {
      for (const suf of ["-wal", "-shm"]) rmSync(DB_VIVA + suf, { force: true });
      for (const suf of ["-wal", "-shm"]) {
        const ladoArq = join(lado, `mestre-rpg.db${suf}`);
        if (existsSync(ladoArq)) copyFileSync(ladoArq, DB_VIVA + suf);
      }
    });
    await reverterComponente("banco", () => {
      const ladoDb = join(lado, "mestre-rpg.db");
      if (existsSync(ladoDb)) {
        const staging = `${DB_VIVA}.restaurando-${process.pid}`;
        copyFileSync(ladoDb, staging);
        renameSync(staging, DB_VIVA);
      }
    });
    await reverterComponente("arquivos", () => {
      if (tinhaArquivos) {
        // substituição completa: cpSync mescla e deixaria arquivos do backup
        rmSync(DIR_ARQUIVOS, { recursive: true, force: true });
        cpSync(join(lado, "arquivos"), DIR_ARQUIVOS, { recursive: true });
      } else if (existsSync(DIR_ARQUIVOS)) {
        rmSync(DIR_ARQUIVOS, { recursive: true, force: true });
      }
    });
    await reverterComponente("configuracao", () => {
      const cfgLado = join(lado, "configuracao", "servidor.json");
      if (tinhaCfg) {
        mkdirSync(dirname(ARQ_CFG), { recursive: true });
        copyFileSync(cfgLado, ARQ_CFG);
      } else if (existsSync(ARQ_CFG)) {
        rmSync(ARQ_CFG, { force: true });
      }
    });
    // flag: o banco restaurado pode conter a flag original — confirmar
    // que ela voltou (ou removê-la se o estado preservado não a tinha).
    await reverterComponente("flag", () => {
      // nada a fazer: a flag vive no banco, restaurado com o componente
      // "banco" — o próximo boot relê o estado real.
    });
    await gravarJournal({ fase: "rollback-concluido", preRestoreDir: lado });
    log("Rollback concluído — sistema voltou ao estado anterior (banco, arquivos e config).");
  } catch (e2) {
    log(`ROLLBACK FALHOU: ${e2} — journal em 'rollback-*' para retomada; estado anterior preservado em ${lado}`);
  }
  // Gate de teste: prova que a trava continua segurada até DEPOIS do
  // rollback (sucesso ou falha) — um segundo restaurador/servidor não
  // consegue adquiri-la neste ponto.
  aguardarGateTrava("apos-rollback");
  process.exit(1);
}

principal().catch((e) => { console.error(e); process.exit(1); });
