import { Router } from "express";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { sheetVersions } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { carregarPersonagemComAcesso } from "./personagens.js";
import { carregarRegras } from "../lib/regras.js";
import { campoVisivelPara, estruturaFichaSchema, mapaCampos, type EstruturaFicha } from "../lib/ficha.js";
import { lerSangue, resolverSanguePersonagem } from "../lib/sangue.js";
import type { ConfigSangueAcoes } from "../lib/sangue-acoes.js";
import { limiteUsuario } from "../lib/ratelimit.js";

const db = getDb();
export const sangueRouter = Router({ mergeParams: true });
sangueRouter.use(requireAuth);
// Montado em /api/characters (mesmo prefixo de progressaoRouter).

/** Mesma leitura de estrutura de personagens.ts/progressao.ts —
 *  sempre a versão REAL vinculada ao personagem
 *  (`templateVersionId`), nunca a versão mais recente do template. */
async function carregarEstruturaFicha(versionId: string): Promise<EstruturaFicha | null> {
  const [v] = await db.select().from(sheetVersions).where(eq(sheetVersions.id, versionId)).limit(1);
  if (!v) return null;
  const parse = estruturaFichaSchema.safeParse(v.structure);
  return parse.success ? parse.data : null;
}

/** GET /api/characters/:characterId/sangue — projeção de leitura do
 *  estado de Sangue (R7.1, Issue #186). Somente leitura: nunca grava,
 *  nunca reconcilia capacidade, nunca emite socket.
 *
 *  Autorização: `carregarPersonagemComAcesso` canônico — dono do
 *  personagem ou mestre ativo da campanha. Não-dono e espectador
 *  recebem 403 sem nenhum dado do ledger. Personagem arquivado segue
 *  legível (somente leitura, como o restante da ficha).
 *
 *  Fontes de autoridade:
 *  - capacidade: `resolverSanguePersonagem`/`resolverCapacidadeSangue`
 *    sobre a estrutura da versão vinculada + config do ruleset ativo.
 *    `__sangue.capacidade` é cache e NUNCA é lido aqui.
 *  - saldo: `lerSangue` — ledger ausente → saldo inicial neutro (0);
 *    ledger malformado → fail-closed (`ledger_invalido`), sem inventar.
 *
 *  Resposta mínima e estável — nunca expõe `usos`, `historico`,
 *  `data` bruto, UUIDs internos ou campos privados. */
sangueRouter.get(
  "/:characterId/sangue",
  limiteUsuario({ nome: "sangue-leitura", janelaMs: 60_000, max: 60 }),
  async (req, res) => {
    const acesso = await carregarPersonagemComAcesso(req);
    if ("erro" in acesso) {
      res.status(acesso.erro ?? 500).json({ erro: acesso.erro === 404 ? "Personagem não encontrado" : "Sem permissão" });
      return;
    }
    const p = acesso.personagem;
    const dados = (p.data ?? {}) as Record<string, unknown>;
    const estrutura = p.templateVersionId ? await carregarEstruturaFicha(p.templateVersionId) : null;
    const regras = await carregarRegras(p.campaignId);
    const config = (regras.config.sangue ?? null) as ConfigSangueAcoes | null;

    const habilitado = config?.habilitado === true;
    if (!habilitado || !estrutura) {
      res.json({
        estado: !habilitado ? "desabilitado" : "indisponivel",
        motivo: !habilitado ? "desabilitado" : "sem_versao_ficha",
        habilitado,
        utilizavel: false,
        saldo: null,
        capacidadeMax: null,
        natureza: null,
        acaoRecuperacao: null,
      });
      return;
    }

    // A projeção de Sangue não pode transformar campos privados da ficha
    // em valores derivados visíveis ao dono. Aplicamos a mesma política
    // efetiva (template + overrides da ficha) usada pela rota da ficha.
    const campos = mapaCampos(estrutura);
    const overrides = (p.overrides ?? {}) as Record<string, {
      visibilidade?: "todos" | "dono_mestre" | "mestre" | "selecionados";
      destinatarios?: string[];
    }>;
    const campoVisivel = (campoId: string | undefined): boolean => {
      if (!campoId) return false;
      const campo = campos.get(campoId);
      if (!campo) return false;
      return campoVisivelPara(
        campo,
        overrides[campoId],
        acesso.ehMestre,
        acesso.ehDono,
        req.usuario!.id,
        acesso.membership.id,
      );
    };
    const fontesCapacidade = [
      config.campoCapacidadeId,
      config.capacidade?.bonusQualidade?.campoId,
    ].filter((id): id is string => typeof id === "string" && id.length > 0);
    const capacidadePrivada =
      !acesso.ehMestre &&
      fontesCapacidade.some((campoId) => campos.has(campoId) && !campoVisivel(campoId));
    if (capacidadePrivada) {
      res.json({
        estado: "capacidade_indisponivel",
        motivo: "campo_privado",
        habilitado: true,
        utilizavel: false,
        saldo: null,
        capacidadeMax: null,
        natureza: null,
        acaoRecuperacao: null,
      });
      return;
    }
    const naturezaPrivada =
      !acesso.ehMestre &&
      typeof config.campoNaturezaId === "string" &&
      campos.has(config.campoNaturezaId) &&
      !campoVisivel(config.campoNaturezaId);

    const resolucao = resolverSanguePersonagem(estrutura, dados, config);
    const lido = lerSangue(dados);
    const capacidadeMax = resolucao.capacidade.disponivel ? resolucao.capacidade.capacidade : null;

    const ledgerValido = lido.valido;
    const saldo = ledgerValido ? lido.estado.saldo : null;
    const capacidadeOk = resolucao.capacidade.disponivel;
    const estado = !capacidadeOk
      ? "capacidade_indisponivel"
      : !ledgerValido
        ? "ledger_invalido"
        : "ok";

    // Contrato publicado (#227): qualquer estado != "ok" devolve
    // TODOS os campos de resumo como null — o consumidor nunca
    // anuncia saldo/capacidade/ação a partir de estado parcial.
    if (estado !== "ok") {
      res.json({
        estado,
        motivo: !capacidadeOk ? (resolucao.capacidade.motivo ?? "indisponivel") : "ledger_invalido",
        habilitado: true,
        utilizavel: false,
        saldo: null,
        capacidadeMax: null,
        natureza: null,
        acaoRecuperacao: null,
      });
      return;
    }

    // Ação de recuperação efetiva — MESMA cadeia de `recuperarSangue`
    // (sangue-acoes.ts): natureza mapeada → ação canônica → flag global
    // → ação habilitada → quantidade válida. Qualquer elo ausente →
    // null (fail-closed, nunca sugere ação indisponível).
    let acaoRecuperacao: { acao: "descansar" | "alimentar"; quantidade: number } | null = null;
    const acao = resolucao.natureza.natureza?.recuperacao;
    if (acao === "descansar" || acao === "alimentar") {
      const rec = config.recuperacaoSangue;
      const cfgAcao = rec?.habilitado === true ? rec.acoes?.[acao] : undefined;
      const q = cfgAcao?.habilitada === true ? cfgAcao.quantidade : undefined;
      if (typeof q === "number" && Number.isFinite(q) && q > 0) {
        acaoRecuperacao = { acao, quantidade: q };
      }
    }

    res.json({
      estado,
      habilitado: true,
      utilizavel: true,
      saldo,
      capacidadeMax: resolucao.capacidade.capacidade,
      natureza: !naturezaPrivada && resolucao.natureza.disponivel
        ? {
            rotulo: resolucao.natureza.rotulo,
            conhecida: resolucao.natureza.natureza !== null,
            metaHumanoComPoder: resolucao.natureza.metaHumanoComPoder,
          }
        : null,
      acaoRecuperacao: naturezaPrivada ? null : acaoRecuperacao,
    });
  },
);
