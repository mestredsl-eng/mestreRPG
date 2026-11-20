/**
 * Pré-validação de revinculação de ficha (Issue #186 — C7/R1.3).
 *
 * Calcula uma PRÉVIA segura da migração dos dados de uma estrutura
 * publicada antiga para uma estrutura publicada nova — sem persistir
 * nada e sem trocar `characters.templateVersionId` (coluna, fora de
 * `data` — schema.ts).
 *
 * Garantias do contrato:
 *  - toda chave persistida de `characters.data` é classificada:
 *      1. campo de ficha conhecido na estrutura origem e/ou destino;
 *      2. chave sintética derivada de campo (`<campoId>::saldo` de
 *         carteira — ficha.ts);
 *      3. ledger/metadado reservado do sistema (`__*` — whitelist
 *         abaixo, confirmada por uso real no código);
 *      4. chave não classificada → INCOMPATIBILIDADE, nunca descarte.
 *  - campo presente na origem e ausente no destino → incompatibilidade;
 *  - mesmo ID com tipo/valor incompatível na estrutura destino →
 *    incompatibilidade (via validarFicha, sem defaults e sem
 *    obrigatórios);
 *  - nenhuma incompatibilidade é descartada silenciosamente:
 *    a prévia falha e reporta TODAS de uma vez;
 *  - ledgers reservados são preservados verbatim (clone profundo),
 *    sem sanitizar/recalcular/zerar — cada um tem seu próprio
 *    validador na leitura;
 *  - o helper nunca escreve em banco e nunca modifica os objetos
 *    de entrada.
 *
 * Fora de escopo (etapa posterior): endpoint administrativo, releitura
 * transacional, verificação de autorização de mestre e gravação
 * atômica. ID de campo diferente NUNCA é migrado automaticamente —
 * renomeação é incompatibilidade até decisão explícita.
 */

import { mapaCampos, validarFicha, type EstruturaFicha } from "./ficha.js";

// ---------- Chaves reservadas confirmadas em characters.data ----------
// Fontes verificadas no código (SHA base 37232ee):
//   __xp          progressao.ts (CHAVE_XP)         — ledger XP
//   __pontos      pontos.ts   (CHAVE_PONTOS)       — selo, bônus e
//                 histórico de pontos de criação ("pontos selados"
//                 vivem AQUI, dentro de data — não são coluna)
//   __hp          vida.ts     (CHAVE_HP)           — Pontos de Vida
//   __vitalidade  vida.ts     (CHAVE_VITALIDADE)   — Vitalidade
//   __sangue      sangue.ts   (CHAVE_SANGUE)       — ledger de sangue
//   __retrato     personagens.ts / retratos.ts / saneamento-importacao.ts
//                 — retrato do personagem (também dentro de data)
//   __npcVisivel  npc-visibility.ts (CHAVE_NPC_VISIVEL)
//   __arquivamento personagens.ts / restaurar.ts    — metadado de
//                 arquivamento (status anterior)
// NÃO incluído: "__leaseCampanhaHandler" (permissoes.ts) — vive em
// res.locals, nunca em characters.data. Qualquer outro "__*" em data
// é tratado como chave reservada DESCONHECIDA → bloqueia a prévia.
export const CHAVES_RESERVADAS_REVINCULACAO: ReadonlySet<string> = new Set([
  "__xp",
  "__pontos",
  "__hp",
  "__vitalidade",
  "__sangue",
  "__retrato",
  "__npcVisivel",
  "__arquivamento",
]);

/** Sufixo da chave sintética de saldo inicial de carteira
 *  (`<campoId>::saldo` — ficha.ts). */
export const SUFIXO_SALDO_CARTEIRA = "::saldo";

export type MotivoIncompatibilidade =
  | "dados_invalidos"
  | "estrutura_invalida"
  | "chave_reservada_desconhecida"
  | "chave_nao_classificada"
  | "campo_ausente_na_estrutura_destino"
  | "saldo_sem_campo_carteira"
  | "campo_calculado_com_valor"
  | "valor_invalido";

export interface IncompatibilidadeRevinculacao {
  /** Chave persistida em `characters.data` (ou "(data)"/"(estrutura)"). */
  chave: string;
  /** ID do campo relacionado, quando aplicável. */
  campoId?: string;
  motivo: MotivoIncompatibilidade;
  /** Mensagem legível vinda do validador de ficha, quando houver. */
  detalhe?: string;
}

export interface PreviaRevinculacao {
  ok: boolean;
  /** Dados candidatos normalizados — presente SOMENTE quando ok.
   *  Nunca contém defaults aplicados nem campos obrigatórios
   *  inventados: apenas o que existia nos dados de origem. */
  dados?: Record<string, unknown>;
  /** Todas as incompatibilidades encontradas (vazio quando ok). */
  incompatibilidades: IncompatibilidadeRevinculacao[];
}

function estruturaValida(e: EstruturaFicha | null | undefined): e is EstruturaFicha {
  return !!e && typeof e === "object" && Array.isArray(e.secoes);
}

/**
 * Calcula a prévia de revinculação de `dados` da estrutura
 * `estruturaOrigem` para `estruturaDestino`.
 *
 * Não persiste, não troca `templateVersionId`, não muta as entradas.
 */
export function preverRevinculacaoFicha(
  estruturaOrigem: EstruturaFicha,
  estruturaDestino: EstruturaFicha,
  dados: Record<string, unknown>,
): PreviaRevinculacao {
  const falha = (incompatibilidades: IncompatibilidadeRevinculacao[]): PreviaRevinculacao => ({
    ok: false,
    incompatibilidades,
  });

  if (!estruturaValida(estruturaOrigem) || !estruturaValida(estruturaDestino)) {
    return falha([{ chave: "(estrutura)", motivo: "estrutura_invalida" }]);
  }
  if (!dados || typeof dados !== "object" || Array.isArray(dados)) {
    return falha([{ chave: "(data)", motivo: "dados_invalidos" }]);
  }

  const mapaOrig = mapaCampos(estruturaOrigem);
  const mapaDest = mapaCampos(estruturaDestino);
  const incompatibilidades: IncompatibilidadeRevinculacao[] = [];

  // Chaves reservadas: preservadas verbatim em `reservados`.
  const reservados: Record<string, unknown> = {};
  // Chaves de campo/saldo candidatas a migrar — validadas em lote
  // por validarFicha contra a estrutura DESTINO.
  const entradaCampos: Record<string, unknown> = {};

  for (const [chave, valor] of Object.entries(dados)) {
    // 3) Ledger/metadado reservado do sistema — preservação integral,
    //    sem inspecionar conteúdo (cada ledger tem validador próprio).
    if (chave.startsWith("__")) {
      if (CHAVES_RESERVADAS_REVINCULACAO.has(chave)) {
        reservados[chave] = structuredClone(valor);
      } else {
        incompatibilidades.push({ chave, motivo: "chave_reservada_desconhecida" });
      }
      continue;
    }

    // 2) Chave sintética de carteira `<campoId>::saldo`: só é válida
    //    se o campo base é carteira TANTO na origem quanto no destino.
    if (chave.endsWith(SUFIXO_SALDO_CARTEIRA)) {
      const base = chave.slice(0, -SUFIXO_SALDO_CARTEIRA.length);
      const cOrig = mapaOrig.get(base);
      const cDest = mapaDest.get(base);
      if (!cOrig || !cOrig.carteira) {
        incompatibilidades.push({ chave, campoId: base, motivo: "saldo_sem_campo_carteira" });
        continue;
      }
      if (!cDest || !cDest.carteira) {
        incompatibilidades.push({
          chave,
          campoId: base,
          motivo: "campo_ausente_na_estrutura_destino",
          detalhe: cDest ? "campo existe no destino mas não é carteira" : undefined,
        });
        continue;
      }
      entradaCampos[chave] = valor;
      continue;
    }

    // 1) Campo de ficha: conhecido na origem, no destino, ou ambos.
    const cOrig = mapaOrig.get(chave);
    const cDest = mapaDest.get(chave);
    if (!cOrig && !cDest) {
      // 4) Não classificada — bloqueia, nunca descarta.
      incompatibilidades.push({ chave, motivo: "chave_nao_classificada" });
      continue;
    }
    if (cOrig && !cDest) {
      incompatibilidades.push({ chave, campoId: chave, motivo: "campo_ausente_na_estrutura_destino" });
      continue;
    }
    // Destino conhece o campo. Campo calculado nunca recebe valor
    // persistido — valor não-vazio aqui é incompatibilidade; valor
    // vazio equivale a ausente e não migra nada.
    if (cDest!.tipo === "calculado") {
      if (valor !== undefined && valor !== null && valor !== "") {
        incompatibilidades.push({ chave, campoId: chave, motivo: "campo_calculado_com_valor" });
      }
      continue;
    }
    entradaCampos[chave] = valor;
  }

  // Validação dos campos candidatos contra a estrutura DESTINO.
  // - aplicarPadroes:false → não inventa defaults;
  // - estrito:false → não exige obrigatórios;
  // - carteirasSaldo → o saldo inicial é pré-validado como o mestre
  //   faria (a autorização real fica para a rota futura);
  // - apenasCamposPermitidos → somente as chaves classificadas acima
  //   entram na validação; qualquer outra é ignorada por construção.
  const carteirasSaldo = new Set(
    [...mapaDest.values()].filter((c) => c.carteira).map((c) => c.id),
  );
  const res = validarFicha(estruturaDestino, entradaCampos, {
    aplicarPadroes: false,
    estrito: false,
    apenasCamposPermitidos: new Set(Object.keys(entradaCampos)),
    carteirasSaldo,
  });
  for (const [campoId, detalhe] of Object.entries(res.erros)) {
    incompatibilidades.push({ chave: campoId, campoId, motivo: "valor_invalido", detalhe });
  }

  if (incompatibilidades.length > 0) {
    return { ok: false, incompatibilidades };
  }

  // Clone final: validarFicha pode reter referências de objetos
  // aninhados da entrada — a prévia devolve cópia independente.
  const dadosPrevia: Record<string, unknown> = structuredClone({
    ...reservados,
    ...res.dados,
  });
  return { ok: true, dados: dadosPrevia, incompatibilidades: [] };
}
