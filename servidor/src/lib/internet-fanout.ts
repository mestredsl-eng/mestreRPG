// Seleção pura de destinatários do fan-out da Internet diegética
// (#350/#351 — incremento F3 absorvido). Sem I/O: recebe os participantes
// já resolvidos (conta → userId) e devolve a lista deduplicada na ordem
// estável da consulta. A revalidação server-side por destinatário
// (contaAutorizadaPara) acontece em emitirInternetConversa (lib/io.ts)
// imediatamente antes de cada emit — este módulo não decide autorização.

export interface DestinoInternet {
  contaId: string;
  userId: string;
}

/**
 * Dedup por (userId, contaId) — a mesma pessoa com dois personagens
 * participantes recebe um evento POR CONTA (roteamento distinto no
 * cliente), não é duplicata. Ordem de entrada preservada.
 */
export function selecionarDestinatariosInternet(partes: readonly DestinoInternet[]): DestinoInternet[] {
  const vistos = new Set<string>();
  const out: DestinoInternet[] = [];
  for (const p of partes) {
    const chave = `${p.userId}:${p.contaId}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    out.push(p);
  }
  return out;
}
