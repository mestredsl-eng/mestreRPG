import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { getDb } from "../db/index.js";
import { invitations } from "../db/schema.js";

/**
 * Helpers compartilhados de convites — usados pelas rotas autenticadas
 * (convites.ts) e pelos fluxos públicos de prévia/cadastro (auth.ts).
 * O código em claro nunca é armazenado: só o hash SHA-256.
 */

export function hashConvite(codigo: string): string {
  return createHash("sha256").update(codigo.trim().toUpperCase()).digest("hex");
}

export function statusConvite(inv: typeof invitations.$inferSelect): string {
  if (inv.revokedAt) return "revogado";
  if (inv.expiresAt && inv.expiresAt < new Date()) return "expirado";
  if (inv.maxUses !== null && inv.uses >= inv.maxUses) return "esgotado";
  return "ativo";
}

export async function buscarConvite(codigo: string) {
  const db = getDb();
  const [inv] = await db
    .select()
    .from(invitations)
    .where(eq(invitations.code, hashConvite(codigo)))
    .limit(1);
  return inv ?? null;
}
