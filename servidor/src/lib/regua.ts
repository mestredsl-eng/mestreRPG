/**
 * Régua de distância do VTT (Issue #125) — núcleo matemático puro.
 *
 * Tokens usam coordenadas normalizadas x,y ∈ [0,1]. A distância real do
 * jogo é obtida em dois passos:
 *
 *   1. `distanciaMapa` — euclidiana no espaço do mapa, corrigida pela
 *      proporção real (largura/altura das dimensões do mapa, NUNCA do
 *      viewport): d = sqrt(((x2-x1)*largura)² + ((y2-y1)*altura)²).
 *      O resultado está nas "unidades do mapa" (ex.: pixels da imagem).
 *   2. `distanciaReal` — calibração genérica: um segmento de referência
 *      conhecido (em unidades do mapa) equivale a um valor real na unidade
 *      escolhida; qualquer medida é convertida proporcionalmente.
 *      Isso mantém metros, polegadas, casas, hexágonos etc. fora da
 *      matemática — a unidade é apenas um rótulo textual.
 *
 * Nenhuma função aqui depende de zoom, tamanho de tela ou estado de UI:
 * redimensionar o viewport não altera nenhum resultado.
 */

export interface PontoNormalizado {
  x: number;
  y: number;
}

/** Dimensões do mapa na sua própria unidade (ex.: pixels da imagem). */
export interface DimensoesMapa {
  largura: number;
  altura: number;
}

/**
 * Calibração de escala: `distanciaReferencia` unidades do mapa equivalem
 * a `valorReferencia` da `unidade` textual (ex.: 100 px de mapa = 1,5 m).
 */
export interface CalibracaoRegua {
  unidade: string;
  distanciaReferencia: number;
  valorReferencia: number;
}

export type ResultadoRegua<T> = { ok: true; valor: T } | { ok: false; erro: string };

const UNIDADE_MAX = 24;

const numeroFinitoPositivo = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;

/** Ponto válido: x,y finitos dentro de [0,1]. */
export function pontoNormalizadoValido(p: unknown): p is PontoNormalizado {
  const o = p as PontoNormalizado | null;
  return !!o && typeof o === "object"
    && typeof o.x === "number" && Number.isFinite(o.x) && o.x >= 0 && o.x <= 1
    && typeof o.y === "number" && Number.isFinite(o.y) && o.y >= 0 && o.y <= 1;
}

/** Dimensões do mapa: largura/altura finitas e estritamente positivas. */
export function dimensoesMapaValidas(d: unknown): d is DimensoesMapa {
  const o = d as DimensoesMapa | null;
  return !!o && typeof o === "object"
    && numeroFinitoPositivo(o.largura)
    && numeroFinitoPositivo(o.altura);
}

/**
 * Distância euclidiana entre dois pontos normalizados, corrigida pela
 * proporção do mapa. Retorna unidades do mapa (mesma unidade das
 * dimensões recebidas). Erro quando entradas inválidas ou resultado
 * não-finito (overflow).
 */
export function distanciaMapa(
  a: PontoNormalizado,
  b: PontoNormalizado,
  dims: DimensoesMapa
): ResultadoRegua<number> {
  if (!pontoNormalizadoValido(a) || !pontoNormalizadoValido(b)) {
    return { ok: false, erro: "Pontos fora do intervalo normalizado [0,1]" };
  }
  if (!dimensoesMapaValidas(dims)) {
    return { ok: false, erro: "Dimensões do mapa inválidas" };
  }
  const dx = (b.x - a.x) * dims.largura;
  const dy = (b.y - a.y) * dims.altura;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (!Number.isFinite(d)) return { ok: false, erro: "Distância fora do intervalo representável" };
  return { ok: true, valor: d };
}

/**
 * Valida uma calibração: unidade textual não vazia (≤ UNIDADE_MAX após
 * trim), distância de referência e valor real estritamente positivos e
 * finitos.
 */
export function calibracaoValida(c: unknown): c is CalibracaoRegua {
  const o = c as CalibracaoRegua | null;
  if (!o || typeof o !== "object") return false;
  if (typeof o.unidade !== "string") return false;
  const u = o.unidade.trim();
  if (!u || u.length > UNIDADE_MAX) return false;
  return numeroFinitoPositivo(o.distanciaReferencia)
    && numeroFinitoPositivo(o.valorReferencia);
}

/**
 * Converte uma distância em unidades do mapa para a unidade da
 * calibração: real = dMapa / distanciaReferencia * valorReferencia.
 */
export function distanciaReal(dMapa: number, calibracao: CalibracaoRegua): ResultadoRegua<number> {
  if (!calibracaoValida(calibracao)) {
    return { ok: false, erro: "Calibração inválida" };
  }
  if (typeof dMapa !== "number" || !Number.isFinite(dMapa) || dMapa < 0) {
    return { ok: false, erro: "Distância em unidades do mapa inválida" };
  }
  const real = (dMapa / calibracao.distanciaReferencia) * calibracao.valorReferencia;
  if (!Number.isFinite(real)) return { ok: false, erro: "Distância convertida fora do intervalo representável" };
  return { ok: true, valor: real };
}

export interface MedidaRegua {
  /** Distância em unidades do mapa (pixels/dims recebidas). */
  distanciaMapa: number;
  /** Distância convertida pela calibração; null quando não calibrada. */
  distanciaReal: number | null;
  /** Rótulo da unidade da calibração; null quando não calibrada. */
  unidade: string | null;
}

/**
 * Pipeline completo: valida pontos + dimensões, calcula a distância no
 * mapa e, quando `calibracao` é informada e válida, converte para a
 * unidade real. Calibração inválida é erro (não ignora silenciosamente).
 */
export function medirRegua(
  a: PontoNormalizado,
  b: PontoNormalizado,
  dims: DimensoesMapa,
  calibracao?: CalibracaoRegua | null
): ResultadoRegua<MedidaRegua> {
  const dm = distanciaMapa(a, b, dims);
  if (!dm.ok) return dm;
  if (calibracao === undefined || calibracao === null) {
    return { ok: true, valor: { distanciaMapa: dm.valor, distanciaReal: null, unidade: null } };
  }
  const dr = distanciaReal(dm.valor, calibracao);
  if (!dr.ok) return dr;
  return {
    ok: true,
    valor: {
      distanciaMapa: dm.valor,
      distanciaReal: dr.valor,
      unidade: calibracao.unidade.trim(),
    },
  };
}

/**
 * Arredondamento exclusivo para apresentação. Nunca usar o resultado
 * para cálculos subsequentes — o valor interno permanece em float64.
 */
export function arredondarParaApresentacao(valor: number, casas = 2): number {
  if (!Number.isFinite(valor)) return valor;
  const f = 10 ** Math.max(0, Math.min(10, Math.floor(casas)));
  return Math.round(valor * f) / f;
}
