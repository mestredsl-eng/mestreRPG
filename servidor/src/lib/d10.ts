/**
 * Convenção oficial do D10 (Issue #147).
 *
 * O sorteio interno continua produzindo valores de 1 a 10
 * (`rolarLados(10, n)` → randomInt(1, 11)); a apresentação separa
 * valor interno, face exibida e classificação:
 *
 * - interno 10 → face exibida "0" → ACERTO CRÍTICO (sempre sucesso,
 *   contribui 10 para a soma);
 * - interno 1  → face exibida "1" → ERRO CRÍTICO (sempre falha, mesmo
 *   quando o mínimo da campanha é 1);
 * - internos 2–9 → sucesso quando valor >= mínimo da campanha.
 */

export type ClasseD10 = "acerto_critico" | "erro_critico" | "acerto" | "erro";

export interface AvaliacaoDadoD10 {
  /** valor interno oficial do servidor (1–10); 10 soma 10. */
  valor: number;
  /** face exibida: interno 10 aparece como 0. */
  face: number;
  classe: ClasseD10;
  /** compatibilidade com o contrato vigente: sucesso booleano por dado. */
  sucesso: boolean;
}

export interface AvaliacaoD10 {
  minimo: number;
  avaliacao: AvaliacaoDadoD10[];
  sucessos: number;
  falhas: number;
}

export function classificarD10(valor: number, minimo: number): AvaliacaoDadoD10 {
  if (valor === 10) {
    return { valor, face: 0, classe: "acerto_critico", sucesso: true };
  }
  if (valor === 1) {
    return { valor, face: 1, classe: "erro_critico", sucesso: false };
  }
  const sucesso = valor >= minimo;
  return { valor, face: valor, classe: sucesso ? "acerto" : "erro", sucesso };
}

/** Classifica todos os dados de um pool D10 com o mínimo autoritativo. */
export function avaliarD10(resultados: readonly number[], minimo: number): AvaliacaoD10 {
  const avaliacao = resultados.map((v) => classificarD10(v, minimo));
  return {
    minimo,
    avaliacao,
    sucessos: avaliacao.filter((a) => a.sucesso).length,
    falhas: avaliacao.filter((a) => !a.sucesso).length,
  };
}

/**
 * Total oficial de uma rolagem D10: o valor interno 10 contribui 10
 * (a face "0" é apenas apresentação). Mesma regra de `reduce` usada
 * para qualquer dado — mantida explícita para os testes de fixture.
 */
export function totalD10(valoresInternos: readonly number[]): number {
  return valoresInternos.reduce((soma, v) => soma + v, 0);
}

/** Faces exibidas de uma rolagem D10 (interno 10 → "0"). */
export function facesExibidasD10(valoresInternos: readonly number[]): number[] {
  return valoresInternos.map((v) => (v === 10 ? 0 : v));
}

/** Rótulo pt-BR da classe para o histórico de rolagens. */
export function rotuloClasseD10(classe: ClasseD10): string {
  switch (classe) {
    case "acerto_critico": return "acerto crítico";
    case "erro_critico": return "erro crítico";
    case "acerto": return "acerto";
    case "erro": return "erro";
  }
}

/** Resumo "0, 1, 4, 8" para o chat — faces exibidas, não valores internos. */
export function resumoFacesD10(valoresInternos: readonly number[]): string {
  return facesExibidasD10(valoresInternos).join(", ");
}

export { classificarD10 as classificarFaceD10 };
