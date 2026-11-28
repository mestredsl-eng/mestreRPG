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

// ---------- Publicações (W4 feed / W5 matéria / W8-subset escrita) ----------

export type TipoPublicacao = "noticia" | "post_perfil" | "anuncio" | "classificado";
export type VisibilidadePublicacao = "campanha" | "contatos";
export type AutorPublicacao =
  | { modo: "identificado"; id: string; handle: string; displayName: string }
  | { modo: "pseudonimo"; nome: string }
  | { modo: "anonimo" }
  | null;

export interface PublicacaoResumo {
  id: string;
  tipo: TipoPublicacao;
  titulo: string;
  autor: AutorPublicacao;
  origem: "usuario" | "sistema";
  visibilidade: VisibilidadePublicacao;
  publicadoEm: string | null;
  expiresAt?: string | null;
  atualizadoEm: string;
}

export interface PublicacaoDetalhe {
  id: string;
  tipo: TipoPublicacao;
  titulo: string;
  corpo: string;
  formato: string;
  status: "rascunho" | "publicado" | "removido";
  visibilidade: VisibilidadePublicacao;
  autorModo?: "identificado" | "pseudonimo" | "anonimo";
  pseudoNome?: string | null;
  /** DP-1: presente (true) quando a publicação é anônima — a resposta
   *  sanitizada não carrega nenhuma chave de identidade do autor. */
  anonimo?: boolean;
  origem: "usuario" | "sistema";
  autor?: AutorPublicacao;
  personagemId?: string | null;
  publicadoEm: string | null;
  expiresAt?: string | null;
  /** D11: estado derivado na leitura — nunca persistido. */
  expirado?: boolean;
  /** D9: o leitor pode iniciar o fluxo Contatar (anúncio/classificado
   *  vigente, sem bloqueio). Anônimo ⇒ sempre false. */
  podeContatar?: boolean;
  criadoEm: string;
  atualizadoEm: string;
  // Só presentes para autor/mestre (prévia privilegiada)
  autorContaId?: string | null;
  version?: number;
  retiradoMotivo?: string | null;
}

export interface MinhaPublicacao {
  id: string;
  tipo: TipoPublicacao;
  titulo: string;
  status: string;
  visibilidade: VisibilidadePublicacao;
  autorModo: string;
  pseudoNome: string | null;
  origem: string;
  publicadoEm: string | null;
  expiresAt?: string | null;
  version: number;
  criadoEm: string;
  atualizadoEm: string;
}

export interface PublicacaoNova {
  tipo: TipoPublicacao;
  titulo: string;
  corpo: string;
  visibilidade: VisibilidadePublicacao;
  autorModo?: "identificado" | "pseudonimo" | "anonimo";
  pseudoNome?: string;
  expiresAt?: string;
  contaId?: string;
}
