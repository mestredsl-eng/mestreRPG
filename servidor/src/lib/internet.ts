// Gate de elegibilidade da Internet diegética (Issue #286, release 1.1.0).
// Fórmula fixa do proprietário: (pontos em perícia/conhecimento do grupo A
// OU grupo B >= 1) E (item físico dispositivo no patrimônio/inventário).
// Server-side, fail-closed: elemento inexistente conta como nível 0 e item
// não reconhecido não habilita. Nunca decide por substring de nome — só por
// `key` de elemento do ruleset e por `data.regra.key`/`data.templateId`
// canônicos gravados pelo servidor no inventário.
import type { EstruturaFicha } from "./ficha.js";
import type { RegrasCampanha } from "./regras.js";
import { nivelAtualElemento } from "./progressao.js";

/** Kinds de elemento que podem carregar "pontos" de perícia/conhecimento. */
const KINDS_PONTOS = ["pericia", "conhecimento", "habilidade", "talento"] as const;

export interface ItemPatrimonioParaGate {
  data?: unknown;
}

export interface ResultadoElegibilidade {
  elegivel: boolean;
  /** explicação estável para UI/auditoria: o que faltou */
  motivos: string[];
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/** Maior nível do elemento kind:key em qualquer campo da ficha (0 se ausente). */
function nivelMaximo(estrutura: EstruturaFicha, dados: Record<string, unknown>, regras: RegrasCampanha, key: string): number {
  let max = 0;
  for (const kind of KINDS_PONTOS) {
    max = Math.max(max, nivelAtualElemento(estrutura, dados, regras, kind, key));
  }
  return max;
}

/** Item conta como dispositivo se o `data` gravado pelo servidor referencia
 *  uma chave canônica do Acervo/ruleset ou um templateId configurado. */
function ehDispositivo(item: ItemPatrimonioParaGate, cfg: RegrasCampanha["config"]["internet"]): boolean {
  const d = (item.data ?? {}) as Record<string, unknown>;
  const regra = d.regra as { kind?: string; key?: string } | undefined;
  if (regra?.kind === "item" && typeof regra.key === "string") {
    const keys = new Set(cfg.dispositivoChaves.map(norm));
    if (keys.has(norm(regra.key))) return true;
  }
  const templateId = d.templateId;
  if (typeof templateId === "string" && cfg.dispositivoTemplateIds.includes(templateId)) return true;
  return false;
}

/**
 * Avalia a elegibilidade de Internet do personagem.
 * `itensPatrimonio` = linhas de inventory_entries + equipment_entries do
 * personagem (o equipado também é posse — sai do estoque mas continua do char).
 */
export function avaliarElegibilidadeInternet(
  estrutura: EstruturaFicha,
  dados: Record<string, unknown>,
  regras: RegrasCampanha,
  itensPatrimonio: ItemPatrimonioParaGate[],
): ResultadoElegibilidade {
  const cfg = regras.config.internet;
  const motivos: string[] = [];

  const nivelA = Math.max(0, ...cfg.grupoPericiasA.map((k) => nivelMaximo(estrutura, dados, regras, k)));
  const nivelB = Math.max(0, ...cfg.grupoPericiasB.map((k) => nivelMaximo(estrutura, dados, regras, k)));
  const temPericia = nivelA >= 1 || nivelB >= 1;
  if (!temPericia) motivos.push("pericia_ou_conhecimento_insuficiente");

  const temDispositivo = itensPatrimonio.some((i) => ehDispositivo(i, cfg));
  if (!temDispositivo) motivos.push("dispositivo_ausente");

  return { elegivel: temPericia && temDispositivo, motivos };
}
