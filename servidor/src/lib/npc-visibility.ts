export const CHAVE_NPC_VISIVEL = "__npcVisivel";

export function npcFichaVisivel(data: unknown): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const meta = (data as Record<string, unknown>)[CHAVE_NPC_VISIVEL];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return false;
  return (meta as { visivel?: unknown }).visivel === true;
}