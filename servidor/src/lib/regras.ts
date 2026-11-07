import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { ruleSets, ruleDefinitions, campaigns } from "../db/schema.js";
import {
  calcularPontos,
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
});
export type ConfigRegras = z.infer<typeof configRegrasSchema>;

export const definicaoElementoSchema = z.object({
  descricao: z.string().max(4000).optional(),
  subcategoria: z.string().max(120).optional(),
  custoPontos: z.number().optional(),          // custo fixo por ponto
  custoProgressivo: z.array(z.number()).max(100).optional(), // ex.: talentos [1,2,3,4,5]
  minimo: z.number().optional(),
  maximo: z.number().optional(),
  prerequisitos: z.array(z.object({
    kind: z.string().max(40),
    key: z.string().max(80),
    minLevel: z.number().optional(),
  })).max(50).default([]),
  dependencias: z.array(z.object({ kind: z.string().max(40), key: z.string().max(80) })).max(50).default([]),
  grupoExclusividade: z.string().max(80).optional(), // elementos do mesmo grupo são exclusivos
  exclusivos: z.array(z.string().max(80)).max(50).default([]), // keys de elementos incompatíveis
  obrigatorios: z.array(z.string().max(80)).max(50).default([]), // defeitos/itens exigidos
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

const TIPOS_SELECAO = new Set(["selecao_unica", "selecao_multipla", "lista", "tabela", "checkbox"]);

/**
 * Custos de elementos escolhidos via campos de seleção/lista
 * (vantagens, defeitos, poderes...) — calcularPontos só vê campos
 * numéricos. Retorna Map poolId → custo total. Deduplica por elemento.
 */
export function custosSelecao(estrutura: EstruturaFicha, dados: Record<string, unknown>, regras: RegrasCampanha): Map<string, number> {
  const custoPorPool = new Map<string, number>();
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
    if (def.custoPontos !== undefined) custo = def.custoPontos * info.level;
    else if (def.custoProgressivo?.length) {
      for (let i = 0; i < Math.min(info.level, def.custoProgressivo.length); i++) custo += def.custoProgressivo[i];
    }
    if (custo === 0) continue;
    const poolId = def.reservaPontos ?? "principal";
    custoPorPool.set(poolId, (custoPorPool.get(poolId) ?? 0) + custo);
  }
  return custoPorPool;
}

/** Aplica custosSelecao sobre um ResultadoPontos já calculado. */
export function aplicarCustosSelecao(
  pontos: ReturnType<typeof calcularPontos>,
  estrutura: EstruturaFicha,
  dados: Record<string, unknown>,
  regras: RegrasCampanha
): ReturnType<typeof calcularPontos> {
  if (!pontos.habilitado) return pontos;
  for (const [poolId, custo] of custosSelecao(estrutura, dados, regras)) {
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
 * Valida a ficha contra as regras da campanha:
 * pontos, pré-requisitos, dependências, exclusividades e obrigações.
 * Retorna erros claros; não decide aprovação (isso é do mestre — spec §9).
 */
export function validarRegras(
  estrutura: EstruturaFicha,
  dados: Record<string, unknown>,
  regras: RegrasCampanha
): { ok: boolean; erros: ErroRegra[]; escolhas: Escolha[] } {
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

  // 1) Elementos indisponíveis ou fora dos limites
  for (const e of escolhas) {
    if (!e.selecionado || !e.elemento) {
      if (e.campo.regraKind && e.selecionado && !e.elemento) {
        erros.push({ campoId: e.campoId, codigo: "elemento_inexistente", mensagem: `Elemento desconhecido selecionado em "${e.campo.label}"` });
      }
      continue;
    }
    const def = e.elemento.definition;
    if (!def.disponivel) {
      erros.push({ campoId: e.campoId, codigo: "indisponivel", mensagem: `"${e.elemento.name}" está desativado nesta campanha` });
    }
    if (def.minimo !== undefined && e.level < def.minimo && e.level > 0) {
      erros.push({ campoId: e.campoId, codigo: "abaixo_minimo", mensagem: `"${e.elemento.name}" exige nível mínimo ${def.minimo}` });
    }
    if (def.maximo !== undefined && e.level > def.maximo) {
      erros.push({ campoId: e.campoId, codigo: "acima_maximo", mensagem: `"${e.elemento.name}" permite no máximo nível ${def.maximo}` });
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

  // 3) Exclusividades: grupo exclusivo e lista de incompatíveis
  const porGrupo = new Map<string, { el: ElementoRegra; campoId: string }[]>();
  for (const [chave, info] of nivelPorElemento) {
    const el = regras.elementos.get(chave)!;
    if (el.definition.grupoExclusividade) {
      const g = el.definition.grupoExclusividade;
      const lista = porGrupo.get(g) ?? [];
      lista.push({ el, campoId: info.campoId });
      porGrupo.set(g, lista);
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
  for (const [grupo, lista] of porGrupo) {
    const unicos = new Map(lista.map((x) => [x.el.key, x]));
    if (unicos.size > 1) {
      erros.push({
        codigo: "exclusividade",
        mensagem: `Grupo "${grupo}": apenas um pode ser escolhido (${[...unicos.values()].map((x) => x.el.name).join(", ")})`,
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

  // 5) Pontos — estrutura efetiva (custos de elementos) + custos de seleção
  const estruturaEfetiva = estruturaComCustosDeElementos(estrutura, regras);
  const pontos = aplicarCustosSelecao(calcularPontos(estruturaEfetiva, dados), estrutura, dados, regras);
  if (pontos.habilitado) {
    for (const erro of pontos.erros) erros.push({ codigo: "pontos", mensagem: erro });
  }

  // Dedup por mensagem
  const vistos = new Set<string>();
  const unicos = erros.filter((e) => (vistos.has(e.mensagem) ? false : (vistos.add(e.mensagem), true)));
  return { ok: unicos.length === 0, erros: unicos, escolhas };
}

// ---------- Config efetiva para resposta de ficha ----------

export function pontosParaFicha(estrutura: EstruturaFicha, regras: RegrasCampanha) {
  return pontosEfetivos(estrutura, regras);
}

// Re-export para uso em rotas
export { calcularPontos };
