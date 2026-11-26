import { useCallback, useEffect, useRef, useState } from "react";
import { getSocket } from "./socket";
import { api } from "./api";
import {
  apiProgressao,
  ApiErrorProgresso,
  type ElementoDisponivel,
  type Progressao,
} from "./api-progressao";

/**
 * Painel de progressão XP/Merit da ficha (Issue #124).
 *
 * - Jogador (dono): saldo, histórico, elementos compráveis com preço
 *   calculado pelo servidor e confirmação antes de gastar XP.
 * - Mestre: além disso, concede/remove XP com motivo (auditoria no
 *   servidor) e administra compras de qualquer personagem.
 *
 * Atualiza sozinho via socket "personagens:atualizados" do personagem.
 */
export default function ProgressaoXp({ characterId, ehMestre }: { characterId: string; ehMestre: boolean }) {
  const [prog, setProg] = useState<Progressao | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [confirmando, setConfirmando] = useState<ElementoDisponivel | null>(null);
  // formulário do mestre
  const [acaoXp, setAcaoXp] = useState<"conceder" | "remover">("conceder");
  const [qtdXp, setQtdXp] = useState("10");
  const [motivoXp, setMotivoXp] = useState("");
  // BUG_0006: erro de AÇÃO (compra/XP) sobrevive a recargas disparadas
  // por socket/GET — só é limpo quando uma nova ação começa ou sucede.
  const erroAcao = useRef(false);

  const carregar = useCallback(async () => {
    try {
      // Quem não é mestre nem dono (ex.: jogador lendo ficha de NPC
      // revelado) receberia 403 em /progressao — evitamos a consulta
      // desperdiçada e o erro, mesmo padrão do painel de Patrimônio.
      if (!ehMestre) {
        const det = await api.obterPersonagem(characterId);
        if (det?.personagem?.ehEu !== true) {
          setProg(null);
          setErro(null);
          return;
        }
      }
      setProg(await apiProgressao.obter(characterId));
      // Preserva erro de ação pendente (BUG_0006); erro de carga é limpo.
      setErro((atual) => (erroAcao.current ? atual : null));
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha ao carregar progressão");
    }
  }, [characterId, ehMestre]);

  useEffect(() => { void carregar(); }, [carregar]);

  // Tempo real: qualquer mutação do personagem (XP, compra, PATCH do
  // mestre, arquivamento) emite personagens:atualizados na campanha.
  useEffect(() => {
    const socket = getSocket();
    const aoMudar = (d: { characterId?: string } | undefined) => {
      if (d?.characterId === characterId) void carregar();
    };
    socket.on("personagens:atualizados", aoMudar);
    return () => { socket.off("personagens:atualizados", aoMudar); };
  }, [characterId, carregar]);

  const detalheErros = (e: unknown): string[] => {
    if (e instanceof ApiErrorProgresso) {
      const erros = (e.detalhes as { erros?: { mensagem?: string }[] } | undefined)?.erros;
      if (Array.isArray(erros)) return erros.map((x) => x?.mensagem).filter((x): x is string => !!x);
    }
    return [];
  };

  const comprar = async (el: ElementoDisponivel) => {
    if (ocupado) return;
    setOcupado(true);
    setErro(null);
    erroAcao.current = false;
    try {
      await apiProgressao.comprarNivel(characterId, { kind: el.kind, key: el.key, nivelAlvo: el.nivelAtual + 1 });
      setConfirmando(null);
      await carregar();
    } catch (e) {
      erroAcao.current = true;
      if (e instanceof ApiErrorProgresso && e.codigo === "regras_alteradas") {
        // Conflito de versão das regras (HTTP 409): nada foi debitado.
        // Recarrega saldo/histórico/preços da configuração vigente e
        // exige nova confirmação explícita — nunca repete a compra.
        setErro(e.message);
        setConfirmando(null);
        await carregar();
      } else {
        const msgs = detalheErros(e);
        setErro([e instanceof Error ? e.message : "Falha na compra", ...msgs].join(" — "));
        setConfirmando(null);
        await carregar();
      }
    } finally {
      setOcupado(false);
    }
  };

  const operarXp = async () => {
    const quantidade = Number(qtdXp);
    if (!Number.isInteger(quantidade) || quantidade < 1 || !motivoXp.trim()) {
      erroAcao.current = true;
      setErro("Informe quantidade inteira positiva e um motivo.");
      return;
    }
    if (ocupado) return;
    setOcupado(true);
    setErro(null);
    erroAcao.current = false;
    try {
      await apiProgressao.concederXp(characterId, { acao: acaoXp, quantidade, motivo: motivoXp.trim() });
      setMotivoXp("");
      await carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha ao alterar XP");
    } finally {
      setOcupado(false);
    }
  };

  // Exceção #186 (contrato do PAI, PRs #226+#231): o selo "Capacidade
  // de Sangue" usa SOMENTE o marcador autoritativo `capacidadeSangue`
  // emitido pelo GET — nunca heurística sobre `motivo`, kind ou nome.
  // O GET e o POST /comprar-ponto seguem sendo a autoridade.
  const ehCapacidadeSangue = (el: ElementoDisponivel): boolean =>
    el.capacidadeSangue === true;

  if (erro && !prog) return <div className="cartao"><p className="ficha-aviso">{erro}</p></div>;
  if (!prog) return null;

  const historico = [...prog.xp.historico].reverse().slice(0, 30);
  const ROTULO_TIPO: Record<string, string> = {
    concessao: "XP recebido",
    remocao: "XP removido",
    compra: "Compra",
    ajuste: "Ajuste",
  };

  return (
    // minWidth:0 — o painel é item do grid .ficha; sem isso o min-content
    // da tabela de elementos alarga o grid e estoura a viewport mobile.
    <div className="cartao progressao-xp" style={{ minWidth: 0 }}>
      <h3>Progressão — XP</h3>
      <div className="grade-2">
        <div>
          <p className="meta">Saldo de XP</p>
          <p className="progresso-saldo"><strong>{prog.xp.saldo}</strong> XP</p>
        </div>
        {ehMestre && (
          <div className="linha" role="group" aria-label="Conceder ou remover XP" style={{ flexWrap: "wrap" }}>
            <select value={acaoXp} onChange={(e) => setAcaoXp(e.target.value as "conceder" | "remover")} aria-label="Operação de XP">
              <option value="conceder">Conceder</option>
              <option value="remover">Remover</option>
            </select>
            <input
              type="number" min={1} step={1} value={qtdXp}
              onChange={(e) => setQtdXp(e.target.value)} aria-label="Quantidade de XP"
              style={{ width: "5em" }}
            />
            <input
              type="text" placeholder="Motivo" value={motivoXp}
              onChange={(e) => setMotivoXp(e.target.value)} aria-label="Motivo do ajuste de XP"
              style={{ flex: "1 1 10em", minWidth: "8em" }}
            />
            <button type="button" className="mini" disabled={ocupado} onClick={() => void operarXp()}>
              Aplicar
            </button>
          </div>
        )}
      </div>
      {erro && <p className="ficha-aviso">{erro}</p>}

      <h4>Elementos para evoluir</h4>
      {prog.disponiveis.length === 0 && <p className="meta">Nenhum elemento da biblioteca vinculado a esta ficha.</p>}
      {prog.disponiveis.length > 0 && (
        <table className="tabela">
          <thead>
            <tr><th>Elemento</th><th>Nível</th><th>Próximo nível</th><th>Custo (XP)</th><th></th></tr>
          </thead>
          <tbody>
            {prog.disponiveis.map((el) => {
              const alvo = el.nivelAtual + 1;
              const confirmandoEste = confirmando?.key === el.key && confirmando?.kind === el.kind;
              const capacidadeSangue = ehCapacidadeSangue(el);
              return (
                <tr key={`${el.kind}:${el.key}`}>
                  <td>
                    {el.nome}
                    <span className="meta"> ({el.kind})</span>
                    {capacidadeSangue && (
                      <span className="selo" title="Característica que define a capacidade máxima de Pontos de Sangue">
                        {" "}Capacidade de Sangue
                      </span>
                    )}
                  </td>
                  <td>{el.nivelAtual}</td>
                  <td>{alvo}</td>
                  <td>{el.precoProximo ?? "—"}</td>
                  <td>
                    {el.compravel ? (
                      confirmandoEste ? (
                        <span className="linha" style={{ flexDirection: "column", alignItems: "flex-start", gap: "0.25rem" }}>
                          {capacidadeSangue && (
                            <span className="meta" role="note">
                              Aumenta apenas a capacidade máxima de Sangue — não adiciona Sangue ao saldo.
                            </span>
                          )}
                          <span className="linha">
                            <button
                              type="button" className="mini perigo" disabled={ocupado}
                              onClick={() => void comprar(el)}
                            >
                              Confirmar −{el.precoProximo} XP
                            </button>
                            <button type="button" className="mini secundario" onClick={() => setConfirmando(null)}>Cancelar</button>
                          </span>
                        </span>
                      ) : (
                        <button type="button" className="mini" disabled={ocupado} onClick={() => setConfirmando(el)}>
                          Comprar
                        </button>
                      )
                    ) : (
                      <span className="meta" title={el.motivo}>{el.motivo ?? "Indisponível"}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h4>Histórico de XP</h4>
      {historico.length === 0 && <p className="meta">Nenhuma movimentação de XP registrada.</p>}
      <ul className="lista-anotacoes">
        {historico.map((ev, i) => (
          <li key={`${ev.em}-${i}`}>
            <strong>{ROTULO_TIPO[ev.tipo] ?? ev.tipo}</strong>
            {ev.compra && <> — {ev.compra.nome} nv.{ev.compra.nivelAnterior}→{ev.compra.nivelNovo} (−{ev.compra.custoXp} XP)</>}
            {!ev.compra && <> {ev.quantidade > 0 ? "+" : ""}{ev.quantidade} XP</>}
            <span className="meta">
              {" "}· {new Date(ev.em).toLocaleString("pt-BR")}
              {ev.autorNome ? ` · ${ev.autorNome}` : ""}
              {" "}· saldo {ev.saldoResultante}
            </span>
            {ev.motivo && <div className="meta">{ev.motivo}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}
