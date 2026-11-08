import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { ruleSets, ruleDefinitions, campaigns } from "../db/schema.js";
import {
  avaliarFormula,
  calcularPontos,
  mapaCampos,
  referenciasFormula,
  todosCampos,
  type EstruturaFicha,
  type CampoDef,
  type PontosConfig,
  pontosConfigSchema,
} from "./ficha.js";

const db = getDb();

// ---------- Tipos ----------

export const TIPOS_REGRA = [
  "atributo",
  "talento",
  "habilidade",
  "conhecimento",
  "profissao",
  "especializacao",
  "vantagem",
  "defeito",
  "poder",
  "disciplina",
  "pericia",
  "caracteristica",
] as const;
export type TipoRegra = (typeof TIPOS_REGRA)[number];

export const configRegrasSchema = z.object({
  aprovacaoAutomatica: z.boolean().default(false), // spec §9: padrão = aprovação manual
  pontos: pontosConfigSchema.default({ habilitado: false, pontosIniciais: 0, pools: [], custos: {} }),
  pontosExtras: z.number().default(0), // pontos adicionais por personagem (spec §5)
  transferivelEntreReservas: z.boolean().default(false), // spec §5.3
  // Arestas autorizadas de transferência: origem pode ceder pontos ao destino.
  // `limite` = máximo transferível por personagem (opcional).
  transferencias: z
    .array(
      z.object({
        origem: z.string().min(1).max(80),
        destino: z.string().min(1).max(80),
        limite: z.number().nonnegative().optional(),
      })
    )
    .max(100)
    .default([]),
  // Sistema financeiro fictício da campanha (Etapa 6, spec §7/§8)
  financeiro: z
    .object({
      moedaPrincipal: z.string().max(10).default("BRL"),
      simbolo: z.string().max(10).default("R$"),
      casasDecimais: z.number().int().min(0).max(4).default(2),
      permitirSaldoNegativo: z.boolean().default(false),
      jogadorPix: z.boolean().default(true),       // jogador pode fazer PIX fictício
      jogadorCompraVenda: z.boolean().default(true), // jogador registra compra/venda própria
      moedas: z
        .array(
          z.object({
            codigo: z.string().max(10),
            nome: z.string().max(60),
            simbolo: z.string().max(10).optional(),
            conversaoParaPrincipal: z.number().positive().optional(), // unidades da moeda principal por 1 unidade
          })
        )
        .max(20)
        .default([]),
      faturaCartaoCredito: z.boolean().default(true), // controla limite utilizado/faturas
    })
    .default({
      moedaPrincipal: "BRL",
      simbolo: "R$",
      casasDecimais: 2,
      permitirSaldoNegativo: false,
      jogadorPix: true,
      jogadorCompraVenda: true,
      moedas: [],
      faturaCartaoCredito: true,
    }),
  // Inventário/equipamentos/veículos (Etapa 6, spec §3/§4/§10/§12)
  patrimonio: z
    .object({
      pesoAtivo: z.boolean().default(false),
      pesoMaximo: z.number().nonnegative().default(0),
      jogadorAdicionaItens: z.boolean().default(true),
      jogadorRemoveItens: z.boolean().default(false),
      jogadorEditaEquipamentos: z.boolean().default(true),
      jogadorEditaVeiculos: z.boolean().default(true),
      jogadorCriaContas: z.boolean().default(true),
      slotsEquipamento: z.array(z.string().max(60)).max(30).default([]), // posições configuráveis
    })
    .default({
      pesoAtivo: false,
      pesoMaximo: 0,
      jogadorAdicionaItens: true,
      jogadorRemoveItens: false,
      jogadorEditaEquipamentos: true,
      jogadorEditaVeiculos: true,
      jogadorCriaContas: true,
      slotsEquipamento: [],
    }),
  // Mesa em tempo real (Etapa 7)
  mesa: z
    .object({
      acaoForaDeTurno: z.boolean().default(true),   // jogadores podem declarar ações fora do turno
      espectadorLe: z.boolean().default(true),      // espectador acompanha chat/rolagens públicas
    })
    .default({ acaoForaDeTurno: true, espectadorLe: true }),
  // Diário e anotações (Etapa 8)
  notas: z
    .object({
      jogadorCompartilha: z.boolean().default(true), // jogador pode compartilhar anotações do diário
      espectadorLeCompartilhadas: z.boolean().default(true), // espectador vê anotações públicas/selecionadas para ele
    })
    .default({ jogadorCompartilha: true, espectadorLeCompartilhadas: true }),
  // Biblioteca de arquivos (Etapa 9)
  arquivos: z
    .object({
      jogadoresEnviam: z.boolean().default(true),   // jogadores podem enviar arquivos (vão p/ aprovação)
      espectadorVe: z.boolean().default(true),      // espectador vê arquivos públicos
      formatosExtras: z.array(z.string().max(10)).max(50).default([]), // extensões adicionais permitidas pelo mestre
    })
    .default({ jogadoresEnviam: true, espectadorVe: true, formatosExtras: [] }),
  // Relação Poderes × Defeitos (campos selecao_multipla/selecao_nivel ligados
  // a elementos kind "poder"/"defeito").
  poderes: z
    .object({
      // Máximo de poderes distintos por personagem. null = sem limite.
      limitePoderes: z.number().int().min(1).max(50).nullable().default(1),
      // Poder selecionado exige ao menos 1 defeito (qualquer um).
      exigirDefeito: z.boolean().default(false),
      // Máximo de defeitos distintos. null/undefined = sem limite.
      limiteDefeitos: z.number().int().min(1).max(50).nullable().optional(),
    })
    .default({ limitePoderes: 1, exigirDefeito: false }),
});
export type ConfigRegras = z.infer<typeof configRegrasSchema>;

export const definicaoElementoSchema = z.object({
  descricao: z.string().max(4000).optional(),
  subcategoria: z.string().max(120).optional(),
  custoPontos: z.number().optional(),          // custo fixo por ponto
  custoProgressivo: z.array(z.number()).max(100).optional(), // ex.: talentos [1,2,3,4,5]
  // Níveis graduados (ex.: defeitos 1–5): cada nível tem descrição e custo
  // incremental próprios. Custo negativo concede pontos. O tamanho do array
  // define o máximo de níveis (1–5).
  niveis: z
    .array(
      z.object({
        descricao: z.string().max(2000).optional(),
        custo: z.number().optional(),
      })
    )
    .max(5)
    .default([]),
  minimo: z.number().optional(),
  maximo: z.number().optional(),
  prerequisitos: z.array(z.object({
    kind: z.string().max(40),
    key: z.string().max(80),
    minLevel: z.number().optional(),
  })).max(50).default([]),
  dependencias: z.array(z.object({ kind: z.string().max(40), key: z.string().max(80) })).max(50).default([]),
  grupoExclusividade: z.string().max(80).optional(), // legado: um único grupo
  gruposExclusividade: z.array(z.string().max(80)).max(20).default([]), // spec: vários grupos por elemento
  exclusivos: z.array(z.string().max(80)).max(50).default([]), // keys de elementos incompatíveis
  obrigatorios: z.array(z.string().max(80)).max(50).default([]), // defeitos/itens exigidos
  // Fórmulas personalizadas (parser seguro de ficha.ts — sem eval).
  // Chaves especiais: "custo" (custo em pontos p/ escolhas por seleção),
  // "requisito" (deve ser ≠0), "minimo"/"maximo" (limites calculados).
  // Demais chaves são cálculos expostos na validação. Fórmulas só leem
  // campos da ficha ({id}) — não referenciam outras fórmulas, logo não
  // há dependências circulares.
  formulas: z.record(z.string().max(60), z.string().max(500)).default({}),
  reservaPontos: z.string().max(80).optional(),
  disponivel: z.boolean().default(true),
  ordem: z.number().default(0),
});
export type DefinicaoElemento = z.infer<typeof definicaoElementoSchema>;

export interface ElementoRegra {
  id: string;
  ruleSetId: string;
  kind: string;
  key: string;
  name: string;
  category: string | null;
  parentKey: string | null;
  definition: DefinicaoElemento;
  createdAt: Date;
  updatedAt: Date;
}

// ---------- Carregamento ----------

export interface RegrasCampanha {
  ruleSetId: string | null;
  config: ConfigRegras;
  elementos: Map<string, ElementoRegra>; // chave: `${kind}:${key}`
  porKind: Map<string, ElementoRegra[]>;
}

const CHAVE = (kind: string, key: string) => `${kind}:${key}`;

/** Garante que a campanha tenha um ruleset ativo e o retorna com seus elementos. */
export async function carregarRegras(campaignId: string): Promise<RegrasCampanha> {
  let [rs] = await db.select().from(ruleSets).where(and(eq(ruleSets.campaignId, campaignId), eq(ruleSets.isActive, true))).limit(1);
  if (!rs) {
    const agora = new Date();
    const id = crypto.randomUUID();
    const config = configRegrasSchema.parse({});
    await db.insert(ruleSets).values({
      id, campaignId, name: "Regras da campanha", version: 1, isActive: true, config, createdAt: agora, updatedAt: agora,
    });
    [rs] = await db.select().from(ruleSets).where(eq(ruleSets.id, id)).limit(1);
  }

  const defs = await db.select().from(ruleDefinitions).where(eq(ruleDefinitions.ruleSetId, rs.id));
  const elementos = new Map<string, ElementoRegra>();
  const porKind = new Map<string, ElementoRegra[]>();
  for (const d of defs) {
    const el: ElementoRegra = {
      id: d.id,
      ruleSetId: d.ruleSetId,
      kind: d.kind,
      key: d.key,
      name: d.name,
      category: d.category,
      parentKey: d.parentKey,
      definition: definicaoElementoSchema.parse(d.definition ?? {}),
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    };
    elementos.set(CHAVE(el.kind, el.key), el);
    const lista = porKind.get(el.kind) ?? [];
    lista.push(el);
    porKind.set(el.kind, lista);
  }
  for (const lista of porKind.values()) lista.sort((a, b) => a.definition.ordem - b.definition.ordem || a.name.localeCompare(b.name));

  const cfgBruta = (rs.config ?? {}) as Record<string, unknown>;
  const config = configRegrasSchema.parse({ ...cfgBruta, pontos: cfgBruta.pontos ?? {} });
  return { ruleSetId: rs.id, config, elementos, porKind };
}

/**
 * Config de pontos efetiva: ruleset da campanha tem prioridade quando
 * `config.pontos.habilitado`; senão usa a `pontos` da estrutura da ficha
 * (compatibilidade com fichas publicadas antes da Etapa 5).
 */
export function pontosEfetivos(estrutura: EstruturaFicha, regras: RegrasCampanha): PontosConfig {
  const cfg = regras.config.pontos;
  if (cfg.habilitado) {
    // Garante um pool "principal" implícito: pontos iniciais/extras são o
    // orçamento geral do personagem e NÃO devem cair numa reserva de
    // categoria (vantagens/defeitos são reservas independentes — spec §5.3).
    const pools = [
      { id: "principal", nome: "Principal", pontos: 0 },
      ...cfg.pools.filter((p) => p.id !== "principal"),
    ];
    return {
      ...cfg,
      pontosIniciais: cfg.pontosIniciais + regras.config.pontosExtras,
      pools,
    };
  }
  return estrutura.pontos;
}

// ---------- Escolhas na ficha ----------

export interface Escolha {
  campoId: string;
  campo: CampoDef;
  elemento: ElementoRegra | null;
  level: number;      // nível numérico (0 = não escolhido)
  selecionado: boolean; // escolha booleana (seleção/lista/tabela)
}

/** Extrai as escolhas de elementos da biblioteca a partir dos dados da ficha. */
export function extrairEscolhas(estrutura: EstruturaFicha, dados: Record<string, unknown>, regras: RegrasCampanha): Escolha[] {
  const escolhas: Escolha[] = [];
  for (const campo of todosCampos(estrutura)) {
    const valor = dados[campo.id];
    if (valor === undefined || valor === null) continue;

    // Modo 1: campo vinculado a um elemento específico (campo.regra)
    if (campo.regra) {
      const elemento = regras.elementos.get(CHAVE(campo.regra.kind, campo.regra.key)) ?? null;
      const n = typeof valor === "number" ? valor : 0;
      escolhas.push({ campoId: campo.id, campo, elemento, level: Math.max(0, n), selecionado: n > 0 });
      continue;
    }

    // Modo 2: campo de seleção preenchido pela biblioteca (campo.regraKind)
    if (campo.regraKind) {
      // selecao_nivel: itens {key, nivel} — nível graduado (ex.: defeitos)
      if (campo.tipo === "selecao_nivel") {
        const itens = Array.isArray(valor) ? valor : [];
        for (const item of itens) {
          if (typeof item !== "object" || item === null) continue;
          const { key, nivel } = item as Record<string, unknown>;
          if (typeof key !== "string" || !key) continue;
          const n = typeof nivel === "number" && Number.isInteger(nivel) ? Math.max(0, nivel) : 0;
          const elemento = regras.elementos.get(CHAVE(campo.regraKind, key)) ?? null;
          escolhas.push({ campoId: campo.id, campo, elemento, level: n, selecionado: n > 0 });
        }
        continue;
      }
      const opcoes = Array.isArray(valor) ? valor : valor ? [valor] : [];
      for (const op of opcoes) {
        const key = String(op);
        const elemento = regras.elementos.get(CHAVE(campo.regraKind, key)) ?? null;
        escolhas.push({ campoId: campo.id, campo, elemento, level: 1, selecionado: true });
      }
    }
  }
  return escolhas;
}

export interface ErroRegra {
  campoId?: string;
  codigo: string;
  mensagem: string;
}

/**
 * Estrutura efetiva para cálculo de pontos: campos vinculados a elementos
 * da biblioteca (campo.regra) herdam custo/limites do elemento.
 */
export function estruturaComCustosDeElementos(estrutura: EstruturaFicha, regras: RegrasCampanha): EstruturaFicha {
  return {
    ...estrutura,
    pontos: pontosEfetivos(estrutura, regras),
    secoes: estrutura.secoes.map((s) => ({
      ...s,
      campos: s.campos.map((campo) => {
        if (!campo.regra) return campo;
        const el = regras.elementos.get(CHAVE(campo.regra.kind, campo.regra.key));
        if (!el) return campo;
        const def = el.definition;
        return {
          ...campo,
          custoPontos: def.custoPontos ?? campo.custoPontos,
          custoProgressivo: def.custoProgressivo?.length ? def.custoProgressivo : campo.custoProgressivo,
          reservaPontos: def.reservaPontos ?? campo.reservaPontos,
          minimo: def.minimo ?? campo.minimo,
          maximo: def.maximo ?? campo.maximo,
        };
      }),
    })),
  };
}

const TIPOS_SELECAO = new Set(["selecao_unica", "selecao_multipla", "selecao_nivel", "lista", "tabela", "checkbox"]);

/**
 * Custos de elementos escolhidos via campos de seleção/lista
 * (vantagens, defeitos, poderes...) — calcularPontos só vê campos
 * numéricos. Retorna Map poolId → custo total. Deduplica por elemento.
 */
export function custosSelecao(
  estrutura: EstruturaFicha,
  dados: Record<string, unknown>,
  regras: RegrasCampanha
): { custos: Map<string, number>; erros: string[] } {
  const custoPorPool = new Map<string, number>();
  const erros: string[] = [];
  const escolhas = extrairEscolhas(estrutura, dados, regras);
  const nivelPorElemento = new Map<string, { level: number; campoId: string; campo: CampoDef }>();
  for (const e of escolhas) {
    if (!e.elemento || !e.selecionado || !TIPOS_SELECAO.has(e.campo.tipo)) continue;
    const chave = CHAVE(e.elemento.kind, e.elemento.key);
    const atual = nivelPorElemento.get(chave);
    if (!atual || e.level > atual.level) nivelPorElemento.set(chave, { level: e.level, campoId: e.campoId, campo: e.campo });
  }
  for (const [chave, info] of nivelPorElemento) {
    const el = regras.elementos.get(chave)!;
    const def = el.definition;
    let custo = 0;
    const formulaCusto = def.formulas?.custo;
    if (formulaCusto) {
      // Custo calculado por fórmula (spec: custos condicionais)
      try {
        custo = Number(avaliarFormula(formulaCusto, dados, estrutura)) || 0;
      } catch {
        erros.push(`Fórmula de custo inválida em "${el.name}"`);
        continue;
      }
    } else if (def.niveis?.length) {
      // Níveis graduados: custo incremental de cada nível até o nível
      // escolhido (niveis[i].custo; fallback custoPontos do elemento).
      // Custos negativos concedem pontos (ex.: defeito = bônus).
      for (let i = 0; i < Math.min(info.level, def.niveis.length); i++) {
        custo += def.niveis[i].custo ?? def.custoPontos ?? 0;
      }
    } else if (def.custoPontos !== undefined) custo = def.custoPontos * info.level;
    else if (def.custoProgressivo?.length) {
      for (let i = 0; i < Math.min(info.level, def.custoProgressivo.length); i++) custo += def.custoProgressivo[i];
    }
    if (custo === 0) continue;
    const poolId = def.reservaPontos ?? "principal";
    custoPorPool.set(poolId, (custoPorPool.get(poolId) ?? 0) + custo);
  }
  return { custos: custoPorPool, erros };
}

/** Aplica custosSelecao sobre um ResultadoPontos já calculado. */
export function aplicarCustosSelecao(
  pontos: ReturnType<typeof calcularPontos>,
  estrutura: EstruturaFicha,
  dados: Record<string, unknown>,
  regras: RegrasCampanha
): ReturnType<typeof calcularPontos> {
  if (!pontos.habilitado) return pontos;
  const { custos, erros } = custosSelecao(estrutura, dados, regras);
  for (const erro of erros) pontos.erros.push(erro);
  for (const [poolId, custo] of custos) {
    let pool = pontos.pools.find((p) => p.id === poolId);
    if (!pool) {
      const declarado = regras.config.pontos.pools.find((p) => p.id === poolId);
      pool = { id: poolId, nome: declarado?.nome ?? poolId, disponiveis: declarado?.pontos ?? 0, gastos: 0, saldo: 0 };
      pontos.pools.push(pool);
    }
    pool.gastos += custo;
    pool.saldo = pool.disponiveis - pool.gastos;
    if (pool.saldo < 0 && !pontos.erros.includes(`Pool "${pool.nome}": pontos insuficientes (saldo ${pool.saldo})`)) {
      pontos.erros.push(`Pool "${pool.nome}": pontos insuficientes (saldo ${pool.saldo})`);
    }
  }
  return pontos;
}

/**
 * Transferência entre reservas (spec §5.3 / ajuste final).
 *
 * - `transferivelEntreReservas` desligado → reservas totalmente isoladas.
 * - Ligado → só é possível transferir ao longo das arestas configuradas
 *   em `config.transferencias` ({origem → destino, limite?}).
 * - Pools com déficit são cobertos por pools com superávit via BFS nas
 *   arestas autorizadas; cada ponto é movido uma única vez, nunca gera
 *   saldo negativo na origem e respeita `limite` por aresta.
 * - Registra `cedidos`/`recebidos` por pool e a lista de transferências.
 */
export function aplicarTransferencias(
  pontos: ReturnType<typeof calcularPontos>,
  regras: RegrasCampanha
): ReturnType<typeof calcularPontos> {
  if (!pontos.habilitado || !regras.config.transferivelEntreReservas) return pontos;

  const arestas = regras.config.transferencias;
  if (!arestas.length) return pontos;

  const adj = new Map<string, { destino: string; limite?: number }[]>();
  for (const a of arestas) {
    const lista = adj.get(a.origem) ?? [];
    lista.push({ destino: a.destino, limite: a.limite });
    adj.set(a.origem, lista);
  }

  const saldoDe = new Map(pontos.pools.map((p) => [p.id, p.saldo]));
  const transferencias: { de: string; para: string; pontos: number }[] = [];
  const cedidos = new Map<string, number>();
  const recebidos = new Map<string, number>();
  const usoAresta = new Map<string, number>(); // "origem>destino" -> pontos usados

  // Para cada pool deficitário, busca fontes com superávit alcançáveis
  for (const deficit of pontos.pools.filter((p) => (saldoDe.get(p.id) ?? 0) < 0)) {
    let falta = -(saldoDe.get(deficit.id) ?? 0);
    // BFS a partir do déficit "de trás para frente" não funciona com arestas
    // dirigidas; iteramos fontes com superávit e testamos caminho até o déficit.
    for (const fonte of pontos.pools) {
      if (falta <= 0) break;
      const disponivel = saldoDe.get(fonte.id) ?? 0;
      if (disponivel <= 0 || fonte.id === deficit.id) continue;
      // Caminho fonte → ... → déficit (arestas dirigidas)
      const caminho = bfs(adj, fonte.id, deficit.id);
      if (!caminho) continue;
      let restante = Math.min(disponivel, falta);
      for (const [origem, destino] of caminho) {
        if (restante <= 0) break;
        const arestaKey = `${origem}>${destino}`;
        const aresta = arestas.find((a) => a.origem === origem && a.destino === destino);
        const jaUsado = usoAresta.get(arestaKey) ?? 0;
        const teto = aresta?.limite !== undefined ? aresta.limite - jaUsado : Infinity;
        const mover = Math.min(restante, teto, saldoDe.get(origem)!);
        if (mover <= 0) continue;
        saldoDe.set(origem, saldoDe.get(origem)! - mover);
        saldoDe.set(destino, saldoDe.get(destino)! + mover);
        usoAresta.set(arestaKey, jaUsado + mover);
        cedidos.set(origem, (cedidos.get(origem) ?? 0) + mover);
        recebidos.set(destino, (recebidos.get(destino) ?? 0) + mover);
        transferencias.push({ de: origem, para: destino, pontos: mover });
        restante -= mover;
        falta -= mover;
      }
    }
  }

  for (const pool of pontos.pools) {
    pool.saldo = saldoDe.get(pool.id) ?? pool.saldo;
    pool.cedidos = cedidos.get(pool.id) ?? 0;
    pool.recebidos = recebidos.get(pool.id) ?? 0;
  }
  pontos.transferencias = transferencias;

  // Recalcula erros de saldo após transferências
  pontos.erros = pontos.erros.filter((e) => !e.startsWith("Pool \""));
  for (const pool of pontos.pools) {
    if (pool.saldo < 0) pontos.erros.push(`Pool "${pool.nome}": pontos insuficientes (saldo ${pool.saldo})`);
  }
  return pontos;
}

/** BFS em arestas dirigidas origem→destino. Retorna caminho como pares [de,para]. */
function bfs(
  adj: Map<string, { destino: string; limite?: number }[]>,
  origem: string,
  destino: string
): [string, string][] | null {
  if (origem === destino) return [];
  const fila: [string, [string, string][]][] = [[origem, []]];
  const visitados = new Set([origem]);
  while (fila.length) {
    const [atual, caminho] = fila.shift()!;
    for (const aresta of adj.get(atual) ?? []) {
      if (visitados.has(aresta.destino)) continue;
      const novoCaminho = [...caminho, [atual, aresta.destino] as [string, string]];
      if (aresta.destino === destino) return novoCaminho;
      visitados.add(aresta.destino);
      fila.push([aresta.destino, novoCaminho]);
    }
  }
  return null;
}

/**
 * Valida a ficha contra as regras da campanha:
 * pontos, pré-requisitos, dependências, exclusividades e obrigações.
 * Retorna erros claros; não decide aprovação (isso é do mestre — spec §9).
 */
export function validarRegras(
  estrutura: EstruturaFicha,
  dados: Record<string, unknown>,
  regras: RegrasCampanha
): { ok: boolean; erros: ErroRegra[]; escolhas: Escolha[]; calculos: Record<string, number> } {
  const erros: ErroRegra[] = [];
  const escolhas = extrairEscolhas(estrutura, dados, regras);

  // Mapa de escolhas por elemento (kind:key) — fica o maior nível encontrado
  const nivelPorElemento = new Map<string, { level: number; campoId: string }>();
  for (const e of escolhas) {
    if (!e.elemento || !e.selecionado) continue;
    const chave = CHAVE(e.elemento.kind, e.elemento.key);
    const atual = nivelPorElemento.get(chave);
    if (!atual || e.level > atual.level) nivelPorElemento.set(chave, { level: e.level, campoId: e.campoId });
  }

  const nivelDe = (kind: string, key: string) => nivelPorElemento.get(CHAVE(kind, key))?.level ?? 0;

  // 0) Fórmulas personalizadas dos elementos (parser seguro; sem eval).
  // "minimo"/"maximo" calculam limites; "requisito" deve ser ≠0;
  // "custo" é usado no cálculo de pontos de seleções; demais viram cálculos.
  const limitesFormula = new Map<string, { minimo?: number; maximo?: number }>();
  const calculos: Record<string, number> = {};
  const camposIds = mapaCampos(estrutura);
  for (const [chave, info] of nivelPorElemento) {
    const el = regras.elementos.get(chave)!;
    const formulas = el.definition.formulas ?? {};
    const lim: { minimo?: number; maximo?: number } = {};
    for (const [nome, expr] of Object.entries(formulas)) {
      for (const ref of referenciasFormula(expr)) {
        if (camposIds.size > 0 && !camposIds.has(ref)) {
          erros.push({ campoId: info.campoId, codigo: "formula_referencia", mensagem: `"${el.name}": fórmula "${nome}" usa campo inexistente "${ref}"` });
        }
      }
      let valor: number;
      try {
        valor = Number(avaliarFormula(expr, dados, estrutura));
      } catch {
        erros.push({ campoId: info.campoId, codigo: "formula_invalida", mensagem: `"${el.name}": fórmula "${nome}" é inválida` });
        continue;
      }
      if (!Number.isFinite(valor)) {
        erros.push({ campoId: info.campoId, codigo: "formula_invalida", mensagem: `"${el.name}": fórmula "${nome}" retornou valor inválido` });
        continue;
      }
      calculos[`${el.kind}:${el.key}.${nome}`] = valor;
      if (nome === "minimo") lim.minimo = valor;
      else if (nome === "maximo") lim.maximo = valor;
      else if (nome === "requisito" && valor === 0) {
        erros.push({ campoId: info.campoId, codigo: "requisito_formula", mensagem: `"${el.name}" não atende ao requisito calculado pela fórmula` });
      }
    }
    if (lim.minimo !== undefined || lim.maximo !== undefined) limitesFormula.set(chave, lim);
  }

  // 1) Elementos indisponíveis ou fora dos limites
  for (const e of escolhas) {
    if (!e.selecionado || !e.elemento) {
      if (e.campo.regraKind && e.selecionado && !e.elemento) {
        erros.push({ campoId: e.campoId, codigo: "elemento_inexistente", mensagem: `Elemento desconhecido selecionado em "${e.campo.label}"` });
      }
      continue;
    }
    const def = e.elemento.definition;
    const chaveEl = CHAVE(e.elemento.kind, e.elemento.key);
    const lim = limitesFormula.get(chaveEl);
    const minimo = lim?.minimo ?? def.minimo;
    // Teto efetivo: menor entre máximo declarado, fórmula e nº de níveis.
    const tetos = [lim?.maximo, def.maximo, def.niveis?.length ? def.niveis.length : undefined]
      .filter((v): v is number => v !== undefined);
    const maximo = tetos.length ? Math.min(...tetos) : undefined;
    if (!def.disponivel) {
      erros.push({ campoId: e.campoId, codigo: "indisponivel", mensagem: `"${e.elemento.name}" está desativado nesta campanha` });
    }
    if (minimo !== undefined && e.level < minimo && e.level > 0) {
      erros.push({ campoId: e.campoId, codigo: "abaixo_minimo", mensagem: `"${e.elemento.name}" exige nível mínimo ${minimo}` });
    }
    if (maximo !== undefined && e.level > maximo) {
      erros.push({ campoId: e.campoId, codigo: "acima_maximo", mensagem: `"${e.elemento.name}" permite no máximo nível ${maximo}` });
    }
  }

  // 2) Pré-requisitos e dependências
  for (const [chave, info] of nivelPorElemento) {
    const [kind, key] = chave.split(/:(.*)/s);
    const el = regras.elementos.get(chave)!;
    const def = el.definition;
    for (const pre of def.prerequisitos) {
      const nivel = nivelDe(pre.kind, pre.key);
      const exigido = pre.minLevel ?? 1;
      if (nivel < exigido) {
        const alvo = regras.elementos.get(CHAVE(pre.kind, pre.key));
        erros.push({
          campoId: info.campoId,
          codigo: "pre_requisito",
          mensagem: `"${el.name}" exige ${alvo?.name ?? `${pre.kind}:${pre.key}`} nível ${exigido} (atual: ${nivel})`,
        });
      }
    }
    for (const dep of def.dependencias) {
      if (nivelDe(dep.kind, dep.key) < 1) {
        const alvo = regras.elementos.get(CHAVE(dep.kind, dep.key));
        erros.push({
          campoId: info.campoId,
          codigo: "dependencia",
          mensagem: `"${el.name}" depende de ${alvo?.name ?? `${dep.kind}:${dep.key}`}`,
        });
      }
    }
  }

  // 3) Exclusividades: múltiplos grupos por elemento (legado
  // grupoExclusividade + gruposExclusividade) e lista de incompatíveis.
  // Grupo é escopado por kind para não gerar falso conflito entre tipos.
  const porGrupo = new Map<string, { el: ElementoRegra; campoId: string; grupo: string }[]>();
  for (const [chave, info] of nivelPorElemento) {
    const el = regras.elementos.get(chave)!;
    const grupos = [
      el.definition.grupoExclusividade,
      ...(el.definition.gruposExclusividade ?? []),
    ].filter((g): g is string => !!g);
    for (const g of new Set(grupos)) {
      const gk = `${el.kind}:${g}`;
      const lista = porGrupo.get(gk) ?? [];
      lista.push({ el, campoId: info.campoId, grupo: g });
      porGrupo.set(gk, lista);
    }
    for (const outro of el.definition.exclusivos) {
      const [okind, okey] = outro.includes(":") ? outro.split(/:(.*)/s) : [el.kind, outro];
      if (nivelDe(okind, okey) > 0) {
        const alvo = regras.elementos.get(outro.includes(":") ? outro : CHAVE(el.kind, outro));
        erros.push({
          campoId: info.campoId,
          codigo: "exclusividade",
          mensagem: `"${el.name}" é incompatível com "${alvo?.name ?? outro}"`,
        });
      }
    }
  }
  for (const lista of porGrupo.values()) {
    const unicos = new Map(lista.map((x) => [x.el.key, x]));
    if (unicos.size > 1) {
      erros.push({
        codigo: "exclusividade",
        mensagem: `Grupo "${lista[0].grupo}": apenas um pode ser escolhido (${[...unicos.values()].map((x) => x.el.name).join(", ")})`,
      });
    }
  }

  // 4) Obrigações (ex.: poder exige defeito associado — spec §6)
  for (const [chave] of nivelPorElemento) {
    const el = regras.elementos.get(chave)!;
    for (const obrig of el.definition.obrigatorios) {
      const [okind, okey] = obrig.includes(":") ? obrig.split(/:(.*)/s) : [el.kind, obrig];
      if (nivelDe(okind, okey) < 1) {
        const alvo = regras.elementos.get(obrig.includes(":") ? obrig : CHAVE(el.kind, obrig));
        erros.push({
          campoId: undefined,
          codigo: "obrigatorio_pendente",
          mensagem: `"${el.name}" exige a escolha de ${alvo?.name ?? obrig}`,
        });
      }
    }
  }

  // 4b) Poderes × Defeitos (config.poderes): limites de poderes/defeitos e
  // regra "poder exige defeito". Conta elementos distintos por kind.
  const cfgPoderes = regras.config.poderes;
  if (cfgPoderes) {
    const porKindSel = new Map<string, { campoId: string; level: number }[]>();
    for (const [chave, info] of nivelPorElemento) {
      const kind = chave.split(":")[0];
      if (kind !== "poder" && kind !== "defeito") continue;
      const lista = porKindSel.get(kind) ?? [];
      lista.push(info);
      porKindSel.set(kind, lista);
    }
    const poderes = porKindSel.get("poder") ?? [];
    const defeitos = porKindSel.get("defeito") ?? [];
    if (cfgPoderes.exigirDefeito && poderes.length > 0 && defeitos.length === 0) {
      erros.push({
        campoId: poderes[0]?.campoId,
        codigo: "poder_sem_defeito",
        mensagem: "Poderes exigem ao menos 1 defeito como contrapartida — escolha um defeito para liberar o poder",
      });
    }
    if (cfgPoderes.limitePoderes != null && poderes.length > cfgPoderes.limitePoderes) {
      erros.push({
        codigo: "limite_poderes",
        mensagem: `Limite de poderes excedido: máximo de ${cfgPoderes.limitePoderes} (escolhidos: ${poderes.length})`,
      });
    }
    if (cfgPoderes.limiteDefeitos != null && defeitos.length > cfgPoderes.limiteDefeitos) {
      erros.push({
        codigo: "limite_defeitos",
        mensagem: `Limite de defeitos excedido: máximo de ${cfgPoderes.limiteDefeitos} (escolhidos: ${defeitos.length})`,
      });
    }
  }

  // 5) Pontos — estrutura efetiva (custos de elementos) + custos de seleção
  //    + transferências entre reservas quando configuradas (spec §5.3)
  const estruturaEfetiva = estruturaComCustosDeElementos(estrutura, regras);
  const pontos = aplicarTransferencias(
    aplicarCustosSelecao(calcularPontos(estruturaEfetiva, dados), estrutura, dados, regras),
    regras
  );
  if (pontos.habilitado) {
    for (const erro of pontos.erros) erros.push({ codigo: "pontos", mensagem: erro });
  }

  // Dedup por mensagem
  const vistos = new Set<string>();
  const unicos = erros.filter((e) => (vistos.has(e.mensagem) ? false : (vistos.add(e.mensagem), true)));
  return { ok: unicos.length === 0, erros: unicos, escolhas, calculos };
}

// ---------- Config efetiva para resposta de ficha ----------

export function pontosParaFicha(estrutura: EstruturaFicha, regras: RegrasCampanha) {
  return pontosEfetivos(estrutura, regras);
}

// Re-export para uso em rotas
export { calcularPontos };
