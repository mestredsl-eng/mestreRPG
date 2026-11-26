// F4 / Issue #352 — adaptador tipado da Internet diegética.
//
// Contrato de integração com o backend F2 (#350) + realtime F3 (#351).
// NENHUMA chamada real existe ainda: este módulo define a superfície
// que o PAI vai implementar. Enquanto o contrato HTTP não fecha, o
// único adaptador exportado é `adaptadorInternetIndisponivel`, que
// falha de forma honesta (erro estável) — nunca devolve dados de
// mentira nem finge sucesso.
//
// Regras do contrato refletidas na assinatura:
//  - toda operação recebe/retorna IDs opacos do servidor;
//  - envio de mensagem exige `requestId` (idempotência, replay:true);
//  - paginação de histórico por cursor, nunca offset;
//  - leitura avança o cursor do participante (mesma linha, servidor);
//  - ações destrutivas/irreversíveis passam por confirmação na UI.

import { ApiError } from "../../api";
import type {
  ContaInternet,
  ContatosInternet,
  ConversaResumo,
  DetalhesGrupo,
  EventoInternet,
  PaginaMensagens,
  ResultadoEnvio,
} from "./tipos";

export interface AdaptadorInternet {
  /** Conta diegética da personagem logado; null = personagem sem conta (opt-in F2). */
  obterConta(): Promise<ContaInternet | null>;

  // ---------- contatos (arestas dirigidas, §4) ----------
  listarContatos(): Promise<ContatosInternet>;
  /** Envia pedido de contato por @handle — unilateral (estado pendente). */
  enviarPedidoContato(handle: string): Promise<void>;
  /** Aceita/recusa pedido recebido — aresta vira `aceito` ou é encerrada. */
  responderPedidoContato(contaId: string, aceitar: boolean): Promise<void>;
  /** Cancela pedido enviado ainda pendente. */
  cancelarPedidoContato(contatoId: string): Promise<void>;
  /** Bloqueio bilateral de facto (P3): corta envio e entrega nos dois sentidos. */
  bloquearContato(contatoId: string): Promise<void>;
  desbloquearContato(contatoId: string): Promise<void>;
  /** Remove aresta aceita — não apaga histórico (semântica F2). */
  removerContato(contatoId: string): Promise<void>;

  // ---------- conversas ----------
  listarConversas(): Promise<ConversaResumo[]>;
  /** Histórico paginado por cursor (mais antigas primeiro na resposta). */
  obterPaginaMensagens(conversaId: string, cursor?: string | null): Promise<PaginaMensagens>;
  /** Envio idempotente: mesmo requestId+payload → replay sem duplicar. */
  enviarMensagem(conversaId: string, conteudo: string, requestId: string): Promise<ResultadoEnvio>;
  /** Marca leitura até a última mensagem conhecida (cursor do participante). */
  marcarLida(conversaId: string): Promise<void>;

  // ---------- criação e grupos ----------
  /** Cria/reabre conversa direta com um contato aceito (parKey, §4). */
  iniciarConversaDireta(contaId: string): Promise<{ conversaId: string }>;
  criarGrupo(nome: string, contaIds: string[]): Promise<{ conversaId: string }>;
  /** Convite de grupo exige contato aceito (P4) e aceite explícito do convidado. */
  convidarParaGrupo(conversaId: string, contaId: string): Promise<void>;
  responderConviteGrupo(conversaId: string, aceitar: boolean): Promise<void>;
  sairDoGrupo(conversaId: string): Promise<void>;
  renomearGrupo(conversaId: string, nome: string): Promise<void>;
  removerMembroGrupo(conversaId: string, contaId: string): Promise<void>;
  obterDetalhesGrupo(conversaId: string): Promise<DetalhesGrupo>;

  // ---------- realtime (F3) ----------
  /**
   * Inscrição em eventos de conta do usuário (fan-out individual).
   * Retorna descadastro. Implementação real usará o socket existente
   * + `internet:conversa-entrar` para cursor — nunca rooms de conteúdo.
   */
  inscreverEventos?(ouvinte: (evento: EventoInternet) => void): () => void;
  /** Estado de conexão do canal realtime para o banner "reconectando". */
  estadoConexao?(): import("./tipos").ConexaoRealtime;
}

/** Erro estável enquanto o contrato F2 não está disponível. */
export const ERRO_API_PENDENTE = "internet_api_pendente";

/**
 * Adaptador fail-closed usado até o PAI fechar o contrato F2/F3.
 * Toda operação rejeita com ApiError — a UI mostra o estado de erro
 * honesto com "Tentar novamente", nunca dados simulados.
 */
export const adaptadorInternetIndisponivel: AdaptadorInternet = {
  obterConta: () => Promise.reject(new ApiError("API da Internet diegética ainda não disponível", undefined, 0)),
  listarContatos: () => Promise.reject(new ApiError("API da Internet diegética ainda não disponível", undefined, 0)),
  enviarPedidoContato: () => Promise.reject(new ApiError("API da Internet diegética ainda não disponível", undefined, 0)),
  responderPedidoContato: () => Promise.reject(new ApiError("API da Internet diegética ainda não disponível", undefined, 0)),
  cancelarPedidoContato: () => Promise.reject(new ApiError("API da Internet diegética ainda não disponível", undefined, 0)),
  bloquearContato: () => Promise.reject(new ApiError("API da Internet diegética ainda não disponível", undefined, 0)),
  desbloquearContato: () => Promise.reject(new ApiError("API da Internet diegética ainda não disponível", undefined, 0)),
  removerContato: () => Promise.reject(new ApiError("API da Internet diegética ainda não disponível", undefined, 0)),
  listarConversas: () => Promise.reject(new ApiError("API da Internet diegética ainda não disponível", undefined, 0)),
  obterPaginaMensagens: () => Promise.reject(new ApiError("API da Internet diegética ainda não disponível", undefined, 0)),
  enviarMensagem: () => Promise.reject(new ApiError("API da Internet diegética ainda não disponível", undefined, 0)),
  marcarLida: () => Promise.reject(new ApiError("API da Internet diegética ainda não disponível", undefined, 0)),
  iniciarConversaDireta: () => Promise.reject(new ApiError("API da Internet diegética ainda não disponível", undefined, 0)),
  criarGrupo: () => Promise.reject(new ApiError("API da Internet diegética ainda não disponível", undefined, 0)),
  convidarParaGrupo: () => Promise.reject(new ApiError("API da Internet diegética ainda não disponível", undefined, 0)),
  responderConviteGrupo: () => Promise.reject(new ApiError("API da Internet diegética ainda não disponível", undefined, 0)),
  sairDoGrupo: () => Promise.reject(new ApiError("API da Internet diegética ainda não disponível", undefined, 0)),
  renomearGrupo: () => Promise.reject(new ApiError("API da Internet diegética ainda não disponível", undefined, 0)),
  removerMembroGrupo: () => Promise.reject(new ApiError("API da Internet diegética ainda não disponível", undefined, 0)),
  obterDetalhesGrupo: () => Promise.reject(new ApiError("API da Internet diegética ainda não disponível", undefined, 0)),
};
