#!/usr/bin/env node
// Ordem de boot: restauracao pendente -> migrations -> servidor.
// Prova em raízes MESTRE_HOME isoladas (banco real nunca tocado):
// primeira instalação sem diretórios, restore de schema antigo + migrate,
// backup corrompido/ausente, falhas reais na preservação, na cópia do
// banco, nos arquivos, na config e na limpeza da flag — cada uma com
// verificação do estado resultante (banco, sidecars, arquivos, config, flag).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, readdirSync, symlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { dirTeste, abrirDb, limparDir, portaLivre, subirServidor, esperarSaudavel, encerrarServidor } from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const RAIZ_REPO = process.cwd();
const RESTAURADOR = join(RAIZ_REPO, "servidor/dist/db/aplicar-restauracao.js");
const MIGRADOR = join(RAIZ_REPO, "servidor/dist/db/migrate.js");
const INDICE = join(RAIZ_REPO, "servidor/dist/index.js");
const TABELA_NOVA = "campaign_rule_books"; // recriada pelas migrations 0017-0021 (últimas)

function envRaiz(raiz, extra = {}) {
  return {
    ...process.env,
    MESTRE_HOME: raiz,
    MESTRE_BANCO: join(raiz, "banco", "mestre-rpg.db"),
    MESTRE_ARQUIVOS: join(raiz, "arquivos", "campanhas"),
    MESTRE_BACKUPS: join(raiz, "backups"),
    ...extra,
  };
}
function rodar(cmd, args, env) {
  const r = spawnSync(cmd, args, { env, encoding: "utf8" });
  return { code: r.status, saida: (r.stdout ?? "") + (r.stderr ?? "") };
}
const migrar = (raiz, env) => rodar("node", [MIGRADOR], env ?? envRaiz(raiz));
const restaurar = (raiz, env) => rodar("node", [RESTAURADOR], env ?? envRaiz(raiz));
const dbPath = (raiz) => join(raiz, "banco", "mestre-rpg.db");
const arqPath = (raiz) => join(raiz, "arquivos", "campanhas");
const cfgPath = (raiz) => join(raiz, "configuracao", "servidor.json");

function comDbRw(arquivo, fn) {
  const db = abrirDb(arquivo);
  try { return fn(db); } finally { db.close(); }
}
function temTabelaDb(arquivo, nome) {
  try {
    return comDbRw(arquivo, (db) =>
      !!db.prepare("select name from sqlite_master where type='table' and name=?").get(nome));
  } catch { return false; }
}
function flagPendenteDb(arquivo) {
  try {
    return comDbRw(arquivo, (db) =>
      db.prepare("select value from server_settings where key='restauracao_pendente'").get()?.value ?? null);
  } catch { return "ERRO_LEITURA"; }
}
function armarFlag(raiz, filePath) {
  comDbRw(dbPath(raiz), (db) => {
    db.prepare("insert into server_settings (key,value) values ('restauracao_pendente',?) " +
      "on conflict(key) do update set value=excluded.value").run(JSON.stringify({ filePath }));
  });
}
// Simula banco de versão anterior: remove as tabelas das migrations
// a partir da 0017 e as colunas das ALTERs (0019 mesa, 0020 financeiro,
// 0023 índice de sessões), além dos registros correspondentes no journal
// do Drizzle — a quantidade é derivada do _journal.json (tudo com
// idx >= 17), não de um número mágico que quebraria a cada migration nova.
const TABELAS_ANTIGAS = ["campaign_rule_books", "novidades", "novidade_leituras", "operacao_estornos"];
const JOURNAL_MIGRATIONS = join(RAIZ_REPO, "servidor", "migrations", "meta", "_journal.json");
const IDX_FRONTEIRA = 17; // primeira migration que este teste simula como "antiga"
function migrationsAReverter() {
  const j = JSON.parse(readFileSync(JOURNAL_MIGRATIONS, "utf8"));
  return j.entries.filter((e) => e.idx >= IDX_FRONTEIRA).length;
}
function rebaixarSchema(arquivoDb) {
  const db = abrirDb(arquivoDb);
  try {
    for (const tb of TABELAS_ANTIGAS) db.exec(`drop table if exists ${tb}`);
    // ALTERs/índices sem tabela própria: desfaz antes do migrate rodar de novo.
    db.exec("drop index if exists sessions_campaign_number_idx"); // migration 0023
    // SQLite não aceita IF EXISTS em DROP COLUMN — verifica antes.
    const colsMoney = new Set(db.pragma("table_info(money_transactions)").map((c) => c.name));
    if (colsMoney.has("inventory_item_id")) db.exec("alter table money_transactions drop column inventory_item_id");
    if (colsMoney.has("operacao")) db.exec("alter table money_transactions drop column operacao");
    const colsSess = new Set(db.pragma("table_info(sessions)").map((c) => c.name));
    if (colsSess.has("vtt_state")) db.exec("alter table sessions drop column vtt_state");
    const jt = db.prepare("select name from sqlite_master where type='table' and name like '%migration%'").all()
      .map((r) => r.name)[0];
    if (jt) {
      const n = migrationsAReverter();
      db.exec(`delete from ${jt} where rowid in (select rowid from ${jt} order by rowid desc limit ${n})`);
    }
  } finally { db.close(); }
}
// Backup completo mínimo: db + arquivos/ + configuracao/servidor.json
function fazerBackup(raiz, nome, { rebaixar = false, semCfg = false, semArq = false } = {}) {
  const bk = join(raiz, "backups", nome);
  mkdirSync(bk, { recursive: true });
  copyFileSync(dbPath(raiz), join(bk, "mestre-rpg.db"));
  if (rebaixar) rebaixarSchema(join(bk, "mestre-rpg.db"));
  if (!semArq) {
    // backup espelha o CONTEÚDO de DIR_ARQUIVOS (ver backup.ts: copiarArquivos)
    mkdirSync(join(bk, "arquivos"), { recursive: true });
    writeFileSync(join(bk, "arquivos", "doc_bk.txt"), "conteudo-do-backup");
  }
  if (!semCfg) {
    mkdirSync(join(bk, "configuracao"), { recursive: true });
    writeFileSync(join(bk, "configuracao", "servidor.json"), JSON.stringify({ backup: true }));
  }
  return bk;
}
function estadoVivo(raiz) {
  return {
    tabelaNova: temTabelaDb(dbPath(raiz), TABELA_NOVA),
    flag: flagPendenteDb(dbPath(raiz)),
    arqExiste: existsSync(arqPath(raiz)),
    arqDocBk: existsSync(join(arqPath(raiz), "doc_bk.txt")),
    cfgExiste: existsSync(cfgPath(raiz)),
    cfgBackup: existsSync(cfgPath(raiz)) && JSON.parse(readFileSync(cfgPath(raiz), "utf8")).backup === true,
  };
}

// Abre o banco em WAL com tabela de prova própria e devolve a conexão
// ABERTA — enquanto ela estiver aberta, o SQLite não consolida nem apaga
// os sidecars, então -wal/-shm persistem em disco durante o restore.
// O trio db/-wal/-shm é consistente (o WAL contém os frames novos).
function ladoComWal(arquivoDb) {
  const db = abrirDb(arquivoDb);
  db.pragma("journal_mode = wal");
  db.exec("create table if not exists wal_probe (k text primary key, v text)");
  db.prepare("insert or replace into wal_probe (k,v) values ('m','wal-ok')").run();
  return db;
}
// Materializa um trio REAL ao lado do banco: copia db/-wal/-shm com a
// conexão aberta, fecha (consolida o arquivo principal) e repõe a cópia
// pré-checkpoint — resultado: sidecars autênticos, marcador só no WAL.
function materializarTrio(arquivoDb) {
  const db = ladoComWal(arquivoDb);
  for (const suf of ["", "-wal", "-shm"]) {
    const src = arquivoDb + suf;
    if (existsSync(src)) copyFileSync(src, arquivoDb + "__t" + suf);
  }
  db.close();
  for (const suf of ["", "-wal", "-shm"]) {
    const tmp = arquivoDb + "__t" + suf;
    if (existsSync(tmp)) { copyFileSync(tmp, arquivoDb + suf); rmSync(tmp); }
  }
}
function probeWalDb(arquivo) {
  try {
    return comDbRw(arquivo, (db) =>
      db.prepare("select v from wal_probe where k='m'").get()?.v ?? null);
  } catch { return "ERRO_LEITURA"; }
}
const RAIZ = dirTeste("restore-boot");
try {
  // ===== 1. primeira instalação: raiz SEM nenhum diretório =====
  sec("Primeira instalação sem banco/, arquivos/ ou backups/");
  {
    const r1 = join(RAIZ, "vazia"); // nem mkdirSync — raiz inexistente de propósito? não: MESTRE_HOME deve existir? teste usa raiz existente mas vazia
    mkdirSync(r1, { recursive: true });
    t("raiz existe e está vazia", readdirSync(r1).length === 0);
    const rest = restaurar(r1);
    t("restaurador em raiz vazia → exit 0 (nada a restaurar)", rest.code === 0, rest.saida.slice(-200));
    const m = migrar(r1);
    t("migrate cria banco e schema → exit 0", m.code === 0, m.saida.slice(-200));
    t("schema completo (tabela nova presente)", temTabelaDb(dbPath(r1), TABELA_NOVA));
    // servidor inicializa de verdade sobre o banco recém-migrado
    const porta = await portaLivre();
    const proc = spawn("node", [INDICE], {
      env: { ...envRaiz(r1), MESTRE_PORTA: String(porta) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await esperarSaudavel(`http://127.0.0.1:${porta}`, proc, 30000);
      t("servidor sobe e responde /api/health", true);
    } catch (e) {
      t("servidor sobe e responde /api/health", false, String(e));
    } finally {
      await encerrarServidor(proc);
    }
  }

  // ===== 2. instalação existente sem restauração pendente =====
  sec("Instalação existente sem restauração pendente");
  {
    const r2 = join(RAIZ, "existente");
    mkdirSync(join(r2, "banco"), { recursive: true });
    t("migrate inicial → exit 0", migrar(r2).code === 0);
    mkdirSync(arqPath(r2), { recursive: true });
    writeFileSync(join(arqPath(r2), "doc_atual.txt"), "atual");
    mkdirSync(join(r2, "configuracao"), { recursive: true });
    writeFileSync(cfgPath(r2), JSON.stringify({ atual: true }));
    const rest = restaurar(r2);
    t("restaurador sem pendência → exit 0", rest.code === 0, rest.saida.slice(-200));
    t("banco/arquivos/config intactos", temTabelaDb(dbPath(r2), TABELA_NOVA)
      && readFileSync(join(arqPath(r2), "doc_atual.txt"), "utf8") === "atual"
      && JSON.parse(readFileSync(cfgPath(r2), "utf8")).atual === true);
  }

  // ===== 3. restore de schema antigo + migrate (prova principal) =====
  sec("Restauração de versão anterior seguida de migrations");
  {
    const r3 = join(RAIZ, "antigo");
    mkdirSync(join(r3, "banco"), { recursive: true });
    t("migrate inicial → exit 0", migrar(r3).code === 0);
    mkdirSync(arqPath(r3), { recursive: true });
    writeFileSync(join(arqPath(r3), "doc_vivo.txt"), "vivo");
    mkdirSync(join(r3, "configuracao"), { recursive: true });
    writeFileSync(cfgPath(r3), JSON.stringify({ atual: true }));
    const bk = fazerBackup(r3, "bk_antigo", { rebaixar: true });
    {
      const d = abrirDb(join(bk, "mestre-rpg.db"));
      const ok = !d.prepare("select name from sqlite_master where type='table' and name=?").get(TABELA_NOVA);
      d.close();
      t("backup simula schema anterior (sem tabela nova)", ok === true);
    }
    armarFlag(r3, bk);
    const rest = restaurar(r3);
    t("restaurador → exit 0", rest.code === 0, rest.saida.slice(-300));
    const st = estadoVivo(r3);
    t("schema antigo aplicado (tabela ausente)", st.tabelaNova === false);
    t("flag limpa após sucesso", st.flag === null, String(st.flag));
    t("arquivo do backup copiado", st.arqDocBk === true);
    t("doc antigo substituído conforme backup", !existsSync(join(arqPath(r3), "doc_vivo.txt")));
    t("config do backup aplicada", st.cfgBackup === true);
    const preservados = readdirSync(join(r3, "backups")).filter((d) => d.startsWith("pre_restore_"));
    t("estado anterior preservado em pre_restore_*", preservados.length >= 1, preservados.join(","));
    const m2 = migrar(r3);
    t("migrate pós-restore → exit 0", m2.code === 0, m2.saida.slice(-200));
    t("schema atualizado após migrate (tabela recriada)", temTabelaDb(dbPath(r3), TABELA_NOVA));
  }

  // ===== 4. backup corrompido =====
  sec("Backup corrompido");
  {
    const r4 = join(RAIZ, "corrompido");
    mkdirSync(join(r4, "banco"), { recursive: true });
    migrar(r4);
    const bk = join(r4, "backups", "bk_ruim"); mkdirSync(bk, { recursive: true });
    writeFileSync(join(bk, "mestre-rpg.db"), "isto nao e sqlite");
    armarFlag(r4, bk);
    const antes = comDbRw(dbPath(r4), (db) => db.prepare("select count(*) c from sqlite_master").get().c);
    const rest = restaurar(r4);
    t("restaurador corrompido → exit != 0", rest.code !== 0, `code=${rest.code}`);
    const depois = comDbRw(dbPath(r4), (db) => db.prepare("select count(*) c from sqlite_master").get().c);
    t("banco vivo intacto", antes === depois, `${antes}→${depois}`);
    t("flag limpa mesmo no cancelamento", flagPendenteDb(dbPath(r4)) === null);
  }

  // ===== 5. pasta de backup inexistente =====
  sec("Pasta de backup inexistente");
  {
    const r5 = join(RAIZ, "sem_pasta");
    mkdirSync(join(r5, "banco"), { recursive: true });
    migrar(r5);
    armarFlag(r5, join(r5, "backups", "nao_existe"));
    const rest = restaurar(r5);
    t("restaurador sem pasta → exit != 0", rest.code !== 0, `code=${rest.code}`);
    t("banco vivo preservado", temTabelaDb(dbPath(r5), TABELA_NOVA));
    t("flag limpa (cancelamento definitivo)", flagPendenteDb(dbPath(r5)) === null);
  }

  // ===== 6. falha ANTES da aplicação (backups/ é um arquivo) =====
  sec("Falha antes da aplicação — nada é alterado");
  {
    const r6 = join(RAIZ, "falha_pre");
    mkdirSync(join(r6, "banco"), { recursive: true });
    migrar(r6);
    mkdirSync(arqPath(r6), { recursive: true });
    writeFileSync(join(arqPath(r6), "doc_vivo.txt"), "vivo");
    mkdirSync(join(r6, "configuracao"), { recursive: true });
    writeFileSync(cfgPath(r6), JSON.stringify({ atual: true }));
    const bk = join(r6, "bk_fonte"); mkdirSync(bk, { recursive: true });
    copyFileSync(dbPath(r6), join(bk, "mestre-rpg.db"));
    armarFlag(r6, bk);
    // sabotagem: 'backups' vira ARQUIVO → mkdirSync(pre_restore) explode
    // durante a PRESERVAÇÃO, antes de qualquer arquivo ser tocado.
    writeFileSync(join(r6, "backups"), "nao e pasta");
    const rest = restaurar(r6);
    t("restaurador em falha de preservação → exit != 0", rest.code !== 0, `code=${rest.code}`);
    t("banco vivo intacto (tabela nova presente)", temTabelaDb(dbPath(r6), TABELA_NOVA));
    t("flag PERMANECE para retry no próximo boot", !!flagPendenteDb(dbPath(r6)));
    t("arquivos vivos intactos", readFileSync(join(arqPath(r6), "doc_vivo.txt"), "utf8") === "vivo");
    t("config viva intacta", JSON.parse(readFileSync(cfgPath(r6), "utf8")).atual === true);
  }

  // ===== 7. backup inválido: 'arquivos' como arquivo =====
  sec("Backup inválido — arquivos como arquivo, rejeitado antes de tocar");
  {
    const r7 = join(RAIZ, "falha_arq");
    mkdirSync(join(r7, "banco"), { recursive: true });
    migrar(r7);
    mkdirSync(arqPath(r7), { recursive: true });
    writeFileSync(join(arqPath(r7), "doc_vivo.txt"), "vivo");
    const bk = fazerBackup(r7, "bk_com_arq"); // backup TEM arquivos/
    rmSync(join(bk, "arquivos"), { recursive: true, force: true });
    writeFileSync(join(bk, "arquivos"), "sou-arquivo-nao-pasta");
    armarFlag(r7, bk);
    const rest = restaurar(r7);
    t("backup com tipo inválido → exit != 0", rest.code !== 0, `code=${rest.code}`);
    const st = estadoVivo(r7);
    t("nada foi tocado: banco intacto", st.tabelaNova === true);
    t("flag limpa no cancelamento", st.flag === null, String(st.flag));
    t("doc_vivo.txt intacto", readFileSync(join(arqPath(r7), "doc_vivo.txt"), "utf8") === "vivo");
    t("doc_bk.txt ausente", !existsSync(join(arqPath(r7), "doc_bk.txt")));
  }

  // ===== 8. backup inválido: servidor.json como diretório =====
  sec("Backup inválido — servidor.json como diretório, rejeitado antes de tocar");
  {
    const r8 = join(RAIZ, "falha_cfg");
    mkdirSync(join(r8, "banco"), { recursive: true });
    migrar(r8);
    mkdirSync(join(r8, "configuracao"), { recursive: true });
    writeFileSync(cfgPath(r8), JSON.stringify({ atual: true }));
    const bk = fazerBackup(r8, "bk_com_cfg"); // backup TEM configuracao/
    rmSync(join(bk, "configuracao", "servidor.json"));
    mkdirSync(join(bk, "configuracao", "servidor.json"));
    armarFlag(r8, bk);
    const rest = restaurar(r8);
    t("backup com tipo inválido → exit != 0", rest.code !== 0, `code=${rest.code}`);
    const st = estadoVivo(r8);
    t("nada foi tocado: banco intacto", st.tabelaNova === true);
    t("flag limpa no cancelamento", st.flag === null, String(st.flag));
    t("config viva intacta", st.cfgExiste && JSON.parse(readFileSync(cfgPath(r8), "utf8")).atual === true);
    t("sem mistura do backup", !st.cfgBackup && !st.arqDocBk);
  }

  // ===== 9. falha na LIMPEZA DA FLAG (banco restaurado sem server_settings) =====
  sec("Falha na limpeza da flag — rollback total");
  {
    const r9 = join(RAIZ, "falha_flag");
    mkdirSync(join(r9, "banco"), { recursive: true });
    migrar(r9);
    mkdirSync(arqPath(r9), { recursive: true });
    writeFileSync(join(arqPath(r9), "doc_vivo.txt"), "vivo");
    const bk = fazerBackup(r9, "bk_sem_tabela");
    // sabotagem no BACKUP: remove server_settings → limparFlag lança
    // "no such table" → deve reverter TUDO e sair != 0.
    {
      const d = abrirDb(join(bk, "mestre-rpg.db"));
      d.exec("drop table server_settings");
      d.close();
    }
    armarFlag(r9, bk);
    const rest = restaurar(r9);
    t("restaurador com falha na flag → exit != 0", rest.code !== 0, `code=${rest.code}`);
    const st = estadoVivo(r9);
    t("banco revertido ao antigo (tabela nova + flag)", st.tabelaNova === true && !!st.flag);
    t("arquivos revertidos (doc_vivo de volta, sem doc_bk)", readFileSync(join(arqPath(r9), "doc_vivo.txt"), "utf8") === "vivo" && !st.arqDocBk);
    t("doc_bk.txt do backup removido pelo rollback", !existsSync(join(arqPath(r9), "doc_bk.txt")));
  }

  // ===== 11. banco vivo COM WAL/SHM aberto por conexão ativa =====
  // Com o servidor parado o restaurador lê a flag (o que consolida o WAL);
  // aqui uma conexão de teste segura os sidecars. Duas garantias por
  // plataforma, ambas exigindo abort sem estado misto:
  //  - Windows: a remoção do sidecar travado falha com EPERM DEPOIS da
  //    preservação → pre_restore_* existe com o trio completo;
  //  - Linux: unlink não trava, então o restaurador detecta o banco em
  //    uso via /proc ANTES de qualquer escrita → exit 2 sem pre_restore
  //    (garantia mais forte: nada foi tocado, flag fica para retry).
  sec("Sidecars: vivo tem WAL/SHM em uso — falha segura sem estado misto");
  {
    const r11 = join(RAIZ, "wal_vivo");
    mkdirSync(join(r11, "banco"), { recursive: true });
    migrar(r11);
    const bk = fazerBackup(r11, "bk_sem_side"); // copia só o .db principal
    armarFlag(r11, bk);
    const conn = ladoComWal(dbPath(r11)); // sidecars reais em disco
    t("banco vivo possui -wal e -shm", existsSync(dbPath(r11) + "-wal") && existsSync(dbPath(r11) + "-shm"));
    const rest = restaurar(r11);
    t("restaurador bloqueado por sidecar em uso → exit != 0", rest.code !== 0, `code=${rest.code}`);
    const pre = readdirSync(join(r11, "backups")).filter((d) => d.startsWith("pre_restore_"));
    if (process.platform === "linux") {
      t("abort antes de escrever: sem pre_restore_*", pre.length === 0);
    } else {
      t("estado anterior (com sidecars) preservado em pre_restore_*", pre.length >= 1);
      const ladoDb = join(r11, "backups", pre[0], "mestre-rpg.db");
      t("trio preservado inclui -wal e -shm",
        existsSync(ladoDb + "-wal") && existsSync(ladoDb + "-shm"));
    }
    t("banco vivo NÃO foi substituído (sidecars ainda presentes)",
      existsSync(dbPath(r11) + "-wal") && existsSync(dbPath(r11) + "-shm"));
    conn.close();
    t("conteúdo do WAL legível após fechar", probeWalDb(dbPath(r11)) === "wal-ok", String(probeWalDb(dbPath(r11))));
    t("flag preservada para retry", !!flagPendenteDb(dbPath(r11)));
  }

  // ===== 12. backup COM WAL/SHM, banco vivo SEM sidecars =====
  sec("Sidecars: backup tem WAL/SHM, vivo não — restore aplica o trio");
  {
    const r12 = join(RAIZ, "wal_backup");
    mkdirSync(join(r12, "banco"), { recursive: true });
    migrar(r12);
    const bk = fazerBackup(r12, "bk_com_side");
    materializarTrio(join(bk, "mestre-rpg.db")); // trio real dentro do backup
    t("backup possui -wal e -shm",
      existsSync(join(bk, "mestre-rpg.db-wal")) && existsSync(join(bk, "mestre-rpg.db-shm")));
    armarFlag(r12, bk);
    const rest = restaurar(r12);
    t("restaurador → exit 0", rest.code === 0, rest.saida.slice(-300));
    // o SQLite consolida o WAL na primeira abertura (limparFlag) e remove
    // os sidecars — a prova real é o dado que SÓ existia no WAL ser lido.
    t("conteúdo do WAL aplicado (wal_probe)", probeWalDb(dbPath(r12)) === "wal-ok", String(probeWalDb(dbPath(r12))));
    t("flag limpa após sucesso", flagPendenteDb(dbPath(r12)) === null);
  }

  // ===== 13. rollback após falha — sidecars do backup NÃO ficam residuais =====
  sec("Rollback com sidecars do backup — nenhum residual no banco recuperado");
  {
    const r13 = join(RAIZ, "wal_rollback");
    mkdirSync(join(r13, "banco"), { recursive: true });
    migrar(r13);
    const bk = fazerBackup(r13, "bk_falha_flag");
    // sabotagem: backup sem server_settings → limparFlag lança → rollback;
    // e COM sidecars → o rollback precisa removê-los (não existiam antes).
    {
      const d = abrirDb(join(bk, "mestre-rpg.db"));
      d.exec("drop table server_settings");
      d.close();
    }
    materializarTrio(join(bk, "mestre-rpg.db")); // trio real no backup
    armarFlag(r13, bk);
    t("vivo sem sidecars antes do restore", !existsSync(dbPath(r13) + "-wal") && !existsSync(dbPath(r13) + "-shm"));
    const rest = restaurar(r13);
    t("restaurador com falha na flag → exit != 0", rest.code !== 0, `code=${rest.code}`);
    t("NENHUM sidecar residual no banco recuperado",
      !existsSync(dbPath(r13) + "-wal") && !existsSync(dbPath(r13) + "-shm"));
    t("exatos arquivos esperados no diretório banco/ (trava de instância é artefato legítimo)",
      readdirSync(join(r13, "banco")).filter((f) => f.startsWith("mestre-rpg.db")).sort().join(",") === "mestre-rpg.db,mestre-rpg.db.trava");
    t("banco revertido abre e tem flag para retry", !!flagPendenteDb(dbPath(r13)));
    t("tabela nova presente no banco revertido", temTabelaDb(dbPath(r13), TABELA_NOVA));
  }

  // ===== 15. snapshot fiel: backup sem arquivos/ =====
  sec("Backup válido SEM arquivos/ — vivo fica sem arquivos (A)");
  {
    const r15 = join(RAIZ, "sem_arq");
    mkdirSync(join(r15, "banco"), { recursive: true });
    migrar(r15);
    mkdirSync(arqPath(r15), { recursive: true });
    writeFileSync(join(arqPath(r15), "doc_vivo.txt"), "posterior-ao-backup");
    const bk = fazerBackup(r15, "bk_sem_arq", { semArq: true });
    armarFlag(r15, bk);
    const rest = restaurar(r15);
    t("restaurador → exit 0", rest.code === 0, rest.saida.slice(-300));
    t("doc_vivo.txt NÃO permanece (snapshot sem arquivos)", !existsSync(join(arqPath(r15), "doc_vivo.txt")));
    t("diretório de arquivos ausente ou vazio", !existsSync(arqPath(r15)) || readdirSync(arqPath(r15)).length === 0);
    t("config do backup aplicada", estadoVivo(r15).cfgBackup === true);
  }

  // ===== 16. snapshot fiel: backup sem configuracao/ =====
  sec("Backup válido SEM configuracao/ — vivo fica sem config (B)");
  {
    const r16 = join(RAIZ, "sem_cfg");
    mkdirSync(join(r16, "banco"), { recursive: true });
    migrar(r16);
    mkdirSync(join(r16, "configuracao"), { recursive: true });
    writeFileSync(cfgPath(r16), JSON.stringify({ posterior: true }));
    const bk = fazerBackup(r16, "bk_sem_cfg", { semCfg: true });
    armarFlag(r16, bk);
    const rest = restaurar(r16);
    t("restaurador → exit 0", rest.code === 0, rest.saida.slice(-300));
    t("configuração viva REMOVIDA", !existsSync(cfgPath(r16)));
    t("arquivos do backup aplicados", estadoVivo(r16).arqDocBk === true);
  }

  // ===== 17. snapshot fiel: backup sem ambos =====
  sec("Backup SEM arquivos e SEM config — nada posterior sobrevive (C)");
  {
    const r17 = join(RAIZ, "sem_ambos");
    mkdirSync(join(r17, "banco"), { recursive: true });
    migrar(r17);
    mkdirSync(arqPath(r17), { recursive: true });
    writeFileSync(join(arqPath(r17), "doc_vivo.txt"), "vivo");
    mkdirSync(join(r17, "configuracao"), { recursive: true });
    writeFileSync(cfgPath(r17), JSON.stringify({ posterior: true }));
    const bk = fazerBackup(r17, "bk_vazio", { semArq: true, semCfg: true });
    armarFlag(r17, bk);
    const rest = restaurar(r17);
    t("restaurador → exit 0", rest.code === 0, rest.saida.slice(-300));
    const st = estadoVivo(r17);
    t("sem doc_vivo nem doc_bk", !existsSync(join(arqPath(r17), "doc_vivo.txt")) && !st.arqDocBk);
    t("sem configuração viva", !st.cfgExiste);
    t("flag limpa e schema do backup", st.flag === null && st.tabelaNova === true);
  }

  // ===== 18. rollback após remoção de arquivos+config =====
  sec("Rollback após remoção — estado anterior volta integralmente (D)");
  {
    const r18 = join(RAIZ, "rollback_vazio");
    mkdirSync(join(r18, "banco"), { recursive: true });
    migrar(r18);
    mkdirSync(arqPath(r18), { recursive: true });
    writeFileSync(join(arqPath(r18), "doc_vivo.txt"), "vivo");
    mkdirSync(join(r18, "configuracao"), { recursive: true });
    writeFileSync(cfgPath(r18), JSON.stringify({ atual: true }));
    const bk = fazerBackup(r18, "bk_vazio_falha", { semArq: true, semCfg: true });
    // sabotagem: backup sem server_settings → apply remove arquivos+config,
    // copia banco e falha na limpeza da flag → rollback deve restaurar TUDO.
    {
      const d = abrirDb(join(bk, "mestre-rpg.db"));
      d.exec("drop table server_settings");
      d.close();
    }
    armarFlag(r18, bk);
    const rest = restaurar(r18);
    t("restaurador com falha na flag → exit != 0", rest.code !== 0, `code=${rest.code}`);
    const st = estadoVivo(r18);
    t("banco revertido (tabela nova + flag)", st.tabelaNova === true && !!st.flag);
    t("doc_vivo.txt restaurado", readFileSync(join(arqPath(r18), "doc_vivo.txt"), "utf8") === "vivo");
    t("doc_bk.txt ausente (nada do backup ficou)", !st.arqDocBk);
    t("configuração anterior restaurada", st.cfgExiste && JSON.parse(readFileSync(cfgPath(r18), "utf8")).atual === true);
  }

  // ===== 19. backup inválido: tipos errados =====
  sec("Backup inválido — arquivos como arquivo / config como diretório (E)");
  {
    const r19 = join(RAIZ, "tipos_errados");
    mkdirSync(join(r19, "banco"), { recursive: true });
    migrar(r19);
    mkdirSync(arqPath(r19), { recursive: true });
    writeFileSync(join(arqPath(r19), "doc_vivo.txt"), "vivo");
    mkdirSync(join(r19, "configuracao"), { recursive: true });
    writeFileSync(cfgPath(r19), JSON.stringify({ atual: true }));
    const bk = fazerBackup(r19, "bk_tipos");
    // sabotagem 1: backup/arquivos vira ARQUIVO
    rmSync(join(bk, "arquivos"), { recursive: true, force: true });
    writeFileSync(join(bk, "arquivos"), "nao-e-pasta");
    // sabotagem 2: backup/configuracao/servidor.json vira DIRETÓRIO
    rmSync(join(bk, "configuracao", "servidor.json"));
    mkdirSync(join(bk, "configuracao", "servidor.json"));
    armarFlag(r19, bk);
    const rest = restaurar(r19);
    t("restaurador com tipos inválidos → exit != 0", rest.code !== 0, `code=${rest.code}`);
    const st = estadoVivo(r19);
    t("estado anterior intacto: banco preservado", st.tabelaNova === true);
    t("flag limpa no cancelamento (nada foi tocado)", st.flag === null, String(st.flag));
    t("doc_vivo.txt intacto", readFileSync(join(arqPath(r19), "doc_vivo.txt"), "utf8") === "vivo");
    t("configuração intacta", st.cfgExiste && JSON.parse(readFileSync(cfgPath(r19), "utf8")).atual === true);
    t("sem conteúdo parcial do backup", !st.arqDocBk && !st.cfgBackup);
  }

  // ===== 20. validação estrutural detalhada do backup =====
  sec("Estrutura: configuracao como arquivo / dir sem json / symlink");
  {
    // 20a) backup/configuracao é ARQUIVO → inválido
    const ra = join(RAIZ, "cfg_arquivo");
    mkdirSync(join(ra, "banco"), { recursive: true });
    migrar(ra);
    mkdirSync(join(ra, "configuracao"), { recursive: true });
    writeFileSync(cfgPath(ra), JSON.stringify({ atual: true }));
    const bka = fazerBackup(ra, "bk_cfg_arq");
    rmSync(join(bka, "configuracao"), { recursive: true, force: true });
    writeFileSync(join(bka, "configuracao"), "sou-arquivo");
    armarFlag(ra, bka);
    const ra_rest = restaurar(ra);
    t("configuracao como arquivo → exit != 0", ra_rest.code !== 0, `code=${ra_rest.code}`);
    t("nada tocado: config viva intacta", JSON.parse(readFileSync(cfgPath(ra), "utf8")).atual === true);
    t("flag limpa no cancelamento", flagPendenteDb(dbPath(ra)) === null);

    // 20b) backup/configuracao é dir SEM servidor.json → válido;
    //      snapshot sem config → remove a config viva
    const rb = join(RAIZ, "cfg_sem_json");
    mkdirSync(join(rb, "banco"), { recursive: true });
    migrar(rb);
    mkdirSync(join(rb, "configuracao"), { recursive: true });
    writeFileSync(cfgPath(rb), JSON.stringify({ posterior: true }));
    const bkb = fazerBackup(rb, "bk_cfg_vazia", { semCfg: true });
    mkdirSync(join(bkb, "configuracao"), { recursive: true }); // dir existe, sem json
    armarFlag(rb, bkb);
    const rb_rest = restaurar(rb);
    t("configuracao dir sem json → exit 0", rb_rest.code === 0, rb_rest.saida.slice(-200));
    t("config viva removida (snapshot sem config)", !existsSync(cfgPath(rb)));

    // 20c) backup/arquivos como link simbólico → inválido
    const rc = join(RAIZ, "arq_symlink");
    mkdirSync(join(rc, "banco"), { recursive: true });
    migrar(rc);
    mkdirSync(arqPath(rc), { recursive: true });
    writeFileSync(join(arqPath(rc), "doc_vivo.txt"), "vivo");
    const bkc = fazerBackup(rc, "bk_symlink", { semArq: true });
    const fora = join(rc, "fora_do_backup"); mkdirSync(fora, { recursive: true });
    writeFileSync(join(fora, "segredo.txt"), "fora");
    let symlinkOk = true;
    try { symlinkSync(fora, join(bkc, "arquivos"), "junction"); }
    catch (e) { symlinkOk = false; console.log("  (skip symlink: " + (e.code ?? e.message) + ")"); }
    if (symlinkOk) {
      armarFlag(rc, bkc);
      const rc_rest = restaurar(rc);
      t("arquivos como symlink → exit != 0", rc_rest.code !== 0, `code=${rc_rest.code}`);
      t("nada tocado: doc_vivo intacto", readFileSync(join(arqPath(rc), "doc_vivo.txt"), "utf8") === "vivo");
      t("nada vazou do link externo", !existsSync(join(arqPath(rc), "segredo.txt")));
      t("flag limpa no cancelamento", flagPendenteDb(dbPath(rc)) === null);
    }
  }

  // ===== 14. MESTRE_HOME inexistente =====
  sec("MESTRE_HOME que ainda não existe — primeira inicialização real");
  {
    const r14 = join(RAIZ, "raiz_inexistente");
    t("raiz realmente não existe", !existsSync(r14));
    const rest = restaurar(r14);
    t("restaurador → exit 0 mesmo sem raiz", rest.code === 0, rest.saida.slice(-200));
    t("diretório banco/ criado no caminho configurado", existsSync(join(r14, "banco")));
    const m = migrar(r14);
    t("migrate → exit 0", m.code === 0, m.saida.slice(-200));
    t("schema completo", temTabelaDb(dbPath(r14), TABELA_NOVA));
    const porta = await portaLivre();
    const proc = spawn("node", [INDICE], {
      env: { ...envRaiz(r14), MESTRE_PORTA: String(porta) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await esperarSaudavel(`http://127.0.0.1:${porta}`, proc, 30000);
      t("servidor sobe de raiz inexistente e responde /api/health", true);
    } catch (e) {
      t("servidor sobe de raiz inexistente e responde /api/health", false, String(e));
    } finally {
      await encerrarServidor(proc);
    }
  }

  // ===== 10. overrides MESTRE_* respeitados =====
  sec("Compatibilidade MESTRE_HOME/BANCO/ARQUIVOS/BACKUPS");
  {
    const r10 = join(RAIZ, "custom");
    const bancoCustom = join(r10, "dados", "meu.db");
    mkdirSync(join(r10, "dados"), { recursive: true });
    mkdirSync(join(r10, "arqs"), { recursive: true });
    mkdirSync(join(r10, "bks"), { recursive: true });
    const env = { ...envRaiz(r10), MESTRE_BANCO: bancoCustom, MESTRE_ARQUIVOS: join(r10, "arqs"), MESTRE_BACKUPS: join(r10, "bks") };
    const m = rodar("node", [MIGRADOR], env);
    t("migrate com MESTRE_BANCO custom → exit 0 e arquivo criado", m.code === 0 && existsSync(bancoCustom), m.saida.slice(-150));
    const rest = rodar("node", [RESTAURADOR], env);
    t("restaurador respeita MESTRE_BANCO (sem pendência → 0)", rest.code === 0, rest.saida.slice(-150));
  }

  // ===== 21. verificação fail-safe de banco em uso (procfs) =====
  // MESTRE_PROC_FS força a inspeção de descritores de arquivo em
  // qualquer plataforma — uma árvore falsa reproduz /proc indisponível,
  // permissão negada, fd inválido e processo encerrado. Em TODOS os
  // casos de verificação inconclusiva o restaurador deve abortar com
  // exit != 0 ANTES de qualquer escrita: banco, arquivos, config e flag
  // permanecem intactos.
  sec("Fail-safe: verificação de banco em uso inconclusiva aborta sem tocar nada");
  {
    const raizArmada = (sufixo) => {
      const r = join(RAIZ, sufixo);
      mkdirSync(join(r, "banco"), { recursive: true });
      migrar(r);
      mkdirSync(arqPath(r), { recursive: true });
      writeFileSync(join(arqPath(r), "doc_vivo.txt"), "vivo");
      mkdirSync(join(r, "configuracao"), { recursive: true });
      writeFileSync(cfgPath(r), JSON.stringify({ atual: true }));
      const bk = fazerBackup(r, "bk_" + sufixo);
      armarFlag(r, bk);
      return r;
    };
    const intacto = (r) =>
      !!flagPendenteDb(dbPath(r)) &&
      readFileSync(join(arqPath(r), "doc_vivo.txt"), "utf8") === "vivo" &&
      JSON.parse(readFileSync(cfgPath(r), "utf8")).atual === true &&
      !readdirSync(join(r, "backups")).some((d) => d.startsWith("pre_restore_"));

    // 21a. /proc indisponível → indeterminado → aborta
    {
      const r = raizArmada("proc_ausente");
      const rest = restaurar(r, envRaiz(r, { MESTRE_PROC_FS: join(RAIZ, "proc_que_nao_existe") }));
      t("procfs ausente → exit != 0", rest.code !== 0, `code=${rest.code}`);
      t("nada alterado: flag, doc, config e sem pre_restore", intacto(r));
    }

    // 21b. fd de pid não é diretório (ENOTDIR) → indeterminado → aborta
    {
      const r = raizArmada("proc_fd_arquivo");
      const fake = join(RAIZ, "fake_proc_fd_arq");
      mkdirSync(join(fake, "1234"), { recursive: true });
      writeFileSync(join(fake, "1234", "fd"), "nao-e-diretorio");
      const rest = restaurar(r, envRaiz(r, { MESTRE_PROC_FS: fake }));
      t("fd como arquivo → exit != 0", rest.code !== 0, `code=${rest.code}`);
      t("nada alterado: flag, doc, config e sem pre_restore", intacto(r));
    }

    // 21c. entrada de fd não é link simbólico (EINVAL no readlink) → indeterminado → aborta
    {
      const r = raizArmada("proc_fd_comum");
      const fake = join(RAIZ, "fake_proc_fd_comum");
      mkdirSync(join(fake, "1234", "fd"), { recursive: true });
      writeFileSync(join(fake, "1234", "fd", "3"), "arquivo-comum");
      const rest = restaurar(r, envRaiz(r, { MESTRE_PROC_FS: fake }));
      t("fd sem ser symlink → exit != 0", rest.code !== 0, `code=${rest.code}`);
      t("nada alterado: flag, doc, config e sem pre_restore", intacto(r));
    }

    // 21d. pid sem diretório fd (processo encerrou) → ignorado com segurança → restore prossegue
    {
      const r = raizArmada("proc_pid_morto");
      const fake = join(RAIZ, "fake_proc_pid_morto");
      mkdirSync(join(fake, "1234"), { recursive: true }); // sem subdir fd → ENOENT
      const rest = restaurar(r, envRaiz(r, { MESTRE_PROC_FS: fake }));
      t("processo encerrado durante inspeção → restore segue → exit 0", rest.code === 0, rest.saida.slice(-200));
      t("restore aplicado: flag limpa e doc do backup presente",
        flagPendenteDb(dbPath(r)) === null && existsSync(join(arqPath(r), "doc_bk.txt")));
    }

    // 21e. somente Linux: fd simbólico apontando para o banco → em_uso → aborta
    if (process.platform === "linux") {
      const r = raizArmada("proc_em_uso");
      const fake = join(RAIZ, "fake_proc_em_uso");
      mkdirSync(join(fake, "4321", "fd"), { recursive: true });
      symlinkSync(dbPath(r), join(fake, "4321", "fd", "7"));
      const rest = restaurar(r, envRaiz(r, { MESTRE_PROC_FS: fake }));
      t("fd apontando para o banco → exit != 0", rest.code !== 0, `code=${rest.code}`);
      t("nada alterado: flag, doc, config e sem pre_restore", intacto(r));

      // 21f. somente Linux: fd ilegível por permissão → indeterminado → aborta
      const r2 = raizArmada("proc_sem_perm");
      const fake2 = join(RAIZ, "fake_proc_sem_perm");
      mkdirSync(join(fake2, "4321", "fd"), { recursive: true });
      chmodSync(join(fake2, "4321", "fd"), 0o000);
      const rest2 = restaurar(r2, envRaiz(r2, { MESTRE_PROC_FS: fake2 }));
      chmodSync(join(fake2, "4321", "fd"), 0o755);
      t("fd sem permissão de leitura → exit != 0", rest2.code !== 0, `code=${rest2.code}`);
      t("nada alterado: flag, doc, config e sem pre_restore", intacto(r2));
    } else {
      t("casos com symlink/permissão POSIX (linux-only) — cobertos no CI", true);
    }
  }
} finally {
  limparDir(RAIZ);
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
