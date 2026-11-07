import express, { Router } from "express";
import { createReadStream, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { resolve, extname, sep } from "node:path";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, CAMINHOS } from "../db/index.js";
import { config } from "../config.js";
import { files, folders, memberships, users, notes, noteAttachments } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePapel, permissoesDe } from "../lib/permissoes.js";
import { carregarRegras } from "../lib/regras.js";
import { audit } from "../lib/audit.js";
import { emitirCampanha } from "../lib/io.js";

const db = getDb();
export const arquivosRouter = Router({ mergeParams: true });
arquivosRouter.use(requireAuth);

type Arquivo = typeof files.$inferSelect;
type Pasta = typeof folders.$inferSelect;

// ---------- constantes de segurança ----------
const EXT_PERMITIDAS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico",
  "pdf", "txt", "md", "csv", "json", "xml",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
  "mp3", "wav", "ogg", "m4a", "flac",
  "mp4", "webm", "mov", "mkv", "avi",
  "zip", "7z", "rar",
]);
const EXT_BLOQUEADAS = new Set([
  "exe", "dll", "msi", "bat", "cmd", "ps1", "vbs", "js", "jse", "wsf", "scr", "com", "pif",
  "reg", "lnk", "hta", "cpl", "jar", "app", "dmg", "pkg", "deb", "rpm", "run", "sh", "bash",
  "sys", "drv", "iso", "img", "swf", "html", "htm", "svg",
]);
const MIMES_PERIGOSOS = /javascript|ecmascript|x-msdownload|x-sh/i;

function extensaoSegura(nome: string): string {
  const ext = extname(nome).slice(1).toLowerCase().replace(/[^a-z0-9]/g, "");
  return ext.slice(0, 10);
}

function formatoPermitido(ext: string, extras: string[]): boolean {
  const e = ext.toLowerCase();
  if (EXT_BLOQUEADAS.has(e)) return false;
  if (MIMES_PERIGOSOS.test(e)) return false;
  return EXT_PERMITIDAS.has(e) || extras.map((x) => x.toLowerCase().replace(/^\./, "")).includes(e);
}

function dirCampanha(cid: string) {
  return resolve(CAMINHOS.arquivos, cid);
}
function caminhoFisico(cid: string, storageName: string) {
  const base = dirCampanha(cid);
  const p = resolve(base, storageName);
  return p.startsWith(base + sep) || p === base ? p : null;
}
function caminhoLixeira(cid: string, storageName: string) {
  return resolve(dirCampanha(cid), ".lixeira", storageName);
}
function garantirDir(cid: string) {
  mkdirSync(dirCampanha(cid), { recursive: true });
  mkdirSync(resolve(dirCampanha(cid), ".lixeira"), { recursive: true });
}

export function arquivoVisivel(f: Arquivo, usuarioId: string, ehMestre: boolean, membershipIds: Set<string>): boolean {
  if (f.status === "pendente" || f.status === "rejeitado") return f.uploadedBy === usuarioId || ehMestre;
  if (f.visibility === "mestre") return ehMestre;
  if (f.visibility === "publica") return true;
  const recips = (f.recipients ?? []) as string[];
  return recips.includes(usuarioId) || recips.some((r) => membershipIds.has(r));
}

function arquivoSerializavel(f: Arquivo, mapaUsers: Map<string, { username: string; displayName: string | null }>) {
  const u = mapaUsers.get(f.uploadedBy);
  return {
    id: f.id, folderId: f.folderId, folderPath: f.folderPath,
    fileName: f.fileName, displayName: f.displayName ?? f.fileName,
    description: f.description, category: f.category,
    mimeType: f.mimeType, sizeBytes: f.sizeBytes, status: f.status,
    visibility: f.visibility, recipients: f.recipients,
    uploadedBy: f.uploadedBy, uploader: u ? { username: u.username, displayName: u.displayName } : null,
    ehMeu: false, // preenchido na listagem
    createdAt: f.createdAt, updatedAt: f.updatedAt,
  };
}

async function mapaUsuarios(ids: string[]) {
  if (!ids.length) return new Map<string, { username: string; displayName: string | null }>();
  const rows = await db.select({ id: users.id, username: users.username, displayName: users.displayName }).from(users).where(inArray(users.id, ids));
  return new Map(rows.map((r) => [r.id, r]));
}

// ---------- pastas ----------

/** GET /api/campaigns/:cid/arquivos/pastas — árvore de pastas */
arquivosRouter.get("/pastas", requirePapel("mestre", "jogador", "espectador"), async (req, res) => {
  const lista = await db.select().from(folders).where(eq(folders.campaignId, req.params.campaignId));
  res.json({ pastas: lista });
});

const pastaSchema = z.object({
  name: z.string().min(1).max(120),
  parentId: z.string().nullable().optional(),
});

/** POST /api/campaigns/:cid/arquivos/pastas — criar pasta (mestre) */
arquivosRouter.post("/pastas", requirePapel("mestre"), async (req, res) => {
  const body = pastaSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ erro: "Dados inválidos" }); return; }
  const cid = req.params.campaignId;
  if (body.data.parentId) {
    const [p] = await db.select().from(folders).where(and(eq(folders.id, body.data.parentId), eq(folders.campaignId, cid))).limit(1);
    if (!p) { res.status(400).json({ erro: "Pasta pai não encontrada" }); return; }
  }
  const id = crypto.randomUUID();
  await db.insert(folders).values({ id, campaignId: cid, parentId: body.data.parentId ?? null, name: body.data.name, createdBy: req.usuario!.id, createdAt: new Date() });
  emitirCampanha(cid, "arquivos:atualizados", {});
  res.status(201).json({ id });
});

/** PATCH /api/campaigns/:cid/arquivos/pastas/:id — renomear/mover/configurar (mestre) */
arquivosRouter.patch("/pastas/:id", requirePapel("mestre"), async (req, res) => {
  const cid = req.params.campaignId;
  const [p] = await db.select().from(folders).where(and(eq(folders.id, req.params.id), eq(folders.campaignId, cid))).limit(1);
  if (!p) { res.status(404).json({ erro: "Pasta não encontrada" }); return; }
  const body = pastaSchema.partial().extend({ allowPlayerUploads: z.boolean().optional() }).safeParse(req.body);
  if (!body.success) { res.status(400).json({ erro: "Dados inválidos" }); return; }
  const d = body.data;
  if (d.parentId !== undefined && d.parentId !== null) {
    if (d.parentId === p.id) { res.status(400).json({ erro: "Pasta não pode ser pai de si mesma" }); return; }
    const [novoPai] = await db.select().from(folders).where(and(eq(folders.id, d.parentId), eq(folders.campaignId, cid))).limit(1);
    if (!novoPai) { res.status(400).json({ erro: "Pasta pai não encontrada" }); return; }
    // previne ciclo: sobe a árvore a partir do novo pai
    let atual: string | null = novoPai.parentId;
    const visitados = new Set<string>([p.id]);
    while (atual) {
      if (visitados.has(atual)) { res.status(400).json({ erro: "Movimento criaria ciclo" }); return; }
      visitados.add(atual);
      const [prox] = await db.select({ parentId: folders.parentId }).from(folders).where(eq(folders.id, atual)).limit(1);
      atual = prox?.parentId ?? null;
    }
  }
  await db.update(folders).set({
    name: d.name ?? p.name,
    parentId: d.parentId !== undefined ? d.parentId : p.parentId,
    allowPlayerUploads: d.allowPlayerUploads ?? p.allowPlayerUploads,
  }).where(eq(folders.id, p.id));
  emitirCampanha(cid, "arquivos:atualizados", {});
  res.json({ ok: true });
});

/** DELETE /api/campaigns/:cid/arquivos/pastas/:id — só se vazia (mestre) */
arquivosRouter.delete("/pastas/:id", requirePapel("mestre"), async (req, res) => {
  const cid = req.params.campaignId;
  const [p] = await db.select().from(folders).where(and(eq(folders.id, req.params.id), eq(folders.campaignId, cid))).limit(1);
  if (!p) { res.status(404).json({ erro: "Pasta não encontrada" }); return; }
  const [filho] = await db.select({ id: folders.id }).from(folders).where(eq(folders.parentId, p.id)).limit(1);
  const [arq] = await db.select({ id: files.id }).from(files).where(eq(files.folderId, p.id)).limit(1);
  if (filho || arq) { res.status(409).json({ erro: "Pasta não está vazia" }); return; }
  await db.delete(folders).where(eq(folders.id, p.id));
  emitirCampanha(cid, "arquivos:atualizados", {});
  res.json({ ok: true });
});

// ---------- arquivos ----------

/** GET /api/campaigns/:cid/arquivos — lista visível ao requisitante */
arquivosRouter.get("/", requirePapel("mestre", "jogador", "espectador"), async (req, res) => {
  const cid = req.params.campaignId;
  const ehMestre = req.membership!.role === "mestre";
  const ehEspectador = req.membership!.role === "espectador";
  const membershipIds = new Set([req.usuario!.id, req.membership!.id]);
  const regras = await carregarRegras(cid);
  if (ehEspectador && (!regras.config.arquivos?.espectadorVe || permissoesDe(req.membership).verBiblioteca === false)) {
    res.status(403).json({ erro: "Espectador sem acesso à biblioteca" }); return;
  }
  const todos = await db.select().from(files).where(eq(files.campaignId, cid)).orderBy(desc(files.createdAt));
  const visiveis = todos.filter((f) => arquivoVisivel(f, req.usuario!.id, ehMestre, membershipIds));
  const mapa = await mapaUsuarios([...new Set(visiveis.map((f) => f.uploadedBy))]);
  res.json({
    arquivos: visiveis.map((f) => ({ ...arquivoSerializavel(f, mapa), ehMeu: f.uploadedBy === req.usuario!.id })),
    limites: { tamanhoMaxMb: config.arquivos.tamanhoMaxMb },
    config: { jogadoresEnviam: regras.config.arquivos?.jogadoresEnviam ?? true, espectadorVe: regras.config.arquivos?.espectadorVe ?? true },
  });
});

/** POST /api/campaigns/:cid/arquivos/upload — corpo binário cru (octet-stream) */
arquivosRouter.post("/upload", express.raw({ type: () => true, limit: `${config.arquivos.tamanhoMaxMb + 5}mb` }), requirePapel("mestre", "jogador"), async (req, res) => {
  const cid = req.params.campaignId;
  const papel = req.membership!.role;
  const nomeHeader = String(req.headers["x-file-name"] ?? "");
  let fileName: string;
  try {
    fileName = decodeURIComponent(nomeHeader).slice(0, 255) || "arquivo";
  } catch {
    res.status(400).json({ erro: "Nome de arquivo inválido" });
    return;
  }
  const ext = extensaoSegura(fileName);
  const buffer = req.body as Buffer;

  const regras = await carregarRegras(cid);
  const maxMb = config.arquivos.tamanhoMaxMb;
  const extras = [...(regras.config.arquivos?.formatosExtras ?? []), ...(config.arquivos.formatosExtras ?? [])];
  if (!formatoPermitido(ext, extras)) { res.status(415).json({ erro: `Formato .${ext || "?"} não permitido` }); return; }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) { res.status(400).json({ erro: "Arquivo vazio" }); return; }
  if (buffer.length > maxMb * 1024 * 1024) { res.status(413).json({ erro: `Arquivo excede o limite de ${maxMb} MB` }); return; }

  const mimeType = String(req.headers["x-file-mime"] ?? "application/octet-stream").slice(0, 120);
  if (MIMES_PERIGOSOS.test(mimeType)) { res.status(415).json({ erro: "Tipo de arquivo não permitido" }); return; }

  const folderId = typeof req.headers["x-folder-id"] === "string" && req.headers["x-folder-id"] ? String(req.headers["x-folder-id"]) : null;
  if (folderId) {
    const [p] = await db.select().from(folders).where(and(eq(folders.id, folderId), eq(folders.campaignId, cid))).limit(1);
    if (!p) { res.status(400).json({ erro: "Pasta não encontrada" }); return; }
  }

  // permissões de envio
  let status = "aprovado";
  let visibility = "mestre";
  let recipients: string[] | null = null;
  if (papel !== "mestre") {
    if (!regras.config.arquivos?.jogadoresEnviam) { res.status(403).json({ erro: "Envio de arquivos bloqueado nesta campanha" }); return; }
    status = "pendente";
    visibility = "mestre"; // jogador envia p/ aprovação do mestre
  } else {
    const vis = String(req.headers["x-visibility"] ?? "mestre");
    if (["mestre", "publica", "selecionada"].includes(vis)) visibility = vis;
    const rec = String(req.headers["x-recipients"] ?? "");
    if (vis === "selecionada" && rec) {
      const ids = rec.split(",").map((s) => s.trim()).filter(Boolean);
      const validos = await db.select({ userId: memberships.userId }).from(memberships)
        .where(and(eq(memberships.campaignId, cid), eq(memberships.status, "ativo"), inArray(memberships.userId, ids)));
      if (validos.length !== ids.length) { res.status(400).json({ erro: "Destinatários inválidos" }); return; }
      recipients = ids;
    }
  }

  // anexo direto a uma anotação (Etapa 11): x-note-id vincula o arquivo à nota
  const noteId = typeof req.headers["x-note-id"] === "string" && req.headers["x-note-id"] ? String(req.headers["x-note-id"]).slice(0, 64) : null;
  if (noteId) {
    const [nota] = await db.select({ id: notes.id, ownerId: notes.ownerId }).from(notes)
      .where(and(eq(notes.id, noteId), eq(notes.campaignId, cid))).limit(1);
    if (!nota) { res.status(400).json({ erro: "Anotação não encontrada" }); return; }
    if (nota.ownerId !== req.usuario!.id && papel !== "mestre") { res.status(403).json({ erro: "Só o dono da anotação anexa arquivos" }); return; }
  }

  const id = crypto.randomUUID();
  const storageName = `${id}.${ext || "bin"}`;
  const displayName = String(req.headers["x-display-name"] ?? "").slice(0, 200) || null;
  const description = String(req.headers["x-description"] ?? "").slice(0, 2000) || null;
  const category = String(req.headers["x-category"] ?? "").slice(0, 120) || null;

  garantirDir(cid);
  const destino = caminhoFisico(cid, storageName)!;
  try {
    writeFileSync(destino, buffer);
  } catch {
    res.status(500).json({ erro: "Falha ao gravar arquivo" }); return;
  }

  await db.insert(files).values({
    id, campaignId: cid, folderId, folderPath: "/",
    fileName, displayName, description, category,
    storageName, mimeType, sizeBytes: buffer.length,
    status, visibility, recipients,
    uploadedBy: req.usuario!.id, createdAt: new Date(), updatedAt: new Date(),
  });
  if (noteId) {
    await db.insert(noteAttachments).values({ id: crypto.randomUUID(), noteId, fileId: id, createdBy: req.usuario!.id, createdAt: new Date() })
      .onConflictDoNothing();
  }
  await audit(req, "arquivo.enviado", { fileId: id, fileName, status });
  emitirCampanha(cid, "arquivos:atualizados", {});
  res.status(201).json({ id });
});

/** GET /api/campaigns/:cid/arquivos/:fileId — download/visualização (permissão revalidada) */
arquivosRouter.get("/:fileId", requirePapel("mestre", "jogador", "espectador"), async (req, res) => {
  const cid = req.params.campaignId;
  const [f] = await db.select().from(files).where(and(eq(files.id, req.params.fileId), eq(files.campaignId, cid))).limit(1);
  if (!f) { res.status(404).json({ erro: "Arquivo não encontrado" }); return; }
  const ehMestre = req.membership!.role === "mestre";
  if (req.membership!.role === "espectador") {
    const regras = await carregarRegras(cid);
    if (!regras.config.arquivos?.espectadorVe || permissoesDe(req.membership).verBiblioteca === false) {
      res.status(403).json({ erro: "Sem permissão" }); return;
    }
  }
  const membershipIds = new Set([req.usuario!.id, req.membership!.id]);
  if (!arquivoVisivel(f, req.usuario!.id, ehMestre, membershipIds)) { res.status(403).json({ erro: "Sem permissão" }); return; }
  if (!f.storageName) { res.status(404).json({ erro: "Arquivo físico não registrado" }); return; }
  const caminho = caminhoFisico(cid, f.storageName);
  if (!caminho || !existsSync(caminho)) {
    // tenta recuperar da lixeira
    const lix = caminhoLixeira(cid, f.storageName);
    if (existsSync(lix)) {
      try { renameSync(lix, caminho!); } catch { res.status(404).json({ erro: "Arquivo indisponível" }); return; }
    } else { res.status(404).json({ erro: "Arquivo indisponível" }); return; }
  }
  const querDownload = req.query.download === "1";
  const nomeExib = f.displayName ?? f.fileName;
  res.setHeader("Content-Type", f.mimeType ?? "application/octet-stream");
  res.setHeader("Content-Disposition", `${querDownload ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(nomeExib)}`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  createReadStream(caminho!).pipe(res);
});

const editarSchema = z.object({
  fileName: z.string().min(1).max(255).optional(),
  displayName: z.string().max(200).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  category: z.string().max(120).nullable().optional(),
  folderId: z.string().nullable().optional(),
  visibility: z.enum(["mestre", "publica", "selecionada"]).optional(),
  recipients: z.array(z.string()).max(100).optional(),
});

/** PATCH /api/campaigns/:cid/arquivos/:fileId — editar/mover (dono ou mestre) */
arquivosRouter.patch("/:fileId", requirePapel("mestre", "jogador"), async (req, res) => {
  const cid = req.params.campaignId;
  const [f] = await db.select().from(files).where(and(eq(files.id, req.params.fileId), eq(files.campaignId, cid))).limit(1);
  if (!f) { res.status(404).json({ erro: "Arquivo não encontrado" }); return; }
  const ehMestre = req.membership!.role === "mestre";
  const ehDono = f.uploadedBy === req.usuario!.id;
  if (!ehMestre && !ehDono) { res.status(403).json({ erro: "Sem permissão" }); return; }
  const body = editarSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues }); return; }
  const d = body.data;

  // não-mestre só edita o próprio arquivo enquanto pendente, e só campos básicos
  if (!ehMestre) {
    if (f.status !== "pendente") { res.status(403).json({ erro: "Arquivo já moderado" }); return; }
    if (d.folderId !== undefined || d.visibility !== undefined || d.recipients !== undefined || d.fileName !== undefined) {
      res.status(403).json({ erro: "Apenas o mestre move/altera visibilidade" }); return;
    }
  }
  if (d.folderId) {
    const [p] = await db.select().from(folders).where(and(eq(folders.id, d.folderId), eq(folders.campaignId, cid))).limit(1);
    if (!p) { res.status(400).json({ erro: "Pasta não encontrada" }); return; }
  }
  let recips: string[] | null | undefined;
  if (d.visibility === "selecionada" && d.recipients !== undefined) {
    const validos = await db.select({ userId: memberships.userId }).from(memberships)
      .where(and(eq(memberships.campaignId, cid), eq(memberships.status, "ativo"), inArray(memberships.userId, d.recipients)));
    if (validos.length !== d.recipients.length) { res.status(400).json({ erro: "Destinatários inválidos" }); return; }
    recips = d.recipients;
  }
  await db.update(files).set({
    fileName: d.fileName ?? f.fileName,
    displayName: d.displayName !== undefined ? d.displayName : f.displayName,
    description: d.description !== undefined ? d.description : f.description,
    category: d.category !== undefined ? d.category : f.category,
    folderId: d.folderId !== undefined ? d.folderId : f.folderId,
    visibility: d.visibility ?? f.visibility,
    recipients: recips !== undefined ? recips : (d.visibility && d.visibility !== "selecionada" ? null : f.recipients),
    updatedAt: new Date(),
  }).where(eq(files.id, f.id));
  await audit(req, "arquivo.atualizado", { fileId: f.id });
  emitirCampanha(cid, "arquivos:atualizados", {});
  res.json({ ok: true });
});

/** PATCH /api/campaigns/:cid/arquivos/:fileId/moderacao — aprovar/rejeitar (mestre) */
arquivosRouter.patch("/:fileId/moderacao", requirePapel("mestre"), async (req, res) => {
  const cid = req.params.campaignId;
  const acao = String((req.body as { acao?: string })?.acao ?? "");
  if (!["aprovar", "rejeitar"].includes(acao)) { res.status(400).json({ erro: "Ação inválida" }); return; }
  const [f] = await db.select().from(files).where(and(eq(files.id, req.params.fileId), eq(files.campaignId, cid))).limit(1);
  if (!f) { res.status(404).json({ erro: "Arquivo não encontrado" }); return; }
  await db.update(files).set({ status: acao === "aprovar" ? "aprovado" : "rejeitado", updatedAt: new Date() }).where(eq(files.id, f.id));
  await audit(req, `arquivo.${acao === "aprovar" ? "aprovado" : "rejeitado"}`, { fileId: f.id });
  emitirCampanha(cid, "arquivos:atualizados", {});
  res.json({ ok: true });
});

/** DELETE /api/campaigns/:cid/arquivos/:fileId — dono ou mestre; físico vai p/ lixeira */
arquivosRouter.delete("/:fileId", requirePapel("mestre", "jogador", "espectador"), async (req, res) => {
  const cid = req.params.campaignId;
  const [f] = await db.select().from(files).where(and(eq(files.id, req.params.fileId), eq(files.campaignId, cid))).limit(1);
  if (!f) { res.status(404).json({ erro: "Arquivo não encontrado" }); return; }
  const ehMestre = req.membership!.role === "mestre";
  const ehDono = f.uploadedBy === req.usuario!.id;
  if (!ehMestre && !ehDono) { res.status(403).json({ erro: "Sem permissão" }); return; }
  if (f.storageName) {
    const origem = caminhoFisico(cid, f.storageName);
    const destino = caminhoLixeira(cid, f.storageName);
    if (origem && existsSync(origem)) {
      try { mkdirSync(resolve(dirCampanha(cid), ".lixeira"), { recursive: true }); renameSync(origem, destino); } catch { /* segue sem mover */ }
    }
  }
  await db.delete(files).where(eq(files.id, f.id));
  await audit(req, "arquivo.removido", { fileId: f.id, fileName: f.fileName });
  emitirCampanha(cid, "arquivos:atualizados", {});
  res.json({ ok: true });
});
