import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getSocket } from "./socket";
import { apiProgressao, type EventoXp, type Progressao } from "./api-progressao";
import "./extrato-xp.css";

/**
 * Extrato de XP somente-leitura (Issue #185 — Mission 2).
 *
 * Mostra saldo atual e o histórico de movimentações do personagem,
 * mais recentes primeiro, com paginação progressiva (nunca descarta
 * dados persistidos — o histórico do servidor é append-only, limitado
 * a 500 eventos por política de retenção; quando truncado, o saldo
 * anterior ao período é exibido como âncora).
 *
 * Visível apenas para mestre e dono do personagem — o mesmo recorte
 * de acesso do backend (GET /characters/:id/progressao). Não exibe
 * IDs internos: apenas nome do autor, tipo, quantidade, motivo,
 * data e saldo resultante.
 */

const POR_PAGINA = 20;

const ROTULO_TIPO: Record<string, string> = {
  concessao: "XP recebido",
  remocao: "XP removido",
  compra: "Compra",
  ajuste: "Ajuste",
  estorno: "Estorno",
};

export default function ExtratoXp({ characterId }: { characterId: string }) {
  const [prog, setProg] = useState<Progressao | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [visiveis, setVisiveis] = useState(POR_PAGINA);
  // Geração da carga: resposta atrasada de um characterId anterior é
  // descartada — nunca exibe dados de A como se fossem de B.
  const geracao = useRef(0);

  const carregar = useCallback(async () => {
    const g = ++geracao.current;
    try {
      const dados = await apiProgressao.obter(characterId);
      if (g !== geracao.current) return;
      setProg(dados);
      setErro(null);
    } catch (e) {
      if (g !== geracao.current) return;
      setErro(e instanceof Error ? e.message : "Falha ao carregar extrato de XP");
    }
  }, [characterId]);

  // Troca de personagem: limpa saldo/histórico/erro para o estado de
  // carregamento — dados do personagem anterior nunca permanecem.
  useEffect(() => {
    setProg(null);
    setErro(null);
    setVisiveis(POR_PAGINA);
  }, [characterId]);

  useEffect(() => { void carregar(); }, [carregar]);

  // Tempo real: mesma assinatura de Personagens — mutações do personagem
  // emitem personagens:atualizados na campanha.
  useEffect(() => {
    const socket = getSocket();
    const aoMudar = (d: { characterId?: string } | undefined) => {
      if (d?.characterId === characterId) void carregar();
    };
    socket.on("personagens:atualizados", aoMudar);
    return () => { socket.off("personagens:atualizados", aoMudar); };
  }, [characterId, carregar]);

  // Mais recentes primeiro; quantidade negativa permanece negativa
  // (remoções/estornos), positiva ganha "+".
  const eventos = useMemo(
    () => [...(prog?.xp.historico ?? [])].reverse(),
    [prog],
  );
  const mostrados = eventos.slice(0, visiveis);

  return (
    <section className="cartao extrato-xp">
      <h3>Extrato de XP</h3>
      {erro && <p className="erro">{erro}</p>}
      {!prog && !erro && <p className="meta">Carregando extrato…</p>}
      {prog && (
        <>
          <p className="progresso-saldo"><strong>{prog.xp.saldo}</strong> XP disponíveis</p>
          {prog.xp.ancora !== undefined && (
            <p className="meta extrato-xp-ancora">
              Exibindo as movimentações mais recentes (retenção de até 500) —
              saldo anterior ao primeiro evento exibido: <strong>{prog.xp.ancora} XP</strong>.
            </p>
          )}
          {eventos.length === 0 ? (
            <p className="meta">Nenhuma movimentação de XP registrada.</p>
          ) : (
            <>
              <ul className="lista-anotacoes extrato-xp-lista">
                {mostrados.map((ev: EventoXp, i) => (
                  <li key={`${ev.em}-${i}`} className="extrato-xp-evento">
                    <strong>{ROTULO_TIPO[ev.tipo] ?? ev.tipo}</strong>
                    {ev.compra && <> — {ev.compra.nome} nv.{ev.compra.nivelAnterior}→{ev.compra.nivelNovo} (<span className="extrato-xp-qtd negativo">−{ev.compra.custoXp} XP</span>)</>}
                    {ev.estorno && <> — {ev.estorno.nome} nv.{ev.estorno.nivelDe}→{ev.estorno.nivelPara} (<span className="extrato-xp-qtd positivo">+{ev.estorno.custoXp} XP</span>)</>}
                    {!ev.compra && !ev.estorno && <> <span className={`extrato-xp-qtd ${ev.quantidade >= 0 ? "positivo" : "negativo"}`}>{ev.quantidade > 0 ? "+" : ""}{ev.quantidade} XP</span></>}
                    <span className="meta">
                      {" "}· {new Date(ev.em).toLocaleString("pt-BR")}
                      {ev.autorNome ? ` · ${ev.autorNome}` : ""}
                      {" "}· saldo {ev.saldoResultante}
                    </span>
                    {ev.motivo && <div className="meta">{ev.motivo}</div>}
                  </li>
                ))}
              </ul>
              {visiveis < eventos.length && (
                <button
                  type="button"
                  className="secundario"
                  onClick={() => setVisiveis((v) => v + POR_PAGINA)}
                >
                  Mostrar mais ({eventos.length - visiveis} restantes)
                </button>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
