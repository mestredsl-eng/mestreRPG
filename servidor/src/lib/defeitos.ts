import { extrairEscolhas, type RegrasCampanha } from "./regras.js";
import type { EstruturaFicha } from "./ficha.js";

/**
 * Painel de defeitos da Mesa (somente mestre): agrega, por personagem,
 * os defeitos efetivamente registrados na ficha — nome, nível atual e a
 * descrição correspondente àquele nível, resolvidos pela biblioteca da
 * campanha (ruleset ativo). SOMENTE consulta: nada aqui altera ficha,
 * pontos ou regras.
 *
 * A interpretação dos campos é a mesma do motor de regras:
 * `extrairEscolhas` resolve `campo.regra` (elemento específico) e
 * `campo.regraKind` (seleção por tipo, incl. `selecao_nivel` com
 * {key, nivel}). Nada é lido por ID fixo de campo.
 */

export interface DefeitoPainel {
  kind: string;
  key: string;
  nome: string;
  nivel: number;
  /** descrição do nível atual; cai para a descrição geral do elemento */
  descricao: string | null;
}

/**
 * Defeitos de UMA ficha. Regras de agregação (espelham a validação):
 * - somente elementos kind "defeito" resolvidos na biblioteca da campanha
 *   (chave inexistente ou outro tipo — poder/vantagem — nunca aparece);
 * - exige seleção efetiva (nível > 0);
 * - nível acima do máximo graduado do elemento é inválido → ignorado;
 * - o mesmo defeito em mais de um campo fica com o MAIOR nível.
 */
export function defeitosDaFicha(
  estrutura: EstruturaFicha,
  dados: Record<string, unknown>,
  regras: RegrasCampanha,
): DefeitoPainel[] {
  const porKey = new Map<string, DefeitoPainel>();
  for (const e of extrairEscolhas(estrutura, dados, regras)) {
    const el = e.elemento;
    if (!el || el.kind !== "defeito" || !e.selecionado || e.level <= 0) continue;
    const niveis = el.definition.niveis ?? [];
    if (niveis.length > 0 && e.level > niveis.length) continue;
    const atual = porKey.get(el.key);
    if (atual && atual.nivel >= e.level) continue;
    porKey.set(el.key, {
      kind: el.kind,
      key: el.key,
      nome: el.name,
      nivel: e.level,
      descricao: niveis[e.level - 1]?.descricao ?? el.definition.descricao ?? null,
    });
  }
  return [...porKey.values()].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
}
