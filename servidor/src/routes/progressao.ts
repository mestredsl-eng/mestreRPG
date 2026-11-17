import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../db/index.js";
import { characters, memberships, sheetVersions, users } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requireLeasePersonagem } from "../lib/permissoes.js";
import { carregarPersonagemComAcesso } from "./personagens.js";
import {
  carregarRegras,
  carregarRegrasSincrono,
  impressaoDigitalRegras,
} from "../lib/regras.js";
import {
  estruturaFichaSchema,
  campoVisivelPara,
  campoEditavelPor,
  mapaCampos,
  type CampoDef,
  type EstruturaFicha,
  type Visibilidade,
  type EditavelPor,
} from "../lib/ficha.js";
import { audit } from "../lib/audit.js";
import { emitirCampanha } from "../lib/io.js";
import { limiteUsuario } from "../lib/ratelimit.js";
import {
  aplicarXp,
  lerXp,
  resumoProgressao,
  simularCompraNivel,
  type EventoXp,
} from "../lib/progressao.js";

const db = getDb();
export const progressaoRouter = Router({ mergeParams: true });
progressaoRouter.use(requireAuth);
// Rotas por personagem (/api/characters/:characterId/...): o lease de
// mutação é aplicado por rota via requireLeasePersonagem (o parâmetro
// só existe depois do match — mesmo padrão de personagens.ts).

type OverrideCampo = { visibilidade?: Visibilidade; editavelPor?: EditavelPor; destinatarios?: string[] };
type Overrides = Record<string, OverrideCampo>;

function overridesDe(personagem: typeof characters.$inferSelect): Overrides {
  return (personagem.overrides ?? {}) as Overrides;
}

async function nomeUsuario(id: string): Promise<string> {
  const [u] = await db.select({ displayName: users.displayName, username: users.username }).from(users).where(eq(users.id, id)).limit(1);
  return u?.displayName || u?.username || "?";
}

/** Mesma leitura de estrutura de personagens.ts (carregarEstrutura é
 *  privada daquele módulo — duplicada aqui para não acoplar frentes). */
async function carregarEstruturaFicha(versionId: string): Promise<EstruturaFicha | null> {
  const [v] = await db.select().from(sheetVersions).where(eq(sheetVersions.id, versionId)).limit(1);
  if (!v) return null;
  const parse = estruturaFichaSchema.safeParse(v.structure);
  return parse.success ? parse.data : null;
}

/** Carrega estrutura+regras fora da transação (leituras assíncronas);
 *  a decisão final acontece dentro da transação com dados frescos. */
async function carregarContextoRegras(personagem: typeof characters.$inferSelect) {
  const estrutura = personagem.templateVersionId
    ? await carregarEstruturaFicha(personagem.templateVersionId)
    : null;
  const regras = await carregarRegras(personagem.campaignId);
  return { estrutura, regras };
}

// ---------- GET /api/characters/:characterId/progressao ----------

/** Saldo de XP, histórico e elementos compráveis — somente mestre e
 *  dono do personagem (carregarPersonagemComAcesso já garante). */
progressaoRouter.get("/:characterId/progressao", async (req, res) => {
  const acesso = await carregarPersonagemComAcesso(req);
  if ("erro" in acesso) {
    res.status(acesso.erro ?? 500).json({ erro: acesso.erro === 404 ? "Personagem não encontrado" : "Sem permissão" });
    return;
  }
  const p = acesso.personagem;
  const { estrutura, regras } = await carregarContextoRegras(p);
  const dados = (p.data ?? {}) as Record<string, unknown>;
  if (!estrutura) {
    res.json({ xp: lerXp(dados), disponiveis: [] });
    return;
  }
  // Defesa no servidor (não só na UI): para não-mestres, o resumo
  // inteiro é calculado somente sobre vínculos visíveis ao requisitante
  // (campoVisivelPara canônica, com overrides atuais). Nível atual,
  // vínculo, preço e disponibilidade nunca derivam de campo oculto —
  // um elemento com vínculo visível E oculto não pode vazar o preço do
  // oculto pela linha do visível. Mestre recebe a visão completa.
  const ehMestre = acesso.ehMestre;
  const usuarioId = req.usuario!.id;
  const overrides = overridesDe(p);
  const mapa = mapaCampos(estrutura);
  const campoVisivelId = (campoId: string | undefined): boolean => {
    if (ehMestre) return true;
    const campo = campoId ? mapa.get(campoId) : undefined;
    if (!campo) return false; // fail-closed: campo fora da estrutura não vaza
    return campoVisivelPara(campo, overrides[campo.id], false, acesso.ehDono, usuarioId, acesso.membershipId);
  };
  const filtroVinculos = ehMestre
    ? undefined
    : (campo: CampoDef) => campoVisivelPara(campo, overrides[campo.id], false, acesso.ehDono, usuarioId, acesso.membershipId);
  const resumo = resumoProgressao(estrutura, dados, regras, filtroVinculos ? { filtroVinculos } : {});
  const disponiveis = resumo.disponiveis;
  // Histórico: compras gravadas em campos ocultos perdem os detalhes
  // (nome/key/campoId/níveis/custo) e o motivo original — que embute o
  // nome do elemento. O evento de XP em si permanece (ledger próprio).
  const historico = ehMestre
    ? resumo.xp.historico
    : resumo.xp.historico.map((ev: EventoXp) => {
        if (ev.tipo !== "compra" || !ev.compra || campoVisivelId(ev.compra.campoId)) return ev;
        const { compra: _compraOculta, ...resto } = ev;
        return { ...resto, motivo: "Compra de nível" };
      });
  res.json({ xp: { saldo: resumo.xp.saldo, historico }, disponiveis });
});

// ---------- POST /api/characters/:characterId/xp ----------

const xpSchema = z.object({
  acao: z.enum(["conceder", "remover"]),
  quantidade: z.number().int().min(1).max(1_000_000),
  motivo: z.string().trim().min(1).max(300),
});

/**
 * POST /api/characters/:characterId/xp — concessão/remoção de XP.
 * SOMENTE o mestre; personagem arquivado é somente leitura. Remoção que
 * deixaria o saldo negativo é recusada — saldo nunca fica negativo por
 * operação administrativa. Tudo dentro de transação com revalidação
 * do papel (mesmo padrão de /pontos): revogação no meio do caminho
 * não concede nada.
 */
progressaoRouter.post("/:characterId/xp", requireLeasePersonagem(), async (req, res) => {
  const acesso = await carregarPersonagemComAcesso(req);
  if ("erro" in acesso) {
    res.status(acesso.erro ?? 500).json({ erro: acesso.erro === 404 ? "Personagem não encontrado" : "Sem permissão" });
    return;
  }
  const { personagem: p, ehMestre } = acesso;
  if (!ehMestre) {
    res.status(403).json({ erro: "Apenas o mestre pode conceder ou remover XP" });
    return;
  }
  if (p.status === "arquivado") {
    res.status(403).json({ erro: "Personagem arquivado — restaure-o antes de alterar" });
    return;
  }
  const body = xpSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues });
    return;
  }
  const delta = body.data.acao === "conceder" ? body.data.quantidade : -body.data.quantidade;
  const autorNome = await nomeUsuario(req.usuario!.id);
  const agora = new Date();

  type Resultado =
    | { tipo: "ok"; saldo: number; historico: unknown[] }
    | { tipo: "ausente" }
    | { tipo: "sem_permissao" }
    | { tipo: "negativo"; saldo: number };

  const resultado = db.transaction((tx): Resultado => {
    // Revalidação transacional do papel — vínculo pode ter sido
    // revogado/rebaixado entre a checagem HTTP e a escrita.
    const [vinculo] = tx.select().from(memberships)
      .where(and(
        eq(memberships.campaignId, p.campaignId),
        eq(memberships.userId, req.usuario!.id),
        eq(memberships.status, "ativo"),
      ))
      .limit(1).all();
    if (!vinculo || vinculo.role !== "mestre") return { tipo: "sem_permissao" };
    const [atual] = tx.select().from(characters).where(eq(characters.id, p.id)).limit(1).all();
    if (!atual || atual.campaignId !== p.campaignId) return { tipo: "ausente" };
    if (atual.status === "arquivado") return { tipo: "sem_permissao" };
    const dados = (atual.data ?? {}) as Record<string, unknown>;
    const saldoAtual = lerXp(dados).saldo;
    if (saldoAtual + delta < 0) return { tipo: "negativo", saldo: saldoAtual };
    const { dados: novosDados, estado } = aplicarXp(dados, delta, {
      tipo: body.data.acao === "conceder" ? "concessao" : "remocao",
      motivo: body.data.motivo,
      autorId: req.usuario!.id,
      autorNome,
    });
    tx.update(characters).set({ data: novosDados, updatedAt: agora }).where(eq(characters.id, p.id)).run();
    return { tipo: "ok", saldo: estado.saldo, historico: estado.historico };
  });

  if (resultado.tipo === "ausente") { res.status(404).json({ erro: "Personagem não encontrado" }); return; }
  if (resultado.tipo === "sem_permissao") { res.status(403).json({ erro: "Sem permissão para alterar XP deste personagem" }); return; }
  if (resultado.tipo === "negativo") {
    res.status(400).json({ erro: `Remoção excede o saldo de XP (saldo ${resultado.saldo})`, codigo: "xp_negativo" });
    return;
  }

  await audit(req, "personagem.xp", {
    characterId: p.id, acao: body.data.acao, quantidade: body.data.quantidade,
    motivo: body.data.motivo, saldoResultante: resultado.saldo,
  });
  emitirCampanha(p.campaignId, "personagens:atualizados", { characterId: p.id });
  res.json({ ok: true, xp: { saldo: resultado.saldo, historico: resultado.historico } });
});

// ---------- POST /api/characters/:characterId/comprar-ponto ----------

const compraSchema = z.object({
  kind: z.string().min(1).max(40),
  key: z.string().min(1).max(80).regex(/^[a-z0-9_]+$/, "Use letras minúsculas, números e _"),
  nivelAlvo: z.number().int().min(1).max(100),
});

/** Contrato obrigatório de conflito de regras (Issue #124 — endurecimento
 *  de concorrência): preço, pré-requisitos e limitações devem pertencer à
 *  mesma versão vigente das regras no momento da gravação. */
const CONFLITO_REGRAS_409 = {
  erro: "As regras da campanha foram alteradas durante a compra. Atualize os dados e tente novamente.",
  codigo: "regras_alteradas",
  detalhes: {
    recurso: "regras_campanha",
    atualizarAntesDeTentar: true,
    compraEfetivada: false,
  },
} as const;

/**
 * Barreira determinística de teste (somente NODE_ENV=test +
 * MESTRE_PROGRESSAO_BARRIER=<dir>): quando <dir>/armado existe, grava
 * <dir>/iniciado e aguarda <dir>/liberar antes da transação — permite
 * reproduzir uma mudança de regras na janela pré-carga→gravação sem
 * sleeps arbitrários. Mesmo padrão de ganchos de MESTRE_SQL_TRACE.
 */
async function barreiraProvaRegras(): Promise<void> {
  const dir = process.env.NODE_ENV === "test" ? process.env.MESTRE_PROGRESSAO_BARRIER : undefined;
  if (!dir || !existsSync(join(dir, "armado"))) return;
  writeFileSync(join(dir, "iniciado"), String(Date.now()));
  const limite = Date.now() + 15_000;
  while (!existsSync(join(dir, "liberar")) && Date.now() < limite) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * POST /api/characters/:characterId/comprar-ponto — compra de UM nível
 * de elemento da biblioteca com XP. Fluxo (tudo dentro de UMA
 * transação síncrona, dados relidos na hora):
 *   nível atual → vínculo → preço (tabelas do motor) → exatamente +1
 *   → ficha resultante → validarRegras (pré-reqs/tetos/limitações #122)
 *   → saldo suficiente → débito + nível + histórico, atômicos.
 * O servidor é a única autoridade: saldo, nível e preço nunca vêm do
 * cliente. Jogador só compra para o próprio personagem; mestre para
 * qualquer um sob sua responsabilidade.
 */
progressaoRouter.post("/:characterId/comprar-ponto", requireLeasePersonagem(), limiteUsuario({ nome: "comprar-ponto", janelaMs: 5 * 60_000, max: 120 }), async (req, res) => {
  const acesso = await carregarPersonagemComAcesso(req);
  if ("erro" in acesso) {
    res.status(acesso.erro ?? 500).json({ erro: acesso.erro === 404 ? "Personagem não encontrado" : "Sem permissão" });
    return;
  }
  const { personagem: p, ehMestre } = acesso;
  if (p.status === "arquivado") {
    res.status(403).json({ erro: "Personagem arquivado — restaure-o antes de alterar" });
    return;
  }
  const body = compraSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues });
    return;
  }
  const { kind, key, nivelAlvo } = body.data;

  // Pré-carga assíncrona: regras/estrutura são lidas aqui para a decisão
  // preliminar, mas a compra só é efetivada se a impressão digital das
  // regras for IDÊNTICA dentro da transação (mesma versão lógica para
  // preço, pré-requisitos, limitações e gravação).
  const { estrutura, regras } = await carregarContextoRegras(p);
  if (!estrutura) {
    res.status(400).json({ erro: "Personagem sem ficha configurada", codigo: "sem_ficha" });
    return;
  }
  const impPreCarga = impressaoDigitalRegras(regras!);
  // Gancho de teste: reproduz mudança de regras entre a pré-carga e a tx.
  await barreiraProvaRegras();
  const autorNome = await nomeUsuario(req.usuario!.id);
  const agora = new Date();

  type Resultado =
    | { tipo: "ok"; saldo: number; compra: unknown }
    | { tipo: "ausente" }
    | { tipo: "sem_permissao" }
    | { tipo: "falha"; status: number; corpo: Record<string, unknown> };

  const resultado = db.transaction((tx): Resultado => {
    const [atual] = tx.select().from(characters).where(eq(characters.id, p.id)).limit(1).all();
    if (!atual || atual.campaignId !== p.campaignId) return { tipo: "ausente" };
    if (atual.status === "arquivado") {
      return { tipo: "falha", status: 403, corpo: { erro: "Personagem arquivado — restaure-o antes de alterar" } };
    }
    // Revalidação de vínculo/papel/propriedade DENTRO da transação:
    // mestre pela role atual; jogador somente se for o dono da ficha.
    const [vinculo] = tx.select().from(memberships)
      .where(and(
        eq(memberships.campaignId, p.campaignId),
        eq(memberships.userId, req.usuario!.id),
        eq(memberships.status, "ativo"),
      ))
      .limit(1).all();
    if (!vinculo) return { tipo: "sem_permissao" };
    // Dono da ficha: necessário tanto para a autorização quanto para a
    // visibilidade efetiva dos campos (dono_mestre/selecionados).
    const [dono] = tx.select({ userId: memberships.userId, status: memberships.status, campaignId: memberships.campaignId })
      .from(memberships).where(eq(memberships.id, atual.membershipId)).limit(1).all();
    const ehMestreTx = vinculo.role === "mestre";
    const ehDonoTx = dono?.userId === req.usuario!.id;
    const autorizado = ehMestreTx
      || (ehDonoTx && dono?.status === "ativo" && dono.campaignId === p.campaignId);
    if (!autorizado) return { tipo: "sem_permissao" };

    // Consistência transacional das regras: relê ruleset+elementos DENTRO
    // da transação e compara a impressão digital com a da pré-carga. Se
    // qualquer custo, pré-requisito, dependência, exclusividade, teto ou
    // limitação condicional mudou nesse intervalo, a compra é cancelada
    // com 409 — nada é debitado, gravado ou auditado como compra.
    const regrasTx = carregarRegrasSincrono(tx, p.campaignId);
    if (!regrasTx || impressaoDigitalRegras(regrasTx) !== impPreCarga) {
      return { tipo: "falha", status: 409, corpo: { ...CONFLITO_REGRAS_409 } };
    }

    const dados = (atual.data ?? {}) as Record<string, unknown>;
    // P2: a simulação e a gravação usam o MESMO conjunto de vínculos —
    // somente campos visíveis ao requisitante segundo a política
    // canônica (campoVisivelPara) com overrides/status da linha fresca
    // da transação. Um vínculo oculto nunca pode ser escolhido, precificar
    // ou receber a escrita, mesmo que editavelPor permita edição.
    const overridesTx = overridesDe(atual);
    const filtroVinculosTx = (campo: CampoDef) =>
      campoVisivelPara(campo, overridesTx[campo.id], ehMestreTx, ehDonoTx, req.usuario!.id, atual.membershipId);
    const compra = simularCompraNivel(
      estrutura!, dados, regrasTx, kind, key, nivelAlvo,
      { id: req.usuario!.id, nome: autorNome },
      { filtroVinculos: filtroVinculosTx },
    );
    if (!compra.ok || !compra.dados) {
      return {
        tipo: "falha",
        status: 400,
        corpo: { erro: compra.erro, codigo: compra.codigo, detalhes: compra.detalhes },
      };
    }

    // Autorização de CAMPO dentro da transação (defeito A): a compra
    // grava no campo vinculado — o jogador só pode comprar se esse
    // campo for editável para ele. Overrides e status são relidos de
    // `atual` (linha fresca da tx), nunca do estado pré-transação;
    // o papel é o vínculo revalidado acima. campoEditavelPor já
    // aplica a política canônica: mestre sempre; jogador nunca em
    // ficha bloqueada/aprovada/arquivada; editavelPor decide o resto.
    const campoId = (compra.compra as { campoId?: string } | undefined)?.campoId;
    const campoAlvo = campoId ? mapaCampos(estrutura!).get(campoId) : undefined;
    // Revalidação explícita de VISIBILIDADE do campo que recebeu a
    // compra (defesa em profundidade — a simulação já filtrou, mas a
    // checagem canônica garante o invariante mesmo se o resolvedor mudar).
    const visivel = campoAlvo
      ? campoVisivelPara(campoAlvo, overridesTx[campoAlvo.id], ehMestreTx, ehDonoTx, req.usuario!.id, atual.membershipId)
      : ehMestreTx; // campo ausente da estrutura → fail-closed p/ não-mestre
    if (!visivel) {
      return {
        tipo: "falha",
        status: 403,
        corpo: {
          erro: "Você não tem permissão para evoluir este elemento nesta ficha",
          codigo: "campo_nao_visivel",
        },
      };
    }
    const editavel = campoAlvo
      ? campoEditavelPor(campoAlvo, overridesDe(atual)[campoAlvo.id], ehMestreTx, atual.status)
      : ehMestreTx; // campo ausente da estrutura → fail-closed p/ não-mestre
    if (!editavel) {
      return {
        tipo: "falha",
        status: 403,
        corpo: {
          erro: "Este elemento está vinculado a um campo que você não pode editar",
          codigo: "campo_nao_editavel",
        },
      };
    }

    tx.update(characters).set({ data: compra.dados, updatedAt: agora }).where(eq(characters.id, p.id)).run();
    return { tipo: "ok", saldo: compra.estadoXp?.saldo ?? 0, compra: compra.compra };
  });

  if (resultado.tipo === "ausente") { res.status(404).json({ erro: "Personagem não encontrado" }); return; }
  if (resultado.tipo === "sem_permissao") { res.status(403).json({ erro: "Sem permissão para comprar níveis deste personagem" }); return; }
  if (resultado.tipo === "falha") { res.status(resultado.status).json(resultado.corpo); return; }

  await audit(req, "personagem.comprar_ponto", {
    characterId: p.id, kind, key, nivelAlvo,
    compra: resultado.compra,
  });
  emitirCampanha(p.campaignId, "personagens:atualizados", { characterId: p.id });
  res.json({ ok: true, xp: { saldo: resultado.saldo }, compra: resultado.compra });
});
