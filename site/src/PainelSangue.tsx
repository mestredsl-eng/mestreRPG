import { useCallback, useEffect, useRef, useState } from "react";
import { getSocket } from "./socket";
import { apiSangue, ApiErrorSangue, type SangueLeitura } from "./api-sangue";

/**
 * Painel SOMENTE LEITURA de Pontos de Sangue (Issue #186, C8-C1).
 *
 * Consome exclusivamente `GET /api/characters/:id/sangue` (R7.1):
 * saldo, capacidade máxima, natureza e ação de recuperação efetiva —
 * projeção mínima do servidor. Nunca lê characters.data, nunca
 * exibe usos/histórico bruto e NUNCA renderiza controle de mutação
 * (botões de ativar/recuperar são C8-C2, após contrato R6.3).
 *
 * 403/404 (não-dono, espectador, ficha alheia) → painel some: o GET
 * é a autoridade de permissão e nenhum dado do ledger vaza.
 * Revalida ao trocar de personagem e a cada `personagens:atualizados`
 * do personagem correspondente.
 */
export default function PainelSangue({ characterId }: { characterId: string }) {
  const [sangue, setSangue] = useState<SangueLeitura | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [semAcesso, setSemAcesso] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  // Geração da carga: resposta de um characterId anterior que chegue
  // DEPOIS da troca é descartada — nunca sobrescreve o estado atual.
  const geracao = useRef(0);

  const carregar = useCallback(async () => {
    const g = ++geracao.current;
    setCarregando(true);
    try {
      const r = await apiSangue.obter(characterId);
      if (g !== geracao.current) return; // resposta obsoleta
      setSangue(r);
      setSemAcesso(false);
      setErro(null);
    } catch (e) {
      if (g !== geracao.current) return; // resposta obsoleta
      if (e instanceof ApiErrorSangue && (e.status === 403 || e.status === 404)) {
        // Sem permissão ou personagem inexistente: nada de saldo na
        // tela — o painel simplesmente não existe para este usuário.
        setSemAcesso(true);
        setSangue(null);
        setErro(null);
      } else {
        setErro(e instanceof Error ? e.message : "Falha ao carregar Sangue");
      }
    } finally {
      if (g === geracao.current) setCarregando(false);
    }
  }, [characterId]);

  useEffect(() => { void carregar(); }, [carregar]);

  // Tempo real: mutações do personagem (compra de nível, PATCH do
  // mestre, arquivamento) emitem personagens:atualizados na campanha.
  useEffect(() => {
    const socket = getSocket();
    const aoMudar = (d: { characterId?: string } | undefined) => {
      if (d?.characterId === characterId) void carregar();
    };
    socket.on("personagens:atualizados", aoMudar);
    return () => { socket.off("personagens:atualizados", aoMudar); };
  }, [characterId, carregar]);

  if (semAcesso) return null;

  const ROTULO_ESTADO: Record<string, string> = {
    desabilitado: "Pontos de Sangue desabilitados nesta campanha.",
    indisponivel: "Ficha sem versão disponível para calcular a capacidade de Sangue.",
    capacidade_indisponivel: "Capacidade de Sangue indisponível nesta ficha.",
    ledger_invalido: "Registro de Sangue inválido — saldo não exibido por segurança.",
  };

  return (
    <div className="cartao painel-sangue-leitura" style={{ minWidth: 0 }}>
      <h3>Pontos de Sangue</h3>
      {carregando && <p className="meta" role="status">Carregando…</p>}
      {erro && <p className="ficha-aviso" role="alert">{erro}</p>}
      {!carregando && !erro && sangue && (
        <>
          {sangue.estado === "ok" || (sangue.utilizavel && sangue.saldo !== null) ? (
            <div className="grade-2">
              <div>
                <p className="meta">Saldo de Sangue</p>
                <p className="progresso-saldo">
                  <strong>{sangue.saldo}</strong>
                  {sangue.capacidadeMax !== null && <span className="meta"> / {sangue.capacidadeMax}</span>}
                </p>
              </div>
              <div>
                <p className="meta">Capacidade máxima</p>
                <p className="progresso-saldo"><strong>{sangue.capacidadeMax ?? "—"}</strong></p>
              </div>
            </div>
          ) : (
            <p className="meta">{ROTULO_ESTADO[sangue.estado] ?? "Estado de Sangue indisponível."}</p>
          )}

          {sangue.natureza && (
            <p className="meta">
              Natureza: <strong>{sangue.natureza.rotulo}</strong>
              {!sangue.natureza.conhecida && " (não reconhecida pela campanha)"}
              {sangue.natureza.metaHumanoComPoder && " · meta-humano com poder"}
            </p>
          )}

          {/* Ação de recuperação só quando o estado é utilizável de
              fato — o GET pode devolver acaoRecuperacao mesmo com
              ledger inválido/capacidade indisponível (config isolada
              válida); anunciar ação indisponível seria enganoso. */}
          {sangue.estado === "ok" && sangue.utilizavel === true && sangue.acaoRecuperacao && (
            <p className="meta">
              Ação de recuperação disponível: <strong>{sangue.acaoRecuperacao.acao === "descansar" ? "Descansar" : "Alimentar-se"}</strong>
              {" "}(+{sangue.acaoRecuperacao.quantidade} de Sangue)
            </p>
          )}
        </>
      )}
    </div>
  );
}
