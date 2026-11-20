import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { eq, inArray, getTableColumns } from "drizzle-orm";
import { getDb, CAMINHOS } from "../db/index.js";
import {
  assinarLedgerXp, assinarPacoteV2, obterChaveAssinatura, impressaoDigitalFicha,
  impressaoDigitalRegras, xpSemAssinaturaRaiz, type ContextoAssinatura,
} from "./assinatura-xp.js";
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
    // vtt_state corrompido não pode impedir exportação/snapshot da campanha
    sessions: await (async () => {
      try {
        return await db.select().from(sessions).where(eq(sessions.campaignId, campaignId));
      } catch (e) {
        console.error("[vtt] falha ao exportar sessões (vtt_state inválido?) — exportando sem o estado VTT:", e);
        const { vttState: _omit, ...cols } = getTableColumns(sessions);
        const rows = await db.select(cols).from(sessions).where(eq(sessions.campaignId, campaignId));
        return rows.map((r) => ({ ...r, vttState: null }));
      }
    })(),
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

  // Issue #162/B1-B2: assina o ledger XP de cada personagem — o pacote
  // não pode ser sua própria autoridade. A chave fica em server_settings
  // (não exportada); a assinatura cobre personagem, ledger integral e a
  // impressão digital das regras do pacote.
  const chave = await obterChaveAssinatura(db);
  const ctxAss: ContextoAssinatura = {
    chave,
    regrasFp: impressaoDigitalRegras(estado.ruleSets, estado.ruleDefinitions),
    // Issue #186/C3: a campanha de origem é o envelope do pacote —
    // vinculada ao payload v2 (CT11). Em "nova" o id é preservado; em
    // "substituir" pacote.campanhaId === campaignId (validado na rota).
    campanhaIdOrigem: campaignId,
  };
  // C3 (bloqueio 2 — fail-closed): a v2 só é emitida quando TODOS os
  // elos do fingerprint existem de verdade. Regras do pacote:
  //   - exatamente UM ruleset ativo, sem IDs duplicados;
  //   - `config.sangue` do ruleset ativo presente e objeto;
  //   - personagem com templateVersionId → sheetVersion PUBLICADA
  //     (publishedAt) com structure → sheetTemplate da MESMA campanha.
  // Qualquer elo ausente → o personagem NÃO recebe v2 (seu __xp segue
  // com sig v1 e seu __sangue fica sem prova — a importação descarta).
  const idsRulesVistos = new Set<string>();
  let rulesIdsDuplicados = false;
  for (const r of estado.ruleSets ?? []) {
    const id = String((r as { id?: unknown }).id ?? "");
    if (idsRulesVistos.has(id)) rulesIdsDuplicados = true;
    idsRulesVistos.add(id);
  }
  const rsAtivosExp = (estado.ruleSets ?? []).filter((r) => r.isActive === true || (r as { isActive?: unknown }).isActive === 1);
  const rsUnicoExp = !rulesIdsDuplicados && rsAtivosExp.length === 1 ? rsAtivosExp[0] : null;
  const configSangueExport = rsUnicoExp
    ? ((rsUnicoExp.config as Record<string, unknown> | undefined)?.sangue ?? null)
    : null;
  const pacoteSangueElegivel =
    !!rsUnicoExp &&
    !!configSangueExport && typeof configSangueExport === "object" && !Array.isArray(configSangueExport);
  const versaoPorIdExp = new Map(
    (estado.sheetVersions ?? []).map((v) => [String(v.id), v]),
  );
  const templatePorIdExp = new Map(
    (estado.sheetTemplates ?? []).map((t) => [String(t.id), t]),
  );
  const fichaFpExport = (row: (typeof estado.characters)[number]): string | null => {
    if (!pacoteSangueElegivel) return null;
    const tvId = (row as { templateVersionId?: unknown }).templateVersionId;
    if (typeof tvId !== "string" || !tvId) return null;
    const ver = versaoPorIdExp.get(tvId);
    if (!ver || ver.publishedAt == null || ver.structure == null) return null;
    const tpl = templatePorIdExp.get(String(ver.templateId ?? ""));
    if (!tpl || tpl.campaignId !== campaignId) return null;
    return impressaoDigitalFicha({
      templateVersionId: tvId,
      estrutura: ver.structure,
      configSangue: configSangueExport,
    });
  };
  for (const row of estado.characters ?? []) {
    const data = row.data as Record<string, unknown> | null;
    if (!data || typeof data !== "object") continue;
    const xp = data.__xp;
    const sangue = data.__sangue;
    // C3: personagem com ledger Sangue recebe assinatura CONJUNTA v2
    // (`__sangue_sig`, propriedade irmã do ledger) cobrindo XP+Sangue+
    // regras+personagem+campanha de origem. O `sig` v1 residual de
    // `__xp` é removido — nunca coexistem credenciais de transporte.
    if (sangue !== undefined && sangue !== null) {
      const fichaFp = fichaFpExport(row);
      if (fichaFp !== null) {
        const xpSem = xpSemAssinaturaRaiz(xp);
        data.__sangue_sig = assinarPacoteV2(ctxAss, {
          personagemId: String(row.id),
          xp: xpSem,
          sangue,
          fichaFp,
        });
        if (xp && typeof xp === "object" && !Array.isArray(xp)) {
          delete (xp as Record<string, unknown>).sig;
        }
        continue;
      }
      // cadeia incompleta → sem v2: __xp cai no fluxo v1 abaixo e
      // __sangue viaja sem prova (importação descarta + reporta)
    }
    if (!xp || typeof xp !== "object" || Array.isArray(xp)) continue;
    const xpObj = xp as Record<string, unknown>;
    const { sig: _antiga, ...xpSem } = xpObj;
    xpObj.sig = assinarLedgerXp(ctxAss, String(row.id), xpSem);
  }
  return { versao: 1, exportadoEm: new Date().toISOString(), campanhaId: campaignId, estado, arquivos };
}
