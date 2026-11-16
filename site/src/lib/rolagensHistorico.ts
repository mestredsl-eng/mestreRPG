export interface DadoHistorico {
  sides: number;
  count: number;
}

export interface GrupoRolagemHistorico {
  sides?: number;
  lados?: number;
  count?: number;
  resultados?: number[];
}

export interface ResumoRolagemHistorico {
  descricao: string;
  valores: number[];
}

/**
 * Normaliza grupos do histórico HTTP (sides/count) e o formato legado
 * usado pelos eventos Socket.IO (lados/resultados).
 */
export function resumirRolagemHistorico(
  dice: readonly DadoHistorico[] = [],
  grupos: readonly GrupoRolagemHistorico[] = [],
): ResumoRolagemHistorico {
  const origem: readonly GrupoRolagemHistorico[] = grupos.length
    ? grupos
    : dice.map((d) => ({ sides: d.sides, count: d.count, resultados: [] }));

  const normalizados = origem.map((grupo, index) => {
    const lados = Number.isInteger(grupo.sides) && (grupo.sides ?? 0) > 0
      ? grupo.sides!
      : Number.isInteger(grupo.lados) && (grupo.lados ?? 0) > 0
        ? grupo.lados!
        : dice[index]?.sides ?? 0;
    const resultados = Array.isArray(grupo.resultados) ? grupo.resultados : [];
    const dadoCorrespondente = dice.find((d) => d.sides === lados);
    const quantidade = Number.isInteger(grupo.count) && (grupo.count ?? -1) >= 0
      ? grupo.count!
      : resultados.length || dadoCorrespondente?.count || 0;
    return { lados, quantidade, resultados };
  }).filter((grupo) => grupo.lados > 0 && grupo.quantidade > 0);

  return {
    descricao: normalizados.map((grupo) => `${grupo.quantidade}d${grupo.lados}`).join(" + "),
    valores: normalizados.flatMap((grupo) => grupo.resultados),
  };
}
