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
  MinhaPublicacao, PaginaPagina, PaginaPublica, PerfilProprio,
  PerfilPublico, PerfilResumoBusca, PublicacaoDetalhe,
  PublicacaoNova, PublicacaoResumo, SitePublico, SitePublicoResumo,
  TipoPublicacao,
} from "./tipos-publica";

const API = "/api";

async function requisicao<T>(caminho: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${caminho}`, {
    credentials: "same-origin",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });
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

    // ---------- Publicações (W4/W5 leitura + W8-subset escrita) ----------

    async listarPublicacoes(opts?: {
      tipo?: TipoPublicacao; cursor?: string | null; limite?: number;
    }): Promise<PaginaPagina<PublicacaoResumo>> {
      const params = new URLSearchParams({ limit: String(opts?.limite ?? 20) });
      if (opts?.tipo) params.set("tipo", opts.tipo);
      if (opts?.cursor) params.set("cursor", opts.cursor);
      const r = await requisicao<{ publicacoes: PublicacaoResumo[]; cursor: string | null }>(
        `${base}/publicacoes?${params}`);
      return { itens: r.publicacoes, proximoCursor: r.cursor };
    },

    async obterPublicacao(id: string): Promise<PublicacaoDetalhe> {
      const r = await requisicao<{ publicacao: PublicacaoDetalhe }>(
        `${base}/publicacoes/${encodeURIComponent(id)}`);
      return r.publicacao;
    },

    async minhasPublicacoes(): Promise<MinhaPublicacao[]> {
      const r = await requisicao<{ publicacoes: MinhaPublicacao[] }>(
        `${base}/publicacoes/minhas`);
      return r.publicacoes;
    },

    async criarPublicacao(dados: PublicacaoNova): Promise<PublicacaoDetalhe> {
      const r = await requisicao<{ publicacao: PublicacaoDetalhe }>(
        `${base}/publicacoes`, { method: "POST", body: JSON.stringify(dados) });
      return r.publicacao;
    },

    async atualizarPublicacao(id: string, dados: {
      titulo?: string; corpo?: string; visibilidade?: string;
      autorModo?: string; pseudoNome?: string | null;
      expiresAt?: string | null;
      status?: "rascunho" | "publicado";
      expectedVersion: number;
    }): Promise<PublicacaoDetalhe> {
      const r = await requisicao<{ publicacao: PublicacaoDetalhe }>(
        `${base}/publicacoes/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(dados) });
      return r.publicacao;
    },

    /** D9/W6-W8: "Contatar" do anúncio/classificado — reusa o fluxo de
     *  contatos existente; devolve { conversa } quando a aresta já é
     *  aceita, ou { contato } quando um pedido fica pendente. */
    async contatarPublicacao(id: string): Promise<{ conversa?: string; contato?: { id: string; status: string } }> {
      return requisicao<{ conversa?: string; contato?: { id: string; status: string } }>(
        `${base}/publicacoes/${encodeURIComponent(id)}/contatar`, { method: "POST", body: "{}" });
    },

    async denunciarPublicacao(id: string, motivo: string, denunciaGrave?: boolean): Promise<{ removida: boolean }> {
      const r = await requisicao<{ removida: boolean }>(
        `${base}/publicacoes/${encodeURIComponent(id)}/denunciar`,
        { method: "POST", body: JSON.stringify({ motivo, denunciaGrave }) });
      return r;
    },

    // ---------- Perfis públicos (W9/W10) ----------

    /** Perfil público por handle — 404 uniforme para inexistente,
     *  não ativado ou outra campanha (anti-enumeração). */
    async obterPerfil(handle: string): Promise<PerfilPublico> {
      const r = await requisicao<{ perfil: PerfilPublico }>(
        `${base}/perfis/${encodeURIComponent(handle)}`);
      return r.perfil;
    },

    /** D12: busca de perfis por HANDLE somente — displayName/nome
     *  público não indexam (SEARCH-06). */
    async buscarPerfis(q: string): Promise<PerfilResumoBusca[]> {
      const r = await requisicao<{ perfis: PerfilResumoBusca[] }>(
        `${base}/busca?q=${encodeURIComponent(q)}`);
      return r.perfis;
    },

    /** Visão do próprio titular (characterId vem da URL — escopo
     *  servidor valida titularidade). 404 = perfil não ativado. */
    async obterMeuPerfil(characterId: string): Promise<PerfilProprio | null> {
      try {
        const r = await requisicao<{ perfil: PerfilProprio }>(
          `${base}/perfil?characterId=${encodeURIComponent(characterId)}`);
        return r.perfil;
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },

    /** Ativação irreversível (D10) — o servidor rejeita repetição com
     *  200 idempotente; a UI ainda confirma uma única vez. */
    async ativarPerfil(characterId: string, dados?: { nomePublico?: string; descricao?: string }): Promise<PerfilProprio> {
      const r = await requisicao<{ perfil: PerfilProprio }>(
        `${base}/perfil/ativar`, {
          method: "POST",
          body: JSON.stringify({ characterId, ...dados }),
        });
      return r.perfil;
    },

    async editarPerfil(characterId: string, dados: {
      nomePublico?: string | null; descricao?: string | null; avatarFileId?: string | null;
    }): Promise<PerfilProprio> {
      const r = await requisicao<{ perfil: PerfilProprio }>(
        `${base}/perfil`, {
          method: "PATCH",
          body: JSON.stringify({ characterId, ...dados }),
        });
      return r.perfil;
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
