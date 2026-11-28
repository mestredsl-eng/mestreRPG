// Internet pública 1.1.2 (#365 — fatia W3-ESCRITA): criação/edição/
// publicação/arquivo de sites e páginas + leituras autenticadas de
// rascunho. Contrato: docs/CONTRATO-ESCRITA-SITES-PAGINAS-365.md
// (aprovado INTERMEDIÁRIO @ c326c55, endurecido até ce83fd8).
//
// Dois atores, fail-closed:
//  - personagem: contaAutorizadaPara em CADA request — revalida conta
//    ativa, titularidade atual (P7), membership e gate P5 cumulativo
//    (dispositivo + requisito de ficha) em TODA mutação, inclusive
//    rascunho. Sem bypass de mestre.
//  - mestre administrativo: mestreLeitorDaCampanha — SOMENTE
//    arquivar/restaurar site/página; nunca cria, nunca edita
//    metadados, nunca reescreve conteúdo (D14).
//
// Auditoria D3 atômica: mutação + INSERT em audit_logs na MESMA
// transação — o helper audit() best-effort não satisfaz o contrato.
// Detalhe nunca carrega corpo/snapshot (sem rollback oculto).
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  auditLogs, characters, internetAccounts, internetContacts,
  internetConversations, internetDenuncias, internetPages,
  internetParticipantes, internetPublicacoes, internetSites, memberships,
  sheetVersions,
} from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePapel } from "../lib/permissoes.js";
import {
  contaAutorizadaPara, contasDoUsuario, contatoAceitoEntre,
  contatoBloqueadoEntre, mestreLeitorDaCampanha,
  titularAtualDaConta, type ContaAutorizada,
} from "../lib/conta-internet.js";
import { limiteUsuario } from "../lib/ratelimit.js";
import { emitirUsuario } from "../lib/io.js";
import { estruturaFichaSchema } from "../lib/ficha.js";
import { carregarRegrasSincrono, extrairEscolhas } from "../lib/regras.js";

const db = getDb();
export const internetEscritaRouter = Router({ mergeParams: true });
internetEscritaRouter.use(requireAuth);

/** Cota de mutações: 30/min por usuário, cota única entre todas as
 *  rotas de escrita (contrato — "31ª mutação no minuto → 429").
 *  Conta SOMENTE mutações cometidas: tentativas rejeitadas por
 *  validação/autorização (4xx) e rollbacks não consomem cota —
 *  implementação: peek antes da transação + consumo após o commit.
 *  Corridas concorrentes podem exceder a cota em +1, aceitável para
 *  limite de taxa. */
const MAX_MUTACOES = 30;
const JANELA_MUTACAO_MS = 60_000;
const janelasMutacao = new Map<string, { count: number; resetEm: number }>();
const timerMutacao = setInterval(() => {
  const agora = Date.now();
  for (const [k, v] of janelasMutacao) if (v.resetEm <= agora) janelasMutacao.delete(k);
}, 60_000);
timerMutacao.unref();

function janelaMutacao(usuarioId: string) {
  const agora = Date.now();
  let j = janelasMutacao.get(usuarioId);
  if (!j || j.resetEm <= agora) {
    j = { count: 0, resetEm: agora + JANELA_MUTACAO_MS };
    janelasMutacao.set(usuarioId, j);
  }
  return j;
}

/** true quando o usuário ainda pode cometer mutação nesta janela. */
function podeMutar(req: Request): boolean {
  return janelaMutacao(req.usuario!.id).count < MAX_MUTACOES;
}
function consumirMutacao(req: Request): void {
  janelaMutacao(req.usuario!.id).count += 1;
}
/** 429 com Retry-After quando a cota do minuto estourou. Retorna true
 *  se a resposta já foi enviada (caller deve dar return). */
function negaSemCota(req: Request, res: Response): boolean {
  if (podeMutar(req)) return false;
  const j = janelaMutacao(req.usuario!.id);
  res.setHeader("Retry-After", String(Math.max(1, Math.ceil((j.resetEm - Date.now()) / 1000))));
  erroHttp(res, 429, "Muitas requisições. Aguarde e tente novamente.");
  return true;
}
/** Leituras autenticadas da fatia de escrita (prévia/listagem do
 *  editor): mesmo teto da camada pública. */
const limiteLeituraEscrita = limiteUsuario({
  nome: "internet-escrita-leitura", janelaMs: 60_000, max: 60,
});

const campanhaId = (req: Request) => req.params.campaignId as string;

function erroHttp(res: Response, status: number, erro: string, detalhes?: unknown) {
  res.status(status).json(detalhes === undefined ? { erro } : { erro, detalhes });
}

// ---------- Serialização ----------

function siteSerializado(s: typeof internetSites.$inferSelect) {
  return {
    id: s.id, slug: s.slug, nome: s.nome, descricao: s.descricao,
    status: s.status, ownerContaId: s.ownerContaId,
    criadoEm: s.createdAt, atualizadoEm: s.updatedAt,
  };
}

function paginaSerializada(p: typeof internetPages.$inferSelect) {
  return {
    id: p.id, slug: p.slug, titulo: p.titulo, corpo: p.corpo,
    formato: p.formato, status: p.status, version: p.version,
    autorContaId: p.autorContaId, siteId: p.siteId,
    publicadoEm: p.publishedAt, criadoEm: p.createdAt, atualizadoEm: p.updatedAt,
  };
}

// ---------- Validação de entrada ----------

const SLUG_RE = /^[a-z0-9][a-z0-9._-]{1,62}$/;
const normalizarSlug = (s: string) => s.trim().toLowerCase();
const slugValido = (s: string) => SLUG_RE.test(s);

const siteCriarSchema = z.object({
  slug: z.string().trim().min(1).max(80),
  nome: z.string().trim().min(1).max(120),
  descricao: z.string().trim().max(1000).optional(),
  contaId: z.string().min(1).optional(),
}).strict();

const sitePatchSchema = z.object({
  nome: z.string().trim().min(1).max(120).optional(),
  descricao: z.string().trim().max(1000).nullable().optional(),
  slug: z.string().trim().min(1).max(80).optional(),
}).strict();

const paginaCriarSchema = z.object({
  slug: z.string().trim().min(1).max(80),
  titulo: z.string().trim().min(1).max(200),
  corpo: z.string().max(50_000),
  formato: z.enum(["texto", "markdown-subset"]).optional(),
  statusInicial: z.enum(["rascunho", "publicado"]).optional(),
}).strict();

const paginaPatchSchema = z.object({
  titulo: z.string().trim().min(1).max(200).optional(),
  corpo: z.string().max(50_000).optional(),
  formato: z.enum(["texto", "markdown-subset"]).optional(),
  expectedVersion: z.number().int().min(1),
}).strict();

const transicaoSchema = z.object({
  expectedVersion: z.number().int().min(1),
}).strict();

const SCRIPTS_PROIBIDOS = /javascript:|data:|file:|vbscript:/i;
const TAG_HTML = /<\/?[a-zA-Z!]/;

/** Whitelist markdown-subset do contrato: rejeita (400) em vez de
 *  sanitizar — HTML cru, schemes perigosos e headings fora de ##/###.
 *  Demais construções permitidas (parágrafos, listas -, ênfase, links
 *  http(s), fences) são inertes para o renderizador de texto. */
function formatoInvalido(corpo: string): string | null {
  if (TAG_HTML.test(corpo)) return "html_nao_permitido";
  if (SCRIPTS_PROIBIDOS.test(corpo)) return "esquema_nao_permitido";
  for (const linha of corpo.split("\n")) {
    if (/^#{1,6}\s/.test(linha) && !/^#{2,3}\s/.test(linha)) {
      return "heading_fora_do_subconjunto";
    }
  }
  return null;
}

// ---------- Auditoria atômica (D3) ----------

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function auditTx(
  tx: Tx, req: Request, cid: string, action: string, detail: Record<string, unknown>,
) {
  tx.insert(auditLogs).values({
    id: crypto.randomUUID(),
    actorId: req.usuario?.id ?? null,
    campaignId: cid,
    guildId: null,
    action,
    detail,
    createdAt: new Date(),
  }).run();
}

/** Revalidação TOCTOU dentro da transação (bloqueio DONO TÉCNICO):
 *  a checagem async anterior pode ficar stale se P7 transferir o
 *  personagem entre ela e o commit. Como a tx é síncrona na mesma
 *  conexão, estas leituras + a mutação formam uma seção crítica —
 *  P7 commita antes (visto aqui → aborta) ou depois (nossa mutação
 *  foi linearizada sob titularidade válida). Não inclui o gate P5
 *  (avaliação assíncrona de regras — permanece pré-tx). */
function titularNaTx(tx: Tx, contaId: string, userId: string, cid: string): boolean {
  const [conta] = tx.select({
    characterId: internetAccounts.characterId,
    status: internetAccounts.status,
  }).from(internetAccounts)
    .where(and(eq(internetAccounts.id, contaId), eq(internetAccounts.campaignId, cid)))
    .limit(1).all();
  if (!conta || conta.status !== "ativa") return false;
  const [pers] = tx.select({
    membershipId: characters.membershipId,
    status: characters.status,
  }).from(characters)
    .where(and(eq(characters.id, conta.characterId), eq(characters.campaignId, cid)))
    .limit(1).all();
  if (!pers || pers.status === "arquivado") return false;
  const [mu] = tx.select({ role: memberships.role }).from(memberships)
    .where(and(
      eq(memberships.campaignId, cid),
      eq(memberships.userId, userId),
      eq(memberships.status, "ativo"),
    )).limit(1).all();
  if (!mu || (mu.role !== "mestre" && mu.role !== "jogador")) return false;
  const [dono] = tx.select({ userId: memberships.userId, status: memberships.status })
    .from(memberships)
    .where(and(
      eq(memberships.id, pers.membershipId),
      eq(memberships.campaignId, cid),
    )).limit(1).all();
  return !!dono && dono.status === "ativo" && dono.userId === userId;
}

/** Site precisa continuar `ativo` no ponto da escrita — mutações
 *  subordinadas (página) abortam se o site foi arquivado na janela. */
function siteAtivoNaTx(tx: Tx, siteId: string): boolean {
  const [st] = tx.select({ status: internetSites.status }).from(internetSites)
    .where(eq(internetSites.id, siteId)).limit(1).all();
  return st?.status === "ativo";
}

// ---------- Resolução de atores ----------

interface AtorPersonagem { auth: ContaAutorizada; papel: "titular" }
interface AtorMestre { papel: "mestre" }
type Ator = AtorPersonagem | AtorMestre;

/** Resolve o ator sobre um recurso ancorado em `contaRefId` (owner do
 *  site ou autor da página). Personagem primeiro: se o requisitante é
 *  titular da conta, a ação é diegética (papel "titular") — mestre com
 *  conta própria opera como titular, nunca alterna implicitamente.
 *  Retorna null quando ninguém está autorizado. */
async function resolverAtor(
  req: Request, cid: string, contaRefId: string,
): Promise<Ator | null> {
  const auth = await contaAutorizadaPara(contaRefId, req.usuario!.id);
  if (auth) return { auth, papel: "titular" };
  if (await mestreLeitorDaCampanha(cid, req.usuario!.id)) return { papel: "mestre" };
  return null;
}

/** Conta do requisitante para criação de site: filtra as contas do
 *  usuário pelas que passam no gate completo (contaAutorizadaPara).
 *  `contaId` do body escolhe entre múltiplas; sem escolha e >1 → 400. */
async function resolverContaCriacao(
  req: Request, res: Response, cid: string, contaId?: string,
): Promise<ContaAutorizada | null> {
  const minhas = await contasDoUsuario(cid, req.usuario!.id);
  const elegiveis: ContaAutorizada[] = [];
  for (const conta of minhas) {
    const auth = await contaAutorizadaPara(conta.id, req.usuario!.id);
    if (auth) elegiveis.push(auth);
  }
  if (!elegiveis.length) {
    erroHttp(res, 403, "internet_sem_conta_ou_elegibilidade");
    return null;
  }
  if (contaId) {
    const escolhida = elegiveis.find((a) => a.conta.id === contaId);
    if (!escolhida) { erroHttp(res, 403, "Conta não autorizada"); return null; }
    return escolhida;
  }
  if (elegiveis.length > 1) {
    erroHttp(res, 400, "contaId_obrigatorio", { contas: elegiveis.map((a) => a.conta.id) });
    return null;
  }
  return elegiveis[0];
}

/** Variante não-responsiva de resolverContaCriacao para rotas em que
 *  "sem conta elegível" é um caminho válido (mestre publicando sem
 *  personagem). Devolve { auth } ou { falha } — quem chama decide o
 *  status HTTP. `contaId` explícito inválido é falha, nunca fallback. */
async function resolverContaCriacaoOpcional(
  req: Request, cid: string, contaId?: string,
): Promise<{ auth: ContaAutorizada | null; falha?: { status: number; erro: string; detalhes?: unknown } }> {
  const minhas = await contasDoUsuario(cid, req.usuario!.id);
  const elegiveis: ContaAutorizada[] = [];
  for (const conta of minhas) {
    const auth = await contaAutorizadaPara(conta.id, req.usuario!.id);
    if (auth) elegiveis.push(auth);
  }
  if (contaId) {
    const escolhida = elegiveis.find((a) => a.conta.id === contaId);
    if (!escolhida) return { auth: null, falha: { status: 403, erro: "Conta não autorizada" } };
    return { auth: escolhida };
  }
  if (!elegiveis.length) return { auth: null };
  if (elegiveis.length > 1) {
    return { auth: null, falha: { status: 400, erro: "contaId_obrigatorio", detalhes: { contas: elegiveis.map((a) => a.conta.id) } } };
  }
  return { auth: elegiveis[0] };
}

async function sitePorSlug(cid: string, slug: string) {
  const [site] = await db.select().from(internetSites)
    .where(and(eq(internetSites.campaignId, cid), eq(internetSites.slug, slug)))
    .limit(1);
  return site ?? null;
}

async function paginaPorSlug(siteId: string, cid: string, pageSlug: string) {
  const [pagina] = await db.select().from(internetPages)
    .where(and(
      eq(internetPages.siteId, siteId),
      eq(internetPages.campaignId, cid),
      eq(internetPages.slug, pageSlug),
    )).limit(1);
  return pagina ?? null;
}

// ---------- Sites ----------

/** POST /sites — criar site. Ator: personagem com conta elegível
 *  (gate P5 revalidado por contaAutorizadaPara). ownerContaId SEMPRE =
 *  conta do requisitante — campos forjados no body caem no strict. */
internetEscritaRouter.post("/sites", requirePapel("mestre", "jogador"), async (req, res) => {
  const cid = campanhaId(req);
  const body = siteCriarSchema.safeParse(req.body);
  if (!body.success) { erroHttp(res, 400, "Dados inválidos", { detalhes: body.error.issues }); return; }

  const slug = normalizarSlug(body.data.slug);
  if (!slugValido(slug)) { erroHttp(res, 400, "slug_invalido"); return; }

  const auth = await resolverContaCriacao(req, res, cid, body.data.contaId);
  if (!auth) return;

  const agora = new Date();
  const id = crypto.randomUUID();
  if (negaSemCota(req, res)) return;
  let falhaTitular = false;
  try {
    db.transaction((tx) => {
      if (!titularNaTx(tx, auth.conta.id, req.usuario!.id, cid)) { falhaTitular = true; return; }
      tx.insert(internetSites).values({
        id, campaignId: cid, slug,
        nome: body.data.nome, descricao: body.data.descricao ?? null,
        ownerContaId: auth.conta.id, status: "ativo",
        createdAt: agora, updatedAt: agora,
      }).run();
      auditTx(tx, req, cid, "internet.site_criado", {
        siteId: id, slug, ownerContaId: auth.conta.id,
        contaId: auth.conta.id, characterId: auth.personagem.id, papel: "titular",
      });
    });
  } catch (e) {
    if (String(e).includes("UNIQUE")) { erroHttp(res, 409, "slug_em_uso"); return; }
    throw e;
  }
  if (falhaTitular) { erroHttp(res, 403, "Conta não autorizada"); return; }
  consumirMutacao(req);
  const site = await sitePorSlug(cid, slug);
  res.status(201).json({ ok: true, site: site ? siteSerializado(site) : null });
});

/** GET /sites/meus — sites das contas autorizadas do requisitante
 *  (qualquer status — o dono precisa ver os próprios arquivados). */
internetEscritaRouter.get("/sites/meus", requirePapel("mestre", "jogador"), limiteLeituraEscrita, async (req, res) => {
  const cid = campanhaId(req);
  const minhas = await contasDoUsuario(cid, req.usuario!.id);
  const contaIds: string[] = [];
  for (const conta of minhas) {
    if (await contaAutorizadaPara(conta.id, req.usuario!.id)) contaIds.push(conta.id);
  }
  if (!contaIds.length) { res.json({ ok: true, sites: [] }); return; }

  const sites = await db.select().from(internetSites)
    .where(and(eq(internetSites.campaignId, cid), inArray(internetSites.ownerContaId, contaIds)))
    .orderBy(internetSites.createdAt);

  const contagens = sites.length
    ? await db.select({ siteId: internetPages.siteId, n: sql<number>`count(*)` }).from(internetPages)
        .where(and(inArray(internetPages.siteId, sites.map((s) => s.id)), eq(internetPages.status, "publicado")))
        .groupBy(internetPages.siteId)
    : [];
  const porSite = new Map(contagens.map((c) => [c.siteId, Number(c.n)]));

  res.json({
    ok: true,
    sites: sites.map((s) => ({
      ...siteSerializado(s),
      paginasPublicadas: porSite.get(s.id) ?? 0,
    })),
  });
});

/** PATCH /sites/:slug — metadados. Somente o dono como ator
 *  personagem; mestre administrativo NÃO edita metadados (403).
 *  Site arquivado → 409 (restaurar primeiro). */
internetEscritaRouter.patch("/sites/:slug", requirePapel("mestre", "jogador"), async (req, res) => {
  const cid = campanhaId(req);
  const body = sitePatchSchema.safeParse(req.body);
  if (!body.success) { erroHttp(res, 400, "Dados inválidos", { detalhes: body.error.issues }); return; }
  const campos = Object.keys(body.data).filter(
    (k) => body.data[k as keyof typeof body.data] !== undefined,
  );
  if (!campos.length) { erroHttp(res, 400, "Nada para atualizar"); return; }

  const site = await sitePorSlug(cid, req.params.slug);
  if (!site) { erroHttp(res, 404, "Site não encontrado"); return; }
  if (site.status !== "ativo") { erroHttp(res, 409, "estado_invalido"); return; }

  // Somente titular da conta dona — contaAutorizadaPara já cobre
  // titularidade atual (P7), conta ativa e gate P5. Mestre não edita.
  const auth = await contaAutorizadaPara(site.ownerContaId, req.usuario!.id);
  if (!auth) { erroHttp(res, 403, "Conta não autorizada"); return; }

  let novoSlug = site.slug;
  if (body.data.slug !== undefined) {
    novoSlug = normalizarSlug(body.data.slug);
    if (!slugValido(novoSlug)) { erroHttp(res, 400, "slug_invalido"); return; }
    if (novoSlug !== site.slug) {
      const [conflito] = await db.select({ id: internetSites.id }).from(internetSites)
        .where(and(eq(internetSites.campaignId, cid), eq(internetSites.slug, novoSlug)))
        .limit(1);
      if (conflito) { erroHttp(res, 409, "slug_em_uso"); return; }
    }
  }

  const camposAlterados = campos
    .map((k) => (k === "slug" ? "slug" : k))
    .filter((k) => {
      const atual = k === "slug" ? site.slug : (site as Record<string, unknown>)[k];
      const novo = k === "slug" ? novoSlug : body.data[k as "nome" | "descricao"];
      return atual !== novo;
    });
  if (!camposAlterados.length) {
    // PATCH idempotente: mesmos valores → sem version/audit/cota
    res.json({ ok: true, site: siteSerializado(site) });
    return;
  }

  const agora = new Date();
  if (negaSemCota(req, res)) return;
  let falhaTitular = false;
  let falhaSite = false;
  try {
    db.transaction((tx) => {
      if (!titularNaTx(tx, site.ownerContaId, req.usuario!.id, cid)) { falhaTitular = true; return; }
      if (!siteAtivoNaTx(tx, site.id)) { falhaSite = true; return; }
      tx.update(internetSites).set({
        slug: novoSlug,
        nome: body.data.nome ?? site.nome,
        descricao: body.data.descricao === undefined ? site.descricao : body.data.descricao,
        updatedAt: agora,
      }).where(eq(internetSites.id, site.id)).run();
      auditTx(tx, req, cid, "internet.site_atualizado", {
        siteId: site.id, slug: site.slug, novoSlug,
        ownerContaId: site.ownerContaId, camposAlterados, papel: "titular",
      });
    });
  } catch (e) {
    if (String(e).includes("UNIQUE")) { erroHttp(res, 409, "slug_em_uso"); return; }
    throw e;
  }
  if (falhaTitular) { erroHttp(res, 403, "Conta não autorizada"); return; }
  if (falhaSite) { erroHttp(res, 409, "estado_invalido"); return; }
  consumirMutacao(req);
  const atualizado = await sitePorSlug(cid, novoSlug);
  res.json({ ok: true, site: atualizado ? siteSerializado(atualizado) : null });
});

/** POST /sites/:slug/arquivar|restaurar — titular (gate P5) OU mestre
 *  administrativo (sem conta, sem gate). Nunca edita conteúdo. */
async function transicaoSite(req: Request, res: Response, destino: "arquivado" | "ativo") {
  const cid = campanhaId(req);
  const site = await sitePorSlug(cid, req.params.slug);
  if (!site) { erroHttp(res, 404, "Site não encontrado"); return; }

  const ator = await resolverAtor(req, cid, site.ownerContaId);
  if (!ator) {
    // não-dono/não-mestre: 403 (site é público por D2 — 404 não
    // agregaria sigilo, mas a negação de escrita é explícita)
    erroHttp(res, 403, "Conta não autorizada");
    return;
  }

  const origem = site.status === "arquivado" ? "arquivado" : "ativo";
  const alvo = destino;
  if (origem === alvo) { erroHttp(res, 409, "estado_invalido"); return; }

  const agora = new Date();
  const acao = destino === "arquivado" ? "internet.site_arquivado" : "internet.site_restaurado";
  if (negaSemCota(req, res)) return;
  let corrida = false;
  let falhaTitular = false;
  db.transaction((tx) => {
    if (ator.papel === "titular" && !titularNaTx(tx, site.ownerContaId, req.usuario!.id, cid)) {
      falhaTitular = true; return;
    }
    const upd = tx.update(internetSites)
      .set({ status: destino, updatedAt: agora })
      .where(and(eq(internetSites.id, site.id), eq(internetSites.status, origem)))
      .returning({ id: internetSites.id }).all();
    if (!upd.length) { corrida = true; return; }
    auditTx(tx, req, cid, acao, {
      siteId: site.id, slug: site.slug, de: origem, para: destino,
      ownerContaId: site.ownerContaId, papel: ator.papel,
      ...(ator.papel === "titular" ? { contaId: ator.auth.conta.id } : {}),
    });
  });
  if (falhaTitular) { erroHttp(res, 403, "Conta não autorizada"); return; }
  if (corrida) { erroHttp(res, 409, "estado_invalido"); return; }
  consumirMutacao(req);
  const atualizado = await sitePorSlug(cid, req.params.slug);
  res.json({ ok: true, site: atualizado ? siteSerializado(atualizado) : null });
}

internetEscritaRouter.post("/sites/:slug/arquivar", requirePapel("mestre", "jogador"),
  (req, res) => transicaoSite(req, res, "arquivado"));
internetEscritaRouter.post("/sites/:slug/restaurar", requirePapel("mestre", "jogador"),
  (req, res) => transicaoSite(req, res, "ativo"));

// ---------- Páginas ----------

/** POST /sites/:slug/paginas — criar página. SITE-12: somente o dono
 *  do site cria páginas no próprio site; não-dono → 403. Ator sempre
 *  personagem (mestre administrativo não cria conteúdo). Toda criação
 *  — inclusive rascunho — exige gate P5 via contaAutorizadaPara. */
internetEscritaRouter.post("/sites/:slug/paginas", requirePapel("mestre", "jogador"), async (req, res) => {
  const cid = campanhaId(req);
  const site = await sitePorSlug(cid, req.params.slug);
  if (!site) { erroHttp(res, 404, "Site não encontrado"); return; }

  const body = paginaCriarSchema.safeParse(req.body);
  if (!body.success) { erroHttp(res, 400, "Dados inválidos", { detalhes: body.error.issues }); return; }

  const slug = normalizarSlug(body.data.slug);
  if (!slugValido(slug)) { erroHttp(res, 400, "slug_invalido"); return; }
  const formato = body.data.formato ?? "texto";
  if (formato === "markdown-subset") {
    const invalido = formatoInvalido(body.data.corpo);
    if (invalido) { erroHttp(res, 400, "formato_invalido", { regra: invalido }); return; }
  }
  const statusInicial = body.data.statusInicial ?? "rascunho";

  // SITE-12 + gate P5: contaAutorizadaPara(site.ownerContaId) só passa
  // para o titular atual com gate elegível — não-dono, ex-titular P7 e
  // gate revogado caem todos aqui (403).
  const auth = await contaAutorizadaPara(site.ownerContaId, req.usuario!.id);
  if (!auth) { erroHttp(res, 403, "Conta não autorizada"); return; }
  // status do site só após autorização — 409 antes entregaria
  // "site arquivado" a quem não é dono
  if (site.status !== "ativo") { erroHttp(res, 409, "estado_invalido"); return; }

  const [duplicada] = await db.select({ id: internetPages.id }).from(internetPages)
    .where(and(eq(internetPages.siteId, site.id), eq(internetPages.slug, slug)))
    .limit(1);
  if (duplicada) { erroHttp(res, 409, "slug_em_uso"); return; }

  const agora = new Date();
  const id = crypto.randomUUID();
  if (negaSemCota(req, res)) return;
  let falhaTitular = false;
  let falhaSite = false;
  try {
    db.transaction((tx) => {
      if (!titularNaTx(tx, site.ownerContaId, req.usuario!.id, cid)) { falhaTitular = true; return; }
      if (!siteAtivoNaTx(tx, site.id)) { falhaSite = true; return; }
      tx.insert(internetPages).values({
        id, siteId: site.id, campaignId: cid, slug,
        titulo: body.data.titulo, corpo: body.data.corpo, formato,
        status: statusInicial, version: 1,
        autorContaId: site.ownerContaId,
        publishedAt: statusInicial === "publicado" ? agora : null,
        createdAt: agora, updatedAt: agora,
      }).run();
      auditTx(tx, req, cid, "internet.pagina_criada", {
        pageId: id, siteId: site.id, slug, siteSlug: site.slug,
        autorContaId: site.ownerContaId, ownerContaId: site.ownerContaId,
        version: 1, status: statusInicial, papel: "titular",
      });
    });
  } catch (e) {
    if (String(e).includes("UNIQUE")) { erroHttp(res, 409, "slug_em_uso"); return; }
    throw e;
  }
  if (falhaTitular) { erroHttp(res, 403, "Conta não autorizada"); return; }
  if (falhaSite) { erroHttp(res, 409, "estado_invalido"); return; }
  consumirMutacao(req);
  const criada = await paginaPorSlug(site.id, cid, slug);
  res.status(201).json({ ok: true, pagina: criada ? paginaSerializada(criada) : null });
});

/** PATCH /sites/:slug/paginas/:pageSlug — editar conteúdo.
 *  expectedVersion obrigatório; somente o autor; 404 uniforme para
 *  não-autor/não-mestre; mestre recebe 403 (nunca edita — D14). */
internetEscritaRouter.patch("/sites/:slug/paginas/:pageSlug", requirePapel("mestre", "jogador"), async (req, res) => {
  const cid = campanhaId(req);
  const site = await sitePorSlug(cid, req.params.slug);
  if (!site) { erroHttp(res, 404, "Site não encontrado"); return; }
  const pagina = await paginaPorSlug(site.id, cid, req.params.pageSlug);
  if (!pagina) { erroHttp(res, 404, "Página não encontrada"); return; }

  // Ator ANTES do body: validar payload cedo demais criaria oráculo —
  // página existente + body inválido → 400 vs inexistente → 404
  // distinguiria existência de rascunho para qualquer autenticado.
  const auth = await contaAutorizadaPara(pagina.autorContaId, req.usuario!.id);
  if (!auth) {
    if (await titularAtualDaConta(pagina.autorContaId, req.usuario!.id)) {
      // titular sem gate P5 (dispositivo revogado etc.) → negação honesta
      erroHttp(res, 403, "gate_internet");
    } else if (await mestreLeitorDaCampanha(cid, req.usuario!.id)) {
      erroHttp(res, 403, "moderacao_apenas");
    } else {
      // 404 uniforme — existência de rascunho não vaza
      erroHttp(res, 404, "Página não encontrada");
    }
    return;
  }

  const body = paginaPatchSchema.safeParse(req.body);
  if (!body.success) { erroHttp(res, 400, "Dados inválidos", { detalhes: body.error.issues }); return; }
  const campos = (["titulo", "corpo", "formato"] as const).filter(
    (k) => body.data[k] !== undefined,
  );
  if (!campos.length) { erroHttp(res, 400, "Nada para atualizar"); return; }

  if (site.status !== "ativo") { erroHttp(res, 409, "estado_invalido"); return; }
  if (pagina.status === "arquivado") { erroHttp(res, 409, "estado_invalido"); return; }
  if (body.data.expectedVersion !== pagina.version) {
    erroHttp(res, 409, "versao_desatualizada", { versionAtual: pagina.version });
    return;
  }

  const novoFormato = body.data.formato ?? pagina.formato;
  const novoCorpo = body.data.corpo ?? pagina.corpo;
  if (novoFormato === "markdown-subset" && (body.data.corpo !== undefined || body.data.formato !== undefined)) {
    const invalido = formatoInvalido(novoCorpo);
    if (invalido) { erroHttp(res, 400, "formato_invalido", { regra: invalido }); return; }
  }

  const camposAlterados = campos.filter((k) => {
    const atual = k === "titulo" ? pagina.titulo : k === "corpo" ? pagina.corpo : pagina.formato;
    const novo = k === "titulo" ? body.data.titulo : k === "corpo" ? body.data.corpo : novoFormato;
    return atual !== novo;
  });
  if (!camposAlterados.length) {
    // PATCH idempotente sem mudança real: não incrementa version nem
    // grava audit — resposta reflete o estado atual.
    res.json({ ok: true, pagina: paginaSerializada(pagina) });
    return;
  }

  const novaVersion = pagina.version + 1;
  const agora = new Date();
  if (negaSemCota(req, res)) return;
  let corrida = false;
  let falhaTitular = false;
  let falhaSite = false;
  db.transaction((tx) => {
    if (!titularNaTx(tx, pagina.autorContaId, req.usuario!.id, cid)) { falhaTitular = true; return; }
    if (!siteAtivoNaTx(tx, site.id)) { falhaSite = true; return; }
    const upd = tx.update(internetPages).set({
      titulo: body.data.titulo ?? pagina.titulo,
      corpo: novoCorpo,
      formato: novoFormato,
      version: novaVersion,
      updatedAt: agora,
    }).where(and(eq(internetPages.id, pagina.id), eq(internetPages.version, pagina.version)))
      .returning({ id: internetPages.id }).all();
    if (!upd.length) { corrida = true; return; }
    auditTx(tx, req, cid, "internet.pagina_editada", {
      pageId: pagina.id, siteId: site.id, siteSlug: site.slug,
      autorContaId: pagina.autorContaId, version: novaVersion,
      camposAlterados, papel: "titular",
    });
  });
  if (falhaTitular) { erroHttp(res, 403, "Conta não autorizada"); return; }
  if (falhaSite) { erroHttp(res, 409, "estado_invalido"); return; }
  if (corrida) {
    const atual = await paginaPorSlug(site.id, cid, req.params.pageSlug);
    erroHttp(res, 409, "versao_desatualizada", { versionAtual: atual?.version ?? pagina.version });
    return;
  }
  consumirMutacao(req);
  const atualizada = await paginaPorSlug(site.id, cid, req.params.pageSlug);
  res.json({ ok: true, pagina: atualizada ? paginaSerializada(atualizada) : null });
});

// ---------- Transições de status de página ----------

type Transicao = "publicar" | "retirar" | "arquivar" | "restaurar";

const TRANSICOES: Record<Transicao, {
  acao: string;
  permitidoMestre: boolean;
  de: string[];
  para: (p: typeof internetPages.$inferSelect) => string;
}> = {
  publicar: {
    acao: "internet.pagina_status",
    permitidoMestre: false,
    de: ["rascunho", "retirado"],
    para: (p) => "publicado",
  },
  retirar: {
    acao: "internet.pagina_status",
    permitidoMestre: false,
    de: ["publicado"],
    para: () => "retirado",
  },
  arquivar: {
    acao: "internet.pagina_arquivada",
    permitidoMestre: true,
    de: ["rascunho", "publicado", "retirado"],
    para: () => "arquivado",
  },
  restaurar: {
    acao: "internet.pagina_restaurada",
    permitidoMestre: true,
    de: ["arquivado"],
    para: (p) => (p.publishedAt ? "publicado" : "rascunho"),
  },
};

/** POST /sites/:slug/paginas/:pageSlug/{publicar|retirar|arquivar|restaurar}
 *  — transição com expectedVersion obrigatório, version+1 uma única
 *  vez e auditoria atômica. publicar/retirar: somente autor (papel
 *  titular). arquivar/restaurar: autor OU mestre administrativo. */
async function transicaoPagina(req: Request, res: Response, transicao: Transicao) {
  const cid = campanhaId(req);
  const regra = TRANSICOES[transicao];

  const body = transicaoSchema.safeParse(req.body);
  if (!body.success) { erroHttp(res, 400, "Dados inválidos", { detalhes: body.error.issues }); return; }

  const site = await sitePorSlug(cid, req.params.slug);
  if (!site) { erroHttp(res, 404, "Site não encontrado"); return; }
  const pagina = await paginaPorSlug(site.id, cid, req.params.pageSlug);
  if (!pagina) { erroHttp(res, 404, "Página não encontrada"); return; }

  const ator = await resolverAtor(req, cid, pagina.autorContaId);
  if (!ator) {
    // titular sem gate → 403 honesto; demais → 404 uniforme
    if (await titularAtualDaConta(pagina.autorContaId, req.usuario!.id)) {
      erroHttp(res, 403, "gate_internet");
    } else {
      erroHttp(res, 404, "Página não encontrada");
    }
    return;
  }
  if (ator.papel === "mestre" && !regra.permitidoMestre) {
    erroHttp(res, 403, "moderacao_apenas");
    return;
  }

  if (site.status !== "ativo") { erroHttp(res, 409, "estado_invalido"); return; }
  if (!regra.de.includes(pagina.status)) { erroHttp(res, 409, "estado_invalido"); return; }
  if (body.data.expectedVersion !== pagina.version) {
    erroHttp(res, 409, "versao_desatualizada", { versionAtual: pagina.version });
    return;
  }

  const de = pagina.status;
  const para = regra.para(pagina);
  const novaVersion = pagina.version + 1;
  const agora = new Date();
  // publishedAt registra a PRIMEIRA publicação; re-publicar mantém.
  const publishedAt = para === "publicado" && !pagina.publishedAt ? agora : pagina.publishedAt;

  if (negaSemCota(req, res)) return;
  let corrida = false;
  let falhaTitular = false;
  let falhaSite = false;
  db.transaction((tx) => {
    if (ator.papel === "titular" && !titularNaTx(tx, pagina.autorContaId, req.usuario!.id, cid)) {
      falhaTitular = true; return;
    }
    if (!siteAtivoNaTx(tx, site.id)) { falhaSite = true; return; }
    const upd = tx.update(internetPages).set({
      status: para, version: novaVersion, publishedAt, updatedAt: agora,
    }).where(and(eq(internetPages.id, pagina.id), eq(internetPages.version, pagina.version)))
      .returning({ id: internetPages.id }).all();
    if (!upd.length) { corrida = true; return; }
    auditTx(tx, req, cid, regra.acao, {
      pageId: pagina.id, siteId: site.id, siteSlug: site.slug,
      autorContaId: pagina.autorContaId, de, para, version: novaVersion,
      papel: ator.papel,
      ...(ator.papel === "titular" ? { contaId: ator.auth.conta.id } : {}),
    });
  });
  if (falhaTitular) { erroHttp(res, 403, "Conta não autorizada"); return; }
  if (falhaSite) { erroHttp(res, 409, "estado_invalido"); return; }
  if (corrida) {
    const atual = await paginaPorSlug(site.id, cid, req.params.pageSlug);
    erroHttp(res, 409, "versao_desatualizada", { versionAtual: atual?.version ?? pagina.version });
    return;
  }
  consumirMutacao(req);

  const atualizada = await paginaPorSlug(site.id, cid, req.params.pageSlug);
  res.json({ ok: true, pagina: atualizada ? paginaSerializada(atualizada) : null });
}

for (const t of ["publicar", "retirar", "arquivar", "restaurar"] as const) {
  internetEscritaRouter.post(
    `/sites/:slug/paginas/:pageSlug/${t}`,
    requirePapel("mestre", "jogador"),
    (req, res) => transicaoPagina(req, res, t),
  );
}

// ---------- Leituras autenticadas (prévia do editor) ----------

/** GET /sites/:slug/paginas — listagem autenticada com recorte por
 *  papel: não-privilegiado vê só `publicado`; autor vê as próprias em
 *  qualquer status; mestre vê todas (moderação). Site precisa estar
 *  ativo (mesma fronteira do read slice). */
internetEscritaRouter.get("/sites/:slug/paginas", requirePapel("mestre", "jogador"), limiteLeituraEscrita, async (req, res) => {
  const cid = campanhaId(req);
  const site = await sitePorSlug(cid, req.params.slug);
  if (!site || site.status !== "ativo") { erroHttp(res, 404, "Site não encontrado"); return; }

  // Leitor precisa de ≥1 conta autorizada OU papel mestre.
  const minhas = await contasDoUsuario(cid, req.usuario!.id);
  const contaIds: string[] = [];
  for (const conta of minhas) {
    if (await contaAutorizadaPara(conta.id, req.usuario!.id)) contaIds.push(conta.id);
  }
  const ehMestre = await mestreLeitorDaCampanha(cid, req.usuario!.id);
  if (!contaIds.length && !ehMestre) {
    erroHttp(res, 403, "Sem acesso à camada pública da Internet");
    return;
  }

  const todas = await db.select().from(internetPages)
    .where(eq(internetPages.siteId, site.id))
    .orderBy(internetPages.titulo, internetPages.id);

  const visiveis = ehMestre
    ? todas
    : todas.filter((p) => p.status === "publicado" || contaIds.includes(p.autorContaId));

  res.json({
    ok: true,
    paginas: visiveis.map((p) => ({
      slug: p.slug, titulo: p.titulo, status: p.status,
      version: p.version, formato: p.formato,
      publicadoEm: p.publishedAt, atualizadoEm: p.updatedAt,
      // UUID interno da conta só para o próprio autor ou mestre —
      // páginas publicadas de sites alheios expõem só o handle público
      autorContaId: (ehMestre || contaIds.includes(p.autorContaId)) ? p.autorContaId : null,
    })),
  });
});

// ---------- Publicações (W4/W5/W8-subset — contrato CONTRATO-W4W5) ----------
//
// `internet_publicacoes`: noticias e post_perfil nesta fatia. Autoria
// server-side (autorContaId/origem/publicadoEm nunca do body); anônimo
// rejeitado (DP-6: só classificado/anuncio — W6/W7); origem='sistema'
// (notícia de morte) é somente-leitura para todos.

const publicacaoCriarSchema = z.object({
  tipo: z.enum(["noticia", "post_perfil", "anuncio", "classificado"]),
  titulo: z.string().trim().min(1).max(200),
  corpo: z.string().max(50_000),
  formato: z.enum(["texto", "markdown-subset"]).optional(),
  // W8: declaração de visibilidade é OBRIGATÓRIA já na criação.
  visibilidade: z.enum(["campanha", "contatos"]),
  // DP-6: 'anonimo' só é aceito para anuncio|classificado — os demais
  // tipos rejeitam com 400 (o enum aceita; a regra de tipo é abaixo).
  autorModo: z.enum(["identificado", "pseudonimo", "anonimo"]).optional(),
  // Charset do handle (internet.ts): letras/dígitos/._- — sem espaços
  // nem pontuação livre; caixa preservada para exibição do pseudônimo.
  pseudoNome: z.string().trim().min(2).max(60).regex(/^[A-Za-z0-9._-]+$/, "pseudoNome inválido").optional(),
  // D11: validade opcional — só anuncio|classificado; estado expirado
  // é derivado na leitura (nunca job).
  expiresAt: z.string().datetime({ offset: true }).optional(),
  contaId: z.string().min(1).optional(),
  // statusInicial removido: POST sempre cria 'rascunho' — publicar é
  // transição posterior via PATCH + expectedVersion (D3).
}).strict();

const publicacaoPatchSchema = z.object({
  titulo: z.string().trim().min(1).max(200).optional(),
  corpo: z.string().max(50_000).optional(),
  formato: z.enum(["texto", "markdown-subset"]).optional(),
  visibilidade: z.enum(["campanha", "contatos"]).optional(),
  autorModo: z.enum(["identificado", "pseudonimo", "anonimo"]).optional(),
  pseudoNome: z.string().trim().min(2).max(60).regex(/^[A-Za-z0-9._-]+$/, "pseudoNome inválido").nullable().optional(),
  expiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  status: z.enum(["rascunho", "publicado"]).optional(),
  expectedVersion: z.number().int().min(1),
}).strict();

const denunciaSchema = z.object({
  motivo: z.enum(["spam", "ofensa", "ilegal", "outro"]),
  // DP-3: flag de gravidade aceita por compatibilidade, mas a
  // elevação a `denuncia_grave` deriva SOMENTE de motivo='ilegal'
  // (mapeamento seguro — motivos benignos nunca auto-removem).
  denunciaGrave: z.boolean().optional(),
}).strict();

/** Gate D8 (NEWS-04/05): personagem-jogador só publica `noticia` se o
 *  ruleset ativo da campanha validar `profissao:jornalista` — valor em
 *  campo regraKind='profissao' resolvido por extrairEscolhas contra a
 *  definição ativa (nunca label/body do cliente). Fail-closed: ruleset
 *  ausente, estrutura inválida ou elemento removido ⇒ sem gate.
 *  Mestre publica independentemente (decisão C) — o bypass é do
 *  chamador, não desta função. `post_perfil` não exige (conteúdo de
 *  perfil, não matéria jornalística). */
async function ehJornalistaD8(cid: string, characterId: string): Promise<boolean> {
  const [personagem] = await db.select().from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.campaignId, cid)))
    .limit(1);
  if (!personagem) return false;
  if (!personagem?.templateVersionId) return false;
  const [ver] = await db.select().from(sheetVersions)
    .where(eq(sheetVersions.id, personagem.templateVersionId)).limit(1);
  const parse = ver ? estruturaFichaSchema.safeParse(ver.structure) : null;
  if (!parse?.success) return false;
  const regras = carregarRegrasSincrono(db, cid);
  if (!regras) return false;
  const dados = (personagem.data ?? {}) as Record<string, unknown>;
  return extrairEscolhas(parse.data, dados, regras).some(
    (e) => e.selecionado && e.elemento?.kind === "profissao" && e.elemento.key === "jornalista",
  );
}

async function publicacaoPorId(cid: string, id: string) {
  const [p] = await db.select().from(internetPublicacoes)
    .where(and(eq(internetPublicacoes.id, id), eq(internetPublicacoes.campaignId, cid)))
    .limit(1);
  return p ?? null;
}

function publicacaoSerializada(p: typeof internetPublicacoes.$inferSelect) {
  return {
    id: p.id, tipo: p.tipo, titulo: p.titulo, corpo: p.corpo,
    formato: p.formato, status: p.status, visibilidade: p.visibilidade,
    autorModo: p.autorModo, pseudoNome: p.pseudoNome,
    autorContaId: p.autorContaId, origem: p.origem,
    fonteRef: p.fonteRef, personagemId: p.personagemId,
    publicadoEm: p.publicadoEm, expiresAt: p.expiresAt,
    retiradoEm: p.retiradoEm,
    retiradoMotivo: p.retiradoMotivo, version: p.version,
    criadoEm: p.createdAt, atualizadoEm: p.updatedAt,
  };
}

/** POST /publicacoes — criar notícia/post de perfil. Sempre nasce
 *  'rascunho' (publicar é PATCH + expectedVersion). Ator: conta
 *  elegível do requisitante (gate P5 via contaAutorizadaPara) ou
 *  mestre sem conta própria (autorContaId NULL — ex.: correção DP-9).
 *  D8: tipo='noticia' por jogador exige profissao:jornalista no
 *  ruleset ativo; mestre publica independente; post_perfil isento. */
internetEscritaRouter.post("/publicacoes", requirePapel("mestre", "jogador"), async (req, res) => {
  const cid = campanhaId(req);
  const body = publicacaoCriarSchema.safeParse(req.body);
  if (!body.success) { erroHttp(res, 400, "Dados inválidos", { detalhes: body.error.issues }); return; }
  const d = body.data;
  const formato = d.formato ?? "markdown-subset";
  const invalido = formato === "markdown-subset" ? formatoInvalido(d.corpo) : null;
  if (invalido) { erroHttp(res, 400, "formato_invalido", { motivo: invalido }); return; }
  const autorModo = d.autorModo ?? "identificado";
  // DP-6: anonimato só existe em anuncio|classificado — nos demais
  // tipos o servidor rejeita (a UI nem renderiza a opção).
  if (autorModo === "anonimo" && d.tipo !== "anuncio" && d.tipo !== "classificado") {
    erroHttp(res, 400, "anonimo_apenas_anuncio_ou_classificado"); return;
  }
  if (autorModo === "pseudonimo" && !d.pseudoNome) {
    erroHttp(res, 400, "pseudo_nome_obrigatorio"); return;
  }
  // D11: expiresAt só se aplica a anuncio|classificado.
  if (d.expiresAt && d.tipo !== "anuncio" && d.tipo !== "classificado") {
    erroHttp(res, 400, "expiresAt_apenas_anuncio_ou_classificado"); return;
  }

  const ehMestre = await mestreLeitorDaCampanha(cid, req.usuario!.id);
  // Personagem primeiro: se o requisitante tem conta elegível, publica
  // como titular dela (mesmo sendo mestre — decide C é sobre o papel
  // mestre SEM personagem, não bypass de conta).
  const resolucao = await resolverContaCriacaoOpcional(req, cid, d.contaId);
  if (resolucao.falha) { erroHttp(res, resolucao.falha.status, resolucao.falha.erro, { detalhes: resolucao.falha.detalhes }); return; }
  const auth = resolucao.auth;
  if (!auth && !ehMestre) { erroHttp(res, 403, "internet_sem_conta_ou_elegibilidade"); return; }
  if (auth && d.tipo === "noticia" && !ehMestre
    && !(await ehJornalistaD8(cid, auth.conta.characterId))) {
    erroHttp(res, 403, "profissao_jornalista_obrigatoria"); return;
  }

  const agora = new Date();
  const id = crypto.randomUUID();
  const status = "rascunho";
  if (negaSemCota(req, res)) return;
  let commitado = false;
  let falhaTitular = false;
  await db.transaction((tx) => {
    if (auth && !titularNaTx(tx, auth.conta.id, req.usuario!.id, cid)) { falhaTitular = true; return; }
    tx.insert(internetPublicacoes).values({
      id, campaignId: cid, tipo: d.tipo, titulo: d.titulo, corpo: d.corpo,
      formato, status, visibilidade: d.visibilidade,
      autorModo, pseudoNome: autorModo === "pseudonimo" ? d.pseudoNome! : null,
      autorContaId: auth?.conta.id ?? null, origem: "usuario",
      publicadoEm: null,
      expiresAt: d.expiresAt ? new Date(d.expiresAt) : null,
      createdAt: agora, updatedAt: agora,
    }).run();
    auditTx(tx, req, cid, "publicacao.criada", {
      publicacaoId: id, tipo: d.tipo, status, visibilidade: d.visibilidade,
      autorModo, contaId: auth?.conta.id ?? null,
    });
    commitado = true;
  });
  if (falhaTitular) { erroHttp(res, 403, "Titularidade da conta não confirmada"); return; }
  if (!commitado) { erroHttp(res, 500, "Falha ao criar publicação"); return; }
  consumirMutacao(req);
  const [pub] = await db.select().from(internetPublicacoes).where(eq(internetPublicacoes.id, id)).limit(1);
  res.status(201).json({ ok: true, publicacao: publicacaoSerializada(pub) });
});

/** PATCH /publicacoes/:id — editar conteúdo/visibilidade ou transitar
 *  rascunho↔publicado. Edição de conteúdo = titular da conta autora
 *  (mesma fronteira D14 do W3: mestre não reescreve conteúdo alheio —
 *  aqui recebe 404, anti-oráculo). retirado/removido são estados de
 *  moderação, nunca patcháveis pelo autor. */
internetEscritaRouter.patch("/publicacoes/:id", requirePapel("mestre", "jogador"), async (req, res) => {
  const cid = campanhaId(req);
  const pub = await publicacaoPorId(cid, req.params.id);
  // Inexistente / campanha errada / origem='sistema' → 404 uniforme
  // (a notícia de morte é imutável — não vaza que a linha é especial).
  if (!pub || pub.origem === "sistema" || pub.status === "removido") {
    erroHttp(res, 404, "Publicação não encontrada"); return;
  }
  const ehMestre = await mestreLeitorDaCampanha(cid, req.usuario!.id);
  // Titular da conta autora edita o próprio conteúdo (D14). Publicação
  // sem conta autora (origem='usuario', autorContaId NULL) só existe
  // quando criada pelo mestre — nesse caso o mestre edita; mestre
  // NUNCA reescreve conteúdo de conta alheia (404 anti-oráculo).
  const auth = pub.autorContaId
    ? await contaAutorizadaPara(pub.autorContaId, req.usuario!.id)
    : null;
  const atorMestreSemConta = !pub.autorContaId && ehMestre;
  if (!auth && !atorMestreSemConta) { erroHttp(res, 404, "Publicação não encontrada"); return; }
  // AD-08/DP-1: anúncio/classificado anônimo PUBLICADO é imutável —
  // nenhuma edição, troca de identidade ou transição de status.
  // (Rascunho anônimo continua editável até a publicação.)
  if (pub.autorModo === "anonimo" && pub.status === "publicado") {
    erroHttp(res, 403, "publicacao_anonima_imutavel"); return;
  }

  const body = publicacaoPatchSchema.safeParse(req.body);
  if (!body.success) { erroHttp(res, 400, "Dados inválidos", { detalhes: body.error.issues }); return; }
  const d = body.data;
  const corpoFinal = d.corpo ?? pub.corpo;
  const formatoFinal = d.formato ?? pub.formato;
  if (formatoFinal === "markdown-subset") {
    const invalido = formatoInvalido(corpoFinal);
    if (invalido) { erroHttp(res, 400, "formato_invalido", { motivo: invalido }); return; }
  }
  const modoFinal = d.autorModo ?? pub.autorModo;
  const pseudoFinal = d.pseudoNome === undefined ? pub.pseudoNome : d.pseudoNome;
  if (modoFinal === "pseudonimo" && !pseudoFinal) {
    erroHttp(res, 400, "pseudo_nome_obrigatorio"); return;
  }
  // DP-6/D11: anonimo e expiresAt só valem para anuncio|classificado
  // (tipo é imutável — a checagem é sempre contra pub.tipo).
  if (modoFinal === "anonimo" && pub.tipo !== "anuncio" && pub.tipo !== "classificado") {
    erroHttp(res, 400, "anonimo_apenas_anuncio_ou_classificado"); return;
  }
  const expiresFinal = d.expiresAt === undefined
    ? pub.expiresAt
    : d.expiresAt === null ? null : new Date(d.expiresAt);
  if (expiresFinal && pub.tipo !== "anuncio" && pub.tipo !== "classificado") {
    erroHttp(res, 400, "expiresAt_apenas_anuncio_ou_classificado"); return;
  }
  const statusFinal = d.status ?? pub.status;
  if (statusFinal !== "rascunho" && statusFinal !== "publicado") {
    erroHttp(res, 400, "status_invalido"); return;
  }
  // D8/NEWS-05: a transição para 'publicado' revalida
  // profissao:jornalista — regraset alterado após o rascunho fecha o
  // gate. Mestre (inclusive publicação sem conta) publica sempre.
  if (statusFinal === "publicado" && pub.status !== "publicado"
    && pub.tipo === "noticia" && auth && !ehMestre && pub.autorContaId) {
    const [contaAutor] = await db.select().from(internetAccounts)
      .where(eq(internetAccounts.id, pub.autorContaId)).limit(1);
    if (!contaAutor || !(await ehJornalistaD8(cid, contaAutor.characterId))) {
      erroHttp(res, 403, "profissao_jornalista_obrigatoria"); return;
    }
  }
  if (pub.status !== "rascunho" && pub.status !== "publicado") {
    erroHttp(res, 409, "publicacao_encerrada"); return;
  }
  const mudou =
    (d.titulo !== undefined && d.titulo !== pub.titulo) ||
    (d.corpo !== undefined && d.corpo !== pub.corpo) ||
    (d.formato !== undefined && d.formato !== pub.formato) ||
    (d.visibilidade !== undefined && d.visibilidade !== pub.visibilidade) ||
    (d.autorModo !== undefined && d.autorModo !== pub.autorModo) ||
    (d.pseudoNome !== undefined && pseudoFinal !== pub.pseudoNome) ||
    (d.expiresAt !== undefined && expiresFinal?.getTime() !== pub.expiresAt?.getTime()) ||
    (d.status !== undefined && d.status !== pub.status);
  if (!mudou) {
    res.json({ ok: true, publicacao: publicacaoSerializada(pub) });
    return;
  }

  const agora = new Date();
  if (negaSemCota(req, res)) return;
  let commitado = false;
  let falhaTitular = false;
  let conflitoVersao = false;
  await db.transaction((tx) => {
    if (auth && !titularNaTx(tx, pub.autorContaId!, req.usuario!.id, cid)) { falhaTitular = true; return; }
    const sets: Record<string, unknown> = {
      titulo: d.titulo ?? pub.titulo,
      corpo: corpoFinal,
      formato: formatoFinal,
      visibilidade: d.visibilidade ?? pub.visibilidade,
      autorModo: modoFinal,
      pseudoNome: modoFinal === "pseudonimo" ? pseudoFinal : null,
      expiresAt: expiresFinal,
      status: statusFinal,
      // publicadoEm = PRIMEIRA publicação (não reescreve ao republicar)
      publicadoEm: statusFinal === "publicado" && !pub.publicadoEm ? agora : pub.publicadoEm,
      version: pub.version + 1,
      updatedAt: agora,
    };
    const r = tx.update(internetPublicacoes).set(sets)
      .where(and(
        eq(internetPublicacoes.id, pub.id),
        eq(internetPublicacoes.version, d.expectedVersion),
      )).run();
    if (r.changes === 0) { conflitoVersao = true; return; }
    auditTx(tx, req, cid, "publicacao.editada", {
      publicacaoId: pub.id, version: pub.version + 1,
      campos: Object.keys(d).filter((k) => k !== "expectedVersion"),
    });
    commitado = true;
  });
  if (falhaTitular) { erroHttp(res, 403, "Titularidade da conta não confirmada"); return; }
  if (conflitoVersao) { erroHttp(res, 409, "Versão desatualizada — recarregue e tente novamente"); return; }
  if (!commitado) { erroHttp(res, 500, "Falha ao editar publicação"); return; }
  consumirMutacao(req);
  const [atualizada] = await db.select().from(internetPublicacoes)
    .where(eq(internetPublicacoes.id, pub.id)).limit(1);
  res.json({ ok: true, publicacao: publicacaoSerializada(atualizada) });
});

/** POST /publicacoes/:id/denunciar — denúncia de conta elegível.
 *  Limiar DP-3: ≥2 denúncias distintas OU 1 grave (motivo='ilegal')
 *  ⇒ remoção automática NA MESMA TX. Uma denúncia por par
 *  (publicação, conta) via UNIQUE. */
internetEscritaRouter.post("/publicacoes/:id/denunciar", requirePapel("mestre", "jogador"), async (req, res) => {
  const cid = campanhaId(req);
  const body = denunciaSchema.safeParse(req.body);
  if (!body.success) { erroHttp(res, 400, "Dados inválidos", { detalhes: body.error.issues }); return; }

  const pub = await publicacaoPorId(cid, req.params.id);
  if (!pub || pub.status !== "publicado" || pub.origem === "sistema" || !pub.autorContaId) {
    erroHttp(res, 404, "Publicação não encontrada"); return;
  }
  const minhas = await contasDoUsuario(cid, req.usuario!.id);
  const elegiveis: ContaAutorizada[] = [];
  for (const conta of minhas) {
    if (conta.id === pub.autorContaId) continue;
    const auth = await contaAutorizadaPara(conta.id, req.usuario!.id);
    if (auth) elegiveis.push(auth);
  }
  if (!elegiveis.length) { erroHttp(res, 403, "internet_sem_conta_ou_elegibilidade"); return; }

  // DP-2/visibilidade: só se denuncia o que se pode ler. 'contatos'
  // exige aresta aceita vigente com o autor, sem bloqueio P3.
  if (pub.visibilidade === "contatos") {
    let alcancavel = false;
    for (const e of elegiveis) {
      const aceito = await contatoAceitoEntre(db, cid, e.conta.id, pub.autorContaId);
      if (!aceito) continue;
      const bloqueado = await contatoBloqueadoEntre(db, cid, e.conta.id, pub.autorContaId);
      if (!bloqueado) { alcancavel = true; break; }
    }
    if (!alcancavel) { erroHttp(res, 404, "Publicação não encontrada"); return; }
  }
  const denunciante = elegiveis[0];
  // DP-3 mapeamento seguro: denuncia_grave deriva SOMENTE de
  // motivo='ilegal' — a flag do body nunca eleva motivo benigno.
  const grave = body.data.motivo === "ilegal" ? 1 : 0;
  const prazoContestacao = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const agora = new Date();
  const id = crypto.randomUUID();
  if (negaSemCota(req, res)) return;
  let commitado = false;
  let jaDenunciou = false;
  let removida = false;
  let falhaTitular = false;
  await db.transaction((tx) => {
    // Revalida titularidade do denunciante NA MESMA TX (TOCTOU).
    if (!titularNaTx(tx, denunciante.conta.id, req.usuario!.id, cid)) { falhaTitular = true; return; }
    const [atual] = tx.select().from(internetPublicacoes)
      .where(eq(internetPublicacoes.id, pub.id)).limit(1).all();
    if (!atual || atual.status !== "publicado") return;
    try {
      tx.insert(internetDenuncias).values({
        id, campaignId: cid, publicacaoId: pub.id,
        denuncianteContaId: denunciante.conta.id,
        motivo: body.data.motivo, denunciaGrave: grave,
        status: "aberta", prazoContestacaoEm: prazoContestacao,
        createdAt: agora, updatedAt: agora,
      }).run();
    } catch {
      jaDenunciou = true; return;
    }
    const abertas = atual.denunciaAberta + 1;
    const graves = atual.denunciaGrave + grave;
    const deveRemover = abertas >= 2 || graves >= 1;
    tx.update(internetPublicacoes).set({
      denunciaAberta: abertas,
      denunciaGrave: graves,
      ...(deveRemover ? {
        status: "removido", retiradoEm: agora, retiradoMotivo: "denuncia",
        version: atual.version + 1,
      } : {}),
      updatedAt: agora,
    }).where(eq(internetPublicacoes.id, pub.id)).run();
    if (deveRemover) {
      // DP-2: remoção automática abre janela de contestação de 7 dias
      // — as denúncias que causaram saem de 'aberta' para
      // 'auto_removida' com o prazo carimbado.
      tx.update(internetDenuncias).set({ status: "auto_removida", updatedAt: agora })
        .where(and(eq(internetDenuncias.publicacaoId, pub.id), eq(internetDenuncias.status, "aberta"))).run();
    }
    auditTx(tx, req, cid, "publicacao.denunciada", {
      publicacaoId: pub.id, denunciaId: id, motivo: body.data.motivo,
      denuncianteContaId: denunciante.conta.id, removida: deveRemover,
    });
    removida = deveRemover;
    commitado = true;
  });
  if (falhaTitular) { erroHttp(res, 403, "Titularidade da conta não confirmada"); return; }
  if (jaDenunciou) { erroHttp(res, 409, "denuncia_ja_registrada"); return; }
  if (!commitado) { erroHttp(res, 404, "Publicação não encontrada"); return; }
  consumirMutacao(req);
  res.status(201).json({ ok: true, denunciaId: id, removida });
});

/** POST /publicacoes/:id/contestar — DP-2: o AUTOR contesta a remoção
 *  automática por denúncias dentro de 7 dias do retiradoEm. Marca as
 *  denúncias 'auto_removida' como 'contestada' — a decisão final é do
 *  admin da plataforma (nunca do mestre da campanha). */
internetEscritaRouter.post("/publicacoes/:id/contestar", requirePapel("mestre", "jogador"), async (req, res) => {
  const cid = campanhaId(req);
  const pub = await publicacaoPorId(cid, req.params.id);
  if (!pub || pub.origem === "sistema" || pub.status !== "removido" || pub.retiradoMotivo !== "denuncia" || !pub.autorContaId) {
    erroHttp(res, 404, "Publicação não encontrada"); return;
  }
  const auth = await contaAutorizadaPara(pub.autorContaId, req.usuario!.id);
  if (!auth) { erroHttp(res, 404, "Publicação não encontrada"); return; }
  const agora = new Date();
  const limite = pub.retiradoEm ? pub.retiradoEm.getTime() + 7 * 24 * 60 * 60 * 1000 : 0;
  if (agora.getTime() > limite) { erroHttp(res, 409, "prazo_contestacao_expirado"); return; }
  if (negaSemCota(req, res)) return;
  let commitado = false;
  let falhaTitular = false;
  let nContestadas = 0;
  await db.transaction((tx) => {
    if (!titularNaTx(tx, pub.autorContaId!, req.usuario!.id, cid)) { falhaTitular = true; return; }
    const r = tx.update(internetDenuncias)
      .set({ status: "contestada", updatedAt: agora })
      .where(and(
        eq(internetDenuncias.publicacaoId, pub.id),
        eq(internetDenuncias.status, "auto_removida"),
      )).run();
    nContestadas = r.changes;
    if (nContestadas > 0) {
      auditTx(tx, req, cid, "publicacao.contestada", {
        publicacaoId: pub.id, denunciasContestadas: nContestadas,
      });
      commitado = true;
    }
  });
  if (falhaTitular) { erroHttp(res, 403, "Titularidade da conta não confirmada"); return; }
  if (!commitado) { erroHttp(res, 409, "nada_a_contestar"); return; }
  consumirMutacao(req);
  res.json({ ok: true, contestadas: nContestadas });
});


/** POST /publicacoes/:id/contatar — D9 (W6/W7): a ação "Contatar" do
 *  anúncio/classificado REUSA o fluxo de contatos existente — nunca
 *  cria chat paralelo (AD-11). Regras:
 *  - só anuncio|classificado publicado, não expirado (D11), com conta
 *    autora ativa e autorModo != 'anonimo' (DP-1: anônimo não tem
 *    identidade para contatar — 404 uniforme, sem oráculo);
 *  - aresta aceita vigente → devolve/cria a conversa direta existente
 *    por parKey (no máximo +1, nunca segunda thread);
 *  - aresta pendente → replay do pedido; sem aresta → pedido pendente
 *    origem→autor (mesma máquina de /contacts: bloqueio bilateral P3,
 *    aceite do destinatário antes de qualquer conversa).
 *  origemContaId opcional quando o requisitante tem >1 conta. */
const contatarSchema = z.object({
  origemContaId: z.string().min(1).optional(),
}).strict();

internetEscritaRouter.post("/publicacoes/:id/contatar", requirePapel("mestre", "jogador"), async (req, res) => {
  const cid = campanhaId(req);
  const body = contatarSchema.safeParse(req.body ?? {});
  if (!body.success) { erroHttp(res, 400, "Dados inválidos", { detalhes: body.error.issues }); return; }

  const pub = await publicacaoPorId(cid, req.params.id);
  const tipoOk = pub && (pub.tipo === "anuncio" || pub.tipo === "classificado");
  const expirado = !!pub?.expiresAt && pub.expiresAt.getTime() <= Date.now();
  if (!pub || pub.status !== "publicado" || !tipoOk || pub.origem === "sistema"
    || !pub.autorContaId || pub.autorModo === "anonimo" || expirado) {
    erroHttp(res, 404, "Publicação não encontrada"); return;
  }
  const [destino] = await db.select().from(internetAccounts)
    .where(and(eq(internetAccounts.id, pub.autorContaId), eq(internetAccounts.campaignId, cid), eq(internetAccounts.status, "ativa")))
    .limit(1);
  if (!destino) { erroHttp(res, 404, "Publicação não encontrada"); return; }

  // origem do requisitante — mesma regra de resolverOrigem (internet.ts)
  const minhas = await contasDoUsuario(cid, req.usuario!.id);
  const origem = body.data.origemContaId
    ? minhas.find((c) => c.id === body.data.origemContaId)
    : minhas.length === 1 ? minhas[0] : undefined;
  if (!origem) {
    erroHttp(res, 400, minhas.length > 1 ? "origemContaId obrigatório" : "Sem conta elegível"); return;
  }
  const auth = await contaAutorizadaPara(origem.id, req.usuario!.id);
  if (!auth) { erroHttp(res, 403, "Conta não autorizada"); return; }
  if (origem.id === destino.id) { erroHttp(res, 400, "Não é possível contatar a si mesmo"); return; }
  if (await contatoBloqueadoEntre(db, cid, origem.id, destino.id)) {
    erroHttp(res, 403, "Contato bloqueado"); return;
  }

  // arestas em qualquer direção entre o par
  const arestas = await db.select().from(internetContacts)
    .where(and(
      eq(internetContacts.campaignId, cid),
      or(
        and(eq(internetContacts.contaOrigemId, origem.id), eq(internetContacts.contaDestinoId, destino.id)),
        and(eq(internetContacts.contaOrigemId, destino.id), eq(internetContacts.contaDestinoId, origem.id)),
      ),
    ));
  const pendente = arestas.find((a) => a.status === "pendente");
  if (pendente) {
    res.json({ ok: true, contato: { id: pendente.id, status: "pendente" }, replay: true }); return;
  }
  const aceita = arestas.find((a) => a.status === "aceito");

  if (aceita) {
    // aresta aceita → conversa direta por parKey (cria só se ainda não
    // existir — mesmo predicado de POST /conversations)
    const parKey = [origem.id, destino.id].sort().join("|");
    const [existente] = await db.select().from(internetConversations)
      .where(and(eq(internetConversations.campaignId, cid), eq(internetConversations.parKey, parKey)))
      .limit(1);
    if (existente) {
      res.json({ ok: true, conversa: existente.id, contato: { status: "aceito" } }); return;
    }
    const agora = new Date();
    const cidConv = crypto.randomUUID();
    if (negaSemCota(req, res)) return;
    let criado = false;
    db.transaction((tx) => {
      if (!titularNaTx(tx, origem.id, req.usuario!.id, cid)) return;
      tx.insert(internetConversations).values({
        id: cidConv, campaignId: cid, tipo: "direta", parKey,
        status: "ativa", createdByContaId: origem.id, createdAt: agora, updatedAt: agora,
      }).run();
      tx.insert(internetParticipantes).values([
        { id: crypto.randomUUID(), conversaId: cidConv, contaId: origem.id, papel: "dono", status: "ativo", convidadoEm: agora, decididoEm: agora, createdAt: agora, updatedAt: agora },
        { id: crypto.randomUUID(), conversaId: cidConv, contaId: destino.id, papel: "membro", status: "ativo", convidadoPorContaId: origem.id, convidadoEm: agora, decididoEm: agora, createdAt: agora, updatedAt: agora },
      ]).run();
      auditTx(tx, req, cid, "internet.conversa_criada", { conversaId: cidConv, tipo: "direta", origem: "contatar" });
      criado = true;
    });
    if (!criado) { erroHttp(res, 403, "Titularidade da conta não confirmada"); return; }
    consumirMutacao(req);
    res.status(201).json({ ok: true, conversa: cidConv, contato: { status: "aceito" } });
    return;
  }

  // sem aresta → pedido de contato pendente (mesma máquina de /contacts)
  const agora = new Date();
  const id = crypto.randomUUID();
  if (negaSemCota(req, res)) return;
  let commitado = false;
  let falhaTitular = false;
  let conflito: "bloqueado" | "aresta" | null = null;
  await db.transaction((tx) => {
    if (!titularNaTx(tx, origem.id, req.usuario!.id, cid)) { falhaTitular = true; return; }
    // re-check dentro da tx (corrida com aceite/bloqueio) — select
    // síncrono: a tx do better-sqlite3 não aceita callback async
    const arestasTx = tx.select({ status: internetContacts.status }).from(internetContacts)
      .where(and(
        eq(internetContacts.campaignId, cid),
        or(
          and(eq(internetContacts.contaOrigemId, origem.id), eq(internetContacts.contaDestinoId, destino.id)),
          and(eq(internetContacts.contaOrigemId, destino.id), eq(internetContacts.contaDestinoId, origem.id)),
        ),
      )).all();
    if (arestasTx.some((a) => a.status === "bloqueado")) { conflito = "bloqueado"; return; }
    if (arestasTx.some((a) => a.status !== "pendente")) { conflito = "aresta"; return; }
    tx.insert(internetContacts).values({
      id, campaignId: cid, contaOrigemId: origem.id, contaDestinoId: destino.id,
      status: "pendente", createdAt: agora, updatedAt: agora,
    }).run();
    auditTx(tx, req, cid, "internet.contato_pedido", {
      contatoId: id, origem: origem.id, destino: destino.id, origemAcao: "contatar",
    });
    commitado = true;
  });
  if (falhaTitular) { erroHttp(res, 403, "Titularidade da conta não confirmada"); return; }
  if (conflito === "bloqueado") { erroHttp(res, 403, "Contato bloqueado"); return; }
  if (conflito === "aresta") { erroHttp(res, 409, "aresta_existente"); return; }
  if (!commitado) { erroHttp(res, 500, "Falha ao registrar contato"); return; }
  consumirMutacao(req);
  // notifica o destinatário pela sala privada (mesmo evento de /contacts)
  const [destUser] = await db.select({ userId: memberships.userId }).from(internetAccounts)
    .innerJoin(characters, eq(internetAccounts.characterId, characters.id))
    .innerJoin(memberships, eq(characters.membershipId, memberships.id))
    .where(and(eq(internetAccounts.id, destino.id), eq(memberships.status, "ativo"))).limit(1);
  if (destUser) {
    emitirUsuario(destUser.userId, "internet:contato", {
      campanhaId: cid, contatoId: id, status: "pendente",
      de: { id: origem.id, handle: origem.handle, displayName: origem.displayName },
    });
  }
  res.status(201).json({ ok: true, contato: { id, status: "pendente" } });
});
