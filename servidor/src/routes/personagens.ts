import { Router, type Request } from "express";
import { and, eq, desc } from "drizzle-orm";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { getDb } from "../db/index.js";
import { characters, sheetTemplates, sheetVersions, memberships, users } from "../db/schema.js";
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
  parseNumeroBR,
  resumoCarteira,
  type EstruturaFicha,
  type Visibilidade,
  type EditavelPor,
} from "../lib/ficha.js";
import { resumoHp, resumoVitalidade, lerHp, lerVitalidade, aplicarHp, hpMaximo, CHAVE_HP, CHAVE_VITALIDADE } from "../lib/vida.js";
import { lerPontos, bonusPontos, comSeloPontos, aplicarBonusPontos } from "../lib/pontos.js";
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
import { limiteUsuario } from "../lib/ratelimit.js";

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

const ESTRUTURA_VAZIA: EstruturaFicha = { versao: 1, secoes: [], pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} } };

async function estruturaDoPersonagem(p: typeof characters.$inferSelect): Promise<EstruturaFicha> {
  if (!p.templateVersionId) return ESTRUTURA_VAZIA;
  const carregada = await carregarEstrutura(p.templateVersionId);
  return carregada?.estrutura ?? ESTRUTURA_VAZIA;
}

async function nomeUsuario(id: string): Promise<string> {
  const [u] = await db.select({ displayName: users.displayName, username: users.username }).from(users).where(eq(users.id, id)).limit(1);
  return u?.displayName || u?.username || "?";
}

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
  regras?: RegrasCampanha,
  dadosOverride?: Record<string, unknown>
) {
  const overrides = overridesDe(personagem);
  const dados = (dadosOverride ?? personagem.data ?? {}) as Record<string, unknown>;
  const campos: Record<string, unknown> = {};
  const estruturaFiltrada: EstruturaFicha = { ...estrutura, secoes: [] };

  // Uma seção é mantida se tiver campos visíveis OU subseções com campos
  // visíveis (seções de agrupamento, ex.: "Atributos", não têm campos próprios).
  const visMap = new Map<string, typeof estrutura.secoes[number]["campos"]>();
  for (const secao of estrutura.secoes) {
    visMap.set(secao.id, secao.campos.filter((c) =>
      campoVisivelPara(c, overrides[c.id], ehMestre, ehDono, userId, membershipId)
    ));
  }
  const temFilhoVisivel = (id: string) =>
    estrutura.secoes.some((s) => s.parentId === id && (visMap.get(s.id)?.length ?? 0) > 0);

  for (const secao of estrutura.secoes) {
    const camposVisiveis = visMap.get(secao.id) ?? [];
    if (!camposVisiveis.length && !temFilhoVisivel(secao.id)) continue;
    estruturaFiltrada.secoes.push({ ...secao, campos: camposVisiveis });
    for (const c of camposVisiveis) {
      if (c.tipo === "calculado") continue;
      // Carteira: o valor do campo são só as movimentações (array);
      // o saldo inicial fica na chave "<id>::saldo" dos dados.
      if (c.carteira) {
        campos[c.id] = Array.isArray(dados[c.id]) ? dados[c.id] : [];
        continue;
      }
      campos[c.id] = dados[c.id] ?? c.padrao ?? null;
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
  // a elementos herdam custos da biblioteca. O bônus individual do
  // personagem (__pontos.bonus, concedido pelo mestre) soma no pool
  // principal — vale também na prévia de pontos.
  const bonus = bonusPontos((personagem.data ?? {}) as Record<string, unknown>);
  const basePontos = regras ? estruturaComCustosDeElementos(estrutura, regras, bonus) : estrutura;
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
    const r = validarRegras(estrutura, dados, regras, { bonusPontos: bonus });
    const visiveis = new Set(estruturaFiltrada.secoes.flatMap((s) => s.campos.map((c) => c.id)));
    const erros = ehMestre ? r.erros : r.erros.filter((e) => !e.campoId || visiveis.has(e.campoId));
    validacao = { ok: erros.length === 0, erros, calculos: ehMestre ? r.calculos : undefined };
  }

  // Carteiras visíveis: resumo calculado no servidor (saldo inicial +
  // entradas - saídas). Escalar legado no campo vira saldo inicial.
  const carteiras: Record<string, { saldoInicial: number; entradas: number; saidas: number; saldo: number }> = {};
  for (const secao of estruturaFiltrada.secoes) {
    for (const c of secao.campos) {
      if (!c.carteira || c.tipo !== "tabela") continue;
      const bruto = dados[c.id];
      const linhas = Array.isArray(bruto) ? bruto : [];
      let saldoInicial = parseNumeroBR(dados[`${c.id}::saldo`]);
      if (saldoInicial === null && bruto !== undefined && bruto !== null && bruto !== "" && !Array.isArray(bruto)) {
        saldoInicial = parseNumeroBR(bruto); // valor antigo do campo = saldo
      }
      if (saldoInicial === null) saldoInicial = parseNumeroBR(c.padrao) ?? 0;
      carteiras[c.id] = { saldoInicial, ...resumoCarteira(linhas, saldoInicial) };
    }
  }

  // Pontos de Vida e Vitalidade (config da campanha; estado em data.__hp/__vitalidade)
  const vida = regras
    ? {
        hp: resumoHp(regras.config.hp, estrutura, dados),
        vitalidade: resumoVitalidade(regras.config.vitalidade, dados),
        podeEditarHp: ehMestre || (!ehMestre && ehDono && regras.config.hp.edicaoPor !== "mestre"),
        podeEditarVitalidade: ehMestre || (!ehMestre && ehDono && regras.config.vitalidade.edicaoPor !== "mestre"),
      }
    : null;

  return {
    campos,
    calculados,
    pontos,
    estrutura: estruturaFiltrada,
    validacao,
    carteiras,
    vida,
    // Config Poderes×Defeitos da campanha — a ficha usa p/ UX (limite,
    // aviso de defeito obrigatório). A validação real é do backend.
    poderes: regras?.config.poderes ?? null,
    // Bônus individual de pontos (__pontos): valor sempre visível;
    // histórico só para o mestre.
    pontosBonus: (() => {
      const est = lerPontos((personagem.data ?? {}) as Record<string, unknown>);
      return { bonus: est.bonus, selado: est.selo !== null, historico: ehMestre ? est.historico : undefined };
    })(),
  };
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
  // Nome do dono da ficha (displayName ou username) — exibido somente-leitura.
  const [dono] = await db
    .select({ displayName: users.displayName, username: users.username })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.id, p.membershipId))
    .limit(1);
  return {
    personagem: {
      id: p.id,
      campaignId: p.campaignId,
      name: p.name,
      status: p.status,
      templateVersionId: p.templateVersionId,
      templateId: carregada.templateId,
      donoNome: dono?.displayName ?? dono?.username ?? null,
      isNpc: p.isNpc,
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
      isNpc: r.personagem.isNpc,
      updatedAt: r.personagem.updatedAt,
    })),
  });
});

// ---------- criação ----------

const criarSchema = z.object({
  name: z.string().min(1).max(120),
  templateVersionId: z.string().optional(),
  data: z.record(z.string(), z.unknown()).default({}),
  // NPC: personagem controlado pelo mestre (inimigo, aliado, figurante).
  // Nasce aprovado e com pontos selados; só o mestre cria.
  isNpc: z.boolean().optional(),
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

  const ehMestreCriacao = req.membership!.role === "mestre";
  const isNpc = body.data.isNpc === true;
  if (isNpc && !ehMestreCriacao) {
    res.status(403).json({ erro: "Apenas o mestre pode criar personagens NPC" });
    return;
  }
  const carteirasSaldoCriacao = new Set<string>();
  for (const c of todosCampos(carregada.estrutura)) {
    if (!c.carteira) continue;
    const saldoOk = ehMestreCriacao || c.carteira.saldoEditavelPor !== "mestre";
    const campoOk = ehMestreCriacao || campoEditavelPor(c, undefined, false, "rascunho");
    if (saldoOk && campoOk) carteirasSaldoCriacao.add(c.id);
  }
  const validacao = validarFicha(carregada.estrutura, body.data.data ?? {}, { estrito: false, carteirasSaldo: carteirasSaldoCriacao });
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

  // HP começa cheio na criação quando a campanha habilita Pontos de Vida.
  let dadosCriacao = { ...validacao.dados } as Record<string, unknown>;
  const hpMax = hpMaximo(regras.config.hp, carregada.estrutura, dadosCriacao);
  if (hpMax !== null) {
    dadosCriacao[CHAVE_HP] = {
      atual: hpMax,
      historico: [{ em: new Date().toISOString(), tipo: "inicial", quantidade: hpMax, motivo: "HP inicial", autorId: req.usuario!.id, autorNome: null }],
    };
  }
  // NPC nasce aprovado e com pontos selados (ninguém disputa aprovação).
  if (isNpc) {
    dadosCriacao = comSeloPontos(dadosCriacao, { id: req.usuario!.id, nome: await nomeUsuario(req.usuario!.id) });
  }

  const agora = new Date();
  const id = crypto.randomUUID();
  await db.insert(characters).values({
    id,
    campaignId: req.params.campaignId,
    membershipId: req.membership!.id,
    templateVersionId: versionId,
    name: body.data.name,
    data: dadosCriacao,
    overrides: {},
    status: isNpc ? "aprovada" : "rascunho",
    isNpc,
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

const previaPontosSchema = z.object({
  dados: z.record(z.string(), z.unknown()).default({}),
});

/**
 * POST /api/characters/:characterId/pontos-previa — saldo de pontos para um
 * rascunho de dados, sem salvar. Usa exatamente o mesmo pipeline do GET
 * (custos da biblioteca, seleção e transferências de reservas), respeitando
 * a visibilidade do solicitante. Não substitui a validação do PATCH.
 */
personagensRouter.post("/:characterId/pontos-previa", limiteUsuario({ nome: "pontos-previa", janelaMs: 5 * 60_000, max: 240 }), async (req, res) => {
  const acesso = await carregarPersonagemComAcesso(req);
  if ("erro" in acesso) {
    res.status(acesso.erro ?? 500).json({ erro: acesso.erro === 404 ? "Personagem não encontrado" : "Sem permissão" });
    return;
  }
  const body = previaPontosSchema.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues });
    return;
  }
  const carregada = acesso.personagem.templateVersionId ? await carregarEstrutura(acesso.personagem.templateVersionId) : null;
  if (!carregada) {
    res.json({ pontos: { habilitado: false, pools: [], detalhes: [], erros: [] } });
    return;
  }
  const regras = await carregarRegras(acesso.personagem.campaignId);
  const ficha = montarFicha(
    acesso.personagem,
    carregada.estrutura,
    acesso.ehMestre,
    acesso.ehDono,
    req.usuario!.id,
    acesso.membershipId,
    regras,
    body.data.dados
  );
  res.json({ pontos: ficha.pontos });
});

const atualizarSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["rascunho", "aguardando_aprovacao", "devolvida", "reaberta", "aprovada", "bloqueada"]).optional(),
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

  // Carteiras cujo saldo inicial o requerente pode alterar: mestre sempre;
  // jogador só se o campo for editável por ele e saldoEditavelPor != "mestre".
  const carteirasSaldo = new Set<string>();
  for (const c of todosCampos(estrutura)) {
    if (!c.carteira) continue;
    const saldoOk = ehMestre || c.carteira.saldoEditavelPor !== "mestre";
    const campoOk = ehMestre || campoEditavelPor(c, overrides[c.id], false, p.status);
    if (saldoOk && campoOk) carteirasSaldo.add(c.id);
  }

  // Dono: só campos editáveis conforme template + overrides
  let dadosFinais = dados;
  if (!ehMestre && body.data.data) {
    const permitidos = new Set<string>();
    for (const campo of todosCampos(estrutura)) {
      const ov = overrides[campo.id];
      if (campoEditavelPor(campo, ov, false, p.status)) permitidos.add(campo.id);
    }
    const validacao = validarFicha(estrutura, body.data.data, { apenasCamposPermitidos: permitidos, aplicarPadroes: false, carteirasSaldo });
    if (!validacao.ok) {
      res.status(400).json({ erro: "Dados inválidos", detalhes: validacao.erros });
      return;
    }
    dadosFinais = { ...(p.data as Record<string, unknown>), ...validacao.dados };
  } else if (ehMestre && body.data.data) {
    const validacao = validarFicha(estrutura, body.data.data, { estrito: false, aplicarPadroes: false, carteirasSaldo });
    if (!validacao.ok) {
      res.status(400).json({ erro: "Dados inválidos", detalhes: validacao.erros });
      return;
    }
    dadosFinais = { ...(p.data as Record<string, unknown>), ...validacao.dados };
  }

  // Validação do motor de regras (spec §9): jogador sempre validado;
  // mestre também, salvo ajuste administrativo explícito (ignorarPontos).
  // O bônus individual (__pontos.bonus) entra no pool principal.
  const regras = await carregarRegras(p.campaignId);
  const bonusAtual = bonusPontos((p.data ?? {}) as Record<string, unknown>);
  let validacaoRegras = validarRegras(estrutura, dadosFinais, regras, { bonusPontos: bonusAtual });
  if (!(ehMestre && body.data.ignorarPontos) && !validacaoRegras.ok) {
    res.status(400).json({ erro: "Ficha viola as regras da campanha", detalhes: { erros: validacaoRegras.erros } });
    return;
  }

  // Trava de pontos selados: ficha já aprovada não pode ter o total de
  // pontos alterado pelo jogador — só o mestre (edição direta ou o
  // endpoint /pontos). A comparação usa o pipeline real do servidor,
  // nunca um total enviado pelo cliente.
  const dadosAntigos = (p.data ?? {}) as Record<string, unknown>;
  if (!ehMestre && lerPontos(dadosAntigos).selo) {
    const pontosAntes = validarRegras(estrutura, dadosAntigos, regras, { bonusPontos: bonusAtual }).pontos;
    const assinatura = (pts: typeof validacaoRegras.pontos) =>
      JSON.stringify(pts.pools.map((x) => [x.id, x.disponiveis, x.gastos, x.saldo, x.cedidos ?? 0, x.recebidos ?? 0]));
    if (assinatura(pontosAntes) !== assinatura(validacaoRegras.pontos)) {
      res.status(403).json({ erro: "Ficha selada: o total de pontos só pode ser alterado pelo mestre" });
      return;
    }
  }

  // Personagens antigos sem estado de HP: inicializa cheio na primeira gravação.
  if (regras.config.hp.habilitado && dadosFinais[CHAVE_HP] === undefined) {
    const hpMax = hpMaximo(regras.config.hp, estrutura, dadosFinais);
    if (hpMax !== null) {
      dadosFinais = {
        ...dadosFinais,
        [CHAVE_HP]: {
          atual: hpMax,
          historico: [{ em: new Date().toISOString(), tipo: "inicial", quantidade: hpMax, motivo: "HP inicial", autorId: req.usuario!.id, autorNome: null }],
        },
      };
    }
  }

  // Transições de status
  let novoStatus = body.data.status ?? p.status;
  // Jogador não tira a ficha de aprovada/bloqueada — só o mestre reabre
  // ("reaberta") ou desbloqueia. Sem isso daria para contornar a trava
  // de pontos voltando o status para rascunho.
  if (!ehMestre && (p.status === "aprovada" || p.status === "bloqueada") && body.data.status && body.data.status !== p.status) {
    res.status(403).json({ erro: "Apenas o mestre pode alterar o status de uma ficha aprovada ou bloqueada" });
    return;
  }
  if (!ehMestre && body.data.status && body.data.status !== "aguardando_aprovacao" && body.data.status !== "rascunho") {
    res.status(403).json({ erro: "Apenas o mestre pode aprovar, reprovar, reabrir ou bloquear fichas" });
    return;
  }
  if (ehMestre) {
    const permitidos = new Set(["rascunho", "aguardando_aprovacao", "devolvida", "reaberta", "aprovada", "bloqueada"]);
    if (body.data.status && !permitidos.has(body.data.status)) {
      res.status(400).json({ erro: "Status inválido" });
      return;
    }
    // "Reabrir" só faz sentido sobre ficha aprovada — libera edição
    // narrativa sem remover o selo de pontos.
    if (body.data.status === "reaberta" && p.status !== "aprovada") {
      res.status(400).json({ erro: "Só é possível reabrir uma ficha aprovada" });
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

  // Aprovação sela os pontos: a partir daqui o jogador não altera mais
  // campos que mudem o total de pontos (o selo nunca é removido por
  // Reabrir/Devolver — só o mestre concede/remove via /pontos).
  if (novoStatus === "aprovada" && !lerPontos(dadosFinais).selo) {
    dadosFinais = comSeloPontos(dadosFinais, { id: req.usuario!.id, nome: await nomeUsuario(req.usuario!.id) });
  }

  // O PATCH foi validado a partir do snapshot carregado no início da
  // requisição. Antes de gravar, compara esse snapshot dentro de uma
  // transação síncrona: HP, Vitalidade, pontos ou outro PATCH que tenham
  // sido salvos enquanto validávamos não podem ser sobrescritos por JSON velho.
  const conflito = db.transaction((tx) => {
    const [atual] = tx.select().from(characters).where(eq(characters.id, p.id)).limit(1).all();
    if (!atual) return "ausente" as const;
    const mesmaData = JSON.stringify(atual.data ?? {}) === JSON.stringify(p.data ?? {});
    const mesmosOverrides = JSON.stringify(atual.overrides ?? {}) === JSON.stringify(p.overrides ?? {});
    const mesmoUpdatedAt = atual.updatedAt instanceof Date && p.updatedAt instanceof Date
      ? atual.updatedAt.getTime() === p.updatedAt.getTime()
      : String(atual.updatedAt) === String(p.updatedAt);
    if (!mesmaData || !mesmosOverrides || !mesmoUpdatedAt || atual.name !== p.name || atual.status !== p.status) {
      return "conflito" as const;
    }
    tx.update(characters)
      .set({
        name: body.data.name ?? atual.name,
        data: dadosFinais,
        overrides: ehMestre ? overrides : (atual.overrides ?? {}),
        status: novoStatus,
        updatedAt: new Date(),
      })
      .where(eq(characters.id, p.id))
      .run();
    return null;
  });
  if (conflito === "ausente") {
    res.status(404).json({ erro: "Personagem não encontrado" });
    return;
  }
  if (conflito === "conflito") {
    res.status(409).json({ erro: "A ficha foi alterada por outra operação. Atualize os dados e tente novamente." });
    return;
  }

  await audit(req, "personagem.atualizado", { characterId: p.id, status: novoStatus });
  emitirCampanha(p.campaignId, "personagens:atualizados", { characterId: p.id });

  const [atualizado] = await db.select().from(characters).where(eq(characters.id, p.id)).limit(1);
  const resp = await personagemPublico(atualizado, req.usuario!.id, acesso.membershipId, ehMestre);
  res.json(resp);
});

// ---------- Pontos de Vida e Vitalidade ----------

const hpSchema = z.object({
  acao: z.enum(["dano", "recuperar", "ajuste"]),
  quantidade: z.number().optional(),
  motivo: z.string().max(300).optional(),
});

/** POST /api/characters/:characterId/hp — dano/recuperação/ajuste de HP.
 *  O HP atual nunca fica negativo nem acima do máximo; histórico gravado. */
personagensRouter.post("/:characterId/hp", async (req, res) => {
  const acesso = await carregarPersonagemComAcesso(req);
  if ("erro" in acesso) {
    res.status(acesso.erro ?? 500).json({ erro: acesso.erro === 404 ? "Personagem não encontrado" : "Sem permissão" });
    return;
  }
  const { personagem: p, ehMestre, ehDono } = acesso;
  const body = hpSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues });
    return;
  }
  const regras = await carregarRegras(p.campaignId);
  const cfg = regras.config.hp;
  if (!cfg.habilitado) {
    res.status(400).json({ erro: "Pontos de vida não estão habilitados nesta campanha" });
    return;
  }
  const estrutura = await estruturaDoPersonagem(p);
  if (!ehMestre && !(ehDono && cfg.edicaoPor !== "mestre")) {
    res.status(403).json({ erro: "Sem permissão para alterar o HP deste personagem" });
    return;
  }

  const { acao, motivo } = body.data;
  let delta = 0;
  if (acao === "ajuste") {
    delta = body.data.quantidade ?? 0;
    if (!Number.isFinite(delta) || delta === 0) {
      res.status(400).json({ erro: "Ajuste exige uma quantidade diferente de zero" });
      return;
    }
  } else {
    const q = body.data.quantidade;
    if (typeof q !== "number" || !Number.isFinite(q) || q <= 0) {
      res.status(400).json({ erro: "Quantidade deve ser um número positivo" });
      return;
    }
    delta = acao === "dano" ? -Math.abs(q) : Math.abs(q);
  }

  // Releitura + cálculo + gravação na MESMA transação: duas alterações
  // simultâneas não perdem entradas do histórico (read-modify-write atômico).
  const agora = new Date();
  const autorNome = await nomeUsuario(req.usuario!.id);
  let resposta: { hp: unknown; deltaHp: number } | null = null;
  let erroHp: string | null = null;
  let sumiu = false;
  await db.transaction((tx) => {
    const [atual] = tx.select().from(characters).where(eq(characters.id, p.id)).limit(1).all();
    if (!atual) { sumiu = true; return; }
    const dadosTx = (atual.data ?? {}) as Record<string, unknown>;
    const maxTx = hpMaximo(cfg, estrutura, dadosTx);
    if (maxTx === null) { erroHp = "maximo"; return; }
    const estado = lerHp(dadosTx);
    const { estado: novo, erro } = aplicarHp(estado, maxTx, delta, {
      em: agora.toISOString(),
      tipo: acao === "dano" ? "dano" : acao === "recuperar" ? "recuperacao" : "ajuste",
      motivo: motivo?.trim() || (acao === "dano" ? "Dano" : acao === "recuperar" ? "Recuperação" : "Ajuste"),
      autorId: req.usuario!.id,
      autorNome,
    });
    if (erro) { erroHp = erro; return; }
    const novosDados = { ...dadosTx, [CHAVE_HP]: novo };
    tx.update(characters).set({ data: novosDados, updatedAt: agora }).where(eq(characters.id, p.id)).run();
    resposta = { hp: resumoHp(cfg, estrutura, novosDados), deltaHp: novo.atual - (estado?.atual ?? maxTx) };
  });
  if (sumiu) { res.status(404).json({ erro: "Personagem não encontrado" }); return; }
  if (erroHp === "maximo") {
    res.status(400).json({ erro: "Não foi possível calcular o HP máximo (verifique o atributo configurado)" });
    return;
  }
  if (erroHp) { res.status(400).json({ erro: erroHp }); return; }
  await audit(req, "personagem.hp", { characterId: p.id, acao, delta: resposta!.deltaHp });
  emitirCampanha(p.campaignId, "personagens:atualizados", { characterId: p.id });
  res.json({ ok: true, hp: resposta!.hp });
});

const vitalidadeSchema = z.object({ nivel: z.number().int().min(0), motivo: z.string().max(300).optional() });

/** POST /api/characters/:characterId/vitalidade — define o nível de ferimento. */
personagensRouter.post("/:characterId/vitalidade", async (req, res) => {
  const acesso = await carregarPersonagemComAcesso(req);
  if ("erro" in acesso) {
    res.status(acesso.erro ?? 500).json({ erro: acesso.erro === 404 ? "Personagem não encontrado" : "Sem permissão" });
    return;
  }
  const { personagem: p, ehMestre, ehDono } = acesso;
  const body = vitalidadeSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues });
    return;
  }
  const regras = await carregarRegras(p.campaignId);
  const cfg = regras.config.vitalidade;
  if (body.data.nivel >= cfg.niveis.length) {
    res.status(400).json({ erro: `Nível inválido (0 a ${cfg.niveis.length - 1})` });
    return;
  }
  if (!ehMestre && !(ehDono && cfg.edicaoPor !== "mestre")) {
    res.status(403).json({ erro: "Sem permissão para alterar a vitalidade deste personagem" });
    return;
  }
  // Releitura + cálculo + gravação na MESMA transação: alterações
  // simultâneas não perdem entradas do histórico.
  const agora = new Date();
  const autorNome = await nomeUsuario(req.usuario!.id);
  let resposta: unknown = null;
  let sumiu = false;
  await db.transaction((tx) => {
    const [atual] = tx.select().from(characters).where(eq(characters.id, p.id)).limit(1).all();
    if (!atual) { sumiu = true; return; }
    const dadosTx = (atual.data ?? {}) as Record<string, unknown>;
    const anterior = lerVitalidade(dadosTx);
    const estado = {
      ...anterior,
      nivel: body.data.nivel,
      alteradoEm: agora.toISOString(),
      alteradoPor: req.usuario!.id,
      historico: [
        ...(anterior.historico ?? []),
        {
          em: agora.toISOString(),
          nivelAnterior: anterior.nivel,
          nivelNovo: body.data.nivel,
          motivo: body.data.motivo?.trim() || null,
          autorId: req.usuario!.id,
          autorNome,
        },
      ].slice(-100),
    };
    const novosDados = { ...dadosTx, [CHAVE_VITALIDADE]: estado };
    tx.update(characters).set({ data: novosDados, updatedAt: agora }).where(eq(characters.id, p.id)).run();
    resposta = resumoVitalidade(cfg, novosDados);
  });
  if (sumiu) { res.status(404).json({ erro: "Personagem não encontrado" }); return; }
  await audit(req, "personagem.vitalidade", { characterId: p.id, nivel: body.data.nivel });
  emitirCampanha(p.campaignId, "personagens:atualizados", { characterId: p.id });
  res.json({ ok: true, vitalidade: resposta });
});

// ---------- Bônus individual de pontos (somente mestre) ----------

const pontosSchema = z.object({
  acao: z.enum(["conceder", "remover"]),
  quantidade: z.number().int().min(1).max(10000),
  motivo: z.string().trim().min(1).max(300),
});

/**
 * POST /api/characters/:characterId/pontos — concede/remove pontos do
 * bônus individual (__pontos.bonus), com motivo e histórico. Somente o
 * mestre: o bônus soma no pool principal do personagem e pode ser
 * distribuído por ele mesmo quando a ficha está selada.
 */
personagensRouter.post("/:characterId/pontos", async (req, res) => {
  const acesso = await carregarPersonagemComAcesso(req);
  if ("erro" in acesso) {
    res.status(acesso.erro ?? 500).json({ erro: acesso.erro === 404 ? "Personagem não encontrado" : "Sem permissão" });
    return;
  }
  const { personagem: p, ehMestre } = acesso;
  if (!ehMestre) {
    res.status(403).json({ erro: "Apenas o mestre pode conceder ou remover pontos" });
    return;
  }
  const body = pontosSchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ erro: "Dados inválidos", detalhes: body.error.issues });
    return;
  }
  const delta = body.data.acao === "conceder" ? body.data.quantidade : -body.data.quantidade;
  const autorNome = await nomeUsuario(req.usuario!.id);

  // Barreira determinística exclusiva de teste (TOCTOU): exige modo de
  // teste explícito (NODE_ENV=test) E MESTRE_PONTOS_GATE_DIR definido E o
  // arquivo "armar" no diretório. Em produção qualquer um dos três
  // ausente faz o endpoint ignorar a configuração por completo.
  const gateDir = process.env.NODE_ENV === "test" ? process.env.MESTRE_PONTOS_GATE_DIR : undefined;
  if (gateDir && existsSync(join(gateDir, "armar"))) {
    try {
      writeFileSync(join(gateDir, "chegou"), String(Date.now()));
      const limite = Date.now() + 10_000;
      while (!existsSync(join(gateDir, "liberar")) && Date.now() < limite) {
        await new Promise((r) => setTimeout(r, 5));
      }
    } catch { /* gate é best-effort; nunca bloqueia a requisição por erro de FS */ }
  }

  // Transação: relê vínculo, ficha, calcula, grava atomicamente
  const agora = new Date();
  let resposta: { ok: true; pontos: { bonus: number; selado: boolean; historico: unknown[] } } | null = null;
  let sumiu = false;
  let revogado = false;
  await db.transaction((tx) => {
    // Revalidação transacional: o vínculo pode ter sido revogado/rebaixado
    // entre a checagem inicial e esta mutação — não confiar no ehMestre.
    const [vinculo] = tx.select().from(memberships)
      .where(and(
        eq(memberships.campaignId, p.campaignId),
        eq(memberships.userId, req.usuario!.id),
        eq(memberships.status, "ativo"),
      ))
      .limit(1).all();
    if (!vinculo || vinculo.role !== "mestre") { revogado = true; return; }
    const [atual] = tx.select().from(characters).where(eq(characters.id, p.id)).limit(1).all();
    if (!atual || atual.campaignId !== p.campaignId) { sumiu = true; return; }
    const dados = (atual.data ?? {}) as Record<string, unknown>;
    const { dados: novosDados, estado } = aplicarBonusPontos(dados, delta, {
      motivo: body.data.motivo,
      autorId: req.usuario!.id,
      autorNome,
    });
    tx.update(characters).set({ data: novosDados, updatedAt: agora }).where(eq(characters.id, p.id)).run();
    resposta = { ok: true, pontos: { bonus: estado.bonus, selado: estado.selo !== null, historico: estado.historico } };
  });
  if (sumiu) {
    res.status(404).json({ erro: "Personagem não encontrado" });
    return;
  }
  if (revogado) {
    res.status(403).json({ erro: "Apenas o mestre pode conceder ou remover pontos" });
    return;
  }

  await audit(req, "personagem.pontos", { characterId: p.id, acao: body.data.acao, quantidade: body.data.quantidade, motivo: body.data.motivo });
  emitirCampanha(p.campaignId, "personagens:atualizados", { characterId: p.id });
  res.json(resposta);
});
