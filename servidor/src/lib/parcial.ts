/**
 * Zod 4: `.partial()` não impede que `.default()` de campos internos injete
 * valores no resultado do safeParse — chaves ausentes no body chegam
 * preenchidas com o default, quebrando a semântica "atualiza só o enviado".
 * Esta função remove do resultado as chaves que não constavam no body original.
 */
export function somenteEnviados<T extends object>(data: T, body: unknown): T {
  if (!body || typeof body !== "object" || Array.isArray(body)) return data;
  const enviadas = new Set(Object.keys(body as Record<string, unknown>));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (enviadas.has(k)) out[k] = v;
  }
  return out as T;
}

/**
 * Merge de PATCH: mantém valores atuais e sobrescreve apenas chaves enviadas.
 * Para seções-objeto (ex.: config.pontos, config.financeiro) mescla um nível
 * abaixo também, usando o sub-body original para saber o que foi enviado.
 */
export function mesclarParcial(
  atual: Record<string, unknown>,
  dados: Record<string, unknown>,
  body: unknown
): Record<string, unknown> {
  const bodyObj = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const enviadas = somenteEnviados(dados, bodyObj) as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...atual };
  for (const [k, v] of Object.entries(enviadas)) {
    const sub = bodyObj[k];
    const atualV = merged[k];
    if (
      v && typeof v === "object" && !Array.isArray(v) &&
      sub && typeof sub === "object" && !Array.isArray(sub) &&
      atualV && typeof atualV === "object" && !Array.isArray(atualV)
    ) {
      merged[k] = { ...(atualV as Record<string, unknown>), ...somenteEnviados(v as Record<string, unknown>, sub) };
    } else {
      merged[k] = v;
    }
  }
  return merged;
}
