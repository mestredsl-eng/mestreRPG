// F4 / Issue #352 — S4: caixa de entrada de conversas.
// Lista conversas diretas e grupos com badge de não lidas (sempre
// dentro do módulo — nunca notificação OOC). Criação de conversa
// direta usa somente contatos aceitos (P4); grupos exigem nome +
// contatos aceitos e convite com aceite explícito do convidado.

import { useEffect, useState } from "react";
import { Modal } from "../../Modal";
import type { AdaptadorInternet } from "./adaptador";
import type { ContatoInternet, ContatosInternet, ConversaResumo, EventoInternet } from "./tipos";
import { Carregando, ErroRetry, Vazio } from "./estados";

function formatarHora(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function LinhaConversa({ conversa, aoAbrir }: { conversa: ConversaResumo; aoAbrir: (c: ConversaResumo) => void }) {
  const nome = conversa.tipo === "grupo"
    ? (conversa.nome ?? "Grupo")
    : (conversa.interlocutor ? `@${conversa.interlocutor.handle}` : "Conversa");
  const preview = conversa.ultimaMensagem
    ? `${conversa.ultimaMensagem.autorHandle ? `@${conversa.ultimaMensagem.autorHandle}: ` : ""}${conversa.ultimaMensagem.conteudo}`
    : "Sem mensagens ainda";
  return (
    <li>
      <button type="button" className="internet-conversa-item secundario" onClick={() => aoAbrir(conversa)}>
        <span className="crescer">
          <span className="internet-conversa-nome">
            {nome}{" "}
            <span className={`internet-chip-tipo ${conversa.tipo === "grupo" ? "internet-chip-grupo" : "internet-chip-direto"}`}>
              {conversa.tipo === "grupo" ? "grupo" : "direta"}
            </span>
          </span>
          <span className="internet-conversa-preview">{preview}</span>
        </span>
        <span className="internet-conversa-meta">
          <span>{formatarHora(conversa.atualizadoEm)}</span>
          {conversa.naoLidas > 0 && (
            <span className="internet-badge-nao-lidas" aria-label={`${conversa.naoLidas} mensagens não lidas`}>
              {conversa.naoLidas > 99 ? "99+" : conversa.naoLidas}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

function SeletorContatos({ contatos, selecionados, aoAlternar, rotulo }: {
  contatos: ContatoInternet[];
  selecionados: Set<string>;
  aoAlternar: (contaId: string) => void;
  rotulo: string;
}) {
  if (contatos.length === 0) {
    return <p className="meta">Nenhum contato aceito disponível — adicione contatos primeiro.</p>;
  }
  return (
    <fieldset className="internet-rede-form" style={{ border: "none", padding: 0, margin: 0 }}>
      <legend className="internet-sr-only">{rotulo}</legend>
      {contatos.map((c) => (
        <label key={c.contaId} className="internet-contato-item" style={{ padding: "4px 0" }}>
          <input
            type="checkbox"
            checked={selecionados.has(c.contaId)}
            onChange={() => aoAlternar(c.contaId)}
          />
          <span>@{c.handle} <span className="internet-contato-nome">{c.nomePersonagem}</span></span>
        </label>
      ))}
    </fieldset>
  );
}

export default function Mensagens({ adaptador, aoAbrirConversa }: {
  adaptador: AdaptadorInternet;
  aoAbrirConversa: (conversa: ConversaResumo) => void;
}) {
  const [conversas, setConversas] = useState<ConversaResumo[] | null>(null);
  const [erro, setErro] = useState(false);
  const [tentativa, setTentativa] = useState(0);
  const [modal, setModal] = useState<"direta" | "grupo" | null>(null);
  const [aceitos, setAceitos] = useState<ContatoInternet[]>([]);
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const [nomeGrupo, setNomeGrupo] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [erroModal, setErroModal] = useState<string | null>(null);

  const recarregar = () => setTentativa((t) => t + 1);

  useEffect(() => {
    let vivo = true;
    setErro(false);
    adaptador.listarConversas()
      .then((c) => { if (vivo) setConversas(c); })
      .catch(() => { if (vivo) { setConversas(null); setErro(true); } });
    return () => { vivo = false; };
  }, [adaptador, tentativa]);

  // Realtime F3: nova mensagem/convite atualiza a lista (badge e ordem).
  // Conteúdo de conversa nunca passa por aqui — só ids para re-fetch.
  useEffect(() => {
    const desc = adaptador.inscreverEventos?.((ev: EventoInternet) => {
      if (ev.tipo === "mensagem" || ev.tipo === "conversa-atualizada" || ev.tipo === "convite" || ev.tipo === "contato") {
        recarregar();
      }
    });
    return desc;
  }, [adaptador]);

  const abrirModal = async (tipo: "direta" | "grupo") => {
    setModal(tipo);
    setErroModal(null);
    setSelecionados(new Set());
    setNomeGrupo("");
    try {
      const contatos: ContatosInternet = await adaptador.listarContatos();
      setAceitos(contatos.aceitos);
    } catch {
      setErroModal("Não foi possível carregar seus contatos aceitos.");
    }
  };

  const alternar = (contaId: string) => {
    setSelecionados((s) => {
      const n = new Set(s);
      if (n.has(contaId)) n.delete(contaId); else n.add(contaId);
      return n;
    });
  };

  const criar = async () => {
    if (ocupado) return;
    setOcupado(true);
    setErroModal(null);
    try {
      if (modal === "direta") {
        const [contaId] = selecionados;
        if (!contaId) { setOcupado(false); return; }
        const { conversaId } = await adaptador.iniciarConversaDireta(contaId);
        setModal(null);
        recarregar();
        // a lista recarrega; a conversa abre com rótulo genérico até o
        // resumo chegar — nome real aparece no próximo carregamento
        aoAbrirConversa({
          id: conversaId, tipo: "direta", nome: null, interlocutor: null,
          ultimaMensagem: null, naoLidas: 0, atualizadoEm: new Date().toISOString(),
          status: "ativa",
        });
      } else {
        if (!nomeGrupo.trim() || selecionados.size === 0) { setOcupado(false); return; }
        const { conversaId } = await adaptador.criarGrupo(nomeGrupo.trim(), [...selecionados]);
        setModal(null);
        recarregar();
        aoAbrirConversa({
          id: conversaId, tipo: "grupo", nome: nomeGrupo.trim(), interlocutor: null,
          ultimaMensagem: null, naoLidas: 0, atualizadoEm: new Date().toISOString(),
          status: "ativa",
        });
      }
    } catch {
      setErroModal("Não foi possível criar a conversa. Tente novamente.");
    } finally {
      setOcupado(false);
    }
  };

  if (erro) {
    return <ErroRetry mensagem="Não foi possível carregar suas conversas." aoTentar={recarregar} />;
  }
  if (!conversas) return <Carregando rotulo="Carregando conversas…" />;

  return (
    <section className="internet-inbox" aria-label="Caixa de entrada">
      <div className="linha" role="group" aria-label="Nova conversa">
        <button type="button" className="secundario" onClick={() => void abrirModal("direta")}>
          Nova conversa direta
        </button>
        <button type="button" className="secundario" onClick={() => void abrirModal("grupo")}>
          Novo grupo
        </button>
      </div>

      {conversas.length === 0 ? (
        <Vazio
          titulo="Nenhuma conversa ainda"
          dica="Suas mensagens privadas e grupos aparecem aqui. Comece adicionando um contato por @handle na aba Contatos."
        />
      ) : (
        <ul className="internet-inbox">
          {[...conversas]
            .sort((a, b) => b.atualizadoEm.localeCompare(a.atualizadoEm))
            .map((c) => (
              <LinhaConversa key={c.id} conversa={c} aoAbrir={aoAbrirConversa} />
            ))}
        </ul>
      )}

      {modal && (
        <Modal
          titulo={modal === "direta" ? "Nova conversa direta" : "Novo grupo"}
          aoFechar={() => setModal(null)}
          ocupado={ocupado}
          acoes={
            <>
              <button type="button" className="secundario" onClick={() => setModal(null)} disabled={ocupado}>
                Cancelar
              </button>
              <button
                type="button"
                className="primario"
                onClick={() => void criar()}
                disabled={ocupado || selecionados.size === 0 || (modal === "grupo" && !nomeGrupo.trim())}
              >
                {ocupado ? "Criando…" : modal === "direta" ? "Iniciar conversa" : "Criar grupo"}
              </button>
            </>
          }
        >
          {modal === "grupo" && (
            <p>
              <label htmlFor="internet-nome-grupo">Nome do grupo</label>
              <input
                id="internet-nome-grupo"
                type="text"
                value={nomeGrupo}
                onChange={(e) => setNomeGrupo(e.target.value)}
                maxLength={80}
                placeholder="Ex.: Caçada de quinta"
              />
            </p>
          )}
          <p className="meta">
            {modal === "direta"
              ? "Somente contatos aceitos podem receber conversa. Escolha um:"
              : "Somente contatos aceitos podem ser convidados, e cada um precisa aceitar o convite explicitamente."}
          </p>
          {erroModal && <p className="erro" role="alert">{erroModal}</p>}
          <SeletorContatos
            contatos={aceitos}
            selecionados={selecionados}
            aoAlternar={alternar}
            rotulo={modal === "direta" ? "Contato para conversa" : "Participantes do grupo"}
          />
        </Modal>
      )}
    </section>
  );
}
