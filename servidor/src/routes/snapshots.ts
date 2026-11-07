import { Router } from "express";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/index.js";
import {
  snapshots, users, auditLogs, sessions, characters, chatMessages, memberships, campaigns,
} from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePapel } from "../lib/permissoes.js";
import { audit } from "../lib/audit.js";
import { emitirCampanha } from "../lib/io.js";
import { exportarCampanha, type EstadoCampanha } from "../lib/estado.js";
import { restaurarEstado } from "../lib/restaurar.js";

const db = getDb();
export const snapshotsRouter = Router({ mergeParams: true });
snapshotsRouter.use(requireAuth);

/** GET /api/campaigns/:campaignId/snapshots — lista (mestre) */
snapshotsRouter.get("/", requirePapel("mestre"), async (req, res) => {
  const lista = await db.select({
    id: snapshots.id, kind: snapshots.kind, description: snapshots.description, createdAt: snapshots.createdAt, createdBy: snapshots.createdBy,
  }).from(snapshots).where(eq(snapshots.campaignId, req.params.campaignId)).orderBy(desc(snapshots.createdAt));
  const ids = [...new Set(lista.map((s) => s.createdBy))];
  const mapa = new Map((ids.length ? await db.select({ id: users.id, username: users.username, displayName: users.displayName }).from(users).where(inArray(users.id, ids)) : []).map((u) => [u.id, u]));
  res.json({ snapshots: lista.map((s) => ({ ...s, autor: mapa.get(s.createdBy) ?? null })) });
});

/** GET /api/campaigns/:campaignId/snapshots/restauracoes — histórico de restaurações (mestre) */
snapshotsRouter.get("/restauracoes", requirePapel("mestre"), async (req, res) => {
  const logs = await db.select().from(auditLogs)
    .where(and(eq(auditLogs.campaignId, req.params.campaignId), eq(auditLogs.action, "snapshot.restaurado")))
    .orderBy(desc(auditLogs.createdAt)).limit(50);
  const ids = [...new Set(logs.map((l) => l.actorId).filter(Boolean) as string[])];
  const mapa = new Map((ids.length ? await db.select({ id: users.id, username: users.username, displayName: users.displayName }).from(users).where(inArray(users.id, ids)) : []).map((u) => [u.id, u]));
  res.json({
    restauracoes: logs.map((l) => ({
      id: l.id, createdAt: l.createdAt, autor: l.actorId ? mapa.get(l.actorId) ?? null : null,
      detalhe: l.detail,
    })),
  });
});

/** GET /api/campaigns/:campaignId/snapshots/estado — resumo do estado atual da campanha (mestre) */
snapshotsRouter.get("/estado", requirePapel("mestre"), async (req, res) => {
  const cid = req.params.campaignId;
  const [campanha] = await db.select({ id: campaigns.id, name: campaigns.name, status: campaigns.status, updatedAt: campaigns.updatedAt })
    .from(campaigns).where(eq(campaigns.id, cid)).limit(1);
  const [nSess] = await db.select({ id: sessions.id, status: sessions.status, number: sessions.number, startedAt: sessions.startedAt, endedAt: sessions.endedAt }).from(sessions)
    .where(and(eq(sessions.campaignId, cid), eq(sessions.status, "ativa"))).orderBy(desc(sessions.number)).limit(1);
  const [[nChars], [nMsgs], [nMembros]] = await Promise.all([
    db.select({ c: count() }).from(characters).where(eq(characters.campaignId, cid)),
    db.select({ c: count() }).from(chatMessages).where(eq(chatMessages.campaignId, cid)),
    db.select({ c: count() }).from(memberships).where(and(eq(memberships.campaignId, cid), eq(memberships.status, "ativo"))),
  ]);
  const ultimo = (await db.select({ id: snapshots.id, kind: snapshots.kind, description: snapshots.description, createdAt: snapshots.createdAt })
    .from(snapshots).where(eq(snapshots.campaignId, cid)).orderBy(desc(snapshots.createdAt)).limit(1))[0] ?? null;
  res.json({
    campanha: campanha ?? null,
    sessaoAtiva: nSess ?? null,
    totais: { personagens: nChars?.c ?? 0, mensagens: nMsgs?.c ?? 0, membrosAtivos: nMembros?.c ?? 0 },
    ultimoPonto: ultimo,
  });
});

const criarSchema = z.object({ description: z.string().max(500).optional() });

/** POST /api/campaigns/:campaignId/snapshots — ponto de recuperação manual (mestre) */
snapshotsRouter.post("/", requirePapel("mestre"), async (req, res) => {
  const body = criarSchema.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ erro: "Dados inválidos" }); return; }
  const dados = await exportarCampanha(req.params.campaignId);
  const id = crypto.randomUUID();
  await db.insert(snapshots).values({
    id, campaignId: req.params.campaignId, kind: "manual",
    description: body.data.description ?? null,
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
    id: preSnapId, campaignId: cid, kind: "pre_restauracao",
    description: `Automático — antes de restaurar snapshot ${snap.id}`,
    data: estadoAtual as never, createdBy: req.usuario!.id, createdAt: new Date(),
  });

  let resultado;
  try {
    resultado = await restaurarEstado(cid, dados);
  } catch (e) {
    res.status(500).json({ erro: "Falha ao restaurar", detalhe: String(e) });
    return;
  }

  await audit(req, "snapshot.restaurado", { snapshotId: snap.id, descricao: snap.description, preSnapshotId: preSnapId, arquivosRecuperados: resultado.arquivosRecuperados, arquivosAusentes: resultado.arquivosAusentes.length });
  emitirCampanha(cid, "campanha:restaurada", { snapshotId: snap.id });
  res.json({ ok: true, preSnapshotId: preSnapId, ...resultado });
});
