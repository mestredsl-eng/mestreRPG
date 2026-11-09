import { Router } from "express";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { campaigns, memberships } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { emitirCampanha } from "../lib/io.js";
import { limiteUsuario } from "../lib/ratelimit.js";
import { buscarConvite, statusConvite } from "../lib/convites.js";

const db = getDb();
export const convitesRouter = Router();
convitesRouter.use(requireAuth);

// Códigos de convite são segredos: limitar consultas/aceites por usuário
// dificulta enumeração e abuso (Etapa 15, R4).
const limiteConsultaConvite = limiteUsuario({ nome: "convite-consulta", janelaMs: 5 * 60_000, max: 30 });
const limiteAceiteConvite = limiteUsuario({ nome: "convite-aceite", janelaMs: 5 * 60_000, max: 20 });

/**
 * Router PÚBLICO (sem autenticação) — montado antes de convitesRouter.
 * GET /:codigo/preview permite que um convidado anônimo veja campanha,
 * papel e status antes de criar conta ou entrar. Não expõe membership
 * nem dados internos — apenas o necessário para a tela de cadastro.
 */
export const convitesPublicoRouter = Router();
const limitePreviewConvite = limiteUsuario({ nome: "convite-preview", janelaMs: 5 * 60_000, max: 60 });

convitesPublicoRouter.get("/:codigo/preview", limitePreviewConvite, async (req, res) => {
  const inv = await buscarConvite(req.params.codigo);
  if (!inv) {
    res.status(404).json({ erro: "Convite não encontrado" });
    return;
  }
  const [campanha] = await db.select().from(campaigns).where(eq(campaigns.id, inv.campaignId)).limit(1);
  if (!campanha) {
    res.status(404).json({ erro: "Campanha não encontrada" });
    return;
  }
  res.json({
    convite: {
      role: inv.role,
      requiresApproval: inv.requiresApproval,
      status: statusConvite(inv),
      campanha: { name: campanha.name, system: campanha.system },
    },
  });
});

/**
 * GET /api/convites/:codigo — valida o convite e retorna o que o convidado
 * precisa ver antes de confirmar: campanha, papel oferecido, validade.
 */
convitesRouter.get("/:codigo", limiteConsultaConvite, async (req, res) => {
  const inv = await buscarConvite(req.params.codigo);
  if (!inv) {
    res.status(404).json({ erro: "Convite não encontrado" });
    return;
  }
  const [campanha] = await db.select().from(campaigns).where(eq(campaigns.id, inv.campaignId)).limit(1);
  if (!campanha) {
    res.status(404).json({ erro: "Campanha não encontrada" });
    return;
  }
  const status = statusConvite(inv);
  const [existente] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.campaignId, inv.campaignId), eq(memberships.userId, req.usuario!.id)))
    .limit(1);
  res.json({
    convite: {
      role: inv.role,
      requiresApproval: inv.requiresApproval,
      status,
      campanha: { id: campanha.id, name: campanha.name, system: campanha.system, status: campanha.status },
      jaParticipa: !!existente && existente.status !== "removido",
      meuStatus: existente?.status ?? null,
    },
  });
});

/**
 * POST /api/convites/:codigo/aceitar — confirma a entrada na campanha.
 * Incremento de usos é atômico para não estourar maxUses em concorrência.
 */
convitesRouter.post("/:codigo/aceitar", limiteAceiteConvite, async (req, res) => {
  const inv = await buscarConvite(req.params.codigo);
  if (!inv) {
    res.status(404).json({ erro: "Convite não encontrado" });
    return;
  }
  if (statusConvite(inv) !== "ativo") {
    res.status(410).json({ erro: `Convite ${statusConvite(inv)}` });
    return;
  }

  const agora = new Date();
  // UPDATE condicional: só incrementa se ainda houver uso disponível.
  const resultado = await db.run(sql`
    UPDATE invitations
    SET uses = uses + 1, updated_at = ${agora.getTime()}
    WHERE id = ${inv.id}
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > ${agora.getTime()})
      AND (max_uses IS NULL OR uses < max_uses)
  `);
  if (resultado.changes === 0) {
    res.status(410).json({ erro: "Convite não está mais disponível" });
    return;
  }

  const papel = (inv.role === "espectador" ? "espectador" : "jogador") as "jogador" | "espectador";
  const statusMembro = inv.requiresApproval ? "pendente" : "ativo";

  const [existente] = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.campaignId, inv.campaignId), eq(memberships.userId, req.usuario!.id)))
    .limit(1);

  if (existente && existente.status !== "removido") {
    // Já participa — estorna o uso do convite
    await db.run(sql`UPDATE invitations SET uses = MAX(uses - 1, 0) WHERE id = ${inv.id}`);
    res.status(409).json({ erro: "Você já participa desta campanha", status: existente.status });
    return;
  }

  if (existente) {
    // Reentrada após remoção: reativa a mesma membership
    await db
      .update(memberships)
      .set({
        role: papel,
        status: statusMembro,
        joinedAt: statusMembro === "ativo" ? agora : existente.joinedAt,
        updatedAt: agora,
      })
      .where(eq(memberships.id, existente.id));
  } else {
    await db.insert(memberships).values({
      id: crypto.randomUUID(),
      campaignId: inv.campaignId,
      userId: req.usuario!.id,
      role: papel,
      status: statusMembro,
      joinedAt: statusMembro === "ativo" ? agora : null,
      createdAt: agora,
      updatedAt: agora,
    });
  }

  emitirCampanha(inv.campaignId, "membros:atualizados", { convite: true });
  res.status(201).json({
    ok: true,
    status: statusMembro,
    mensagem:
      statusMembro === "pendente"
        ? "Entrada solicitada! Aguardando aprovação do mestre."
        : "Você entrou na campanha!",
  });
});
