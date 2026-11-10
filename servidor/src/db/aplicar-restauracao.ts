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
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
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

  // 3) preserva o estado anterior ANTES de aplicar — SOMENTE CÓPIAS:
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

  // 4) aplicação: banco, arquivos, config e flag — qualquer falha desfaz
  //    TUDO a partir das cópias em `lado` (inclusive removendo o que a
  //    aplicação criou quando não existia antes).
  const reverter = () => {
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
    copyFileSync(dbBackup, DB_VIVA);
    const dirArqBackup = join(backupDir, "arquivos");
    if (existsSync(dirArqBackup)) {
      if (!statSync(dirArqBackup).isDirectory()) throw new Error("backup/arquivos não é um diretório");
      // substituição completa (backup espelha o conteúdo de DIR_ARQUIVOS):
      // mesclar deixaria arquivos criados após o backup — estado misto.
      rmSync(DIR_ARQUIVOS, { recursive: true, force: true });
      cpSync(dirArqBackup, DIR_ARQUIVOS, { recursive: true });
    }
    const cfgBackup = join(backupDir, "configuracao", "servidor.json");
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
