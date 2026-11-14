/**
 * Feedback de rate limit Socket.IO (Issue #68).
 *
 * O servidor responde `{ ok:false, codigo:"RATE_LIMITED", retryAfterMs }`
 * quando a cota do usuário estoura. Como rajadas geram muitas rejeições,
 * o aviso é agrupado: no máximo um por janela — nunca um toast por pacote.
 */

let ultimoAvisoEm = 0;
const JANELA_AVISO_MS = 2000;

/** Extrai o retryAfterMs quando o ACK é RATE_LIMITED; null caso contrário. */
export function retryAfterDoAck(r: unknown): number | null {
  const a = r as { codigo?: string; retryAfterMs?: number } | null | undefined;
  return a?.codigo === "RATE_LIMITED" && typeof a.retryAfterMs === "number" ? a.retryAfterMs : null;
}

/** Mensagem agrupada de espera, ou null se um aviso acabou de ser emitido. */
export function avisoRateLimit(retryAfterMs: number | null): string | null {
  const agora = Date.now();
  if (agora - ultimoAvisoEm < JANELA_AVISO_MS) return null;
  ultimoAvisoEm = agora;
  const s = Math.max(1, Math.ceil((retryAfterMs ?? 1000) / 1000));
  return `Muitas ações em pouco tempo — aguarde cerca de ${s}s`;
}
