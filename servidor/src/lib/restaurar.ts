import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { eq, getTableColumns, inArray } from "drizzle-orm";
import { getDb, CAMINHOS } from "../db/index.js";
import {
  campaigns, memberships, invitations, sheetTemplates, sheetVersions, characters, characterFields,
  ruleSets, ruleDefinitions, itemTemplates, inventoryEntries, equipmentEntries, vehicles,
  financialAccounts, moneyTransactions, sessions, turns, chatMessages, rolls, tests, notes, files, folders, noteAttachments,
} from "../db/schema.js";
import type { EstadoCampanha } from "./estado.js";

const db = getDb();
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const CAMPOS_CAMPANHA = ["name", "description", "system", "summary", "status", "settings", "coverImage"] as const;

export interface ResultadoRestauracao {
  arquivosRecuperados: number;
  arquivosAusentes: string[];
}

function reviverDatas(row: Record<string, unknown>, cols: Record<string, { dataType: string }>) {
  const out: Record<string, unknown> = { ...row };
  for (const [k, v] of Object.entries(out)) {
    if (typeof v === "string" && cols[k]?.dataType === "date") out[k] = new Date(v);
  }
  return out;
}

function inserir(tx: Tx, tabela: Parameters<typeof tx.insert>[0], rows: readonly unknown[] | undefined) {
  if (!rows?.length) return;
  const cols = getTableColumns(tabela as never) as Record<string, { dataType: string }>;
  tx.insert(tabela).values((rows as Record<string, unknown>[]).map((r) => reviverDatas(r, cols)) as never).run();
}

// `data.__arquivamento` é metadado reservado, autoridade exclusiva do
// backend (rotas /arquivar e /desarquivar). Pacotes de importação ou
// snapshots adulterados não podem forjá-lo: personagem arquivado precisa
// de statusAnterior válido (senão assume rascunho); fora de arquivado a
// chave é sempre removida.
const STATUS_RESTAURO_VALORES = new Set(["rascunho", "aguardando_aprovacao", "devolvida", "reaberta", "aprovada", "bloqueada"]);
function sanitizarArquivamento(row: Record<string, unknown>) {
  const data = (row.data && typeof row.data === "object" ? { ...(row.data as Record<string, unknown>) } : {}) as Record<string, unknown>;
  const meta = data.__arquivamento as Record<string, unknown> | undefined;
  if (row.status === "arquivado") {
    const anterior = typeof meta?.statusAnterior === "string" && STATUS_RESTAURO_VALORES.has(meta.statusAnterior) ? meta.statusAnterior : "rascunho";
    data.__arquivamento = {
      statusAnterior: anterior,
      arquivadoEm: typeof meta?.arquivadoEm === "string" ? meta.arquivadoEm : null,
      arquivadoPor: typeof meta?.arquivadoPor === "string" ? meta.arquivadoPor : null,
    };
  } else {
    delete data.__arquivamento;
  }
  row.data = data;
}

// Snapshots e pacotes exportados antes da migration 0023 podem conter
// (campaign_id, number) duplicados em sessions — a constraint única
// rejeitaria a restauração/importação. Mesma regra da migration: a
// ocorrência mais antiga de cada número é preservada e as demais recebem
// números acima do MAX da campanha, na ordem de criação. IDs e demais
// referências das sessões não mudam.
export function normalizarNumerosSessao(rows: unknown[] | undefined) {
  if (!rows?.length) return rows;
  const criadoEm = (r: Record<string, unknown>) => {
    const v = r.createdAt ?? r.created_at;
    if (v instanceof Date) return v.getTime();
    if (typeof v === "number") return v;
    const t = Date.parse(String(v ?? ""));
    return Number.isNaN(t) ? 0 : t;
  };
  const porCampanha = new Map<string, Record<string, unknown>[]>();
  for (const row of rows as Record<string, unknown>[]) {
    const cid = String(row.campaignId ?? row.campaign_id ?? "");
    const lista = porCampanha.get(cid) ?? [];
    lista.push(row);
    porCampanha.set(cid, lista);
  }
  for (const lista of porCampanha.values()) {
    const ordenada = [...lista].sort(
      (a, b) => criadoEm(a) - criadoEm(b) || String(a.id ?? "").localeCompare(String(b.id ?? "")),
    );
    const ocupados = new Set<number>();
    let proximo = Math.max(0, ...lista.map((r) => Number(r.number ?? 0) || 0)) + 1;
    for (const r of ordenada) {
      const n = Number(r.number ?? 0) || 0;
      if (!ocupados.has(n)) { ocupados.add(n); continue; }
      r.number = proximo++;
    }
  }
  return rows;
}

/** Insere todas as entidades do estado na ordem de dependência (restauração e importação). */
export function inserirEstado(tx: Tx, dados: EstadoCampanha) {
  for (const r of (dados.characters ?? []) as Record<string, unknown>[]) sanitizarArquivamento(r);
  inserir(tx, memberships, dados.memberships);
  inserir(tx, invitations, dados.invitations);
  inserir(tx, sheetTemplates, dados.sheetTemplates);
  inserir(tx, sheetVersions, dados.sheetVersions);
  inserir(tx, characters, dados.characters);
  inserir(tx, characterFields, dados.characterFields);
  inserir(tx, ruleSets, dados.ruleSets);
  inserir(tx, ruleDefinitions, dados.ruleDefinitions);
  inserir(tx, itemTemplates, dados.itemTemplates);
  inserir(tx, inventoryEntries, dados.inventoryEntries);
  inserir(tx, equipmentEntries, dados.equipmentEntries);
  inserir(tx, vehicles, dados.vehicles);
  inserir(tx, financialAccounts, dados.financialAccounts);
  inserir(tx, moneyTransactions, dados.moneyTransactions);
  inserir(tx, sessions, normalizarNumerosSessao(dados.sessions));
  inserir(tx, turns, dados.turns);
  inserir(tx, chatMessages, dados.chatMessages);
  inserir(tx, rolls, dados.rolls);
  inserir(tx, tests, dados.tests);
  inserir(tx, notes, dados.notes);
  inserir(tx, folders, dados.folders);
  inserir(tx, files, dados.files);
  inserir(tx, noteAttachments, dados.noteAttachments);
}

/**
 * Restaura o estado de uma campanha a partir de um EstadoCampanha exportado.
 * Transacional no banco; arquivos físicos movidos para a lixeira e recuperados
 * em seguida (best-effort, nunca deixa registros apontando para caminho inválido).
 */
export async function restaurarEstado(campaignId: string, dados: EstadoCampanha, opts: { gravarArquivos?: Record<string, { conteudo: string }> } = {}): Promise<ResultadoRestauracao> {
  // ids necessários para deletes com FK indireta (calculados antes da transação)
  const charIds = (await db.select({ id: characters.id }).from(characters).where(eq(characters.campaignId, campaignId))).map((r) => r.id);
  const tplIds = (await db.select({ id: sheetTemplates.id }).from(sheetTemplates).where(eq(sheetTemplates.campaignId, campaignId))).map((r) => r.id);
  const sessIds = (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.campaignId, campaignId))).map((r) => r.id);
  const ruleSetIds = (await db.select({ id: ruleSets.id }).from(ruleSets).where(eq(ruleSets.campaignId, campaignId))).map((r) => r.id);
  const noteIds = (await db.select({ id: notes.id }).from(notes).where(eq(notes.campaignId, campaignId))).map((r) => r.id);
  // arquivos físicos dos registros que serão substituídos vão para a lixeira (recuperáveis)
  const arquivosAtuais = await db.select({ storageName: files.storageName }).from(files).where(eq(files.campaignId, campaignId));
  const baseDir = resolve(CAMINHOS.arquivos, campaignId);
  const lixeira = resolve(baseDir, ".lixeira");
  const moverParaLixeira = (storageName: string | null) => {
    if (!storageName) return;
    const origem = resolve(baseDir, storageName);
    if (!origem.startsWith(baseDir + sep)) return;
    const destino = resolve(lixeira, storageName);
    if (existsSync(origem) && !existsSync(destino)) {
      mkdirSync(lixeira, { recursive: true });
      try { renameSync(origem, destino); } catch { /* best-effort */ }
    }
  };

  db.transaction((tx) => {
    const limpar = (tabela: Parameters<typeof tx.delete>[0], where: unknown) =>
      tx.delete(tabela).where(where as never).run();
    // filhos primeiro
    limpar(tests, eq(tests.campaignId, campaignId));
    limpar(rolls, eq(rolls.campaignId, campaignId));
    limpar(chatMessages, eq(chatMessages.campaignId, campaignId));
    if (sessIds.length) limpar(turns, inArray(turns.sessionId, sessIds));
    limpar(sessions, eq(sessions.campaignId, campaignId));
    limpar(moneyTransactions, eq(moneyTransactions.campaignId, campaignId));
    limpar(financialAccounts, eq(financialAccounts.campaignId, campaignId));
    limpar(vehicles, eq(vehicles.campaignId, campaignId));
    if (charIds.length) {
      limpar(equipmentEntries, inArray(equipmentEntries.characterId, charIds));
      limpar(inventoryEntries, inArray(inventoryEntries.characterId, charIds));
      limpar(characterFields, inArray(characterFields.characterId, charIds));
    }
    if (noteIds.length) limpar(noteAttachments, inArray(noteAttachments.noteId, noteIds));
    limpar(notes, eq(notes.campaignId, campaignId));
    limpar(files, eq(files.campaignId, campaignId));
    limpar(folders, eq(folders.campaignId, campaignId));
    limpar(characters, eq(characters.campaignId, campaignId));
    if (tplIds.length) limpar(sheetVersions, inArray(sheetVersions.templateId, tplIds));
    limpar(sheetTemplates, eq(sheetTemplates.campaignId, campaignId));
    if (ruleSetIds.length) limpar(ruleDefinitions, inArray(ruleDefinitions.ruleSetId, ruleSetIds));
    limpar(ruleSets, eq(ruleSets.campaignId, campaignId));
    limpar(itemTemplates, eq(itemTemplates.campaignId, campaignId));
    limpar(invitations, eq(invitations.campaignId, campaignId));
    limpar(memberships, eq(memberships.campaignId, campaignId));

    // campos mutáveis da campanha
    const c = dados.campanha ?? {};
    const upd: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of CAMPOS_CAMPANHA) if (c[k] !== undefined) upd[k] = c[k];
    tx.update(campaigns).set(upd).where(eq(campaigns.id, campaignId)).run();

    // reinsere na ordem de dependência (datas voltam de ISO string para Date)
    inserirEstado(tx, dados);
  });

  // ---- arquivos físicos: lixeira dos substituídos + gravação dos importados ----
  for (const a of arquivosAtuais) moverParaLixeira(a.storageName);
  let arquivosRecuperados = 0;
  const arquivosAusentes: string[] = [];
  const binarios = opts.gravarArquivos ?? {};
  for (const f of dados.files ?? []) {
    if (!f.storageName) continue;
    const vivo = resolve(baseDir, f.storageName);
    const naLixeira = resolve(lixeira, f.storageName);
    if (vivo.startsWith(baseDir + sep) && existsSync(naLixeira) && !existsSync(vivo)) {
      mkdirSync(baseDir, { recursive: true });
      try { renameSync(naLixeira, vivo); } catch { /* segue */ }
    }
    // pacote de importação pode trazer o binário embutido
    const embutido = binarios[f.id];
    if (embutido && !existsSync(vivo)) {
      try {
        mkdirSync(baseDir, { recursive: true });
        writeFileSync(vivo, Buffer.from(embutido.conteudo, "base64"));
      } catch { /* segue */ }
    }
    if (existsSync(vivo)) arquivosRecuperados++;
    else arquivosAusentes.push(f.fileName ?? f.id);
  }

  return { arquivosRecuperados, arquivosAusentes };
}
