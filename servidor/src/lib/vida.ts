import { todosCampos, type EstruturaFicha } from "./ficha.js";
import type { ConfigRegras } from "./regras.js";

/**
 * Pontos de Vida e Vitalidade — estado por personagem guardado em
 * `characters.data` sob chaves reservadas "__hp" e "__vitalidade"
 * (nunca editáveis via PATCH da ficha: validarFicha descarta chaves
 * desconhecidas). Toda alteração passa por endpoints dedicados.
 */

export const CHAVE_HP = "__hp";
export const CHAVE_VITALIDADE = "__vitalidade";

export interface EventoHp {
  em: string;                    // ISO
  tipo: "inicial" | "dano" | "recuperacao" | "ajuste";
  quantidade: number;            // delta aplicado (negativo = dano)
  motivo: string | null;
  autorId: string | null;
  autorNome: string | null;
}

export interface EstadoHp {
  atual: number;
  historico: EventoHp[];
}

export interface NivelVitalidade {
  nome: string;
  penalidadeDados: number;
  bloqueiaAcoes: boolean;
}

export interface EventoVitalidade {
  em: string;                    // ISO
  nivelAnterior: number;
  nivelNovo: number;
  motivo: string | null;
  autorId: string | null;
  autorNome: string | null;
  // Origem da alteração: "manual" (endpoint /vitalidade) ou
  // "conversao-ferimento" (subida automática por dano de HP).
  // Ausente em eventos antigos = tratado como manual.
  origem?: "manual" | "conversao-ferimento";
}

export interface EstadoVitalidade {
  nivel: number; // índice em config.vitalidade.niveis
  alteradoEm?: string;
  alteradoPor?: string | null;
  historico?: EventoVitalidade[];
}

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** Resolve o campo de atributo do HP: campoId explícito ou 1º numérico com o semântico. */
export function campoHp(estrutura: EstruturaFicha, cfg: ConfigRegras["hp"]) {
  const campos = todosCampos(estrutura).filter((c) => c.tipo === "inteiro" || c.tipo === "decimal" || c.tipo === "moeda");
  if (cfg.campoId) {
    const c = campos.find((x) => x.id === cfg.campoId);
    if (c) return c;
  }
  if (cfg.semantico) return campos.find((c) => c.semantico === cfg.semantico) ?? null;
  return null;
}

/** HP máximo = base + valor do atributo × porNivel. null se desabilitado. */
export function hpMaximo(cfg: ConfigRegras["hp"], estrutura: EstruturaFicha, dados: Record<string, unknown>): number | null {
  if (!cfg?.habilitado) return null;
  const campo = campoHp(estrutura, cfg);
  const nivel = campo ? Math.max(0, num(dados[campo.id]) ?? 0) : 0;
  return cfg.base + nivel * cfg.porNivel;
}

/** Lê o estado de HP dos dados do personagem (sem persistir). */
export function lerHp(dados: Record<string, unknown>): EstadoHp | null {
  const bruto = dados[CHAVE_HP] as EstadoHp | undefined;
  if (!bruto || typeof bruto !== "object") return null;
  const atual = num(bruto.atual);
  if (atual === null) return null;
  return { atual, historico: Array.isArray(bruto.historico) ? bruto.historico : [] };
}

/** Monta o objeto de HP para a ficha: máximo calculado, atual limitado ao
 *  máximo e histórico (inclui "HP inicial" virtual quando ainda não há
 *  registro persistido). */
export function resumoHp(
  cfg: ConfigRegras["hp"],
  estrutura: EstruturaFicha,
  dados: Record<string, unknown>,
  autorInicial: string | null = null
) {
  const maximo = hpMaximo(cfg, estrutura, dados);
  if (maximo === null) return null;
  const estado = lerHp(dados);
  const atual = Math.min(estado?.atual ?? maximo, maximo);
  const historico: EventoHp[] = estado?.historico.length
    ? estado.historico
    : [{ em: new Date(0).toISOString(), tipo: "inicial", quantidade: maximo, motivo: "HP inicial", autorId: autorInicial, autorNome: null }];
  return { maximo, atual, historico: historico.slice(-100) };
}

/** Aplica uma variação de HP com regras: piso 0, teto = máximo. Retorna o
 *  novo estado pronto para gravar (histórico já com o evento). */
export function aplicarHp(
  estado: EstadoHp | null,
  maximo: number,
  delta: number,
  evento: Omit<EventoHp, "quantidade"> & { quantidade?: number }
): { estado: EstadoHp; erro?: string } {
  const atual = estado?.atual ?? maximo;
  const novo = Math.min(maximo, Math.max(0, atual + delta));
  if (novo === atual && delta !== 0) {
    // delta bloqueado pelo limite — ainda assim registra? Não: rejeita.
    return { estado: { atual, historico: estado?.historico ?? [] }, erro: delta < 0 ? "HP já está em zero" : "HP já está no máximo" };
  }
  const aplicado = novo - atual;
  const historico = [...(estado?.historico ?? []), { ...evento, quantidade: aplicado }];
  return { estado: { atual: novo, historico: historico.slice(-100) }, erro: undefined };
}

/** Lê o nível de vitalidade (índice na escala configurada). */
export function lerVitalidade(dados: Record<string, unknown>): EstadoVitalidade {
  const bruto = dados[CHAVE_VITALIDADE] as EstadoVitalidade | undefined;
  const nivel = bruto && typeof bruto === "object" ? num(bruto.nivel) : null;
  const historico = bruto && typeof bruto === "object" && Array.isArray(bruto.historico) ? bruto.historico : undefined;
  return {
    nivel: nivel !== null && nivel >= 0 ? Math.floor(nivel) : 0,
    alteradoEm: bruto?.alteradoEm,
    alteradoPor: bruto?.alteradoPor ?? null,
    historico,
  };
}

/** Nível de vitalidade exigido pelos limiares de HP restante.
 *  Retorna o maior `nivel` entre as faixas em que `pctHp <= ate`;
 *  null quando a conversão está desabilitada ou sem limiares. */
export function nivelExigidoPorHp(
  conv: ConfigRegras["conversaoFerimento"],
  pctHp: number
): number | null {
  if (!conv?.habilitada || !conv.limiares?.length) return null;
  let exigido: number | null = null;
  for (const l of conv.limiares) {
    if (pctHp <= l.ate && (exigido === null || l.nivel > exigido)) exigido = l.nivel;
  }
  return exigido;
}

/** Resumo para a ficha e para as rolagens. */
export function resumoVitalidade(cfg: ConfigRegras["vitalidade"], dados: Record<string, unknown>) {
  if (!cfg?.niveis?.length) return null;
  const estado = lerVitalidade(dados);
  const nivel = Math.min(estado.nivel, cfg.niveis.length - 1);
  const def = cfg.niveis[nivel];
  return {
    nivel,
    nome: def.nome,
    penalidadeDados: def.penalidadeDados,
    bloqueiaAcoes: def.bloqueiaAcoes,
    niveis: cfg.niveis.map((n, i) => ({ indice: i, nome: n.nome, penalidadeDados: n.penalidadeDados, bloqueiaAcoes: n.bloqueiaAcoes })),
    alteradoEm: estado.alteradoEm ?? null,
    alteradoPor: estado.alteradoPor ?? null,
    historico: (estado.historico ?? []).slice(-100),
  };
}
