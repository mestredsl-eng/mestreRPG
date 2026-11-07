import { Router } from "express";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { resolve, sep } from "node:path";
import { and, desc, eq, getTableColumns, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/index.js";
import {
  campaigns, memberships, invitations, sheetTemplates, sheetVersions, characters, characterFields,
  ruleSets, ruleDefinitions, itemTemplates, inventoryEntries, equipmentEntries, vehicles,
  financialAccounts, moneyTransactions, sessions, turns, chatMessages, rolls, tests, notes, files, folders,
  snapshots, users,
} from "../db/schema.js";
import { CAMINHOS } from "../db/index.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePapel } from "../lib/permissoes.js";
import { audit } from "../lib/audit.js";
import { emitirCampanha } from "../lib/io.js";

const db = getDb();
export const snapshotsRouter = Router({ mergeParams: true });
snapshotsRouter.use(requireAuth);

const CAMPOS_CAMPANHA = ["name", "description", "system", "summary", "status", "settings", "coverImage"] as const;

interface EstadoCampanha {
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
}

/** Exporta o estado completo da campanha (spec §4/§5). */
async function exportarCampanha(campaignId: string): Promise<EstadoCampanha> {
  const campanha = (await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1))[0];
  const tplIds = (await db.select({ id: sheetTemplates.id }).from(sheetTemplates).where(eq(sheetTemplates.campaignId, campaignId))).map((r) => r.id);
  const charIds = (await db.select({ id: characters.id }).from(characters).where(eq(characters.campaignId, campaignId))).map((r) => r.id);
  const sessIds = (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.campaignId, campaignId))).map((r) => r.id);
  const ruleSetIds = (await db.select({ id: ruleSets.id }).from(ruleSets).where(eq(ruleSets.campaignId, campaignId))).map((r) => r.id);

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
  };
}

/** GET /api/campaigns/:campaignId/snapshots — lista (mestre) */
snapshotsRouter.get("/", requirePapel("mestre"), async (req, res) => {
  const lista = await db.select({
    id: snapshots.id, description: snapshots.description, createdAt: snapshots.createdAt, createdBy: snapshots.createdBy,
  }).from(snapshots).where(eq(snapshots.campaignId, req.params.campaignId)).orderBy(desc(snapshots.createdAt));
  const ids = [...new Set(lista.map((s) => s.createdBy))];
  const mapa = new Map((ids.length ? await db.select({ id: users.id, username: users.username, displayName: users.displayName }).from(users).where(inArray(users.id, ids)) : []).map((u) => [u.id, u]));
  res.json({ snapshots: lista.map((s) => ({ ...s, autor: mapa.get(s.createdBy) ?? null })) });
});

const criarSchema = z.object({ description: z.string().max(500).optional() });

/** POST /api/campaigns/:campaignId/snapshots — ponto de recuperação (mestre) */
snapshotsRouter.post("/", requirePapel("mestre"), async (req, res) => {
  const body = criarSchema.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ erro: "Dados inválidos" }); return; }
  const dados = await exportarCampanha(req.params.campaignId);
  const id = crypto.randomUUID();
  await db.insert(snapshots).values({
    id, campaignId: req.params.campaignId, description: body.data.description ?? null,
    data: dados as never, createdBy: req.usuario!.id, createdAt: new Date(),
  });
  await audit(req, "snapshot.criado", { snapshotId: id });
  emitirCampanha(req.params.campaignId, "snapshots:atualizados", {});
  res.status(201).json({ id });
});

const restaurarSchema = z.object({ confirmacao: z.literal("RESTAURAR") });

/** POST /api/campaigns/:campaignId/snapshots/:snapshotId/restaurar — somente mestre, auditado */
snapshotsRouter.post("/:snapshotId/restaurar", requirePapel("mestre"), async (req, res) => {
  const body = restaurarSchema.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ erro: 'Confirmação obrigatória: { "confirmacao": "RESTAURAR" }' }); return; }
  const [snap] = await db.select().from(snapshots).where(and(eq(snapshots.id, req.params.snapshotId), eq(snapshots.campaignId, req.params.campaignId))).limit(1);
  if (!snap) { res.status(404).json({ erro: "Snapshot não encontrado" }); return; }
  const dados = snap.data as EstadoCampanha;
  const cid = req.params.campaignId;

  // Estado atual é preservado num snapshot automático ANTES de restaurar (spec §5)
  const preSnapId = crypto.randomUUID();
  const estadoAtual = await exportarCampanha(cid);
  await db.insert(snapshots).values({
    id: preSnapId, campaignId: cid,
    description: `Automático — antes de restaurar snapshot ${snap.id}`,
    data: estadoAtual as never, createdBy: req.usuario!.id, createdAt: new Date(),
  });

  // ids necessários para deletes com FK indireta (calculados antes da transação)
  const charIds = (await db.select({ id: characters.id }).from(characters).where(eq(characters.campaignId, cid))).map((r) => r.id);
  const tplIds = (await db.select({ id: sheetTemplates.id }).from(sheetTemplates).where(eq(sheetTemplates.campaignId, cid))).map((r) => r.id);
  const sessIds = (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.campaignId, cid))).map((r) => r.id);
  const ruleSetIds = (await db.select({ id: ruleSets.id }).from(ruleSets).where(eq(ruleSets.campaignId, cid))).map((r) => r.id);
  // arquivos físicos dos registros que serão substituídos vão para a lixeira (recuperáveis)
  const arquivosAtuais = await db.select({ storageName: files.storageName }).from(files).where(eq(files.campaignId, cid));
  const baseDir = resolve(CAMINHOS.arquivos, cid);
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

  try {
    db.transaction((tx) => {
      const limpar = (tabela: Parameters<typeof tx.delete>[0], where: unknown) =>
        tx.delete(tabela).where(where as never).run();
      // filhos primeiro
      limpar(tests, eq(tests.campaignId, cid));
      limpar(rolls, eq(rolls.campaignId, cid));
      limpar(chatMessages, eq(chatMessages.campaignId, cid));
      if (sessIds.length) limpar(turns, inArray(turns.sessionId, sessIds));
      limpar(sessions, eq(sessions.campaignId, cid));
      limpar(moneyTransactions, eq(moneyTransactions.campaignId, cid));
      limpar(financialAccounts, eq(financialAccounts.campaignId, cid));
      limpar(vehicles, eq(vehicles.campaignId, cid));
      if (charIds.length) {
        limpar(equipmentEntries, inArray(equipmentEntries.characterId, charIds));
        limpar(inventoryEntries, inArray(inventoryEntries.characterId, charIds));
        limpar(characterFields, inArray(characterFields.characterId, charIds));
      }
      limpar(notes, eq(notes.campaignId, cid));
      limpar(files, eq(files.campaignId, cid));
      limpar(folders, eq(folders.campaignId, cid));
      limpar(characters, eq(characters.campaignId, cid));
      if (tplIds.length) limpar(sheetVersions, inArray(sheetVersions.templateId, tplIds));
      limpar(sheetTemplates, eq(sheetTemplates.campaignId, cid));
      if (ruleSetIds.length) limpar(ruleDefinitions, inArray(ruleDefinitions.ruleSetId, ruleSetIds));
      limpar(ruleSets, eq(ruleSets.campaignId, cid));
      limpar(itemTemplates, eq(itemTemplates.campaignId, cid));
      limpar(invitations, eq(invitations.campaignId, cid));
      limpar(memberships, eq(memberships.campaignId, cid));

      // campos mutáveis da campanha
      const c = dados.campanha ?? {};
      const upd: Record<string, unknown> = { updatedAt: new Date() };
      for (const k of CAMPOS_CAMPANHA) if (c[k] !== undefined) upd[k] = c[k];
      tx.update(campaigns).set(upd).where(eq(campaigns.id, cid)).run();

      // reinsere na ordem de dependência (datas voltam de ISO string para Date)
      const ins = (tabela: Parameters<typeof tx.insert>[0], rows: readonly unknown[] | undefined) => {
        if (!rows?.length) return;
        const cols = getTableColumns(tabela as never) as Record<string, { dataType: string }>;
        const reviver = (row: Record<string, unknown>) => {
          const out: Record<string, unknown> = { ...row };
          for (const [k, v] of Object.entries(out)) {
            if (typeof v === "string" && cols[k]?.dataType === "date") out[k] = new Date(v);
          }
          return out;
        };
        tx.insert(tabela).values((rows as Record<string, unknown>[]).map(reviver) as never).run();
      };
      ins(memberships, dados.memberships);
      ins(invitations, dados.invitations);
      ins(sheetTemplates, dados.sheetTemplates);
      ins(sheetVersions, dados.sheetVersions);
      ins(characters, dados.characters);
      ins(characterFields, dados.characterFields);
      ins(ruleSets, dados.ruleSets);
      ins(ruleDefinitions, dados.ruleDefinitions);
      ins(itemTemplates, dados.itemTemplates);
      ins(inventoryEntries, dados.inventoryEntries);
      ins(equipmentEntries, dados.equipmentEntries);
      ins(vehicles, dados.vehicles);
      ins(financialAccounts, dados.financialAccounts);
      ins(moneyTransactions, dados.moneyTransactions);
      ins(sessions, dados.sessions);
      ins(turns, dados.turns);
      ins(chatMessages, dados.chatMessages);
      ins(rolls, dados.rolls);
      ins(tests, dados.tests);
      ins(notes, dados.notes);
      ins(folders, dados.folders);
      ins(files, dados.files);
    });
  } catch (e) {
    res.status(500).json({ erro: "Falha ao restaurar", detalhe: String(e) });
    return;
  }

  // ---- recuperação de arquivos físicos (spec §8) ----
  for (const a of arquivosAtuais) moverParaLixeira(a.storageName);
  let arquivosRecuperados = 0;
  const arquivosAusentes: string[] = [];
  for (const f of dados.files ?? []) {
    if (!f.storageName) continue;
    const vivo = resolve(baseDir, f.storageName);
    const naLixeira = resolve(lixeira, f.storageName);
    if (vivo.startsWith(baseDir + sep) && existsSync(naLixeira) && !existsSync(vivo)) {
      mkdirSync(baseDir, { recursive: true });
      try { renameSync(naLixeira, vivo); } catch { /* segue */ }
    }
    if (existsSync(vivo)) arquivosRecuperados++;
    else arquivosAusentes.push(f.fileName ?? f.id);
  }

  await audit(req, "snapshot.restaurado", { snapshotId: snap.id, descricao: snap.description, preSnapshotId: preSnapId, arquivosRecuperados, arquivosAusentes: arquivosAusentes.length });
  emitirCampanha(cid, "campanha:restaurada", { snapshotId: snap.id });
  res.json({ ok: true, preSnapshotId: preSnapId, arquivosRecuperados, arquivosAusentes });
});
