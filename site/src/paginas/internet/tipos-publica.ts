// Internet pública 1.1.2 (#365 — fatia W1/W3): tipos da camada
// pública (Explorar). Somente leitura — diretório de sites da campanha,
// detalhe de site com menu derivado das páginas publicadas e leitura
// de página. Nenhum tipo aqui é contrato de API — o formato HTTP vem
// de servidor/src/routes/internet-publica.ts.

export interface SitePublicoResumo {
  id: string;
  slug: string;
  nome: string;
  descricao: string | null;
  owner: { id: string; handle: string; displayName: string } | null;
  paginasPublicadas: number;
  /** ISO string (createdAt do servidor, timestamp_ms). */
  criadoEm: string;
}

export interface PaginaPublicaResumo {
  slug: string;
  titulo: string;
  publicadoEm: string | null;
}

export interface SitePublico {
  id: string;
  slug: string;
  nome: string;
  descricao: string | null;
  owner: { id: string; handle: string; displayName: string } | null;
  criadoEm: string;
  paginas: PaginaPublicaResumo[];
}

export interface PaginaPublica {
  slug: string;
  titulo: string;
  corpo: string;
  formato: string;
  version: number;
  publicadoEm: string | null;
  autor: { id: string; handle: string; displayName: string } | null;
}

export interface PaginaPagina<T> {
  itens: T[];
  /** cursor opaco da próxima página; null = fim. */
  proximoCursor: string | null;
}
