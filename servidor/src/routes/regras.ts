import { Router } from "express";
import { and, eq, like, or } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { ruleSets, ruleDefinitions, characters, memberships, sheetVersions } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePapel, getMembership } from "../lib/permissoes.js";
import {
  carregarRegras,
  configRegrasSchema,
  definicaoElementoSchema,
  validarRegras,
  TIPOS_REGRA,
  type ElementoRegra,
} from "../lib/regras.js";
import { estruturaFichaSchema, todosCampos, avaliarFormula } from "../lib/ficha.js";
import { SEED_BIBLIOTECA } from "../lib/seed-regras.js";
import { audit } from "../lib/audit.js";
import { emitirCampanha } from "../lib/io.js";
import { somenteEnviados, mesclarParcial } from "../lib/parcial.js";

const db = getDb();
export const regrasRouter = Router({ mergeParams: true });
regrasRouter.use(requireAuth);

// null em campo opcional equivale a "ausente" (JSON de formulários).
const opcional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === null ? undefined : v), schema);

const elementoSchema = z.object({
  kind: z.enum(TIPOS_REGRA),
  key: z.string().min(1).max(80).regex(/^[a-z0-9_]+$/, "Use letras minúsculas, números e _"),
  name: z.string().min(1).max(160),
  category: opcional(z.string().max(120).optional()),
  parentKey: opcional(z.string().max(80).optional()),
  definition: definicaoElementoSchema.prefault({}),
});

const atualizacaoSchema = elementoSchema.partial().omit({ kind: true, key: true });

const ESTRUTURA_VAZIA = { versao: 1 as const, secoes: [], pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} } };

/** Valida sintaxe das fórmulas de um elemento (referências são checadas na ficha). */
function formulasValidas(def: { formulas?: Record<string, string> } | undefined): string | null {
  for (const [nome, expr] of Object.entries(def?.formulas ?? {})) {
    try {
      const v = avaliarFormula(expr, {}, ESTRUTURA_VAZIA);
      if (typeof v !== "number" || !Number.isFinite(v)) return `Fórmula "${nome}" retornou valor inválido`;
    } catch {
      return `Fórmula "${nome}" inválida`;
    }
  }
  return null;
}

function serializar(el: ElementoRegra) {
  return {
    id: el.id,
    kind: el.kind,
    key: el.key,
    name: el.name,
    category: el.category,
    parentKey: el.parentKey,
    definition: el.definition,
    createdAt: el.createdAt,
    updatedAt: el.updatedAt,
  };
}

/** GET /api/campaigns/:campaignId/regras — biblioteca + config (membros leem; mestre edita) */
regrasRouter.get("/", requirePapel("mestre", "jogador", "espectador"), async (req, res) => {
  const regras = await carregarRegras(req.params.campaignId);
  const elementos = [...regras.elementos.values()].map(serializar);
  res.json({
    config: regras.config,
    ruleSetId: regras.ruleSetId,
    kinds: TIPOS_REGRA,
    elementos,
    total: elementos.length,
  });
});

/** GET /api/campaigns/:campaignId/regras/elementos?kind=&q= — lista filtrada (para selects da ficha) */
regrasRouter.get("/elementos", requirePapel("mestre", "jogador", "espectador"), async (req, res) => {
  const regras = await carregarRegras(req.params.campaignId);
  const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
  const q = typeof req.query.q === "string" ? req.query.q.toLowerCase() : undefined;
  const disponiveis = [...regras.elementos.values()].filter((el) => {
    if (kind && el.kind !== kind) return false;
    if (q && !el.name.toLowerCase().includes(q) && !el.key.includes(q)) return false;
    return el.definition.disponivel !== false;
  });
  res.json({ elementos: disponiveis.map(serializar) });
});

/** POST /api/campaigns/:campaignId/regras/elementos — criar elemento (mestre) */
regrasRouter.post("/elementos", requirePapel("mestre"), async (req, res) => {
  const body = elementoSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues });
    return;
  }
  const regras = await carregarRegras(req.params.campaignId);
  if (!regras.ruleSetId) {
    res.status(500).json({ erro: "Ruleset não inicializado" });
    return;
  }
  const chave = `${body.data.kind}:${body.data.key}`;
  if (regras.elementos.has(chave)) {
    res.status(409).json({ erro: `Já existe um elemento ${body.data.kind} com a chave "${body.data.key}"` });
    return;
  }
  const agora = new Date();
  const id = crypto.randomUUID();
  const def = definicaoElementoSchema.parse(body.data.definition);
  const erroFormula = formulasValidas(def);
  if (erroFormula) {
    res.status(400).json({ erro: erroFormula });
    return;
  }
  await db.insert(ruleDefinitions).values({
    id,
    ruleSetId: regras.ruleSetId,
    kind: body.data.kind,
    key: body.data.key,
    name: body.data.name,
    category: body.data.category ?? null,
    parentKey: body.data.parentKey ?? null,
    definition: def,
    createdAt: agora,
    updatedAt: agora,
  });
  await audit(req, "regra.elemento.criado", { elementId: id, kind: body.data.kind, key: body.data.key });
  emitirCampanha(req.params.campaignId, "regras:atualizadas", { elementId: id });
  res.status(201).json({ id });
});

/** PATCH /api/campaigns/:campaignId/regras/elementos/:elementId — editar (mestre) */
regrasRouter.patch("/elementos/:elementId", requirePapel("mestre"), async (req, res) => {
  const body = atualizacaoSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues });
    return;
  }
  const regras = await carregarRegras(req.params.campaignId);
  const el = [...regras.elementos.values()].find((e) => e.id === req.params.elementId);
  if (!el || el.ruleSetId !== regras.ruleSetId) {
    res.status(404).json({ erro: "Elemento não encontrado" });
    return;
  }
  const atual = el.definition;
  const defEnviada =
    body.data.definition !== undefined && req.body?.definition && typeof req.body.definition === "object"
      ? somenteEnviados(body.data.definition, req.body.definition)
      : {};
  const novaDef = definicaoElementoSchema.parse({ ...atual, ...defEnviada });
  const erroFormula = formulasValidas(novaDef);
  if (erroFormula) {
    res.status(400).json({ erro: erroFormula });
    return;
  }
  await db
    .update(ruleDefinitions)
    .set({
      name: body.data.name ?? el.name,
      category: body.data.category ?? el.category,
      parentKey: body.data.parentKey ?? el.parentKey,
      definition: novaDef,
      updatedAt: new Date(),
    })
    .where(eq(ruleDefinitions.id, el.id));
  await audit(req, "regra.elemento.editado", { elementId: el.id });
  emitirCampanha(req.params.campaignId, "regras:atualizadas", { elementId: el.id });
  res.json({ ok: true });
});

/** DELETE /api/campaigns/:campaignId/regras/elementos/:elementId — excluir (mestre) */
regrasRouter.delete("/elementos/:elementId", requirePapel("mestre"), async (req, res) => {
  const regras = await carregarRegras(req.params.campaignId);
  const el = [...regras.elementos.values()].find((e) => e.id === req.params.elementId);
  if (!el || el.ruleSetId !== regras.ruleSetId) {
    res.status(404).json({ erro: "Elemento não encontrado" });
    return;
  }
  await db.delete(ruleDefinitions).where(eq(ruleDefinitions.id, el.id));
  await audit(req, "regra.elemento.removido", { elementId: el.id, kind: el.kind, key: el.key });
  emitirCampanha(req.params.campaignId, "regras:atualizadas", { elementId: el.id });
  res.json({ ok: true });
});

/** POST /api/campaigns/:campaignId/regras/duplicar/:elementId — duplicar elemento (mestre) */
regrasRouter.post("/duplicar/:elementId", requirePapel("mestre"), async (req, res) => {
  const regras = await carregarRegras(req.params.campaignId);
  const el = [...regras.elementos.values()].find((e) => e.id === req.params.elementId);
  if (!el || el.ruleSetId !== regras.ruleSetId) {
    res.status(404).json({ erro: "Elemento não encontrado" });
    return;
  }
  const novoKey = `${el.key}_copia`;
  const chave = `${el.kind}:${novoKey}`;
  if (regras.elementos.has(chave)) {
    res.status(409).json({ erro: "Já existe um elemento com a chave de cópia" });
    return;
  }
  const agora = new Date();
  const id = crypto.randomUUID();
  await db.insert(ruleDefinitions).values({
    id,
    ruleSetId: regras.ruleSetId,
    kind: el.kind,
    key: novoKey,
    name: `${el.name} (cópia)`,
    category: el.category,
    parentKey: el.parentKey,
    definition: el.definition,
    createdAt: agora,
    updatedAt: agora,
  });
  emitirCampanha(req.params.campaignId, "regras:atualizadas", { elementId: id });
  res.status(201).json({ id });
});

/** PUT /api/campaigns/:campaignId/regras/config — configuração de pontos e aprovação (mestre) */
regrasRouter.put("/config", requirePapel("mestre"), async (req, res) => {
  const body = configRegrasSchema.partial().safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ erro: "Configuração inválida", detalhes: body.error.issues });
    return;
  }
  const regras = await carregarRegras(req.params.campaignId);
  if (!regras.ruleSetId) {
    res.status(500).json({ erro: "Ruleset não inicializado" });
    return;
  }
  const configAtual = { ...(regras.config as Record<string, unknown>) };
  const novo = configRegrasSchema.parse(mesclarParcial(configAtual, body.data as Record<string, unknown>, req.body));
  await db.update(ruleSets).set({ config: novo, updatedAt: new Date() }).where(eq(ruleSets.id, regras.ruleSetId));
  await audit(req, "regras.config.atualizada", {});
  emitirCampanha(req.params.campaignId, "regras:atualizadas", {});
  res.json({ ok: true, config: novo });
});

/** POST /api/campaigns/:campaignId/regras/seed — carrega biblioteca inicial (mestre) */
regrasRouter.post("/seed", requirePapel("mestre"), async (req, res) => {
  const regras = await carregarRegras(req.params.campaignId);
  if (!regras.ruleSetId) {
    res.status(500).json({ erro: "Ruleset não inicializado" });
    return;
  }
  let inseridos = 0;
  const agora = new Date();
  for (const item of SEED_BIBLIOTECA) {
    const chave = `${item.kind}:${item.key}`;
    if (regras.elementos.has(chave)) continue;
    await db.insert(ruleDefinitions).values({
      id: crypto.randomUUID(),
      ruleSetId: regras.ruleSetId,
      kind: item.kind,
      key: item.key,
      name: item.name,
      category: item.category,
      parentKey: null,
      definition: item.def ?? {},
      createdAt: agora,
      updatedAt: agora,
    });
    inseridos++;
  }
  await audit(req, "regras.seed.aplicado", { inseridos });
  emitirCampanha(req.params.campaignId, "regras:atualizadas", {});
  res.json({ ok: true, inseridos });
});

/**
 * GET /api/campaigns/:campaignId/regras/validacao/:characterId
 * Roda o validador completo (spec §9). Dono vê erros das próprias fichas;
 * mestre vê tudo. Não aprova automaticamente — aprovação é decisão do mestre,
 * salvo config.aprovacaoAutomatica (ver personagens.ts).
 */
regrasRouter.get("/validacao/:characterId", requirePapel("mestre", "jogador"), async (req, res) => {
  const campaignId = req.params.campaignId;
  const [p] = await db.select().from(characters).where(eq(characters.id, req.params.characterId)).limit(1);
  if (!p || p.campaignId !== campaignId) {
    res.status(404).json({ erro: "Personagem não encontrado" });
    return;
  }
  const ehMestre = req.membership!.role === "mestre";
  const [membroDono] = await db.select().from(memberships).where(eq(memberships.id, p.membershipId)).limit(1);
  if (!ehMestre && membroDono?.userId !== req.usuario!.id) {
    res.status(403).json({ erro: "Sem permissão" });
    return;
  }
  if (!p.templateVersionId) {
    res.json({ ok: true, erros: [], mensagem: "Personagem sem ficha vinculada" });
    return;
  }
  const [v] = await db.select().from(sheetVersions).where(eq(sheetVersions.id, p.templateVersionId)).limit(1);
  const parse = estruturaFichaSchema.safeParse(v?.structure);
  if (!parse.success) {
    res.status(500).json({ erro: "Estrutura da ficha inválida" });
    return;
  }
  const regras = await carregarRegras(campaignId);
  const resultado = validarRegras(parse.data, (p.data ?? {}) as Record<string, unknown>, regras);
  res.json({
    ok: resultado.ok,
    erros: resultado.erros,
    calculos: ehMestre ? resultado.calculos : undefined,
    pontosHabilitados: regras.config.pontos.habilitado || parse.data.pontos.habilitado,
    totalErros: resultado.erros.length,
  });
});

// ---------- referência de campos vinculáveis (para o editor de ficha) ----------

/** GET /api/campaigns/:campaignId/regras/vinculaveis — kinds + elementos p/ binding no editor */
regrasRouter.get("/vinculaveis", requirePapel("mestre", "jogador"), async (req, res) => {
  const regras = await carregarRegras(req.params.campaignId);
  const porKind = new Map<string, {
    key: string; name: string; category: string | null;
    niveis?: { descricao?: string; custo?: number }[];
    custoPontos?: number; maximo?: number;
  }[]>();
  for (const el of regras.elementos.values()) {
    if (el.definition.disponivel === false) continue;
    const lista = porKind.get(el.kind) ?? [];
    lista.push({
      key: el.key,
      name: el.name,
      category: el.category,
      niveis: el.definition.niveis?.length ? el.definition.niveis : undefined,
      custoPontos: el.definition.custoPontos,
      maximo: el.definition.maximo,
    });
    porKind.set(el.kind, lista);
  }
  const out: Record<string, { key: string; name: string; category: string | null }[]> = {};
  for (const [k, v] of porKind) out[k] = v.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ kinds: TIPOS_REGRA, elementos: out });
});
