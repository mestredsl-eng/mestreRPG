/**
 * Pontos de Sangue — ledger e resolução de capacidade/natureza
 * (Issue #186, contratos v5 — comentários #7030908719/#7031431155).
 *
 * O estado vive em `characters.data.__sangue` — chave reservada:
 * `campoSchema` rejeita IDs `__*` e `validarFicha` descarta chaves
 * fora do modelo, então o PATCH comum da ficha NUNCA altera este
 * ledger (mesmo mecanismo de `__xp`, `__hp`, `__vitalidade`).
 *
 * Contrato do ledger (v5 — NÃO reabrir):
 *   __sangue.saldo      — saldo atual (nunca negativo)
 *   __sangue.capacidade — CACHE de exibição; nunca autoritativo
 *   __sangue.usos       — mapa de idempotência DURÁVEL, nunca
 *                         truncado. Chaves `d10:<uuid>`,
 *                         `ativar:<uuid>`, `recuperar:<uuid>`;
 *                         qualquer entrada malformada rejeita o
 *                         ledger inteiro (fail-closed).
 *   __sangue.historico  — display-only, cap MAX_HISTORICO_SANGUE +
 *                         âncora; NUNCA fonte de deduplicação.
 *
 * Este módulo é puro (sem banco/rotas): as decisões de regra
 * (custos, quantidades, permissões, fórmula de capacidade, mapa de
 * naturezas) chegam por `ConfigSangue` — nada é inventado aqui.
 */

import { mapaCampos, parseNumeroBR, type CampoDef, type EstruturaFicha } from "./ficha.js";

export const CHAVE_SANGUE = "__sangue";

/** Histórico de exibição — display-only, nunca dedup (padrão __xp). */
export const MAX_HISTORICO_SANGUE = 500;

/** Acima disso o servidor loga warning — gatilho declarado para
 *  migração futura a tabela dedicada (decisão de produto pendente). */
export const LIMITE_USOS_AVISO = 5000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHAVE_USO_RE = /^(d10|ativar|recuperar|ajustar):(.+)$/;

/**
 * Aritmética decimal exata para os valores de Sangue.
 *
 * Converte a representação decimal canônica dos Numbers (incluindo
 * expoentes) para coeficiente BigInt + escala. Isso evita resíduos como
 * 0.3 - 0.2 = 0.09999999999999998 sem impor uma quantidade arbitrária
 * de casas decimais à regra da campanha.
 */
interface DecimalSangue {
  coeficiente: bigint;
  escala: number;
}

function decomporDecimalSangue(valor: number): DecimalSangue | null {
  if (!Number.isFinite(valor)) return null;
  // Preserva a representação decimal mais curta que round-tripa para
  // Number. Não aplica snap para 15 dígitos: isso poderia apagar valores
  // IEEE válidos como 1.0000000000000002.
  const [mantissaOriginal, expoenteRaw] = valor.toString().toLowerCase().split("e");
  const expoente = expoenteRaw === undefined ? 0 : Number(expoenteRaw);
  const negativo = mantissaOriginal.startsWith("-");
  const mantissa = negativo ? mantissaOriginal.slice(1) : mantissaOriginal;
  const [inteiro = "0", fracao = ""] = mantissa.split(".");
  let coeficiente = BigInt(`${inteiro}${fracao}` || "0") * (negativo ? -1n : 1n);
  let escala = fracao.length - expoente;
  if (escala < 0) {
    coeficiente *= 10n ** BigInt(-escala);
    escala = 0;
  }
  while (escala > 0 && coeficiente % 10n === 0n) {
    coeficiente /= 10n;
    escala--;
  }
  return { coeficiente, escala };
}

function alinharDecimaisSangue(a: DecimalSangue, b: DecimalSangue): [bigint, bigint, number] {
  const escala = Math.max(a.escala, b.escala);
  return [
    a.coeficiente * 10n ** BigInt(escala - a.escala),
    b.coeficiente * 10n ** BigInt(escala - b.escala),
    escala,
  ];
}

function comporDecimalSangue(valor: DecimalSangue): number {
  if (valor.coeficiente === 0n) return 0;
  const negativo = valor.coeficiente < 0n;
  const digitos = (negativo ? -valor.coeficiente : valor.coeficiente).toString();
  const sinal = negativo ? "-" : "";
  const preenchido = valor.escala === 0
    ? `${sinal}${digitos}`
    : (() => {
        const zeros = digitos.padStart(valor.escala + 1, "0");
        const corte = zeros.length - valor.escala;
        return `${sinal}${zeros.slice(0, corte)}.${zeros.slice(corte)}`;
      })();
  const resultado = Number(preenchido);
  if (!Number.isFinite(resultado)) return NaN;

  // A composição precisa round-trip sem perda. Isso detecta tanto
  // overflow quanto underflow/subnormal arredondado (ex.: 1e-400 → 0).
  const refeito = decomporDecimalSangue(resultado);
  if (!refeito) return NaN;
  const [originalAlinhado, refeitoAlinhado] = alinharDecimaisSangue(valor, refeito);
  return originalAlinhado === refeitoAlinhado ? resultado : NaN;
}

/** Soma decimal sem resíduos binários. */
export function somarDecimalSangue(a: number, b: number): number {
  const da = decomporDecimalSangue(a);
  const db = decomporDecimalSangue(b);
  if (!da || !db) return a + b;
  const [ia, ib, escala] = alinharDecimaisSangue(da, db);
  return comporDecimalSangue({ coeficiente: ia + ib, escala });
}

/** Subtração decimal sem resíduos binários. */
export function subtrairDecimalSangue(a: number, b: number): number {
  const da = decomporDecimalSangue(a);
  const db = decomporDecimalSangue(b);
  if (!da || !db) return a - b;
  const [ia, ib, escala] = alinharDecimaisSangue(da, db);
  return comporDecimalSangue({ coeficiente: ia - ib, escala });
}

/** Multiplicação decimal sem resíduos binários intermediários. */
export function multiplicarDecimalSangue(a: number, b: number): number {
  const da = decomporDecimalSangue(a);
  const db = decomporDecimalSangue(b);
  if (!da || !db) return a * b;
  return comporDecimalSangue({
    coeficiente: da.coeficiente * db.coeficiente,
    escala: da.escala + db.escala,
  });
}

/** Comparação decimal; null indica que algum resultado não é representável. */
export function compararDecimalSangue(a: number, b: number): -1 | 0 | 1 | null {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const da = decomporDecimalSangue(a);
  const db = decomporDecimalSangue(b);
  if (!da || !db) return null;
  const [ia, ib] = alinharDecimaisSangue(da, db);
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/** Compara a+b com um limite sem converter a soma intermediária para Number. */
function compararSomaDecimalSangue(a: number, b: number, limite: number): -1 | 0 | 1 | null {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(limite)) return null;
  const da = decomporDecimalSangue(a);
  const db = decomporDecimalSangue(b);
  const dl = decomporDecimalSangue(limite);
  if (!da || !db || !dl) return null;
  const [ia, ib, escalaSoma] = alinharDecimaisSangue(da, db);
  const [soma, teto] = alinharDecimaisSangue(
    { coeficiente: ia + ib, escala: escalaSoma },
    dl,
  );
  return soma < teto ? -1 : soma > teto ? 1 : 0;
}

// ---------- Tipos ----------

export type TipoEventoSangue = "inicial" | "uso" | "recuperacao" | "ajuste";

export interface EventoSangue {
  em: string;
  tipo: TipoEventoSangue;
  /** Delta de saldo: positivo = entrou, negativo = saiu. */
  quantidade: number;
  motivo: string | null;
  autorId: string | null;
  autorNome: string | null;
  saldoResultante: number;
  /** Chave de idempotência que originou o evento (display). */
  usoId?: string;
}

/** Entrada do ledger de idempotência — schema discriminado por
 *  prefixo da chave (contrato v5 §1). */
export interface UsoSangue {
  tipo: "uso" | "recuperacao";
  em: string; // ISO-8601
  requestId?: string | null;
  personagemId: string;
  /** Somente prefixo d10: — deve igualar o sufixo da chave. */
  testId?: string;
  /** Somente prefixo ativar:. */
  poderKey?: string;
  /** Somente prefixo recuperar:. */
  quantidade?: number;
  /** Somente prefixo ajustar: — delta aplicado (fingerprint de
   *  payload: requestId reaproveitado com delta/motivo divergente
   *  é rejeitado como `uso_conflito`, nunca replay silencioso). */
  delta?: number;
  /** Somente prefixo ajustar: — motivo normalizado (trim) que faz
   *  parte do fingerprint de payload. */
  motivo?: string | null;
}

export interface EstadoSangue {
  saldo: number;
  /** Cache de exibição — recalculado a cada leitura; nunca
   *  autoritativo para autorizar gasto. */
  capacidade?: number;
  /** Idempotência durável — NUNCA truncado. */
  usos: Record<string, UsoSangue>;
  /** Display-only — cap MAX_HISTORICO_SANGUE + ancora. */
  historico: EventoSangue[];
  /** Saldo anterior ao primeiro evento retido quando o histórico
   *  foi truncado (mesma semântica da âncora de __xp). */
  ancora?: number;
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

const isoValida = (v: unknown): v is string =>
  typeof v === "string" && !Number.isNaN(Date.parse(v));

// ---------- Validação do ledger ----------

/** Valida UMA entrada de `usos` contra o contrato discriminado por
 *  prefixo. Retorna true somente se chave e metadados forem coerentes. */
export function usoSangueValido(chave: string, valor: unknown): boolean {
  const m = CHAVE_USO_RE.exec(chave);
  if (!m) return false;
  const prefixo = m[1] as "d10" | "ativar" | "recuperar" | "ajustar";
  const sufixo = m[2];
  if (!UUID_RE.test(sufixo)) return false;
  if (!valor || typeof valor !== "object" || Array.isArray(valor)) return false;
  const u = valor as Record<string, unknown>;

  // Campos comuns obrigatórios
  if (u.tipo !== (prefixo === "recuperar" ? "recuperacao" : "uso")) return false;
  if (!isoValida(u.em)) return false;
  if (typeof u.personagemId !== "string" || !UUID_RE.test(u.personagemId)) return false;

  if (prefixo === "d10") {
    // sufixo da chave É o testId
    if (u.testId !== sufixo) return false;
    if (u.requestId !== undefined && u.requestId !== null && typeof u.requestId !== "string") return false;
    return true;
  }
  if (prefixo === "ativar") {
    // requestId UUID obrigatório e é o próprio sufixo da operação
    // (o servidor deriva a chave de `ativar:<requestId>`).
    if (typeof u.requestId !== "string" || u.requestId.toLowerCase() !== sufixo.toLowerCase()) return false;
    if (typeof u.poderKey !== "string" || u.poderKey.length === 0 || u.poderKey.length > 80) return false;
    return true;
  }
  if (prefixo === "ajustar") {
    // requestId UUID obrigatório e é o próprio sufixo da operação
    // (o servidor deriva a chave de `ajustar:<requestId>`).
    if (typeof u.requestId !== "string" || u.requestId.toLowerCase() !== sufixo.toLowerCase()) return false;
    const d = num(u.delta);
    if (d === null || d === 0) return false;
    if (u.motivo !== undefined && u.motivo !== null && typeof u.motivo !== "string") return false;
    return true;
  }
  // recuperar:
  const q = num(u.quantidade);
  if (q === null || q <= 0) return false;
  return true;
}

/** Valida o objeto `usos` inteiro. Qualquer entrada malformada
 *  invalida o ledger COMPLETO — nunca se remove uma chave válida
 *  com metadados inválidos e se continua usando o saldo. */
export function usosSangueValidos(usos: unknown): usos is Record<string, UsoSangue> {
  if (!usos || typeof usos !== "object" || Array.isArray(usos)) return false;
  for (const [chave, valor] of Object.entries(usos as Record<string, unknown>)) {
    if (!usoSangueValido(chave, valor)) return false;
  }
  return true;
}

function eventoSangueValido(e: unknown): boolean {
  if (!e || typeof e !== "object" || Array.isArray(e)) return false;
  const ev = e as Record<string, unknown>;
  if (!isoValida(ev.em)) return false;
  if (!["inicial", "uso", "recuperacao", "ajuste"].includes(ev.tipo as string)) return false;
  if (num(ev.quantidade) === null || num(ev.saldoResultante) === null) return false;
  return true;
}

/**
 * Corrige somente ledgers cuja cadeia inteira comprova que o saldo foi
 * produzido pelo algoritmo binário anterior (Number + delta). Recalcula
 * a mesma cadeia em decimal exato. Se qualquer saldo de evento divergir,
 * mantém o saldo armazenado: não adivinha valores nem arredonda Number
 * legítimo. Para histórico truncado, começa pela âncora persistida.
 */
function saldoDecimalComprovadoPeloHistorico(
  saldoArmazenado: number,
  historico: EventoSangue[],
  ancora: number | undefined,
  usos: Record<string, UsoSangue>,
): number | null {
  if (historico.length === 0) return null;
  let saldoLegado = ancora ?? 0;
  let saldoDecimal = ancora ?? 0;
  // Uma âncora indica que o prefixo do histórico foi truncado. Em
  // versões antigas ela pode conter arredondamento binário; sem o prefixo
  // não há evidência para corrigir o saldo atual com segurança.
  // O mesmo vale para reconciliações/ajustes negativos antigos sem usoId.
  let reconstrucaoAmbigua = ancora !== undefined;
  for (const evento of historico) {
    const proximoLegado = saldoLegado + evento.quantidade;
    if (!Number.isFinite(proximoLegado) || proximoLegado !== evento.saldoResultante) {
      return null;
    }
    const proximoDecimal = somarDecimalSangue(saldoDecimal, evento.quantidade);
    if (!Number.isFinite(proximoDecimal)) return null;

    if (evento.tipo === "ajuste" && evento.quantidade < 0 && !evento.usoId && proximoDecimal !== evento.saldoResultante) {
      // Reconciliações históricas e ajustes negativos manuais sem usoId
      // podem carregar arredondamento binário que não é decimalmente
      // reversível. O snapshot ancora a cadeia e marca o restante do
      // histórico como ambíguo: no final preservamos saldoArmazenado.
      saldoDecimal = evento.saldoResultante;
      reconstrucaoAmbigua = true;
    } else if (evento.tipo === "recuperacao" && evento.quantidade === 0) {
      // Uma recuperação no teto grava quantidade zero por idempotência e
      // auditoria. Ela confirma o mesmo saldo legado, mas não desfaz uma
      // correção decimal comprovada por eventos anteriores.
      saldoLegado = proximoLegado;
      continue;
    } else if (evento.tipo === "recuperacao" && proximoDecimal !== evento.saldoResultante) {
      // Antes da aritmética decimal, créditos limitados pelo teto podiam
      // gravar um delta binário menor que o solicitado, embora o saldo
      // resultante fosse exatamente o teto. O uso durável guarda a
      // quantidade pedida; quando ela excede o delta aplicado, o snapshot
      // saldoResultante é a única fronteira inequívoca da cadeia antiga.
      const uso = evento.usoId ? usos[evento.usoId] : undefined;
      if (!uso || uso.tipo !== "recuperacao" || typeof uso.quantidade !== "number" || evento.quantidade <= 0) {
        return null; // sem prova do delta limitado: preservar saldo armazenado
      }
      const solicitadoVsAplicado = compararDecimalSangue(uso.quantidade, evento.quantidade);
      if (solicitadoVsAplicado === null || solicitadoVsAplicado < 0) return null;
      if (solicitadoVsAplicado > 0) {
        const saldoResultanteValido = compararDecimalSangue(evento.saldoResultante, saldoLegado);
        if (saldoResultanteValido === null || saldoResultanteValido < 0) return null;
        saldoDecimal = evento.saldoResultante;
        // A recuperação limitada, com uso durável e snapshot no teto,
        // estabelece um novo ponto de partida comprovado. A ambiguidade
        // anterior não deve contaminar débitos/créditos posteriores.
        reconstrucaoAmbigua = false;
      } else {
        // Crédito integral comprovado: a quantidade pedida coincide com o
        // delta durável, então a correção decimal normal continua segura.
        saldoDecimal = proximoDecimal;
      }
    } else {
      saldoDecimal = proximoDecimal;
    }
    saldoLegado = proximoLegado;
  }
  const saldoReconstruido = reconstrucaoAmbigua ? saldoArmazenado : saldoDecimal;
  const saldoNaoNegativo = compararDecimalSangue(saldoReconstruido, 0);
  if (saldoNaoNegativo === null || saldoNaoNegativo < 0) return null;
  return saldoLegado === saldoArmazenado ? saldoReconstruido : null;
}

/**
 * Lê `__sangue` de `characters.data`.
 *
 * Fail-closed: ledger malformado NÃO é silenciosamente zerado na
 * leitura — retorna `valido:false` para que o chamador decida
 * (rotas devem recusar mutação; importação descarta via sanearSangue).
 * Personagem sem `__sangue` → estado vazio válido (inicialização
 * preguiçosa — decisão de saldo inicial é do responsável).
 */
export function lerSangue(dados: Record<string, unknown>): {
  estado: EstadoSangue;
  valido: boolean;
  motivo?: string;
} {
  const vazio: EstadoSangue = { saldo: 0, usos: {}, historico: [] };
  const bruto = dados[CHAVE_SANGUE];
  if (bruto === undefined || bruto === null) return { estado: vazio, valido: true };
  if (typeof bruto !== "object" || Array.isArray(bruto)) {
    return { estado: vazio, valido: false, motivo: "sangue_nao_objeto" };
  }
  const b = bruto as Record<string, unknown>;
  const saldo = num(b.saldo);
  if (saldo === null || saldo < 0) {
    return { estado: vazio, valido: false, motivo: "saldo_invalido" };
  }
  if (b.capacidade !== undefined) {
    const cap = num(b.capacidade);
    if (cap === null || cap < 0) {
      return { estado: vazio, valido: false, motivo: "capacidade_invalida" };
    }
  }
  const capacidade = b.capacidade === undefined ? undefined : num(b.capacidade)!;
  if (!usosSangueValidos(b.usos ?? {})) {
    return { estado: vazio, valido: false, motivo: "usos_invalidos" };
  }
  if (b.historico !== undefined && !Array.isArray(b.historico)) {
    return { estado: vazio, valido: false, motivo: "historico_invalido" };
  }
  const historico = ((b.historico ?? []) as unknown[]).filter(eventoSangueValido) as EventoSangue[];
  const usos = (b.usos ?? {}) as Record<string, UsoSangue>;
  const ancora = num(b.ancora);
  const saldoReconstruido = saldoDecimalComprovadoPeloHistorico(
    saldo,
    historico,
    ancora !== null && ancora !== undefined && ancora >= 0 ? ancora : undefined,
    usos,
  );
  return {
    estado: {
      saldo: saldoReconstruido ?? saldo,
      ...(capacidade !== null && capacidade !== undefined ? { capacidade } : {}),
      usos,
      historico,
      ...(ancora !== null && ancora !== undefined && ancora >= 0 ? { ancora } : {}),
    },
    valido: true,
  };
}

export function saldoSangue(dados: Record<string, unknown>): number {
  return lerSangue(dados).estado.saldo;
}

// ---------- Mutações (executadas dentro da transação do chamador) ----------

export type CodigoErroSangue =
  | "sangue_invalido"
  | "uso_invalido"
  | "uso_conflito"
  | "saldo_insuficiente"
  | "recuperacao_desabilitada"
  | "quantidade_invalida";

export type ResultadoSangue =
  | { ok: true; dados: Record<string, unknown>; estado: EstadoSangue; jaRegistrado?: boolean }
  | { ok: false; codigo: CodigoErroSangue; saldo?: number; motivo?: string };

interface ContextoEvento {
  personagemId: string;
  autorId: string | null;
  autorNome: string | null;
  motivo?: string | null;
}

function truncarHistorico(historico: EventoSangue[]): {
  historico: EventoSangue[];
  ancora: number | undefined;
} {
  const truncado = historico.length > MAX_HISTORICO_SANGUE;
  const lista = truncado ? historico.slice(-MAX_HISTORICO_SANGUE) : historico;
  // Mesma regra da âncora de __xp: saldo anterior ao primeiro evento
  // retido = saldoResultante - quantidade do primeiro evento da janela.
  const ancora = truncado
    ? subtrairDecimalSangue(lista[0].saldoResultante, lista[0].quantidade)
    : undefined;
  return { historico: lista, ancora };
}

function avisoUsos(usos: Record<string, UsoSangue>): void {
  const n = Object.keys(usos).length;
  if (n > LIMITE_USOS_AVISO) {
    // Observável mas não destrutivo: nunca apagar entradas de
    // idempotência. O gatilho de migração p/ tabela dedicada é
    // decisão futura declarada na especificação v5.
    console.warn(
      `[sangue] personagem possui ${n} usos (> ${LIMITE_USOS_AVISO}) — ` +
        `avaliar migração do ledger para tabela dedicada`,
    );
  }
}

/** Núcleo comum: valida ledger, aplica delta e evento, preserva
 *  `usos` (idempotência) e `capacidade` (cache). */
function aplicarDelta(
  dados: Record<string, unknown>,
  delta: number,
  tipoEvento: TipoEventoSangue,
  ctx: ContextoEvento & { usoId?: string },
): ResultadoSangue {
  const lido = lerSangue(dados);
  if (!lido.valido) {
    return { ok: false, codigo: "sangue_invalido", motivo: lido.motivo };
  }
  return aplicarDeltaComEstado(dados, lido.estado, delta, tipoEvento, ctx);
}

/**
 * Núcleo de idempotência: registra `usoId` no ledger `usos` e aplica
 * o delta. Se a chave já existe para o MESMO personagem → replay:
 * retorna o estado atual sem novo débito/crédito. Se existe para
 * OUTRO personagem/teste → erro de integridade.
 */
function registrarOperacao(
  dados: Record<string, unknown>,
  params: {
    usoId: string;
    tipoUso: "uso" | "recuperacao";
    delta: number; // negativo = débito, positivo = crédito
    tipoEvento: TipoEventoSangue;
    personagemId: string;
    requestId?: string | null;
    extra?: Partial<UsoSangue>;
    capacidadeMax?: number | null;
    ctx: ContextoEvento;
  },
): ResultadoSangue {
  const lido = lerSangue(dados);
  if (!lido.valido) {
    return { ok: false, codigo: "sangue_invalido", motivo: lido.motivo };
  }
  const estado = lido.estado;

  const existente = estado.usos[params.usoId];
  if (existente) {
    if (existente.personagemId !== params.personagemId) {
      return { ok: false, codigo: "uso_conflito" };
    }
    // Ativação de Poder tem fingerprint de payload: o mesmo
    // personagem/requestId só é replay quando poderKey também
    // corresponde. RequestId reutilizado para outro Poder é conflito,
    // nunca replay silencioso. Entradas antigas válidas já exigem
    // poderKey no schema de `ativar:`, portanto seguem compatíveis.
    if (
      params.extra?.poderKey !== undefined &&
      existente.poderKey !== params.extra.poderKey
    ) {
      return { ok: false, codigo: "uso_conflito" };
    }
    // Replay idempotente: mesmo usoId/personagem/payload → nada muda.
    return { ok: true, dados, estado, jaRegistrado: true };
  }

  // Débito nunca excede saldo; crédito nunca excede a capacidade
  // quando ela é conhecida (capacidadeMax resolvida pelo chamador
  // a partir da versão da ficha — nunca inventada aqui).
  // IMPORTANTE (R1/P1): mesmo quando o delta efetivo é 0 (saldo no
  // teto), a operação DEVE gravar usos[usoId] — caso contrário um
  // retry posterior, após a capacidade liberar espaço, creditaria
  // de novo o mesmo requestId. O uso é registrado sempre; o delta
  // efetivo (possivelmente 0) vai para o histórico.
  // `-0` (de `-custo` com custo 0) é normalizado para `0` — o evento
  // de histórico deve registrar quantidade neutra, não negativa-zero.
  let delta = params.delta === 0 ? 0 : params.delta;
  if (delta > 0 && typeof params.capacidadeMax === "number" && Number.isFinite(params.capacidadeMax)) {
    // Compare saldo + crédito com o teto em coeficiente/escala. Não
    // converta o espaço restante para Number antes de saber que haverá
    // clamp: um espaço não representável não invalida um crédito integral
    // que produz saldo final válido abaixo do teto.
    const acimaDoTeto = compararSomaDecimalSangue(estado.saldo, delta, params.capacidadeMax);
    if (acimaDoTeto === null) {
      return { ok: false, codigo: "quantidade_invalida", motivo: "comparação de capacidade não representável" };
    }
    if (acimaDoTeto > 0) {
      const saldoVsTeto = compararDecimalSangue(estado.saldo, params.capacidadeMax);
      if (saldoVsTeto === null) {
        return { ok: false, codigo: "quantidade_invalida", motivo: "comparação do saldo com a capacidade não representável" };
      }
      if (saldoVsTeto >= 0) {
        delta = 0;
      } else {
        // Só materializa a diferença quando ela será o delta efetivamente
        // creditado. Se essa quantidade não puder ser representada sem
        // perda, falha sem consumir o requestId.
        const espacoEfetivo = subtrairDecimalSangue(params.capacidadeMax, estado.saldo);
        const espacoPositivo = compararDecimalSangue(espacoEfetivo, 0);
        if (!Number.isFinite(espacoEfetivo) || espacoPositivo === null || espacoPositivo <= 0) {
          return { ok: false, codigo: "quantidade_invalida", motivo: "espaço de clamp não representável" };
        }
        delta = espacoEfetivo;
      }
    }
  }
  if (delta < 0) {
    const excedeSaldo = compararDecimalSangue(-delta, estado.saldo);
    if (excedeSaldo === null) {
      return { ok: false, codigo: "quantidade_invalida", motivo: "comparação de saldo não representável" };
    }
    if (excedeSaldo > 0) return { ok: false, codigo: "saldo_insuficiente", saldo: estado.saldo };
  }

  const uso: UsoSangue = {
    tipo: params.tipoUso,
    em: new Date().toISOString(),
    ...(params.requestId !== undefined ? { requestId: params.requestId } : {}),
    personagemId: params.personagemId,
    ...(params.extra ?? {}),
  };
  if (!usoSangueValido(params.usoId, uso)) {
    return { ok: false, codigo: "uso_invalido", motivo: params.usoId };
  }

  const usos = { ...estado.usos, [params.usoId]: uso };
  const estadoComUso: EstadoSangue = { ...estado, usos };

  const aplicado = aplicarDeltaComEstado(dados, estadoComUso, delta, params.tipoEvento, {
    ...params.ctx,
    usoId: params.usoId,
  });
  if (!aplicado.ok) return aplicado;
  avisoUsos(usos);
  return aplicado;
}

/** Variante de aplicarDelta que parte de um EstadoSangue já
 *  modificado (usos), evitando dupla leitura. */
function aplicarDeltaComEstado(
  dados: Record<string, unknown>,
  estado: EstadoSangue,
  delta: number,
  tipoEvento: TipoEventoSangue,
  ctx: ContextoEvento & { usoId?: string },
): ResultadoSangue {
  const saldo = somarDecimalSangue(estado.saldo, delta);
  if (!Number.isFinite(saldo)) return { ok: false, codigo: "quantidade_invalida", saldo: estado.saldo };
  const saldoNegativo = compararDecimalSangue(saldo, 0);
  if (saldoNegativo === null) return { ok: false, codigo: "quantidade_invalida", saldo: estado.saldo };
  if (saldoNegativo < 0) return { ok: false, codigo: "saldo_insuficiente", saldo: estado.saldo };
  const historicoNovo: EventoSangue[] = [
    ...estado.historico,
    {
      em: new Date().toISOString(),
      tipo: tipoEvento,
      quantidade: delta,
      motivo: ctx.motivo?.trim() || null,
      autorId: ctx.autorId,
      autorNome: ctx.autorNome,
      saldoResultante: saldo,
      ...(ctx.usoId ? { usoId: ctx.usoId } : {}),
    },
  ];
  const { historico, ancora } = truncarHistorico(historicoNovo);
  const novo: EstadoSangue = {
    saldo,
    ...(estado.capacidade !== undefined ? { capacidade: estado.capacidade } : {}),
    usos: estado.usos,
    historico,
    // R2/P2: a âncora é persistida sempre que o truncamento a
    // produziu — inclusive quando o valor correto é 0 (saldo que
    // cresceu de zero dentro da janela). Omitir 0 apagaria a prova
    // de que o histórico foi truncado.
    ...(ancora !== undefined && ancora >= 0
      ? { ancora }
      : estado.ancora !== undefined
        ? { ancora: estado.ancora }
        : {}),
  };
  return { ok: true, dados: { ...dados, [CHAVE_SANGUE]: novo }, estado: novo };
}

// ---------- Operações públicas ----------

export interface ParamsUsoSangue extends ContextoEvento {
  /** Custo em PS resolvido pelo servidor (nunca do cliente). */
  custo: number;
}

/** Débito via teste D10 — `usoId = "d10:" + testId` (v5 §2).
 *  A transição `tests.status` e este débito devem ocorrer na MESMA
 *  transação do handler (C6) — esta função só toca `characters.data`.
 *
 *  `custo` deve ser resolvido pelo CHAMADOR a partir da configuração
 *  autoritativa (`config.sangue.poderes[key].custo`): entrada ausente
 *  ou custo zero = Poder gratuito → o chamador passa `custo: 0`.
 *  Esta primitiva NÃO aceita custo omitido/undefined — a resolução
 *  de "sem custo configurado" é responsabilidade do runtime, para
 *  que a decisão de gratuidade fique auditável na camada de config.
 *  Custo zero ainda registra `usos["d10:<testId>"]` e um evento de
 *  histórico com `quantidade: 0` — o registro durável é o que torna
 *  o retry idempotente; como `usos` é consultado antes de qualquer
 *  débito, um replay nunca pode cobrar depois (não há caminho que
 *  "reabra" o uso para cobrança). */
export function registrarUsoD10(
  dados: Record<string, unknown>,
  params: ParamsUsoSangue & { testId: string; requestId?: string | null },
): ResultadoSangue {
  if (!UUID_RE.test(params.testId)) return { ok: false, codigo: "uso_invalido" };
  if (!Number.isFinite(params.custo) || params.custo < 0) {
    return { ok: false, codigo: "quantidade_invalida" };
  }
  return registrarOperacao(dados, {
    usoId: `d10:${params.testId.toLowerCase()}`,
    tipoUso: "uso",
    delta: -params.custo,
    tipoEvento: "uso",
    personagemId: params.personagemId,
    requestId: params.requestId ?? null,
    extra: { testId: params.testId.toLowerCase() },
    ctx: params,
  });
}

/** Ativação narrativa de Poder — `usoId = "ativar:" + requestId`.
 *  `requestId` é UUID obrigatório gerado pelo cliente (contrato v5). */
export function registrarAtivacaoSangue(
  dados: Record<string, unknown>,
  params: ParamsUsoSangue & { poderKey: string; requestId: string },
): ResultadoSangue {
  const requestId = params.requestId;
  if (typeof requestId !== "string" || !UUID_RE.test(requestId)) {
    return { ok: false, codigo: "uso_invalido", motivo: "requestId deve ser UUID" };
  }
  if (!params.poderKey || params.poderKey.length > 80) {
    return { ok: false, codigo: "uso_invalido", motivo: "poderKey inválida" };
  }
  if (!Number.isFinite(params.custo) || params.custo < 0) {
    return { ok: false, codigo: "quantidade_invalida" };
  }
  // Custo zero = poder gratuito: registra o uso sem débito (delta 0
  // ainda gera evento auditável? Não — uso gratuito não move saldo;
  // o ledger registra a operação para idempotência mesmo com custo 0).
  return registrarOperacao(dados, {
    usoId: `ativar:${requestId.toLowerCase()}`,
    tipoUso: "uso",
    delta: -params.custo,
    tipoEvento: "uso",
    personagemId: params.personagemId,
    requestId,
    extra: { poderKey: params.poderKey },
    ctx: params,
  });
}

/** Recuperação (Descansar/Alimentar-se) — `usoId = "recuperar:" + requestId`.
 *  Só é aceita quando a campanha habilita recuperação
 *  (`config.sangue.recuperacaoSangue.habilitado`) — o chamador passa
 *  `habilitada`; entradas `recuperar:` em pacotes importados sem a
 *  flag são descartadas pelo saneamento (v5 §1).
 *  `capacidadeMax` (opcional, resolvida pela versão da ficha):
 *  recuperação nunca deixa saldo acima da capacidade conhecida. */
export function registrarRecuperacaoSangue(
  dados: Record<string, unknown>,
  params: ContextoEvento & {
    requestId: string;
    quantidade: number;
    habilitada: boolean;
    capacidadeMax?: number | null;
  },
): ResultadoSangue {
  if (!params.habilitada) return { ok: false, codigo: "recuperacao_desabilitada" };
  const requestId = params.requestId;
  if (typeof requestId !== "string" || !UUID_RE.test(requestId)) {
    return { ok: false, codigo: "uso_invalido", motivo: "requestId deve ser UUID" };
  }
  if (!Number.isFinite(params.quantidade) || params.quantidade <= 0) {
    return { ok: false, codigo: "quantidade_invalida" };
  }
  return registrarOperacao(dados, {
    usoId: `recuperar:${requestId.toLowerCase()}`,
    tipoUso: "recuperacao",
    delta: params.quantidade,
    tipoEvento: "recuperacao",
    personagemId: params.personagemId,
    requestId,
    extra: { quantidade: params.quantidade },
    capacidadeMax: params.capacidadeMax,
    ctx: params,
  });
}

/** Ajuste administrativo de saldo (mestre) — exige motivo.
 *  Sem `requestId` não cria entrada em `usos` (uso interno, ex.:
 *  reconciliação de capacidade). Com `requestId` UUID (contrato do
 *  socket R6.3) registra `usos["ajustar:<uuid>"]` DENTRO da mesma
 *  transação do chamador: retry do mesmo requestId com o mesmo
 *  payload (delta+motivo) retorna `jaRegistrado` sem novo delta;
 *  requestId reaproveitado com payload divergente → `uso_conflito`.
 *  Usado para correções e, se aprovado, para o tratamento de
 *  redução de capacidade (decisão D4 pendente — sem clamp automático
 *  para zero nesta etapa). */
export function registrarAjusteSangue(
  dados: Record<string, unknown>,
  params: ContextoEvento & { delta: number; requestId?: string | null },
): ResultadoSangue {
  if (!Number.isFinite(params.delta) || params.delta === 0) {
    return { ok: false, codigo: "quantidade_invalida" };
  }
  if (!params.motivo?.trim()) {
    return { ok: false, codigo: "quantidade_invalida", motivo: "ajuste exige motivo" };
  }
  const requestId = params.requestId ?? null;
  if (requestId !== null && (typeof requestId !== "string" || !UUID_RE.test(requestId))) {
    return { ok: false, codigo: "uso_invalido" };
  }
  if (requestId === null) {
    return aplicarDelta(dados, params.delta, "ajuste", params);
  }
  // Dedup durável: o uso é verificado ANTES de aplicar — mesmo
  // requestId + mesmo fingerprint → replay; fingerprint divergente
  // → conflito estável (o ACK perdido + retry nunca duplica delta).
  const usoId = `ajustar:${requestId.toLowerCase()}`;
  const lido = lerSangue(dados);
  if (!lido.valido) {
    return { ok: false, codigo: "sangue_invalido", motivo: lido.motivo };
  }
  const existente = lido.estado.usos[usoId];
  if (existente) {
    if (existente.personagemId !== params.personagemId) {
      return { ok: false, codigo: "uso_conflito" };
    }
    const motivoNorm = params.motivo?.trim() || null;
    if (existente.delta !== params.delta || (existente.motivo ?? null) !== motivoNorm) {
      return { ok: false, codigo: "uso_conflito" };
    }
    return { ok: true, dados, estado: lido.estado, jaRegistrado: true };
  }
  return registrarOperacao(dados, {
    usoId,
    tipoUso: "uso",
    delta: params.delta,
    tipoEvento: "ajuste",
    personagemId: params.personagemId,
    requestId,
    extra: { delta: params.delta, motivo: params.motivo?.trim() || null },
    ctx: params,
  });
}

/** Resultado da reconciliação de capacidade — `ajustado` informa se
 *  um ajuste de saldo foi efetivamente registrado neste chamado. */
export type ResultadoReconciliacaoSangue =
  | { ok: true; dados: Record<string, unknown>; estado: EstadoSangue; ajustado: boolean }
  | { ok: false; codigo: CodigoErroSangue; saldo?: number; motivo?: string };

/**
 * Reconciliação de capacidade reduzida (decisão #7055515759, item 1).
 *
 * Quando a capacidade recém-resolvida e VALIDADA pelo chamador
 * (`resolverCapacidadeSangue` sobre a versão da ficha) fica ABAIXO do
 * saldo atual, registra um ajuste negativo auditável até o teto —
 * nunca apaga histórico, nunca zera saldo silenciosamente.
 *
 * Regras (todas fail-closed, nenhuma regra numérica inventada):
 *  - `capacidadeNova` ausente/null/não finita/negativa → NO-OP
 *    (`ajustado:false`, dados retornados sem mutação). Capacidade
 *    desconhecida nunca gera ajuste.
 *  - `saldo <= capacidadeNova` → NO-OP (`ajustado:false`).
 *  - `saldo > capacidadeNova` → `registrarAjusteSangue` com delta
 *    `capacidadeNova - saldo` (exatamente até o teto, nunca abaixo).
 *    Exige `motivo` não vazio — o runtime deve passar a razão da
 *    redução (ex.: "Capacidade reduzida de 10 para 6"); sem motivo a
 *    função recusa com `quantidade_invalida` em vez de gravar ajuste
 *    não auditável.
 *
 * O resultado também atualiza o cache `estado.capacidade` quando o
 * ajuste ocorre. A gravação em `characters.data` deve ocorrer dentro
 * da transação síncrona do chamador (C6) — esta função é pura e só
 * toca o objeto `dados`.
 */
export function reconciliarCapacidadeSangue(
  dados: Record<string, unknown>,
  params: ContextoEvento & { capacidadeNova?: number | null },
): ResultadoReconciliacaoSangue {
  const cap = params.capacidadeNova;
  if (cap === undefined || cap === null || !Number.isFinite(cap) || cap < 0) {
    const lido = lerSangue(dados);
    if (!lido.valido) {
      return { ok: false, codigo: "sangue_invalido", motivo: lido.motivo };
    }
    return { ok: true, dados, estado: lido.estado, ajustado: false };
  }
  const lido = lerSangue(dados);
  if (!lido.valido) {
    return { ok: false, codigo: "sangue_invalido", motivo: lido.motivo };
  }
  const estado = lido.estado;
  const saldoVsCapacidade = compararDecimalSangue(estado.saldo, cap);
  if (saldoVsCapacidade === null) {
    return { ok: false, codigo: "quantidade_invalida", motivo: "comparação de capacidade não representável" };
  }
  if (saldoVsCapacidade <= 0) return { ok: true, dados, estado, ajustado: false };
  const ajuste = registrarAjusteSangue(dados, {
    personagemId: params.personagemId,
    autorId: params.autorId,
    autorNome: params.autorNome,
    motivo: params.motivo,
    delta: subtrairDecimalSangue(cap, estado.saldo),
  });
  if (!ajuste.ok) return ajuste;
  // Atualiza o cache de capacidade junto — a leitura seguinte já
  // reflete o teto novo sem esperar novo round-trip de ficha.
  const dadosAjustados = gravarCacheCapacidade(ajuste.dados, cap);
  const relido = lerSangue(dadosAjustados);
  if (!relido.valido) {
    return { ok: false, codigo: "sangue_invalido", motivo: relido.motivo };
  }
  return { ok: true, dados: dadosAjustados, estado: relido.estado, ajustado: true };
}

/** Grava o cache de exibição `__sangue.capacidade` — nunca altera
 *  saldo/usos/histórico. Chamado por rotas de leitura após resolver
 *  a capacidade pela versão da ficha. */
export function gravarCacheCapacidade(
  dados: Record<string, unknown>,
  capacidade: number | null,
): Record<string, unknown> {
  const lido = lerSangue(dados);
  if (!lido.valido || capacidade === null || !Number.isFinite(capacidade) || capacidade < 0) {
    return dados;
  }
  const estado: EstadoSangue = { ...lido.estado, capacidade };
  return { ...dados, [CHAVE_SANGUE]: estado };
}

// ---------- C4: resolução de capacidade e natureza ----------

/**
 * Configuração `sangue` — vive em `rule_sets.config.sangue` (schema
 * Zod é adicionado em C1/regras.ts; aqui o tipo é estrutural para
 * manter este módulo independente). TODOS os campos são opcionais:
 * config ausente/inválida ⇒ recurso desabilitado para o personagem
 * (fail-closed), nunca erro global.
 *
 * Decisões de regra pendentes (NÃO inventar):
 *  - D3: fórmula de capacidade e bônus de Chacra — o bloco
 *    `capacidade` abaixo é o ponto de extensão já preparado;
 *  - D2: valores exatos do mapa `naturezas`.
 */
export interface ConfigNaturezaSangue {
  /** true somente quando a natureza é explicitamente mapeada como
   *  humana E a regra aprovada diz que humano+Poder ⇒ Meta humano. */
  metaHumanoComPoder?: boolean;
  /** Rótulo da ação de recuperação da campanha (ex.: "descansar",
   *  "alimentar-se") — string opaca, o sistema não interpreta. */
  recuperacao?: string;
}

export interface ConfigCapacidadeSangue {
  /** Como extrair o número do campo de capacidade:
   *   "valor"      — campo numérico (inteiro/decimal/moeda) lido direto;
   *   "somaNiveis" — campo selecao_nivel/selecao_multipla/lista:
   *                  soma dos `nivel` dos elementos selecionados;
   *   "mapa"       — campo selecao_unica/lista: rótulo → número via
   *                  `mapa` abaixo.
   *  Default quando omitido: inferido do tipo do campo
   *  (numérico→valor, selecao_nivel→somaNiveis,
   *   selecao_unica/lista→mapa). */
  modo?: "valor" | "somaNiveis" | "mapa";
  /** modo "mapa": rótulo do campo → capacidade. */
  mapa?: Record<string, number>;
  /** Bônus opcional por Qualidade (ex.: Chacra) — PREPARADO para D3,
   *  sem coeficiente inventado: só aplica se `coeficiente` for
   *  explicitamente configurado pela campanha. */
  bonusQualidade?: {
    campoId?: string;
    coeficiente?: number;
    modo?: "valor" | "somaNiveis" | "mapa";
    mapa?: Record<string, number>;
  };
}

export interface ConfigSangue {
  habilitado?: boolean;
  /** ID do campo da ficha que fornece a capacidade-base. */
  campoCapacidadeId?: string;
  /** ID do campo da ficha que fornece a natureza/espécie. */
  campoNaturezaId?: string;
  capacidade?: ConfigCapacidadeSangue;
  /** Rótulo do campo natureza → regras da natureza. Rótulos são da
   *  campanha — o servidor nunca compara nomes fixos. */
  naturezas?: Record<string, ConfigNaturezaSangue>;
  /** Flag de produto: recuperação (Descansar/Alimentar-se) habilitada.
   *  Controla tanto a aceitação de `recuperar:` na importação quanto
   *  a disponibilidade da ação — ver v5 §1. */
  recuperacaoSangue?: { habilitado?: boolean };
}

export type MotivoIndisponivelSangue =
  | "desabilitado"
  | "config_invalida"
  | "campo_inexistente"
  | "valor_invalido"
  | "natureza_desconhecida";

export interface ResolucaoCapacidade {
  disponivel: boolean;
  motivo?: MotivoIndisponivelSangue;
  /** Capacidade resolvida (null quando indisponível). */
  capacidade: number | null;
  /** Detalhe para auditoria/UI (nunca expõe dados ocultos além do
   *  necessário — o chamador aplica o filtro de visibilidade). */
  detalhe?: { campoId: string; bruto: unknown; modo: string };
}

export interface ResolucaoNatureza {
  disponivel: boolean;
  motivo?: MotivoIndisponivelSangue;
  /** Rótulo cru lido do campo (null se ausente/vazio). */
  rotulo: string | null;
  /** Entrada mapeada em config.naturezas (null se não mapeada). */
  natureza: ConfigNaturezaSangue | null;
  /** true SOMENTE quando a natureza está explicitamente mapeada e
   *  declara metaHumanoComPoder — nunca por inferência ou default. */
  metaHumanoComPoder: boolean;
}

function campoDaEstrutura(estrutura: EstruturaFicha, campoId: string | undefined): CampoDef | null {
  if (!campoId) return null;
  return mapaCampos(estrutura).get(campoId) ?? null;
}

/** Extrai rótulo textual de um valor de campo de seleção. */
function rotuloDeSelecao(valor: unknown): string | null {
  if (typeof valor === "string" && valor.trim()) return valor.trim();
  if (Array.isArray(valor)) {
    for (const item of valor) {
      if (typeof item === "string" && item.trim()) return item.trim();
      if (item && typeof item === "object") {
        const key = (item as Record<string, unknown>).key;
        if (typeof key === "string" && key.trim()) return key.trim();
      }
    }
  }
  return null;
}

/** Extrai número de um valor de campo conforme o modo. */
function numeroDoCampo(
  campo: CampoDef,
  valor: unknown,
  modo: "valor" | "somaNiveis" | "mapa",
  mapa?: Record<string, number>,
): number | null {
  if (modo === "mapa") {
    const rotulo = rotuloDeSelecao(valor);
    if (rotulo === null) return null;
    const n = mapa?.[rotulo];
    return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
  }
  if (modo === "somaNiveis") {
    // selecao_nivel/selecao_multipla/lista: soma dos níveis
    // (elementos sem `nivel` contam como 0 — a regra de nível é do
    // campo, não inventamos peso).
    if (!Array.isArray(valor)) return null;
    let soma = 0;
    let algum = false;
    for (const item of valor) {
      if (!item || typeof item !== "object") continue;
      const nivel = num((item as Record<string, unknown>).nivel);
      if (nivel !== null) {
        soma = somarDecimalSangue(soma, nivel);
        if (!Number.isFinite(soma)) return null;
        algum = true;
      }
    }
    return algum ? soma : null;
  }
  // modo "valor": numérico direto
  const n = parseNumeroBR(valor);
  return n !== null && n >= 0 ? n : null;
}

function modoInferido(campo: CampoDef): "valor" | "somaNiveis" | "mapa" {
  if (campo.tipo === "inteiro" || campo.tipo === "decimal" || campo.tipo === "moeda") return "valor";
  if (campo.tipo === "selecao_nivel") return "somaNiveis";
  return "mapa";
}

/**
 * Resolve a capacidade de Pontos de Sangue do personagem.
 *
 * Regras (v5/C4):
 *  - `config` ausente ou `habilitado !== true` → indisponível;
 *  - `campoCapacidadeId` ausente ou campo inexistente NA ESTRUTURA
 *    DAQUELE templateVersionId → indisponível (fail-closed, saldo
 *    preservado — nunca converte ausência em zeragem);
 *  - valor do campo inválido para o modo → indisponível;
 *  - bônus de Qualidade só entra quando `bonusQualidade` está
 *    explicitamente configurado (coeficiente da campanha — D3
 *    pendente; sem coeficiente configurado, bônus = 0).
 */
export function resolverCapacidadeSangue(
  estrutura: EstruturaFicha,
  dados: Record<string, unknown>,
  config: ConfigSangue | null | undefined,
): ResolucaoCapacidade {
  if (!config || config.habilitado !== true) {
    return { disponivel: false, motivo: "desabilitado", capacidade: null };
  }
  const campoId = config.campoCapacidadeId;
  const campo = campoDaEstrutura(estrutura, campoId);
  if (!campoId || !campo) {
    return { disponivel: false, motivo: "campo_inexistente", capacidade: null };
  }
  const cfgCap = config.capacidade ?? {};
  const modo = cfgCap.modo ?? modoInferido(campo);
  const bruto = dados[campoId];
  let base = numeroDoCampo(campo, bruto, modo, cfgCap.mapa);
  if (base === null) {
    return {
      disponivel: false,
      motivo: "valor_invalido",
      capacidade: null,
      detalhe: { campoId, bruto, modo },
    };
  }

  // Bônus de Qualidade (Chacra) — ponto de extensão preparado para
  // D3: só computa quando `bonusQualidade` está configurado.
  // R3/P2: configuração ATIVA de bônus é validada de forma
  // fail-closed — coeficiente deve ser finito e >= 0, campoId é
  // obrigatório e deve existir na estrutura DESTA versão de ficha,
  // modo "mapa" exige `mapa`, e o valor extraído não pode ser
  // negativo. Qualquer violação torna a capacidade indisponível
  // para o personagem (sem inventar bônus nem reduzir a base).
  let bonus = 0;
  const bq = cfgCap.bonusQualidade;
  const bqAtivo =
    bq !== undefined &&
    (bq.campoId !== undefined ||
      bq.coeficiente !== undefined ||
      bq.modo !== undefined ||
      bq.mapa !== undefined);
  if (bqAtivo) {
    const configInvalida = (): ResolucaoCapacidade => ({
      disponivel: false,
      motivo: "config_invalida",
      capacidade: null,
      detalhe: { campoId, bruto, modo },
    });
    if (
      typeof bq?.coeficiente !== "number" ||
      !Number.isFinite(bq.coeficiente) ||
      bq.coeficiente < 0 ||
      typeof bq?.campoId !== "string" ||
      bq.campoId.length === 0
    ) {
      return configInvalida();
    }
    const campoBonus = campoDaEstrutura(estrutura, bq.campoId);
    if (!campoBonus) {
      return { disponivel: false, motivo: "campo_inexistente", capacidade: null };
    }
    const modoBonus = bq.modo ?? modoInferido(campoBonus);
    if (modoBonus === "mapa" && bq.mapa === undefined) {
      return configInvalida();
    }
    const nBonus = numeroDoCampo(campoBonus, dados[bq.campoId], modoBonus, bq.mapa);
    if (nBonus !== null) {
      if (!Number.isFinite(nBonus) || nBonus < 0) {
        return {
          disponivel: false,
          motivo: "valor_invalido",
          capacidade: null,
          detalhe: { campoId: bq.campoId, bruto: dados[bq.campoId], modo: modoBonus },
        };
      }
      bonus = multiplicarDecimalSangue(nBonus, bq.coeficiente);
    }
    // nBonus === null → personagem sem a qualidade selecionada:
    // bônus zero, não é erro.
  }

  const capacidade = somarDecimalSangue(base, bonus);
  // R3/P2: a capacidade final precisa ser finita e não negativa —
  // defesa final mesmo que base ou bônus cheguem corrompidos.
  if (!Number.isFinite(capacidade) || capacidade < 0) {
    return {
      disponivel: false,
      motivo: "valor_invalido",
      capacidade: null,
      detalhe: { campoId, bruto, modo },
    };
  }
  return {
    disponivel: true,
    capacidade,
    detalhe: { campoId, bruto, modo },
  };
}

/**
 * Resolve a natureza/espécie do personagem.
 *
 * Regras (v5/C4 + revisão):
 *  - `campoNaturezaId` ausente/inexistente → indisponível;
 *  - valor vazio → `rotulo:null`, natureza não mapeada → NUNCA
 *    metaHumanoComPoder (fail-closed);
 *  - natureza não mapeada em `config.naturezas` → `natureza:null`,
 *    metaHumanoComPoder=false;
 *  - não-humano explicitamente mapeado sempre prevalece — a
 *    derivação Meta humano só ocorre quando o mapa declara
 *    `metaHumanoComPoder:true` para o rótulo lido.
 */
export function resolverNaturezaSangue(
  estrutura: EstruturaFicha,
  dados: Record<string, unknown>,
  config: ConfigSangue | null | undefined,
): ResolucaoNatureza {
  const base: ResolucaoNatureza = {
    disponivel: false,
    motivo: "desabilitado",
    rotulo: null,
    natureza: null,
    metaHumanoComPoder: false,
  };
  if (!config || config.habilitado !== true) return base;
  const campoId = config.campoNaturezaId;
  const campo = campoDaEstrutura(estrutura, campoId);
  if (!campoId || !campo) {
    return { ...base, motivo: "campo_inexistente" };
  }
  const rotulo = rotuloDeSelecao(dados[campoId]);
  if (rotulo === null) {
    // Campo existe mas sem valor: natureza "ausente" — não é erro
    // de configuração; o personagem simplesmente não tem natureza
    // definida ainda. Não vira Meta humano.
    return { ...base, disponivel: true, motivo: "valor_invalido", rotulo: null };
  }
  const natureza = config.naturezas?.[rotulo] ?? null;
  if (!natureza) {
    return { ...base, disponivel: true, motivo: "natureza_desconhecida", rotulo };
  }
  return {
    disponivel: true,
    rotulo,
    natureza,
    metaHumanoComPoder: natureza.metaHumanoComPoder === true,
  };
}

/** Resumo combinado para leitura de ficha/rotas. */
export interface ResolucaoSangue {
  capacidade: ResolucaoCapacidade;
  natureza: ResolucaoNatureza;
  /** Sangue utilizável por este personagem: config habilitada E
   *  capacidade resolvível. Natureza ausente NÃO desabilita o
   *  recurso — apenas impede derivação Meta humano. */
  utilizavel: boolean;
}

export function resolverSanguePersonagem(
  estrutura: EstruturaFicha,
  dados: Record<string, unknown>,
  config: ConfigSangue | null | undefined,
): ResolucaoSangue {
  const capacidade = resolverCapacidadeSangue(estrutura, dados, config);
  const natureza = resolverNaturezaSangue(estrutura, dados, config);
  return { capacidade, natureza, utilizavel: capacidade.disponivel };
}

/** Valida os vínculos de `config.sangue` contra uma estrutura —
 *  usado por C1 (edição de regras) para rejeitar IDs inexistentes.
 *  Retorna lista de problemas (vazia = válido). */
export function validarVinculosSangue(
  config: ConfigSangue | null | undefined,
  estrutura: EstruturaFicha,
): string[] {
  const erros: string[] = [];
  if (!config || config.habilitado !== true) return erros;
  const mapa = mapaCampos(estrutura);
  if (config.campoCapacidadeId && !mapa.has(config.campoCapacidadeId)) {
    erros.push(`campoCapacidadeId "${config.campoCapacidadeId}" não existe na estrutura`);
  }
  if (config.campoNaturezaId && !mapa.has(config.campoNaturezaId)) {
    erros.push(`campoNaturezaId "${config.campoNaturezaId}" não existe na estrutura`);
  }
  const bq = config.capacidade?.bonusQualidade;
  if (bq !== undefined) {
    const bqAtivo =
      bq.campoId !== undefined ||
      bq.coeficiente !== undefined ||
      bq.modo !== undefined ||
      bq.mapa !== undefined;
    if (bqAtivo) {
      if (typeof bq.campoId !== "string" || bq.campoId.length === 0) {
        erros.push("capacidade.bonusQualidade.campoId é obrigatório quando o bônus está configurado");
      } else if (!mapa.has(bq.campoId)) {
        erros.push(`capacidade.bonusQualidade.campoId "${bq.campoId}" não existe na estrutura`);
      }
      if (
        typeof bq.coeficiente !== "number" ||
        !Number.isFinite(bq.coeficiente) ||
        bq.coeficiente < 0
      ) {
        erros.push("capacidade.bonusQualidade.coeficiente deve ser número finito >= 0");
      }
    }
  }
  return erros;
}
