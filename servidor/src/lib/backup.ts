import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { getDb, CAMINHOS, RAIZ } from "../db/index.js";
import { backups, serverSettings } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { log } from "./logs.js";
import { config } from "../config.js";
import { dirsProtegidosBackup, normDir, protegerBackupContraRetencao, desprotegerBackupContraRetencao, referenciadoPorJournal } from "./protecao-backup.js";
import { validarBackup } from "./validar-backup.js";

const db = getDb();

export interface ConfigBackup {
  agenda: "diario" | "semanal" | "ambos" | "manual";
  hora: string;               // "HH:MM"
  retencaoDiarios: number;    // padrão 7
  retencaoSemanais: number;   // padrão 4
  pasta: string;              // relativo à raiz ou absoluto
}

export const BACKUP_PADRAO: ConfigBackup = {
  agenda: "diario", hora: "03:00", retencaoDiarios: 7, retencaoSemanais: 4,
  pasta: "backups",
};

export async function getSetting<T>(key: string, padrao: T): Promise<T> {
  const [r] = await db.select().from(serverSettings).where(eq(serverSettings.key, key)).limit(1);
  return (r?.value as T) ?? padrao;
}
export async function setSetting<T>(key: string, valor: T) {
  await db.insert(serverSettings).values({ key, value: valor as never, updatedAt: new Date() })
    .onConflictDoUpdate({ target: serverSettings.key, set: { value: valor as never, updatedAt: new Date() } });
}
export async function getConfigBackup(): Promise<ConfigBackup> {
  return getSetting("backup", BACKUP_PADRAO);
}
export async function setConfigBackup(c: Partial<ConfigBackup>) {
  const atual = await getConfigBackup();
  const novo = { ...atual, ...c };
  await setSetting("backup", novo);
  return novo;
}

// ---------- agendamento com recuperação de execuções perdidas ----------
// Modelo: para cada tipo (diario/semanal) guardamos em server_settings a chave da
// ocorrência programada mais recente JÁ coberta por um backup automático.
// A cada verificação calculamos a ocorrência programada mais recente ≤ agora;
// se ela for posterior à coberta, falta backup — executa UMA vez (recupera
// agendamentos perdidos sem gerar sequência de backups por dias desligado).

interface Cobertura { diario?: string; semanal?: string }
const RETRY_FALHA_MS = 30 * 60 * 1000; // falha → nova tentativa em 30 min (em memória)
const proximaTentativa = new Map<string, number>();

function fmtData(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Ocorrência programada mais recente de cada tipo, com sua chave de cobertura. */
function ocorrenciasRecentes(cfg: ConfigBackup, agora: Date): { tipo: "diario" | "semanal"; chave: string; quando: Date }[] {
  const [hh, mm] = cfg.hora.split(":").map(Number);
  const minutosAgendamento = (hh || 0) * 60 + (mm || 0);
  const agoraMinutos = agora.getHours() * 60 + agora.getMinutes();
  const out: { tipo: "diario" | "semanal"; chave: string; quando: Date }[] = [];

  if (cfg.agenda === "diario" || cfg.agenda === "ambos") {
    const d = new Date(agora);
    d.setHours(hh || 0, mm || 0, 0, 0);
    if (agoraMinutos < minutosAgendamento) d.setDate(d.getDate() - 1); // ainda não chegou a hora hoje → ocorrência é a de ontem
    out.push({ tipo: "diario", chave: `D${fmtData(d)}`, quando: d });
  }
  if (cfg.agenda === "semanal") {
    const d = new Date(agora);
    d.setHours(hh || 0, mm || 0, 0, 0);
    const diasDesdeDomingo = d.getDay();
    d.setDate(d.getDate() - diasDesdeDomingo);
    if (diasDesdeDomingo === 0 && agoraMinutos < minutosAgendamento) d.setDate(d.getDate() - 7);
    out.push({ tipo: "semanal", chave: `S${fmtData(d)}`, quando: d });
  }
  return out;
}

/**
 * Verifica agendamentos de backup. Chamada a cada minuto e uma vez na subida.
 * Executa no máximo um backup por tipo pendente; recupera agendamentos perdidos
 * (PC desligado no horário) sem duplicar execuções já concluídas.
 */
export async function verificarBackupAgendado(motivoInicio = false): Promise<void> {
  try {
    const cfg = await getConfigBackup();
    if (cfg.agenda === "manual") return;
    const agora = new Date();
    const cobertura = await getSetting<Cobertura>("backup_cobertura", {});
    const occs = ocorrenciasRecentes(cfg, agora);

    for (const occ of occs) {
      const chaveAtual = cobertura[occ.tipo];
      if (chaveAtual && chaveAtual >= occ.chave) continue; // ocorrência já coberta
      const agoraMs = Date.now();
      if ((proximaTentativa.get(occ.chave) ?? 0) > agoraMs) continue; // backoff após falha

      const recuperado = motivoInicio || (chaveAtual !== undefined && chaveAtual < occ.chave && occ.quando.getTime() < agoraMs - 60_000);
      // só marca como "recuperado" se a ocorrência é claramente passada (não é o minuto exato do agendamento)
      const rotulo = recuperado ? `Recuperado: agendado ${occ.tipo} perdido` : `Agendado ${cfg.agenda}`;
      try {
        const r = await criarBackup("automatico", `${rotulo} (${occ.chave})`);
        if (r.sucesso) {
          cobertura[occ.tipo] = occ.chave;
          await setSetting("backup_cobertura", cobertura);
          proximaTentativa.delete(occ.chave);
          if (recuperado) log("info", "backup recuperado de agendamento perdido", { tipo: occ.tipo, chave: occ.chave });
          else log("info", "backup agendado executado", { tipo: occ.tipo, chave: occ.chave });
        } else {
          proximaTentativa.set(occ.chave, agoraMs + RETRY_FALHA_MS);
          log("erro", "backup agendado falhou — nova tentativa em 30min", { tipo: occ.tipo, chave: occ.chave, erros: r.erros });
        }
      } catch (e) {
        proximaTentativa.set(occ.chave, agoraMs + RETRY_FALHA_MS);
        log("erro", "backup agendado falhou — nova tentativa em 30min", { tipo: occ.tipo, chave: occ.chave, erro: String(e) });
      }
    }
  } catch (e) {
    log("erro", "falha no agendador de backup", { erro: String(e) });
  }
}

export function pastaBackups(c: ConfigBackup): string {
  if (c.pasta.startsWith("/") || /^[A-Za-z]:/.test(c.pasta)) return resolve(c.pasta);
  // pasta padrão respeita MESTRE_BACKUPS/MESTRE_HOME — sem isso, backups
  // automáticos de testes caiam na pasta real do repositório.
  if (c.pasta === BACKUP_PADRAO.pasta) return CAMINHOS.backups;
  return resolve(RAIZ, c.pasta);
}

function sha256Arquivo(caminho: string): string {
  return createHash("sha256").update(readFileSync(caminho)).digest("hex");
}

/** Copia consistente do SQLite via API de backup do better-sqlite3.
 *  O destino pode ficar em modo WAL com -wal/-shm residuais: consolidamos
 *  com wal_checkpoint(TRUNCATE) e removemos os sidecars para que o
 *  snapshot seja UM arquivo autocontido — hasheável e restaurável sem
 *  depender de arquivos não declarados no manifesto. */
async function copiarBanco(destino: string) {
  const sqliteOrigem = new Database(CAMINHOS.banco, { readonly: true });
  try {
    await sqliteOrigem.backup(destino);
  } finally {
    sqliteOrigem.close();
  }
  const dest = new Database(destino);
  try {
    dest.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    // journal_mode=DELETE: o snapshot vira autocontido — nenhuma
    // abertura posterior (readonly inclusive) recria -wal/-shm, e o
    // inventário do manifesto permanece estável.
    dest.exec("PRAGMA journal_mode=DELETE");
  } finally {
    dest.close();
  }
  for (const suf of ["-wal", "-shm"]) rmSync(destino + suf, { force: true });
}

function verificarBanco(caminho: string): { ok: boolean; integridade?: string } {
  try {
    const s = new Database(caminho, { readonly: true });
    const r = s.pragma("integrity_check", { simple: true });
    s.close();
    return { ok: r === "ok", integridade: String(r) };
  } catch (e) {
    return { ok: false, integridade: String(e) };
  }
}

function copiarArquivos(origem: string, destino: string, raiz: string, manifesto: Record<string, { size: number; sha256: string }>) {
  if (!existsSync(origem)) return;
  for (const entrada of readdirSync(origem, { withFileTypes: true })) {
    if (entrada.name === ".lixeira") continue; // lixeira não entra no backup
    const src = join(origem, entrada.name);
    const dst = join(destino, entrada.name);
    if (entrada.isDirectory()) {
      mkdirSync(dst, { recursive: true });
      copiarArquivos(src, dst, raiz, manifesto);
    } else if (entrada.isFile()) {
      cpSync(src, dst);
      const rel = "arquivos/" + src.slice(raiz.length + 1).replace(/\\/g, "/");
      manifesto[rel] = { size: statSync(dst).size, sha256: sha256Arquivo(dst) };
    }
  }
}

/** Validação integral obrigatória do backup (manifesto v2 + inventário
 *  real × declarado + tamanho/SHA-256 + integridade SQLite + rejeição de
 *  traversal/symlinks). Delega ao módulo neutro validar-backup.ts —
 *  o mesmo validador usado pelo restaurador offline. */
export function validarManifestoBackup(dir: string): string[] {
  return validarBackup(dir).problemas;
}

/** Cria backup completo: banco (consistente), arquivos, config e manifesto.
 *  opts.proteger: marca o diretório como imune à retenção enquanto o
 *  journal que o referencia estiver ativo (backups transacionais/
 *  de recuperação). opts.meta: campos extras no manifesto. */
export async function criarBackup(
  kind: "automatico" | "manual" | "pre_restauracao" | "pre_update" = "manual",
  nota?: string,
  opts: { proteger?: boolean; meta?: Record<string, unknown> } = {},
) {
  const cfg = await getConfigBackup();
  const pasta = pastaBackups(cfg);
  const id = crypto.randomUUID();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(pasta, `${stamp}_${kind}`);
  mkdirSync(dir, { recursive: true });

  const manifesto: Record<string, unknown> = {
    manifestoVersao: 2,
    arquivos: {} as Record<string, { size: number; sha256: string }>,
    criadoEm: new Date().toISOString(), versao: lerVersao(),
    ...(opts.meta ?? {}),
  };
  const erros: string[] = [];

  // 1) banco — cópia consistente via API de backup
  try {
    await copiarBanco(join(dir, "mestre-rpg.db"));
    const dbDest = join(dir, "mestre-rpg.db");
    if (existsSync(dbDest)) {
      manifesto.banco = { size: statSync(dbDest).size, sha256: sha256Arquivo(dbDest) };
    }
  } catch (e) {
    erros.push(`banco: ${String(e)}`);
  }

  // 2) arquivos das campanhas
  try {
    copiarArquivos(CAMINHOS.arquivos, join(dir, "arquivos"), CAMINHOS.arquivos, manifesto.arquivos as Record<string, { size: number; sha256: string }>);
  } catch (e) {
    erros.push(`arquivos: ${String(e)}`);
  }

  // 3) configurações (sem segredos — servidor.json não contém credenciais)
  //    Absência intencional é representada explicitamente: configuracao=null.
  manifesto.configuracao = null;
  try {
    const cfgSrc = resolve(RAIZ, "configuracao", "servidor.json");
    if (existsSync(cfgSrc)) {
      mkdirSync(join(dir, "configuracao"), { recursive: true });
      cpSync(cfgSrc, join(dir, "configuracao", "servidor.json"));
      const cfgDest = join(dir, "configuracao", "servidor.json");
      manifesto.configuracao = { size: statSync(cfgDest).size, sha256: sha256Arquivo(cfgDest) };
    }
  } catch (e) {
    erros.push(`config: ${String(e)}`);
  }

  writeFileSync(join(dir, "manifesto.json"), JSON.stringify(manifesto, null, 2));

  // 4) validação antes de marcar sucesso — manifesto integral obrigatório
  const bancoOk = existsSync(join(dir, "mestre-rpg.db")) && verificarBanco(join(dir, "mestre-rpg.db")).ok;
  const problemasManifesto = validarManifestoBackup(dir);
  const sucesso = erros.length === 0 && bancoOk && problemasManifesto.length === 0;

  // Backup transacional/de recuperação: proteção contra retenção é
  // OBRIGATÓRIA — sem marcador não há como garantir que a rotação não o
  // remova enquanto o journal estiver ativo. Falha aqui = backup falha.
  if (sucesso && opts.proteger) {
    const ok = await protegerBackupContraRetencao(dir, nota ?? kind);
    if (!ok) {
      erros.push("proteção contra retenção não pôde ser gravada");
      rmSync(dir, { recursive: true, force: true });
      log("erro", "backup pre-update falhou: state dir indisponível", { id, dir });
      return { id, dir, sucesso: false, erros, tamanho: 0, faltando: 0 };
    }
  }

  const tamanho = tamanhoDir(dir);
  const [row] = await db.insert(backups).values({
    id, campaignId: null, kind, filePath: dir, sizeBytes: tamanho,
    note: nota ?? (sucesso ? "Backup completo" : `Falha: ${erros.join("; ")}`),
    createdBy: null, createdAt: new Date(),
  }).returning();

  if (sucesso) {
    await aplicarRetencao(cfg);
    log("info", "backup criado", { id, dir, tamanho });
  } else {
    log("erro", "backup falhou", { id, erros, bancoOk, problemasManifesto });
  }
  return { id, dir, sucesso, erros, tamanho, problemasManifesto };
}

function tamanhoDir(dir: string): number {
  let total = 0;
  const andar = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) andar(p); else total += statSync(p).size;
    }
  };
  try { andar(dir); } catch { }
  return total;
}

function lerVersao(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(RAIZ, "package.json"), "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch { return "0.0.0"; }
}

/** Remove backups antigos além da retenção (só após novo backup validado).
 *  Backups protegidos por journal/marker ativo NUNCA são removidos;
 *  se a varredura de proteção falhar, a retenção inteira é abortada
 *  (fail-safe — nunca rotacionar sem prova). */
async function aplicarRetencao(cfg: ConfigBackup) {
  const protegidos = await dirsProtegidosBackup();
  if (protegidos === null) {
    log("erro", "retenção abortada: não foi possível verificar backups protegidos");
    return;
  }
  const lista = (await listarBackups()).filter((b) => !protegidos.has(normDir(b.filePath)));
  const agora = Date.now();
  const DIAS = 86400000;
  const classificar = (b: BackupInfo) => {
    const dias = (agora - new Date(b.createdAt).getTime()) / DIAS;
    if (cfg.agenda === "semanal" || (cfg.agenda === "ambos" && dias >= 7)) return "semanal";
    return "diario";
  };
  const diarios = lista.filter((b) => classificar(b) === "diario").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const semanais = lista.filter((b) => classificar(b) === "semanal").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const remover = [...diarios.slice(cfg.retencaoDiarios), ...semanais.slice(cfg.retencaoSemanais)];
  for (const b of remover) {
    try { rmSync(b.filePath, { recursive: true, force: true }); } catch { }
    await db.delete(backups).where(eq(backups.id, b.id));
  }
}

export interface BackupInfo {
  id: string; kind: string; filePath: string; sizeBytes: number | null;
  note: string | null; createdAt: string; sucesso?: boolean; integridade?: string;
}

export async function listarBackups(): Promise<BackupInfo[]> {
  const todos = await db.select().from(backups);
  return todos
    .filter((b) => !b.campaignId) // somente backups completos do servidor
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .map((b) => ({
      id: b.id, kind: b.kind, filePath: b.filePath, sizeBytes: b.sizeBytes,
      note: b.note, createdAt: String(b.createdAt),
      sucesso: b.note?.startsWith("Falha") ? false : existsSync(b.filePath),
    }));
}

/** Verifica integridade de um backup (banco + arquivos do manifesto). */
export async function verificarBackup(id: string): Promise<{ ok: boolean; detalhes: string[] }> {
  const detalhes: string[] = [];
  const todos = await db.select().from(backups);
  const b = todos.find((x) => x.id === id && !x.campaignId);
  if (!b) return { ok: false, detalhes: ["Backup não encontrado"] };
  const dbPath = join(b.filePath, "mestre-rpg.db");
  if (!existsSync(dbPath)) { detalhes.push("banco ausente"); return { ok: false, detalhes }; }
  const integ = verificarBanco(dbPath);
  if (!integ.ok) { detalhes.push(`banco corrompido: ${integ.integridade}`); return { ok: false, detalhes }; }
  detalhes.push("banco ok");
  // validação integral do manifesto — obrigatória para backups novos
  // (manifestoVersao 2). Backups antigos sem o campo novo caem na
  // verificação legada de arquivos apenas.
  // validação integral obrigatória — manifesto v2 + inventário real +
  // hashes + integridade (mesmo validador do restaurador offline).
  const v = validarBackup(b.filePath);
  if (!v.ok) { detalhes.push(...v.problemas.slice(0, 5)); return { ok: false, detalhes }; }
  detalhes.push("backup íntegro (manifesto v2 + inventário + integridade)");
  return { ok: true, detalhes };
}

/** Preparação de restauração: backup de segurança + proteção do alvo
 *  contra retenção + flag pendente (offline aplica).
 *  Ordem obrigatória (fail-closed):
 *   1. validação integral do alvo (mesmo validador do restaurador);
 *   2. PROTEÇÃO do alvo contra retenção — se falhar, o pedido é
 *      rejeitado ANTES de qualquer flag;
 *   3. backup de segurança do estado atual;
 *   4. flag restauracao_pendente — se a gravação falhar, o marker só é
 *      removido depois de consultar o estado persistido (flag +
 *      journals), nunca uma proteção ainda necessária.
 *  Não existe transação entre marker (state dir) e flag (banco): a
 *  ordem proteção→flag elimina a janela "flag sem proteção"; a janela
 *  "marker sem flag" é inofensiva (over-protection até expirar). */
export async function prepararRestauracao(backupId: string, usuarioId: string) {
  const todos = await db.select().from(backups);
  const alvo = todos.find((b) => b.id === backupId && !b.campaignId);
  if (!alvo) return { erro: "Backup não encontrado", status: 404 };
  // validação integral: integridade + manifesto v2 + inventário + hashes
  const v = validarBackup(alvo.filePath);
  if (!v.ok) return { erro: `Backup inválido: ${v.problemas[0]}`, status: 400 };

  // 2) proteção do alvo ANTES da flag — sem ela o backup poderia ser
  //    rotacionado entre o pedido e a aplicação offline.
  const protegido = await protegerBackupContraRetencao(alvo.filePath, "restauracao_pendente");
  if (!protegido) {
    return { erro: "Não foi possível proteger o backup contra retenção — pedido rejeitado", status: 503 };
  }

  // só remove a proteção do alvo se NADA persistido ainda a referencia
  // (nem flag no banco, nem journal no state dir). Incerto → mantém.
  const desprotegerSeDesnecessario = async () => {
    try {
      const [flag] = await db.select().from(serverSettings).where(eq(serverSettings.key, "restauracao_pendente")).limit(1);
      const refFlag = typeof flag?.value === "string"
        ? (JSON.parse(flag.value) as { filePath?: string }).filePath
        : (flag?.value as { filePath?: string } | undefined)?.filePath;
      if (refFlag === alvo.filePath) return; // flag ainda aponta para o alvo
      const refJournal = await referenciadoPorJournal(alvo.filePath);
      if (refJournal !== false) return; // journal referencia OU verificação inconclusiva
      await desprotegerBackupContraRetencao(alvo.filePath);
    } catch (e) {
      log("erro", "falha ao avaliar desproteção do backup alvo", { backupId, erro: String(e) });
    }
  };

  // 3) backup de segurança do estado atual antes de qualquer restauração
  let seguranca;
  try {
    seguranca = await criarBackup("pre_restauracao", `Segurança antes de restaurar ${backupId}`);
  } catch (e) {
    await desprotegerSeDesnecessario();
    return { erro: `Falha ao criar backup de segurança: ${String(e)}`, status: 500 };
  }

  // flag anterior (se houver) — para desproteção do alvo substituído
  const [flagAnterior] = await db.select().from(serverSettings).where(eq(serverSettings.key, "restauracao_pendente")).limit(1);
  const filePathAnterior = typeof flagAnterior?.value === "string"
    ? (JSON.parse(flagAnterior.value) as { filePath?: string }).filePath
    : (flagAnterior?.value as { filePath?: string } | undefined)?.filePath;

  // 4) flag pendente — estado intermediário tratado consultando o
  //    persistido antes de mexer no marker.
  try {
    await db.insert(serverSettings).values({
      key: "restauracao_pendente", value: { backupId, filePath: alvo.filePath, por: usuarioId, em: new Date().toISOString() } as never, updatedAt: new Date(),
    }).onConflictDoUpdate({ target: serverSettings.key, set: { value: { backupId, filePath: alvo.filePath, por: usuarioId, em: new Date().toISOString() } as never, updatedAt: new Date() } });
  } catch (e) {
    await desprotegerSeDesnecessario();
    return { erro: `Falha ao registrar restauração pendente: ${String(e)}`, status: 500 };
  }

  // flag gravada: se a anterior apontava outro backup, remove a proteção
  // antiga SOMENTE se nenhum journal ainda a referencia (a flag já não).
  if (filePathAnterior && filePathAnterior !== alvo.filePath) {
    try {
      const ref = await referenciadoPorJournal(filePathAnterior);
      if (ref === false) await desprotegerBackupContraRetencao(filePathAnterior);
      // ref null → inconclusivo → mantém proteção (nunca remove o que
      // ainda pode ser necessário para recuperação)
    } catch (e) {
      log("erro", "falha ao desproteger backup anterior", { filePath: filePathAnterior, erro: String(e) });
    }
  }

  return { ok: true, seguranca, arquivoPath: alvo.filePath };
}

/** Marca log de inicialização. */
export function logInicio() {
  log("info", "servidor iniciado", { porta: config.porta });
}
export function logFim(sinal: string) {
  log("info", "servidor encerrando", { sinal });
}
