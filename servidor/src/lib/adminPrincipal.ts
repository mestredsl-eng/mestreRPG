import { getDb } from "../db/index.js";
import { adminPrincipal } from "../db/schema.js";

// Identidade imutável do administrador principal (tabela admin_principal,
// protegida por triggers na migração 0013). Cache em memória por processo.
let cache: string | null | undefined;

export async function idAdminPrincipal(): Promise<string | null> {
  if (cache !== undefined) return cache;
  const [row] = await getDb().select({ userId: adminPrincipal.userId }).from(adminPrincipal).limit(1);
  cache = row?.userId ?? null;
  return cache;
}

export function limparCacheAdminPrincipal(): void {
  cache = undefined;
}

export async function ehAdminPrincipal(userId: string): Promise<boolean> {
  return (await idAdminPrincipal()) === userId;
}
