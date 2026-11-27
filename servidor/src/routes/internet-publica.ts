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
import { internetAccounts, internetPages, internetSites } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePapel } from "../lib/permissoes.js";
import {
  contaAutorizadaPara, contasDoUsuario, codificarCursor, decodificarCursor,
  mestreLeitorDaCampanha,
} from "../lib/conta-internet.js";

const db = getDb();
export const internetPublicaRouter = Router({ mergeParams: true });
internetPublicaRouter.use(requireAuth);

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
internetPublicaRouter.get("/sites", requirePapel("mestre", "jogador"), async (req, res) => {
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
internetPublicaRouter.get("/sites/:slug", requirePapel("mestre", "jogador"), async (req, res) => {
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
internetPublicaRouter.get("/sites/:slug/paginas/:pageSlug", requirePapel("mestre", "jogador"), async (req, res) => {
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

  const [pagina] = await db.select().from(internetPages)
    .where(and(
      eq(internetPages.siteId, site.id),
      eq(internetPages.campaignId, cid),
      eq(internetPages.slug, req.params.pageSlug),
      eq(internetPages.status, "publicado"),
    )).limit(1);
  if (!pagina) { erroHttp(res, 404, "Página não encontrada"); return; }

  const [autor] = await db.select().from(internetAccounts)
    .where(eq(internetAccounts.id, pagina.autorContaId)).limit(1);

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
});
