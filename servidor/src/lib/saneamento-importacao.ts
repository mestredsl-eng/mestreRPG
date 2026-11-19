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
import {
  configRegrasSchema, montarRegrasCampanha,
  type ConfigRegras, type RegrasCampanha,
} from "./regras.js";
import { hpMaximo, CHAVE_HP, CHAVE_VITALIDADE } from "./vida.js";
import {
  CHAVE_XP, KINDS_COMPRAVEIS_XP, precoProximoNivel, vinculosElemento,
} from "./progressao.js";
import { CHAVE_PONTOS } from "./pontos.js";
import { CHAVE_NPC_VISIVEL } from "./npc-visibility.js";
import { retratoGaleriaPorId } from "./retratos.js";
import {
  impressaoDigitalRegras, verificarLedgerXp, type ContextoAssinatura,
} from "./assinatura-xp.js";

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
  hpHistoricoDescartados: number;
  hpCorrigido: boolean;
  hpRemovido: boolean;
  vitalidadeHistoricoDescartados: number;
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
  hpHistoricoDescartados: number;
  hpCorrigidos: number;
  hpRemovidos: number;
  vitalidadeHistoricoDescartados: number;
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
      pontosHistoricoDescartados: 0, hpHistoricoDescartados: 0, hpCorrigidos: 0, hpRemovidos: 0,
      vitalidadeHistoricoDescartados: 0, vitalidadeCorrigidas: 0, vitalidadeRemovidas: 0,
      retratosRemovidos: 0, npcVisivelRemovidos: 0,
    },
    personagens: [],
  };
}

// ---------- contexto de saneamento (montado a partir do próprio estado) ----------

export interface ContextoSaneamento {
  config: ConfigRegras;
  /** regras vigentes do pacote (ruleset ativo + biblioteca de elementos)
   *  — usadas para provar compras de XP contra custo e vínculo reais. */
  regras: RegrasCampanha;
  /** templateVersionId → estrutura parseada (null = estrutura inválida/ausente) */
  estruturas: Map<string, EstruturaFicha | null>;
  /** ids de files do pacote (retrato precisa apontar para um deles) */
  arquivosIds: Set<string>;
  /** userId → nome de exibição (autoria forjada é limpa) */
  autores: Map<string, string | null>;
  /** B1: contexto de verificação HMAC do ledger — null quando a
   *  instalação não tem chave (toda proveniência externa falha). */
  assinatura: ContextoAssinatura | null;
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
// Data precisa ser ISO 8601 estrita — "data-ruim"/epoch/number rejeitados.
const ISO_DATA = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const dataValida = (v: unknown): boolean =>
  typeof v === "string" && ISO_DATA.test(v) && !Number.isNaN(Date.parse(v));

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
  } else {
    // nome sem id verificável não é autoria confiável
    e.autorNome = null;
  }
}

// ---------- __xp ----------

const EVENTO_XP_KEYS = ["em", "tipo", "quantidade", "motivo", "autorId", "autorNome", "saldoResultante", "compra"];

/** Objeto `compra` íntegro: kind/key/campoId identificam o elemento,
 *  a transição é exatamente um nível (nivelNovo = nivelAnterior + 1),
 *  custoXp finito positivo e a quantidade do evento é o débito exato. */
function compraValida(cp: unknown, quantidade: number): cp is Record<string, unknown> {
  const o = obj(cp);
  if (!o) return false;
  if (typeof o.kind !== "string" || !o.kind) return false;
  if (typeof o.key !== "string" || !o.key) return false;
  if (typeof o.campoId !== "string" || !o.campoId) return false;
  if (typeof o.nome !== "string" || !o.nome) return false;
  const na = o.nivelAnterior, nn = o.nivelNovo, cx = num(o.custoXp);
  if (!Number.isInteger(na) || !Number.isInteger(nn) || (na as number) < 0) return false;
  if ((nn as number) !== (na as number) + 1) return false;
  if (cx === null || cx <= 0) return false;
  return xpNum(quantidade) === -xpNum(cx);
}

function eventoXpValido(e: unknown): e is Record<string, unknown> {
  const o = obj(e);
  if (!o) return false;
  const qtd = num(o.quantidade);
  const saldo = num(o.saldoResultante);
  if (!dataValida(o.em)) return false;
  if (typeof o.tipo !== "string" || !TIPOS_XP.has(o.tipo)) return false;
  if (qtd === null || qtd === 0) return false;                    // B1: quantidade zero não é evento
  if (saldo === null || saldo < 0) return false;                  // B1: saldo resultante finito e não-negativo
  if (o.motivo !== undefined && o.motivo !== null && typeof o.motivo !== "string") return false;
  if (o.tipo === "compra" && !compraValida(o.compra, qtd)) return false; // B1: compra íntegra
  return true;
}

function sanearXp(data: Record<string, unknown>, ctx: ContextoSaneamento, rep: SaneamentoPersonagem, estrutura: EstruturaFicha | null, personagemId: string) {
  const bruto = obj(data[CHAVE_XP]);
  if (bruto === null) {
    if (data[CHAVE_XP] !== undefined) {
      delete data[CHAVE_XP];
      rep.ledgerXpInvalidado = true;
    }
    return;
  }

  // B1: PROVENIÊNCIA antes de qualquer validação interna. O pacote
  // controla âncora, eventos, saldos, financiamentos e as próprias
  // regras — uma cadeia coerente pode ser 100% fabricada. Somente a
  // assinatura HMAC emitida pelo servidor na exportação (chave em
  // server_settings, nunca exportada) distingue legítimo de forjado.
  // Sem assinatura válida: fail-closed — saldo zerado, histórico e
  // financiamentos descartados. Dados normais da ficha não são tocados.
  const confiavel = ctx.assinatura !== null &&
    verificarLedgerXp(ctx.assinatura, personagemId, bruto);
  if (!confiavel) {
    rep.ledgerXpInvalidado = true;
    const finSemProva = obj(bruto.financiado);
    if (finSemProva) rep.financiadoRejeitados += Object.keys(finSemProva).length;
    data[CHAVE_XP] = { saldo: 0, historico: [] };
    return;
  }

  const saldoBruto = num(bruto.saldo);
  // B1: histórico ausente ou malformado NÃO pode virar "vazio
  // confiável" — sem array explícito o ledger é inválido.
  if (!Array.isArray(bruto.historico)) {
    rep.ledgerXpInvalidado = true;
    data[CHAVE_XP] = { saldo: 0, historico: [] };
    return;
  }
  const histBruto = bruto.historico;

  // filtra eventos estruturalmente inválidos e normaliza os válidos
  const validos: Record<string, unknown>[] = [];
  for (const e of histBruto) {
    if (!eventoXpValido(e)) { rep.eventosXpDescartados++; continue; }
    const o = obj(e)!;
    const ev: Record<string, unknown> = {};
    for (const k of EVENTO_XP_KEYS) {
      if (o[k] === undefined) continue;
      if (k === "compra" && o.tipo !== "compra") continue; // compra só existe em evento de compra
      ev[k] = o[k];
    }
    sanearAutor(ev, ctx);
    validos.push(ev);
  }

  // B1: âncora verificável do saldo inicial. O servidor grava `ancora`
  // quando trunca o histórico no teto de persistência; pacotes antigos
  // sem o campo são tratados como completos desde o zero. Um valor
  // presente mas inválido torna o ledger não demonstrável.
  const ancoraBruta = bruto.ancora === undefined || bruto.ancora === null
    ? 0
    : num(bruto.ancora);
  if (ancoraBruta === null || ancoraBruta < 0) {
    rep.ledgerXpInvalidado = true;
    const finBrutoInv = obj(bruto.financiado);
    if (finBrutoInv) rep.financiadoRejeitados += Object.keys(finBrutoInv).length;
    data[CHAVE_XP] = { saldo: 0, historico: [] };
    return;
  }

  // B1: validar a cadeia INTEGRAL recebida ANTES de qualquer limite de
  // armazenamento. O primeiro evento precisa nascer exatamente da
  // âncora declarada — sem isso, 501 eventos fabricados a partir de um
  // saldo inicial falso seriam "coerentes". Ruptura descarta apenas o
  // sufixo não demonstrável; o prefixo válido é preservado.
  let eventosFinais = validos;
  let ancoraFinal = ancoraBruta;
  if (validos.length) {
    let quebra = -1;
    const primeiro = xpNum(num(validos[0].saldoResultante)! - num(validos[0].quantidade)!);
    if (xpNum(primeiro) !== xpNum(ancoraBruta)) quebra = 0;
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

  // Só DEPOIS de demonstrada a cadeia é que o teto de armazenamento
  // (MAX_XP_HISTORICO) é aplicado — retendo os últimos eventos e
  // carregando a nova âncora calculada do primeiro retido. Histórico
  // legítimo com mais de 500 eventos é preservado; truncamento forjado
  // já foi rejeitado pela âncora acima.
  if (eventosFinais.length > MAX_XP_HISTORICO) {
    const retidos = eventosFinais.slice(-MAX_XP_HISTORICO);
    rep.eventosXpDescartados += eventosFinais.length - retidos.length;
    eventosFinais = retidos;
    ancoraFinal = xpNum(
      num(eventosFinais[0].saldoResultante)! - num(eventosFinais[0].quantidade)!,
    );
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

  // ---- financiado: só campos numéricos existentes na ficha, e cada
  // índice precisa de PROVA COMPLETA: um evento de compra retido na
  // cadeia cujo kind/key existem na biblioteca do pacote, cujo kind é
  // elegível a XP, cujo campoId corresponde a um vínculo modo "nivel"
  // do elemento e cujo custoXp é IGUAL ao preço recalculado pelas
  // regras vigentes para a transição nivelAnterior→nivelNovo (B2).
  // Compra com metadados ou custo inventados não financia nada.
  // Sem histórico demonstrável (ou sem estrutura da ficha) nenhuma
  // transição é considerada paga por XP.
  const finBruto = obj(bruto.financiado);
  const finValido: Record<string, number[]> = {};
  if (finBruto && !saldoOk) rep.financiadoRejeitados += Object.keys(finBruto).length;
  if (finBruto && saldoOk) {
    const provas = new Set<string>();
    if (estrutura) {
      for (const ev of eventosFinais) {
        if (ev.tipo !== "compra") continue;
        const cp = obj(ev.compra);
        if (!cp) continue;
        const { kind, key, campoId } = cp;
        const na = cp.nivelAnterior, nn = cp.nivelNovo, cx = num(cp.custoXp);
        if (typeof kind !== "string" || typeof key !== "string" || typeof campoId !== "string") continue;
        if (!KINDS_COMPRAVEIS_XP.has(kind)) continue;
        if (!Number.isInteger(na) || !Number.isInteger(nn) || cx === null) continue;
        const elemento = ctx.regras.elementos.get(`${kind}:${key}`);
        if (!elemento || elemento.definition.disponivel === false) continue;
        // o campo financiado precisa ser o campo que ESTE elemento
        // realmente expressa em modo "nivel" — sem vínculo, a compra
        // não pode ter escrito naquele campo.
        const vinculo = vinculosElemento(estrutura, kind, key)
          .find((v) => v.campo.id === campoId && v.modo === "nivel");
        if (!vinculo) continue;
        // custo tem que bater com o preço das regras vigentes para a
        // mesma transição — custo inventado não gera prova.
        const preco = precoProximoNivel(
          estrutura, data, ctx.regras, elemento, vinculo,
          na as number, nn as number,
        );
        if (preco.preco === null || xpNum(preco.preco) !== xpNum(cx)) continue;
        provas.add(`${campoId}|${na}`);
      }
    }
    const porId = new Map<string, CampoDef>();
    if (estrutura) for (const c of todosCampos(estrutura)) porId.set(c.id, c);
    const comprovar = (campoId: string, candidatos: number[]): number[] => {
      const provados = candidatos.filter((i) => provas.has(`${campoId}|${i}`));
      rep.financiadoRejeitados += candidatos.length - provados.length;
      return [...new Set(provados)].sort((a, b) => a - b);
    };
    for (const [campoId, v] of Object.entries(finBruto)) {
      const campo = porId.get(campoId);
      const valorAtual = num(data[campoId]) ?? 0;
      if (!campo || !TIPOS_NUMERICOS.has(campo.tipo)) {
        rep.financiadoRejeitados += Array.isArray(v) ? v.length : 1;
        continue;
      }
      let candidatos: number[] = [];
      if (Array.isArray(v)) {
        candidatos = v.filter((x): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0 && x < valorAtual);
      } else {
        const n = num(v);
        // legado (contagem de sufixo): converte para índices somente
        // quando as transições existem no valor atual do campo
        if (n !== null && n > 0 && valorAtual > 0) {
          const ini = Math.max(0, valorAtual - Math.floor(n));
          for (let i = ini; i < valorAtual; i++) candidatos.push(i);
        }
      }
      const idx = comprovar(campoId, candidatos);
      if (idx.length) finValido[campoId] = idx;
    }
  }

  const novoXp: Record<string, unknown> = { saldo: saldoOk ? saldoComprovado : 0, historico: saldoOk ? eventosFinais : [] };
  // âncora > 0 só existe quando o histórico foi truncado pelo teto —
  // preserva a origem verificável do primeiro evento retido (B1).
  if (saldoOk && eventosFinais.length && ancoraFinal > 0) novoXp.ancora = ancoraFinal;
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

const EVENTO_HP_KEYS = ["em", "tipo", "quantidade", "motivo", "autorId", "autorNome"];

function eventoHpValido(e: unknown): e is Record<string, unknown> {
  const o = obj(e);
  if (!o) return false;
  const qtd = num(o.quantidade);
  return (
    dataValida(o.em) &&
    typeof o.tipo === "string" && TIPOS_HP.has(o.tipo) &&
    qtd !== null && qtd !== 0 &&
    (o.motivo === undefined || o.motivo === null || typeof o.motivo === "string")
  );
}

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

  // B4: histórico reconstruído por whitelist — nada arbitrário do
  // pacote sobrevive; eventos inválidos são contabilizados.
  const histBruto = Array.isArray(bruto.historico) ? bruto.historico : [];
  const historico: Record<string, unknown>[] = [];
  for (const e of histBruto) {
    if (!eventoHpValido(e)) { rep.hpHistoricoDescartados++; continue; }
    const o = obj(e)!;
    const ev: Record<string, unknown> = {};
    for (const k of EVENTO_HP_KEYS) if (o[k] !== undefined) ev[k] = o[k];
    sanearAutor(ev, ctx);
    historico.push(ev);
  }
  if (historico.length > MAX_HP_HISTORICO) {
    rep.hpHistoricoDescartados += historico.length - MAX_HP_HISTORICO;
    historico.splice(0, historico.length - MAX_HP_HISTORICO);
  }

  data[CHAVE_HP] = { atual, historico };
}

// `limiares` NÃO entra na whitelist: é snapshot da config do servidor
// que alimenta a leitura pública de NPC (teto de exibição). Um pacote
// externo nunca podefornecer esse snapshot — evento de conversão
// importado fica sem limiares e a leitura cai no fallback conservador
// (só o piso manual). Nunca validar "dentro da faixa" e preservar.
const EVENTO_VIT_KEYS = ["em", "nivelAnterior", "nivelNovo", "motivo", "autorId", "autorNome", "origem"];
const ORIGENS_VIT = new Set(["manual", "conversao-ferimento"]);

function eventoVitalidadeValido(e: unknown, total: number): e is Record<string, unknown> {
  const o = obj(e);
  if (!o) return false;
  const na = o.nivelAnterior, nn = o.nivelNovo;
  if (!dataValida(o.em)) return false;
  if (!Number.isInteger(na) || (na as number) < 0 || (na as number) >= total) return false;
  if (!Number.isInteger(nn) || (nn as number) < 0 || (nn as number) >= total) return false;
  if (o.origem !== undefined && (typeof o.origem !== "string" || !ORIGENS_VIT.has(o.origem))) return false;
  // conversão automática só sobe — coerência com a regra de produção
  if (o.origem === "conversao-ferimento" && (nn as number) <= (na as number)) return false;
  if (o.motivo !== undefined && o.motivo !== null && typeof o.motivo !== "string") return false;
  return true;
}

function sanearVitalidade(data: Record<string, unknown>, ctx: ContextoSaneamento, rep: SaneamentoPersonagem) {
  const bruto = obj(data[CHAVE_VITALIDADE]);
  if (bruto === null) {
    if (data[CHAVE_VITALIDADE] !== undefined) { delete data[CHAVE_VITALIDADE]; rep.vitalidadeRemovida = true; }
    return;
  }
  const total = ctx.config.vitalidade?.niveis?.length ?? 7;
  // B3: nível precisa ser inteiro DENTRO da escala — valor fora é
  // dado inválido e cai no fallback conservador (chave removida →
  // leitura assume nível 0, nunca amplia penalidade pública).
  const nivelBruto = num(bruto.nivel);
  const nivelValido = nivelBruto !== null && Number.isInteger(nivelBruto) && nivelBruto >= 0 && nivelBruto < total;
  if (!nivelValido) { delete data[CHAVE_VITALIDADE]; rep.vitalidadeRemovida = true; return; }
  const nivelManualBruto = num(bruto.nivelManual);
  const nivelManual = nivelManualBruto !== null && Number.isInteger(nivelManualBruto) && nivelManualBruto >= 0 && nivelManualBruto < total
    ? nivelManualBruto : undefined;
  if (nivelManualBruto !== null && nivelManualBruto !== undefined && nivelManual === undefined) rep.vitalidadeCorrigida = true;

  // histórico reconstruído por whitelist: campos arbitrários do pacote
  // não sobrevivem; limiares inválidos derrubam o snapshot do evento
  // (leitura pública cai no fallback conservador).
  let historico: Record<string, unknown>[] | undefined;
  if (bruto.historico !== undefined) {
    if (Array.isArray(bruto.historico)) {
      historico = [];
      for (const e of bruto.historico) {
        if (!eventoVitalidadeValido(e, total)) { rep.vitalidadeHistoricoDescartados++; continue; }
        const o = obj(e)!;
        const ev: Record<string, unknown> = {};
        for (const k of EVENTO_VIT_KEYS) {
          if (o[k] !== undefined) ev[k] = o[k];
        }
        sanearAutor(ev, ctx);
        historico.push(ev);
      }
      if (historico.length > MAX_HP_HISTORICO) {
        rep.vitalidadeHistoricoDescartados += historico.length - MAX_HP_HISTORICO;
        historico.splice(0, historico.length - MAX_HP_HISTORICO);
      }
    } else {
      rep.vitalidadeCorrigida = true;
    }
  }

  // alteradoPor é userId: resolve contra usuários locais — id
  // desconhecido ou tipo inválido é limpo (autoria forjada não entra).
  const ap = bruto.alteradoPor;
  let alteradoPor: string | null | undefined;
  if (typeof ap === "string" && ap) {
    alteradoPor = ctx.autores.has(ap) ? ap : null;
    if (alteradoPor === null) rep.vitalidadeCorrigida = true;
  } else if (ap === null) {
    alteradoPor = null;
  } else if (ap !== undefined) {
    rep.vitalidadeCorrigida = true;
  }

  data[CHAVE_VITALIDADE] = {
    nivel: nivelBruto,
    ...(nivelManual !== undefined ? { nivelManual } : {}),
    ...(typeof bruto.alteradoEm === "string" && dataValida(bruto.alteradoEm) ? { alteradoEm: bruto.alteradoEm } : {}),
    ...(alteradoPor !== undefined ? { alteradoPor } : {}),
    ...(historico ? { historico } : {}),
  };
}

// ---------- __retrato / __npcVisivel ----------

function sanearRetrato(data: Record<string, unknown>, ctx: ContextoSaneamento, rep: SaneamentoPersonagem) {
  if (data[CHAVE_RETRATO] === undefined) return;
  const bruto = obj(data[CHAVE_RETRATO]);
  const arquivoId = bruto && typeof bruto.arquivoId === "string" ? bruto.arquivoId : null;
  if (bruto && bruto.tipo === "arquivo" && arquivoId && ctx.arquivosIds.has(arquivoId)) return;
  // galeria: só id presente no catálogo oficial do servidor
  if (bruto && bruto.tipo === "galeria" && typeof bruto.id === "string" && retratoGaleriaPorId(bruto.id)) return;
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

  sanearXp(data, ctx, rep, estrutura, String(row.id ?? ""));
  sanearPontos(data, ctx, rep);
  sanearHp(data, ctx, rep, estrutura);
  sanearVitalidade(data, ctx, rep);
  sanearRetrato(data, ctx, rep);
  sanearNpcVisivel(data, rep);
}

/** Monta o contexto a partir do EstadoCampanha + usuários do banco. */
export function montarContextoSaneamento(
  dados: {
    ruleSets?: ({ id?: string; config?: unknown; isActive?: boolean })[];
    ruleDefinitions?: ({ ruleSetId?: string } & Record<string, unknown>)[];
    sheetVersions?: { id?: string; structure?: unknown }[];
    files?: { id?: string }[];
    campanha?: Record<string, unknown>;
  },
  autores: Map<string, string | null>,
  opts: { chaveAssinatura?: Buffer | null } = {},
): ContextoSaneamento {
  const rsAtivo = (dados.ruleSets ?? []).find((r) => r.isActive);
  let config: ConfigRegras;
  try {
    const cfgBruta = (rsAtivo?.config ?? {}) as Record<string, unknown>;
    config = configRegrasSchema.parse({ ...cfgBruta, pontos: cfgBruta.pontos ?? {} });
  } catch {
    config = configRegrasSchema.parse({});
  }
  // B2: regras completas (elementos kind:key) montadas das linhas do
  // pacote — mesma fonte usada pelo motor de progression real. Se a
  // montagem falhar, o mapa fica vazio e todo `financiado` é rejeitado
  // (fail-closed: sem prova de custo, nada é considerado pago por XP).
  let regras: RegrasCampanha;
  try {
    const defs = (dados.ruleDefinitions ?? []).filter((d) => d.ruleSetId === rsAtivo?.id);
    regras = rsAtivo
      ? montarRegrasCampanha(
          rsAtivo as unknown as Parameters<typeof montarRegrasCampanha>[0],
          defs as unknown as Parameters<typeof montarRegrasCampanha>[1],
        )
      : { ruleSetId: null, config, elementos: new Map(), porKind: new Map() };
  } catch {
    regras = { ruleSetId: rsAtivo?.id ?? null, config, elementos: new Map(), porKind: new Map() };
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
  // B1: proveniência do ledger — a assinatura HMAC cobre personagem,
  // ledger integral e a impressão digital das regras DO PACOTE. Sem
  // chave de instalação não há como distinguir pacote legítimo de
  // fabricado: fail-closed.
  const chave = opts.chaveAssinatura ?? null;
  const assinatura: ContextoAssinatura | null = chave
    ? {
        chave,
        regrasFp: impressaoDigitalRegras(dados.ruleSets, dados.ruleDefinitions),
      }
    : null;
  return {
    config,
    regras,
    estruturas,
    arquivosIds: new Set((dados.files ?? []).map((f) => f.id).filter((x): x is string => typeof x === "string")),
    autores,
    assinatura,
  };
}
