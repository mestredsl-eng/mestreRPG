// F4 / Issue #352 — S5/S6: thread de conversa (privada e grupo).
// Bolhas diegéticas, composer com limite de 4.000 caracteres (P8 —
// o servidor é autoridade; o contador é só conveniência), estados de
// envio (enviando/falhou com reenvio sob NOVO requestId, §2 do spec),
// paginação por cursor para histórico, e detalhes de grupo com as
// ações do contrato (convite com aceite explícito, sair, renomear,
// remover — sempre com confirmação modal nas destrutivas).

import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "../../Modal";
import { ModalConfirmar } from "../../Modal";
import type { AdaptadorInternet } from "./adaptador";
import type {
  ConexaoRealtime, DetalhesGrupo, EventoInternet, MensagemInternet,
  PaginaMensagens, ParticipanteGrupo,
} from "./tipos";
import { Carregando, ErroRetry } from "./estados";

const LIMITE_CARACTERES = 4000;

function formatarHora(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function novaChaveLocal(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function Bolha({ mensagem, mostrarAutor, aoReenviar, aoDescartar }: {
  mensagem: MensagemInternet;
  mostrarAutor: boolean;
  aoReenviar?: (m: MensagemInternet) => void;
  aoDescartar?: (m: MensagemInternet) => void;
}) {
  const falhou = mensagem.estadoEnvio === "falhou";
  const enviando = mensagem.estadoEnvio === "enviando";
  return (
    <li
      className={`internet-bolha ${mensagem.minha ? "internet-bolha-minha" : "internet-bolha-dele"} ${falhou ? "internet-bolha-falhou" : ""}`}
    >
      {mostrarAutor && !mensagem.minha && (
        <span className="internet-bolha-autor">@{mensagem.autorHandle}</span>
      )}
      <span>{mensagem.conteudo}</span>
      <span className="internet-bolha-meta">
        {formatarHora(mensagem.criadoEm)}
        {enviando && " · enviando…"}
        {falhou && " · não enviada"}
      </span>
      {falhou && aoReenviar && aoDescartar && (
        <span className="internet-bolha-estado" role="alert">
          <button type="button" className="secundario" onClick={() => aoReenviar(mensagem)}>
            Tentar novamente
          </button>
          <button type="button" className="perigo" onClick={() => aoDescartar(mensagem)}>
            Descartar
          </button>
        </span>
      )}
    </li>
  );
}

function LinhaMembro({ membro, souDono, minhaContaId, ocupado, acoes }: {
  membro: ParticipanteGrupo;
  souDono: boolean;
  minhaContaId: string;
  ocupado: boolean;
  acoes?: { rotulo: string; aoClicar: () => void; perigo?: boolean }[];
}) {
  return (
    <li className="internet-grupo-membro">
      <span className="crescer">
        @{membro.handle} <span className="internet-contato-nome">{membro.nomePersonagem}</span>
      </span>
      <span className={`internet-grupo-papel internet-grupo-papel-${membro.papel === "dono" ? "dono" : membro.status === "convidado" ? "convidado" : ""}`}>
        {membro.status === "convidado" ? "convidado" : membro.papel}
      </span>
      {souDono && membro.contaId !== minhaContaId && acoes?.map((a) => (
        <button key={a.rotulo} type="button" className={a.perigo ? "perigo" : "secundario"} onClick={a.aoClicar} disabled={ocupado}>
          {a.rotulo}
        </button>
      ))}
    </li>
  );
}

export default function Conversa({ adaptador, conversaId, nomeConversa, tipoConversa, conexao = "conectado", aoVoltar, aoMudarLista }: {
  adaptador: AdaptadorInternet;
  conversaId: string;
  nomeConversa: string;
  tipoConversa: "direta" | "grupo";
  conexao?: ConexaoRealtime;
  aoVoltar: () => void;
  /** avisa o pai para reordenar/atualizar a lista da caixa de entrada. */
  aoMudarLista?: () => void;
}) {
  const [mensagens, setMensagens] = useState<MensagemInternet[] | null>(null);
  const [cursorAnterior, setCursorAnterior] = useState<string | null>(null);
  const [erro, setErro] = useState(false);
  const [tentativa, setTentativa] = useState(0);
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [anuncio, setAnuncio] = useState("");
  const [detalhes, setDetalhes] = useState<DetalhesGrupo | null>(null);
  const [mostrarDetalhes, setMostrarDetalhes] = useState(false);
  const [confirmacao, setConfirmacao] = useState<{ titulo: string; mensagem: string; rotulo: string; perigo?: boolean; executar: () => Promise<void> } | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [erroAcao, setErroAcao] = useState<string | null>(null);
  const fundoRef = useRef<HTMLDivElement>(null);
  const idsRef = useRef<Set<string>>(new Set());

  const reconectando = conexao !== "conectado";

  const mesclar = useCallback((novas: MensagemInternet[]) => {
    setMensagens((atual) => {
      const base = atual ?? [];
      const vistos = new Set(base.map((m) => m.id));
      const adicionadas = novas.filter((m) => !vistos.has(m.id));
      if (!adicionadas.length) return base;
      return [...base, ...adicionadas];
    });
  }, []);

  const carregar = useCallback(async (cursor?: string | null) => {
    const pagina: PaginaMensagens = await adaptador.obterPaginaMensagens(conversaId, cursor ?? null);
    if (cursor) {
      // prepend histórico mais antigo mantendo ordem cronológica
      setMensagens((atual) => {
        const base = atual ?? [];
        const vistos = new Set(base.map((m) => m.id));
        return [...pagina.mensagens.filter((m) => !vistos.has(m.id)), ...base];
      });
    } else {
      idsRef.current = new Set(pagina.mensagens.map((m) => m.id));
      setMensagens(pagina.mensagens);
    }
    setCursorAnterior(pagina.cursorAnterior);
    // leitura avança o cursor do participante (servidor, mesma linha)
    void adaptador.marcarLida(conversaId).catch(() => {});
  }, [adaptador, conversaId]);

  useEffect(() => {
    let vivo = true;
    setErro(false);
    setMensagens(null);
    const iniciar = async () => {
      // Grupo: resolve o status do participante ANTES do histórico —
      // `convidado` não lê mensagens (servidor 403) mas PRECISA ver o
      // banner de convite; sem isso a tela caía em ErroRetry e o aceite
      // ficava inalcançável (defeito achado no E2E real #352).
      if (tipoConversa === "grupo") {
        try {
          const d = await adaptador.obterDetalhesGrupo(conversaId);
          if (!vivo) return;
          setDetalhes(d);
          if (d.meuStatusParticipante === "convidado") {
            setMensagens([]);
            return;
          }
        } catch { /* detalhe falhou → segue p/ o carregamento normal, que falha honesto */ }
      }
      await carregar().catch(() => { if (vivo) setErro(true); });
    };
    void iniciar();
    return () => { vivo = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adaptador, conversaId, tentativa, tipoConversa]);

  // Realtime F3: eventos chegam por usuario:{id} — aqui só reagimos a
  // ESTA conversa; revalidação de autorização já ocorreu no servidor.
  useEffect(() => {
    const desc = adaptador.inscreverEventos?.((ev: EventoInternet) => {
      if (ev.tipo !== "mensagem" || ev.conversaId !== conversaId) return;
      const m = ev.mensagem;
      if (idsRef.current.has(m.id)) return;
      idsRef.current.add(m.id);
      mesclar([m]);
      if (!m.minha) {
        setAnuncio(`Nova mensagem de @${m.autorHandle}`);
        void adaptador.marcarLida(conversaId).catch(() => {});
        aoMudarLista?.();
      }
    });
    return desc;
  }, [adaptador, conversaId, mesclar, aoMudarLista]);

  // autoscroll ao final em nova mensagem própria/recebida (não ao carregar histórico)
  const ultimosIds = mensagens?.slice(-1)[0]?.id;
  useEffect(() => {
    fundoRef.current?.scrollIntoView({ block: "end" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ultimosIds]);

  const enviar = async (m?: MensagemInternet) => {
    const conteudo = (m ? m.conteudo : texto).trim();
    if (!conteudo || enviando || reconectando) return;
    setEnviando(true);
    const requestId = novaChaveLocal(); // reenvio de falha usa chave NOVA (§2 spec)
    const localId = `local-${requestId}`;
    const otimista: MensagemInternet = m
      ? { ...m, estadoEnvio: "enviando", requestId }
      : {
          id: localId, conversaId, contaIdAutor: "", autorHandle: "você",
          autorNome: "", tipo: "texto", conteudo, criadoEm: new Date().toISOString(),
          requestId, minha: true, estadoEnvio: "enviando",
        };
    if (!m) {
      setMensagens((at) => [...(at ?? []), otimista]);
      setTexto("");
    } else {
      setMensagens((at) => (at ?? []).map((x) => x.id === m.id ? otimista : x));
    }
    try {
      const r = await adaptador.enviarMensagem(conversaId, conteudo, requestId);
      setMensagens((at) => (at ?? []).map((x) => (x.id === otimista.id || x.id === m?.id ? r.mensagem : x)));
      idsRef.current.add(r.mensagem.id);
      aoMudarLista?.();
    } catch {
      setMensagens((at) => (at ?? []).map((x) =>
        x.id === otimista.id || x.id === m?.id ? { ...otimista, estadoEnvio: "falhou" as const } : x));
    } finally {
      setEnviando(false);
    }
  };

  const descartar = (m: MensagemInternet) => {
    setMensagens((at) => (at ?? []).filter((x) => x.id !== m.id));
  };

  const carregarDetalhes = async () => {
    if (tipoConversa !== "grupo") return;
    setErroAcao(null);
    try {
      setDetalhes(await adaptador.obterDetalhesGrupo(conversaId));
      setMostrarDetalhes(true);
    } catch {
      setErroAcao("Não foi possível carregar os detalhes do grupo.");
    }
  };

  const executarConfirmado = async () => {
    if (!confirmacao) return;
    setOcupado(true);
    setErroAcao(null);
    try {
      await confirmacao.executar();
      setConfirmacao(null);
      setMostrarDetalhes(false);
      aoMudarLista?.();
      aoVoltar();
    } catch {
      setErroAcao("A ação não foi concluída. Tente novamente.");
      setConfirmacao(null);
    } finally {
      setOcupado(false);
    }
  };

  const ehGrupo = tipoConversa === "grupo";
  const mostrarAutor = ehGrupo;

  return (
    <section className="internet-thread" aria-label={`Conversa ${nomeConversa}`}>
      <header className="internet-thread-cab">
        <button type="button" className="secundario internet-thread-voltar" onClick={aoVoltar}>
          ← Voltar
        </button>
        <div className="crescer">
          <strong>{nomeConversa}</strong>{" "}
          <span className={`internet-chip-tipo ${ehGrupo ? "internet-chip-grupo" : "internet-chip-direto"}`}>
            {ehGrupo ? "grupo" : "direta"}
          </span>
        </div>
        {reconectando && (
          <span className="internet-rede-banner internet-rede-banner-reconectando" role="status">
            Reconectando… o histórico continua legível.
          </span>
        )}
        {ehGrupo && (
          <button type="button" className="secundario" onClick={() => void carregarDetalhes()}>
            Detalhes do grupo
          </button>
        )}
      </header>

      {erro ? (
        <ErroRetry mensagem="Não foi possível carregar a conversa." aoTentar={() => setTentativa((t) => t + 1)} />
      ) : !mensagens ? (
        <Carregando rotulo="Carregando mensagens…" />
      ) : (
        <>
          {cursorAnterior && (
            <button
              type="button"
              className="secundario"
              onClick={() => void carregar(cursorAnterior).catch(() => setErro(true))}
            >
              Carregar mensagens anteriores
            </button>
          )}
          <ul className="internet-mensagens" aria-label="Mensagens da conversa">
            {mensagens.map((m) => (
              <Bolha
                key={m.id}
                mensagem={m}
                mostrarAutor={mostrarAutor}
                aoReenviar={(x) => void enviar(x)}
                aoDescartar={descartar}
              />
            ))}
          </ul>
          <div ref={fundoRef} />
          <p className="internet-sr-only" aria-live="polite">{anuncio}</p>

          {detalhes?.meuStatusParticipante === "convidado" ? (
            <div className="internet-rede-banner" role="status">
              Você foi convidado para este grupo.{" "}
              <button
                type="button"
                className="primario"
                disabled={ocupado}
                onClick={() => {
                  setOcupado(true);
                  void adaptador.responderConviteGrupo(conversaId, true)
                    .catch(() => setErroAcao("Não foi possível aceitar o convite."))
                    .finally(() => {
                      setOcupado(false);
                      // recarrega o status SEM abrir o painel de detalhes —
                      // o usuário cai direto no composer, não num modal
                      void adaptador.obterDetalhesGrupo(conversaId)
                        .then(setDetalhes)
                        .catch(() => {});
                    });
                }}
              >Aceitar convite</button>{" "}
              <button
                type="button"
                className="secundario"
                disabled={ocupado}
                onClick={() => {
                  setOcupado(true);
                  void adaptador.responderConviteGrupo(conversaId, false)
                    .catch(() => setErroAcao("Não foi possível recusar o convite."))
                    .finally(() => { setOcupado(false); aoVoltar(); });
                }}
              >Recusar</button>
            </div>
          ) : (
            <form
              className="internet-composer"
              onSubmit={(e) => { e.preventDefault(); void enviar(); }}
              aria-label="Enviar mensagem"
            >
              <label htmlFor="internet-msg-texto" className="internet-sr-only">Mensagem</label>
              <textarea
                id="internet-msg-texto"
                value={texto}
                onChange={(e) => setTexto(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void enviar(); }
                }}
                placeholder={ehGrupo ? "Escrever mensagem no grupo…" : "Escrever mensagem…"}
                maxLength={LIMITE_CARACTERES}
                disabled={reconectando}
                rows={2}
              />
              <span className={`internet-composer-contador ${texto.length > LIMITE_CARACTERES * 0.9 ? "perto-do-limite" : ""}`}>
                {texto.length}/{LIMITE_CARACTERES}
              </span>
              <button type="submit" className="primario" disabled={!texto.trim() || enviando || reconectando}>
                {enviando ? "Enviando…" : "Enviar"}
              </button>
            </form>
          )}
          {erroAcao && <p className="erro" role="alert">{erroAcao}</p>}
        </>
      )}

      {mostrarDetalhes && detalhes && (
        <Modal
          titulo={`Grupo: ${detalhes.nome}`}
          aoFechar={() => setMostrarDetalhes(false)}
          ocupado={ocupado}
        >
          <h3>Membros</h3>
          <ul className="internet-grupo-membros">
            {detalhes.membros.map((m) => (
              <LinhaMembro
                key={m.contaId}
                membro={m}
                souDono={detalhes.papelMinhaConta === "dono"}
                minhaContaId={detalhes.minhaContaId}
                ocupado={ocupado}
                acoes={[
                  {
                    rotulo: "Remover",
                    perigo: true,
                    aoClicar: () => setConfirmacao({
                      titulo: `Remover @${m.handle} do grupo?`,
                      mensagem: "O membro perde acesso às novas mensagens; o histórico já trocado é preservado.",
                      rotulo: "Remover membro", perigo: true,
                      executar: () => adaptador.removerMembroGrupo(conversaId, m.contaId),
                    }),
                  },
                ]}
              />
            ))}
          </ul>

          {detalhes.meuStatusParticipante === "ativo" && detalhes.papelMinhaConta === "dono" && (
            <DetalhesDono
              adaptador={adaptador}
              conversaId={conversaId}
              detalhes={detalhes}
              ocupado={ocupado}
              setOcupado={setOcupado}
              setErroAcao={setErroAcao}
            />
          )}
          {detalhes.meuStatusParticipante === "ativo" && detalhes.papelMinhaConta !== "dono" && (
            <button
              type="button"
              className="perigo"
              disabled={ocupado}
              onClick={() => setConfirmacao({
                titulo: `Sair do grupo ${detalhes.nome}?`,
                mensagem: "Você deixará de receber mensagens deste grupo. Para voltar, será preciso um novo convite.",
                rotulo: "Sair do grupo", perigo: true,
                executar: () => adaptador.sairDoGrupo(conversaId),
              })}
            >
              Sair do grupo
            </button>
          )}
        </Modal>
      )}

      {confirmacao && (
        <ModalConfirmar
          titulo={confirmacao.titulo}
          mensagem={confirmacao.mensagem}
          rotuloConfirmar={confirmacao.rotulo}
          perigo={confirmacao.perigo}
          ocupado={ocupado}
          aoConfirmar={() => void executarConfirmado()}
          aoCancelar={() => setConfirmacao(null)}
        />
      )}
    </section>
  );
}

/** Bloco do dono do grupo: renomear + convidar (somente contatos aceitos,
 *  P4) + listar status dos participantes. */
function DetalhesDono({ adaptador, conversaId, detalhes, ocupado, setOcupado, setErroAcao }: {
  adaptador: AdaptadorInternet;
  conversaId: string;
  detalhes: DetalhesGrupo;
  ocupado: boolean;
  setOcupado: (v: boolean) => void;
  setErroAcao: (v: string | null) => void;
}) {
  const [nome, setNome] = useState(detalhes.nome);
  const [contas, setContas] = useState<{ contaId: string; handle: string; nomePersonagem: string }[]>([]);
  const [selecionada, setSelecionada] = useState("");

  useEffect(() => {
    let vivo = true;
    // candidatos a convite: contatos aceitos que ainda não são membros ativos
    adaptador.listarContatos()
      .then((c) => {
        if (!vivo) return;
        const naConversa = new Set(detalhes.membros.filter((m) => m.status === "ativo" || m.status === "convidado").map((m) => m.contaId));
        setContas(c.aceitos.filter((x) => !naConversa.has(x.contaId)));
      })
      .catch(() => {});
    return () => { vivo = false; };
  }, [adaptador, detalhes.membros]);

  return (
    <div className="internet-grupo-dono">
      <p>
        <label htmlFor="internet-renomear-grupo">Renomear grupo</label>
        <span className="internet-rede-form">
          <input
            id="internet-renomear-grupo"
            type="text"
            value={nome}
            onChange={(e) => setNome(e.target.value)}
            maxLength={80}
          />
          <button
            type="button"
            className="secundario"
            disabled={ocupado || !nome.trim() || nome.trim() === detalhes.nome}
            onClick={() => {
              setOcupado(true);
              void adaptador.renomearGrupo(conversaId, nome.trim())
                .catch(() => setErroAcao("Não foi possível renomear o grupo."))
                .finally(() => setOcupado(false));
            }}
          >Renomear</button>
        </span>
      </p>
      <p>
        <label htmlFor="internet-convidar-grupo">Convidar contato aceito</label>
        <span className="internet-rede-form">
          <select
            id="internet-convidar-grupo"
            value={selecionada}
            onChange={(e) => setSelecionada(e.target.value)}
          >
            <option value="">Escolha um contato…</option>
            {contas.map((c) => (
              <option key={c.contaId} value={c.contaId}>@{c.handle} — {c.nomePersonagem}</option>
            ))}
          </select>
          <button
            type="button"
            className="secundario"
            disabled={ocupado || !selecionada}
            onClick={() => {
              setOcupado(true);
              void adaptador.convidarParaGrupo(conversaId, selecionada)
                .catch(() => setErroAcao("Não foi possível enviar o convite."))
                .finally(() => setOcupado(false));
            }}
          >Convidar</button>
        </span>
        <span className="meta"> O convidado precisa aceitar explicitamente para participar.</span>
      </p>
    </div>
  );
}
