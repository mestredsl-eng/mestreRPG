import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { itemTemplates, inventoryEntries } from "../db/schema.js";
import { requirePapel } from "../lib/permissoes.js";
import { audit } from "../lib/audit.js";
import { emitirCampanha } from "../lib/io.js";

const db = getDb();
export const catalogoRouter = Router({ mergeParams: true });

const templateSchema = z.object({
  name: z.string().min(1).max(200),
  category: z.string().max(120).optional(),
  description: z.string().max(4000).optional(),
  data: z.record(z.string(), z.unknown()).default({}),
  isActive: z.boolean().default(true),
});

/** GET /api/campaigns/:campaignId/inventario — catálogo + categorias */
catalogoRouter.get("/", requirePapel("mestre", "jogador", "espectador"), async (req, res) => {
  const itens = await db.select().from(itemTemplates)
    .where(and(eq(itemTemplates.campaignId, req.params.campaignId), eq(itemTemplates.isActive, true)))
    .orderBy(itemTemplates.category, itemTemplates.name);
  const categorias = [...new Set(itens.map((i) => i.category).filter(Boolean) as string[])].sort();
  res.json({ itens, categorias });
});

/** POST /api/campaigns/:campaignId/inventario — novo item do catálogo (mestre) */
catalogoRouter.post("/", requirePapel("mestre"), async (req, res) => {
  const body = templateSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues }); return; }
  const agora = new Date();
  const id = crypto.randomUUID();
  await db.insert(itemTemplates).values({
    id, campaignId: req.params.campaignId, name: body.data.name, category: body.data.category ?? null,
    description: body.data.description ?? null, data: body.data.data, isActive: body.data.isActive,
    createdAt: agora, updatedAt: agora,
  });
  await audit(req, "inventario.catalogo.criado", { templateId: id, name: body.data.name });
  emitirCampanha(req.params.campaignId, "inventario:atualizado", {});
  res.status(201).json({ id });
});

/** PATCH /api/campaigns/:campaignId/inventario/:templateId */
catalogoRouter.patch("/:templateId", requirePapel("mestre"), async (req, res) => {
  const body = templateSchema.partial().safeParse(req.body);
  if (!body.success) { res.status(400).json({ erro: "Dados inválidos" }); return; }
  const [tpl] = await db.select().from(itemTemplates).where(and(eq(itemTemplates.id, req.params.templateId), eq(itemTemplates.campaignId, req.params.campaignId))).limit(1);
  if (!tpl) { res.status(404).json({ erro: "Item não encontrado" }); return; }
  await db.update(itemTemplates).set({
    name: body.data.name ?? tpl.name,
    category: body.data.category ?? tpl.category,
    description: body.data.description ?? tpl.description,
    data: body.data.data ?? tpl.data,
    isActive: body.data.isActive ?? tpl.isActive,
    updatedAt: new Date(),
  }).where(eq(itemTemplates.id, tpl.id));
  emitirCampanha(req.params.campaignId, "inventario:atualizado", {});
  res.json({ ok: true });
});

/** DELETE — desativa (preserva histórico de itens já criados) */
catalogoRouter.delete("/:templateId", requirePapel("mestre"), async (req, res) => {
  const [tpl] = await db.select().from(itemTemplates).where(and(eq(itemTemplates.id, req.params.templateId), eq(itemTemplates.campaignId, req.params.campaignId))).limit(1);
  if (!tpl) { res.status(404).json({ erro: "Item não encontrado" }); return; }
  await db.update(itemTemplates).set({ isActive: false, updatedAt: new Date() }).where(eq(itemTemplates.id, tpl.id));
  emitirCampanha(req.params.campaignId, "inventario:atualizado", {});
  res.json({ ok: true });
});

/** GET /api/campaigns/:campaignId/inventario/categorias — categorias em uso */
catalogoRouter.get("/categorias", requirePapel("mestre", "jogador", "espectador"), async (req, res) => {
  const cats = new Set<string>();
  const tpls = await db.select({ category: itemTemplates.category }).from(itemTemplates).where(eq(itemTemplates.campaignId, req.params.campaignId));
  for (const t of tpls) if (t.category) cats.add(t.category);
  res.json({ categorias: [...cats].sort() });
});

// referência para o tipo InventoryEntry usada em outros lugares
export type { inventoryEntries };
