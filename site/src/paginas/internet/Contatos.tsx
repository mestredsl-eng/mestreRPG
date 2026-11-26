// F4 / Issue #352 — S3: contatos da conta diegética.
// Arestas dirigidas do contrato §4: pedidos enviados/recebidos são
// unilaterais; aceite cria a aresta `aceito`; bloqueio é bilateral de
// facto (P3) — a UI sempre confirma antes de bloquear/remover/sair.

import { useEffect, useState } from "react";
import { ModalConfirmar } from "../../Modal";
import type { AdaptadorInternet } from "./adaptador";
import type { ContatoInternet, ContatosInternet, EventoInternet } from "./tipos";
import { Carregando, ErroRetry, Vazio } from "./estados";

type SubAba = "aceitos" | "recebidos" | "enviados" | "bloqueados";

const SUBABAS: { id: SubAba; rotulo: string }[] = [
  { id: "aceitos", rotulo: "Aceitos" },
  { id: "recebidos", rotulo: "Pedidos recebidos" },
  { id: "enviados", rotulo: "Pedidos enviados" },
  { id: "bloqueados", rotulo: "Bloqueados" },
];

interface AcaoPendente {
  titulo: string;
  mensagem: string;
  rotulo: string;
  perigo?: boolean;
  executar: () => Promise<void>;
}

function LinhaContato({ contato, acoes, ocupado }: {
  contato: ContatoInternet;
  acoes?: { rotulo: string; aoClicar: () => void; perigo?: boolean; desabilitado?: boolean }[];
  ocupado?: boolean;
}) {
  return (
    <li className="internet-contato-item cartao">
      <div className="crescer">
        <span className="internet-contato-handle">@{contato.handle}</span>{" "}
        <span className="internet-contato-nome">{contato.nomePersonagem}</span>
      </div>
      {acoes && acoes.length > 0 && (
        <div className="internet-contato-acoes">
          {acoes.map((a) => (
            <button
              key={a.rotulo}
              type="button"
              className={a.perigo ? "perigo" : "secundario"}
              onClick={a.aoClicar}
              disabled={ocupado || a.desabilitado}
            >
              {a.rotulo}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}

export default function Contatos({ adaptador, aoIniciarConversa }: {
  adaptador: AdaptadorInternet;
  /** Abre/cria conversa direta com um contato aceito. */
  aoIniciarConversa: (contaId: string) => void;
}) {
  const [dados, setDados] = useState<ContatosInternet | null>(null);
  const [erro, setErro] = useState(false);
  const [tentativa, setTentativa] = useState(0);
  const [subAba, setSubAba] = useState<SubAba>("aceitos");
  const [handleNovo, setHandleNovo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [erroAcao, setErroAcao] = useState<string | null>(null);
  const [confirmacao, setConfirmacao] = useState<AcaoPendente | null>(null);

  const recarregar = () => setTentativa((t) => t + 1);

  useEffect(() => {
    let vivo = true;
    setErro(false);
    adaptador.listarContatos()
      .then((c) => { if (vivo) setDados(c); })
      .catch(() => { if (vivo) { setDados(null); setErro(true); } });
    return () => { vivo = false; };
  }, [adaptador, tentativa]);

  // push F3 `internet:contato` → recarrega arestas (pedido novo/decidido)
  useEffect(() => {
    const desc = adaptador.inscreverEventos?.((ev: EventoInternet) => {
      if (ev.tipo === "contato") recarregar();
    });
    return desc;
  }, [adaptador]);

  const executarConfirmado = async () => {
    if (!confirmacao) return;
    setOcupado(true);
    setErroAcao(null);
    try {
      await confirmacao.executar();
      setConfirmacao(null);
      recarregar();
    } catch {
      setErroAcao("A ação não foi concluída. Tente novamente.");
      setConfirmacao(null);
    } finally {
      setOcupado(false);
    }
  };

  const pedir = (acao: Omit<AcaoPendente, "executar"> & { executar: () => Promise<void> }) =>
    setConfirmacao({ ...acao, executar: acao.executar });

  const enviarPedido = async () => {
    const h = handleNovo.trim().replace(/^@/, "");
    if (!h || enviando) return;
    setEnviando(true);
    setErroAcao(null);
    try {
      await adaptador.enviarPedidoContato(h);
      setHandleNovo("");
      recarregar();
    } catch {
      setErroAcao("Não foi possível enviar o pedido. Verifique o @handle e tente novamente.");
    } finally {
      setEnviando(false);
    }
  };

  if (erro) {
    return <ErroRetry mensagem="Não foi possível carregar os contatos." aoTentar={recarregar} />;
  }
  if (!dados) return <Carregando rotulo="Carregando contatos…" />;

  const CAMPOS: Record<SubAba, keyof ContatosInternet> = {
    aceitos: "aceitos",
    recebidos: "pedidosRecebidos",
    enviados: "pedidosEnviados",
    bloqueados: "bloqueados",
  };
  const lista: ContatoInternet[] = dados[CAMPOS[subAba]];
  const rotuloSub = SUBABAS.find((s) => s.id === subAba)?.rotulo ?? "";

  return (
    <section className="internet-contatos" aria-label="Contatos">
      <div className="internet-contatos-subabas" role="tablist" aria-label="Grupos de contatos">
        {SUBABAS.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={subAba === s.id}
            className={subAba === s.id ? "ativo" : "secundario"}
            onClick={() => setSubAba(s.id)}
          >
            {s.rotulo}
            {s.id === "recebidos" && dados.pedidosRecebidos.length > 0 &&
              ` (${dados.pedidosRecebidos.length})`}
          </button>
        ))}
      </div>

      <form
        className="internet-rede-form"
        onSubmit={(e) => { e.preventDefault(); void enviarPedido(); }}
        aria-label="Adicionar contato por handle"
      >
        <label htmlFor="internet-handle-novo" className="internet-sr-only">Handle do contato</label>
        <input
          id="internet-handle-novo"
          type="text"
          placeholder="@handle do personagem"
          value={handleNovo}
          onChange={(e) => setHandleNovo(e.target.value)}
          maxLength={64}
          autoComplete="off"
        />
        <button type="submit" className="primario" disabled={!handleNovo.trim() || enviando}>
          {enviando ? "Enviando…" : "Enviar pedido"}
        </button>
      </form>
      {erroAcao && <p className="erro" role="alert">{erroAcao}</p>}

      <h3 className="internet-sr-only">{rotuloSub}</h3>
      {lista.length === 0 ? (
        <Vazio
          titulo={
            subAba === "aceitos" ? "Nenhum contato aceito ainda" :
            subAba === "recebidos" ? "Nenhum pedido recebido" :
            subAba === "enviados" ? "Nenhum pedido enviado" :
            "Nenhum contato bloqueado"
          }
          dica={
            subAba === "aceitos"
              ? "Use o campo acima para enviar um pedido por @handle. O contato só é criado quando a outra pessoa aceitar."
              : undefined
          }
        />
      ) : (
        <ul className="internet-contatos-lista" aria-label={rotuloSub}>
          {lista.map((c) => {
            const acoes: { rotulo: string; aoClicar: () => void; perigo?: boolean; desabilitado?: boolean }[] = [];
            if (subAba === "aceitos") {
              acoes.push({ rotulo: "Conversar", aoClicar: () => aoIniciarConversa(c.contaId) });
              acoes.push({
                rotulo: "Bloquear", perigo: true,
                aoClicar: () => pedir({
                  titulo: `Bloquear @${c.handle}?`,
                  mensagem: "O bloqueio é bilateral: nenhum dos dois poderá enviar mensagens ao outro. O histórico existente é preservado.",
                  rotulo: "Bloquear", perigo: true,
                  executar: () => adaptador.bloquearContato(c.id),
                }),
              });
              acoes.push({
                rotulo: "Remover", perigo: true,
                aoClicar: () => pedir({
                  titulo: `Remover @${c.handle} dos contatos?`,
                  mensagem: "A conversa e o histórico são preservados; novos pedidos poderão ser enviados depois.",
                  rotulo: "Remover", perigo: true,
                  executar: () => adaptador.removerContato(c.id),
                }),
              });
            } else if (subAba === "recebidos") {
              acoes.push({
                rotulo: "Aceitar",
                aoClicar: () => {
                  setOcupado(true);
                  void adaptador.responderPedidoContato(c.contaId, true)
                    .catch(() => setErroAcao("Não foi possível aceitar o pedido."))
                    .finally(() => { setOcupado(false); recarregar(); });
                },
                desabilitado: ocupado,
              });
              acoes.push({
                rotulo: "Recusar", perigo: true,
                aoClicar: () => {
                  setOcupado(true);
                  void adaptador.responderPedidoContato(c.contaId, false)
                    .catch(() => setErroAcao("Não foi possível recusar o pedido."))
                    .finally(() => { setOcupado(false); recarregar(); });
                },
                desabilitado: ocupado,
              });
            } else if (subAba === "enviados") {
              acoes.push({
                rotulo: "Cancelar pedido", perigo: true,
                aoClicar: () => pedir({
                  titulo: `Cancelar pedido para @${c.handle}?`,
                  mensagem: "O pedido pendente será retirado. Você poderá enviar um novo pedido depois.",
                  rotulo: "Cancelar pedido", perigo: true,
                  executar: () => adaptador.cancelarPedidoContato(c.id),
                }),
              });
            } else {
              acoes.push({
                rotulo: "Desbloquear",
                aoClicar: () => {
                  setOcupado(true);
                  void adaptador.desbloquearContato(c.id)
                    .catch(() => setErroAcao("Não foi possível desbloquear."))
                    .finally(() => { setOcupado(false); recarregar(); });
                },
                desabilitado: ocupado,
              });
            }
            return <LinhaContato key={c.id} contato={c} acoes={acoes} ocupado={ocupado} />;
          })}
        </ul>
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
