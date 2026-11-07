import { Router, type Request } from "express";
import { and, eq, desc } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { characters, sheetTemplates, sheetVersions, memberships, users, campaigns } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePapel, getMembership } from "../lib/permissoes.js";
import {
  estruturaFichaSchema,
  validarFicha,
  calcularCampos,
  campoVisivelPara,
  campoEditavelPor,
  todosCampos,
  calcularPontos,
  type EstruturaFicha,
  type Visibilidade,
  type EditavelPor,
} from "../lib/ficha.js";
import {
  carregarRegras,
  validarRegras,
  estruturaComCustosDeElementos,
  aplicarCustosSelecao,
  aplicarTransferencias,
  type RegrasCampanha,
} from "../lib/regras.js";
import { emitirCampanha } from "../lib/io.js";
import { audit } from "../lib/audit.js";

const db = getDb();
export const personagensRouter = Router({ mergeParams: true });
personagensRouter.use(requireAuth);

// ---------- helpers ----------

interface EstruturaCarregada {
  estrutura: EstruturaFicha;
  versionId: string;
  templateId: string;
}

async function carregarEstrutura(versionId: string): Promise<EstruturaCarregada | null> {
  const [v] = await db.select().from(sheetVersions).where(eq(sheetVersions.id, versionId)).limit(1);
  if (!v) return null;
  const parse = estruturaFichaSchema.safeParse(v.structure);
  if (!parse.success) return null;
  return { estrutura: parse.data, versionId: v.id, templateId: v.templateId };
}

type OverrideCampo = { visibilidade?: Visibilidade; editavelPor?: EditavelPor; destinatarios?: string[] };
type Overrides = Record<string, OverrideCampo>;

function overridesDe(personagem: typeof characters.$inferSelect): Overrides {
  return (personagem.overrides ?? {}) as Overrides;
}

/**
 * Monta a ficha para resposta:
 * - ehMestre: tudo + calculados
 * - dono: campos conforme visibilidade (sem os "mestre") + calculados dos visíveis
 * - outros: sem acesso (tratado antes)
 */
function montarFicha(
  personagem: typeof characters.$inferSelect,
  estrutura: EstruturaFicha,
  ehMestre: boolean,
  ehDono: boolean,
  userId: string,
  membershipId: string,
  regras?: RegrasCampanha
) {
  const overrides = overridesDe(personagem);
  const dados = (personagem.data ?? {}) as Record<string, unknown>;
  const campos: Record<string, unknown> = {};
  const estruturaFiltrada: EstruturaFicha = { ...estrutura, secoes: [] };

  for (const secao of estrutura.secoes) {
    const camposVisiveis = secao.campos.filter((c) =>
      campoVisivelPara(c, overrides[c.id], ehMestre, ehDono, userId, membershipId)
    );
    if (!camposVisiveis.length) continue;
    estruturaFiltrada.secoes.push({ ...secao, campos: camposVisiveis });
    for (const c of camposVisiveis) {
      if (c.tipo !== "calculado") campos[c.id] = dados[c.id] ?? c.padrao ?? null;
    }
  }

  const calculados = ehMestre
    ? calcularCampos(estrutura, dados)
    : calcularCampos(
        { ...estrutura, secoes: estruturaFiltrada.secoes },
        campos as Record<string, unknown>
      );

  // Saldo de pontos calculado no servidor (spec §8.5); com Etapa 5,
  // a config do ruleset da campanha tem prioridade e campos vinculados
  // a elementos herdam custos da biblioteca.
  const basePontos = regras ? estruturaComCustosDeElementos(estrutura, regras) : estrutura;
  const estruturaPontosVisivel = ehMestre
    ? basePontos
    : { ...basePontos, secoes: estruturaFiltrada.secoes };
  const dadosPontos = ehMestre ? dados : (campos as Record<string, unknown>);
  let pontos = calcularPontos(estruturaPontosVisivel, dadosPontos);
  if (regras) {
    pontos = aplicarTransferencias(aplicarCustosSelecao(pontos, estruturaPontosVisivel, dadosPontos, regras), regras);
  }

  // Validação de regras (pré-reqs, exclusividades, defeitos, pontos) — spec §9.
  // Para não-mestre, filtra erros de campos que ele não pode ver (privacidade).
  let validacao: { ok: boolean; erros: { campoId?: string; codigo: string; mensagem: string }[]; calculos?: Record<string, number> } | null = null;
  if (regras) {
    const r = validarRegras(estrutura, dados, regras);
    const visiveis = new Set(estruturaFiltrada.secoes.flatMap((s) => s.campos.map((c) => c.id)));
    const erros = ehMestre ? r.erros : r.erros.filter((e) => !e.campoId || visiveis.has(e.campoId));
    validacao = { ok: erros.length === 0, erros, calculos: ehMestre ? r.calculos : undefined };
  }

  return { campos, calculados, pontos, estrutura: estruturaFiltrada, validacao };
}

async function personagemPublico(
  p: typeof characters.$inferSelect,
  userId: string,
  membershipId: string,
  ehMestre: boolean
) {
  const carregada = p.templateVersionId ? await carregarEstrutura(p.templateVersionId) : null;
  const ehDono = p.membershipId === membershipId;
  if (!carregada) {
    return { personagem: { id: p.id, name: p.name, status: p.status }, ficha: null };
  }
  const regras = await carregarRegras(p.campaignId);
  const ficha = montarFicha(p, carregada.estrutura, ehMestre, ehDono, userId, membershipId, regras);
  return {
    personagem: {
      id: p.id,
      campaignId: p.campaignId,
      name: p.name,
      status: p.status,
      templateVersionId: p.templateVersionId,
      templateId: carregada.templateId,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    },
    ficha,
  };
}

// ---------- listagem ----------

/** GET /api/campaigns/:campaignId/characters — mestre vê todos; jogador só os seus */
personagensRouter.get("/", requirePapel("mestre", "jogador"), async (req, res) => {
  const campaignId = req.params.campaignId;
  const ehMestre = req.membership!.role === "mestre";
  let rows;
  if (ehMestre) {
    rows = await db
      .select({ personagem: characters, user: users, membership: memberships })
      .from(characters)
      .innerJoin(memberships, eq(characters.membershipId, memberships.id))
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(eq(characters.campaignId, campaignId))
      .orderBy(desc(characters.updatedAt));
  } else {
    rows = await db
      .select({ personagem: characters, user: users, membership: memberships })
      .from(characters)
      .innerJoin(memberships, eq(characters.membershipId, memberships.id))
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(and(eq(characters.campaignId, campaignId), eq(memberships.userId, req.usuario!.id)))
      .orderBy(desc(characters.updatedAt));
  }
  res.json({
    personagens: rows.map((r) => ({
      id: r.personagem.id,
      name: r.personagem.name,
      status: r.personagem.status,
      dono: r.user.username,
      displayName: r.user.displayName,
      membershipId: r.personagem.membershipId,
      ehEu: r.membership.userId === req.usuario!.id,
      updatedAt: r.personagem.updatedAt,
    })),
  });
});

// ---------- criação ----------

const criarSchema = z.object({
  name: z.string().min(1).max(120),
  templateVersionId: z.string().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
});

/** POST /api/campaigns/:campaignId/characters — jogador cria o próprio personagem */
personagensRouter.post("/", requirePapel("mestre", "jogador"), async (req, res) => {
  const body = criarSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues });
    return;
  }

  // Resolve a versão publicada do modelo
  let versionId = body.data.templateVersionId;
  if (!versionId) {
    const [tpl] = await db
      .select()
      .from(sheetTemplates)
      .where(
        and(
          eq(sheetTemplates.campaignId, req.params.campaignId),
          eq(sheetTemplates.isActive, true),
          eq(sheetTemplates.isDefault, true)
        )
      )
      .limit(1);
    if (!tpl?.currentVersionId) {
      res.status(400).json({ erro: "Nenhum modelo de ficha publicado disponível. Peça ao mestre para publicar uma ficha." });
      return;
    }
    versionId = tpl.currentVersionId;
  }
  const carregada = await carregarEstrutura(versionId);
  if (!carregada) {
    res.status(400).json({ erro: "Modelo de ficha inválido" });
    return;
  }
  const [versao] = await db.select().from(sheetVersions).where(eq(sheetVersions.id, versionId)).limit(1);
  if (!versao?.publishedAt) {
    res.status(400).json({ erro: "O modelo precisa estar publicado pelo mestre antes de criar personagens." });
    return;
  }

  const validacao = validarFicha(carregada.estrutura, body.data.data ?? {}, { estrito: false });
  if (!validacao.ok) {
    res.status(400).json({ erro: "Dados da ficha inválidos", detalhes: validacao.erros });
    return;
  }
  // Motor de regras da campanha (Etapa 5): pontos + pré-requisitos +
  // exclusividades + defeitos obrigatórios. Mestre pode ignorar via
  // ajuste administrativo? Na criação sempre valida (é o jogador criando).
  const regras = await carregarRegras(req.params.campaignId);
  const validacaoRegras = validarRegras(carregada.estrutura, validacao.dados, regras);
  if (!validacaoRegras.ok) {
    res.status(400).json({ erro: "Ficha viola as regras da campanha", detalhes: { erros: validacaoRegras.erros } });
    return;
  }

  const agora = new Date();
  const id = crypto.randomUUID();
  await db.insert(characters).values({
    id,
    campaignId: req.params.campaignId,
    membershipId: req.membership!.id,
    templateVersionId: versionId,
    name: body.data.name,
    data: validacao.dados,
    overrides: {},
    status: "rascunho",
    createdAt: agora,
    updatedAt: agora,
  });
  await audit(req, "personagem.criado", { characterId: id, name: body.data.name });
  emitirCampanha(req.params.campaignId, "personagens:atualizados", { characterId: id });

  const [p] = await db.select().from(characters).where(eq(characters.id, id)).limit(1);
  const resp = await personagemPublico(p, req.usuario!.id, req.membership!.id, req.membership!.role === "mestre");
  res.status(201).json(resp);
});

// ---------- leitura/edição por id ----------

export async function carregarPersonagemComAcesso(req: Request) {
  const [p] = await db.select().from(characters).where(eq(characters.id, req.params.characterId)).limit(1);
  if (!p) return { erro: 404 as const };
  const membership = await getMembership(p.campaignId, req.usuario!.id);
  const ehMestre = membership?.role === "mestre";
  const [membroDono] = await db.select().from(memberships).where(eq(memberships.id, p.membershipId)).limit(1);
  const ehDono = membroDono?.userId === req.usuario!.id;
  if (!membership || membership.status !== "ativo" || (!ehMestre && !ehDono)) {
    return { erro: 403 as const };
  }
  return { personagem: p, membership, ehMestre, ehDono, membershipId: p.membershipId };
}

/** GET /api/characters/:characterId — ficha conforme permissões de visibilidade */
personagensRouter.get("/:characterId", async (req, res) => {
  const acesso = await carregarPersonagemComAcesso(req);
  if ("erro" in acesso) {
    res.status(acesso.erro ?? 500).json({ erro: acesso.erro === 404 ? "Personagem não encontrado" : "Sem permissão" });
    return;
  }
  const resp = await personagemPublico(acesso.personagem, req.usuario!.id, acesso.membershipId, acesso.ehMestre);
  res.json(resp);
});

const atualizarSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["rascunho", "aguardando_aprovacao", "devolvida", "aprovada", "bloqueada"]).optional(),
  overrides: z.record(z.string(), z.object({
    visibilidade: z.enum(["todos", "dono_mestre", "mestre", "selecionados"]).optional(),
    editavelPor: z.enum(["jogador", "mestre", "ambos"]).optional(),
    destinatarios: z.array(z.string()).optional(),
  })).optional(),
  // Ajuste administrativo do mestre: permite salvar mesmo estourando pontos (spec §8.5)
  ignorarPontos: z.boolean().optional(),
});

/** PATCH /api/characters/:characterId — dono edita campos permitidos; mestre tudo */
personagensRouter.patch("/:characterId", async (req, res) => {
  const acesso = await carregarPersonagemComAcesso(req);
  if ("erro" in acesso) {
    res.status(acesso.erro ?? 500).json({ erro: acesso.erro === 404 ? "Personagem não encontrado" : "Sem permissão" });
    return;
  }
  const { personagem: p, ehMestre, ehDono } = acesso;
  const body = atualizarSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues });
    return;
  }

  const carregada = p.templateVersionId ? await carregarEstrutura(p.templateVersionId) : null;
  const estrutura = carregada?.estrutura ?? { versao: 1 as const, secoes: [], pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} } };
  const overrides = { ...overridesDe(p), ...(body.data.overrides ?? {}) } as Overrides;
  const dados = { ...((p.data ?? {}) as Record<string, unknown>), ...(body.data.data ?? {}) };

  // Dono: só campos editáveis conforme template + overrides
  let dadosFinais = dados;
  if (!ehMestre && body.data.data) {
    const permitidos = new Set<string>();
    for (const campo of todosCampos(estrutura)) {
      const ov = overrides[campo.id];
      if (campoEditavelPor(campo, ov, false, p.status)) permitidos.add(campo.id);
    }
    const validacao = validarFicha(estrutura, body.data.data, { apenasCamposPermitidos: permitidos, aplicarPadroes: false });
    if (!validacao.ok) {
      res.status(400).json({ erro: "Dados inválidos", detalhes: validacao.erros });
      return;
    }
    dadosFinais = { ...(p.data as Record<string, unknown>), ...validacao.dados };
  } else if (ehMestre && body.data.data) {
    const validacao = validarFicha(estrutura, body.data.data, { estrito: false, aplicarPadroes: false });
    if (!validacao.ok) {
      res.status(400).json({ erro: "Dados inválidos", detalhes: validacao.erros });
      return;
    }
    dadosFinais = { ...(p.data as Record<string, unknown>), ...validacao.dados };
  }

  // Validação do motor de regras (spec §9): jogador sempre validado;
  // mestre também, salvo ajuste administrativo explícito (ignorarPontos).
  const regras = await carregarRegras(p.campaignId);
  let validacaoRegras = validarRegras(estrutura, dadosFinais, regras);
  if (!(ehMestre && body.data.ignorarPontos) && !validacaoRegras.ok) {
    res.status(400).json({ erro: "Ficha viola as regras da campanha", detalhes: { erros: validacaoRegras.erros } });
    return;
  }

  // Transições de status
  let novoStatus = body.data.status ?? p.status;
  if (!ehMestre && body.data.status && body.data.status !== "aguardando_aprovacao" && body.data.status !== "rascunho") {
    res.status(403).json({ erro: "Apenas o mestre pode aprovar, reprovar ou bloquear fichas" });
    return;
  }
  if (!ehMestre && body.data.status === "aguardando_aprovacao" && p.status === "aprovada") {
    // edição em ficha aprovada volta para análise se a campanha exigir aprovação
    const [camp] = await db.select().from(campaigns).where(eq(campaigns.id, p.campaignId)).limit(1);
    const exige = (camp?.settings as { exigirAprovacaoFicha?: boolean } | null)?.exigirAprovacaoFicha;
    if (exige) novoStatus = "aguardando_aprovacao";
  }
  if (ehMestre) {
    const permitidos = new Set(["rascunho", "aguardando_aprovacao", "devolvida", "aprovada", "bloqueada"]);
    if (body.data.status && !permitidos.has(body.data.status)) {
      res.status(400).json({ erro: "Status inválido" });
      return;
    }
  }

  // Aprovação automática quando configurada e regras cumpridas (spec §9).
  // Padrão é aprovação manual — o mestre sempre decide.
  if (
    !ehMestre &&
    novoStatus === "aguardando_aprovacao" &&
    regras.config.aprovacaoAutomatica &&
    validacaoRegras.ok
  ) {
    novoStatus = "aprovada";
  }

  await db
    .update(characters)
    .set({
      name: body.data.name ?? p.name,
      data: dadosFinais,
      overrides: ehMestre ? overrides : overridesDe(p), // dono não altera overrides
      status: novoStatus,
      updatedAt: new Date(),
    })
    .where(eq(characters.id, p.id));

  await audit(req, "personagem.atualizado", { characterId: p.id, status: novoStatus });
  emitirCampanha(p.campaignId, "personagens:atualizados", { characterId: p.id });

  const [atualizado] = await db.select().from(characters).where(eq(characters.id, p.id)).limit(1);
  const resp = await personagemPublico(atualizado, req.usuario!.id, acesso.membershipId, ehMestre);
  res.json(resp);
});
