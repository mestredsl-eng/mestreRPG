import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { getDb, CAMINHOS } from "../db/index.js";
import {
  campaigns, memberships, invitations, sheetTemplates, sheetVersions, characters, characterFields,
  ruleSets, ruleDefinitions, itemTemplates, inventoryEntries, equipmentEntries, vehicles,
  financialAccounts, moneyTransactions, sessions, turns, chatMessages, rolls, tests, notes, files, folders, noteAttachments,
} from "../db/schema.js";

const db = getDb();

export interface EstadoCampanha {
  campanha: Record<string, unknown>;
  memberships: (typeof memberships.$inferSelect)[];
  invitations: (typeof invitations.$inferSelect)[];
  sheetTemplates: (typeof sheetTemplates.$inferSelect)[];
  sheetVersions: (typeof sheetVersions.$inferSelect)[];
  characters: (typeof characters.$inferSelect)[];
  characterFields: (typeof characterFields.$inferSelect)[];
  ruleSets: (typeof ruleSets.$inferSelect)[];
  ruleDefinitions: (typeof ruleDefinitions.$inferSelect)[];
  itemTemplates: (typeof itemTemplates.$inferSelect)[];
  inventoryEntries: (typeof inventoryEntries.$inferSelect)[];
  equipmentEntries: (typeof equipmentEntries.$inferSelect)[];
  vehicles: (typeof vehicles.$inferSelect)[];
  financialAccounts: (typeof financialAccounts.$inferSelect)[];
  moneyTransactions: (typeof moneyTransactions.$inferSelect)[];
  sessions: (typeof sessions.$inferSelect)[];
  turns: (typeof turns.$inferSelect)[];
  chatMessages: (typeof chatMessages.$inferSelect)[];
  rolls: (typeof rolls.$inferSelect)[];
  tests: (typeof tests.$inferSelect)[];
  notes: (typeof notes.$inferSelect)[];
  files: (typeof files.$inferSelect)[];
  folders: (typeof folders.$inferSelect)[];
  noteAttachments: (typeof noteAttachments.$inferSelect)[];
}

/** Exporta o estado completo da campanha (spec §4/§5). */
export async function exportarCampanha(campaignId: string): Promise<EstadoCampanha> {
  const campanha = (await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1))[0];
  const tplIds = (await db.select({ id: sheetTemplates.id }).from(sheetTemplates).where(eq(sheetTemplates.campaignId, campaignId))).map((r) => r.id);
  const charIds = (await db.select({ id: characters.id }).from(characters).where(eq(characters.campaignId, campaignId))).map((r) => r.id);
  const sessIds = (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.campaignId, campaignId))).map((r) => r.id);
  const ruleSetIds = (await db.select({ id: ruleSets.id }).from(ruleSets).where(eq(ruleSets.campaignId, campaignId))).map((r) => r.id);
  const noteIds = (await db.select({ id: notes.id }).from(notes).where(eq(notes.campaignId, campaignId))).map((r) => r.id);
  const fileIds = (await db.select({ id: files.id }).from(files).where(eq(files.campaignId, campaignId))).map((r) => r.id);

  const { id: _id, createdAt: _c, updatedAt: _u, ownerId: _o, ...restoCampanha } = campanha ?? {};

  return {
    campanha: restoCampanha as Record<string, unknown>,
    memberships: await db.select().from(memberships).where(eq(memberships.campaignId, campaignId)),
    invitations: await db.select().from(invitations).where(eq(invitations.campaignId, campaignId)),
    sheetTemplates: await db.select().from(sheetTemplates).where(eq(sheetTemplates.campaignId, campaignId)),
    sheetVersions: tplIds.length ? await db.select().from(sheetVersions).where(inArray(sheetVersions.templateId, tplIds)) : [],
    characters: await db.select().from(characters).where(eq(characters.campaignId, campaignId)),
    characterFields: charIds.length ? await db.select().from(characterFields).where(inArray(characterFields.characterId, charIds)) : [],
    ruleSets: await db.select().from(ruleSets).where(eq(ruleSets.campaignId, campaignId)),
    ruleDefinitions: ruleSetIds.length ? await db.select().from(ruleDefinitions).where(inArray(ruleDefinitions.ruleSetId, ruleSetIds)) : [],
    itemTemplates: await db.select().from(itemTemplates).where(eq(itemTemplates.campaignId, campaignId)),
    inventoryEntries: charIds.length ? await db.select().from(inventoryEntries).where(inArray(inventoryEntries.characterId, charIds)) : [],
    equipmentEntries: charIds.length ? await db.select().from(equipmentEntries).where(inArray(equipmentEntries.characterId, charIds)) : [],
    vehicles: await db.select().from(vehicles).where(eq(vehicles.campaignId, campaignId)),
    financialAccounts: await db.select().from(financialAccounts).where(eq(financialAccounts.campaignId, campaignId)),
    moneyTransactions: await db.select().from(moneyTransactions).where(eq(moneyTransactions.campaignId, campaignId)),
    sessions: await db.select().from(sessions).where(eq(sessions.campaignId, campaignId)),
    turns: sessIds.length ? await db.select().from(turns).where(inArray(turns.sessionId, sessIds)) : [],
    chatMessages: await db.select().from(chatMessages).where(eq(chatMessages.campaignId, campaignId)),
    rolls: await db.select().from(rolls).where(eq(rolls.campaignId, campaignId)),
    tests: await db.select().from(tests).where(eq(tests.campaignId, campaignId)),
    notes: await db.select().from(notes).where(eq(notes.campaignId, campaignId)),
    files: await db.select().from(files).where(eq(files.campaignId, campaignId)),
    folders: await db.select().from(folders).where(eq(folders.campaignId, campaignId)),
    noteAttachments: noteIds.length && fileIds.length
      ? await db.select().from(noteAttachments).where(inArray(noteAttachments.noteId, noteIds))
      : [],
  };
}

export interface PacoteExportacao {
  versao: 1;
  exportadoEm: string;
  campanhaId: string;
  estado: EstadoCampanha;
  /** Conteúdo dos arquivos físicos em base64, indexado por fileId. */
  arquivos: Record<string, { conteudo: string; mimeType: string | null }>;
}

/** Monta o pacote de exportação da campanha incluindo os binários dos arquivos. */
export async function exportarPacote(campaignId: string): Promise<PacoteExportacao> {
  const estado = await exportarCampanha(campaignId);
  const baseDir = resolve(CAMINHOS.arquivos, campaignId);
  const arquivos: PacoteExportacao["arquivos"] = {};
  for (const f of estado.files) {
    if (!f.storageName) continue;
    const caminho = resolve(baseDir, f.storageName);
    if (!caminho.startsWith(baseDir + sep)) continue;
    try {
      arquivos[f.id] = { conteudo: readFileSync(caminho).toString("base64"), mimeType: f.mimeType ?? null };
    } catch { /* arquivo físico ausente — metadados ainda exportados */ }
  }
  return { versao: 1, exportadoEm: new Date().toISOString(), campanhaId: campaignId, estado, arquivos };
}
