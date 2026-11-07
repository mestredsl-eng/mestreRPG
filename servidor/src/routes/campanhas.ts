import { Router } from "express";
import { and, eq, desc } from "drizzle-orm";
import { z } from "zod";
import { randomBytes, createHash } from "node:crypto";
import { getDb } from "../db/index.js";
import { campaigns, memberships, invitations, users } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePapel, getMembership, contarMestres, type PapelCampanha } from "../lib/permissoes.js";
import { emitirCampanha } from "../lib/io.js";

const db = getDb();
export const campanhasRouter = Router();
campanhasRouter.use(requireAuth);

const STATUS = ["preparacao", "andamento", "pausada", "concluida", "arquivada"] as const;

const criarSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(4000).optional(),
  system: z.string().max(120).optional(), // texto livre — qualquer sistema de RPG
});

const atualizarSchema = criarSchema.partial().extend({
  status: z.enum(STATUS).optional(),
  coverImage: z.string().max(500).nullable().optional(),
  summary: z.string().max(20000).nullable().optional(),
});

function campanhaPublica(c: typeof campaigns.$inferSelect) {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    system: c.system,
    coverImage: c.coverImage,
    status: c.status,
    ownerId: c.ownerId,
    settings: c.settings,
    summary: c.summary,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/** GET /api/campaigns — campanhas onde sou membro ativo/pendente/bloqueado (exceto removido) */
campanhasRouter.get("/", async (req, res) => {
  const rows = await db
    .select({ campaign: campaigns, membership: memberships })
    .from(memberships)
    .innerJoin(campaigns, eq(memberships.campaignId, campaigns.id))
    .where(eq(memberships.userId, req.usuario!.id))
    .orderBy(desc(campaigns.createdAt));
  const lista = rows
    .filter((r) => r.membership.status !== "removido")
    .map((r) => ({ ...campanhaPublica(r.campaign), meuPapel: r.membership.role, meuStatus: r.membership.status }));
  res.json({ campanhas: lista });
});

/** POST /api/campaigns — qualquer usuário autenticado pode criar; vira mestre */
campanhasRouter.post("/", async (req, res) => {
  const body = criarSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues });
    return;
  }
  const agora = new Date();
  const campaignId = crypto.randomUUID();
  await db.insert(campaigns).values({
    id: campaignId,
    name: body.data.name,
    description: body.data.description ?? null,
    system: body.data.system ?? null,
    status: "preparacao",
    ownerId: req.usuario!.id,
    settings: {},
    createdAt: agora,
    updatedAt: agora,
  });
  await db.insert(memberships).values({
    id: crypto.randomUUID(),
    campaignId,
    userId: req.usuario!.id,
    role: "mestre",
    status: "ativo",
    joinedAt: agora,
    createdAt: agora,
    updatedAt: agora,
  });
  const [criada] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
  res.status(201).json({ campanha: { ...campanhaPublica(criada), meuPapel: "mestre", meuStatus: "ativo" } });
});

// ---- Rotas com :campaignId ----

/** GET /api/campaigns/:campaignId — detalhe (qualquer membro não-removido) */
campanhasRouter.get("/:campaignId", async (req, res) => {
  const m = await getMembership(req.params.campaignId, req.usuario!.id);
  if (!m || m.status === "removido") {
    res.status(403).json({ erro: "Sem permissão nesta campanha" });
    return;
  }
  const [c] = await db.select().from(campaigns).where(eq(campaigns.id, req.params.campaignId)).limit(1);
  if (!c) {
    res.status(404).json({ erro: "Campanha não encontrada" });
    return;
  }
  res.json({ campanha: { ...campanhaPublica(c), meuPapel: m.role, meuStatus: m.status } });
});

/** PATCH /api/campaigns/:campaignId — edição e status (somente mestre) */
campanhasRouter.patch("/:campaignId", requirePapel("mestre"), async (req, res) => {
  const body = atualizarSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues });
    return;
  }
  const dados: Partial<typeof campaigns.$inferInsert> = { updatedAt: new Date() };
  if (body.data.name !== undefined) dados.name = body.data.name;
  if (body.data.description !== undefined) dados.description = body.data.description;
  if (body.data.system !== undefined) dados.system = body.data.system;
  if (body.data.status !== undefined) dados.status = body.data.status;
  if (body.data.coverImage !== undefined) dados.coverImage = body.data.coverImage;
  if (body.data.summary !== undefined) dados.summary = body.data.summary;
  await db.update(campaigns).set(dados).where(eq(campaigns.id, req.params.campaignId));
  const [atualizada] = await db.select().from(campaigns).where(eq(campaigns.id, req.params.campaignId)).limit(1);
  emitirCampanha(req.params.campaignId, "campanha:atualizada", campanhaPublica(atualizada));
  res.json({ campanha: campanhaPublica(atualizada) });
});

// ---- Participantes ----

/** GET /api/campaigns/:campaignId/members — lista participantes com dados do usuário */
campanhasRouter.get("/:campaignId/members", requirePapel("mestre", "jogador", "espectador"), async (req, res) => {
  const rows = await db
    .select({ membership: memberships, user: users })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.campaignId, req.params.campaignId))
    .orderBy(memberships.joinedAt);
  res.json({
    membros: rows.map((r) => ({
      membershipId: r.membership.id,
      userId: r.membership.userId,
      username: r.user.username,
      displayName: r.user.displayName,
      email: r.user.email,
      role: r.membership.role,
      status: r.membership.status,
      permissions: r.membership.permissions,
      joinedAt: r.membership.joinedAt,
      ehEu: r.membership.userId === req.usuario!.id,
    })),
  });
});

const membroSchema = z.object({
  role: z.enum(["mestre", "jogador", "espectador"]).optional(),
  status: z.enum(["pendente", "ativo", "bloqueado", "removido"]).optional(),
});

/** PATCH /api/campaigns/:campaignId/members/:membershipId — papel/status (mestre) */
campanhasRouter.patch(
  "/:campaignId/members/:membershipId",
  requirePapel("mestre"),
  async (req, res) => {
    const body = membroSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues });
      return;
    }
    const [alvo] = await db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.id, req.params.membershipId),
          eq(memberships.campaignId, req.params.campaignId)
        )
      )
      .limit(1);
    if (!alvo) {
      res.status(404).json({ erro: "Participante não encontrado" });
      return;
    }

    const novoPapel = body.data.role ?? (alvo.role as PapelCampanha);
    const novoStatus = body.data.status ?? (alvo.status as string);

    // Impede deixar a campanha sem mestre ativo
    const alvoEhMestreAtivo = alvo.role === "mestre" && alvo.status === "ativo";
    const deixaDeSerMestreAtivo = novoPapel !== "mestre" || novoStatus !== "ativo";
    if (alvoEhMestreAtivo && deixaDeSerMestreAtivo && (await contarMestres(req.params.campaignId)) <= 1) {
      res.status(400).json({ erro: "A campanha precisa de ao menos um mestre. Transfira a titularidade primeiro." });
      return;
    }

    await db
      .update(memberships)
      .set({
        role: novoPapel,
        status: novoStatus,
        updatedAt: new Date(),
        ...(novoStatus === "ativo" && !alvo.joinedAt ? { joinedAt: new Date() } : {}),
      })
      .where(eq(memberships.id, alvo.id));

    emitirCampanha(req.params.campaignId, "membros:atualizados", { membershipId: alvo.id });
    res.json({ ok: true });
  }
);

/** DELETE /api/campaigns/:campaignId/members/:membershipId — remoção (soft delete) */
campanhasRouter.delete(
  "/:campaignId/members/:membershipId",
  requirePapel("mestre"),
  async (req, res) => {
    const [alvo] = await db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.id, req.params.membershipId),
          eq(memberships.campaignId, req.params.campaignId)
        )
      )
      .limit(1);
    if (!alvo) {
      res.status(404).json({ erro: "Participante não encontrado" });
      return;
    }
    if (alvo.role === "mestre" && alvo.status === "ativo" && (await contarMestres(req.params.campaignId)) <= 1) {
      res.status(400).json({ erro: "Não é possível remover o único mestre da campanha." });
      return;
    }
    await db
      .update(memberships)
      .set({ status: "removido", updatedAt: new Date() })
      .where(eq(memberships.id, alvo.id));
    emitirCampanha(req.params.campaignId, "membros:atualizados", { membershipId: alvo.id });
    res.json({ ok: true });
  }
);

/** POST /api/campaigns/:campaignId/transferir — transfere titularidade para outro mestre */
campanhasRouter.post(
  "/:campaignId/transferir/:membershipId",
  requirePapel("mestre"),
  async (req, res) => {
    const [alvo] = await db
      .select()
      .from(memberships)
      .where(
        and(
          eq(memberships.id, req.params.membershipId),
          eq(memberships.campaignId, req.params.campaignId)
        )
      )
      .limit(1);
    if (!alvo || alvo.role !== "mestre" || alvo.status !== "ativo") {
      res.status(400).json({ erro: "O novo titular precisa ser um mestre ativo da campanha" });
      return;
    }
    await db
      .update(campaigns)
      .set({ ownerId: alvo.userId, updatedAt: new Date() })
      .where(eq(campaigns.id, req.params.campaignId));
    res.json({ ok: true });
  }
);

// ---- Convites ----

function hashConvite(codigo: string): string {
  return createHash("sha256").update(codigo).digest("hex");
}

function gerarCodigo(): string {
  // Código legível: XXXX-XXXX-XXXX (base32 sem caracteres ambíguos)
  const alfabeto = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(12);
  const chars = [...bytes].map((b) => alfabeto[b % alfabeto.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8, 12).join("")}`;
}

const conviteSchema = z.object({
  role: z.enum(["jogador", "espectador"]).default("jogador"),
  maxUses: z.number().int().positive().max(500).optional(),
  expiresInHours: z.number().positive().max(24 * 365).optional(),
  requiresApproval: z.boolean().default(false),
});

function statusConvite(inv: typeof invitations.$inferSelect): string {
  if (inv.revokedAt) return "revogado";
  if (inv.expiresAt && inv.expiresAt < new Date()) return "expirado";
  if (inv.maxUses !== null && inv.uses >= inv.maxUses) return "esgotado";
  return "ativo";
}

function convitePublico(inv: typeof invitations.$inferSelect) {
  return {
    id: inv.id,
    role: inv.role,
    maxUses: inv.maxUses,
    uses: inv.uses,
    expiresAt: inv.expiresAt,
    requiresApproval: inv.requiresApproval,
    status: statusConvite(inv),
    createdAt: inv.createdAt,
  };
}

/** POST /api/campaigns/:campaignId/invitations — cria convite (mestre) */
campanhasRouter.post(
  "/:campaignId/invitations",
  requirePapel("mestre"),
  async (req, res) => {
    const body = conviteSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues });
      return;
    }
    const codigo = gerarCodigo();
    const agora = new Date();
    const id = crypto.randomUUID();
    await db.insert(invitations).values({
      id,
      campaignId: req.params.campaignId,
      code: hashConvite(codigo), // nunca armazenamos o código em texto puro
      role: body.data.role,
      createdBy: req.usuario!.id,
      maxUses: body.data.maxUses ?? null,
      uses: 0,
      expiresAt: body.data.expiresInHours ? new Date(agora.getTime() + body.data.expiresInHours * 3600_000) : null,
      requiresApproval: body.data.requiresApproval,
      createdAt: agora,
      updatedAt: agora,
    });
    // O código em claro só é retornado aqui, uma única vez.
    res.status(201).json({ convite: { id, code: codigo } });
  }
);

/** GET /api/campaigns/:campaignId/invitations — lista convites (mestre) */
campanhasRouter.get(
  "/:campaignId/invitations",
  requirePapel("mestre"),
  async (req, res) => {
    const rows = await db
      .select()
      .from(invitations)
      .where(eq(invitations.campaignId, req.params.campaignId))
      .orderBy(desc(invitations.createdAt));
    res.json({ convites: rows.map(convitePublico) });
  }
);

/** PATCH /api/campaigns/:campaignId/invitations/:invitationId — revogar */
campanhasRouter.patch(
  "/:campaignId/invitations/:invitationId",
  requirePapel("mestre"),
  async (req, res) => {
    const parsed = z.object({ action: z.literal("revogar") }).safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ erro: "Ação inválida" });
      return;
    }
    const [inv] = await db
      .select()
      .from(invitations)
      .where(
        and(eq(invitations.id, req.params.invitationId), eq(invitations.campaignId, req.params.campaignId))
      )
      .limit(1);
    if (!inv) {
      res.status(404).json({ erro: "Convite não encontrado" });
      return;
    }
    await db.update(invitations).set({ revokedAt: new Date(), updatedAt: new Date() }).where(eq(invitations.id, inv.id));
    res.json({ ok: true });
  }
);
