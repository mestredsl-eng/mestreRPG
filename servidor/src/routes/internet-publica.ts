// Internet pública 1.1.2 (#365 — fatia W1/W3, SOMENTE LEITURA):
// diretório de sites da campanha e leitura de site/página.
//
// Fronteiras decididas (D1/D2, Quiz 1–2): escopo = campanha, sites
// descobríveis por TODOS os elegíveis — conteúdo com visibilidade
// `contatos` NÃO existe nesta fatia. URLs são por campanha: slug de
// outra campanha responde 404 idêntico a inexistente (anti-enumeração).
//
// Leitor: exige ≥1 conta Internet autorizada (contaAutorizadaPara —
// titularidade + gate de perícia/dispositivo) OU papel mestre na
// campanha (leitura P10-style, sem conta própria). Sem as duas → 403.
//
// Criação/edição de sites e páginas NÃO está nesta fatia — a regra de
// produto (quem cria/edita) está pendente de deliberação. Nesta fatia
// as tabelas só são lidas; dados de teste entram por fixture.
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { internetAccounts, internetPages, internetPublicacoes, internetSites } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePapel } from "../lib/permissoes.js";
import {
  contaAutorizadaPara, contasDoUsuario, codificarCursor, contatoAceitoEntre,
  contatoBloqueadoEntre, decodificarCursor, mestreLeitorDaCampanha,
} from "../lib/conta-internet.js";
import { limiteUsuario } from "../lib/ratelimit.js";

const db = getDb();
export const internetPublicaRouter = Router({ mergeParams: true });
internetPublicaRouter.use(requireAuth);

/** Limite de leitura da camada pública (aceite #387 "rate limit
 *  observado" + parecer #367 §7): cota por usuário autenticado
 *  compartilhada entre os 3 GETs — enumeração de slugs fica cara
 *  mesmo para elegíveis; navegação humana normal fica muito abaixo. */
const limiteLeituraPublica = limiteUsuario({
  nome: "internet-publica-leitura", janelaMs: 60_000, max: 60,
});

const campanhaId = (req: Request) => req.params.campaignId as string;

function erroHttp(res: Response, status: number, erro: string) {
  res.status(status).json({ erro });
}

function contaPublica(c: typeof internetAccounts.$inferSelect) {
  return { id: c.id, handle: c.handle, displayName: c.displayName };
}

interface LeitorPublico {
  /** Contas autorizadas do requisitante (vazio quando leitura via mestre). */
  contas: (typeof internetAccounts.$inferSelect)[];
  viaMestre: boolean;
}

/** Gate do leitor da camada pública: conta Internet autorizada (gate
 *  cumulativo de perícia+dispositivo via contaAutorizadaPara) ou papel
 *  mestre na campanha. Fail-closed — nunca presume acesso por ID. */
async function exigirLeitorPublico(req: Request, res: Response, cid: string): Promise<LeitorPublico | null> {
  const minhas = await contasDoUsuario(cid, req.usuario!.id);
  const contas: (typeof internetAccounts.$inferSelect)[] = [];
  for (const conta of minhas) {
    const auth = await contaAutorizadaPara(conta.id, req.usuario!.id);
    if (auth) contas.push(auth.conta);
  }
  if (contas.length) return { contas, viaMestre: false };
  if (await mestreLeitorDaCampanha(cid, req.usuario!.id)) return { contas: [], viaMestre: true };
  erroHttp(res, 403, "Sem acesso à camada pública da Internet");
  return null;
}

const querySitesSchema = z.object({
  q: z.string().trim().max(80).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
}).strict();

/** GET /api/campaigns/:campaignId/internet/sites — diretório de sites
 *  ativos da campanha (D2). Paginação keyset (createdAt,id) DESC +
 *  filtro prefixo opcional em `nome` (?q=). Cada item traz o dono
 *  (handle/displayName) e a contagem de páginas PUBLICADAS — rascunho,
 *  retirado e arquivado nunca contam para o leitor. */
internetPublicaRouter.get("/sites", requirePapel("mestre", "jogador"), limiteLeituraPublica, async (req, res) => {
  const cid = campanhaId(req);
  const leitor = await exigirLeitorPublico(req, res, cid);
  if (!leitor) return;

  const query = querySitesSchema.safeParse(req.query);
  if (!query.success) { erroHttp(res, 400, "Parâmetros inválidos"); return; }
  const { q, cursor: cursorRaw, limit = 20 } = query.data;
  const cursor = cursorRaw ? decodificarCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) { erroHttp(res, 400, "Cursor inválido"); return; }

  const conds = [
    eq(internetSites.campaignId, cid),
    eq(internetSites.status, "ativo"),
  ];
  if (q) conds.push(sql`${internetSites.nome} LIKE ${q + "%"}`);
  if (cursor) {
    conds.push(or(
      lt(internetSites.createdAt, cursor.createdAt),
      and(eq(internetSites.createdAt, cursor.createdAt), lt(internetSites.id, cursor.messageId)),
    )!);
  }
  const rows = await db.select().from(internetSites)
    .where(and(...conds))
    .orderBy(sql`${internetSites.createdAt} DESC`, sql`${internetSites.id} DESC`)
    .limit(limit + 1);
  const pagina = rows.slice(0, limit);
  const proximoCursor = rows.length > limit && pagina.length
    ? codificarCursor(pagina[pagina.length - 1].createdAt, pagina[pagina.length - 1].id)
    : null;

  const siteIds = pagina.map((s) => s.id);
  const [contas, contagens] = await Promise.all([
    siteIds.length
      ? db.select().from(internetAccounts).where(inArray(internetAccounts.id, [...new Set(pagina.map((s) => s.ownerContaId))]))
      : Promise.resolve([] as (typeof internetAccounts.$inferSelect)[]),
    siteIds.length
      ? db.select({ siteId: internetPages.siteId, n: sql<number>`count(*)` }).from(internetPages)
          .where(and(inArray(internetPages.siteId, siteIds), eq(internetPages.status, "publicado")))
          .groupBy(internetPages.siteId)
      : Promise.resolve([] as { siteId: string; n: number }[]),
  ]);
  const contaPorId = new Map(contas.map((c) => [c.id, contaPublica(c)]));
  const contagemPorSite = new Map(contagens.map((c) => [c.siteId, Number(c.n)]));

  res.json({
    sites: pagina.map((s) => ({
      id: s.id,
      slug: s.slug,
      nome: s.nome,
      descricao: s.descricao,
      owner: contaPorId.get(s.ownerContaId) ?? null,
      paginasPublicadas: contagemPorSite.get(s.id) ?? 0,
      criadoEm: s.createdAt,
    })),
    cursor: proximoCursor,
  });
});

/** GET /api/campaigns/:campaignId/internet/sites/:slug — detalhe do
 *  site + menu derivado das páginas PUBLICADAS (D13-a: sem editor de
 *  menu nesta fatia). Site arquivado ou de outra campanha → 404. */
internetPublicaRouter.get("/sites/:slug", requirePapel("mestre", "jogador"), limiteLeituraPublica, async (req, res) => {
  const cid = campanhaId(req);
  const leitor = await exigirLeitorPublico(req, res, cid);
  if (!leitor) return;

  const [site] = await db.select().from(internetSites)
    .where(and(
      eq(internetSites.campaignId, cid),
      eq(internetSites.slug, req.params.slug),
      eq(internetSites.status, "ativo"),
    )).limit(1);
  if (!site) { erroHttp(res, 404, "Site não encontrado"); return; }

  const paginas = await db.select().from(internetPages)
    .where(and(eq(internetPages.siteId, site.id), eq(internetPages.status, "publicado")))
    .orderBy(internetPages.titulo, internetPages.id);

  const [owner] = await db.select().from(internetAccounts)
    .where(eq(internetAccounts.id, site.ownerContaId)).limit(1);

  res.json({
    site: {
      id: site.id,
      slug: site.slug,
      nome: site.nome,
      descricao: site.descricao,
      owner: owner ? contaPublica(owner) : null,
      criadoEm: site.createdAt,
    },
    paginas: paginas.map((p) => ({
      slug: p.slug,
      titulo: p.titulo,
      publicadoEm: p.publishedAt,
    })),
  });
});

/** GET /api/campaigns/:campaignId/internet/sites/:slug/paginas/:pageSlug
 *  — página publicada. Somente `publicado` é legível nesta fatia:
 *  rascunho/retirado/arquivado respondem 404 idêntico a inexistente
 *  (a fronteira "visível-antes vs nunca-visível" de estados honestos
 *  fica para a fatia de publicações — aqui não há como distinguir sem
 *  vazar existência). */
internetPublicaRouter.get("/sites/:slug/paginas/:pageSlug", requirePapel("mestre", "jogador"), limiteLeituraPublica, async (req, res) => {
  const cid = campanhaId(req);
  const leitor = await exigirLeitorPublico(req, res, cid);
  if (!leitor) return;

  const [site] = await db.select().from(internetSites)
    .where(and(
      eq(internetSites.campaignId, cid),
      eq(internetSites.slug, req.params.slug),
      eq(internetSites.status, "ativo"),
    )).limit(1);
  if (!site) { erroHttp(res, 404, "Site não encontrado"); return; }

  // Sem filtro de status na query: a página pode estar em qualquer
  // estado e a decisão de visibilidade é por ator (W3-escrita).
  const [pagina] = await db.select().from(internetPages)
    .where(and(
      eq(internetPages.siteId, site.id),
      eq(internetPages.campaignId, cid),
      eq(internetPages.slug, req.params.pageSlug),
    )).limit(1);
  if (!pagina) { erroHttp(res, 404, "Página não encontrada"); return; }

  // Visão pública: somente `publicado`. Visão estendida (autor da
  // página via contaAutorizadaPara ou mestre) enxerga qualquer status
  // com version/status/autorContaId — prévia do editor. Não-privilegiado
  // recebe 404 IDÊNTICO ao inexistente (zero oráculo de rascunho).
  const souAutor = await contaAutorizadaPara(pagina.autorContaId, req.usuario!.id);
  const ehMestre = souAutor ? false : await mestreLeitorDaCampanha(cid, req.usuario!.id);
  const privilegiado = !!souAutor || ehMestre;
  if (pagina.status !== "publicado" && !privilegiado) {
    erroHttp(res, 404, "Página não encontrada");
    return;
  }

  const [autor] = await db.select().from(internetAccounts)
    .where(eq(internetAccounts.id, pagina.autorContaId)).limit(1);

  if (!privilegiado) {
    res.json({
      pagina: {
        slug: pagina.slug,
        titulo: pagina.titulo,
        corpo: pagina.corpo,
        formato: pagina.formato === "markdown-subset" ? "texto" : pagina.formato,
        version: pagina.version,
        publicadoEm: pagina.publishedAt,
        autor: autor ? contaPublica(autor) : null,
      },
      site: { slug: site.slug, nome: site.nome },
    });
    return;
  }

  res.json({
    pagina: {
      slug: pagina.slug,
      titulo: pagina.titulo,
      corpo: pagina.corpo,
      formato: pagina.formato,
      status: pagina.status,
      version: pagina.version,
      autorContaId: pagina.autorContaId,
      publicadoEm: pagina.publishedAt,
      atualizadoEm: pagina.updatedAt,
      autor: autor ? contaPublica(autor) : null,
    },
    site: { slug: site.slug, nome: site.nome },
  });
});

// ---------- Publicações (W4 lista / W5 matéria — contrato CONTRATO-W4W5) ----------
//
// visivel(pub, leitor): status='publicado' ∧ campanha do leitor ∧
// (visibilidade='campanha' ∨ autor ∈ contas do leitor ∨ aresta aceita
// vigente com o autor sem bloqueio P3). `contatos` nunca aparece em
// busca/agregados — aqui só filtra linhas; agregados são fatias W2/W6.

function contaIdsDoLeitor(leitor: LeitorPublico) {
  return leitor.contas.map((c) => c.id);
}

/** aresta aceita vigente leitor→autor (qualquer direção de aresta,
 *  mesmo predicado de contatoAceitoEntre) sem bloqueio bilateral. */
async function visivelParaLeitor(
  pub: typeof internetPublicacoes.$inferSelect,
  leitor: LeitorPublico,
  cid: string,
): Promise<boolean> {
  if (pub.status !== "publicado" || pub.campaignId !== cid) return false;
  if (pub.visibilidade === "campanha") return true;
  // 'contatos': autor precisa existir e haver aresta aceita sem bloqueio
  if (!pub.autorContaId) return false;
  const meusIds = contaIdsDoLeitor(leitor);
  if (meusIds.includes(pub.autorContaId)) return true; // o próprio autor
  for (const meuId of meusIds) {
    const aceito = await contatoAceitoEntre(db, cid, meuId, pub.autorContaId);
    if (!aceito) continue;
    const bloqueado = await contatoBloqueadoEntre(db, cid, meuId, pub.autorContaId);
    if (!bloqueado) return true;
  }
  return false;
}

const queryPublicacoesSchema = z.object({
  tipo: z.enum(["noticia", "post_perfil"]).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
}).strict();

function autorPublico(
  pub: typeof internetPublicacoes.$inferSelect,
  conta: typeof internetAccounts.$inferSelect | undefined,
) {
  // DP-6/anonimato: nesta fatia só identificado|pseudonimo.
  // pseudonimo expõe pseudoNome, NUNCA o handle real; sistema → null.
  if (pub.origem === "sistema") return null;
  if (pub.autorModo === "pseudonimo") {
    return pub.pseudoNome ? { modo: "pseudonimo" as const, nome: pub.pseudoNome } : null;
  }
  return conta ? { modo: "identificado" as const, ...contaPublica(conta) } : null;
}

/** GET /publicacoes — W4: feed de notícias/posts publicados. Keyset
 *  (publicadoEm DESC, id DESC); `contatos` filtrado POR LINHA após a
 *  página (documentado: página pode vir curta — nunca vaza contagem). */
internetPublicaRouter.get("/publicacoes", requirePapel("mestre", "jogador"), limiteLeituraPublica, async (req, res) => {
  const cid = campanhaId(req);
  const leitor = await exigirLeitorPublico(req, res, cid);
  if (!leitor) return;

  const query = queryPublicacoesSchema.safeParse(req.query);
  if (!query.success) { erroHttp(res, 400, "Parâmetros inválidos"); return; }
  const { tipo, cursor: cursorRaw, limit = 20 } = query.data;
  const cursor = cursorRaw ? decodificarCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) { erroHttp(res, 400, "Cursor inválido"); return; }

  const conds = [
    eq(internetPublicacoes.campaignId, cid),
    eq(internetPublicacoes.status, "publicado"),
    sql`${internetPublicacoes.publicadoEm} IS NOT NULL`,
  ];
  if (tipo) conds.push(eq(internetPublicacoes.tipo, tipo));
  if (cursor) {
    conds.push(or(
      lt(internetPublicacoes.publicadoEm, cursor.createdAt),
      and(
        eq(internetPublicacoes.publicadoEm, cursor.createdAt),
        lt(internetPublicacoes.id, cursor.messageId),
      ),
    )!);
  }
  // Over-fetch para compensar o filtro 'contatos' por linha.
  const rows = await db.select().from(internetPublicacoes)
    .where(and(...conds))
    .orderBy(sql`${internetPublicacoes.publicadoEm} DESC`, sql`${internetPublicacoes.id} DESC`)
    .limit(limit * 3 + 1);

  const visiveis: typeof rows = [];
  for (const pub of rows) {
    if (visiveis.length >= limit) break;
    if (await visivelParaLeitor(pub, leitor, cid)) visiveis.push(pub);
  }
  const proximoCursor = rows.length > limit * 3 && visiveis.length
    ? codificarCursor(visiveis[visiveis.length - 1].publicadoEm!, visiveis[visiveis.length - 1].id)
    : null;

  const contaIds = [...new Set(visiveis.map((p) => p.autorContaId).filter((x): x is string => !!x))];
  const contas = contaIds.length
    ? await db.select().from(internetAccounts).where(inArray(internetAccounts.id, contaIds))
    : [];
  const contaPorId = new Map(contas.map((c) => [c.id, c]));

  res.json({
    publicacoes: visiveis.map((p) => ({
      id: p.id, tipo: p.tipo, titulo: p.titulo,
      autor: autorPublico(p, p.autorContaId ? contaPorId.get(p.autorContaId) : undefined),
      origem: p.origem, visibilidade: p.visibilidade,
      publicadoEm: p.publicadoEm, atualizadoEm: p.updatedAt,
    })),
    cursor: proximoCursor,
  });
});

/** GET /publicacoes/:id — W5: matéria completa. Público: só
 *  publicado+visivel (404 uniforme). Titular da conta autora vê a
 *  própria em qualquer status (prévia do editor); mestre vê todas. */
internetPublicaRouter.get("/publicacoes/:id", requirePapel("mestre", "jogador"), limiteLeituraPublica, async function (req, res) {
  const cid = campanhaId(req);
  const leitor = await exigirLeitorPublico(req, res, cid);
  if (!leitor) return;

  const [pub] = await db.select().from(internetPublicacoes)
    .where(and(eq(internetPublicacoes.id, req.params.id), eq(internetPublicacoes.campaignId, cid)))
    .limit(1);
  if (!pub) { erroHttp(res, 404, "Publicação não encontrada"); return; }

  const ehAutor = pub.autorContaId
    ? contaIdsDoLeitor(leitor).includes(pub.autorContaId)
    : false;
  const ehMestre = await mestreLeitorDaCampanha(cid, req.usuario!.id);
  const privilegiado = ehAutor || ehMestre;

  if (!privilegiado && !(await visivelParaLeitor(pub, leitor, cid))) {
    erroHttp(res, 404, "Publicação não encontrada"); return;
  }

  const [conta] = pub.autorContaId
    ? await db.select().from(internetAccounts).where(eq(internetAccounts.id, pub.autorContaId)).limit(1)
    : [undefined];

  res.json({
    publicacao: {
      id: pub.id, tipo: pub.tipo, titulo: pub.titulo, corpo: pub.corpo,
      formato: pub.formato, status: pub.status, visibilidade: pub.visibilidade,
      autorModo: pub.autorModo, origem: pub.origem,
      autor: autorPublico(pub, conta),
      personagemId: pub.personagemId,
      publicadoEm: pub.publicadoEm, criadoEm: pub.createdAt, atualizadoEm: pub.updatedAt,
      // UUID interno e estado de moderação só para privilegiados
      ...(privilegiado ? {
        autorContaId: pub.autorContaId, version: pub.version,
        status: pub.status, retiradoMotivo: pub.retiradoMotivo,
      } : {}),
    },
  });
});
