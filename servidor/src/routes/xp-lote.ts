import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { createHash } from "node:crypto";
import { getDb } from "../db/index.js";
import { characters, memberships, users, xpLotes } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePapel } from "../lib/permissoes.js";
import { audit } from "../lib/audit.js";
import { emitirCampanha } from "../lib/io.js";
import { pontosSelados } from "../lib/pontos.js";
import { aplicarXp } from "../lib/progressao.js";

const db = getDb();
export const xpLoteRouter = Router();
xpLoteRouter.use(requireAuth);

const MAX_ITENS = 500;

const loteSchema = z.object({
  requestId: z.string().trim().min(1).max(100),
  motivo: z.string().trim().min(1).max(300),
  itens: z.array(z.object({
    characterId: z.string().min(1).max(100),
    quantidade: z.number().int().min(1).max(1_000_000),
  })).min(1).max(MAX_ITENS),
});

type ItemLote = { characterId: string; quantidade: number };
type ItemResultado = ItemLote & { saldoResultante: number };

/** Hash canônico do payload (itens ordenados) — distingue retry
 *  idêntico de requestId reutilizado com conteúdo divergente. */
function hashPayload(motivo: string, itens: ItemLote[]): string {
  const canon = JSON.stringify({
    motivo,
    itens: [...itens].sort((a, b) => a.characterId.localeCompare(b.characterId) || a.quantidade - b.quantidade),
  });
  return createHash("sha256").update(canon).digest("hex");
}

function respostaLote(registro: typeof xpLotes.$inferSelect, repetido: boolean) {
  const itens = (registro.itens ?? []) as ItemResultado[];
  return {
    ok: true,
    repetido,
    lote: {
      requestId: registro.requestId,
      motivo: registro.motivo,
      totalPersonagens: registro.totalPersonagens,
      totalXp: registro.totalXp,
      criadoEm: registro.createdAt,
    },
    itens: itens.map((i) => ({ characterId: i.characterId, quantidade: i.quantidade, saldoResultante: i.saldoResultante })),
  };
}

/**
 * POST /api/campaigns/:campaignId/xp-lote — concessão de XP em lote
 * (Issue #185 item 3). SOMENTE mestre. Tudo-ou-nada: qualquer item
 * inválido (personagem de outra campanha/inexistente, arquivado ou ficha
 * sem selo de pontos) cancela o lote inteiro — nenhuma escrita ocorre.
 *
 * Idempotência por requestId no escopo da campanha (tabela xp_lotes,
 * UNIQUE campaign+request): retry com o MESMO payload devolve o
 * resultado gravado sem duplicar saldo/histórico/auditoria; requestId
 * reutilizado com payload divergente → 409. Duas execuções concorrentes
 * com o mesmo requestId são serializadas pela constraint UNIQUE — a
 * segunda relê o registro gravado.
 *
 * Os eventos __xp individuais carregam `loteRequestId` para rastreio;
 * a auditoria é UM registro agregado `campanha.xp_lote` e o socket
 * emite `personagens:atualizados` por personagem afetado (mesmo
 * contrato do endpoint individual).
 */
xpLoteRouter.post("/:campaignId/xp-lote", requirePapel("mestre"), async (req, res) => {
  const campaignId = req.params.campaignId;
  const body = loteSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues });
    return;
  }
  const { requestId, motivo, itens } = body.data;
  const hash = hashPayload(motivo, itens);

  // characterId duplicado no mesmo lote tornaria o resultado ambíguo —
  // rejeitado antes de qualquer leitura.
  const ids = itens.map((i) => i.characterId);
  if (new Set(ids).size !== ids.length) {
    res.status(400).json({ erro: "Itens duplicados no lote", codigo: "item_duplicado" });
    return;
  }

  const [autor] = await db.select({ displayName: users.displayName, username: users.username })
    .from(users).where(eq(users.id, req.usuario!.id)).limit(1);
  const autorNome = autor?.displayName || autor?.username || "?";
  const agora = new Date();

  type Resultado =
    | { tipo: "ok"; resultados: ItemResultado[] }
    | { tipo: "repetido"; registro: typeof xpLotes.$inferSelect }
    | { tipo: "divergente" }
    | { tipo: "sem_permissao" }
    | { tipo: "falha"; status: number; corpo: Record<string, unknown> };

  let resultado: Resultado;
  try {
    resultado = db.transaction((tx): Resultado => {
      // Revalidação transacional do papel — mesmo padrão de POST /xp.
      const [vinculo] = tx.select().from(memberships)
        .where(and(
          eq(memberships.campaignId, campaignId),
          eq(memberships.userId, req.usuario!.id),
          eq(memberships.status, "ativo"),
        ))
        .limit(1).all();
      if (!vinculo || vinculo.role !== "mestre") return { tipo: "sem_permissao" };

      // Idempotência: requestId já gravado para esta campanha.
      const [existente] = tx.select().from(xpLotes)
        .where(and(eq(xpLotes.campaignId, campaignId), eq(xpLotes.requestId, requestId)))
        .limit(1).all();
      if (existente) {
        return existente.payloadHash === hash
          ? { tipo: "repetido", registro: existente }
          : { tipo: "divergente" };
      }

      // Fase 1 — validação de TODOS os itens antes de qualquer escrita
      // (tudo-ou-nada). Personagens são relidos frescos dentro da tx.
      const planos: { id: string; quantidade: number; dados: Record<string, unknown> }[] = [];
      for (const item of itens) {
        const [p] = tx.select().from(characters).where(eq(characters.id, item.characterId)).limit(1).all();
        if (!p || p.campaignId !== campaignId) {
          return {
            tipo: "falha", status: 404,
            corpo: { erro: `Personagem não encontrado nesta campanha`, codigo: "personagem_nao_encontrado", characterId: item.characterId },
          };
        }
        if (p.status === "arquivado") {
          return {
            tipo: "falha", status: 403,
            corpo: { erro: "Personagem arquivado — restaure-o antes de alterar", codigo: "personagem_arquivado", characterId: item.characterId },
          };
        }
        const dados = (p.data ?? {}) as Record<string, unknown>;
        // Concessão exige ficha selada — mesma regra do endpoint individual.
        if (!pontosSelados(dados)) {
          return {
            tipo: "falha", status: 403,
            corpo: { erro: "Ficha sem selo de pontos — XP só pode ser concedido em ficha selada", codigo: "ficha_nao_selada", characterId: item.characterId },
          };
        }
        planos.push({ id: p.id, quantidade: item.quantidade, dados });
      }

      // Fase 2 — aplicação: um evento __xp por personagem, tudo na mesma tx.
      const resultados: ItemResultado[] = [];
      for (const plano of planos) {
        const { dados: novosDados, estado } = aplicarXp(plano.dados, plano.quantidade, {
          tipo: "concessao",
          motivo,
          autorId: req.usuario!.id,
          autorNome,
          loteRequestId: requestId,
        });
        tx.update(characters).set({ data: novosDados, updatedAt: agora }).where(eq(characters.id, plano.id)).run();
        resultados.push({ characterId: plano.id, quantidade: plano.quantidade, saldoResultante: estado.saldo });
      }

      tx.insert(xpLotes).values({
        id: crypto.randomUUID(),
        campaignId,
        requestId,
        payloadHash: hash,
        motivo,
        itens: resultados,
        totalPersonagens: resultados.length,
        totalXp: resultados.reduce((s, i) => s + i.quantidade, 0),
        createdBy: req.usuario!.id,
        createdAt: agora,
      }).run();
      return { tipo: "ok", resultados };
    });
  } catch (e) {
    // Corrida de requestId: a constraint UNIQUE rejeitou o segundo
    // insert — relê o registro vencedor e responde conforme o payload.
    const [vencedor] = db.select().from(xpLotes)
      .where(and(eq(xpLotes.campaignId, campaignId), eq(xpLotes.requestId, requestId)))
      .limit(1).all();
    if (vencedor) {
      resultado = vencedor.payloadHash === hash
        ? { tipo: "repetido", registro: vencedor }
        : { tipo: "divergente" };
    } else {
      throw e;
    }
  }

  if (resultado.tipo === "sem_permissao") {
    res.status(403).json({ erro: "Sem permissão para conceder XP nesta campanha" });
    return;
  }
  if (resultado.tipo === "divergente") {
    res.status(409).json({
      erro: "requestId já utilizado com payload divergente",
      codigo: "requestId_divergente",
    });
    return;
  }
  if (resultado.tipo === "repetido") {
    res.json(respostaLote(resultado.registro, true));
    return;
  }
  if (resultado.tipo === "falha") {
    res.status(resultado.status).json(resultado.corpo);
    return;
  }

  const registro = db.select().from(xpLotes)
    .where(and(eq(xpLotes.campaignId, campaignId), eq(xpLotes.requestId, requestId)))
    .limit(1).all()[0];

  await audit(req, "campanha.xp_lote", {
    requestId,
    motivo,
    totalPersonagens: resultado.resultados.length,
    totalXp: resultado.resultados.reduce((s, i) => s + i.quantidade, 0),
    itens: resultado.resultados,
  });
  for (const item of resultado.resultados) {
    emitirCampanha(campaignId, "personagens:atualizados", { characterId: item.characterId });
  }
  res.json(respostaLote(registro, false));
});
