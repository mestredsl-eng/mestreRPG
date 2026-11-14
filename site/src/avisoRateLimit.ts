// Feedback agrupado de RATE_LIMITED (Issue #68): no máximo um aviso por
// ação a cada JANELA_MS, com o retryAfterMs mais recente — evita spam de
// mensagens quando um flood ou uma rajada é rejeitada pacote a pacote.
const ultimoAviso = new Map<string, number>();
const JANELA_MS = 3000;

/**
 * Se `r` é uma rejeição RATE_LIMITED, exibe um aviso deduplicado via
 * `mostrar` e retorna true (o chamador deve pular o erro genérico).
 * Retorna false para qualquer outro resultado — inclusive sucesso.
 */
export function tratarRateLimitSocket(
  r: unknown,
  rotulo: string,
  mostrar: (mensagem: string) => void,
): boolean {
  const resp = r as { codigo?: string; retryAfterMs?: number } | null | undefined;
  if (resp?.codigo !== "RATE_LIMITED") return false;
  const agora = Date.now();
  if (agora - (ultimoAviso.get(rotulo) ?? 0) < JANELA_MS) return true;
  ultimoAviso.set(rotulo, agora);
  const espera = Math.max(1, Math.ceil((resp.retryAfterMs ?? 1000) / 1000));
  mostrar(`Muitas ações de ${rotulo} — aguarde ~${espera}s e tente novamente`);
  return true;
}
