export const INICIATIVA_DADOS_MIN = 1;
export const INICIATIVA_DADOS_MAX = 10;

export interface ParticipanteIniciativa {
  atorId: string;
  nome: string;
}

export interface ResultadoIniciativa extends ParticipanteIniciativa {
  dados: number[];
  total: number;
}

export type RolarDadosIniciativa = (quantidade: number) => number[];

export function calcularIniciativa(
  participantes: readonly ParticipanteIniciativa[],
  dadosPorAtor: number,
  rolarD20: RolarDadosIniciativa,
): ResultadoIniciativa[] {
  if (!Number.isInteger(dadosPorAtor) || dadosPorAtor < INICIATIVA_DADOS_MIN || dadosPorAtor > INICIATIVA_DADOS_MAX) {
    throw new RangeError(`A iniciativa aceita de ${INICIATIVA_DADOS_MIN} a ${INICIATIVA_DADOS_MAX} dados d20`);
  }

  return participantes.map((participante) => {
    const dados = rolarD20(dadosPorAtor);
    if (dados.length !== dadosPorAtor || dados.some((resultado) => !Number.isInteger(resultado) || resultado < 1 || resultado > 20)) {
      throw new RangeError("A rolagem de iniciativa precisa produzir resultados entre 1 e 20");
    }
    return { ...participante, dados, total: dados.reduce((soma, resultado) => soma + resultado, 0) };
  }).sort((a, b) =>
    b.total - a.total
    || a.nome.localeCompare(b.nome, "pt-BR", { sensitivity: "base" })
    || a.atorId.localeCompare(b.atorId),
  );
}