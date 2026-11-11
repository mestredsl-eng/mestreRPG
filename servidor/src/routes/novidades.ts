import { Router } from "express";
import { eq, and, desc, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { novidades, novidadesLeituras } from "../db/schema.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { audit } from "../lib/audit.js";

const db = getDb();

const CATEGORIAS = ["novidade", "melhoria", "correcao"] as const;
const ESTADOS = ["rascunho", "publicada"] as const;

const novidadeSchema = z.object({
  titulo: z.string().min(1).max(140),
  resumo: z.string().max(300).nullish(),
  conteudo: z.string().max(20000).optional(),
  versao: z.string().max(40).nullish(),
  categoria: z.enum(CATEGORIAS).optional(),
  estado: z.enum(ESTADOS).optional(),
});

const atualizarSchema = novidadeSchema.partial();

// Campos apresentados ao usuário — alteração efetiva neles torna a
// publicação uma "nova versão" e invalida as leituras anteriores.
const CAMPOS_CONTEUDO = ["titulo", "resumo", "conteudo", "versao", "categoria"] as const;
const normTexto = (v: string | null | undefined) => {
  const s = (v ?? "").trim();
  return s === "" ? null : s;
};
function conteudoAlterado(
  atual: typeof novidades.$inferSelect,
  d: Partial<z.infer<typeof novidadeSchema>>
): boolean {
  return CAMPOS_CONTEUDO.some((k) => {
    if (d[k] === undefined) return false;
    const novo = k === "resumo" || k === "versao" ? normTexto(d[k] as string | null) : d[k];
    const velho = k === "resumo" || k === "versao" ? normTexto(atual[k] as string | null) : atual[k];
    return novo !== velho;
  });
}

function publico(n: typeof novidades.$inferSelect, lida = false) {
  return {
    id: n.id,
    titulo: n.titulo,
    resumo: n.resumo,
    conteudo: n.conteudo,
    versao: n.versao,
    categoria: n.categoria,
    estado: n.estado,
    publicadoEm: n.publicadoEm,
    criadoEm: n.createdAt,
    lida,
  };
}

/** Publicadas visíveis ao usuário + flag de leitura + contador de não lidas. */
async function listarPublicadas(userId: string) {
  const rows = await db
    .select({ n: novidades, lidaEm: novidadesLeituras.lidaEm })
    .from(novidades)
    .leftJoin(novidadesLeituras, and(eq(novidadesLeituras.novidadeId, novidades.id), eq(novidadesLeituras.userId, userId)))
    .where(eq(novidades.estado, "publicada"))
    .orderBy(desc(novidades.publicadoEm), desc(novidades.createdAt));
  const lista = rows.map((r) => publico(r.n, r.lidaEm != null));
  return { lista, naoLidas: lista.filter((n) => !n.lida).length };
}

// ==================== Central do usuário (requireAuth) ====================
export const novidadesRouter = Router();
novidadesRouter.use(requireAuth);

/** GET /api/novidades — somente publicadas, mais recentes primeiro. */
novidadesRouter.get("/", async (req, res) => {
  const { lista, naoLidas } = await listarPublicadas(req.usuario!.id);
  res.json({ novidades: lista, naoLidas });
});

/** GET /api/novidades/nao-lidas — contador leve para o menu. */
novidadesRouter.get("/nao-lidas", async (req, res) => {
  const { naoLidas } = await listarPublicadas(req.usuario!.id);
  res.json({ naoLidas });
});

/** GET /api/novidades/:id — detalhe; rascunho/inexistente → 404 (não vaza). */
novidadesRouter.get("/:id", async (req, res) => {
  const [row] = await db
    .select({ n: novidades, lidaEm: novidadesLeituras.lidaEm })
    .from(novidades)
    .leftJoin(novidadesLeituras, and(eq(novidadesLeituras.novidadeId, novidades.id), eq(novidadesLeituras.userId, req.usuario!.id)))
    .where(and(eq(novidades.id, req.params.id), eq(novidades.estado, "publicada")))
    .limit(1);
  if (!row) {
    res.status(404).json({ erro: "Publicação não encontrada" });
    return;
  }
  res.json({ novidade: publico(row.n, row.lidaEm != null) });
});

/**
 * POST /api/novidades/:id/lida — marca como lida SOMENTE o usuário da
 * sessão. Publicação precisa existir e estar publicada. INSERT OR IGNORE
 * + índice único → idempotente e seguro sob concorrência.
 */
novidadesRouter.post("/:id/lida", async (req, res) => {
  const [pub] = await db
    .select({ id: novidades.id })
    .from(novidades)
    .where(and(eq(novidades.id, req.params.id), eq(novidades.estado, "publicada")))
    .limit(1);
  if (!pub) {
    res.status(404).json({ erro: "Publicação não encontrada" });
    return;
  }
  await db.run(sql`insert or ignore into novidade_leituras (id, novidade_id, user_id, lida_em) values (${crypto.randomUUID()}, ${pub.id}, ${req.usuario!.id}, ${Date.now()})`);
  res.json({ ok: true });
});

// ==================== Administração (requireAdmin) ====================
export const novidadesAdminRouter = Router();
novidadesAdminRouter.use(requireAdmin);

/** GET /api/admin/novidades — todas, incluindo rascunhos. */
novidadesAdminRouter.get("/", async (_req, res) => {
  const rows = await db
    .select({
      n: novidades,
      leituras: sql<number>`(select count(*) from novidade_leituras l where l.novidade_id = "novidades"."id")`,
    })
    .from(novidades)
    .orderBy(desc(novidades.publicadoEm), desc(novidades.createdAt));
  res.json({ novidades: rows.map((r) => ({ ...publico(r.n), leituras: r.leituras })) });
});

/** GET /api/admin/novidades/:id — detalhe para edição (inclui rascunho). */
novidadesAdminRouter.get("/:id", async (req, res) => {
  const [n] = await db.select().from(novidades).where(eq(novidades.id, req.params.id)).limit(1);
  if (!n) {
    res.status(404).json({ erro: "Publicação não encontrada" });
    return;
  }
  res.json({ novidade: publico(n) });
});

/** POST /api/admin/novidades — cria (rascunho por padrão). */
novidadesAdminRouter.post("/", async (req, res) => {
  const body = novidadeSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues });
    return;
  }
  const d = body.data;
  const agora = new Date();
  const id = crypto.randomUUID();
  const publicada = d.estado === "publicada";
  await db.insert(novidades).values({
    id,
    titulo: d.titulo,
    resumo: d.resumo ?? null,
    conteudo: d.conteudo ?? "",
    versao: d.versao ?? null,
    categoria: d.categoria ?? "novidade",
    estado: d.estado ?? "rascunho",
    publicadoEm: publicada ? agora : null,
    autorId: req.usuario!.id,
    createdAt: agora,
    updatedAt: agora,
  });
  const [criada] = await db.select().from(novidades).where(eq(novidades.id, id)).limit(1);
  await audit(req, "novidade.criada", { novidadeId: id, titulo: d.titulo });
  res.status(201).json({ novidade: publico(criada) });
});

/** PATCH /api/admin/novidades/:id — edita campos; publicar via PATCH também funciona. */
novidadesAdminRouter.patch("/:id", async (req, res) => {
  const body = atualizarSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues });
    return;
  }
  const [atual] = await db.select().from(novidades).where(eq(novidades.id, req.params.id)).limit(1);
  if (!atual) {
    res.status(404).json({ erro: "Publicação não encontrada" });
    return;
  }
  const d = body.data;
  const dados: Partial<typeof novidades.$inferInsert> = { updatedAt: new Date() };
  if (d.titulo !== undefined) dados.titulo = d.titulo;
  if (d.resumo !== undefined) dados.resumo = d.resumo ?? null;
  if (d.conteudo !== undefined) dados.conteudo = d.conteudo;
  if (d.versao !== undefined) dados.versao = d.versao ?? null;
  if (d.categoria !== undefined) dados.categoria = d.categoria;
  if (d.estado !== undefined) {
    dados.estado = d.estado;
    // publicar → carimba data; despublicar → mantém a data original para histórico
    if (d.estado === "publicada" && atual.estado !== "publicada") dados.publicadoEm = new Date();
    if (d.estado === "rascunho" && atual.estado === "publicada") dados.publicadoEm = null;
  }
  const invalidar = conteudoAlterado(atual, d);
  // Atualização + invalidação de leituras na MESMA transação: nunca
  // fica conteúdo novo com leituras velhas (nem o contrário).
  db.transaction((tx) => {
    tx.update(novidades).set(dados).where(eq(novidades.id, atual.id)).run();
    if (invalidar) {
      tx.delete(novidadesLeituras).where(eq(novidadesLeituras.novidadeId, atual.id)).run();
    }
  });
  const [atualizada] = await db.select().from(novidades).where(eq(novidades.id, atual.id)).limit(1);
  await audit(req, "novidade.atualizada", { novidadeId: atual.id, campos: Object.keys(d), leiturasInvalidas: invalidar });
  res.json({ novidade: publico(atualizada), leiturasInvalidas: invalidar });
});

/** POST /api/admin/novidades/:id/publicar — rascunho → publicada (idempotente). */
novidadesAdminRouter.post("/:id/publicar", async (req, res) => {
  const [atual] = await db.select().from(novidades).where(eq(novidades.id, req.params.id)).limit(1);
  if (!atual) {
    res.status(404).json({ erro: "Publicação não encontrada" });
    return;
  }
  // Já publicada → não toca em publicadoEm nem gera transição fictícia
  // na auditoria; a ordenação da central permanece estável.
  if (atual.estado === "publicada") {
    res.json({ novidade: publico(atual) });
    return;
  }
  await db.update(novidades).set({ estado: "publicada", publicadoEm: new Date(), updatedAt: new Date() }).where(eq(novidades.id, atual.id));
  const [pub] = await db.select().from(novidades).where(eq(novidades.id, atual.id)).limit(1);
  await audit(req, "novidade.publicada", { novidadeId: atual.id });
  res.json({ novidade: publico(pub) });
});

/** POST /api/admin/novidades/:id/despublicar — publicada → rascunho (idempotente). */
novidadesAdminRouter.post("/:id/despublicar", async (req, res) => {
  const [atual] = await db.select().from(novidades).where(eq(novidades.id, req.params.id)).limit(1);
  if (!atual) {
    res.status(404).json({ erro: "Publicação não encontrada" });
    return;
  }
  if (atual.estado === "rascunho") {
    res.json({ novidade: publico(atual) });
    return;
  }
  await db.update(novidades).set({ estado: "rascunho", publicadoEm: null, updatedAt: new Date() }).where(eq(novidades.id, atual.id));
  const [rasc] = await db.select().from(novidades).where(eq(novidades.id, atual.id)).limit(1);
  await audit(req, "novidade.despublicada", { novidadeId: atual.id });
  res.json({ novidade: publico(rasc) });
});

/** DELETE /api/admin/novidades/:id — remove; leituras caem por ON DELETE CASCADE. */
novidadesAdminRouter.delete("/:id", async (req, res) => {
  const [atual] = await db.select({ id: novidades.id }).from(novidades).where(eq(novidades.id, req.params.id)).limit(1);
  if (!atual) {
    res.status(404).json({ erro: "Publicação não encontrada" });
    return;
  }
  await db.delete(novidades).where(eq(novidades.id, atual.id));
  await audit(req, "novidade.removida", { novidadeId: atual.id });
  res.json({ ok: true });
});
