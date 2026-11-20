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
  // Snapshot dos limiares de conversão usados NESTE evento — a leitura
  // pública de NPC avalia privacidade pela regra que produziu o evento,
  // não pela configuração atual (que o mestre pode mudar depois).
  limiares?: { ate: number; nivel: number }[];
}

export interface EstadoVitalidade {
  nivel: number; // índice em config.vitalidade.niveis
  alteradoEm?: string;
  alteradoPor?: string | null;
  historico?: EventoVitalidade[];
  // Último nível definido MANUALMENTE pelo mestre — piso narrativo
  // persistido fora do histórico (que sofre slice(-100)): conversões
  // automáticas nunca o sobrescrevem.
  nivelManual?: number;
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
  const nivelManual = bruto && typeof bruto === "object" ? num(bruto.nivelManual) : null;
  const historico = bruto && typeof bruto === "object" && Array.isArray(bruto.historico) ? bruto.historico : undefined;
  return {
    nivel: nivel !== null && nivel >= 0 ? Math.floor(nivel) : 0,
    // nivelManual precisa voltar na leitura: a conversão automática
    // regrava o estado com {...vitAnt} — sem este campo, o piso
    // narrativo seria apagado a cada ferimento automático.
    ...(nivelManual !== null && nivelManual >= 0 ? { nivelManual: Math.floor(nivelManual) } : {}),
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

// ---------- vida por leitor (ficha e tokens da mesa virtual) ----------

export interface VidaFicha {
  hp: ReturnType<typeof resumoHp>;
  vitalidade: ReturnType<typeof resumoVitalidade>;
  podeEditarHp: boolean;
  podeEditarVitalidade: boolean;
}

/**
 * Vida (HP + Vitalidade) calculada para UM leitor — fonte única usada
 * pela ficha (personagens.ts) e pelos tokens da Mesa Virtual.
 *
 * - ehMestre/ehDono → resumo sobre a estrutura e os dados completos.
 * - visaoFiltrada (ou NPC lido por não-mestre/não-dono) → HP calculado
 *   sobre a MESMA visão filtrada dos campos: atributo privado não vaza
 *   pelo máximo, pelo atual nem pelo histórico; a Vitalidade passa pelo
 *   piso narrativo e pelo snapshot de limiares do evento de conversão.
 * Sem `regras` → null (recurso desligado na campanha).
 */
export function vidaParaFicha(opts: {
  isNpc: boolean;
  ehMestre: boolean;
  ehDono: boolean;
  /** Força o caminho filtrado mesmo para não-NPC (ex.: token de outro
   *  jogador na mesa quando a campanha compartilha vida). */
  visaoFiltrada?: boolean;
  dados: Record<string, unknown>;
  /** Valores dos campos já filtrados para o leitor (usado no caminho filtrado). */
  campos?: Record<string, unknown>;
  estrutura: EstruturaFicha;
  estruturaFiltrada?: EstruturaFicha;
  regras?: { config: ConfigRegras };
}): VidaFicha | null {
  const { isNpc, ehMestre, ehDono, dados, estrutura, regras } = opts;
  if (!regras) return null;
  const filtrada = opts.visaoFiltrada ?? (isNpc && !ehMestre && !ehDono);
  if (!filtrada) {
    return {
      hp: resumoHp(regras.config.hp, estrutura, dados),
      vitalidade: resumoVitalidade(regras.config.vitalidade, dados),
      podeEditarHp: ehMestre || (!ehMestre && ehDono && regras.config.hp.edicaoPor !== "mestre"),
      podeEditarVitalidade: ehMestre || (!ehMestre && ehDono && regras.config.vitalidade.edicaoPor !== "mestre"),
    };
  }
  const estruturaFiltrada = opts.estruturaFiltrada ?? { ...estrutura, secoes: [] };
  const campos = (opts.campos ?? {}) as Record<string, unknown>;
  const dadosVida = {
    ...campos,
    [CHAVE_HP]: dados[CHAVE_HP],
    [CHAVE_VITALIDADE]: dados[CHAVE_VITALIDADE],
  };
  const hp = resumoHp(regras.config.hp, estruturaFiltrada, dadosVida);
  if (hp) hp.historico = [];
  const vit = resumoVitalidade(regras.config.vitalidade, dadosVida);
  if (vit) {
    vit.historico = [];
    // Conversão automática: % sobre o HP MÁXIMO REAL (oculto do leitor)
    // denunciaria atributo privado — avalia pelo SNAPSHOT de limiares do
    // evento que produziu o nível, com piso manual como piso narrativo.
    const cfgVit = regras.config.vitalidade;
    const estadoVit = lerVitalidade(dados);
    const histVit = estadoVit.historico ?? [];
    let pisoManual = typeof estadoVit.nivelManual === "number" ? estadoVit.nivelManual : 0;
    if (typeof estadoVit.nivelManual !== "number") {
      for (const ev of histVit) {
        if (ev.origem !== "conversao-ferimento" && typeof ev.nivelNovo === "number") {
          pisoManual = ev.nivelNovo;
        }
      }
    }
    const ultimoVit = histVit.length ? histVit[histVit.length - 1] : null;
    const veioDeConversao = ultimoVit?.origem === "conversao-ferimento" && ultimoVit.nivelNovo === estadoVit.nivel;
    if (veioDeConversao && cfgVit?.niveis?.length) {
      const pctPublico = hp && hp.maximo > 0 ? (hp.atual / hp.maximo) * 100 : 100;
      const limiaresEv = Array.isArray(ultimoVit?.limiares) ? ultimoVit.limiares : null;
      const tetoPublico = limiaresEv
        ? Math.min(
            nivelExigidoPorHp({ habilitada: true, limiares: limiaresEv }, pctPublico) ?? 0,
            cfgVit.niveis.length - 1
          )
        : 0;
      const pisoNaEscala = Math.min(pisoManual, cfgVit.niveis.length - 1);
      const nivelExibido = Math.max(pisoNaEscala, Math.min(vit.nivel, tetoPublico));
      if (nivelExibido !== vit.nivel) {
        const niv = cfgVit.niveis[nivelExibido];
        vit.nivel = nivelExibido;
        vit.nome = niv.nome;
        vit.penalidadeDados = niv.penalidadeDados;
        vit.bloqueiaAcoes = niv.bloqueiaAcoes;
      }
    }
  }
  return {
    hp,
    vitalidade: vit,
    podeEditarHp: false,
    podeEditarVitalidade: false,
  };
}
