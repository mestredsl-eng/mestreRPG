import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { itemTemplates, inventoryEntries } from "../db/schema.js";
import { carregarRegras } from "../lib/regras.js";
import { requirePapel } from "../lib/permissoes.js";
import { audit } from "../lib/audit.js";
import { emitirCampanha } from "../lib/io.js";
import { somenteEnviados } from "../lib/parcial.js";

const db = getDb();
export const catalogoRouter = Router({ mergeParams: true });

const regraRefSchema = z.object({
  kind: z.string().min(1).max(40),
  key: z.string().min(1).max(80),
});

const templateSchema = z.object({
  name: z.string().min(1).max(200),
  category: z.string().max(120).optional(),
  description: z.string().max(4000).optional(),
  // Vínculo opcional com elemento do Acervo (kind:key). Só o mestre
  // define — na compra, o servidor resolve os pré-requisitos a partir
  // das regras aplicadas à campanha.
  regra: regraRefSchema.nullable().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
  isActive: z.boolean().default(true),
});

/** data.regra nunca vem do cliente — só do campo `regra` validado. */
function dataTemplateSemRegra(data: Record<string, unknown>) {
  const limpo = { ...data };
  delete limpo.regra;
  return limpo;
}

/** GET /api/campaigns/:campaignId/inventario — catálogo + categorias +
 *  elementos do Acervo (kind item/veiculo) com pré-requisitos. */
catalogoRouter.get("/", requirePapel("mestre", "jogador", "espectador"), async (req, res) => {
  const itens = await db.select().from(itemTemplates)
    .where(and(eq(itemTemplates.campaignId, req.params.campaignId), eq(itemTemplates.isActive, true)))
    .orderBy(itemTemplates.category, itemTemplates.name);
  const categorias = [...new Set(itens.map((i) => i.category).filter(Boolean) as string[])].sort();
  // Acervo aplicado à campanha: elementos de aquisição com pré-requisitos.
  const regras = await carregarRegras(req.params.campaignId);
  const acervo = [...regras.porKind.entries()]
    .filter(([kind]) => kind === "item" || kind === "veiculo")
    .flatMap(([, els]) => els.filter((e) => e.definition.disponivel !== false).map((e) => ({
      regra: { kind: e.kind, key: e.key },
      nome: e.name,
      categoria: e.category,
      descricao: (e.definition as { descricao?: string }).descricao ?? null,
      prerequisitos: (e.definition.prerequisitos ?? []).map((p) => ({
        kind: p.kind, key: p.key,
        nome: regras.elementos.get(`${p.kind}:${p.key}`)?.name ?? `${p.kind}:${p.key}`,
        minLevel: p.minLevel ?? 1,
      })),
    })));
  res.json({ itens, categorias, acervo });
});

/** POST /api/campaigns/:campaignId/inventario — novo item do catálogo (mestre) */
catalogoRouter.post("/", requirePapel("mestre"), async (req, res) => {
  const body = templateSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues }); return; }
  const agora = new Date();
  const id = crypto.randomUUID();
  const dataTpl = dataTemplateSemRegra(body.data.data);
  if (body.data.regra) dataTpl.regra = body.data.regra;
  await db.insert(itemTemplates).values({
    id, campaignId: req.params.campaignId, name: body.data.name, category: body.data.category ?? null,
    description: body.data.description ?? null, data: dataTpl, isActive: body.data.isActive,
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
  const d = somenteEnviados(body.data, req.body);
  const dataAtual = (tpl.data ?? {}) as Record<string, unknown>;
  const dataNova = d.data !== undefined ? dataTemplateSemRegra(d.data) : { ...dataAtual };
  delete dataNova.regra;
  // Preserva a semântica tri-state do PATCH com base no body original:
  // ausente = manter; null = remover; objeto validado = substituir.
  const regraEnviada = Object.prototype.hasOwnProperty.call(req.body ?? {}, "regra");
  if (regraEnviada) {
    if (req.body.regra === null) {
      delete dataNova.regra;
    } else if (d.regra) {
      dataNova.regra = d.regra;
    }
  } else if (dataAtual.regra !== undefined) {
    dataNova.regra = dataAtual.regra;
  }
  await db.update(itemTemplates).set({
    name: d.name ?? tpl.name,
    category: d.category ?? tpl.category,
    description: d.description ?? tpl.description,
    data: dataNova,
    isActive: d.isActive ?? tpl.isActive,
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
