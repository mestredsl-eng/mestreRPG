// Internet pública 1.1.2 (#365 — fatia W1/W3): adaptador REST da camada
// pública (Explorar). SOMENTE LEITURA — consome os endpoints de
// servidor/src/routes/internet-publica.ts:
//   GET /api/campaigns/:cid/internet/sites?q=&cursor=&limit=
//   GET /api/campaigns/:cid/internet/sites/:slug
//   GET /api/campaigns/:cid/internet/sites/:slug/paginas/:pageSlug
// O gate de acesso (conta Internet autorizada ou mestre) é do servidor
// — 403/404 chegam como ApiError e viram estados honestos na UI; o
// adaptador nunca presume acesso nem cacheia autorização.

import { ApiError } from "../../api";
import type {
  PaginaPagina, PaginaPublica, SitePublico, SitePublicoResumo,
} from "./tipos-publica";

const API = "/api";

async function requisicao<T>(caminho: string): Promise<T> {
  const res = await fetch(`${API}${caminho}`, { credentials: "same-origin" });
  const corpo = await res.json().catch(() => ({}));
  if (!res.ok) {
    const c = corpo as { erro?: string; mensagem?: string };
    throw new ApiError(c.mensagem ?? c.erro ?? `HTTP ${res.status}`, corpo, res.status);
  }
  return corpo as T;
}

interface SiteApi {
  id: string; slug: string; nome: string; descricao: string | null;
  owner: { id: string; handle: string; displayName: string } | null;
  paginasPublicadas?: number;
  criadoEm: string;
}
interface PaginaResumoApi { slug: string; titulo: string; publicadoEm: string | null }
interface PaginaApi {
  slug: string; titulo: string; corpo: string; formato: string;
  version: number; publicadoEm: string | null;
  autor: { id: string; handle: string; displayName: string } | null;
}

const paraResumo = (s: SiteApi): SitePublicoResumo => ({
  id: s.id, slug: s.slug, nome: s.nome, descricao: s.descricao,
  owner: s.owner, paginasPublicadas: s.paginasPublicadas ?? 0, criadoEm: s.criadoEm,
});

export function criarAdaptadorInternetPublica({ campaignId }: { campaignId: string }) {
  const base = `/campaigns/${campaignId}/internet`;

  return {
    async listarSites(q?: string, cursor?: string | null): Promise<PaginaPagina<SitePublicoResumo>> {
      const params = new URLSearchParams({ limit: "20" });
      if (q && q.trim()) params.set("q", q.trim());
      if (cursor) params.set("cursor", cursor);
      const r = await requisicao<{ sites: SiteApi[]; cursor: string | null }>(
        `${base}/sites?${params}`);
      return { itens: r.sites.map(paraResumo), proximoCursor: r.cursor };
    },

    async obterSite(slug: string): Promise<SitePublico> {
      const r = await requisicao<{ site: SiteApi; paginas: PaginaResumoApi[] }>(
        `${base}/sites/${encodeURIComponent(slug)}`);
      return {
        id: r.site.id, slug: r.site.slug, nome: r.site.nome,
        descricao: r.site.descricao, owner: r.site.owner, criadoEm: r.site.criadoEm,
        paginas: r.paginas.map((p) => ({
          slug: p.slug, titulo: p.titulo, publicadoEm: p.publicadoEm,
        })),
      };
    },

    async obterPagina(siteSlug: string, pageSlug: string): Promise<{ pagina: PaginaPublica; site: { slug: string; nome: string } }> {
      const r = await requisicao<{ pagina: PaginaApi; site: { slug: string; nome: string } }>(
        `${base}/sites/${encodeURIComponent(siteSlug)}/paginas/${encodeURIComponent(pageSlug)}`);
      const p = r.pagina;
      return {
        pagina: {
          slug: p.slug, titulo: p.titulo, corpo: p.corpo, formato: p.formato,
          version: p.version, publicadoEm: p.publicadoEm, autor: p.autor,
        },
        site: r.site,
      };
    },
  };
}

export type AdaptadorInternetPublica = ReturnType<typeof criarAdaptadorInternetPublica>;
