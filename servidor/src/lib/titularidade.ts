// Titularidade TOCTOU — revalidação síncrona dentro da tx da mutação.
//
// As checagens assíncronas de titularidade (`titularDoPersonagem`,
// `contaAutorizadaPara`) correm ANTES da transação; entre a leitura e
// o commit uma transferência de personagem/conta passaria
// despercebida (janela confirmada por Ger.Exec/TG nos TOCTOUs de
// patrocínio #401 e live #402 — mesmo padrão do DP-5 de perfil).
// Aqui a titularidade é relida de forma síncrona dentro da tx:
// conta Internet ativa do personagem + personagem não arquivado +
// membership ativa do requisitante + personagem pertencente ao
// requisitante. Gate de elegibilidade não entra — o invariante é
// autorização, não device.
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { characters, internetAccounts, memberships } from "../db/schema.js";

const db = getDb();
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function titularDePersonagemNaTx(
  tx: Tx, cid: string, characterId: string, userId: string,
): boolean {
  const [conta] = tx.select({ characterId: internetAccounts.characterId })
    .from(internetAccounts)
    .where(and(
      eq(internetAccounts.campaignId, cid),
      eq(internetAccounts.characterId, characterId),
      eq(internetAccounts.status, "ativa"),
    )).limit(1).all();
  if (!conta) return false;
  const [pers] = tx.select({
    membershipId: characters.membershipId,
    status: characters.status,
  }).from(characters)
    .where(and(eq(characters.id, conta.characterId), eq(characters.campaignId, cid)))
    .limit(1).all();
  if (!pers || pers.status === "arquivado") return false;
  const [mu] = tx.select({ role: memberships.role }).from(memberships)
    .where(and(
      eq(memberships.campaignId, cid),
      eq(memberships.userId, userId),
      eq(memberships.status, "ativo"),
    )).limit(1).all();
  if (!mu || (mu.role !== "mestre" && mu.role !== "jogador")) return false;
  const [dono] = tx.select({ userId: memberships.userId, status: memberships.status })
    .from(memberships)
    .where(and(
      eq(memberships.id, pers.membershipId),
      eq(memberships.campaignId, cid),
    )).limit(1).all();
  return !!dono && dono.status === "ativo" && dono.userId === userId;
}
