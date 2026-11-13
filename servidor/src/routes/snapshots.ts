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
import { emitirCampanha, iniciarBarreiraRestauracao, liberarBarreiraRestauracao, reconciliarMembrosAposRestauracao } from "../lib/io.js";
import { exportarCampanha, type EstadoCampanha } from "../lib/estado.js";
import { restaurarEstado } from "../lib/restaurar.js";
import { limiteUsuario } from "../lib/ratelimit.js";

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

const limiteCriarSnapshot = limiteUsuario({ nome: "snapshot-criar", janelaMs: 10 * 60_000, max: 12 });
const limiteRestaurarSnapshot = limiteUsuario({ nome: "snapshot-restaurar", janelaMs: 10 * 60_000, max: 5 });

/** POST /api/campaigns/:campaignId/snapshots — ponto de recuperação manual (mestre) */
snapshotsRouter.post("/", requirePapel("mestre"), limiteCriarSnapshot, async (req, res) => {
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
snapshotsRouter.post("/:snapshotId/restaurar", requirePapel("mestre"), limiteRestaurarSnapshot, async (req, res) => {
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

  // BARREIRA antes de qualquer captura/restauração: sockets são
  // evacuados das salas e handlers Socket.IO rejeitam novas operações
  // — elimina a janela entre commit e expulsão e drena operações
  // assíncronas que ainda não emitiram.
  // BARREIRA exclusiva antes de qualquer captura/restauração: uma
  // segunda restauração na mesma campanha recebe 409 e NUNCA assume
  // a barreira da primeira. O restoreId proprietário autoriza a
  // liberação; qualquer falha pós-aquisição cai no catch e libera.
  const restoreId = await iniciarBarreiraRestauracao(cid);
  if (restoreId === "timeout") {
    res.status(503).json({ erro: "Restauração abortada: operações em andamento não terminaram a tempo — tente novamente" });
    return;
  }
  if (!restoreId) {
    res.status(409).json({ erro: "Já existe uma restauração em andamento nesta campanha" });
    return;
  }
  let commitado = false;
  try {
    // janela de teste determinística (NODE_ENV=test)
    const delayBarreira = Number(process.env.MESTRE_RESTORE_DELAY_MS ?? 0);
    if (process.env.NODE_ENV === "test" && delayBarreira > 0) {
      await new Promise((r) => setTimeout(r, delayBarreira));
    }
    // GUARDAR memberships atuais ANTES de restaurar
    const membrosAntes = await db.select().from(memberships).where(eq(memberships.campaignId, cid));
    const sessoesAntes = (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.campaignId, cid))).map((s) => s.id);

    let resultado;
    try {
      resultado = await restaurarEstado(cid, dados);
      commitado = true;
    } catch (e) {
      await liberarBarreiraRestauracao(cid, restoreId, "falha");
      res.status(500).json({ erro: "Falha ao restaurar", detalhe: String(e) });
      return;
    }

    await audit(req, "snapshot.restaurado", { snapshotId: snap.id, descricao: snap.description, preSnapshotId: preSnapId, arquivosRecuperados: resultado.arquivosRecuperados, arquivosAusentes: resultado.arquivosAusentes.length });
    const membrosDepois = await db.select().from(memberships).where(eq(memberships.campaignId, cid));
    const sessoesDepois = (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.campaignId, cid))).map((s) => s.id);
    const rec = await reconciliarMembrosAposRestauracao(cid, membrosAntes, membrosDepois, sessoesAntes, sessoesDepois);
    if (rec.falhas.length) {
      // commit já aplicado: libera no modo sucesso mas reporta a falha
      await liberarBarreiraRestauracao(cid, restoreId, "sucesso");
      res.status(500).json({ erro: "Restauração aplicada, mas a reconciliação de sockets falhou para alguns membros", detalhes: rec.falhas });
      return;
    }
    await liberarBarreiraRestauracao(cid, restoreId, "sucesso");
    emitirCampanha(cid, "campanha:restaurada", { snapshotId: snap.id, campaignId: cid });
    res.json({ ok: true, preSnapshotId: preSnapId, ...resultado });
  } catch (e) {
    // falha fora do try interno (captura, auditoria, reconciliação,
    // reconstrução de salas): nunca deixar a barreira órfã — se o
    // commit não ocorreu, restaura as salas evacuadas; se ocorreu,
    // libera em modo sucesso (somente autorizados voltam)
    console.error(`[restore] falha não tratada campanha=${cid}:`, e);
    await liberarBarreiraRestauracao(cid, restoreId, commitado ? "sucesso" : "falha").catch(() => false);
    if (!res.headersSent) {
      res.status(500).json({ erro: commitado ? "Restauração aplicada, mas a finalização falhou" : "Falha ao restaurar", detalhe: String(e) });
    }
  }
});
