import { Router } from "express";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { notes, memberships, users, characters, files, noteAttachments } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePapel } from "../lib/permissoes.js";
import { carregarRegras } from "../lib/regras.js";
import { audit } from "../lib/audit.js";
import { emitirCampanha } from "../lib/io.js";
import { arquivoVisivel } from "./arquivos.js";
import { somenteEnviados } from "../lib/parcial.js";

const db = getDb();
export const anotacoesRouter = Router({ mergeParams: true });
anotacoesRouter.use(requireAuth);

type Nota = typeof notes.$inferSelect;

/** Visibilidade de uma anotação para o requisitante (spec §2/§3/§10). */
function notaVisivel(n: Nota, usuarioId: string, ehMestre: boolean): boolean {
  if (n.ownerId === usuarioId) return true;
  if (n.visibility === "privada") return false;
  if (n.visibility === "mestre") return ehMestre;
  if (n.visibility === "publica") return true;
  const recips = (n.recipients ?? []) as string[];
  return recips.includes(usuarioId);
}

async function nomesOwners(ids: string[]) {
  if (!ids.length) return new Map<string, { username: string; displayName: string | null }>();
  const rows = await db.select({ id: users.id, username: users.username, displayName: users.displayName }).from(users).where(inArray(users.id, ids));
  return new Map(rows.map((r) => [r.id, r]));
}

/** Anexos das notas visíveis ao requisitante — filtrados pela visibilidade do ARQUIVO também. */
async function anexosPorNota(noteIds: string[], usuarioId: string, ehMestre: boolean, membershipIds: Set<string>) {
  const mapa = new Map<string, { id: string; fileId: string; fileName: string; displayName: string; mimeType: string | null; sizeBytes: number | null }[]>();
  if (!noteIds.length) return mapa;
  const rows = await db.select({ att: noteAttachments, file: files })
    .from(noteAttachments)
    .innerJoin(files, eq(noteAttachments.fileId, files.id))
    .where(inArray(noteAttachments.noteId, noteIds));
  for (const { att, file } of rows) {
    if (!arquivoVisivel(file, usuarioId, ehMestre, membershipIds)) continue;
    const lista = mapa.get(att.noteId) ?? [];
    lista.push({
      id: att.id, fileId: file.id,
      fileName: file.fileName, displayName: file.displayName ?? file.fileName,
      mimeType: file.mimeType, sizeBytes: file.sizeBytes,
    });
    mapa.set(att.noteId, lista);
  }
  return mapa;
}

async function validarDestinatarios(campaignId: string, recipients: string[] | undefined): Promise<string[] | null> {
  if (!recipients?.length) return [];
  const validos = await db.select({ userId: memberships.userId }).from(memberships)
    .where(and(eq(memberships.campaignId, campaignId), eq(memberships.status, "ativo"), inArray(memberships.userId, recipients)));
  const set = new Set(validos.map((v) => v.userId));
  const invalidos = recipients.filter((r) => !set.has(r));
  return invalidos.length ? null : recipients;
}

const notaSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().max(50000).default(""),
  category: z.string().max(120).optional(),
  characterId: z.string().optional(),
  kind: z.enum(["diario", "mestre"]).default("diario"),
  visibility: z.enum(["privada", "mestre", "publica", "selecionada"]).default("privada"),
  recipients: z.array(z.string()).max(100).optional(),
  important: z.boolean().default(false),
  status: z.enum(["pendente", "concluida"]).optional(),
});

/** GET /api/campaigns/:campaignId/anotacoes?tipo=diario|mestre — visíveis ao requisitante */
anotacoesRouter.get("/", requirePapel("mestre", "jogador", "espectador"), async (req, res) => {
  const tipo = typeof req.query.tipo === "string" ? req.query.tipo : "todas";
  const cid = req.params.campaignId;
  const ehMestre = req.membership!.role === "mestre";
  const todas = await db.select().from(notes).where(eq(notes.campaignId, cid)).orderBy(desc(notes.updatedAt));
  const visiveis = todas.filter((n) => {
    if (tipo === "diario" && n.kind !== "diario") return false;
    if (tipo === "mestre" && n.kind !== "mestre") return false;
    return notaVisivel(n, req.usuario!.id, ehMestre);
  });
  const mapa = await nomesOwners([...new Set(visiveis.map((n) => n.ownerId))]);
  const membershipIds = new Set([req.usuario!.id, req.membership!.id]);
  const anexos = await anexosPorNota(visiveis.map((n) => n.id), req.usuario!.id, ehMestre, membershipIds);
  res.json({
    anotacoes: visiveis.map((n) => ({
      ...n,
      owner: mapa.get(n.ownerId) ?? null,
      ehMinha: n.ownerId === req.usuario!.id,
      anexos: anexos.get(n.id) ?? [],
    })),
  });
});

/** POST /api/campaigns/:campaignId/anotacoes */
anotacoesRouter.post("/", requirePapel("mestre", "jogador"), async (req, res) => {
  const body = notaSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues }); return; }
  const cid = req.params.campaignId;
  const papel = req.membership!.role;
  const d = body.data;

  if (d.kind === "mestre" && papel !== "mestre") {
    res.status(403).json({ erro: "Só o mestre cria anotações do mestre" }); return;
  }
  // Espectador não chega aqui (requirePapel). Jogador com characterId deve ser dono do personagem.
  if (d.characterId) {
    const [char] = await db.select().from(characters).where(and(eq(characters.id, d.characterId), eq(characters.campaignId, cid))).limit(1);
    if (!char) { res.status(400).json({ erro: "Personagem não encontrado" }); return; }
    if (papel !== "mestre") {
      const [md] = await db.select({ userId: memberships.userId }).from(memberships).where(eq(memberships.id, char.membershipId)).limit(1);
      if (md?.userId !== req.usuario!.id) { res.status(403).json({ erro: "Diário pertence a outro jogador" }); return; }
    }
  }
  // Compartilhamento pelo jogador depende da config da campanha
  if (papel !== "mestre" && d.visibility !== "privada") {
    const regras = await carregarRegras(cid);
    if (!regras.config.notas?.jogadorCompartilha) {
      res.status(403).json({ erro: "O mestre não permite compartilhamento de anotações nesta campanha" }); return;
    }
  }
  if (d.visibility === "selecionada") {
    const recips = await validarDestinatarios(cid, d.recipients);
    if (recips === null) { res.status(400).json({ erro: "Destinatários inválidos" }); return; }
    d.recipients = recips;
  } else {
    d.recipients = undefined;
  }
  const agora = new Date();
  const id = crypto.randomUUID();
  await db.insert(notes).values({
    id, campaignId: cid, ownerId: req.usuario!.id, characterId: d.characterId ?? null,
    kind: d.kind, category: d.category ?? null, title: d.title, content: d.content,
    important: d.important ? 1 : 0, visibility: d.visibility,
    recipients: d.recipients ?? null, status: d.status ?? "pendente",
    createdAt: agora, updatedAt: agora,
  });
  await audit(req, "anotacao.criada", { noteId: id, kind: d.kind, visibility: d.visibility });
  emitirCampanha(cid, "anotacoes:atualizadas", {});
  res.status(201).json({ id });
});

/** PATCH /api/campaigns/:campaignId/anotacoes/:noteId — só o dono edita */
anotacoesRouter.patch("/:noteId", requirePapel("mestre", "jogador"), async (req, res) => {
  const [n] = await db.select().from(notes).where(and(eq(notes.id, req.params.noteId), eq(notes.campaignId, req.params.campaignId))).limit(1);
  if (!n) { res.status(404).json({ erro: "Anotação não encontrada" }); return; }
  if (n.ownerId !== req.usuario!.id) { res.status(403).json({ erro: "Só o proprietário edita a anotação" }); return; }
  const body = notaSchema.partial().safeParse(req.body);
  if (!body.success) { res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues }); return; }
  const d = somenteEnviados(body.data, req.body);
  // revalida personagem ao trocar characterId
  if (d.characterId && d.characterId !== n.characterId) {
    const [char] = await db.select().from(characters).where(and(eq(characters.id, d.characterId), eq(characters.campaignId, req.params.campaignId))).limit(1);
    if (!char) { res.status(400).json({ erro: "Personagem não encontrado" }); return; }
    if (req.membership!.role !== "mestre") {
      const [md] = await db.select({ userId: memberships.userId }).from(memberships).where(eq(memberships.id, char.membershipId)).limit(1);
      if (md?.userId !== req.usuario!.id) { res.status(403).json({ erro: "Diário pertence a outro jogador" }); return; }
    }
  }
  // mudar visibilidade para compartilhada exige a mesma regra da criação
  if (req.membership!.role !== "mestre" && d.visibility && d.visibility !== "privada") {
    const regras = await carregarRegras(req.params.campaignId);
    if (!regras.config.notas?.jogadorCompartilha) {
      res.status(403).json({ erro: "Compartilhamento não permitido nesta campanha" }); return;
    }
  }
  let recips: string[] | null | undefined;
  if (d.visibility === "selecionada" || (d.recipients !== undefined && d.visibility !== "privada" && d.visibility !== "mestre" && d.visibility !== "publica")) {
    if (d.recipients !== undefined) {
      const validados = await validarDestinatarios(req.params.campaignId, d.recipients);
      if (validados === null) { res.status(400).json({ erro: "Destinatários inválidos" }); return; }
      recips = validados;
    }
  }
  await db.update(notes).set({
    title: d.title ?? n.title,
    content: d.content ?? n.content,
    category: d.category ?? n.category,
    characterId: d.characterId ?? n.characterId,
    kind: d.kind ?? n.kind,
    important: d.important !== undefined ? (d.important ? 1 : 0) : n.important,
    visibility: d.visibility ?? n.visibility,
    recipients: recips !== undefined ? recips : (d.visibility && d.visibility !== "selecionada" ? null : n.recipients),
    status: d.status ?? n.status,
    updatedAt: new Date(),
  }).where(eq(notes.id, n.id));
  await audit(req, "anotacao.atualizada", { noteId: n.id });
  emitirCampanha(req.params.campaignId, "anotacoes:atualizadas", {});
  res.json({ ok: true });
});

/** POST /api/campaigns/:campaignId/anotacoes/:noteId/anexos — anexa arquivo da biblioteca (Etapa 11) */
anotacoesRouter.post("/:noteId/anexos", requirePapel("mestre", "jogador"), async (req, res) => {
  const cid = req.params.campaignId;
  const [n] = await db.select().from(notes).where(and(eq(notes.id, req.params.noteId), eq(notes.campaignId, cid))).limit(1);
  if (!n) { res.status(404).json({ erro: "Anotação não encontrada" }); return; }
  if (n.ownerId !== req.usuario!.id && req.membership!.role !== "mestre") {
    res.status(403).json({ erro: "Só o dono da anotação anexa arquivos" }); return;
  }
  const fileId = typeof (req.body as { fileId?: string })?.fileId === "string" ? (req.body as { fileId: string }).fileId : null;
  if (!fileId) { res.status(400).json({ erro: "fileId obrigatório" }); return; }
  const [f] = await db.select().from(files).where(and(eq(files.id, fileId), eq(files.campaignId, cid))).limit(1);
  if (!f) { res.status(404).json({ erro: "Arquivo não encontrado" }); return; }
  // o requisitante precisa enxergar o arquivo para anexá-lo (não vaza arquivos privados alheios)
  const membershipIds = new Set([req.usuario!.id, req.membership!.id]);
  const ehMestre = req.membership!.role === "mestre";
  if (!arquivoVisivel(f, req.usuario!.id, ehMestre, membershipIds)) {
    res.status(403).json({ erro: "Sem permissão sobre este arquivo" }); return;
  }
  const id = crypto.randomUUID();
  await db.insert(noteAttachments).values({ id, noteId: n.id, fileId: f.id, createdBy: req.usuario!.id, createdAt: new Date() })
    .onConflictDoNothing();
  await audit(req, "anotacao.anexo_adicionado", { noteId: n.id, fileId: f.id });
  emitirCampanha(cid, "anotacoes:atualizadas", {});
  res.status(201).json({ id });
});

/** DELETE /api/campaigns/:campaignId/anotacoes/:noteId/anexos/:fileId — remove anexo */
anotacoesRouter.delete("/:noteId/anexos/:fileId", requirePapel("mestre", "jogador"), async (req, res) => {
  const cid = req.params.campaignId;
  const [n] = await db.select().from(notes).where(and(eq(notes.id, req.params.noteId), eq(notes.campaignId, cid))).limit(1);
  if (!n) { res.status(404).json({ erro: "Anotação não encontrada" }); return; }
  if (n.ownerId !== req.usuario!.id && req.membership!.role !== "mestre") {
    res.status(403).json({ erro: "Só o dono da anotação remove anexos" }); return;
  }
  const removidos = await db.delete(noteAttachments)
    .where(and(eq(noteAttachments.noteId, n.id), eq(noteAttachments.fileId, req.params.fileId)))
    .returning({ id: noteAttachments.id });
  if (!removidos.length) { res.status(404).json({ erro: "Anexo não encontrado" }); return; }
  await audit(req, "anotacao.anexo_removido", { noteId: n.id, fileId: req.params.fileId });
  emitirCampanha(cid, "anotacoes:atualizadas", {});
  res.json({ ok: true });
});

/** DELETE /api/campaigns/:campaignId/anotacoes/:noteId — só o dono */
anotacoesRouter.delete("/:noteId", requirePapel("mestre", "jogador"), async (req, res) => {
  const [n] = await db.select().from(notes).where(and(eq(notes.id, req.params.noteId), eq(notes.campaignId, req.params.campaignId))).limit(1);
  if (!n) { res.status(404).json({ erro: "Anotação não encontrada" }); return; }
  if (n.ownerId !== req.usuario!.id) { res.status(403).json({ erro: "Só o proprietário exclui a anotação" }); return; }
  await db.delete(notes).where(eq(notes.id, n.id));
  await audit(req, "anotacao.removida", { noteId: n.id });
  emitirCampanha(req.params.campaignId, "anotacoes:atualizadas", {});
  res.json({ ok: true });
});
