// F4 / Issue #352 — adaptador REAL da Internet diegética.
// Implementa AdaptadorInternet sobre o contrato publicado pelo PAI
// (PR #362 / #350): REST `/api/campaigns/:cid/internet/*` + socket
// `internet:mensagem:enviar` (ACK idempotente) e pushes
// `internet:mensagem`/`internet:contato` (fan-out individual F3).
//
// Lacunas de contrato conhecidas (reportadas ao PAI — métodos
// correspondentes rejeitam com ERRO_API_PENDENTE, nunca fingem sucesso):
//  - GET /conversations não retorna preview da última mensagem nem
//    contagem de não lidas → inbox mostra conversa sem badge por ora;
//    (o id do participante é exposto desde d3174ea — responderConviteGrupo
//    resolve o pid do detalhe e chama POST /participants/:pid/responder);
//  - não há endpoints de renomear grupo, remover membro ou desbloquear
//    contato (DELETE /contacts/:id existe, mas semântica de desbloqueio
//    não está no contrato);
//  - paginação de mensagens é SOMENTE para frente (createdAt,id): o
//    adaptador percorre as páginas até o fim para montar o histórico —
//    correto, mas O(n) por abertura de conversa.

import { getSocket } from "../../socket";
import { ApiError } from "../../api";
import type { AdaptadorInternet } from "./adaptador";
import type {
  ContaInternet, ContatoInternet, ContatosInternet, ConversaResumo,
  DetalhesGrupo, EventoInternet, MensagemInternet, PaginaMensagens,
  ResultadoEnvio,
} from "./tipos";

const API = "/api";
/** páginas de 100 (máx. do servidor) × 40 = 4.000 mensagens por conversa —
 *  acima disso falhamos de forma honesta em vez de truncar histórico. */
const LIMITE_PAGINA = 100;
const MAX_PAGINAS = 40;

interface ContaPublica { id: string; handle: string; displayName: string }
interface ContatoApi {
  id: string; status: string; souOrigem: boolean;
  origem: ContaPublica | null; destino: ContaPublica | null;
}
interface ParticipanteApi {
  id: string; // id da linha internet_participantes (pid do /responder)
  contaId: string; papel: string; status: string;
  conta: ContaPublica | null;
}
interface ConversaApi {
  id: string; tipo: "direta" | "grupo"; nome: string | null; status: string;
  participantes: ParticipanteApi[];
  meuContaId: string | null; meuPapel: string | null; meuStatus: string | null;
}
interface ConversaDetalheApi {
  id: string; tipo: string; nome: string | null; status: string;
  participantes: ParticipanteApi[];
}
interface MensagemApi {
  id: string; conversaId: string; contaId: string;
  autor: { id: string; handle: string; displayName: string } | null;
  conteudo: string; createdAt: string;
}

async function requisicao<T>(caminho: string, opcoes: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${caminho}`, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(opcoes.headers ?? {}) },
    ...opcoes,
  });
  const corpo = await res.json().catch(() => ({}));
  if (!res.ok) {
    const c = corpo as { erro?: string; mensagem?: string };
    throw new ApiError(c.mensagem ?? c.erro ?? `HTTP ${res.status}`, corpo, res.status);
  }
  return corpo as T;
}

const pendente = () => Promise.reject(new ApiError("Endpoint ainda não disponível no contrato F2", undefined, 0));

export function criarAdaptadorInternetApi({ campaignId, characterId }: {
  campaignId: string;
  characterId: string;
}): AdaptadorInternet {
  const base = `/campaigns/${campaignId}/internet`;
  // mesmo socket singleton da aplicação (autenticado no handshake) —
  // o fan-out F3 entrega em usuario:{userId} sem rooms de conteúdo
  const getSock = () => getSocket();

  let contaCache: Promise<ContaInternet | null> | null = null;
  const minhaConta = () => {
    contaCache ??= requisicao<{ conta: ContaPublica | null }>(`${base}/account?characterId=${encodeURIComponent(characterId)}`)
      .then((r) => (r.conta ? { id: r.conta.id, handle: r.conta.handle, nomePersonagem: r.conta.displayName } : null))
      .catch((e) => { contaCache = null; throw e; });
    return contaCache;
  };

  /** contaId da MINHA conta para payloads de ação (origem das arestas). */
  const meuContaId = async () => (await minhaConta())?.id ?? null;

  /** última mensagem conhecida por conversa — alimenta POST /read. */
  const ultimaPorConversa = new Map<string, { createdAtMs: number; id: string }>();
  const registrarUltima = (conversaId: string, m: { id: string; createdAt: string }) => {
    ultimaPorConversa.set(conversaId, { createdAtMs: Date.parse(m.createdAt), id: m.id });
  };

  const paraMensagem = (m: MensagemApi, contaId: string | null): MensagemInternet => ({
    id: m.id,
    conversaId: m.conversaId,
    contaIdAutor: m.contaId,
    autorHandle: m.autor?.handle ?? "?",
    autorNome: m.autor?.displayName ?? "",
    tipo: "texto",
    conteudo: m.conteudo,
    criadoEm: m.createdAt,
    requestId: "",
    minha: contaId !== null && m.contaId === contaId,
    estadoEnvio: "enviada",
  });

  return {
    obterConta: () => minhaConta(),

    // ---------- contatos ----------
    async listarContatos(): Promise<ContatosInternet> {
      const r = await requisicao<{ contatos: ContatoApi[] }>(`${base}/contacts`);
      const paraUi = (c: ContatoApi): ContatoInternet | null => {
        // a outra ponta da aresta, na ótica do usuário
        const outra = c.souOrigem ? c.destino : c.origem;
        if (!outra) return null;
        return {
          id: c.id, contaId: outra.id, handle: outra.handle,
          nomePersonagem: outra.displayName,
          estado: c.status as ContatoInternet["estado"],
          direcao: c.souOrigem ? "enviado" : "recebido",
        };
      };
      const out: ContatosInternet = { aceitos: [], pedidosRecebidos: [], pedidosEnviados: [], bloqueados: [] };
      for (const c of r.contatos) {
        const ui = paraUi(c);
        if (!ui) continue;
        // arestas que não tocam a conta do personagem atual seguem visíveis
        // (o servidor já restringe às contas do usuário; multi-personagem
        // aparece agregado — refinamento de filtro por conta é incremental)
        if (ui.estado === "aceito") out.aceitos.push(ui);
        else if (ui.estado === "bloqueado") out.bloqueados.push(ui);
        else if (ui.direcao === "enviado") out.pedidosEnviados.push(ui);
        else out.pedidosRecebidos.push(ui);
      }
      return out;
    },

    async enviarPedidoContato(handle: string) {
      const h = handle.trim().replace(/^@/, "").toLowerCase();
      const dir = await requisicao<{ contas: ContaPublica[] }>(`${base}/accounts`);
      const alvo = dir.contas.find((c) => c.handle.toLowerCase() === h);
      if (!alvo) throw new ApiError("Conta não encontrada", undefined, 404);
      const origem = await meuContaId();
      await requisicao(`${base}/contacts`, {
        method: "POST",
        body: JSON.stringify({ contaId: alvo.id, ...(origem ? { origemContaId: origem } : {}) }),
      });
    },

    // o F2 decide por aresta (:id) — o id já vem do GET /contacts
    async responderPedidoContato(contatoId: string, aceitar: boolean) {
      await requisicao(`${base}/contacts/${contatoId}/${aceitar ? "aceitar" : "recusar"}`, { method: "POST", body: "{}" });
    },

    cancelarPedidoContato: (contatoId) => requisicao(`${base}/contacts/${contatoId}`, { method: "DELETE" }).then(() => {}),
    bloquearContato: (contatoId) => requisicao(`${base}/contacts/${contatoId}/bloquear`, { method: "POST", body: "{}" }).then(() => {}),
    // desbloqueio não está no contrato F2 — falha honesta até deliberação
    desbloquearContato: () => pendente(),
    removerContato: (contatoId) => requisicao(`${base}/contacts/${contatoId}`, { method: "DELETE" }).then(() => {}),

    // ---------- conversas ----------
    async listarConversas(): Promise<ConversaResumo[]> {
      const r = await requisicao<{ conversas: (ConversaApi & { meuContaId: string | null })[] }>(`${base}/conversations`);
      return r.conversas
        .filter((c) => c.status === "ativa")
        .map((c) => {
          const outros = c.participantes.filter((p) => p.status === "ativo" && p.contaId !== c.meuContaId);
          const interlocutor = c.tipo === "direta" && outros[0]?.conta
            ? { contaId: outros[0].conta.id, handle: outros[0].conta.handle, nomePersonagem: outros[0].conta.displayName }
            : null;
          return {
            id: c.id, tipo: c.tipo, nome: c.nome, interlocutor,
            ultimaMensagem: null, // lacuna de contrato — ver cabeçalho
            naoLidas: 0,
            atualizadoEm: "", // ordenação por updatedAt não exposta; ordem do servidor
            status: c.status as ConversaResumo["status"],
          };
        });
    },

    async obterPaginaMensagens(conversaId: string, cursor?: string | null): Promise<PaginaMensagens> {
      const contaId = await meuContaId();
      const todas: MensagemInternet[] = [];
      let cur = cursor ?? null;
      for (let i = 0; i < MAX_PAGINAS; i++) {
        const q = new URLSearchParams({ limit: String(LIMITE_PAGINA) });
        if (cur) q.set("cursor", cur);
        const r = await requisicao<{ mensagens: MensagemApi[]; proximoCursor: string | null }>(
          `${base}/conversations/${conversaId}/messages?${q}`);
        for (const m of r.mensagens) {
          todas.push(paraMensagem(m, contaId));
          registrarUltima(conversaId, m);
        }
        if (!r.proximoCursor) break;
        cur = r.proximoCursor;
        if (i === MAX_PAGINAS - 1) {
          throw new ApiError("Histórico extenso demais para carregar de uma vez", undefined, 0);
        }
      }
      return {
        mensagens: todas,
        cursorAnterior: null, // paginação só avança — histórico chega completo
        cursorLeitura: { lastReadCreatedAt: null, lastReadMessageId: null },
      };
    },

    async enviarMensagem(conversaId: string, conteudo: string, requestId: string): Promise<ResultadoEnvio> {
      const contaId = await meuContaId();
      if (!contaId) throw new ApiError("Personagem sem conta", undefined, 403);
      const ack = await new Promise<Record<string, unknown>>((resolve, reject) => {
        getSock().timeout(10000).emit(
          "internet:mensagem:enviar",
          { conversaId, contaId, requestId, conteudo },
          (err: Error | null, res?: Record<string, unknown>) => {
            if (err) reject(new ApiError("Tempo esgotado no envio", undefined, 0));
            else if (res && res.ok === true) resolve(res);
            else reject(new ApiError(String(res?.erro ?? "falha_interna"), res, 0));
          },
        );
      });
      const m: MensagemInternet = {
        id: String(ack.mensagemId), conversaId,
        contaIdAutor: contaId,
        autorHandle: (await minhaConta())?.handle ?? "você",
        autorNome: "",
        tipo: "texto", conteudo,
        criadoEm: String(ack.createdAt),
        requestId,
        minha: true, estadoEnvio: "enviada",
      };
      registrarUltima(conversaId, { id: m.id, createdAt: m.criadoEm });
      return { mensagem: m, replay: ack.replay === true };
    },

    async marcarLida(conversaId: string) {
      const contaId = await meuContaId();
      const ultima = ultimaPorConversa.get(conversaId);
      if (!contaId || !ultima || !Number.isFinite(ultima.createdAtMs)) return;
      await requisicao(`${base}/conversations/${conversaId}/read`, {
        method: "POST",
        body: JSON.stringify({ contaId, ateCreatedAt: ultima.createdAtMs, ateMessageId: ultima.id }),
      });
    },

    // ---------- criação e grupos ----------
    async iniciarConversaDireta(contaId: string) {
      const origem = await meuContaId();
      const r = await requisicao<{ conversa: string }>(`${base}/conversations`, {
        method: "POST",
        body: JSON.stringify({ tipo: "direta", contaDestinoId: contaId, ...(origem ? { origemContaId: origem } : {}) }),
      });
      return { conversaId: r.conversa };
    },

    async criarGrupo(nome: string, contaIds: string[]) {
      const origem = await meuContaId();
      const r = await requisicao<{ conversa: string }>(`${base}/conversations`, {
        method: "POST",
        body: JSON.stringify({ tipo: "grupo", nome, contaIds, ...(origem ? { origemContaId: origem } : {}) }),
      });
      return { conversaId: r.conversa };
    },

    async convidarParaGrupo(conversaId: string, contaId: string) {
      const origem = await meuContaId();
      await requisicao(`${base}/conversations/${conversaId}/participants`, {
        method: "POST",
        body: JSON.stringify({ contaId, ...(origem ? { origemContaId: origem } : {}) }),
      });
    },

    async responderConviteGrupo(conversaId: string, aceitar: boolean) {
      // d3174ea expõe o id da linha internet_participantes no detalhe —
      // resolve o MEU pid de convidado e responde pelo endpoint real.
      const contaId = await meuContaId();
      const r = await requisicao<{ conversa: ConversaDetalheApi }>(`${base}/conversations/${conversaId}`);
      const meu = r.conversa.participantes.find((p) => p.contaId === contaId && p.status === "convidado");
      if (!meu) throw new ApiError("Convite de grupo não encontrado", undefined, 404);
      await requisicao(`${base}/conversations/${conversaId}/participants/${meu.id}/responder`, {
        method: "POST",
        body: JSON.stringify({ aceitar }),
      });
    },
    sairDoGrupo: async (conversaId: string) => {
      const contaId = await meuContaId();
      if (!contaId) throw new ApiError("Personagem sem conta", undefined, 403);
      await requisicao(`${base}/conversations/${conversaId}/leave`, {
        method: "POST", body: JSON.stringify({ contaId }),
      });
    },
    renomearGrupo: () => pendente(),
    removerMembroGrupo: () => pendente(),

    async obterDetalhesGrupo(conversaId: string): Promise<DetalhesGrupo> {
      const r = await requisicao<{ conversa: ConversaDetalheApi }>(`${base}/conversations/${conversaId}`);
      const c = r.conversa;
      const meuId = await meuContaId();
      const meu = c.participantes.find((p) => p.contaId === meuId);
      return {
        conversaId: c.id,
        nome: c.nome ?? "Grupo",
        papelMinhaConta: (meu?.papel === "dono" ? "dono" : "membro") as DetalhesGrupo["papelMinhaConta"],
        meuStatusParticipante: (meu?.status ?? "ativo") as DetalhesGrupo["meuStatusParticipante"],
        minhaContaId: meuId ?? "",
        membros: c.participantes.map((p) => ({
          contaId: p.contaId,
          handle: p.conta?.handle ?? "?",
          nomePersonagem: p.conta?.displayName ?? "",
          papel: (p.papel === "dono" ? "dono" : "membro") as DetalhesGrupo["membros"][number]["papel"],
          status: p.status as DetalhesGrupo["membros"][number]["status"],
        })),
      };
    },

    // ---------- realtime (F3) ----------
    inscreverEventos(ouvinte: (e: EventoInternet) => void) {
      const s = getSock();
      const onMensagem = (raw: Record<string, unknown>) => {
        const autor = raw.autor as { contaId?: string; handle?: string; displayName?: string } | undefined;
        void minhaConta().then((conta) => {
          ouvinte({
            tipo: "mensagem",
            conversaId: String(raw.conversaId),
            mensagem: {
              id: String(raw.mensagemId), conversaId: String(raw.conversaId),
              contaIdAutor: autor?.contaId ?? String(raw.contaId ?? ""),
              autorHandle: autor?.handle ?? "?", autorNome: autor?.displayName ?? "",
              tipo: "texto", conteudo: String(raw.conteudo ?? ""),
              criadoEm: String(raw.createdAt), requestId: String(raw.requestId ?? ""),
              // "minha" = autor é a MINHA conta (sync de outro dispositivo)
              minha: conta !== null && autor?.contaId === conta.id,
              estadoEnvio: "enviada",
            },
          });
          registrarUltima(String(raw.conversaId), { id: String(raw.mensagemId), createdAt: String(raw.createdAt) });
        }).catch(() => {});
      };
      const onContato = (raw: Record<string, unknown>) => {
        ouvinte({ tipo: "contato", contatoId: String(raw.contatoId), status: String(raw.status) });
      };
      s.on("internet:mensagem", onMensagem);
      s.on("internet:contato", onContato);
      return () => {
        s.off("internet:mensagem", onMensagem);
        s.off("internet:contato", onContato);
      };
    },

    estadoConexao: () => (getSock().connected ? "conectado" : "reconectando"),
  };
}
