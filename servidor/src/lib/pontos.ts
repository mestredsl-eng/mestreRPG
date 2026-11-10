/**
 * Bônus individual de pontos por personagem — estado guardado em
 * `characters.data` sob a chave reservada "__pontos"
 * (nunca editável via PATCH da ficha: validarFicha descarta chaves
 * desconhecidas). Toda alteração passa pelo endpoint dedicado.
 *
 * - `bonus`: pontos extras do pool principal (negativo permitido).
 * - `historico`: concessões/remoções feitas pelo mestre.
 * - `selo`: marcado na primeira aprovação; enquanto existir, o jogador
 *   não pode alterar campos que mudem o total de pontos (Reabrir e
 *   Devolver NÃO removem o selo — só o mestre altera pontos).
 */

export const CHAVE_PONTOS = "__pontos";

export interface EventoPontos {
  em: string;                    // ISO
  quantidade: number;            // delta aplicado (negativo = remoção)
  motivo: string;
  autorId: string | null;
  autorNome: string | null;
}

export interface SeloPontos {
  em: string;
  autorId: string | null;
  autorNome: string | null;
}

export interface EstadoPontos {
  bonus: number;
  historico: EventoPontos[];
  selo: SeloPontos | null;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Lê o estado de pontos bônus do personagem (sem persistir). */
export function lerPontos(dados: Record<string, unknown>): EstadoPontos {
  const bruto = dados[CHAVE_PONTOS] as EstadoPontos | undefined;
  if (!bruto || typeof bruto !== "object") return { bonus: 0, historico: [], selo: null };
  const bonus = num(bruto.bonus);
  const historico = Array.isArray(bruto.historico)
    ? bruto.historico.filter((e) => e && typeof e === "object")
    : [];
  const selo = bruto.selo && typeof bruto.selo === "object" ? bruto.selo : null;
  return { bonus: bonus === null ? 0 : Math.trunc(bonus), historico, selo };
}

/** Bônus individual de pontos (pode ser negativo). */
export function bonusPontos(dados: Record<string, unknown>): number {
  return lerPontos(dados).bonus;
}

/**
 * Devolve `dados` com o selo de pontos aplicado (idempotente: preserva
 * bonus/histórico existentes e não sobrescreve um selo anterior).
 */
export function comSeloPontos(
  dados: Record<string, unknown>,
  autor: { id: string; nome: string | null }
): Record<string, unknown> {
  const estado = lerPontos(dados);
  if (estado.selo) return dados;
  return {
    ...dados,
    [CHAVE_PONTOS]: {
      ...estado,
      selo: { em: new Date().toISOString(), autorId: autor.id, autorNome: autor.nome },
    },
  };
}

/** O jogador pode alterar campos que afetam pontos nesta ficha? */
export function pontosSelados(dados: Record<string, unknown>): boolean {
  return lerPontos(dados).selo !== null;
}

/**
 * Aplica um delta no bônus individual registrando o evento no histórico.
 * `delta` positivo concede, negativo remove. Retorna os novos dados.
 */
export function aplicarBonusPontos(
  dados: Record<string, unknown>,
  delta: number,
  evento: { motivo: string; autorId: string; autorNome: string | null }
): { dados: Record<string, unknown>; estado: EstadoPontos } {
  const estado = lerPontos(dados);
  const novo: EstadoPontos = {
    bonus: estado.bonus + Math.trunc(delta),
    historico: [
      ...estado.historico,
      {
        em: new Date().toISOString(),
        quantidade: Math.trunc(delta),
        motivo: evento.motivo,
        autorId: evento.autorId,
        autorNome: evento.autorNome,
      },
    ].slice(-200),
    selo: estado.selo,
  };
  return { dados: { ...dados, [CHAVE_PONTOS]: novo }, estado: novo };
}
