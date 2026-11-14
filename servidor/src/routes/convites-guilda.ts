import { Router } from "express";
import { and, eq, sql } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { guildInvites, guildMembers, guilds } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { audit } from "../lib/audit.js";
import { requireGuildGestao, getGuildMembership } from "../lib/guildas.js";
import { hashConvite } from "../lib/convites.js";
import { notificarGuildaAtualizada } from "./guildas.js";
import { limiteUsuario } from "../lib/ratelimit.js";

const db = getDb();

/**
 * Convites internos de guilda (Issue #65).
 *
 * Gerenciamento (GM ativo da guilda ou ADMIN):
 *   GET    /api/guildas/:guildId/convites-internos
 *   POST   /api/guildas/:guildId/convites-internos
 *   DELETE /api/guildas/:guildId/convites-internos/:conviteId
 *
 * Consulta/aceite (qualquer conta autenticada e ativa):
 *   GET  /api/convites-guilda/:codigo
 *   POST /api/convites-guilda/:codigo/aceitar
 *
 * O código em claro só existe na resposta de criação — no banco fica
 * apenas o hash SHA-256. A aceitação concede exclusivamente o papel
 * `membro` da guilda (nunca GM, ADMIN ou membership de campanha).
 */

// códigos são segredos: limitar consulta/aceite dificulta enumeração
const limiteConsulta = limiteUsuario({ nome: "convite-guilda-consulta", janelaMs: 5 * 60_000, max: 30 });
const limiteAceite = limiteUsuario({ nome: "convite-guilda-aceite", janelaMs: 5 * 60_000, max: 20 });

const criarSchema = z.object({
  validadeHoras: z.number().int().min(1).max(720).default(168),
  maxUsos: z.number().int().min(1).max(50).default(1),
});

type Convite = typeof guildInvites.$inferSelect;

function statusConviteGuilda(inv: Convite): string {
  if (inv.revokedAt) return "revogado";
  if (inv.expiresAt < new Date()) return "expirado";
  if (inv.uses >= inv.maxUses) return "esgotado";
  return "ativo";
}

function convitePublico(inv: Convite) {
  return {
    id: inv.id,
    expiraEm: inv.expiresAt,
    maxUsos: inv.maxUses,
    usos: inv.uses,
    usosRestantes: Math.max(0, inv.maxUses - inv.uses),
    status: statusConviteGuilda(inv),
    criadoEm: inv.createdAt,
  };
}

async function buscarConviteGuilda(codigo: string): Promise<Convite | null> {
  const [inv] = await db
    .select()
    .from(guildInvites)
    .where(eq(guildInvites.code, hashConvite(codigo)))
    .limit(1);
  return inv ?? null;
}

/** Router de gerenciamento — montado em /api/guildas. */
export const convitesGuildaAdminRouter = Router();
convitesGuildaAdminRouter.use(requireAuth);

convitesGuildaAdminRouter.get("/:guildId/convites-internos", requireGuildGestao(), async (req, res) => {
  const rows = await db
    .select()
    .from(guildInvites)
    .where(eq(guildInvites.guildId, req.params.guildId));
  res.json({ convites: rows.map(convitePublico) });
});

convitesGuildaAdminRouter.post("/:guildId/convites-internos", requireGuildGestao(), async (req, res) => {
  const [g] = await db.select().from(guilds).where(eq(guilds.id, req.params.guildId)).limit(1);
  if (!g || g.status !== "ativa") {
    res.status(404).json({ erro: "Guilda não encontrada ou arquivada" });
    return;
  }
  const body = criarSchema.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ erro: "validadeHoras deve ser 1–720 e maxUsos 1–50" });
    return;
  }
  const agora = new Date();
  const codigo = randomBytes(12).toString("base64url"); // 16 chars, ~96 bits
  const expiraEm = new Date(agora.getTime() + body.data.validadeHoras * 3_600_000);
  const id = crypto.randomUUID();
  await db.insert(guildInvites).values({
    id,
    guildId: g.id,
    code: hashConvite(codigo),
    createdBy: req.usuario!.id,
    expiresAt: expiraEm,
    maxUses: body.data.maxUsos,
    uses: 0,
    createdAt: agora,
    updatedAt: agora,
  });
  const [gravado] = await db.select().from(guildInvites).where(eq(guildInvites.id, id)).limit(1);
  await audit(req, "guilda.convite.criar", { conviteId: id, validadeHoras: body.data.validadeHoras, maxUsos: body.data.maxUsos });
  await notificarGuildaAtualizada(g.id, "convite_criado");
  res.status(201).json({
    convite: { ...convitePublico(gravado), codigo },
  });
});

convitesGuildaAdminRouter.delete("/:guildId/convites-internos/:conviteId", requireGuildGestao(), async (req, res) => {
  const [inv] = await db
    .select()
    .from(guildInvites)
    .where(and(eq(guildInvites.id, req.params.conviteId), eq(guildInvites.guildId, req.params.guildId)))
    .limit(1);
  if (!inv) {
    res.status(404).json({ erro: "Convite não encontrado" });
    return;
  }
  if (!inv.revokedAt) {
    const agora = new Date();
    await db.update(guildInvites).set({ revokedAt: agora, updatedAt: agora }).where(eq(guildInvites.id, inv.id));
    await audit(req, "guilda.convite.revogar", { conviteId: inv.id });
    await notificarGuildaAtualizada(req.params.guildId, "convite_revogado");
  }
  res.json({ ok: true });
});

/** Router de consulta/aceite — montado em /api/convites-guilda. */
export const convitesGuildaRouter = Router();
convitesGuildaRouter.use(requireAuth);

convitesGuildaRouter.get("/:codigo", limiteConsulta, async (req, res) => {
  const inv = await buscarConviteGuilda(req.params.codigo);
  if (!inv) {
    res.status(404).json({ erro: "Convite não encontrado" });
    return;
  }
  const [g] = await db.select().from(guilds).where(eq(guilds.id, inv.guildId)).limit(1);
  if (!g || g.status !== "ativa") {
    res.status(404).json({ erro: "Convite não encontrado" });
    return;
  }
  // payload mínimo: nome+id da guilda, validade e usos — nada de roster
  res.json({
    convite: {
      guilda: { id: g.id, nome: g.name },
      expiraEm: inv.expiresAt,
      usosRestantes: Math.max(0, inv.maxUses - inv.uses),
      status: statusConviteGuilda(inv),
    },
  });
});

convitesGuildaRouter.post("/:codigo/aceitar", limiteAceite, async (req, res) => {
  const inv = await buscarConviteGuilda(req.params.codigo);
  if (!inv) {
    res.status(404).json({ erro: "Convite não encontrado" });
    return;
  }
  const [g] = await db.select().from(guilds).where(eq(guilds.id, inv.guildId)).limit(1);
  if (!g || g.status !== "ativa") {
    res.status(404).json({ erro: "Convite não encontrado" });
    return;
  }
  const uid = req.usuario!.id;
  // Membro ativo: aceite idempotente — NÃO consome uso e independe do
  // estado do convite (expirado/esgotado/revogado não revoga membresia)
  const existente = await getGuildMembership(g.id, uid);
  if (existente) {
    res.json({ ok: true, guildaId: g.id, papel: existente.role });
    return;
  }
  if (statusConviteGuilda(inv) !== "ativo") {
    res.status(410).json({ erro: `Convite ${statusConviteGuilda(inv)}` });
    return;
  }

  // UPDATE condicional atômico: só consome se o convite seguir válido —
  // duas aceitações simultâneas de convite de uso único: só uma vence
  const agora = new Date();
  const consumo = await db.run(sql`
    UPDATE guild_invites
    SET uses = uses + 1, updated_at = ${agora.getTime()}
    WHERE id = ${inv.id}
      AND revoked_at IS NULL
      AND expires_at > ${agora.getTime()}
      AND uses < max_uses
  `);
  if (consumo.changes === 0) {
    res.status(410).json({ erro: "Convite não está mais disponível" });
    return;
  }

  // upsert: reativa vínculo removido como `membro` (nunca preserva papel
  // anterior — aceite por convite nunca eleva privilégio) ou insere novo
  const [antigo] = await db
    .select()
    .from(guildMembers)
    .where(and(eq(guildMembers.guildId, g.id), eq(guildMembers.userId, uid)))
    .limit(1);
  if (antigo) {
    await db
      .update(guildMembers)
      .set({ role: "membro", status: "ativo", joinedAt: agora, updatedAt: agora })
      .where(eq(guildMembers.id, antigo.id));
  } else {
    await db.insert(guildMembers).values({
      id: crypto.randomUUID(),
      guildId: g.id,
      userId: uid,
      role: "membro",
      status: "ativo",
      joinedAt: agora,
      createdAt: agora,
      updatedAt: agora,
    });
  }

  await audit(req, "guilda.convite.aceitar", { conviteId: inv.id, guildId: g.id }, { guildId: g.id });
  await notificarGuildaAtualizada(g.id, "membro_adicionado", [uid]);
  res.json({ ok: true, guildaId: g.id, papel: "membro" });
});
