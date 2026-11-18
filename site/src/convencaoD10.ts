/**
 * Convenção do D10 no cliente (Issue #147) — espelho de
 * servidor/src/lib/d10.ts. O valor interno oficial é 1–10; a face
 * exibida "0" corresponde ao interno 10 (acerto crítico, soma 10) e o
 * interno 1 é erro crítico mesmo com mínimo 1.
 */

export type ClasseD10 = "acerto_critico" | "erro_critico" | "acerto" | "erro";

export interface AvaliacaoDadoD10 {
  valor: number;
  face: number;
  classe: ClasseD10;
  sucesso: boolean;
}

export function classificarD10(valor: number, minimo: number): AvaliacaoDadoD10 {
  if (valor === 10) return { valor, face: 0, classe: "acerto_critico", sucesso: true };
  if (valor === 1) return { valor, face: 1, classe: "erro_critico", sucesso: false };
  const sucesso = valor >= minimo;
  return { valor, face: valor, classe: sucesso ? "acerto" : "erro", sucesso };
}

/** Face exibida de um valor interno de dado (só D10 usa o 0). */
export function faceExibida(lados: number, valor: number): number {
  return lados === 10 && valor === 10 ? 0 : valor;
}

export function rotuloClasseD10(classe: ClasseD10): string {
  switch (classe) {
    case "acerto_critico": return "acerto crítico";
    case "erro_critico": return "erro crítico";
    case "acerto": return "acerto";
    case "erro": return "erro";
  }
}

/** Mapeia a classe D10 para o efeito visual transitório do dado. */
export function efeitoDaClasse(classe: ClasseD10): "sucesso" | "falha" | "acerto_critico" | "erro_critico" {
  switch (classe) {
    case "acerto_critico": return "acerto_critico";
    case "erro_critico": return "erro_critico";
    case "acerto": return "sucesso";
    case "erro": return "falha";
  }
}

/** Duração do flash de resultado na mesa 3D (ms). */
export const EFEITO_RESULTADO_MS = 1400;

/** Estado visual transitório de um dado — nunca permanece após o efeito. */
export type EstadoEfeitoDado = "sucesso" | "falha" | "acerto_critico" | "erro_critico" | null;
