import { Router } from "express";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { guilds, guildMembers, campaigns, memberships, users } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { audit } from "../lib/audit.js";
import {
  requireGuildAcesso,
  requireGuildGestao,
  getGuildMembership,
  contarGMs,
  ehAdmin,
} from "../lib/guildas.js";
import { getMembership } from "../lib/permissoes.js";

const db = getDb();
export const guildasRouter = Router();
guildasRouter.use(requireAuth);

const guildSchema = z.object({
  name: z.string().min(2).max(120),
  description: z.string().max(2000).optional(),
});

const guildAtualizarSchema = guildSchema.partial().extend({
  status: z.enum(["ativa", "arquivada"]).optional(),
});

function guildPublica(g: typeof guilds.$inferSelect, meuPapel: string | null, souAdmin: boolean) {
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    status: g.status,
    createdBy: g.createdBy,
    meuPapel: souAdmin && !meuPapel ? "admin" : meuPapel,
    souGM: meuPapel === "gm",
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
  };
}

/** GET /api/guildas — guildas do usuário; ?todas=1 lista todas (somente ADMIN). */
guildasRouter.get("/", async (req, res) => {
  const souAdmin = ehAdmin(req);
  const todas = req.query.todas === "1" || req.query.todas === "true";
  if (todas && !souAdmin) {
    res.status(403).json({ erro: "Somente o administrador lista todas as guildas" });
    return;
  }
  let resultado: { guild: typeof guilds.$inferSelect; papel: string | null }[];
  if (todas) {
    resultado = (await db.select().from(guilds).orderBy(guilds.name)).map((guild) => ({
      guild,
      papel: null,
    }));
  } else {
    const meus = await db
      .select({ guild: guilds, membership: guildMembers })
      .from(guildMembers)
      .innerJoin(guilds, eq(guildMembers.guildId, guilds.id))
      .where(and(eq(guildMembers.userId, req.usuario!.id), eq(guildMembers.status, "ativo")))
      .orderBy(guilds.name);
    // inclui arquivadas: o membro precisa enxergá-las para reativar
    // (o status vai no payload e a UI diferencia visualmente)
    resultado = meus.map((r) => ({ guild: r.guild, papel: r.membership.role }));
  }
  res.json({
    guildas: resultado.map((r) => guildPublica(r.guild, r.papel, souAdmin)),
  });
});

/** POST /api/guildas — qualquer usuário autenticado cria e vira GM fundador. */
guildasRouter.post("/", async (req, res) => {
  const body = guildSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues });
    return;
  }
  const agora = new Date();
  const id = crypto.randomUUID();
  try {
    await db.insert(guilds).values({
      id,
      name: body.data.name,
      description: body.data.description ?? null,
      status: "ativa",
      createdBy: req.usuario!.id,
      createdAt: agora,
      updatedAt: agora,
    });
  } catch (e) {
    if (String(e).includes("UNIQUE")) {
      res.status(409).json({ erro: "Já existe uma guilda com este nome" });
      return;
    }
    throw e;
  }
  await db.insert(guildMembers).values({
    id: crypto.randomUUID(),
    guildId: id,
    userId: req.usuario!.id,
    role: "gm",
    status: "ativo",
    joinedAt: agora,
    createdAt: agora,
    updatedAt: agora,
  });
  // a guilda nasce aqui — req.params.guildId ainda não existe; passa o
  // escopo explicitamente para a coluna guild_id ficar preenchida
  await audit(req, "guilda.criar", { guildId: id, nome: body.data.name }, { guildId: id });
  const [criada] = await db.select().from(guilds).where(eq(guilds.id, id)).limit(1);
  res.status(201).json({ guilda: guildPublica(criada, "gm", ehAdmin(req)) });
});

/** GET /api/guildas/:guildId — detalhe + contadores (membro ativo ou ADMIN). */
guildasRouter.get("/:guildId", requireGuildAcesso(), async (req, res) => {
  const [g] = await db.select().from(guilds).where(eq(guilds.id, req.params.guildId)).limit(1);
  if (!g) {
    res.status(404).json({ erro: "Guilda não encontrada" });
    return;
  }
  const membros = await db
    .select({ id: guildMembers.id })
    .from(guildMembers)
    .where(and(eq(guildMembers.guildId, g.id), eq(guildMembers.status, "ativo")));
  const campanhasDaGuilda = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(eq(campaigns.guildId, g.id));
  res.json({
    guilda: guildPublica(g, req.guildMembership?.role ?? null, ehAdmin(req)),
    totalMembros: membros.length,
    totalCampanhas: campanhasDaGuilda.length,
  });
});

/** PATCH /api/guildas/:guildId — nome/descrição/status (GM da guilda ou ADMIN). */
guildasRouter.patch("/:guildId", requireGuildGestao(), async (req, res) => {
  const body = guildAtualizarSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues });
    return;
  }
  const [g] = await db.select().from(guilds).where(eq(guilds.id, req.params.guildId)).limit(1);
  if (!g) {
    res.status(404).json({ erro: "Guilda não encontrada" });
    return;
  }
  const dados: Partial<typeof guilds.$inferInsert> = { updatedAt: new Date() };
  if (body.data.name !== undefined) dados.name = body.data.name;
  if (body.data.description !== undefined) dados.description = body.data.description;
  if (body.data.status !== undefined) dados.status = body.data.status;
  try {
    await db.update(guilds).set(dados).where(eq(guilds.id, g.id));
  } catch (e) {
    if (String(e).includes("UNIQUE")) {
      res.status(409).json({ erro: "Já existe uma guilda com este nome" });
      return;
    }
    throw e;
  }
  await audit(req, "guilda.atualizar", { guildId: g.id, campos: Object.keys(dados) });
  const [atualizada] = await db.select().from(guilds).where(eq(guilds.id, g.id)).limit(1);
  res.json({ guilda: guildPublica(atualizada, req.guildMembership?.role ?? null, ehAdmin(req)) });
});

/** GET /api/guildas/:guildId/membros — roster (membro ativo ou ADMIN). */
guildasRouter.get("/:guildId/membros", requireGuildAcesso(), async (req, res) => {
  const rows = await db
    .select({ membership: guildMembers, user: users })
    .from(guildMembers)
    .innerJoin(users, eq(guildMembers.userId, users.id))
    .where(and(eq(guildMembers.guildId, req.params.guildId), ne(guildMembers.status, "removido")))
    .orderBy(guildMembers.joinedAt);
  res.json({
    membros: rows.map((r) => ({
      userId: r.membership.userId,
      username: r.user.username,
      displayName: r.user.displayName,
      role: r.membership.role,
      status: r.membership.status,
      joinedAt: r.membership.joinedAt,
      ehEu: r.membership.userId === req.usuario!.id,
    })),
  });
});

const membroAddSchema = z.object({
  username: z.string().min(3).max(40).optional(),
  userId: z.string().optional(),
});

/** POST /api/guildas/:guildId/membros — adiciona usuário existente como membro (GM/ADMIN). */
guildasRouter.post("/:guildId/membros", requireGuildGestao(), async (req, res) => {
  const [g] = await db.select().from(guilds).where(eq(guilds.id, req.params.guildId)).limit(1);
  if (!g || g.status !== "ativa") {
    res.status(404).json({ erro: "Guilda não encontrada ou arquivada" });
    return;
  }
  const body = membroAddSchema.safeParse(req.body);
  if (!body.success || (!body.data.username && !body.data.userId)) {
    res.status(400).json({ erro: "Informe username ou userId" });
    return;
  }
  const [alvo] = body.data.userId
    ? await db.select().from(users).where(eq(users.id, body.data.userId)).limit(1)
    : await db.select().from(users).where(eq(users.username, body.data.username!)).limit(1);
  if (!alvo || alvo.status !== "ativo") {
    res.status(404).json({ erro: "Usuário não encontrado" });
    return;
  }
  const existente = await getGuildMembership(g.id, alvo.id);
  if (existente) {
    res.status(409).json({ erro: "Usuário já é membro ativo desta guilda" });
    return;
  }
  const agora = new Date();
  // reativa vínculo removido ou insere novo
  const [antigo] = await db
    .select()
    .from(guildMembers)
    .where(and(eq(guildMembers.guildId, g.id), eq(guildMembers.userId, alvo.id)))
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
      userId: alvo.id,
      role: "membro",
      status: "ativo",
      joinedAt: agora,
      createdAt: agora,
      updatedAt: agora,
    });
  }
  await audit(req, "guilda.membro.adicionar", { guildId: g.id, userId: alvo.id });
  res.status(201).json({ ok: true, userId: alvo.id, username: alvo.username });
});

const membroPatchSchema = z.object({
  role: z.enum(["gm", "membro"]).optional(),
  status: z.enum(["ativo", "removido"]).optional(),
});

/** PATCH /api/guildas/:guildId/membros/:userId — papel/status (GM/ADMIN). */
guildasRouter.patch("/:guildId/membros/:userId", requireGuildGestao(), async (req, res) => {
  const [g] = await db.select().from(guilds).where(eq(guilds.id, req.params.guildId)).limit(1);
  if (!g) {
    res.status(404).json({ erro: "Guilda não encontrada" });
    return;
  }
  const body = membroPatchSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues });
    return;
  }
  const alvoId = req.params.userId;
  const [m] = await db
    .select()
    .from(guildMembers)
    .where(and(eq(guildMembers.guildId, g.id), eq(guildMembers.userId, alvoId)))
    .limit(1);
  if (!m || m.status === "removido") {
    res.status(404).json({ erro: "Membro não encontrado" });
    return;
  }
  const novoRole = body.data.role ?? m.role;
  const novoStatus = body.data.status ?? m.status;
  const perdeGM = m.role === "gm" && m.status === "ativo" && (novoRole !== "gm" || novoStatus !== "ativo");
  if (perdeGM && (await contarGMs(g.id)) <= 1) {
    res.status(409).json({ erro: "A guilda precisa de ao menos um GM ativo — promova outro membro antes" });
    return;
  }
  const dados: Partial<typeof guildMembers.$inferInsert> = { updatedAt: new Date() };
  if (body.data.role !== undefined) dados.role = body.data.role;
  if (body.data.status !== undefined) dados.status = body.data.status;
  await db.update(guildMembers).set(dados).where(eq(guildMembers.id, m.id));
  await audit(req, "guilda.membro.atualizar", {
    guildId: g.id,
    userId: alvoId,
    role: novoRole,
    status: novoStatus,
  });
  const [atualizado] = await db.select().from(guildMembers).where(eq(guildMembers.id, m.id)).limit(1);
  res.json({ membro: { userId: atualizado.userId, role: atualizado.role, status: atualizado.status } });
});

/** DELETE /api/guildas/:guildId/membros/:userId — remove vínculo (GM/ADMIN). */
guildasRouter.delete("/:guildId/membros/:userId", requireGuildGestao(), async (req, res) => {
  const alvoId = req.params.userId;
  const [m] = await db
    .select()
    .from(guildMembers)
    .where(and(eq(guildMembers.guildId, req.params.guildId), eq(guildMembers.userId, alvoId)))
    .limit(1);
  if (!m || m.status === "removido") {
    res.status(404).json({ erro: "Membro não encontrado" });
    return;
  }
  if (m.role === "gm" && m.status === "ativo" && (await contarGMs(req.params.guildId)) <= 1) {
    res.status(409).json({ erro: "A guilda precisa de ao menos um GM ativo — promova outro membro antes" });
    return;
  }
  await db
    .update(guildMembers)
    .set({ status: "removido", updatedAt: new Date() })
    .where(eq(guildMembers.id, m.id));
  await audit(req, "guilda.membro.remover", { guildId: req.params.guildId, userId: alvoId });
  res.json({ ok: true });
});

/** GET /api/guildas/:guildId/campanhas — campanhas vinculadas (membro ativo ou ADMIN). */
guildasRouter.get("/:guildId/campanhas", requireGuildAcesso(), async (req, res) => {
  const rows = await db.select().from(campaigns).where(eq(campaigns.guildId, req.params.guildId));
  res.json({
    campanhas: rows.map((c) => ({ id: c.id, name: c.name, status: c.status, ownerId: c.ownerId })),
  });
});

/**
 * PUT /api/guildas/:guildId/campanhas/:campaignId — vincula/desvincula.
 * Regras:
 *  - vincular: campanha sem guilda; exigido papel mestre ativo na campanha
 *    (ou ser owner) E gestão na guilda de destino (GM dela ou ADMIN).
 *  - mover entre guildas ou desvincular: somente ADMIN.
 */
guildasRouter.put(
  "/:guildId/campanhas/:campaignId",
  requireGuildGestao(),
  async (req, res) => {
    const body = z.object({ acao: z.enum(["vincular", "desvincular"]) }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ erro: "Informe acao: vincular|desvincular" });
      return;
    }
    const guildId = req.params.guildId;
    const campaignId = req.params.campaignId;
    const [c] = await db.select().from(campaigns).where(eq(campaigns.id, campaignId)).limit(1);
    if (!c) {
      res.status(404).json({ erro: "Campanha não encontrada" });
      return;
    }
    const souAdmin = ehAdmin(req);
    if (body.data.acao === "vincular") {
      // mover entre guildas é exclusivo do ADMIN — para GM/usuário comum,
      // campanha de outra guilda retorna 409 já na entrada
      if (c.guildId && c.guildId !== guildId && !souAdmin) {
        res.status(409).json({ erro: "Campanha já pertence a outra guilda — somente o ADMIN move entre guildas" });
        return;
      }
      if (c.guildId === guildId) {
        res.json({ ok: true, campanha: { id: c.id, guildId } });
        return;
      }
      // exige papel de mestre na campanha (ou ownership) — GM não sequestra
      // campanhas de terceiros
      const m = await getMembership(campaignId, req.usuario!.id);
      const podeMesa = souAdmin || c.ownerId === req.usuario!.id || (m?.status === "ativo" && m.role === "mestre");
      if (!podeMesa) {
        res.status(403).json({ erro: "Somente um mestre da campanha (ou o ADMIN) pode vinculá-la a uma guilda" });
        return;
      }
      const [g] = await db.select().from(guilds).where(eq(guilds.id, guildId)).limit(1);
      if (!g || g.status !== "ativa") {
        res.status(404).json({ erro: "Guilda não encontrada ou arquivada" });
        return;
      }
      await db.update(campaigns).set({ guildId, updatedAt: new Date() }).where(eq(campaigns.id, campaignId));
      await audit(req, "guilda.campanha.vincular", { guildId, campaignId });
      res.json({ ok: true, campanha: { id: c.id, guildId } });
      return;
    }
    // desvincular: somente ADMIN; a campanha volta a ser pessoal/legada
    if (!souAdmin) {
      res.status(403).json({ erro: "Somente o ADMIN desvincula campanhas de uma guilda" });
      return;
    }
    if (c.guildId !== guildId) {
      res.status(404).json({ erro: "Campanha não pertence a esta guilda" });
      return;
    }
    await db.update(campaigns).set({ guildId: null, updatedAt: new Date() }).where(eq(campaigns.id, campaignId));
    await audit(req, "guilda.campanha.desvincular", { guildId, campaignId });
    res.json({ ok: true, campanha: { id: c.id, guildId: null } });
  }
);
