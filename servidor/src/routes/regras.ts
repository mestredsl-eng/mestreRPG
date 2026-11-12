import { Router } from "express";
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

/**
 * GET /api/campaigns/:campaignId/regras/acervo/:bookId/diff
 * Prévia somente-leitura do que uma aplicação/sincronização faria:
 * itens novos, idênticos, conflitos por chave e elementos da campanha
 * preservados (ausentes no livro). Não grava nada.
 */
regrasRouter.get("/acervo/:bookId/diff", requirePapel("mestre"), async (req, res) => {
  const campaignId = req.params.campaignId;
  const resultado = db.transaction((tx): { http: number; payload: Record<string, unknown> } => {
    const [livro] = tx.select().from(ruleBooks)
      .where(and(eq(ruleBooks.id, req.params.bookId), isNull(ruleBooks.excluidoEm))).all();
    if (!livro) return { http: 404, payload: { erro: "Livro não encontrado ou excluído do Acervo" } };

    const itens = tx.select().from(ruleBookItems)
      .where(eq(ruleBookItems.bookId, livro.id))
      .orderBy(asc(ruleBookItems.ordem), asc(ruleBookItems.kind), asc(ruleBookItems.key)).all();

    const [rs] = tx.select().from(ruleSets)
      .where(and(eq(ruleSets.campaignId, campaignId), eq(ruleSets.isActive, true))).all();
    const atuais = rs
      ? tx.select().from(ruleDefinitions).where(eq(ruleDefinitions.ruleSetId, rs.id)).all()
      : [];
    const porChave = new Map(atuais.map((e) => [`${e.kind}:${e.key}`, e]));
    const chavesLivro = new Set(itens.map((i) => `${i.kind}:${i.key}`));

    let novos = 0, identicos = 0;
    const conflitos: { chave: string; nomeNoLivro: string; nomeNaCampanha: string }[] = [];
    const invalidos: string[] = [];
    for (const item of itens) {
      const chave = `${item.kind}:${item.key}`;
      const parsed = definicaoElementoSchema.safeParse(item.definition ?? {});
      if (!parsed.success) { invalidos.push(chave); continue; }
      const atual = porChave.get(chave);
      if (!atual) { novos++; continue; }
      const candidato = {
        name: item.name, category: item.category ?? null,
        parentKey: item.parentKey ?? null, definition: parsed.data,
      };
      const atualNorm = {
        name: atual.name, category: atual.category ?? null,
        parentKey: atual.parentKey ?? null,
        definition: definicaoElementoSchema.parse(atual.definition ?? {}),
      };
      if (JSON.stringify(candidato) === JSON.stringify(atualNorm)) identicos++;
      else conflitos.push({ chave, nomeNoLivro: item.name, nomeNaCampanha: atual.name });
    }
    const preservadosNaCampanha = atuais.filter((e) => !chavesLivro.has(`${e.kind}:${e.key}`)).length;

    const [vinculo] = tx.select().from(campaignRuleBooks)
      .where(and(eq(campaignRuleBooks.campaignId, campaignId), eq(campaignRuleBooks.bookId, livro.id))).all();

    return {
      http: 200,
      payload: {
        ok: true,
        livroId: livro.id,
        versao: livro.versao,
        versaoAplicada: vinculo?.appliedVersion ?? null,
        totais: {
          itensNoLivro: itens.length,
          novos,
          identicos,
          conflitos: conflitos.length,
          invalidos: invalidos.length,
          preservadosNaCampanha,
        },
        conflitos,
        semDiferencas: novos === 0 && conflitos.length === 0 && invalidos.length === 0
          && (vinculo?.appliedVersion ?? null) === livro.versao,
      },
    };
  });
  res.status(resultado.http).json(resultado.payload);
});

const aplicarLivroSchema = z.object({
  decisoes: z.record(z.string(), z.enum(["manter_campanha", "usar_livro"])).default({}),
});

/**
 * POST /api/campaigns/:campaignId/regras/acervo/:bookId/aplicar
 * Copia o conteúdo do livro para o ruleset ativo. Conflitos nunca são
 * sobrescritos sem decisão explícita; itens removidos do livro são preservados.
 */
regrasRouter.post("/acervo/:bookId/aplicar", requirePapel("mestre"), async (req, res) => {
  const body = aplicarLivroSchema.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ erro: "Decisões inválidas", detalhes: body.error.issues });
    return;
  }
  const campaignId = req.params.campaignId;
  const decisoes = body.data.decisoes;

  // Toda a leitura de decisão + escrita acontece DENTRO da mesma transação:
  // livro, itens, ruleset ativo, elementos atuais, vínculo e checagem de
  // no-op são relidos na hora — nenhuma decisão usa snapshot pré-transação.
  // O callback é síncrono (better-sqlite3 serializa a transação), então
  // aplicações concorrentes não intercalam leitura e escrita.
  const resultado = db.transaction((tx): { http: number; payload: Record<string, unknown> } => {
    const [livro] = tx.select().from(ruleBooks)
      .where(and(eq(ruleBooks.id, req.params.bookId), isNull(ruleBooks.excluidoEm))).all();
    if (!livro) return { http: 404, payload: { erro: "Livro não encontrado ou excluído do Acervo" } };

    const itens = tx.select().from(ruleBookItems)
      .where(eq(ruleBookItems.bookId, livro.id))
      .orderBy(asc(ruleBookItems.ordem), asc(ruleBookItems.kind), asc(ruleBookItems.key)).all();
    const incompatíveis = itens.filter((item) => !TIPOS_REGRA.includes(item.kind as (typeof TIPOS_REGRA)[number]));
    if (incompatíveis.length) {
      return {
        http: 422,
        payload: {
          erro: "O livro contém tipos que a biblioteca de campanha ainda não suporta",
          tipos: [...new Set(incompatíveis.map((i) => i.kind))],
        },
      };
    }
    const preparados = itens.map((item) => ({
      item,
      parsed: definicaoElementoSchema.safeParse(item.definition ?? {}),
    }));
    const invalidos = preparados.filter((p) => !p.parsed.success);
    if (invalidos.length) {
      return {
        http: 422,
        payload: {
          erro: "O livro contém definições incompatíveis com as regras da campanha",
          itens: invalidos.map(({ item, parsed }) => ({
            chave: `${item.kind}:${item.key}`,
            detalhes: parsed.success ? [] : parsed.error.issues,
          })),
        },
      };
    }

    // ruleset ativo — relido dentro da transação (pode ter sido trocado)
    let [rs] = tx.select().from(ruleSets)
      .where(and(eq(ruleSets.campaignId, campaignId), eq(ruleSets.isActive, true))).all();
    if (!rs) {
      const agoraRs = new Date();
      const rsId = crypto.randomUUID();
      tx.insert(ruleSets).values({
        id: rsId, campaignId, name: "Regras da campanha", version: 1, isActive: true,
        config: configRegrasSchema.parse({}), createdAt: agoraRs, updatedAt: agoraRs,
      }).run();
      [rs] = tx.select().from(ruleSets).where(eq(ruleSets.id, rsId)).all();
    }
    const ruleSetId = rs!.id;

    const existentes = tx.select().from(ruleDefinitions)
      .where(eq(ruleDefinitions.ruleSetId, ruleSetId)).all();
    const porChave = new Map(existentes.map((e) => [`${e.kind}:${e.key}`, e]));
    const conflitos = preparados.flatMap(({ item, parsed }) => {
      if (!parsed.success) return [];
      const chave = `${item.kind}:${item.key}`;
      const atual = porChave.get(chave);
      if (!atual) return [];
      const candidato = {
        name: item.name, category: item.category ?? null,
        parentKey: item.parentKey ?? null, definition: parsed.data,
      };
      const atualNormalizado = {
        name: atual.name, category: atual.category ?? null,
        parentKey: atual.parentKey ?? null,
        definition: definicaoElementoSchema.parse(atual.definition ?? {}),
      };
      if (JSON.stringify(candidato) === JSON.stringify(atualNormalizado)) return [];
      return [{
        chave, nomeNoLivro: item.name, nomeNaCampanha: atual.name,
        decisao: decisoes[chave] ?? null,
      }];
    });
    const semDecisao = conflitos.filter((c) => !c.decisao);
    if (semDecisao.length) {
      return {
        http: 409,
        payload: {
          erro: "Há elementos com a mesma chave na campanha. Escolha qual versão manter.",
          detalhes: { conflitos: semDecisao, opcoes: ["manter_campanha", "usar_livro"] },
        },
      };
    }

    const snapshot = itens.map((item) => ({
      kind: item.kind, key: item.key, name: item.name,
      category: item.category ?? null, parentKey: item.parentKey ?? null,
      definition: item.definition ?? {}, ordem: item.ordem,
    }));
    const [vinculoExistente] = tx.select().from(campaignRuleBooks)
      .where(and(eq(campaignRuleBooks.campaignId, campaignId), eq(campaignRuleBooks.bookId, livro.id))).all();
    if (vinculoExistente && vinculoExistente.appliedVersion === livro.versao && JSON.stringify(vinculoExistente.snapshot) === JSON.stringify(snapshot)) {
      return { http: 200, payload: { ok: true, semAlteracao: true, livroId: livro.id, versaoAplicada: livro.versao, inseridos: 0, atualizados: 0, mantidos: 0 } };
    }
    const t = new Date();
    const atuais = tx.select().from(ruleDefinitions)
      .where(eq(ruleDefinitions.ruleSetId, ruleSetId)).all();
    const mapa = new Map(atuais.map((e) => [`${e.kind}:${e.key}`, e]));
    let inseridos = 0, atualizados = 0, mantidos = 0;
    for (const { item, parsed } of preparados) {
      if (!parsed.success) continue;
      const chave = `${item.kind}:${item.key}`;
      const atual = mapa.get(chave);
      const decisao = decisoes[chave];
      const valores = {
        name: item.name, category: item.category ?? null,
        parentKey: item.parentKey ?? null, definition: parsed.data, updatedAt: t,
      };
      if (!atual) {
        tx.insert(ruleDefinitions).values({
          id: crypto.randomUUID(), ruleSetId,
          kind: item.kind, key: item.key, ...valores, createdAt: t,
        }).run();
        inseridos++;
      } else if (decisao === "manter_campanha") {
        mantidos++;
      } else {
        const mudou = atual.name !== valores.name
          || (atual.category ?? null) !== valores.category
          || (atual.parentKey ?? null) !== valores.parentKey
          || JSON.stringify(definicaoElementoSchema.parse(atual.definition ?? {})) !== JSON.stringify(valores.definition);
        if (mudou) {
          tx.update(ruleDefinitions).set(valores).where(eq(ruleDefinitions.id, atual.id)).run();
          atualizados++;
        }
      }
    }
    const [vinculo] = tx.select().from(campaignRuleBooks)
      .where(and(eq(campaignRuleBooks.campaignId, campaignId), eq(campaignRuleBooks.bookId, livro.id))).all();
    if (vinculo) {
      tx.update(campaignRuleBooks).set({
        appliedVersion: livro.versao, snapshot, appliedAt: t, updatedAt: t,
      }).where(eq(campaignRuleBooks.id, vinculo.id)).run();
    } else {
      tx.insert(campaignRuleBooks).values({
        id: crypto.randomUUID(), campaignId, bookId: livro.id,
        appliedVersion: livro.versao, snapshot, appliedAt: t, createdAt: t, updatedAt: t,
      }).run();
    }
    if (inseridos + atualizados > 0) {
      const [rulesetAtual] = tx.select({ version: ruleSets.version }).from(ruleSets)
        .where(eq(ruleSets.id, ruleSetId)).all();
      tx.update(ruleSets).set({ version: (rulesetAtual?.version ?? 1) + 1, updatedAt: t })
        .where(eq(ruleSets.id, ruleSetId)).run();
    }
    return {
      http: 200,
      payload: { ok: true, livroId: livro.id, versaoAplicada: livro.versao, inseridos, atualizados, mantidos },
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
