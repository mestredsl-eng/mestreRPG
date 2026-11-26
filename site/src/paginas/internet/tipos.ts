// F4 / Issue #352 — tipos de domínio da Internet diegética.
// Espelham o contrato #349/#360 (docs/ISSUE-349-ARQUITETURA-CONTRATO.md):
// conta opt-in por personagem, contatos por arestas dirigidas, conversas
// diretas/grupo com cursor de leitura no participante, mensagens com
// requestId idempotente. Nenhum tipo aqui é contrato de API — o formato
// HTTP será fixado pelo F2; estes tipos são o modelo de tela.

export type EstadoContato = "pendente" | "aceito" | "bloqueado";
/** Direção da aresta na ótica do usuário logado. */
export type DirecaoContato = "enviado" | "recebido";

export interface ContaInternet {
  id: string;
  handle: string;
  /** Nome do personagem vinculado — único dado de perfil exposto (P: perfil conservador). */
  nomePersonagem: string;
}

export interface ContatoInternet {
  id: string;
  contaId: string;
  handle: string;
  nomePersonagem: string;
  estado: EstadoContato;
  direcao: DirecaoContato;
}

export interface ContatosInternet {
  aceitos: ContatoInternet[];
  pedidosRecebidos: ContatoInternet[];
  pedidosEnviados: ContatoInternet[];
  bloqueados: ContatoInternet[];
}

export type TipoConversa = "direta" | "grupo";
export type StatusConversa = "ativa" | "arquivada";

export interface ConversaResumo {
  id: string;
  tipo: TipoConversa;
  /** null em conversa direta — o rótulo é o handle do outro participante. */
  nome: string | null;
  /** handle/nome do interlocutor em conversa direta (preview/lista). */
  interlocutor?: { contaId: string; handle: string; nomePersonagem: string } | null;
  /** preview da última mensagem (sem conteúdo sensível além do texto). */
  ultimaMensagem: { conteudo: string; criadoEm: string; autorHandle: string | null } | null;
  naoLidas: number;
  atualizadoEm: string;
  status: StatusConversa;
}

export type PapelParticipante = "dono" | "membro";
export type StatusParticipante = "convidado" | "ativo" | "recusado" | "cancelado" | "saiu";

export interface ParticipanteGrupo {
  contaId: string;
  handle: string;
  nomePersonagem: string;
  papel: PapelParticipante;
  status: StatusParticipante;
}

export interface DetalhesGrupo {
  conversaId: string;
  nome: string;
  papelMinhaConta: PapelParticipante;
  /** status do meu participante: "convidado" exibe aceite/recusa (P4). */
  meuStatusParticipante: StatusParticipante;
  minhaContaId: string;
  membros: ParticipanteGrupo[];
}

export type TipoMensagem = "texto";
export type EstadoEnvio = "enviada" | "enviando" | "falhou";

export interface MensagemInternet {
  id: string;
  conversaId: string;
  /** conta autora — o cliente roteia por ela (multi-conta por usuário). */
  contaIdAutor: string;
  autorHandle: string;
  autorNome: string;
  tipo: TipoMensagem;
  conteudo: string;
  criadoEm: string;
  requestId: string;
  /** true quando a mensagem é da conta do usuário logado. */
  minha: boolean;
  estadoEnvio?: EstadoEnvio;
}

export interface PaginaMensagens {
  mensagens: MensagemInternet[]; // ordem cronológica (createdAt,id)
  /** cursor opaco da próxima página (mais antigas); null = fim do histórico. */
  cursorAnterior: string | null;
  /** cursor de leitura atual da minha conta nesta conversa. */
  cursorLeitura: { lastReadCreatedAt: string | null; lastReadMessageId: string | null };
}

export interface ResultadoEnvio {
  mensagem: MensagemInternet;
  replay: boolean;
}

/** Evento realtime entregue pelo adaptador (F3: fan-out usuario:{id}). */
export type EventoInternet =
  | { tipo: "mensagem"; conversaId: string; mensagem: MensagemInternet }
  | { tipo: "conversa-atualizada"; conversaId: string }
  | { tipo: "convite"; conversaId: string }
  | { tipo: "leitura"; conversaId: string; contaId: string };

export type ConexaoRealtime = "conectado" | "reconectando" | "desconectado";
