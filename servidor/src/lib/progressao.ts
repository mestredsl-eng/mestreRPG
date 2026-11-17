/**
 * Progressão de personagens — XP/Merit (Issue #124).
 *
 * Moeda SEPARADA dos pontos de criação: o estado vive em
 * `characters.data.__xp` (chave reservada — validarFicha descarta
 * chaves desconhecidas, então o PATCH comum da ficha nunca a altera;
 * o merge do PATCH preserva o objeto inteiro a partir de p.data).
 *
 * Estrutura:
 *   __xp.saldo     — XP disponível (nunca negativo)
 *   __xp.historico — eventos append-only: concessao, remocao, compra
 *                    (com kind/key, nível anterior→novo e custo em XP),
 *                    ajuste. Cada evento grava data, autor, motivo e
 *                    saldo resultante.
 *
 * Compra de nível (`comprar-ponto`): o preço do próximo nível reusa as
 * MESMAS tabelas do motor de pontos de criação, nunca uma tabela
 * paralela:
 *  - campo numérico vinculado (campo.regra): custo incremental do
 *    campo efetivo — `custoProgressivo` do elemento (ou `custos`
 *    por semântico da config de pontos) tem prioridade; fallback
 *    `custoPontos` por nível. Idêntico ao delta de calcularPontos.
 *  - seleções da biblioteca (selecao_multipla/lista/selecao_unica e
 *    selecao_nivel): custo incremental do elemento — `formulas.custo`
 *    (avaliada sobre a ficha hipotética), senão `niveis[].custo`
 *    (incremental por nível), senão `custoPontos` por nível, senão
 *    `custoProgressivo` somado. Idêntico a custosSelecao.
 * Preço não positivo ou não configurado → compra recusada (nunca
 * fallback silencioso, nunca preço zero inventado).
 *
 * A validação da ficha resultante roda `validarRegras` completo
 * (pré-requisitos, dependências, exclusividades, obrigações,
 * tetos/fórmulas e limitações condicionais da Issue #122). Erros de
 * POOL DE PONTOS DE CRIAÇÃO são ignorados: o XP é a moeda da progressão
 * e substitui o custo em pontos daquele incremento — os demais erros
 * bloqueiam a compra.
 */

import {
  todosCampos,
  avaliarFormula,
  type CampoDef,
  type EstruturaFicha,
} from "./ficha.js";
import {
  extrairEscolhas,
  estruturaComCustosDeElementos,
  pontosEfetivos,
  validarRegras,
  type ElementoRegra,
  type RegrasCampanha,
} from "./regras.js";

export const CHAVE_XP = "__xp";

// ---------- Estado __xp ----------

export type TipoEventoXp = "concessao" | "remocao" | "compra" | "ajuste";

export interface EventoXp {
  em: string;
  tipo: TipoEventoXp;
  /** Delta de XP: positivo = entrou, negativo = saiu. */
  quantidade: number;
  motivo: string | null;
  autorId: string | null;
  autorNome: string | null;
  saldoResultante: number;
  /** Preenchido quando tipo === "compra". */
  compra?: {
    kind: string;
    key: string;
    nome: string;
    campoId: string;
    nivelAnterior: number;
    nivelNovo: number;
    custoXp: number;
  };
}

export interface EstadoXp {
  saldo: number;
  historico: EventoXp[];
  /** Níveis financiados por XP por campo da ficha (BUG_0001): impede
   *  que o orçamento de pontos de criação cobre de novo esses níveis
   *  e permite reconciliar reduções/manutenção. */
  financiado?: Record<string, number>;
}

const MAX_HISTORICO = 500;

/** XP admite custos fracionários (BUG_0004): arredonda a 4 casas para
 *  absorver ruído de ponto flutuante sem truncar valores legítimos. */
const xpNum = (n: number): number => Math.round(n * 10000) / 10000;

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Lê o estado de XP do personagem (sem persistir). Personagens
 *  antigos sem __xp começam com saldo zero e histórico vazio. */
export function lerXp(dados: Record<string, unknown>): EstadoXp {
  const bruto = dados[CHAVE_XP] as EstadoXp | undefined;
  if (!bruto || typeof bruto !== "object") return { saldo: 0, historico: [] };
  const saldoBruto = num(bruto.saldo);
  const historico = Array.isArray(bruto.historico)
    ? bruto.historico.filter((e) => e && typeof e === "object")
    : [];
  const financiado: Record<string, number> = {};
  const finBruto = (bruto as { financiado?: unknown }).financiado;
  if (finBruto && typeof finBruto === "object") {
    for (const [k, v] of Object.entries(finBruto as Record<string, unknown>)) {
      const n = num(v);
      if (n !== null && n > 0) financiado[k] = n;
    }
  }
  return {
    saldo: saldoBruto === null ? 0 : xpNum(saldoBruto),
    historico,
    financiado: Object.keys(financiado).length ? financiado : undefined,
  };
}

export function saldoXp(dados: Record<string, unknown>): number {
  return lerXp(dados).saldo;
}

/**
 * Aplica um delta de XP (concessão/remoção/ajuste) registrando o evento.
 * `novoSaldo` é calculado aqui — o chamador garante a regra de saldo
 * (remoção não pode deixar negativo; validado antes de chamar).
 */
export function aplicarXp(
  dados: Record<string, unknown>,
  delta: number,
  evento: { tipo: TipoEventoXp; motivo?: string | null; autorId: string | null; autorNome: string | null },
): { dados: Record<string, unknown>; estado: EstadoXp } {
  const estado = lerXp(dados);
  const saldo = xpNum(estado.saldo + delta);
  const novo: EstadoXp = {
    saldo,
    historico: [
      ...estado.historico,
      {
        em: new Date().toISOString(),
        tipo: evento.tipo,
        quantidade: xpNum(delta),
        motivo: evento.motivo?.trim() || null,
        autorId: evento.autorId,
        autorNome: evento.autorNome,
        saldoResultante: saldo,
      },
    ].slice(-MAX_HISTORICO),
    financiado: estado.financiado,
  };
  return { dados: { ...dados, [CHAVE_XP]: novo }, estado: novo };
}

/** Níveis do campo `campoId` financiados por XP no estado persistido. */
export function xpFinanciadoEm(dados: Record<string, unknown>, campoId: string): number {
  const fin = (dados[CHAVE_XP] as EstadoXp | undefined)?.financiado;
  const n = fin?.[campoId];
  return typeof n === "number" && Number.isFinite(n) ? Math.max(0, n) : 0;
}

/**
 * Reconcilia `financiado` após escrita NÃO-XP nos dados da ficha
 * (PATCH do jogador/mestre, importação, restauração). Níveis
 * reduzidos consomem primeiro os financiados por XP (são os mais
 * recentes); aumentos por via não-XP são financiados por pontos de
 * criação — o contador só é limitado ao novo valor. Sem __xp no
 * estado, retorna os dados intactos.
 */
export function reconciliarFinanciadoXp(
  dadosAntigos: Record<string, unknown>,
  dadosNovos: Record<string, unknown>,
): Record<string, unknown> {
  const xp = lerXp(dadosNovos);
  if (dadosNovos[CHAVE_XP] === undefined || !xp.financiado) return dadosNovos;
  const fin: Record<string, number> = { ...xp.financiado };
  for (const campoId of Object.keys(fin)) {
    const antes = num(dadosAntigos[campoId]) ?? 0;
    const depois = num(dadosNovos[campoId]) ?? 0;
    if (depois < antes) fin[campoId] = Math.max(0, fin[campoId] - (antes - depois));
    else fin[campoId] = Math.min(fin[campoId], Math.max(0, depois));
    if (fin[campoId] <= 0) delete fin[campoId];
  }
  return { ...dadosNovos, [CHAVE_XP]: { ...xp, financiado: Object.keys(fin).length ? fin : undefined } };
}

// ---------- Vínculo elemento → campo da ficha ----------

/** Modos de armazenamento do nível de um elemento na ficha. */
type ModoVinculo = "nivel" | "selecao_nivel" | "binario";

interface VinculoElemento {
  campo: CampoDef;
  modo: ModoVinculo;
}

// Tipos de campo que armazenam SELEÇÕES por chave de elemento.
// "tabela"/"calculado"/"referencia" não representam nível por elemento.
const TIPOS_BINARIOS = new Set(["selecao_unica", "selecao_multipla", "lista"]);

/** Campos da ficha que podem expressar o nível do elemento kind:key. */
export function vinculosElemento(estrutura: EstruturaFicha, kind: string, key: string): VinculoElemento[] {
  const out: VinculoElemento[] = [];
  for (const campo of todosCampos(estrutura)) {
    if (campo.tipo === "calculado" || campo.tipo === "referencia" || campo.tipo === "tabela") continue;
    if (campo.regra?.kind === kind && campo.regra?.key === key) {
      out.push({ campo, modo: "nivel" });
      continue;
    }
    if (campo.regraKind === kind) {
      if (campo.tipo === "selecao_nivel") out.push({ campo, modo: "selecao_nivel" });
      else if (TIPOS_BINARIOS.has(campo.tipo)) out.push({ campo, modo: "binario" });
    }
  }
  return out;
}

/** Nível que ESTE vínculo expressa para o elemento (0 = ausente). */
export function nivelNoVinculo(dados: Record<string, unknown>, vinculo: VinculoElemento, key: string): number {
  const valor = dados[vinculo.campo.id];
  if (vinculo.modo === "nivel") {
    return typeof valor === "number" && Number.isFinite(valor) ? Math.max(0, valor) : 0;
  }
  if (vinculo.modo === "selecao_nivel") {
    if (!Array.isArray(valor)) return 0;
    for (const item of valor) {
      if (item && typeof item === "object" && (item as Record<string, unknown>).key === key) {
        const n = (item as Record<string, unknown>).nivel;
        return typeof n === "number" && Number.isInteger(n) ? Math.max(0, n) : 0;
      }
    }
    return 0;
  }
  // binario: presença da chave = nível 1
  if (Array.isArray(valor)) return valor.includes(key) ? 1 : 0;
  return valor !== undefined && valor !== null && valor !== "" && String(valor) === key ? 1 : 0;
}

/** O vínculo consegue expressar `nivel`? (binário só 0/1) */
function vinculoExpressa(vinculo: VinculoElemento, nivel: number): boolean {
  return vinculo.modo !== "binario" || nivel <= 1;
}

const PRIORIDADE_MODO: Record<ModoVinculo, number> = { nivel: 0, selecao_nivel: 1, binario: 2 };

/**
 * Escolhe o vínculo que recebe a escrita do nível. Prefere o campo que
 * já detém o nível atual máximo; entre os que expressam `nivelAlvo`,
 * maior nível atual → prioridade de modo → ordem da ficha.
 */
export function escolherVinculo(
  estrutura: EstruturaFicha,
  dados: Record<string, unknown>,
  kind: string,
  key: string,
  nivelAlvo: number,
): VinculoElemento | null {
  const candidatos = vinculosElemento(estrutura, kind, key).filter((v) => vinculoExpressa(v, nivelAlvo));
  if (!candidatos.length) return null;
  let melhor: VinculoElemento | null = null;
  let melhorNivel = -1;
  for (const v of candidatos) {
    const n = nivelNoVinculo(dados, v, key);
    if (!melhor || n > melhorNivel || (n === melhorNivel && PRIORIDADE_MODO[v.modo] < PRIORIDADE_MODO[melhor.modo])) {
      melhor = v;
      melhorNivel = n;
    }
  }
  return melhor;
}

/** Nível atual do elemento = maior nível em qualquer campo — MESMA
 *  fonte do motor (extrairEscolhas → máximo por kind:key). */
export function nivelAtualElemento(
  estrutura: EstruturaFicha,
  dados: Record<string, unknown>,
  regras: RegrasCampanha,
  kind: string,
  key: string,
): number {
  let max = 0;
  for (const e of extrairEscolhas(estrutura, dados, regras)) {
    if (!e.elemento || !e.selecionado) continue;
    if (e.elemento.kind === kind && e.elemento.key === key) {
      max = Math.max(max, e.level);
    }
  }
  return max;
}

/** Devolve `dados` com o nível do elemento gravado no vínculo escolhido
 *  (0 remove a seleção). Não valida regras — uso interno/transacional. */
export function aplicarNivelDados(
  dados: Record<string, unknown>,
  vinculo: VinculoElemento,
  key: string,
  nivel: number,
): Record<string, unknown> {
  const id = vinculo.campo.id;
  const atual = dados[id];
  if (vinculo.modo === "nivel") {
    return { ...dados, [id]: nivel };
  }
  if (vinculo.modo === "selecao_nivel") {
    const itens = Array.isArray(atual) ? [...atual] : [];
    const idx = itens.findIndex((it) => it && typeof it === "object" && (it as Record<string, unknown>).key === key);
    if (nivel <= 0) {
      if (idx >= 0) itens.splice(idx, 1);
    } else if (idx >= 0) {
      itens[idx] = { ...(itens[idx] as Record<string, unknown>), nivel };
    } else {
      itens.push({ key, nivel });
    }
    return { ...dados, [id]: itens };
  }
  // binario: selecao_unica guarda escalar; selecao_multipla/lista guardam
  // array de chaves — preserva o formato que validarFicha normaliza.
  const escalar = vinculo.campo.tipo === "selecao_unica";
  if (nivel <= 0) {
    if (Array.isArray(atual)) return { ...dados, [id]: atual.filter((x) => x !== key) };
    return { ...dados, [id]: escalar ? null : [] };
  }
  if (escalar) return { ...dados, [id]: key };
  const arr = Array.isArray(atual) ? atual : [];
  return arr.includes(key) ? dados : { ...dados, [id]: [...arr, key] };
}

// ---------- Preço do próximo nível (reuso das tabelas do motor) ----------

/**
 * Custo em pontos de criação de um campo numérico para o intervalo
 * [de, para) — réplica EXATA do trecho de calcularPontos que soma o
 * custo de um campo (tabela progressiva por valor absoluto com
 * fallback custoPontos; sem tabela → custoPontos × diff).
 */
function custoCampoIntervalo(
  campo: CampoDef,
  cfgCustos: EstruturaFicha["pontos"]["custos"],
  de: number,
  para: number,
): number {
  const base = typeof campo.padrao === "number" ? campo.padrao : (campo.minimo ?? 0);
  const custoAte = (valor: number): number => {
    const diff = valor - base;
    if (diff <= 0) return 0;
    const tabela = campo.custoProgressivo?.length ? campo.custoProgressivo : cfgCustos?.[campo.semantico];
    if (tabela?.length) {
      let c = 0;
      for (let nivel = base; nivel < valor; nivel++) {
        const v = tabela[nivel];
        c += typeof v === "number" ? v : (campo.custoPontos ?? 0);
      }
      return c;
    }
    return diff * (campo.custoPontos ?? 0);
  };
  return custoAte(para) - custoAte(de);
}

/** Custo de SELEÇÃO de um elemento até o nível L — réplica da lógica
 *  por elemento de custosSelecao (formulas.custo / niveis / custoPontos /
 *  custoProgressivo). `dados` é usado apenas pela fórmula de custo. */
function custoSelecaoAte(
  elemento: ElementoRegra,
  dados: Record<string, unknown>,
  estrutura: EstruturaFicha,
  level: number,
): number | null {
  // BUG_0005: nível 0 = seleção ausente → custo acumulado zero,
  // mesmo quando a fórmula é constante (não depende do estado).
  if (level <= 0) return 0;
  const def = elemento.definition;
  const formulaCusto = def.formulas?.custo;
  if (formulaCusto) {
    try {
      const v = Number(avaliarFormula(formulaCusto, dados, estrutura));
      return Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  }
  if (def.niveis?.length) {
    let c = 0;
    for (let i = 0; i < Math.min(level, def.niveis.length); i++) {
      c += def.niveis[i].custo ?? def.custoPontos ?? 0;
    }
    return c;
  }
  if (def.custoPontos !== undefined) return def.custoPontos * level;
  if (def.custoProgressivo?.length) {
    let c = 0;
    for (let i = 0; i < level; i++) c += def.custoProgressivo[i] ?? 0;
    return c;
  }
  return 0; // nada configurado → custo zero (sem preço)
}

export interface PrecoNivel {
  /** Custo em XP do próximo nível; null = sem preço configurado. */
  preco: number | null;
  motivo?: string;
}

/**
 * Preço do próximo nível do elemento para ESTE personagem, calculado
 * pela configuração vigente (mesmas tabelas do motor de pontos).
 * `nivelAtual`/`nivelAlvo` são níveis do elemento (não do campo).
 */
export function precoProximoNivel(
  estrutura: EstruturaFicha,
  dados: Record<string, unknown>,
  regras: RegrasCampanha,
  elemento: ElementoRegra,
  vinculo: VinculoElemento,
  nivelAtual: number,
  nivelAlvo: number,
): PrecoNivel {
  const kind = elemento.kind;
  const key = elemento.key;

  if (vinculo.modo === "nivel") {
    // Campo numérico: custo incremental do campo EFETIVO (elemento
    // sobrescreve custoPontos/custoProgressivo do campo — mesma
    // herança de estruturaComCustosDeElementos usada pelo motor).
    const estruturaEf = estruturaComCustosDeElementos(estrutura, regras);
    const campoEf = todosCampos(estruturaEf).find((c) => c.id === vinculo.campo.id) ?? vinculo.campo;
    const cfgCustos = pontosEfetivos(estrutura, regras).custos;
    const temTabela = !!(campoEf.custoProgressivo?.length || cfgCustos?.[campoEf.semantico]?.length);
    const temFixo = campoEf.custoPontos !== undefined;
    if (!temTabela && !temFixo) {
      return { preco: null, motivo: `"${elemento.name}" não tem custo configurado para compra com XP` };
    }
    const preco = custoCampoIntervalo(campoEf, cfgCustos, nivelAtual, nivelAlvo);
    return Number.isFinite(preco) && preco > 0
      ? { preco }
      : { preco: null, motivo: `"${elemento.name}" não tem preço válido para o próximo nível` };
  }

  // Seleção da biblioteca: custo incremental do elemento (custosSelecao).
  const def = elemento.definition;
  const temConfig =
    !!def.formulas?.custo ||
    !!def.niveis?.length ||
    def.custoPontos !== undefined ||
    !!def.custoProgressivo?.length;
  if (!temConfig) {
    return { preco: null, motivo: `"${elemento.name}" não tem custo configurado para compra com XP` };
  }
  if (def.formulas?.custo) {
    // Fórmula de custo é um TOTAL da seleção: o preço do incremento é o
    // delta da fórmula entre a ficha atual e a ficha com o nível alvo.
    const dadosNovo = aplicarNivelDados(dados, vinculo, key, nivelAlvo);
    const dadosAtual = aplicarNivelDados(dados, vinculo, key, nivelAtual);
    const custoNovo = custoSelecaoAte(elemento, dadosNovo, estrutura, nivelAlvo);
    const custoAtual = custoSelecaoAte(elemento, dadosAtual, estrutura, nivelAtual);
    if (custoNovo === null || custoAtual === null) {
      return { preco: null, motivo: `"${elemento.name}" tem fórmula de custo inválida` };
    }
    const preco = custoNovo - custoAtual;
    return Number.isFinite(preco) && preco > 0
      ? { preco }
      : { preco: null, motivo: `"${elemento.name}" não tem preço válido para o próximo nível` };
  }
  const preco = custoSelecaoAte(elemento, dados, estrutura, nivelAlvo)! - custoSelecaoAte(elemento, dados, estrutura, nivelAtual)!;
  return Number.isFinite(preco) && preco > 0
    ? { preco }
    : { preco: null, motivo: `"${elemento.name}" não tem preço válido para o próximo nível` };
}

// ---------- Resumo para GET /progressao ----------

export interface ElementoDisponivel {
  kind: string;
  key: string;
  nome: string;
  nivelAtual: number;
  precoProximo: number | null;
  compravel: boolean;
  motivo?: string;
}

/**
 * Saldo + histórico + lista de elementos compráveis da ficha.
 * `disponiveis` cobre todos os elementos da biblioteca vinculados a
 * campos da estrutura (kind:key direto ou via regraKind).
 */
export function resumoProgressao(
  estrutura: EstruturaFicha,
  dados: Record<string, unknown>,
  regras: RegrasCampanha,
): { xp: EstadoXp; disponiveis: ElementoDisponivel[] } {
  const xp = lerXp(dados);
  const disponiveis: ElementoDisponivel[] = [];

  // Conjunto de elementos candidatos: vínculos diretos + elementos dos
  // kinds usados em campos de seleção (cada key presente na biblioteca
  // daquele kind é candidatável — o nível atual vem da ficha).
  const candidatos = new Map<string, ElementoRegra>();
  for (const campo of todosCampos(estrutura)) {
    if (campo.tipo === "calculado" || campo.tipo === "referencia" || campo.tipo === "tabela") continue;
    if (campo.regra?.kind && campo.regra?.key) {
      const el = regras.elementos.get(`${campo.regra.kind}:${campo.regra.key}`);
      if (el) candidatos.set(`${el.kind}:${el.key}`, el);
    }
    if (campo.regraKind) {
      for (const el of regras.porKind.get(campo.regraKind) ?? []) {
        candidatos.set(`${el.kind}:${el.key}`, el);
      }
    }
  }

  for (const el of candidatos.values()) {
    const nivelAtual = nivelAtualElemento(estrutura, dados, regras, el.kind, el.key);
    const nivelAlvo = nivelAtual + 1;
    const vinculo = escolherVinculo(estrutura, dados, el.kind, el.key, nivelAlvo);
    let precoProximo: number | null = null;
    let compravel = false;
    let motivo: string | undefined;
    if (!vinculo) {
      motivo = "Elemento sem campo de nível disponível na ficha";
    } else if (el.definition.disponivel === false) {
      motivo = "Elemento desativado nesta campanha";
    } else {
      const preco = precoProximoNivel(estrutura, dados, regras, el, vinculo, nivelAtual, nivelAlvo);
      precoProximo = preco.preco;
      if (preco.preco === null) {
        motivo = preco.motivo;
      } else if (xp.saldo < preco.preco) {
        motivo = "XP insuficiente";
      } else {
        compravel = true;
      }
    }
    disponiveis.push({
      kind: el.kind,
      key: el.key,
      nome: el.name,
      nivelAtual,
      precoProximo,
      compravel,
      motivo,
    });
  }
  disponiveis.sort((a, b) => a.kind.localeCompare(b.kind) || a.nome.localeCompare(b.nome));
  return { xp, disponiveis };
}

// ---------- Compra (monta dados prontos para validar) ----------

export interface ResultadoCompra {
  ok: boolean;
  erro?: string;
  codigo?: string;
  detalhes?: unknown;
  dados?: Record<string, unknown>;
  estadoXp?: EstadoXp;
  compra?: NonNullable<EventoXp["compra"]>;
}

/**
 * Núcleo da compra de nível — função PURA e síncrona para rodar
 * DENTRO da transação do endpoint (releitura fresca dos dados).
 * Nunca confia em saldo/nível/preço vindos do cliente: tudo é
 * recalculado aqui a partir de `dados` persistidos.
 */
export function simularCompraNivel(
  estrutura: EstruturaFicha,
  dados: Record<string, unknown>,
  regras: RegrasCampanha,
  kind: string,
  key: string,
  nivelAlvo: number,
  autor: { id: string | null; nome: string | null },
): ResultadoCompra {
  const elemento = regras.elementos.get(`${kind}:${key}`);
  if (!elemento) {
    return { ok: false, erro: `Elemento ${kind}:${key} não existe nas regras da campanha`, codigo: "elemento_inexistente" };
  }
  if (elemento.definition.disponivel === false) {
    return { ok: false, erro: `"${elemento.name}" está desativado nesta campanha`, codigo: "indisponivel" };
  }

  const nivelAtual = nivelAtualElemento(estrutura, dados, regras, kind, key);
  if (nivelAlvo !== nivelAtual + 1) {
    return {
      ok: false,
      erro: `A compra avança exatamente um nível por vez (atual ${nivelAtual}, alvo ${nivelAlvo})`,
      codigo: "salto_nivel",
      detalhes: { nivelAtual, nivelAlvo },
    };
  }

  const vinculo = escolherVinculo(estrutura, dados, kind, key, nivelAlvo);
  const semVinculo = vinculosElemento(estrutura, kind, key).length === 0;
  if (!vinculo) {
    return {
      ok: false,
      erro: semVinculo
        ? `"${elemento.name}" não está vinculado a nenhum campo da ficha`
        : `"${elemento.name}" não pode expressar o nível ${nivelAlvo} nos campos da ficha`,
      codigo: "sem_vinculo",
    };
  }
  if (vinculo.modo === "binario" && nivelAtual >= 1) {
    return { ok: false, erro: `"${elemento.name}" é uma seleção simples (nível máximo 1)`, codigo: "nivel_maximo" };
  }

  // BUG_0003: tetos estruturais da ficha/seleção — a compra nunca
  // persiste nível acima do máximo do campo nem do limite graduado
  // do elemento, independentemente de preço/regras.
  if (vinculo.modo === "nivel" && vinculo.campo.maximo !== undefined && nivelAlvo > vinculo.campo.maximo) {
    return {
      ok: false,
      erro: `"${elemento.name}" excede o máximo do campo "${vinculo.campo.label}" (${vinculo.campo.maximo})`,
      codigo: "maximo_campo",
      detalhes: { campoId: vinculo.campo.id, maximo: vinculo.campo.maximo, nivelAlvo },
    };
  }
  if (vinculo.modo === "selecao_nivel" && elemento.definition.niveis?.length && nivelAlvo > elemento.definition.niveis.length) {
    return {
      ok: false,
      erro: `"${elemento.name}" excede o limite de níveis configurado (${elemento.definition.niveis.length})`,
      codigo: "maximo_selecao",
      detalhes: { maximo: elemento.definition.niveis.length, nivelAlvo },
    };
  }

  const preco = precoProximoNivel(estrutura, dados, regras, elemento, vinculo, nivelAtual, nivelAlvo);
  if (preco.preco === null) {
    return { ok: false, erro: preco.motivo ?? "Sem preço configurado", codigo: "sem_preco" };
  }

  const xp = lerXp(dados);
  if (xp.saldo < preco.preco) {
    return {
      ok: false,
      erro: `XP insuficiente: custo ${preco.preco}, saldo ${xp.saldo}`,
      codigo: "xp_insuficiente",
      detalhes: { custo: preco.preco, saldo: xp.saldo },
    };
  }

  // Aplica o nível e debita o XP na mesma estrutura de dados — a
  // gravação é atômica porque tudo acontece dentro da transação.
  let dadosNovos = aplicarNivelDados(dados, vinculo, key, nivelAlvo);

  // Validação completa do motor de regras sobre o resultado:
  // pré-requisitos, dependências, exclusividades, obrigações,
  // tetos/fórmulas e limitações condicionais (#122). Erros de pool de
  // pontos de criação são ignorados — o XP substitui o custo em pontos
  // do incremento comprado (bypass controlado e auditado).
  const validacao = validarRegras(estrutura, dadosNovos, regras);
  const errosRegras = validacao.erros.filter((e) => e.codigo !== "pontos");
  if (errosRegras.length > 0) {
    return {
      ok: false,
      erro: "A evolução viola as regras da campanha",
      codigo: "regras",
      detalhes: { erros: errosRegras },
    };
  }

  dadosNovos = aplicarXp(dadosNovos, -preco.preco, {
    tipo: "compra",
    motivo: `Compra de nível: ${elemento.name} ${nivelAtual} → ${nivelAlvo}`,
    autorId: autor.id,
    autorNome: autor.nome,
  }).dados;
  // Enriquece o evento de compra com os dados do elemento.
  const estado = lerXp(dadosNovos);
  // BUG_0001: nível comprado com XP em campo numérico é financiado
  // por XP — o orçamento de pontos de criação não pode cobrá-lo de
  // novo, e reduções futuras reconciliam por reconciliarFinanciadoXp.
  if (vinculo.modo === "nivel") {
    const fin = { ...(estado.financiado ?? {}) };
    fin[vinculo.campo.id] = xpNum((fin[vinculo.campo.id] ?? 0) + (nivelAlvo - nivelAtual));
    estado.financiado = fin;
  }
  const ultimo = estado.historico[estado.historico.length - 1];
  if (ultimo) {
    ultimo.compra = {
      kind,
      key,
      nome: elemento.name,
      campoId: vinculo.campo.id,
      nivelAnterior: nivelAtual,
      nivelNovo: nivelAlvo,
      custoXp: preco.preco,
    };
    dadosNovos = { ...dadosNovos, [CHAVE_XP]: estado };
  }

  return {
    ok: true,
    dados: dadosNovos,
    estadoXp: lerXp(dadosNovos),
    compra: ultimo?.compra,
  };
}
