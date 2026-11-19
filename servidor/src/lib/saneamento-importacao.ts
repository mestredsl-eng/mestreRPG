/**
 * Saneamento de metadados reservados na entrada de estado (Issue #162).
 *
 * Dois níveis de confiança, explícitos e obrigatórios:
 *  - "interna": snapshot criado pelo próprio servidor — nenhum
 *    metadado reservado é tocado.
 *  - "externa" (padrão): pacote JSON de importação — proveniência não
 *    verificável. Cada personagem tem `characters.data` inspecionado e
 *    os metadados econômicos/de estado são VALIDADOS e reparados:
 *      __xp          — cadeia de saldos, tipos, datas e `financiado`
 *      __pontos      — selo sempre removido; bônus limitado; histórico
 *                      validado com autoria resolvida
 *      __hp          — faixa do máximo configurado, estrutura e histórico
 *      __vitalidade  — nível dentro da escala configurada
 *      __retrato     — arquivo precisa existir no pacote
 *      __npcVisivel  — somente { visivel: boolean }
 *    Nada é apagado silenciosamente: cada ajuste é contabilizado no
 *    RelatorioSaneamento devolvido ao chamador (resposta + auditoria).
 */

import { todosCampos, estruturaFichaSchema, type CampoDef, type EstruturaFicha } from "./ficha.js";
import { configRegrasSchema, type ConfigRegras } from "./regras.js";
import { hpMaximo, CHAVE_HP, CHAVE_VITALIDADE } from "./vida.js";
import { CHAVE_XP } from "./progressao.js";
import { CHAVE_PONTOS } from "./pontos.js";
import { CHAVE_NPC_VISIVEL } from "./npc-visibility.js";

// mesma chave usada pelas rotas de retrato (personagens.ts)
const CHAVE_RETRATO = "__retrato";

export type OrigemEstado = "interna" | "externa";

export interface SaneamentoPersonagem {
  personagemId: string;
  nome: string | null;
  eventosXpDescartados: number;
  ledgerXpInvalidado: boolean;
  financiadoRejeitados: number;
  seloRemovido: boolean;
  bonusAjustado: boolean;
  pontosHistoricoDescartados: number;
  hpCorrigido: boolean;
  hpRemovido: boolean;
  vitalidadeCorrigida: boolean;
  vitalidadeRemovida: boolean;
  retratoRemovido: boolean;
  npcVisivelRemovido: boolean;
}

export interface TotaisSaneamento {
  personagensAfetados: number;
  eventosXpDescartados: number;
  ledgersXpInvalidos: number;
  financiadoRejeitados: number;
  selosRemovidos: number;
  bonusAjustados: number;
  pontosHistoricoDescartados: number;
  hpCorrigidos: number;
  hpRemovidos: number;
  vitalidadeCorrigidas: number;
  vitalidadeRemovidas: number;
  retratosRemovidos: number;
  npcVisivelRemovidos: number;
}

export interface RelatorioSaneamento {
  origem: OrigemEstado;
  totais: TotaisSaneamento;
  personagens: SaneamentoPersonagem[];
}

export function relatorioSaneamentoVazio(origem: OrigemEstado): RelatorioSaneamento {
  return {
    origem,
    totais: {
      personagensAfetados: 0, eventosXpDescartados: 0, ledgersXpInvalidos: 0,
      financiadoRejeitados: 0, selosRemovidos: 0, bonusAjustados: 0,
      pontosHistoricoDescartados: 0, hpCorrigidos: 0, hpRemovidos: 0,
      vitalidadeCorrigidas: 0, vitalidadeRemovidas: 0,
      retratosRemovidos: 0, npcVisivelRemovidos: 0,
    },
    personagens: [],
  };
}

// ---------- contexto de saneamento (montado a partir do próprio estado) ----------

export interface ContextoSaneamento {
  config: ConfigRegras;
  /** templateVersionId → estrutura parseada (null = estrutura inválida/ausente) */
  estruturas: Map<string, EstruturaFicha | null>;
  /** ids de files do pacote (retrato precisa apontar para um deles) */
  arquivosIds: Set<string>;
  /** userId → nome de exibição (autoria forjada é limpa) */
  autores: Map<string, string | null>;
}

const TIPOS_NUMERICOS = new Set(["inteiro", "decimal", "moeda"]);
const TIPOS_XP = new Set(["concessao", "remocao", "compra", "ajuste"]);
const TIPOS_HP = new Set(["inicial", "dano", "recuperacao", "ajuste"]);
const MAX_XP_HISTORICO = 500;
const MAX_PONTOS_HISTORICO = 200;
const MAX_HP_HISTORICO = 100;
const LIMITE_BONUS = 10000;

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const xpNum = (n: number): number => Math.round(n * 10000) / 10000;
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const dataObj = (v: unknown): Record<string, unknown> | null => {
  const o = obj(v);
  if (o) return o;
  if (typeof v === "string") {
    try { return obj(JSON.parse(v)); } catch { return null; }
  }
  return null;
};
const dataValida = (v: unknown): boolean => !Number.isNaN(Date.parse(String(v)));

function estruturaDoPersonagem(
  ctx: ContextoSaneamento,
  templateVersionId: unknown,
): EstruturaFicha | null {
  if (typeof templateVersionId !== "string") return null;
  if (!ctx.estruturas.has(templateVersionId)) return null;
  return ctx.estruturas.get(templateVersionId) ?? null;
}

/** Resolve autorId/autorNome: id conhecido no banco local mantém o nome
 *  oficial; autorId desconhecido limpa os DOIS campos (autoria forjada). */
function sanearAutor(e: Record<string, unknown>, ctx: ContextoSaneamento) {
  const autorId = typeof e.autorId === "string" && e.autorId ? e.autorId : null;
  if (autorId) {
    if (ctx.autores.has(autorId)) {
      e.autorNome = ctx.autores.get(autorId) ?? null;
    } else {
      e.autorId = null;
      e.autorNome = null;
    }
  }
}

// ---------- __xp ----------

const EVENTO_XP_KEYS = ["em", "tipo", "quantidade", "motivo", "autorId", "autorNome", "saldoResultante", "compra"];

function eventoXpValido(e: unknown): e is Record<string, unknown> {
  const o = obj(e);
  if (!o) return false;
  return (
    dataValida(o.em) &&
    typeof o.tipo === "string" && TIPOS_XP.has(o.tipo) &&
    num(o.quantidade) !== null &&
    num(o.saldoResultante) !== null
  );
}

function sanearXp(data: Record<string, unknown>, ctx: ContextoSaneamento, rep: SaneamentoPersonagem, estrutura: EstruturaFicha | null) {
  const bruto = obj(data[CHAVE_XP]);
  if (bruto === null) {
    if (data[CHAVE_XP] !== undefined) {
      delete data[CHAVE_XP];
      rep.ledgerXpInvalidado = true;
    }
    return;
  }

  const saldoBruto = num(bruto.saldo);
  const histBruto = Array.isArray(bruto.historico) ? bruto.historico : [];

  // filtra eventos estruturalmente inválidos e normaliza os válidos
  const validos: Record<string, unknown>[] = [];
  for (const e of histBruto) {
    if (!eventoXpValido(e)) { rep.eventosXpDescartados++; continue; }
    const o = obj(e)!;
    const ev: Record<string, unknown> = {};
    for (const k of EVENTO_XP_KEYS) if (o[k] !== undefined) ev[k] = o[k];
    sanearAutor(ev, ctx);
    validos.push(ev);
  }

  const truncado = validos.length > MAX_XP_HISTORICO;
  if (truncado) {
    rep.eventosXpDescartados += validos.length - MAX_XP_HISTORICO;
    validos.splice(0, validos.length - MAX_XP_HISTORICO);
  }

  // cadeia de saldos: cada saldoResultante deve ser o anterior + delta.
  // Histórico completo (não truncado) ancora no zero: o primeiro evento
  // precisa nascer de saldo 0. Histórico truncado ancora no primeiro
  // evento retido (o prefixo anterior não é verificável).
  let eventosFinais = validos;
  if (validos.length) {
    let quebra = -1;
    if (!truncado) {
      const primeiro = xpNum(num(validos[0].saldoResultante)! - num(validos[0].quantidade)!);
      if (primeiro !== 0) quebra = 0;
    }
    if (quebra < 0) {
      for (let i = 1; i < validos.length; i++) {
        const esperado = xpNum(xpNum(num(validos[i - 1].saldoResultante)!) + xpNum(num(validos[i].quantidade)!));
        if (xpNum(num(validos[i].saldoResultante)!) !== esperado) { quebra = i; break; }
      }
    }
    if (quebra >= 0) {
      rep.eventosXpDescartados += validos.length - quebra;
      eventosFinais = validos.slice(0, quebra);
    }
  }

  // saldo demonstrável: último saldoResultante da cadeia retida;
  // histórico vazio só comprova saldo zero.
  const saldoComprovado = eventosFinais.length
    ? xpNum(num(eventosFinais[eventosFinais.length - 1].saldoResultante)!)
    : 0;
  const saldoOk = saldoBruto !== null && xpNum(saldoBruto) === saldoComprovado;
  if (!saldoOk) {
    // ledger não demonstrável: zera saldo e histórico (não inventa XP)
    rep.ledgerXpInvalidado = true;
    eventosFinais = [];
  }

  // ---- financiado: só campos numéricos existentes na ficha ----
  // Sem ledger demonstrável, nenhuma transição pode ser considerada
  // paga por XP — todas as entradas são rejeitadas.
  const finBruto = obj(bruto.financiado);
  const finValido: Record<string, number[]> = {};
  if (finBruto && !saldoOk) rep.financiadoRejeitados += Object.keys(finBruto).length;
  if (finBruto && saldoOk) {
    const porId = new Map<string, CampoDef>();
    if (estrutura) for (const c of todosCampos(estrutura)) porId.set(c.id, c);
    for (const [campoId, v] of Object.entries(finBruto)) {
      const campo = porId.get(campoId);
      const valorAtual = num(data[campoId]) ?? 0;
      const rejeitar = () => { rep.financiadoRejeitados++; };
      if (!campo || !TIPOS_NUMERICOS.has(campo.tipo)) { rejeitar(); continue; }
      if (Array.isArray(v)) {
        const idx = [...new Set(v.filter((x): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0 && x < valorAtual))].sort((a, b) => a - b);
        if (idx.length) finValido[campoId] = idx; else rejeitar();
      } else {
        const n = num(v);
        // legado (contagem de sufixo): converte para índices somente
        // quando as transições existem no valor atual do campo
        if (n !== null && n > 0 && valorAtual > 0) {
          const ini = Math.max(0, valorAtual - Math.floor(n));
          const idx: number[] = [];
          for (let i = ini; i < valorAtual; i++) idx.push(i);
          if (idx.length) { finValido[campoId] = idx; continue; }
        }
        rejeitar();
      }
    }
  }

  const novoXp: Record<string, unknown> = { saldo: saldoOk ? saldoComprovado : 0, historico: saldoOk ? eventosFinais : [] };
  if (saldoOk && Object.keys(finValido).length) novoXp.financiado = finValido;
  data[CHAVE_XP] = novoXp;
}

// ---------- __pontos ----------

const EVENTO_PONTOS_KEYS = ["em", "quantidade", "motivo", "autorId", "autorNome"];

function eventoPontosValido(e: unknown): e is Record<string, unknown> {
  const o = obj(e);
  if (!o) return false;
  return dataValida(o.em) && num(o.quantidade) !== null;
}

function sanearPontos(data: Record<string, unknown>, ctx: ContextoSaneamento, rep: SaneamentoPersonagem) {
  const bruto = obj(data[CHAVE_PONTOS]);
  if (bruto === null) {
    if (data[CHAVE_PONTOS] !== undefined) delete data[CHAVE_PONTOS];
    return;
  }
  // selo de aprovação é autoridade exclusiva do servidor: SEMPRE removido
  if (bruto.selo !== undefined && bruto.selo !== null) rep.seloRemovido = true;

  const bonusBruto = num(bruto.bonus);
  let bonus = 0;
  if (bonusBruto !== null) bonus = Math.max(-LIMITE_BONUS, Math.min(LIMITE_BONUS, Math.trunc(bonusBruto)));
  if (bonus !== (bruto.bonus ?? 0)) rep.bonusAjustado = true;

  const histBruto = Array.isArray(bruto.historico) ? bruto.historico : [];
  const historico: Record<string, unknown>[] = [];
  for (const e of histBruto) {
    if (!eventoPontosValido(e)) { rep.pontosHistoricoDescartados++; continue; }
    const o = obj(e)!;
    const ev: Record<string, unknown> = {};
    for (const k of EVENTO_PONTOS_KEYS) if (o[k] !== undefined) ev[k] = o[k];
    sanearAutor(ev, ctx);
    historico.push(ev);
  }
  if (historico.length > MAX_PONTOS_HISTORICO) {
    rep.pontosHistoricoDescartados += historico.length - MAX_PONTOS_HISTORICO;
    historico.splice(0, historico.length - MAX_PONTOS_HISTORICO);
  }

  data[CHAVE_PONTOS] = { bonus, historico, selo: null };
}

// ---------- __hp / __vitalidade ----------

function sanearHp(data: Record<string, unknown>, ctx: ContextoSaneamento, rep: SaneamentoPersonagem, estrutura: EstruturaFicha | null) {
  const bruto = obj(data[CHAVE_HP]);
  if (bruto === null) {
    if (data[CHAVE_HP] !== undefined) { delete data[CHAVE_HP]; rep.hpRemovido = true; }
    return;
  }
  if (!ctx.config.hp.habilitado) { delete data[CHAVE_HP]; rep.hpRemovido = true; return; }
  const atualBruto = num(bruto.atual);
  if (atualBruto === null) { delete data[CHAVE_HP]; rep.hpRemovido = true; return; }

  // máximo calculado pela config vigente + estrutura da ficha do personagem
  const maximo = hpMaximo(ctx.config.hp, estrutura ?? { versao: 1, secoes: [], pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} } }, data);
  const teto = maximo ?? Number.MAX_SAFE_INTEGER;
  const atual = Math.min(teto, Math.max(0, atualBruto));
  if (atual !== atualBruto) rep.hpCorrigido = true;

  const histBruto = Array.isArray(bruto.historico) ? bruto.historico : [];
  const historico = histBruto.filter((e) => {
    const o = obj(e);
    return !!o && dataValida(o.em) && typeof o.tipo === "string" && TIPOS_HP.has(o.tipo) && num(o.quantidade) !== null;
  }).slice(-MAX_HP_HISTORICO);

  data[CHAVE_HP] = { atual, historico };
}

function sanearVitalidade(data: Record<string, unknown>, ctx: ContextoSaneamento, rep: SaneamentoPersonagem) {
  const bruto = obj(data[CHAVE_VITALIDADE]);
  if (bruto === null) {
    if (data[CHAVE_VITALIDADE] !== undefined) { delete data[CHAVE_VITALIDADE]; rep.vitalidadeRemovida = true; }
    return;
  }
  const total = ctx.config.vitalidade?.niveis?.length ?? 7;
  const nivelBruto = num(bruto.nivel);
  const nivelManualBruto = num(bruto.nivelManual);
  if (nivelBruto === null) { delete data[CHAVE_VITALIDADE]; rep.vitalidadeRemovida = true; return; }
  const nivel = Math.min(total - 1, Math.max(0, Math.floor(nivelBruto)));
  const nivelManual = nivelManualBruto === null ? undefined : Math.min(total - 1, Math.max(0, Math.floor(nivelManualBruto)));
  if (nivel !== nivelBruto || (nivelManual !== undefined && nivelManual !== nivelManualBruto)) rep.vitalidadeCorrigida = true;

  const histBruto = Array.isArray(bruto.historico) ? bruto.historico : undefined;
  const historico = histBruto?.filter((e) => {
    const o = obj(e);
    return !!o && dataValida(o.em) && num(o.nivelAnterior) !== null && num(o.nivelNovo) !== null;
  }).slice(-MAX_HP_HISTORICO);

  data[CHAVE_VITALIDADE] = {
    nivel,
    ...(nivelManual !== undefined ? { nivelManual } : {}),
    ...(typeof bruto.alteradoEm === "string" ? { alteradoEm: bruto.alteradoEm } : {}),
    ...(bruto.alteradoPor !== undefined ? { alteradoPor: bruto.alteradoPor } : {}),
    ...(historico ? { historico } : {}),
  };
}

// ---------- __retrato / __npcVisivel ----------

function sanearRetrato(data: Record<string, unknown>, ctx: ContextoSaneamento, rep: SaneamentoPersonagem) {
  if (data[CHAVE_RETRATO] === undefined) return;
  const bruto = obj(data[CHAVE_RETRATO]);
  const arquivoId = bruto && typeof bruto.arquivoId === "string" ? bruto.arquivoId : null;
  if (bruto && bruto.tipo === "arquivo" && arquivoId && ctx.arquivosIds.has(arquivoId)) return;
  delete data[CHAVE_RETRATO];
  rep.retratoRemovido = true;
}

function sanearNpcVisivel(data: Record<string, unknown>, rep: SaneamentoPersonagem) {
  if (data[CHAVE_NPC_VISIVEL] === undefined) return;
  const bruto = obj(data[CHAVE_NPC_VISIVEL]);
  if (bruto && typeof bruto.visivel === "boolean") return;
  delete data[CHAVE_NPC_VISIVEL];
  rep.npcVisivelRemovido = true;
}

// ---------- orquestrador ----------

/**
 * Saneia `characters.data` de um pacote externo. Retorna true quando
 * algo foi alterado (o chamador contabiliza no relatório).
 */
export function sanearPersonagemImportado(
  row: Record<string, unknown>,
  ctx: ContextoSaneamento,
  rep: SaneamentoPersonagem,
) {
  const data = dataObj(row.data);
  if (!data) return;
  row.data = data;

  // metadado reservado do arquivamento já tem regra própria em
  // sanitizarArquivamento (restaurar.ts) — autoridade exclusiva do
  // backend, preservada sem abreviar aqui.
  const templateVersionId = (row as Record<string, unknown>).templateVersionId;
  const estrutura = estruturaDoPersonagem(ctx, templateVersionId);

  sanearXp(data, ctx, rep, estrutura);
  sanearPontos(data, ctx, rep);
  sanearHp(data, ctx, rep, estrutura);
  sanearVitalidade(data, ctx, rep);
  sanearRetrato(data, ctx, rep);
  sanearNpcVisivel(data, rep);
}

/** Monta o contexto a partir do EstadoCampanha + usuários do banco. */
export function montarContextoSaneamento(
  dados: {
    ruleSets?: { config?: unknown; isActive?: boolean }[];
    sheetVersions?: { id?: string; structure?: unknown }[];
    files?: { id?: string }[];
  },
  autores: Map<string, string | null>,
): ContextoSaneamento {
  const rsAtivo = (dados.ruleSets ?? []).find((r) => r.isActive);
  let config: ConfigRegras;
  try {
    const cfgBruta = (rsAtivo?.config ?? {}) as Record<string, unknown>;
    config = configRegrasSchema.parse({ ...cfgBruta, pontos: cfgBruta.pontos ?? {} });
  } catch {
    config = configRegrasSchema.parse({});
  }
  const estruturas = new Map<string, EstruturaFicha | null>();
  for (const v of dados.sheetVersions ?? []) {
    if (typeof v.id !== "string") continue;
    try {
      const parsed = typeof v.structure === "string" ? JSON.parse(v.structure) : v.structure;
      estruturas.set(v.id, estruturaFichaSchema.parse(parsed ?? {}));
    } catch {
      estruturas.set(v.id, null);
    }
  }
  return {
    config,
    estruturas,
    arquivosIds: new Set((dados.files ?? []).map((f) => f.id).filter((x): x is string => typeof x === "string")),
    autores,
  };
}
