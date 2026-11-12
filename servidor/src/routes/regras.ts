import { Router } from "express";
import { createHash } from "node:crypto";
import { and, asc, eq, isNull, like, or } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { ruleSets, ruleDefinitions, characters, memberships, sheetVersions, ruleBooks, ruleBookItems, campaignRuleBooks } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePapel, getMembership } from "../lib/permissoes.js";
import {
  carregarRegras,
  configRegrasSchema,
  errosConversaoFerimento,
  definicaoElementoSchema,
  validarRegras,
  pontosParaFicha,
  TIPOS_REGRA,
  type ElementoRegra,
} from "../lib/regras.js";
import { estruturaFichaSchema, todosCampos, avaliarFormula, validarFicha } from "../lib/ficha.js";
import { resumoHp, resumoVitalidade, CHAVE_HP, CHAVE_VITALIDADE } from "../lib/vida.js";
import { bonusPontos } from "../lib/pontos.js";
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
  const errosConv = errosConversaoFerimento(novo);
  if (errosConv.length) {
    res.status(400).json({ erro: errosConv.join(" ") });
    return;
  }
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
  const resultado = validarRegras(parse.data, (p.data ?? {}) as Record<string, unknown>, regras, {
    bonusPontos: bonusPontos((p.data ?? {}) as Record<string, unknown>),
  });
  res.json({
    ok: resultado.ok,
    erros: resultado.erros,
    calculos: ehMestre ? resultado.calculos : undefined,
    pontosHabilitados: regras.config.pontos.habilitado || parse.data.pontos.habilitado,
    totalErros: resultado.erros.length,
  });
});

const simulacaoSchema = z.object({
  estrutura: estruturaFichaSchema,
  dados: z.record(z.string(), z.unknown()).default({}),
  // Orçamento fictício do simulador: substitui o saldo inicial do pool
  // padrão na prévia (reservas declaradas mantêm seus pontos).
  pontosFicticios: z.number().min(0).max(1_000_000).optional(),
});

/**
 * POST /api/campaigns/:campaignId/regras/simulacao — simulador da prévia
 * do editor de fichas (somente mestre). SOMENTE LEITURA: roda exatamente
 * o mesmo pipeline da ficha real (validarRegras → calcularPontos →
 * custos de seleção → transferências de reservas) sobre a estrutura e os
 * dados enviados, sem gravar nada. `pontosFicticios` permite testar com
 * orçamento livre. Não substitui a validação do PATCH/publicação.
 */
regrasRouter.post("/simulacao", requirePapel("mestre"), async (req, res) => {
  const body = simulacaoSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues });
    return;
  }
  const regras = await carregarRegras(req.params.campaignId);
  // Mesma normalização da ficha real: validarFicha descarta chaves
  // desconhecidas/reservadas (__hp, __vitalidade) e APLICA OS PADRÕES
  // (campo.padrao) — sem isso um campo com "valor inicial" pareceria
  // vazio para as regras e o simulador divergiria da ficha do jogador.
  const dadosBrutos = { ...(body.data.dados ?? {}) } as Record<string, unknown>;
  delete dadosBrutos[CHAVE_HP];
  delete dadosBrutos[CHAVE_VITALIDADE];
  const dados = validarFicha(body.data.estrutura, dadosBrutos, { estrito: false }).dados;
  const r = validarRegras(body.data.estrutura, dados, regras, {
    pontosIniciais: body.data.pontosFicticios,
  });
  const pontosCfgBase = pontosParaFicha(body.data.estrutura, regras);
  const pontosCfg = body.data.pontosFicticios !== undefined
    ? { ...pontosCfgBase, pontosIniciais: body.data.pontosFicticios }
    : pontosCfgBase;
  res.json({
    ok: r.ok,
    erros: r.erros,
    calculos: r.calculos,
    pontos: r.pontos,
    pontosCfg,
    // HP/Vitalidade simulados com os dados fictícios (somente leitura —
    // funções puras de vida.ts; nada é persistido).
    vida: {
      hp: resumoHp(regras.config.hp, body.data.estrutura, dados),
      vitalidade: resumoVitalidade(regras.config.vitalidade, dados),
    },
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


// ---------- Acervo global aplicado à campanha (snapshot explícito) ----------

/** GET /api/campaigns/:campaignId/regras/acervo — livros disponíveis e versão aplicada. */
regrasRouter.get("/acervo", requirePapel("mestre"), async (req, res) => {
  const campaignId = req.params.campaignId;
  const livros = await db.select().from(ruleBooks)
    .orderBy(asc(ruleBooks.titulo));
  const vinculos = await db.select().from(campaignRuleBooks)
    .where(eq(campaignRuleBooks.campaignId, campaignId));
  const porLivro = new Map(vinculos.map((v) => [v.bookId, v]));
  const contagens = await db.select().from(ruleBookItems);
  const totalPorLivro = new Map<string, number>();
  for (const item of contagens) totalPorLivro.set(item.bookId, (totalPorLivro.get(item.bookId) ?? 0) + 1);
  // livros excluídos do Acervo só aparecem se já tiverem vínculo com a campanha
  // (o vínculo precisa continuar identificável até o mestre decidir)
  const visiveis = livros.filter((b) => !b.excluidoEm || porLivro.has(b.id));
  res.json({
    livros: visiveis.map((b) => {
      const vinculo = porLivro.get(b.id);
      const excluido = !!b.excluidoEm;
      return {
        id: b.id, titulo: b.titulo, descricao: b.descricao, autor: b.autor,
        sistema: b.sistema, edicao: b.edicao, tipo: b.tipo, versao: b.versao,
        totalItens: totalPorLivro.get(b.id) ?? 0,
        aplicado: !!vinculo,
        versaoAplicada: vinculo?.appliedVersion ?? null,
        aplicadoEm: vinculo?.appliedAt ?? null,
        atualizacaoDisponivel: !!vinculo && !excluido && vinculo.appliedVersion !== b.versao,
        excluido,
        selecionavel: !excluido,
      };
    }),
  });
});

// ---------- Acervo → campanha: análise, prévia e aplicação ----------

/** JSON canônico: chaves ordenadas recursivamente (sem falso conflito por ordem de propriedades). */
function canonJson(v: unknown): string {
  // Date precisa serializar o instante — sem isso todo timestamp vira "{}"
  // e mudanças que só alteram updatedAt/excluidoEm passariam no fingerprint.
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonJson).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonJson(o[k])).join(",") + "}";
}

/** Normalização semântica única: ignora id, timestamps e ordem de exibição. */
function normElemento(e: { name?: unknown; category?: unknown; parentKey?: unknown; definition?: unknown }) {
  const parsed = definicaoElementoSchema.safeParse(e.definition ?? {});
  return {
    name: typeof e.name === "string" ? e.name : "",
    category: (e.category ?? null) as string | null,
    parentKey: (e.parentKey ?? null) as string | null,
    definition: parsed.success ? parsed.data : (e.definition ?? {}),
  };
}

type ItemSnapshot = { kind: string; key: string; name: string; category: string | null; parentKey: string | null; definition: unknown; ordem?: number };
type DecisaoGravada = { tipo: string; origem: string; campanha: string | null; em: number };

/** Lê snapshot legado (array) ou v2 ({formato:2, itens, decisoes}) sem migração. */
function lerSnapshotVinculo(snap: unknown): { itens: ItemSnapshot[]; decisoes: Record<string, DecisaoGravada> } {
  if (Array.isArray(snap)) return { itens: snap as ItemSnapshot[], decisoes: {} };
  if (snap && typeof snap === "object" && (snap as { formato?: number }).formato === 2) {
    const o = snap as { itens?: unknown; decisoes?: unknown };
    return {
      itens: Array.isArray(o.itens) ? (o.itens as ItemSnapshot[]) : [],
      decisoes: o.decisoes && typeof o.decisoes === "object" ? (o.decisoes as Record<string, DecisaoGravada>) : {},
    };
  }
  return { itens: [], decisoes: {} };
}

function snapshotItensCanon(itens: ItemSnapshot[]): string {
  return canonJson(itens.map((i) => ({ kind: i.kind, key: i.key, ...normElemento(i), ordem: i.ordem ?? 0 })));
}

type Dbx = ReturnType<typeof getDb>;

type RegraDef = typeof ruleDefinitions.$inferSelect;
type Livro = typeof ruleBooks.$inferSelect;
type ItemLivro = typeof ruleBookItems.$inferSelect;
type Vinculo = typeof campaignRuleBooks.$inferSelect;
type RuleSet = typeof ruleSets.$inferSelect;

/**
 * Classificação de três estados por chave `kind:key`:
 *  - snapshot anterior (o que este livro aplicou da última vez);
 *  - livro atual (conteúdo vigente no Acervo);
 *  - regras atuais da campanha (rule_definitions).
 *
 * tipos não pendentes: novo, identico, convergido (livro e campanha
 * mudaram para o mesmo valor), atualizar (só o livro mudou — campanha
 * intacta desde o snapshot), removido_livro (saiu do livro — preservado
 * na campanha), resolvido (decisão persistida ainda válida).
 * pendentes (exigem decisão explícita): personalizado (só a campanha
 * mudou), divergente (mudanças independentes nos dois lados), colisao
 * (chave de outro livro ou divergência sem snapshot), remocao (regra
 * aplicada antes e removida manualmente da campanha).
 */
type TipoClasseAcervo =
  | "novo" | "identico" | "convergido" | "atualizar"
  | "personalizado" | "divergente" | "colisao" | "remocao"
  | "removido_livro" | "resolvido";

interface Classificacao {
  chave: string;
  tipo: TipoClasseAcervo;
  pendente: boolean;
  item: ItemLivro | null;
  snap: ItemSnapshot | null;
  atual: RegraDef | null;
  nomeNoLivro: string;
  nomeNaCampanha: string;
  origem: string | null;
  tipoDecisao: "conteudo" | "colisao" | "preservar_remocao" | null;
  decisoesPossiveis: readonly string[];
}

interface AnaliseAcervo {
  http: number;
  payload: Record<string, unknown>;
  livro?: Livro;
  itens?: ItemLivro[];
  rs?: RuleSet;
  mapa?: Map<string, RegraDef>;
  classificacao?: Classificacao[];
  decisoesGravadas?: Record<string, DecisaoGravada>;
}

/** Canônico de conteúdo para comparar snapshot × livro × campanha. */
function canonConteudo(e: { name?: unknown; category?: unknown; parentKey?: unknown; definition?: unknown } | null | undefined): string | null {
  return e ? canonJson(normElemento(e)) : null;
}

/** Valores exibidos na prévia: nome + campos relevantes, sem ids/timestamps. */
function resumoValor(e: { name?: unknown; category?: unknown; parentKey?: unknown; definition?: unknown } | null | undefined) {
  if (!e) return null;
  return {
    name: typeof e.name === "string" ? e.name : "",
    category: (e.category ?? null) as string | null,
    parentKey: (e.parentKey ?? null) as string | null,
    definition: e.definition ?? {},
  };
}

/**
 * Análise somente-leitura do que aplicar/sincronizar faria. Consultas diretas:
 * nunca chama carregarRegras (que criaria ruleset), não grava nada, não
 * incrementa versões, não registra auditoria. Se não houver ruleset ativo,
 * o estado é simplesmente vazio.
 */
function analisarAcervo(dbx: Dbx, campaignId: string, bookId: string): AnaliseAcervo {
  const [livro] = dbx.select().from(ruleBooks)
    .where(and(eq(ruleBooks.id, bookId), isNull(ruleBooks.excluidoEm))).all();
  if (!livro) return { http: 404, payload: { erro: "Livro não encontrado ou excluído do Acervo" } };

  const itens = dbx.select().from(ruleBookItems)
    .where(eq(ruleBookItems.bookId, livro.id))
    .orderBy(asc(ruleBookItems.ordem), asc(ruleBookItems.kind), asc(ruleBookItems.key)).all();
  const [rs] = dbx.select().from(ruleSets)
    .where(and(eq(ruleSets.campaignId, campaignId), eq(ruleSets.isActive, true))).all();
  const atuais: RegraDef[] = rs
    ? dbx.select().from(ruleDefinitions).where(eq(ruleDefinitions.ruleSetId, rs.id)).all()
    : [];
  const mapa = new Map(atuais.map((e) => [`${e.kind}:${e.key}`, e]));
  const [vinculo] = dbx.select().from(campaignRuleBooks)
    .where(and(eq(campaignRuleBooks.campaignId, campaignId), eq(campaignRuleBooks.bookId, livro.id))).all();
  const { itens: antigosSnap, decisoes: decisoesGravadas } = lerSnapshotVinculo(vinculo?.snapshot);

  // chaves presentes em OUTROS livros vinculados à campanha (colisão entre livros)
  const outrosVinculos = dbx.select().from(campaignRuleBooks)
    .where(eq(campaignRuleBooks.campaignId, campaignId)).all()
    .filter((v: Vinculo) => v.bookId !== livro.id);
  const chavesOutrosLivros = new Set<string>();
  for (const v of outrosVinculos) {
    for (const i of lerSnapshotVinculo(v.snapshot).itens) chavesOutrosLivros.add(`${i.kind}:${i.key}`);
  }

  // kinds fora de TIPOS_REGRA: a aplicação rejeita o livro inteiro (422) —
  // a prévia precisa identificar a mesma incompatibilidade e não contar
  // esses itens como novos/identicos aplicáveis.
  const incompativeis = itens.filter((i) => !TIPOS_REGRA.includes(i.kind as (typeof TIPOS_REGRA)[number]));
  const chavesIncompativeis = new Set(incompativeis.map((i) => `${i.kind}:${i.key}`));

  const livroPorChave = new Map(itens.map((i) => [`${i.kind}:${i.key}`, i]));
  const snapPorChave = new Map(antigosSnap.map((i) => [`${i.kind}:${i.key}`, i]));
  // união snapshot ∪ livro: cobre itens removidos do livro e da campanha
  const chavesLivros = new Set([...livroPorChave.keys(), ...snapPorChave.keys()]);
  const chavesOrdenadas = [
    ...itens.map((i) => `${i.kind}:${i.key}`).filter((k) => chavesLivros.has(k)),
    ...[...snapPorChave.keys()].filter((k) => !livroPorChave.has(k)).sort(),
  ];

  const classificacao: Classificacao[] = [];
  const itensDiff: Record<string, unknown>[] = [];
  const invalidosLista: string[] = [];
  const pendentes: Record<string, unknown>[] = [];

  for (const chave of chavesOrdenadas) {
    const item = livroPorChave.get(chave) ?? null;
    const snap = snapPorChave.get(chave) ?? null;
    const atual = mapa.get(chave) ?? null;
    if (item && chavesIncompativeis.has(chave)) continue;
    if (item) {
      const parsed = definicaoElementoSchema.safeParse(item.definition ?? {});
      if (!parsed.success) { invalidosLista.push(chave); continue; }
    }

    const cL = canonConteudo(item);
    const cS = canonConteudo(snap);
    const cC = canonConteudo(atual);
    const outroLivro = chavesOutrosLivros.has(chave);
    const gravada = decisoesGravadas[chave];
    // decisão persistida só vale se origem (livro) e campanha seguem idênticas
    const decisaoGravadaOk = !!gravada && gravada.origem === cL && gravada.campanha === cC
      && ((gravada.tipo === "manter_campanha" && cC !== null)
        || (gravada.tipo === "preservar_remocao" && cC === null));

    const nomeNoLivro = item?.name ?? snap?.name ?? "";
    const nomeNaCampanha = atual?.name ?? "(ausente na campanha)";
    let tipo: TipoClasseAcervo;
    let origem: string | null = null;
    let pendente = false;
    let tipoDecisao: Classificacao["tipoDecisao"] = null;
    let decisoesPossiveis: readonly string[] = [];

    if (!atual) {
      if (item && !snap) {
        tipo = "novo";
      } else if (item && snap) {
        // aplicado antes por este livro e removido manualmente da campanha
        if (decisaoGravadaOk && gravada!.tipo === "preservar_remocao") {
          tipo = "resolvido";
        } else {
          tipo = "remocao"; origem = "remocao"; pendente = true;
          tipoDecisao = "preservar_remocao";
          decisoesPossiveis = ["preservar_remocao", "usar_livro"];
        }
      } else {
        continue; // removido do livro E da campanha — nada a exibir
      }
    } else if (!item) {
      // saiu do livro mas continua na campanha → preservado, só informativo
      tipo = "removido_livro"; origem = "fora_do_livro";
    } else if (!snap) {
      // livro ainda não aplicado (ou chave nova no livro) com regra existente
      if (cL === cC) {
        if (outroLivro) {
          if (decisaoGravadaOk && gravada!.tipo === "manter_campanha") tipo = "resolvido";
          else {
            tipo = "colisao"; origem = "colisao"; pendente = true;
            tipoDecisao = "colisao"; decisoesPossiveis = ["manter_campanha", "usar_livro"];
          }
        } else {
          tipo = "identico";
        }
      } else {
        if (decisaoGravadaOk && gravada!.tipo === "manter_campanha") tipo = "resolvido";
        else {
          tipo = outroLivro ? "colisao" : "divergente";
          origem = outroLivro ? "colisao" : "sem_snapshot";
          pendente = true;
          tipoDecisao = outroLivro ? "colisao" : "conteudo";
          decisoesPossiveis = ["manter_campanha", "usar_livro"];
        }
      }
    } else if (cL === cC) {
      // livro e campanha convergem — idêntico ou ambos mudaram para o mesmo valor
      tipo = cS === cL ? "identico" : "convergido"; origem = cS === cL ? null : "convergido";
    } else if (cC === cS) {
      // só o livro mudou; campanha intacta desde o snapshot → atualização segura
      tipo = "atualizar"; origem = "so_livro";
    } else {
      // campanha diverge do snapshot
      if (decisaoGravadaOk && gravada!.tipo === "manter_campanha") {
        tipo = "resolvido";
      } else {
        tipo = cL === cS ? "personalizado" : "divergente";
        origem = tipo === "personalizado" ? "so_campanha" : "ambos";
        pendente = true;
        tipoDecisao = outroLivro ? "colisao" : "conteudo";
        decisoesPossiveis = ["manter_campanha", "usar_livro"];
      }
    }

    if (pendente) {
      pendentes.push({
        chave, nomeNoLivro, nomeNaCampanha,
        tipo: tipoDecisao, origem, decisoesPossiveis,
      });
    }
    classificacao.push({
      chave, tipo, pendente, item, snap, atual,
      nomeNoLivro, nomeNaCampanha, origem, tipoDecisao, decisoesPossiveis,
    });
    itensDiff.push({
      chave, tipo, origem, pendente,
      nomeNoLivro, nomeNaCampanha,
      tipoDecisao, decisoesPossiveis,
      anterior: resumoValor(snap),
      livro: resumoValor(item),
      campanha: resumoValor(atual),
    });
  }

  const conta = (tp: TipoClasseAcervo) => classificacao.filter((c) => c.tipo === tp).length;
  const novos = conta("novo"), identicos = conta("identico"), convergidos = conta("convergido");
  const atualizar = conta("atualizar"), resolvidos = conta("resolvido"),
    removidosDoLivro = conta("removido_livro");
  const conflitos = pendentes.length;
  const chavesLivro = new Set(itens.map((i) => `${i.kind}:${i.key}`));

  // impressão digital determinística do estado relevante (book, itens, vínculos,
  // ruleset e definições) — cobre updatedAt/excluidoEm porque soft delete e
  // restauração alteram o estado sem necessariamente incrementar `versao`.
  const fingerprint = canonJson({
    livro: { id: livro.id, versao: livro.versao, updatedAt: livro.updatedAt, excluidoEm: livro.excluidoEm },
    itens: itens.map((i) => {
      const p = definicaoElementoSchema.safeParse(i.definition ?? {});
      return { kind: i.kind, key: i.key, ...normElemento({ ...i, definition: p.success ? p.data : i.definition }), ordem: i.ordem };
    }).sort((a, b) => `${a.kind}:${a.key}`.localeCompare(`${b.kind}:${b.key}`)),
    vinculo: vinculo ? { id: vinculo.id, appliedVersion: vinculo.appliedVersion, snapshot: vinculo.snapshot, updatedAt: vinculo.updatedAt } : null,
    outrosVinculos: outrosVinculos.map((v) => ({ id: v.id, appliedVersion: v.appliedVersion, snapshot: v.snapshot, updatedAt: v.updatedAt })),
    ruleset: rs ? { id: rs.id, version: rs.version, updatedAt: rs.updatedAt, config: rs.config } : null,
    defs: atuais.map((e) => ({ id: e.id, kind: e.kind, key: e.key, ...normElemento(e), updatedAt: e.updatedAt }))
      .sort((a, b) => `${a.kind}:${a.key}`.localeCompare(`${b.kind}:${b.key}`)),
  });
  const token = createHash("sha256").update(fingerprint).digest("hex");

  const snapshotNovoItens: ItemSnapshot[] = itens.map((i) => ({
    kind: i.kind, key: i.key, name: i.name,
    category: i.category ?? null, parentKey: i.parentKey ?? null,
    definition: i.definition ?? {}, ordem: i.ordem,
  }));
  const semDiferencas = incompativeis.length === 0
    && invalidosLista.length === 0
    && novos === 0 && atualizar === 0 && conflitos === 0
    && (vinculo?.appliedVersion ?? null) === livro.versao
    && snapshotItensCanon(antigosSnap) === snapshotItensCanon(snapshotNovoItens)
    && canonJson(decisoesGravadas) === "{}";

  return {
    http: 200,
    livro, itens, rs, mapa, classificacao, decisoesGravadas,
    payload: {
      ok: true,
      livroId: livro.id,
      titulo: livro.titulo,
      versao: livro.versao,
      versaoAplicada: vinculo?.appliedVersion ?? null,
      estadoToken: token,
      totais: {
        itensNoLivro: itens.length, novos, identicos, convergidos, atualizar,
        conflitos, resolvidos, invalidos: invalidosLista.length,
        incompativeis: incompativeis.length,
        removidosDoLivro,
        removidosDaCampanha: pendentes.filter((p) => p.tipo === "preservar_remocao").length,
        preservadosNaCampanha: atuais.filter((e) => !chavesLivro.has(`${e.kind}:${e.key}`)).length,
      },
      tiposIncompativeis: [...new Set(incompativeis.map((i) => i.kind))],
      aplicavelIntegralmente: incompativeis.length === 0 && invalidosLista.length === 0,
      conflitos: pendentes,
      itens: itensDiff,
      semDiferencas,
    },
  };
}

/** GET /api/campaigns/:campaignId/regras/acervo/:bookId/diff — prévia 100% sem efeitos colaterais. */
regrasRouter.get("/acervo/:bookId/diff", requirePapel("mestre"), async (req, res) => {
  const r = analisarAcervo(db, req.params.campaignId, req.params.bookId);
  res.status(r.http).json(r.payload);
});

/** DELETE /api/campaigns/:campaignId/regras/acervo/:bookId/vinculo — remove apenas o registro de vínculo. */
regrasRouter.delete("/acervo/:bookId/vinculo", requirePapel("mestre"), async (req, res) => {
  const campaignId = req.params.campaignId;
  const [vinculo] = await db.select().from(campaignRuleBooks)
    .where(and(eq(campaignRuleBooks.campaignId, campaignId), eq(campaignRuleBooks.bookId, req.params.bookId))).all();
  if (!vinculo) { res.status(404).json({ erro: "Vínculo não encontrado" }); return; }
  await db.delete(campaignRuleBooks).where(eq(campaignRuleBooks.id, vinculo.id));
  await audit(req, "biblioteca.livro.vinculo_removido", { bookId: req.params.bookId });
  res.json({ ok: true });
});

const TIPOS_DECISAO_ACERVO = ["manter_campanha", "usar_livro", "preservar_remocao"] as const;
const aplicarLivroSchema = z.object({
  decisoes: z.record(z.string(), z.enum(TIPOS_DECISAO_ACERVO)).default({}),
  // impressão digital obrigatória: a confirmação só vale para a prévia exata
  // que o mestre viu — conteúdo alterado depois da prévia exige nova prévia.
  estadoToken: z.string().min(1).max(128),
});

/**
 * POST /api/campaigns/:campaignId/regras/acervo/:bookId/aplicar
 * Transacional: relê tudo, confere a impressão digital da prévia, recalcula
 * a classificação de três estados, valida o conjunto EXATO de decisões e só
 * então grava — a aplicação nunca diverge do que a prévia anunciou.
 */
regrasRouter.post("/acervo/:bookId/aplicar", requirePapel("mestre"), async (req, res) => {
  const body = aplicarLivroSchema.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ erro: "Decisões inválidas", detalhes: body.error.issues });
    return;
  }
  const campaignId = req.params.campaignId;
  const decisoes = body.data.decisoes;
  const estadoTokenEnviado = body.data.estadoToken;

  const resultado = db.transaction((tx): { http: number; payload: Record<string, unknown> } => {
    const a = analisarAcervo(tx as unknown as Dbx, campaignId, req.params.bookId);
    if (a.http !== 200) return { http: a.http, payload: a.payload };
    // validação dura idêntica à anterior: kinds não suportados ou definições
    // inválidas bloqueiam a aplicação inteira (422), nunca aplicação parcial
    const itens = a.itens ?? [];
    const incompatíveis = itens.filter((i) => !TIPOS_REGRA.includes(i.kind as (typeof TIPOS_REGRA)[number]));
    if (incompatíveis.length) {
      return { http: 422, payload: { erro: "O livro contém tipos que a biblioteca de campanha ainda não suporta", tipos: [...new Set(incompatíveis.map((i) => i.kind))] } };
    }
    const invalidosDetalhe = itens
      .map((i) => ({ chave: `${i.kind}:${i.key}`, parsed: definicaoElementoSchema.safeParse(i.definition ?? {}) }))
      .filter((x) => !x.parsed.success);
    if (invalidosDetalhe.length) {
      return {
        http: 422,
        payload: {
          erro: "O livro contém definições incompatíveis com as regras da campanha",
          itens: invalidosDetalhe.map((x) => ({ chave: x.chave, detalhes: x.parsed.success ? [] : x.parsed.error.issues })),
        },
      };
    }
    const tokenAtual = a.payload.estadoToken as string;
    if (estadoTokenEnviado !== tokenAtual) {
      return { http: 409, payload: { erro: "O estado mudou desde a prévia — gere uma nova prévia", estadoToken: tokenAtual } };
    }
    const pendentes = (a.classificacao ?? []).filter((c) => c.pendente);
    const chavesPendentes = new Set(pendentes.map((c) => c.chave));
    // chaves já resolvidas por decisão persistida também aceitam a mesma decisão
    // (retry idempotente não pode virar "chave extra")
    const chavesAceitas = new Set([
      ...chavesPendentes,
      ...(a.classificacao ?? []).filter((c) => c.tipo === "resolvido").map((c) => c.chave),
    ]);
    const extras = Object.keys(decisoes).filter((k) => !chavesAceitas.has(k));
    const faltantes = [...chavesPendentes].filter((k) => !decisoes[k]);
    if (extras.length || faltantes.length) {
      return {
        http: 409,
        payload: {
          erro: "Decisões de sincronização inválidas",
          detalhes: {
            conflitos: pendentes.map((c) => ({
              chave: c.chave, nomeNoLivro: c.nomeNoLivro,
              nomeNaCampanha: c.nomeNaCampanha,
              tipo: c.tipoDecisao, origem: c.origem,
            })),
            chavesExtras: extras, chavesFaltantes: faltantes,
            opcoes: [...TIPOS_DECISAO_ACERVO],
          },
        },
      };
    }
    // decisão compatível com o tipo de conflito
    for (const c of pendentes) {
      const d = decisoes[c.chave];
      const ausente = !c.atual;
      if (ausente && d === "manter_campanha") {
        return { http: 409, payload: { erro: "Decisão incompatível com o conflito", chave: c.chave } };
      }
      if (!ausente && d === "preservar_remocao") {
        return { http: 409, payload: { erro: "Decisão incompatível com o conflito", chave: c.chave } };
      }
      // decisão precisa estar entre as opções do conflito exibido na prévia
      if (!(c.decisoesPossiveis as readonly string[]).includes(d)) {
        return { http: 409, payload: { erro: "Decisão incompatível com o conflito", chave: c.chave } };
      }
    }

    const livro = a.livro!; const mapa = a.mapa!;
    // campanha sem ruleset ativo (nunca abriu Regras): criar sob demanda,
    // mesmo default de carregarRegras — a prévia representa o estado vazio
    // sem criar nada; a aplicação materializa o ruleset na transação.
    let rs = a.rs;
    if (!rs) {
      const idRs = crypto.randomUUID();
      const configRs = configRegrasSchema.parse({});
      tx.insert(ruleSets).values({
        id: idRs, campaignId, name: "Regras da campanha", version: 1,
        isActive: true, config: configRs, createdAt: new Date(), updatedAt: new Date(),
      }).run();
      [rs] = tx.select().from(ruleSets).where(eq(ruleSets.id, idRs)).all();
    }
    const t = new Date();
    let inseridos = 0, atualizados = 0, mantidos = 0, preservados = 0;
    const novasDecisoes: Record<string, DecisaoGravada> = { ...(a.decisoesGravadas ?? {}) };

    // revalida decisões antigas: só sobrevivem se origem e estado da campanha seguem iguais
    for (const [chave, d] of Object.entries(novasDecisoes)) {
      const item = itens.find((i) => `${i.kind}:${i.key}` === chave);
      const def = mapa.get(chave);
      if (!item || !TIPOS_REGRA.includes(item.kind as (typeof TIPOS_REGRA)[number])) { delete novasDecisoes[chave]; continue; }
      const origem = canonConteudo(item);
      const campanha = canonConteudo(def);
      const tipoOk = d.tipo === "preservar_remocao" ? campanha === null
        : d.tipo === "manter_campanha" ? campanha !== null : false;
      if (d.origem !== origem || d.campanha !== campanha || !tipoOk) delete novasDecisoes[chave];
    }

    // upsert do conteúdo do livro: usado por "novo", "atualizar" (só o livro
    // mudou) e "usar_livro" (decisão sobre conflito) — a prévia garante que
    // esses são exatamente os casos em que o valor do livro deve prevalecer.
    const gravarDoLivro = (item: ItemLivro, atual: RegraDef | undefined) => {
      const parsed = definicaoElementoSchema.safeParse(item.definition ?? {});
      if (!parsed.success) return;
      const valores = {
        name: item.name, category: item.category ?? null,
        parentKey: item.parentKey ?? null, definition: parsed.data, updatedAt: t,
      };
      if (!atual) {
        tx.insert(ruleDefinitions).values({
          id: crypto.randomUUID(), ruleSetId: rs.id,
          kind: item.kind, key: item.key, ...valores, createdAt: t,
        }).run();
        inseridos++;
        return;
      }
      if (canonConteudo(atual) !== canonConteudo(item)) {
        tx.update(ruleDefinitions).set(valores).where(eq(ruleDefinitions.id, atual.id)).run();
        atualizados++;
      }
    };

    for (const c of a.classificacao ?? []) {
      const item = c.item;
      if (!item) continue; // removido_livro: sem item do livro, nada a gravar
      const chave = c.chave;
      const atual = mapa.get(chave);

      if (c.tipo === "novo" || c.tipo === "atualizar") {
        gravarDoLivro(item, atual);
        continue;
      }
      if (!c.pendente) continue; // identico/convergido/resolvido/removido_livro
      const decisao = decisoes[chave];
      if (decisao === "manter_campanha" || decisao === "preservar_remocao") {
        novasDecisoes[chave] = {
          tipo: decisao,
          origem: canonConteudo(item)!,
          campanha: decisao === "preservar_remocao" ? null : canonConteudo(atual),
          em: t.getTime(),
        };
        if (decisao === "manter_campanha") mantidos++; else preservados++;
        continue;
      }
      // usar_livro: produz exatamente a alteração mostrada na prévia
      gravarDoLivro(item, atual);
    }

    const snapshot = {
      formato: 2 as const,
      itens: itens.map((i) => ({
        kind: i.kind, key: i.key, name: i.name,
        category: i.category ?? null, parentKey: i.parentKey ?? null,
        definition: i.definition ?? {}, ordem: i.ordem,
      })),
      decisoes: novasDecisoes,
    };
    const [vinculoAtual] = tx.select().from(campaignRuleBooks)
      .where(and(eq(campaignRuleBooks.campaignId, campaignId), eq(campaignRuleBooks.bookId, livro.id))).all();
    const snapAntigo = vinculoAtual ? lerSnapshotVinculo(vinculoAtual.snapshot) : null;
    const semAlteracao = !!vinculoAtual
      && vinculoAtual.appliedVersion === livro.versao
      && snapAntigo !== null
      && snapshotItensCanon(snapAntigo.itens) === snapshotItensCanon(snapshot.itens)
      && canonJson(snapAntigo.decisoes) === canonJson(novasDecisoes)
      && inseridos + atualizados + mantidos + preservados === 0;
    if (!semAlteracao) {
      if (vinculoAtual) {
        tx.update(campaignRuleBooks).set({
          appliedVersion: livro.versao, snapshot, appliedAt: t, updatedAt: t,
        }).where(eq(campaignRuleBooks.id, vinculoAtual.id)).run();
      } else {
        tx.insert(campaignRuleBooks).values({
          id: crypto.randomUUID(), campaignId, bookId: livro.id,
          appliedVersion: livro.versao, snapshot, appliedAt: t, createdAt: t, updatedAt: t,
        }).run();
      }
    }
    if (inseridos + atualizados > 0) {
      const [rulesetAtual] = tx.select({ version: ruleSets.version }).from(ruleSets)
        .where(eq(ruleSets.id, rs.id)).all();
      tx.update(ruleSets).set({ version: (rulesetAtual?.version ?? 1) + 1, updatedAt: t })
        .where(eq(ruleSets.id, rs.id)).run();
    }
    return {
      http: 200,
      payload: {
        ok: true, livroId: livro.id, versaoAplicada: livro.versao,
        inseridos, atualizados, mantidos, preservados,
        semAlteracao: semAlteracao || undefined,
        estadoToken: tokenAtual,
      },
    };
  });

  if (resultado.http !== 200) {
    res.status(resultado.http).json(resultado.payload);
    return;
  }
  await audit(req, "biblioteca.livro.aplicado_campanha", {
    bookId: req.params.bookId, versao: resultado.payload.versaoAplicada,
    inseridos: resultado.payload.inseridos, atualizados: resultado.payload.atualizados,
    mantidos: resultado.payload.mantidos,
  });
  if (!resultado.payload.semAlteracao) {
    emitirCampanha(campaignId, "regras:atualizadas", { origem: "acervo", bookId: req.params.bookId });
  }
  res.json(resultado.payload);
});
