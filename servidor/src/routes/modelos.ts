import { Router } from "express";
import { and, eq, desc, max } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { sheetTemplates, sheetVersions, campaigns } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePapel, getMembership } from "../lib/permissoes.js";
import { estruturaFichaSchema, type EstruturaFicha } from "../lib/ficha.js";
import { emitirCampanha } from "../lib/io.js";
import { audit } from "../lib/audit.js";

const db = getDb();
export const modelosRouter = Router({ mergeParams: true });
modelosRouter.use(requireAuth);

/** campaignId vem do mount pai (/api/campaigns/:campaignId/...) — mergeParams não tipa. */
function campaignIdDe(req: { params: unknown }): string {
  return (req.params as Record<string, string>).campaignId;
}

// ---------- helpers ----------

async function carregarVersao(versionId: string) {
  const [v] = await db.select().from(sheetVersions).where(eq(sheetVersions.id, versionId)).limit(1);
  if (!v) return null;
  const parse = estruturaFichaSchema.safeParse(v.structure);
  return { row: v, estrutura: parse.success ? (parse.data as EstruturaFicha) : null };
}

function templatePublico(t: typeof sheetTemplates.$inferSelect, versaoAtual?: { id: string; version: number; publishedAt: Date | null } | null) {
  return {
    id: t.id,
    campaignId: t.campaignId,
    name: t.name,
    description: t.description,
    isActive: t.isActive,
    isDefault: t.isDefault,
    currentVersionId: t.currentVersionId,
    versaoAtual: versaoAtual ?? null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

// ---------- listagem ----------

/** GET /api/campaigns/:campaignId/sheet-templates */
modelosRouter.get("/", async (req, res) => {
  const campaignId = campaignIdDe(req);
  const m = await getMembership(campaignId, req.usuario!.id);
  if (!m || m.status === "removido") {
    res.status(403).json({ erro: "Sem permissão nesta campanha" });
    return;
  }
  const ehMestre = m.role === "mestre";
  const rows = await db
    .select()
    .from(sheetTemplates)
    .where(eq(sheetTemplates.campaignId, campaignId))
    .orderBy(desc(sheetTemplates.createdAt));

  const resultado = [];
  for (const t of rows) {
    const [versao] = t.currentVersionId
      ? await db.select().from(sheetVersions).where(eq(sheetVersions.id, t.currentVersionId)).limit(1)
      : [null];
    // Jogadores só veem modelos ativos com versão publicada
    if (!ehMestre && (!t.isActive || !versao?.publishedAt)) continue;
    resultado.push(templatePublico(t, versao ? { id: versao.id, version: versao.version, publishedAt: versao.publishedAt } : null));
  }
  res.json({ modelos: resultado });
});

// ---------- criação / edição do modelo ----------

const criarSchema = z.object({
  name: z.string().min(2).max(160),
  description: z.string().max(2000).optional(),
});

/** POST /api/campaigns/:campaignId/sheet-templates — cria modelo + versão 1 (rascunho) */
modelosRouter.post("/", requirePapel("mestre"), async (req, res) => {
  const body = criarSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues });
    return;
  }
  const agora = new Date();
  const templateId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const estruturaVazia = estruturaFichaSchema.parse({ secoes: [], pontos: { habilitado: false } });

  await db.insert(sheetTemplates).values({
    id: templateId,
    campaignId: campaignIdDe(req),
    name: body.data.name,
    description: body.data.description ?? null,
    ownerId: req.usuario!.id,
    isActive: true,
    isDefault: false,
    createdAt: agora,
    updatedAt: agora,
  });
  await db.insert(sheetVersions).values({
    id: versionId,
    templateId,
    version: 1,
    structure: estruturaVazia,
    createdAt: agora,
  });
  await db.update(sheetTemplates).set({ currentVersionId: versionId }).where(eq(sheetTemplates.id, templateId));
  await audit(req, "ficha.modelo_criado", { templateId, campaignId: campaignIdDe(req) });
  emitirCampanha(campaignIdDe(req), "fichas:atualizadas", { templateId });
  res.status(201).json({ modelo: { id: templateId, versionId } });
});

const atualizarSchema = z.object({
  name: z.string().min(2).max(160).optional(),
  description: z.string().max(2000).nullable().optional(),
  isActive: z.boolean().optional(),
  isDefault: z.boolean().optional(),
});

/** PATCH /api/campaigns/:campaignId/sheet-templates/:templateId */
modelosRouter.patch("/:templateId", requirePapel("mestre"), async (req, res) => {
  const [t] = await db
    .select()
    .from(sheetTemplates)
    .where(and(eq(sheetTemplates.id, req.params.templateId), eq(sheetTemplates.campaignId, campaignIdDe(req))))
    .limit(1);
  if (!t) {
    res.status(404).json({ erro: "Modelo não encontrado" });
    return;
  }
  const body = atualizarSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues });
    return;
  }
  const dados: Partial<typeof sheetTemplates.$inferInsert> = { updatedAt: new Date() };
  if (body.data.name !== undefined) dados.name = body.data.name;
  if (body.data.description !== undefined) dados.description = body.data.description;
  if (body.data.isActive !== undefined) dados.isActive = body.data.isActive;
  if (body.data.isDefault !== undefined) dados.isDefault = body.data.isDefault;

  // "Modelo para novos personagens" é único por campanha
  if (body.data.isDefault) {
    await db
      .update(sheetTemplates)
      .set({ isDefault: false })
      .where(and(eq(sheetTemplates.campaignId, campaignIdDe(req)), eq(sheetTemplates.isDefault, true)));
  }
  await db.update(sheetTemplates).set(dados).where(eq(sheetTemplates.id, t.id));
  emitirCampanha(campaignIdDe(req), "fichas:atualizadas", { templateId: t.id });
  const [atualizado] = await db.select().from(sheetTemplates).where(eq(sheetTemplates.id, t.id)).limit(1);
  res.json({ modelo: templatePublico(atualizado) });
});

/** POST .../sheet-templates/:templateId/duplicate — duplica modelo e estrutura */
modelosRouter.post("/:templateId/duplicate", requirePapel("mestre"), async (req, res) => {
  const [t] = await db
    .select()
    .from(sheetTemplates)
    .where(and(eq(sheetTemplates.id, req.params.templateId), eq(sheetTemplates.campaignId, campaignIdDe(req))))
    .limit(1);
  if (!t?.currentVersionId) {
    res.status(404).json({ erro: "Modelo não encontrado" });
    return;
  }
  const origem = await carregarVersao(t.currentVersionId);
  if (!origem) {
    res.status(404).json({ erro: "Versão atual não encontrada" });
    return;
  }
  const agora = new Date();
  const novoId = crypto.randomUUID();
  const novaVersaoId = crypto.randomUUID();
  const nome = `${t.name} (cópia)`;
  await db.insert(sheetTemplates).values({
    id: novoId,
    campaignId: campaignIdDe(req),
    name: nome,
    description: t.description,
    ownerId: req.usuario!.id,
    isActive: false, // cópia nasce inativa até o mestre revisar
    isDefault: false,
    createdAt: agora,
    updatedAt: agora,
  });
  await db.insert(sheetVersions).values({
    id: novaVersaoId,
    templateId: novoId,
    version: 1,
    structure: origem.estrutura,
    createdAt: agora,
  });
  await db.update(sheetTemplates).set({ currentVersionId: novaVersaoId }).where(eq(sheetTemplates.id, novoId));
  emitirCampanha(campaignIdDe(req), "fichas:atualizadas", { templateId: novoId });
  res.status(201).json({ modelo: { id: novoId, versionId: novaVersaoId } });
});

// ---------- versões ----------

/** GET .../sheet-templates/:templateId — detalhe com versões */
modelosRouter.get("/:templateId", async (req, res) => {
  const m = await getMembership(campaignIdDe(req), req.usuario!.id);
  if (!m || m.status === "removido") {
    res.status(403).json({ erro: "Sem permissão nesta campanha" });
    return;
  }
  const [t] = await db
    .select()
    .from(sheetTemplates)
    .where(and(eq(sheetTemplates.id, req.params.templateId), eq(sheetTemplates.campaignId, campaignIdDe(req))))
    .limit(1);
  if (!t) {
    res.status(404).json({ erro: "Modelo não encontrado" });
    return;
  }
  const ehMestre = m.role === "mestre";
  const versoes = await db
    .select()
    .from(sheetVersions)
    .where(eq(sheetVersions.templateId, t.id))
    .orderBy(desc(sheetVersions.version));
  res.json({
    modelo: templatePublico(t),
    versoes: versoes.map((v) => ({
      id: v.id,
      version: v.version,
      publishedAt: v.publishedAt,
      rascunho: !v.publishedAt,
      // estrutura completa só para o mestre; jogadores recebem a publicada
      estrutura: ehMestre || v.publishedAt ? v.structure : undefined,
    })),
  });
});

/** PUT .../sheet-templates/:templateId/versions/:versionId — salva estrutura de rascunho */
modelosRouter.put(
  "/:templateId/versions/:versionId",
  requirePapel("mestre"),
  async (req, res) => {
    const [v] = await db
      .select()
      .from(sheetVersions)
      .where(and(eq(sheetVersions.id, req.params.versionId), eq(sheetVersions.templateId, req.params.templateId)))
      .limit(1);
    if (!v) {
      res.status(404).json({ erro: "Versão não encontrada" });
      return;
    }
    if (v.publishedAt) {
      res.status(409).json({ erro: "Versão já publicada é imutável. Crie uma nova versão." });
      return;
    }
    const parse = estruturaFichaSchema.safeParse(req.body?.estrutura ?? req.body);
    if (!parse.success) {
      res.status(400).json({ erro: "Estrutura inválida", detalhes: parse.error.issues });
      return;
    }
    await db.update(sheetVersions).set({ structure: parse.data }).where(eq(sheetVersions.id, v.id));
    const [tpl] = await db.select({ campaignId: sheetTemplates.campaignId }).from(sheetTemplates)
      .where(eq(sheetTemplates.id, req.params.templateId)).limit(1);
    if (tpl?.campaignId) emitirCampanha(tpl.campaignId, "fichas:atualizadas", { templateId: req.params.templateId });
    res.json({ ok: true });
  }
);

/** POST .../sheet-templates/:templateId/versions — nova versão a partir da atual */
modelosRouter.post("/:templateId/versions", requirePapel("mestre"), async (req, res) => {
  const [t] = await db
    .select()
    .from(sheetTemplates)
    .where(and(eq(sheetTemplates.id, req.params.templateId), eq(sheetTemplates.campaignId, campaignIdDe(req))))
    .limit(1);
  if (!t) {
    res.status(404).json({ erro: "Modelo não encontrado" });
    return;
  }
  let estruturaBase: unknown = { secoes: [] };
  if (t.currentVersionId) {
    const atual = await carregarVersao(t.currentVersionId);
    if (atual?.estrutura) estruturaBase = atual.estrutura;
  }
  const parse = estruturaFichaSchema.safeParse(estruturaBase);
  const [{ valor: proxima }] = await db
    .select({ valor: max(sheetVersions.version) })
    .from(sheetVersions)
    .where(eq(sheetVersions.templateId, t.id));
  const agora = new Date();
  const versionId = crypto.randomUUID();
  await db.insert(sheetVersions).values({
    id: versionId,
    templateId: t.id,
    version: (proxima ?? 0) + 1,
    structure: parse.success ? parse.data : estruturaBase,
    createdAt: agora,
  });
  await db.update(sheetTemplates).set({ currentVersionId: versionId, updatedAt: agora }).where(eq(sheetTemplates.id, t.id));
  emitirCampanha(campaignIdDe(req), "fichas:atualizadas", { templateId: t.id });
  res.status(201).json({ versionId });
});

/** POST .../sheet-templates/:templateId/publish — publica versão para os jogadores */
modelosRouter.post("/:templateId/publish", requirePapel("mestre"), async (req, res) => {
  const versionId = z.string().min(1).parse(req.body?.versionId ?? req.params.versionId);
  const [v] = await db
    .select()
    .from(sheetVersions)
    .where(and(eq(sheetVersions.id, versionId), eq(sheetVersions.templateId, req.params.templateId)))
    .limit(1);
  if (!v) {
    res.status(404).json({ erro: "Versão não encontrada" });
    return;
  }
  const agora = new Date();
  await db.update(sheetVersions).set({ publishedAt: agora }).where(eq(sheetVersions.id, v.id));
  await db
    .update(sheetTemplates)
    .set({ currentVersionId: v.id, updatedAt: agora })
    .where(eq(sheetTemplates.id, req.params.templateId));
  await audit(req, "ficha.modelo_publicado", { templateId: req.params.templateId, versionId: v.id, version: v.version });
  emitirCampanha(campaignIdDe(req), "fichas:atualizadas", { templateId: req.params.templateId });
  res.json({ ok: true, version: v.version });
});
