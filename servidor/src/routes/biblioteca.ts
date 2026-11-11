import { Router } from "express";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { ruleBooks, ruleBookItems, ruleBookBackups } from "../db/schema.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { audit } from "../lib/audit.js";
import {
  FORMATO_ACERVO,
  VERSAO_FORMATO,
  envelopeImportacaoSchema,
  decisoesImportacaoSchema,
  itemLivroSchema,
  metadadosLivroSchema,
  diffLivro,
  livroParaEnvelope,
  mesmoItem,
  canonical,
  chaveConflito,
  type LivroExportado,
  type ItemDb,
} from "../lib/biblioteca.js";

const db = getDb();
export const bibliotecaRouter = Router();
bibliotecaRouter.use(requireAuth);

const novoId = () => crypto.randomUUID();
const agora = () => new Date();
type LivroRow = typeof ruleBooks.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const TAM_MAX_DEFINITION = 64 * 1024;

// ---------- helpers ----------

async function itensDoLivro(bookId: string): Promise<ItemDb[]> {
  const rows = await db.select().from(ruleBookItems)
    .where(eq(ruleBookItems.bookId, bookId))
    .orderBy(asc(ruleBookItems.ordem), asc(ruleBookItems.kind), asc(ruleBookItems.key));
  return rows.map((r) => ({
    id: r.id, kind: r.kind, key: r.key, name: r.name,
    category: r.category, parentKey: r.parentKey,
    definition: r.definition, ordem: r.ordem,
  }));
}

/** Snapshot + incremento de versão na mesma transação da mutação manual. */
function backupAntesMutacao(tx: Tx, bookId: string, motivo: string, t: Date): void {
  const b = tx.select().from(ruleBooks).where(eq(ruleBooks.id, bookId)).get();
  if (!b) throw new Error("Livro não encontrado durante a mutação");
  const rows = tx.select().from(ruleBookItems).where(eq(ruleBookItems.bookId, bookId)).all();
  const itens: ItemDb[] = rows.map((r) => ({
    id: r.id, kind: r.kind, key: r.key, name: r.name,
    category: r.category, parentKey: r.parentKey,
    definition: r.definition, ordem: r.ordem,
  }));
  const snapshot = livroParaEnvelope(
    { ...b, formatoVersao: b.formatoVersao ?? VERSAO_FORMATO },
    itens,
  );
  tx.insert(ruleBookBackups).values({
    id: novoId(), bookId,
    snapshot: { formato: FORMATO_ACERVO, versao: VERSAO_FORMATO, livros: [snapshot] },
    motivo, createdAt: t,
  }).run();
  tx.update(ruleBooks).set({
    versao: (b.versao ?? 1) + 1, updatedAt: t,
  }).where(eq(ruleBooks.id, bookId)).run();
}

/** Livro ativo (não excluído logicamente). Uso em consultas e mutações. */
async function livroPorId(id: string): Promise<LivroRow | null> {
  const [b] = await db.select().from(ruleBooks)
    .where(and(eq(ruleBooks.id, id), isNull(ruleBooks.excluidoEm))).limit(1);
  return b ?? null;
}

/** Livro em qualquer estado — só para administração (backups, restauração). */
async function livroPorIdQualquer(id: string): Promise<LivroRow | null> {
  const [b] = await db.select().from(ruleBooks).where(eq(ruleBooks.id, id)).limit(1);
  return b ?? null;
}

function metaResposta(b: LivroRow, totalItens?: number) {
  return {
    id: b.id,
    titulo: b.titulo,
    descricao: b.descricao,
    autor: b.autor,
    sistema: b.sistema,
    edicao: b.edicao,
    tipo: b.tipo,
    versao: b.versao,
    formatoVersao: b.formatoVersao,
    origem: b.origem,
    excluidoEm: b.excluidoEm ?? null,
    totalItens,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
  };
}

// ---------- Listagem / consulta (qualquer autenticado) ----------

/** GET /api/biblioteca/livros — acervo (metadados + contagem de itens). */
bibliotecaRouter.get("/livros", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const tipo = typeof req.query.tipo === "string" ? req.query.tipo : "";
  // Excluídos (soft delete) só aparecem para admin com ?incluirExcluidos=1.
  const incluirExcluidos = req.query.incluirExcluidos === "1" && req.usuario?.isAdmin === true;
  const livros = await db.select().from(ruleBooks).orderBy(asc(ruleBooks.titulo));
  const contagens = new Map<string, number>();
  for (const row of await db.select({ bookId: ruleBookItems.bookId }).from(ruleBookItems)) {
    contagens.set(row.bookId, (contagens.get(row.bookId) ?? 0) + 1);
  }
  let lista = livros
    .filter((b) => incluirExcluidos || b.excluidoEm == null)
    .map((b) => metaResposta(b, contagens.get(b.id) ?? 0));
  if (q) {
    const needle = q.toLowerCase();
    lista = lista.filter((b) =>
      [b.titulo, b.autor, b.sistema, b.edicao, b.descricao ?? ""]
        .some((v) => v != null && v.toLowerCase().includes(needle))
    );
  }
  if (tipo === "livro" || tipo === "suplemento") lista = lista.filter((b) => b.tipo === tipo);
  res.json({ livros: lista, total: lista.length });
});

/** GET /api/biblioteca/livros/:id — livro completo com itens.
 *  Livro excluído (soft delete): admin consulta, demais recebem 404. */
bibliotecaRouter.get("/livros/:id", async (req, res) => {
  let b = await livroPorId(req.params.id);
  if (!b) {
    const excluido = await livroPorIdQualquer(req.params.id);
    if (!excluido?.excluidoEm || !req.usuario?.isAdmin) {
      res.status(404).json({ erro: "Livro não encontrado" });
      return;
    }
    b = excluido;
  }
  const itens = await itensDoLivro(b.id);
  res.json({ livro: metaResposta(b, itens.length), itens });
});

// ---------- Criação / edição de metadados / exclusão (admin) ----------

const criarLivroSchema = metadadosLivroSchema.extend({
  itens: z.array(itemLivroSchema).max(5000).default([]),
});

function duplicadosKindKey(itens: { kind: string; key: string }[]): string | null {
  const vistos = new Set<string>();
  for (const it of itens) {
    const ck = chaveConflito(it.kind, it.key);
    if (vistos.has(ck)) return ck;
    vistos.add(ck);
  }
  return null;
}

/** POST /api/biblioteca/livros — cria livro manual com itens opcionais. */
bibliotecaRouter.post("/livros", requireAdmin, async (req, res) => {
  const body = criarLivroSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues });
    return;
  }
  const dup = duplicadosKindKey(body.data.itens);
  if (dup) { res.status(400).json({ erro: `Item duplicado no livro: ${dup}` }); return; }
  const t = agora();
  const id = novoId();
  const [b] = await db.insert(ruleBooks).values({
    id,
    titulo: body.data.titulo,
    descricao: body.data.descricao ?? null,
    autor: body.data.autor ?? null,
    sistema: body.data.sistema ?? null,
    edicao: body.data.edicao ?? null,
    tipo: body.data.tipo,
    versao: 1,
    formatoVersao: VERSAO_FORMATO,
    origem: "manual",
    createdAt: t,
    updatedAt: t,
  }).returning();
  if (body.data.itens.length) {
    await db.insert(ruleBookItems).values(body.data.itens.map((it, i) => ({
      id: novoId(), bookId: id, kind: it.kind, key: it.key, name: it.name,
      category: it.category ?? null, parentKey: it.parentKey ?? null,
      definition: it.definition ?? {}, ordem: it.ordem ?? i,
      createdAt: t, updatedAt: t,
    })));
  }
  await audit(req, "biblioteca.livro.criado", { bookId: id, titulo: b.titulo });
  res.status(201).json({ livro: metaResposta(b, body.data.itens.length) });
});

const editarLivroSchema = z.object({
  titulo: z.string().trim().min(1).max(200).optional(),
  descricao: z.string().max(4000).nullish(),
  autor: z.string().max(200).nullish(),
  sistema: z.string().max(120).nullish(),
  edicao: z.string().max(120).nullish(),
  tipo: z.enum(["livro", "suplemento"]).optional(),
}).strict();

/** PATCH /api/biblioteca/livros/:id — edita metadados (itens têm rotas próprias). */
bibliotecaRouter.patch("/livros/:id", requireAdmin, async (req, res) => {
  const body = editarLivroSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues });
    return;
  }
  const b = await livroPorId(req.params.id);
  if (!b) { res.status(404).json({ erro: "Livro não encontrado" }); return; }
  const t = agora();
  // Ignora campos enviados com o mesmo valor — PATCH no-op não gera
  // backup nem incremento de versão.
  const campos: Record<string, unknown> = {};
  for (const k of ["titulo", "descricao", "autor", "sistema", "edicao", "tipo"] as const) {
    if (body.data[k] !== undefined) {
      const novo = body.data[k] ?? null;
      const velho = (b as Record<string, unknown>)[k] ?? null;
      if (novo !== velho) campos[k] = novo;
    }
  }
  if (!Object.keys(campos).length) {
    const total = (await itensDoLivro(b.id)).length;
    res.json({ livro: metaResposta(b, total), semAlteracao: true });
    return;
  }
  campos.updatedAt = t;
  db.transaction((tx) => {
    backupAntesMutacao(tx, b.id, "antes de editar metadados", t);
    tx.update(ruleBooks).set(campos).where(eq(ruleBooks.id, b.id)).run();
  });
  await audit(req, "biblioteca.livro.atualizado", { bookId: b.id });
  const atualizado = await livroPorId(b.id);
  const total = (await itensDoLivro(b.id)).length;
  res.json({ livro: metaResposta(atualizado!, total) });
});

/**
 * DELETE /api/biblioteca/livros/:id — exclusão lógica (soft delete).
 * Itens e backups são preservados; o livro some das consultas e pode ser
 * restaurado via POST /livros/:id/restaurar. `?definitivo=1` faz a exclusão
 * real em cascata (itens + backups) — ação irreversível, explícita.
 */
bibliotecaRouter.delete("/livros/:id", requireAdmin, async (req, res) => {
  const definitivo = req.query.definitivo === "1";
  // Ambos os caminhos usam qualquer estado: soft delete é idempotente
  // (já excluído -> jaExcluido) e definitivo também funciona em excluído.
  const b = await livroPorIdQualquer(req.params.id);
  if (!b) { res.status(404).json({ erro: "Livro não encontrado" }); return; }
  if (definitivo) {
    if (!b.excluidoEm) {
      // exclusão definitiva de livro ativo: exige que já esteja excluído?
      // Não — é a saída para quem quer apagar de vez; faz direto.
    }
    await db.delete(ruleBooks).where(eq(ruleBooks.id, b.id)); // cascade: itens e backups
    await audit(req, "biblioteca.livro.removido_definitivo", { bookId: b.id, titulo: b.titulo });
    res.json({ ok: true, definitivo: true });
    return;
  }
  if (b.excluidoEm) { res.json({ ok: true, jaExcluido: true }); return; }
  await db.update(ruleBooks).set({ excluidoEm: agora(), updatedAt: agora() }).where(eq(ruleBooks.id, b.id));
  await audit(req, "biblioteca.livro.excluido", { bookId: b.id, titulo: b.titulo });
  res.json({ ok: true, excluido: true });
});

/** POST /api/biblioteca/livros/:id/restaurar — reverte soft delete.
 *  O livro volta com itens, backups e versão intactos (mesma row — sem duplicar). */
bibliotecaRouter.post("/livros/:id/restaurar", requireAdmin, async (req, res) => {
  const b = await livroPorIdQualquer(req.params.id);
  if (!b) { res.status(404).json({ erro: "Livro não encontrado" }); return; }
  if (!b.excluidoEm) { res.status(409).json({ erro: "Livro não está excluído" }); return; }
  // Colisão de título com livro ativo? A restauração não renomeia —
  // títulos duplicados são permitidos no acervo (imports usam id primeiro).
  await db.update(ruleBooks).set({ excluidoEm: null, updatedAt: agora() }).where(eq(ruleBooks.id, b.id));
  await audit(req, "biblioteca.livro.restaurado", { bookId: b.id, titulo: b.titulo });
  const restaurado = await livroPorId(b.id);
  const total = (await itensDoLivro(b.id)).length;
  res.json({ livro: metaResposta(restaurado!, total) });
});

// ---------- Itens ----------

/** POST /api/biblioteca/livros/:id/itens — adiciona item. */
bibliotecaRouter.post("/livros/:id/itens", requireAdmin, async (req, res) => {
  const b = await livroPorId(req.params.id);
  if (!b) { res.status(404).json({ erro: "Livro não encontrado" }); return; }
  const body = itemLivroSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues }); return; }
  const [existe] = await db.select({ id: ruleBookItems.id }).from(ruleBookItems)
    .where(and(eq(ruleBookItems.bookId, b.id), eq(ruleBookItems.kind, body.data.kind), eq(ruleBookItems.key, body.data.key)))
    .limit(1);
  if (existe) { res.status(409).json({ erro: `Já existe item ${chaveConflito(body.data.kind, body.data.key)} neste livro` }); return; }
  const t = agora();
  const id = novoId();
  try {
    db.transaction((tx) => {
      backupAntesMutacao(tx, b.id, "antes de adicionar item", t);
      tx.insert(ruleBookItems).values({
        id, bookId: b.id, kind: body.data.kind, key: body.data.key, name: body.data.name,
        category: body.data.category ?? null, parentKey: body.data.parentKey ?? null,
        definition: body.data.definition ?? {}, ordem: body.data.ordem ?? 0,
        createdAt: t, updatedAt: t,
      }).run();
    });
  } catch (e) {
    res.status(409).json({ erro: "Não foi possível adicionar o item", detalhe: e instanceof Error ? e.message : String(e) });
    return;
  }
  await audit(req, "biblioteca.item.criado", { bookId: b.id, item: chaveConflito(body.data.kind, body.data.key) });
  res.status(201).json({ ok: true, id });
});

// .partial() vazaria os .default() de definition/ordem — campos ausentes
// chegariam como {} e 0 e sobrescreveriam o item. Schema explícito, sem defaults.
const editarItemSchema = z.object({
  kind: itemLivroSchema.shape.kind.optional(),
  key: itemLivroSchema.shape.key.optional(),
  name: itemLivroSchema.shape.name.optional(),
  category: itemLivroSchema.shape.category.optional(),
  parentKey: itemLivroSchema.shape.parentKey.optional(),
  definition: z.record(z.string(), z.unknown()).optional(),
  ordem: z.number().int().min(0).max(1_000_000).optional(),
});

/** PATCH /api/biblioteca/livros/:id/itens/:itemId — edita item. */
bibliotecaRouter.patch("/livros/:id/itens/:itemId", requireAdmin, async (req, res) => {
  const b = await livroPorId(req.params.id);
  if (!b) { res.status(404).json({ erro: "Livro não encontrado" }); return; }
  const body = editarItemSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues }); return; }
  const [item] = await db.select().from(ruleBookItems)
    .where(and(eq(ruleBookItems.id, req.params.itemId), eq(ruleBookItems.bookId, b.id))).limit(1);
  if (!item) { res.status(404).json({ erro: "Item não encontrado" }); return; }
  const novoKind = body.data.kind ?? item.kind;
  const novaKey = body.data.key ?? item.key;
  if (novoKind !== item.kind || novaKey !== item.key) {
    const [duplicado] = await db.select({ id: ruleBookItems.id }).from(ruleBookItems)
      .where(and(eq(ruleBookItems.bookId, b.id), eq(ruleBookItems.kind, novoKind), eq(ruleBookItems.key, novaKey)))
      .limit(1);
    if (duplicado && duplicado.id !== item.id) {
      res.status(409).json({ erro: `Já existe item ${chaveConflito(novoKind, novaKey)} neste livro` });
      return;
    }
  }
  const t = agora();
  // Idem: PATCH de item sem mudança real não gera backup nem versão.
  const campos: Record<string, unknown> = {};
  const iguais: Record<string, boolean> = {
    kind: body.data.kind === undefined || body.data.kind === item.kind,
    key: body.data.key === undefined || body.data.key === item.key,
    name: body.data.name === undefined || body.data.name === item.name,
    category: body.data.category === undefined || (body.data.category ?? null) === item.category,
    parentKey: body.data.parentKey === undefined || (body.data.parentKey ?? null) === item.parentKey,
    definition: body.data.definition === undefined || canonical(body.data.definition ?? {}) === canonical(item.definition ?? {}),
    ordem: body.data.ordem === undefined || body.data.ordem === item.ordem,
  };
  for (const k of ["kind", "key", "name", "category", "parentKey", "definition", "ordem"] as const) {
    if (body.data[k] !== undefined && !iguais[k]) campos[k] = body.data[k] ?? null;
  }
  if (!Object.keys(campos).length) {
    res.json({ ok: true, semAlteracao: true });
    return;
  }
  campos.updatedAt = t;
  try {
    db.transaction((tx) => {
      backupAntesMutacao(tx, b.id, "antes de editar item", t);
      tx.update(ruleBookItems).set(campos).where(eq(ruleBookItems.id, item.id)).run();
    });
  } catch (e) {
    res.status(409).json({ erro: "Não foi possível editar o item", detalhe: e instanceof Error ? e.message : String(e) });
    return;
  }
  await audit(req, "biblioteca.item.atualizado", { bookId: b.id, item: chaveConflito(novoKind, novaKey) });
  res.json({ ok: true });
});

/** DELETE /api/biblioteca/livros/:id/itens/:itemId — remove item. */
bibliotecaRouter.delete("/livros/:id/itens/:itemId", requireAdmin, async (req, res) => {
  const b = await livroPorId(req.params.id);
  if (!b) { res.status(404).json({ erro: "Livro não encontrado" }); return; }
  const [item] = await db.select().from(ruleBookItems)
    .where(and(eq(ruleBookItems.id, req.params.itemId), eq(ruleBookItems.bookId, b.id))).limit(1);
  if (!item) { res.status(404).json({ erro: "Item não encontrado" }); return; }
  const t = agora();
  db.transaction((tx) => {
    backupAntesMutacao(tx, b.id, "antes de remover item", t);
    tx.delete(ruleBookItems).where(eq(ruleBookItems.id, item.id)).run();
  });
  await audit(req, "biblioteca.item.removido", { bookId: b.id, item: `${item.kind}:${item.key}` });
  res.json({ ok: true });
});

const ordemSchema = z.object({
  itens: z.array(z.object({ id: z.string(), ordem: z.number().int().min(0) })).min(1).max(5000),
});

/** PUT /api/biblioteca/livros/:id/itens/ordem — reordena [{id, ordem}]. */
bibliotecaRouter.put("/livros/:id/itens/ordem", requireAdmin, async (req, res) => {
  const b = await livroPorId(req.params.id);
  if (!b) { res.status(404).json({ erro: "Livro não encontrado" }); return; }
  const body = ordemSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues }); return; }
  const atuais = await db.select({ id: ruleBookItems.id, ordem: ruleBookItems.ordem }).from(ruleBookItems).where(eq(ruleBookItems.bookId, b.id));
  const mapa = new Map(atuais.map((a) => [a.id, a.ordem]));
  const alteracoes = body.data.itens.filter((it) => mapa.has(it.id) && mapa.get(it.id) !== it.ordem);
  if (!alteracoes.length) { res.json({ ok: true, alterados: 0 }); return; }
  const t = agora();
  db.transaction((tx) => {
    backupAntesMutacao(tx, b.id, "antes de reordenar itens", t);
    for (const it of alteracoes) {
      tx.update(ruleBookItems).set({ ordem: it.ordem, updatedAt: t }).where(eq(ruleBookItems.id, it.id)).run();
    }
  });
  await audit(req, "biblioteca.itens.reordenados", { bookId: b.id, quantidade: alteracoes.length });
  res.json({ ok: true, alterados: alteracoes.length });
});

// ---------- Importação: prévia e confirmação ----------

interface LivroProcessado {
  entrada: LivroExportado;
  existente: LivroRow | null;
  itensDb: ItemDb[];
  diff: ReturnType<typeof diffLivro>;
}

const normTitulo = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

/** Resolve o livro existente para um item do envelope: por id, senão por título. */
async function resolverLivro(entrada: LivroExportado): Promise<{ book: LivroRow | null; itensDb: ItemDb[] }> {
  if (entrada.id) {
    const b = await livroPorId(entrada.id);
    if (b) return { book: b, itensDb: await itensDoLivro(b.id) };
  }
  const alvo = normTitulo(entrada.titulo);
  // Livros excluídos (soft delete) não participam do match de importação —
  // um envelope que cite o título de um excluído cria livro novo.
  const todos = await db.select().from(ruleBooks).where(isNull(ruleBooks.excluidoEm));
  const b = todos.find((x) => normTitulo(x.titulo) === alvo) ?? null;
  return { book: b, itensDb: b ? await itensDoLivro(b.id) : [] };
}

/** Valida envelope inteiro e calcula diff de cada livro — SEM gravar. */
async function processarEnvelope(body: unknown): Promise<{ ok: true; livros: LivroProcessado[] } | { ok: false; erro: string; detalhes?: unknown }> {
  const parsed = envelopeImportacaoSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, erro: "Envelope inválido", detalhes: parsed.error.issues.slice(0, 20) };
  }
  for (const [li, livro] of parsed.data.livros.entries()) {
    for (const [ii, item] of livro.itens.entries()) {
      if (JSON.stringify(item.definition ?? {}).length > TAM_MAX_DEFINITION) {
        return { ok: false, erro: `Livro ${li} item ${ii} (${item.kind}:${item.key}): definition excede 64KB` };
      }
    }
    const dup = duplicadosKindKey(livro.itens);
    if (dup) return { ok: false, erro: `Livro "${livro.titulo}": item duplicado ${dup}` };
  }
  const livros: LivroProcessado[] = [];
  const destinos = new Set<string>();
  for (const entrada of parsed.data.livros) {
    const { book, itensDb } = await resolverLivro(entrada);
    // O mesmo livro não pode aparecer duas vezes no envelope: além de gerar
    // snapshots redundantes, as duas aplicações partiriam da mesma versão
    // e poderiam sobrescrever uma à outra dentro da mesma transação.
    const destino = book ? `id:${book.id}` : `novo:${normTitulo(entrada.titulo)}`;
    if (destinos.has(destino)) {
      return { ok: false, erro: `Livro duplicado no envelope: "${entrada.titulo}"` };
    }
    destinos.add(destino);
    livros.push({ entrada, existente: book, itensDb, diff: diffLivro(entrada, book, itensDb) });
  }
  return { ok: true, livros };
}

/** Recalcula o destino e o diff usando exclusivamente leituras da transação de confirmação. */
function processarEnvelopeTx(tx: Tx, body: unknown): { ok: true; livros: LivroProcessado[] } | { ok: false; erro: string; detalhes?: unknown } {
  const parsed = envelopeImportacaoSchema.safeParse(body);
  if (!parsed.success) return { ok: false, erro: "Envelope inválido", detalhes: parsed.error.issues.slice(0, 20) };
  const livros: LivroProcessado[] = [];
  const destinos = new Set<string>();
  const ativos = tx.select().from(ruleBooks).where(isNull(ruleBooks.excluidoEm)).all();
  for (const [li, entrada] of parsed.data.livros.entries()) {
    for (const [ii, item] of entrada.itens.entries()) {
      if (JSON.stringify(item.definition ?? {}).length > TAM_MAX_DEFINITION)
        return { ok: false, erro: `Livro ${li} item ${ii} (${item.kind}:${item.key}): definition excede 64KB` };
    }
    const dup = duplicadosKindKey(entrada.itens);
    if (dup) return { ok: false, erro: `Livro "${entrada.titulo}": item duplicado ${dup}` };
    let book = entrada.id ? ativos.find((x) => x.id === entrada.id) ?? null : null;
    if (!book) {
      const alvo = normTitulo(entrada.titulo);
      book = ativos.find((x) => normTitulo(x.titulo) === alvo) ?? null;
    }
    const itensDb: ItemDb[] = book
      ? tx.select().from(ruleBookItems).where(eq(ruleBookItems.bookId, book.id)).all().map((i) => ({
          id: i.id, kind: i.kind, key: i.key, name: i.name,
          category: i.category, parentKey: i.parentKey, definition: i.definition, ordem: i.ordem,
        }))
      : [];
    const destino = book ? `id:${book.id}` : `novo:${normTitulo(entrada.titulo)}`;
    if (destinos.has(destino)) return { ok: false, erro: `Livro duplicado no envelope: "${entrada.titulo}"` };
    destinos.add(destino);
    livros.push({ entrada, existente: book, itensDb, diff: diffLivro(entrada, book, itensDb) });
  }
  return { ok: true, livros };
}

function previewDe(p: LivroProcessado, indice: number) {
  return {
    indice,
    titulo: p.entrada.titulo,
    acao: p.diff.acao,
    bookId: p.diff.bookId,
    metadadosAlterados: p.diff.metadadosAlterados,
    resumo: {
      itensNovos: p.diff.itensNovos.length,
      itensAlterados: p.diff.itensAlterados.length,
      itensIdenticos: p.diff.itensIdenticos,
      itensAusentesPreservados: p.diff.itensAusentesPreservados,
    },
    conflitos: p.diff.conflitos,
    aviso: p.diff.acao === "atualizar"
      ? "Itens ausentes no arquivo serão preservados. Conflitos só são aplicados com decisão explícita."
      : "Livro novo — todos os itens serão adicionados.",
  };
}

/** POST /api/biblioteca/importar/previa — valida e mostra o diff, sem gravar. */
bibliotecaRouter.post("/importar/previa", requireAdmin, async (req, res) => {
  const r = await processarEnvelope(req.body);
  if (!r.ok) { res.status(400).json(r); return; }
  res.json({
    formato: FORMATO_ACERVO,
    versao: VERSAO_FORMATO,
    totalLivros: r.livros.length,
    novos: r.livros.filter((p) => p.diff.acao === "novo").length,
    atualizacoes: r.livros.filter((p) => p.diff.acao === "atualizar").length,
    livros: r.livros.map(previewDe),
  });
});

type Decisao = { metadados: "atualizar" | "manter"; itens: Record<string, "atualizar" | "manter"> };

/** Aplica um livro processado dentro da transação (snapshot + merge). */
function aplicarLivro(tx: Tx, p: LivroProcessado, dec: Decisao | undefined, t: Date): { bookId: string; acao: "criado" | "atualizado"; adicionados: number; atualizados: number } {
  let bookId = p.diff.bookId;

  if (!bookId) {
    const novoBookId = novoId();
    bookId = novoBookId;
    tx.insert(ruleBooks).values({
      id: novoBookId,
      titulo: p.entrada.titulo,
      descricao: p.entrada.descricao ?? null,
      autor: p.entrada.autor ?? null,
      sistema: p.entrada.sistema ?? null,
      edicao: p.entrada.edicao ?? null,
      tipo: p.entrada.tipo ?? "livro",
      versao: 1,
      formatoVersao: VERSAO_FORMATO,
      origem: "importado",
      createdAt: t,
      updatedAt: t,
    }).run();
    p.entrada.itens.forEach((it, i) => {
      tx.insert(ruleBookItems).values({
        id: novoId(), bookId: novoBookId, kind: it.kind, key: it.key, name: it.name,
        category: it.category ?? null, parentKey: it.parentKey ?? null,
        definition: it.definition ?? {}, ordem: it.ordem ?? i,
        createdAt: t, updatedAt: t,
      }).run();
    });
    return { bookId: novoBookId, acao: "criado", adicionados: p.entrada.itens.length, atualizados: 0 };
  }
  const bid = bookId; // narrowing de `let` não sobrevive a closures

  const mapaDb = new Map(p.itensDb.map((i) => [chaveConflito(i.kind, i.key), i]));

  // Metadados: só com decisão explícita "atualizar" E diferença real.
  const atualizaMeta = dec?.metadados === "atualizar" && p.diff.metadadosAlterados.length > 0;
  const e = p.entrada;
  let adicionados = 0, atualizados = 0, alterou = atualizaMeta;

  // Conflitos que realmente serão aplicados (decisão + conteúdo divergente).
  const conflitosAplicados = new Set(
    p.diff.itensAlterados
      .filter((it) => {
        const ck = chaveConflito(it.kind, it.key);
        const dbItem = mapaDb.get(ck);
        return dec?.itens?.[ck] === "atualizar" && dbItem != null && !mesmoItem(it, dbItem);
      })
      .map((it) => chaveConflito(it.kind, it.key))
  );

  // Nada muda de fato? Nem backup nem versão — igual ao PATCH no-op.
  if (!atualizaMeta && p.diff.itensNovos.length === 0 && conflitosAplicados.size === 0) {
    return { bookId: bid, acao: "atualizado", adicionados: 0, atualizados: 0 };
  }

  // Livro existente com alteração real: snapshot completo ANTES (mesma tx).
  const snapshot = livroParaEnvelope(
    { ...p.existente!, formatoVersao: p.existente!.formatoVersao ?? VERSAO_FORMATO },
    p.itensDb
  );
  tx.insert(ruleBookBackups).values({
    id: novoId(), bookId: bid,
    snapshot: { formato: FORMATO_ACERVO, versao: VERSAO_FORMATO, livros: [snapshot] },
    motivo: "antes da importação",
    createdAt: t,
  }).run();

  if (atualizaMeta) {
    tx.update(ruleBooks).set({
      titulo: e.titulo,
      descricao: e.descricao ?? null,
      autor: e.autor ?? null,
      sistema: e.sistema ?? null,
      edicao: e.edicao ?? null,
      tipo: e.tipo ?? "livro",
      formatoVersao: VERSAO_FORMATO,
      origem: "importado",
      updatedAt: t,
    }).where(eq(ruleBooks.id, bid)).run();
  }

  for (const it of e.itens) {
    const ck = chaveConflito(it.kind, it.key);
    const dbItem = mapaDb.get(ck);
    if (!dbItem) {
      tx.insert(ruleBookItems).values({
        id: novoId(), bookId: bid, kind: it.kind, key: it.key, name: it.name,
        category: it.category ?? null, parentKey: it.parentKey ?? null,
        definition: it.definition ?? {}, ordem: it.ordem ?? 0,
        createdAt: t, updatedAt: t,
      }).run();
      adicionados++; alterou = true;
      continue;
    }
    // Idêntico → mantém. Conflito → só atualiza com decisão "atualizar".
    if (conflitosAplicados.has(ck) && !mesmoItem(it, dbItem)) {
      tx.update(ruleBookItems).set({
        name: it.name,
        category: it.category ?? null,
        parentKey: it.parentKey ?? null,
        definition: it.definition ?? {},
        ordem: it.ordem ?? dbItem.ordem,
        updatedAt: t,
      }).where(eq(ruleBookItems.id, dbItem.id)).run();
      atualizados++; alterou = true;
    }
  }

  if (alterou) {
    tx.update(ruleBooks).set({
      versao: (p.existente!.versao ?? 1) + 1,
      formatoVersao: VERSAO_FORMATO,
      origem: "importado",
      updatedAt: t,
    }).where(eq(ruleBooks.id, bid)).run();
  }
  return { bookId: bid, acao: "atualizado", adicionados, atualizados };
}

/**
 * POST /api/biblioteca/importar/confirmar — recebe { envelope, decisoes }.
 * O envelope é revalidado por completo no servidor (não confia na prévia).
 * Sem decisão explícita, conflitos e metadados ficam "manter" — nada é
 * sobrescrito silenciosamente.
 */
bibliotecaRouter.post("/importar/confirmar", requireAdmin, async (req, res) => {
  const body = req.body as { envelope?: unknown; decisoes?: unknown } | undefined;
  const decParse = decisoesImportacaoSchema.safeParse(body?.decisoes ?? { decisoes: [] });
  if (!decParse.success) { res.status(400).json({ erro: "Decisões inválidas", detalhes: decParse.error.issues }); return; }
  const decisoes = new Map(decParse.data.decisoes.map((d) => [d.indice, d as Decisao]));
  const t = agora();
  const resultados: { indice: number; titulo: string; acao: string; bookId: string; adicionados: number; atualizados: number }[] = [];
  const estado = { falhaValidacao: null as { erro: string; detalhes?: unknown } | null };
  try {
    db.transaction((tx) => {
      // A prévia pode ficar obsoleta enquanto o usuário decide. Resolver
      // destinos, reler itens e recalcular diffs imediatamente antes de aplicar.
      const r = processarEnvelopeTx(tx, body?.envelope);
      if (!r.ok) { estado.falhaValidacao = { erro: r.erro, detalhes: r.detalhes }; return; }
      r.livros.forEach((p, indice) => {
        const res2 = aplicarLivro(tx, p, decisoes.get(indice), t);
        resultados.push({ indice, titulo: p.entrada.titulo, ...res2 });
      });
    });
  } catch (e) {
    res.status(500).json({ erro: "Falha na importação — nada foi gravado", detalhe: e instanceof Error ? e.message : String(e) });
    return;
  }
  if (estado.falhaValidacao) { res.status(400).json({ erro: estado.falhaValidacao.erro, detalhes: estado.falhaValidacao.detalhes }); return; }
  await audit(req, "biblioteca.importar", { livros: resultados.length, usuario: req.usuario!.username });
  res.json({ ok: true, resultados });
});

// ---------- Exportação ----------

/** GET /api/biblioteca/exportar — acervo completo no envelope oficial.
 *  Livros excluídos (soft delete) não entram na exportação. */
bibliotecaRouter.get("/exportar", async (_req, res) => {
  const livros = await db.select().from(ruleBooks).where(isNull(ruleBooks.excluidoEm)).orderBy(asc(ruleBooks.titulo));
  const itens = await db.select().from(ruleBookItems);
  const porLivro = new Map<string, ItemDb[]>();
  for (const i of itens) {
    const arr = porLivro.get(i.bookId) ?? [];
    arr.push({ id: i.id, kind: i.kind, key: i.key, name: i.name, category: i.category, parentKey: i.parentKey, definition: i.definition, ordem: i.ordem });
    porLivro.set(i.bookId, arr);
  }
  const envelope = {
    formato: FORMATO_ACERVO,
    versao: VERSAO_FORMATO,
    exportadoEm: new Date().toISOString(),
    livros: livros.map((b) => livroParaEnvelope(b, porLivro.get(b.id) ?? [])),
  };
  res.setHeader("content-disposition", `attachment; filename="acervo-regras-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(envelope);
});

/** GET /api/biblioteca/livros/:id/exportar — livro único (livro ou suplemento). */
bibliotecaRouter.get("/livros/:id/exportar", async (req, res) => {
  const b = await livroPorId(req.params.id);
  if (!b) { res.status(404).json({ erro: "Livro não encontrado" }); return; }
  const env = livroParaEnvelope(b, await itensDoLivro(b.id));
  res.setHeader("content-disposition", `attachment; filename="${env.titulo.replace(/[^\w-]+/g, "_")}.json"`);
  res.json({ formato: FORMATO_ACERVO, versao: VERSAO_FORMATO, exportadoEm: new Date().toISOString(), livros: [env] });
});

// ---------- Backups e restauração ----------

/** GET /api/biblioteca/livros/:id/backups — histórico de snapshots.
 *  Funciona também para livros excluídos (o histórico é justamente o que
 *  se quer preservar); admin-only implícito via requireAdmin nas mutações,
 *  mas a consulta segue a regra de leitura do acervo. */
bibliotecaRouter.get("/livros/:id/backups", async (req, res) => {
  const b = await livroPorIdQualquer(req.params.id);
  if (!b || (b.excluidoEm && !req.usuario?.isAdmin)) { res.status(404).json({ erro: "Livro não encontrado" }); return; }
  const rows = await db.select().from(ruleBookBackups).where(eq(ruleBookBackups.bookId, b.id)).orderBy(desc(ruleBookBackups.createdAt));
  res.json({
    backups: rows.map((r) => {
      const snap = r.snapshot as { livros?: { itens?: unknown[] }[] };
      return { id: r.id, motivo: r.motivo, createdAt: r.createdAt, itens: snap?.livros?.[0]?.itens?.length ?? 0 };
    }),
  });
});

/** GET /api/biblioteca/backups/:backupId — snapshot completo. */
bibliotecaRouter.get("/backups/:backupId", async (req, res) => {
  const [r] = await db.select().from(ruleBookBackups).where(eq(ruleBookBackups.id, req.params.backupId)).limit(1);
  if (!r) { res.status(404).json({ erro: "Backup não encontrado" }); return; }
  const livro = await livroPorIdQualquer(r.bookId);
  if (!livro || (livro.excluidoEm && !req.usuario?.isAdmin)) {
    res.status(404).json({ erro: "Backup não encontrado" }); return;
  }
  res.json({ backup: { id: r.id, bookId: r.bookId, motivo: r.motivo, createdAt: r.createdAt, snapshot: r.snapshot } });
});

interface SnapshotLivro {
  titulo?: string;
  descricao?: string | null;
  autor?: string | null;
  sistema?: string | null;
  edicao?: string | null;
  tipo?: string;
  itens?: { kind: string; key: string; name: string; category?: string | null; parentKey?: string | null; definition?: Record<string, unknown>; ordem?: number }[];
}

/**
 * POST /api/biblioteca/backups/:backupId/restaurar — restaura snapshot.
 * Gera backup do estado atual ANTES de substituir; tudo numa transação.
 */
bibliotecaRouter.post("/backups/:backupId/restaurar", requireAdmin, async (req, res) => {
  let falha: "backup" | "livro" | "snapshot" | null = null;
  let bookId: string | null = null;
  let backupId: string | null = null;
  try {
    db.transaction((tx) => {
      // Releitura de backup, livro e itens dentro da mesma transação:
      // o snapshot de segurança precisa representar o estado imediatamente
      // anterior à restauração, não uma leitura feita antes do BEGIN.
      const backup = tx.select().from(ruleBookBackups)
        .where(eq(ruleBookBackups.id, req.params.backupId)).limit(1).get();
      if (!backup) { falha = "backup"; return; }
      const b = tx.select().from(ruleBooks)
        .where(eq(ruleBooks.id, backup.bookId)).limit(1).get();
      if (!b || b.excluidoEm) { falha = "livro"; return; }
      const snap = backup.snapshot as { livros?: SnapshotLivro[] };
      const livroSnap = snap?.livros?.[0];
      if (!livroSnap) { falha = "snapshot"; return; }

      bookId = b.id;
      backupId = backup.id;
      const itensAtuais = tx.select().from(ruleBookItems)
        .where(eq(ruleBookItems.bookId, b.id)).all();
      const itens: ItemDb[] = itensAtuais.map((r) => ({
        id: r.id, kind: r.kind, key: r.key, name: r.name,
        category: r.category, parentKey: r.parentKey,
        definition: r.definition, ordem: r.ordem,
      }));
      const t = agora();
      tx.insert(ruleBookBackups).values({
        id: novoId(), bookId: b.id,
        snapshot: { formato: FORMATO_ACERVO, versao: VERSAO_FORMATO, livros: [livroParaEnvelope({ ...b, formatoVersao: b.formatoVersao ?? VERSAO_FORMATO }, itens)] },
        motivo: `antes da restauração do backup ${backup.id}`,
        createdAt: t,
      }).run();
      tx.update(ruleBooks).set({
        titulo: livroSnap.titulo ?? b.titulo,
        descricao: livroSnap.descricao ?? null,
        autor: livroSnap.autor ?? null,
        sistema: livroSnap.sistema ?? null,
        edicao: livroSnap.edicao ?? null,
        tipo: livroSnap.tipo === "suplemento" ? "suplemento" : "livro",
        versao: (b.versao ?? 1) + 1,
        formatoVersao: VERSAO_FORMATO,
        origem: "importado",
        updatedAt: t,
      }).where(eq(ruleBooks.id, b.id)).run();
      tx.delete(ruleBookItems).where(eq(ruleBookItems.bookId, b.id)).run();
      (livroSnap.itens ?? []).forEach((it, i) => {
        tx.insert(ruleBookItems).values({
          id: novoId(), bookId: b.id, kind: it.kind, key: it.key, name: it.name,
          category: it.category ?? null, parentKey: it.parentKey ?? null,
          definition: it.definition ?? {}, ordem: it.ordem ?? i,
          createdAt: t, updatedAt: t,
        }).run();
      });
    });
  } catch (e) {
    res.status(500).json({ erro: "Falha na restauração — nada foi alterado", detalhe: e instanceof Error ? e.message : String(e) });
    return;
  }
  if (falha === "backup") { res.status(404).json({ erro: "Backup não encontrado" }); return; }
  if (falha === "livro") { res.status(404).json({ erro: "Livro não encontrado" }); return; }
  if (falha === "snapshot") { res.status(400).json({ erro: "Snapshot inválido" }); return; }
  if (!bookId || !backupId) { res.status(500).json({ erro: "Falha inesperada na restauração" }); return; }
  await audit(req, "biblioteca.backup.restaurado", { bookId, backupId });
  res.json({ ok: true });
});
