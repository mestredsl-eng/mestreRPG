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
  /** Métricas (ordem 7232090197): views brutas de leitura — só em
   *  matéria publicada vigente; incrementa por GET do detalhe. */
  views?: number;
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

// ---------- Perfis públicos (W9/W10 — D10/DP-4/5/7 + D12) ----------

export interface PublicacaoTimeline {
  id: string;
  tipo: string;
  titulo: string;
  corpo: string;
  formato: string;
  publicadoEm: string | null;
  /** Presente só para o próprio titular (DP-1 — marcada, jamais
   *  identificada). */
  anonima?: boolean;
  pseudoNome?: string;
}

export interface PerfilPublico {
  handle: string;
  nomePublico: string;
  descricao: string | null;
  avatar: { arquivoId: string } | null;
  personagemFalecido: boolean;
  /** Métricas (ordem 7232090197; M7): COUNT derivado da aresta —
   *  o grafo (quem segue quem) nunca é exposto. */
  seguidores: number;
  /** Só para o próprio leitor autenticado — o grafo nunca é exposto. */
  seguindoVoce?: boolean;
  publicacoes: PublicacaoTimeline[];
}

/** Live simulada (Streamer — ordem 7232090197 item 3): presença
 *  efêmera com TTL; sem ids internos de conta/personagem. */
export interface LiveResumo {
  id: string;
  titulo: string;
  descricao: string | null;
  handle: string | null;
  nomePublico: string | null;
  iniciadoEm: string;
  expiraEm: string;
  vigente: boolean;
  /** Live de conta autorizada do próprio leitor — única marca de
   *  titularidade exposta. */
  minha?: boolean;
  criadoEm: string;
}

export interface PerfilResumoBusca {
  handle: string;
  nomePublico: string;
}

/** Visão do próprio titular (GET /perfil?characterId=) — rota
 *  autenticada do dono, pode trazer ids internos de gestão. */
export interface PerfilProprio {
  id: string;
  characterId: string;
  handle: string | null;
  nomePublico: string | null;
  descricao: string | null;
  avatarFileId: string | null;
  ativadoEm: string;
  falecido: boolean;
}
