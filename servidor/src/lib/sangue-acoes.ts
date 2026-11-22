// Issue #186 — Camada de aplicação das ações de Sangue (contrato
// #7055515759). Pura e reutilizável: sem SQLite, sem transporte,
// sem permissões. Orquestra as primitivas de `sangue.ts` (#194/#219/
// #220) com a configuração estendida de `regras.ts` (#216).
//
// CONTRATO DO CHAMADOR (runtime — Intermediário):
//  - carregar e validar TODO o contexto no servidor (personagem,
//    ficha/estrutura da versão vinculada, ruleset, permissões do
//    ator) ANTES de chamar; esta camada nunca confia em papel,
//    custo ou requestId vindos do cliente;
//  - executar dentro da transação SQLite SÍNCRONA que persiste
//    `characters.data` (mesmo padrão C6 das demais mutações);
//  - emitir eventos realtime SOMENTE após o commit;
//  - custo de Poder é resolvido AQUI a partir de
//    `config.sangue.poderes[key].custo` — ausência = 0; o cliente
//    nunca informa custo.

import {
  CHAVE_SANGUE,
  lerSangue,
  registrarAjusteSangue,
  registrarAtivacaoSangue,
  registrarRecuperacaoSangue,
  reconciliarCapacidadeSangue,
  resolverCapacidadeSangue,
  resolverNaturezaSangue,
  type CodigoErroSangue,
  type ConfigSangue,
  type EstadoSangue,
} from "./sangue.js";
import type { EstruturaFicha } from "./ficha.js";

// ---------- Config estendida (shape #216) ----------

/** Forma de `config.sangue` já estendida por #216 — supersets
 *  estruturais dos tipos C2: `poderes` (custos por key de
 *  rule_definitions kind="poder") e `recuperacaoSangue.acoes`
 *  (Descansar/Alimentar-se canônicas). `naturezas[*].recuperacao`
 *  referencia uma dessas chaves canônicas. */
export interface AcaoRecuperacaoSangueConfig {
  habilitada?: boolean;
  quantidade?: number;
}

export interface ConfigSangueAcoes extends Omit<ConfigSangue, "recuperacaoSangue"> {
  recuperacaoSangue?: {
    habilitado?: boolean;
    acoes?: {
      descansar?: AcaoRecuperacaoSangueConfig;
      alimentar?: AcaoRecuperacaoSangueConfig;
    };
  };
  poderes?: Record<string, { custo?: number }>;
}

// ---------- Resultados de domínio ----------

/** Códigos estáveis de domínio — o transporte mapeia para HTTP/ACK,
 *  esta camada nunca produz mensagens de transporte. */
export type CodigoErroAcaoSangue =
  | CodigoErroSangue
  | "poder_desconhecido"
  | "custo_invalido"
  | "recurso_desabilitado"
  | "natureza_indisponivel"
  | "natureza_sem_acao"
  | "acao_desabilitada";

export type ResultadoAcaoSangue =
  | {
      ok: true;
      dados: Record<string, unknown>;
      estado: EstadoSangue;
      /** true quando a operação já constava no ledger (replay
       *  idempotente — nenhum efeito novo aplicado). */
      replay: boolean;
      /** true somente na reconciliação de capacidade quando um
       *  ajuste de saldo foi efetivamente registrado. */
      ajustado?: boolean;
    }
  | { ok: false; codigo: CodigoErroAcaoSangue; saldo?: number; motivo?: string };

interface ContextoAtor {
  personagemId: string;
  autorId: string | null;
  autorNome: string | null;
  motivo?: string | null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function erro(codigo: CodigoErroAcaoSangue, extra?: { saldo?: number; motivo?: string }): ResultadoAcaoSangue {
  return {
    ok: false,
    codigo,
    ...(extra?.saldo !== undefined ? { saldo: extra.saldo } : {}),
    ...(extra?.motivo ? { motivo: extra.motivo } : {}),
  };
}

function deResultadoSangue(r: {
  ok: true;
  dados: Record<string, unknown>;
  estado: EstadoSangue;
  jaRegistrado?: boolean;
}): ResultadoAcaoSangue {
  return { ok: true, dados: r.dados, estado: r.estado, replay: r.jaRegistrado === true };
}

function deErro(r: { ok: false; codigo: CodigoErroSangue; saldo?: number; motivo?: string }): ResultadoAcaoSangue {
  return { ok: false, codigo: r.codigo, ...(r.saldo !== undefined ? { saldo: r.saldo } : {}), ...(r.motivo ? { motivo: r.motivo } : {}) };
}

// ---------- 1. Ativação narrativa de Poder (fora do D10) ----------

export interface ParamsAtivacaoPoder extends ContextoAtor {
  /** UUID gerado pelo cliente para idempotência (`ativar:<uuid>`). */
  requestId: string;
  /** `key` do elemento kind="poder" do ruleset — NUNCA o custo. */
  poderKey: string;
  /** Configuração autoritativa já carregada do ruleset da campanha.
   *  `habilitado !== true` (ou config ausente) → `recurso_desabilitado`
   *  antes de qualquer leitura de custo ou mutação do ledger. */
  config: ConfigSangueAcoes | null | undefined;
  /** Chaves kind="poder" válidas do ruleset (rule_definitions) —
   *  OBRIGATÓRIO: o runtime deve fornecê-lo sempre, montado apenas
   *  das definições `kind="poder"` do ruleset ativo. poderKey fora
   *  do conjunto (ou conjunto ausente) → `poder_desconhecido`
   *  (fail-closed — a camada nunca assume validade por conta própria). */
  poderesValidos: ReadonlySet<string>;
}

/** Ativação narrativa de Poder fora do D10 — débito via
 *  `registrarAtivacaoSangue` (`usoId = "ativar:"+requestId`).
 *  Custo resolvido exclusivamente de `config.poderes[poderKey].custo`:
 *  ausente → 0 (gratuito), zero válido, negativo/não finito →
 *  `custo_invalido`. Não há dano/consequência narrativa automática. */
export function ativarPoderNarrativo(
  dados: Record<string, unknown>,
  params: ParamsAtivacaoPoder,
): ResultadoAcaoSangue {
  const poderKey = typeof params.poderKey === "string" ? params.poderKey.trim() : "";
  if (!poderKey || poderKey.length > 80) {
    return erro("uso_invalido", { motivo: "poderKey inválida" });
  }
  // Recurso desabilitado corta TUDO antes de custo/ledger — config
  // ausente ou `habilitado !== true` nunca vira ativação gratuita.
  if (!params.config || params.config.habilitado !== true) {
    return erro("recurso_desabilitado");
  }
  if (params.poderesValidos?.has(poderKey) !== true) {
    return erro("poder_desconhecido", { motivo: poderKey });
  }
  const custoBruto = params.config?.poderes?.[poderKey]?.custo;
  const custo = custoBruto === undefined || custoBruto === null ? 0 : custoBruto;
  if (typeof custo !== "number" || !Number.isFinite(custo) || custo < 0) {
    return erro("custo_invalido", { motivo: poderKey });
  }
  const r = registrarAtivacaoSangue(dados, {
    personagemId: params.personagemId,
    autorId: params.autorId,
    autorNome: params.autorNome,
    motivo: params.motivo ?? null,
    poderKey,
    custo,
    requestId: params.requestId,
  });
  return r.ok ? deResultadoSangue(r) : deErro(r);
}

// ---------- 2. Recuperação (Descansar / Alimentar-se) ----------

export type AcaoRecuperacaoSangue = "descansar" | "alimentar";

export interface ParamsRecuperacaoSangue extends ContextoAtor {
  /** UUID de idempotência (`recuperar:<uuid>`). */
  requestId: string;
  /** Estrutura da versão de ficha VINCULADA ao personagem — nunca a
   *  versão mais recente se divergir da vinculada. */
  estrutura: EstruturaFicha;
  /** `characters.data` da ficha (campos, não o ledger `__sangue`). */
  dadosFicha: Record<string, unknown>;
  /** Configuração autoritativa do ruleset (shape #216). */
  config: ConfigSangueAcoes | null | undefined;
  /** Capacidade atual já resolvida/validada pelo chamador
   *  (`resolverCapacidadeSangue` sobre a mesma versão). */
  capacidadeMax?: number | null;
}

/** Recuperação por natureza — decide a ação SOMENTE pelo mapeamento
 *  explícito `naturezas[rotulo].recuperacao` ∈ {"descansar",
 *  "alimentar"} (#216). Sem natureza mapeada/ação configurada →
 *  `natureza_sem_acao`; global ou ação desligada → `acao_desabilitada`.
 *  Nunca aplica dano nem consequência narrativa. */
export function recuperarSangue(
  dados: Record<string, unknown>,
  params: ParamsRecuperacaoSangue,
): ResultadoAcaoSangue {
  if (typeof params.requestId !== "string" || !UUID_RE.test(params.requestId)) {
    return erro("uso_invalido", { motivo: "requestId deve ser UUID" });
  }
  const config = params.config;
  if (!config || config.habilitado !== true) {
    return erro("recurso_desabilitado");
  }
  const nat = resolverNaturezaSangue(params.estrutura, params.dadosFicha, config);
  if (!nat.disponivel) {
    return erro("natureza_indisponivel", { motivo: nat.motivo });
  }
  const acao = nat.natureza?.recuperacao;
  if (acao !== "descansar" && acao !== "alimentar") {
    return erro("natureza_sem_acao", { motivo: nat.rotulo ?? undefined });
  }
  const rec = config.recuperacaoSangue;
  if (rec?.habilitado !== true) {
    return erro("acao_desabilitada");
  }
  const cfgAcao = rec.acoes?.[acao];
  if (!cfgAcao || cfgAcao.habilitada !== true) {
    return erro("acao_desabilitada", { motivo: acao });
  }
  const quantidade = cfgAcao.quantidade;
  if (typeof quantidade !== "number" || !Number.isFinite(quantidade) || quantidade <= 0) {
    return erro("quantidade_invalida", { motivo: acao });
  }
  const r = registrarRecuperacaoSangue(dados, {
    personagemId: params.personagemId,
    autorId: params.autorId,
    autorNome: params.autorNome,
    motivo: params.motivo ?? null,
    requestId: params.requestId,
    quantidade,
    habilitada: true,
    capacidadeMax: params.capacidadeMax ?? null,
  });
  return r.ok ? deResultadoSangue(r) : deErro(r);
}

// ---------- 3. Ajuste manual de saldo (mestre) ----------

export interface ParamsAjusteSangue extends ContextoAtor {
  delta: number;
  /** UUID de idempotência (`ajustar:<uuid>`) — OBRIGATÓRIO no
   *  contrato do socket R6.3: retry após ACK perdido devolve o
   *  resultado original sem novo delta; requestId reaproveitado
   *  com payload divergente → `uso_conflito`. */
  requestId: string;
}

/** Ajuste manual — expõe `registrarAjusteSangue` com motivo
 *  obrigatório (o primitivo já rejeita delta 0/não finito e motivo
 *  vazio) e `requestId` UUID obrigatório para dedup durável.
 *  O runtime deve provar que o ator é mestre ANTES de chamar;
 *  papel nunca vem do cliente. */
export function ajustarSangueManual(
  dados: Record<string, unknown>,
  params: ParamsAjusteSangue,
): ResultadoAcaoSangue {
  if (typeof params.requestId !== "string" || !UUID_RE.test(params.requestId)) {
    return erro("uso_invalido", { motivo: "requestId deve ser UUID" });
  }
  const r = registrarAjusteSangue(dados, {
    personagemId: params.personagemId,
    autorId: params.autorId,
    autorNome: params.autorNome,
    motivo: params.motivo ?? null,
    delta: params.delta,
    requestId: params.requestId,
  });
  if (!r.ok) return deErro(r);
  return { ok: true, dados: r.dados, estado: r.estado, replay: r.jaRegistrado === true };
}

// ---------- 4. Reconciliação de capacidade reduzida ----------

export interface ParamsReconciliacaoCapacidade extends ContextoAtor {
  /** Capacidade recém-resolvida e validada pelo resolvedor C4 —
   *  nunca um número vindo do cliente. */
  capacidadeNova?: number | null;
}

/** Integra `reconciliarCapacidadeSangue` (#220): saldo acima do novo
 *  teto → ajuste negativo auditável até o teto; capacidade
 *  ausente/inválida ou saldo dentro do teto → no-op. Histórico
 *  append-only preservado; motivo obrigatório para ajuste. */
export function reconciliarCapacidade(
  dados: Record<string, unknown>,
  params: ParamsReconciliacaoCapacidade,
): ResultadoAcaoSangue {
  const r = reconciliarCapacidadeSangue(dados, {
    personagemId: params.personagemId,
    autorId: params.autorId,
    autorNome: params.autorNome,
    motivo: params.motivo ?? null,
    capacidadeNova: params.capacidadeNova,
  });
  if (!r.ok) {
    return { ok: false, codigo: r.codigo, ...(r.saldo !== undefined ? { saldo: r.saldo } : {}), ...(r.motivo ? { motivo: r.motivo } : {}) };
  }
  return {
    ok: true,
    dados: r.dados,
    estado: r.estado,
    replay: false,
    ajustado: r.ajustado,
  };
}

// ---------- Utilidade de leitura para o runtime ----------

/** Estado atual do ledger para decisões do chamador (ex.: saldo
 *  disponível antes de propor ação). Leitura pura — não valida
 *  permissões nem ficha. */
export function estadoSangueAtual(
  dados: Record<string, unknown>,
): { ok: true; estado: EstadoSangue } | { ok: false; codigo: "sangue_invalido"; motivo?: string } {
  const lido = lerSangue(dados);
  if (!lido.valido) return { ok: false, codigo: "sangue_invalido", motivo: lido.motivo };
  return { ok: true, estado: lido.estado };
}

export { CHAVE_SANGUE, resolverCapacidadeSangue };
