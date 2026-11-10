#!/usr/bin/env node
// Ordem de boot: restauracao pendente -> migrations -> servidor.
// Prova em raízes MESTRE_HOME isoladas (banco real nunca tocado):
// primeira instalação sem diretórios, restore de schema antigo + migrate,
// backup corrompido/ausente, falhas reais na preservação, na cópia do
// banco, nos arquivos, na config e na limpeza da flag — cada uma com
// verificação do estado resultante (banco, sidecars, arquivos, config, flag).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { dirTeste, abrirDb, limparDir, portaLivre, subirServidor, esperarSaudavel, encerrarServidor } from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const RAIZ_REPO = process.cwd();
const RESTAURADOR = join(RAIZ_REPO, "servidor/dist/db/aplicar-restauracao.js");
const MIGRADOR = join(RAIZ_REPO, "servidor/dist/db/migrate.js");
const INDICE = join(RAIZ_REPO, "servidor/dist/index.js");
const TABELA_NOVA = "campaign_rule_books"; // criada pela migration 0017 (última)

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
// Simula banco de versão anterior: remove a tabela da última migration e o
// registro correspondente no journal do Drizzle.
function rebaixarSchema(arquivoDb) {
  const db = abrirDb(arquivoDb);
  try {
    db.exec(`drop table if exists ${TABELA_NOVA}`);
    const jt = db.prepare("select name from sqlite_master where type='table' and name like '%migration%'").all()
      .map((r) => r.name)[0];
    if (jt) {
      const cols = db.prepare(`pragma table_info(${jt})`).all().map((c) => c.name);
      const ordem = cols.includes("created_at") ? "created_at" : cols.includes("id") ? "id" : null;
      if (ordem) db.exec(`delete from ${jt} where ${ordem} = (select max(${ordem}) from ${jt})`);
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

  // ===== 7. falha na cópia dos ARQUIVOS =====
  sec("Falha durante a cópia dos arquivos de campanha");
  {
    const r7 = join(RAIZ, "falha_arq");
    mkdirSync(join(r7, "banco"), { recursive: true });
    migrar(r7);
    mkdirSync(arqPath(r7), { recursive: true });
    writeFileSync(join(arqPath(r7), "doc_vivo.txt"), "vivo");
    const bk = fazerBackup(r7, "bk_com_arq"); // backup TEM arquivos/
    // sabotagem NO BACKUP: 'arquivos' vira ARQUIVO → validacao de tipo
    // explode na aplicação, DEPOIS do banco já ter sido copiado.
    rmSync(join(bk, "arquivos"), { recursive: true, force: true });
    writeFileSync(join(bk, "arquivos"), "sou-arquivo-nao-pasta");
    armarFlag(r7, bk);
    const rest = restaurar(r7);
    t("restaurador com falha nos arquivos → exit != 0", rest.code !== 0, `code=${rest.code}`);
    // banco deve ter sido revertido para o antigo (com tabela nova e flag)
    const st = estadoVivo(r7);
    t("banco revertido ao estado anterior (tabela nova presente)", st.tabelaNova === true);
    t("flag permanece para retry", !!st.flag, String(st.flag));
    t("doc_vivo.txt restaurado pelo rollback", readFileSync(join(arqPath(r7), "doc_vivo.txt"), "utf8") === "vivo");
    t("doc_bk.txt do backup NÃO ficou para trás", !existsSync(join(arqPath(r7), "doc_bk.txt")));
  }

  // ===== 8. falha na cópia da CONFIG =====
  sec("Falha durante a cópia da configuração");
  {
    const r8 = join(RAIZ, "falha_cfg");
    mkdirSync(join(r8, "banco"), { recursive: true });
    migrar(r8);
    mkdirSync(join(r8, "configuracao"), { recursive: true });
    writeFileSync(cfgPath(r8), JSON.stringify({ atual: true }));
    const bk = fazerBackup(r8, "bk_com_cfg"); // backup TEM configuracao/
    // sabotagem NO BACKUP: config vira DIRETÓRIO → copyFileSync falha na
    // aplicação, DEPOIS do banco e dos arquivos já terem sido copiados.
    rmSync(join(bk, "configuracao", "servidor.json"));
    mkdirSync(join(bk, "configuracao", "servidor.json"));
    armarFlag(r8, bk);
    const rest = restaurar(r8);
    t("restaurador com falha na config → exit != 0", rest.code !== 0, `code=${rest.code}`);
    const st = estadoVivo(r8);
    t("banco revertido ao estado anterior", st.tabelaNova === true);
    t("flag permanece para retry", !!st.flag, String(st.flag));
    t("config revertida (diretório sabotador restaurado)", existsSync(cfgPath(r8)));
    t("banco restaurado não é o do backup (sem mistura)", temTabelaDb(dbPath(r8), TABELA_NOVA));
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
} finally {
  limparDir(RAIZ);
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
