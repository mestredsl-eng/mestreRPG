import { Router } from "express";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, CAMINHOS } from "../db/index.js";
import {
  campaigns, memberships, users, snapshots,
} from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePapel } from "../lib/permissoes.js";
import { audit } from "../lib/audit.js";
import { emitirCampanha } from "../lib/io.js";
import { exportarCampanha, exportarPacote, type PacoteExportacao } from "../lib/estado.js";
import { restaurarEstado, inserirEstado } from "../lib/restaurar.js";

const db = getDb();
export const campanhaIORouter = Router({ mergeParams: true });
campanhaIORouter.use(requireAuth);

/** GET /api/campaigns/:campaignId/exportar — pacote completo da campanha (mestre) */
campanhaIORouter.get("/:campaignId/exportar", requirePapel("mestre"), async (req, res) => {
  const pacote = await exportarPacote(req.params.campaignId);
  await audit(req, "campanha.exportada", { campaignId: req.params.campaignId });
  res.setHeader("content-disposition", `attachment; filename="campanha-${req.params.campaignId}.json"`);
  res.json(pacote);
});

const importarSchema = z.object({
  pacote: z.unknown(),
  modo: z.enum(["nova", "substituir"]).default("nova"),
  campaignId: z.string().optional(),
  confirmacao: z.string().optional(),
});

function pacoteValido(p: unknown): p is PacoteExportacao {
  const pacote = p as PacoteExportacao;
  return !!pacote && pacote.versao === 1 && typeof pacote.campanhaId === "string"
    && !!pacote.estado && typeof pacote.estado === "object"
    && typeof pacote.estado.campanha === "object" && pacote.estado.campanha !== null
    && Array.isArray(pacote.estado.memberships) && Array.isArray(pacote.estado.characters)
    && typeof pacote.arquivos === "object" && pacote.arquivos !== null;
}

/** POST /api/campaigns/importar — importa pacote exportado (Etapa 12) */
campanhaIORouter.post("/importar", async (req, res) => {
  const body = importarSchema.safeParse(req.body ?? {});
  if (!body.success) { res.status(400).json({ erro: "Dados inválidos" }); return; }
  const { pacote, modo } = body.data;
  if (!pacoteValido(pacote)) { res.status(400).json({ erro: "Pacote de campanha inválido ou incompatível" }); return; }
  const estado = pacote.estado;

  // ---- modo substituir: restaura sobre campanha existente do próprio usuário ----
  if (modo === "substituir") {
    const cid = body.data.campaignId;
    if (!cid) { res.status(400).json({ erro: "campaignId obrigatório no modo substituir" }); return; }
    if (body.data.confirmacao !== "SUBSTITUIR") {
      res.status(400).json({ erro: 'Confirmação obrigatória: { "confirmacao": "SUBSTITUIR" }' }); return;
    }
    const [m] = await db.select().from(memberships)
      .where(and(eq(memberships.campaignId, cid), eq(memberships.userId, req.usuario!.id), eq(memberships.role, "mestre"), eq(memberships.status, "ativo"))).limit(1);
    if (!m) { res.status(403).json({ erro: "Somente o mestre da campanha pode substituí-la" }); return; }

    // segurança: snapshot do estado atual antes de sobrescrever
    const preSnapId = crypto.randomUUID();
    await db.insert(snapshots).values({
      id: preSnapId, campaignId: cid, kind: "pre_restauracao",
      description: `Automático — antes de importar pacote sobre a campanha`,
      data: (await exportarCampanha(cid)) as never, createdBy: req.usuario!.id, createdAt: new Date(),
    });
    let resultado;
    try {
      resultado = await restaurarEstado(cid, estado, { gravarArquivos: pacote.arquivos });
    } catch (e) {
      res.status(500).json({ erro: "Falha ao importar/substituir", detalhe: String(e) });
      return;
    }
    await audit(req, "campanha.importada_substituida", { campaignId: cid, preSnapshotId: preSnapId, ...resultado });
    emitirCampanha(cid, "campanha:restaurada", {});
    res.json({ ok: true, campaignId: cid, modo, ...resultado });
    return;
  }

  // ---- modo nova: cria campanha a partir do pacote ----
  const cid = pacote.campanhaId ?? crypto.randomUUID();
  if (typeof cid !== "string" || !/^[\w-]{8,64}$/.test(cid)) { res.status(400).json({ erro: "Identificador de campanha inválido no pacote" }); return; }
  const [existente] = await db.select({ id: campaigns.id }).from(campaigns).where(eq(campaigns.id, cid)).limit(1);
  if (existente) {
    res.status(409).json({ erro: "Já existe uma campanha com este identificador", sugestao: "Use modo 'substituir' (somente o mestre da campanha) ou edite o pacote." });
    return;
  }

  // membros do pacote precisam existir nesta instalação
  const userIds = [...new Set((estado.memberships as { userId: string }[]).map((m) => m.userId))];
  if (userIds.length) {
    const encontrados = await db.select({ id: users.id }).from(users).where(inArray(users.id, userIds));
    const set = new Set(encontrados.map((u) => u.id));
    const faltando = userIds.filter((u) => !set.has(u));
    if (faltando.length) {
      res.status(422).json({ erro: "O pacote referencia usuários que não existem nesta instalação", usuariosAusentes: faltando.length });
      return;
    }
  }

  const precisaMembroExtra = !(estado.memberships as { userId: string }[]).some((m) => m.userId === req.usuario!.id);
  try {
    db.transaction((tx) => {
      const { id: _i, ownerId: _o, createdAt: _c, updatedAt: _u, ...campos } = estado.campanha as Record<string, unknown>;
      tx.insert(campaigns).values({
        id: cid, ownerId: req.usuario!.id,
        ...(campos as object),
        createdAt: new Date(), updatedAt: new Date(),
      } as never).run();
      inserirEstado(tx, estado);
      // garante o importador como mestre mesmo que o pacote não o tenha
      if (precisaMembroExtra) {
        tx.insert(memberships).values({
          id: crypto.randomUUID(), campaignId: cid, userId: req.usuario!.id, role: "mestre",
          permissions: {}, status: "ativo", joinedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
        } as never).run();
      }
    });
  } catch (e) {
    res.status(422).json({ erro: "Falha de integridade ao importar pacote", detalhe: String(e) });
    return;
  }

  // grava binários dos arquivos
  const baseDir = resolve(CAMINHOS.arquivos, cid);
  let arquivosGravados = 0;
  for (const [fileId, arq] of Object.entries(pacote.arquivos ?? {})) {
    const meta = (estado.files as { id: string; storageName: string | null }[]).find((f) => f.id === fileId);
    if (!meta?.storageName || !arq?.conteudo) continue;
    const destino = resolve(baseDir, meta.storageName);
    if (!destino.startsWith(baseDir + sep)) continue;
    try { mkdirSync(baseDir, { recursive: true }); writeFileSync(destino, Buffer.from(arq.conteudo, "base64")); arquivosGravados++; } catch { /* best-effort */ }
  }

  await audit(req, "campanha.importada", { campaignId: cid, arquivosGravados });
  res.status(201).json({ ok: true, campaignId: cid, modo, arquivosGravados });
});
