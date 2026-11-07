// Aplica restauração pendente de backup — executar com o servidor PARADO.
// Uso: node dist/db/aplicar-restauracao.js
// MESTRE_HOME pode apontar para uma raiz alternativa (testes/sandbox).
import { copyFileSync, cpSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = process.env.MESTRE_HOME ?? resolve(__dirname, "..", "..", "..");
const DB_VIVA = resolve(RAIZ, "banco", "mestre-rpg.db");
const DIR_ARQUIVOS = resolve(RAIZ, "arquivos", "campanhas");
const DIR_BACKUPS = resolve(RAIZ, "backups");

function log(msg: string) { console.log(`[restauracao] ${msg}`); }

/** Remove a flag de restauração pendente do banco atualmente em DB_VIVA. */
function limparFlag() {
  try {
    const d = new Database(DB_VIVA);
    d.prepare("delete from server_settings where key='restauracao_pendente'").run();
    d.close();
  } catch (e) { log(`aviso: não foi possível limpar flag: ${e}`); }
}

async function principal() {
  // 1) lê a flag pendente e fecha a conexão ANTES de mexer nos arquivos (Windows trava arquivo aberto)
  let pendente: { filePath?: string } | null = null;
  {
    const db = new Database(DB_VIVA);
    const row = db.prepare("select value from server_settings where key='restauracao_pendente'").get() as { value: string } | undefined;
    db.close();
    if (!row) { log("Nenhuma restauração pendente."); return; }
    pendente = JSON.parse(row.value);
  }
  const backupDir = pendente?.filePath;
  if (!backupDir || !existsSync(backupDir)) {
    // backup alvo não existe mais (ex.: removido por retenção) — nada foi alterado; limpa a flag p/ não repetir o aviso a cada boot
    log(`ERRO: pasta do backup não existe: ${backupDir} — restauração cancelada, sistema segue com dados atuais.`);
    limparFlag();
    return;
  }

  // 2) valida o banco do backup antes de tocar em qualquer coisa
  const dbBackup = join(backupDir, "mestre-rpg.db");
  if (!existsSync(dbBackup)) {
    log("ERRO: backup sem mestre-rpg.db — restauração cancelada.");
    limparFlag();
    return;
  }
  const chk = new Database(dbBackup, { readonly: true });
  const integ = chk.pragma("integrity_check", { simple: true });
  chk.close();
  if (integ !== "ok") {
    log(`ERRO: backup corrompido (${integ}) — restauração cancelada.`);
    limparFlag();
    return;
  }

  // 3) move o banco atual para área de segurança e aplica o backup
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const lado = join(DIR_BACKUPS, `pre_restore_${ts}`);
  mkdirSync(lado, { recursive: true });
  for (const suf of ["", "-wal", "-shm"]) {
    const atual = DB_VIVA + suf;
    if (existsSync(atual)) renameSync(atual, join(lado, `mestre-rpg.db${suf}`));
  }
  try {
    copyFileSync(dbBackup, DB_VIVA);
    const dirArqBackup = join(backupDir, "arquivos");
    if (existsSync(dirArqBackup)) {
      mkdirSync(DIR_ARQUIVOS, { recursive: true });
      cpSync(dirArqBackup, DIR_ARQUIVOS, { recursive: true });
    }
    const cfgBackup = join(backupDir, "configuracao", "servidor.json");
    if (existsSync(cfgBackup)) {
      mkdirSync(resolve(RAIZ, "configuracao"), { recursive: true });
      copyFileSync(cfgBackup, resolve(RAIZ, "configuracao", "servidor.json"));
    }
    // 4) limpa a flag DENTRO do banco restaurado
    limparFlag();
    log(`Restauração aplicada de ${backupDir}`);
    log(`Estado anterior preservado em ${lado}`);
  } catch (e) {
    // rollback: devolve o banco atual
    log(`FALHA: ${e}. Restaurando estado anterior...`);
    try {
      for (const suf of ["", "-wal", "-shm"]) {
        const ladoArq = join(lado, `mestre-rpg.db${suf}`);
        if (existsSync(ladoArq)) copyFileSync(ladoArq, DB_VIVA + suf);
      }
      log("Rollback concluído — sistema voltou ao estado anterior.");
    } catch (e2) { log(`ROLLBACK FALHOU: ${e2} — estado anterior em ${lado}`); }
    process.exit(1);
  }
}

principal().catch((e) => { console.error(e); process.exit(1); });
