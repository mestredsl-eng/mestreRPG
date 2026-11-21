import { useCallback, useEffect, useRef, useState } from "react";
import { getSocket } from "./socket";
import { api } from "./api";
import { apiSangue, ApiErrorSangue, type SangueLeitura } from "./api-sangue";

/**
 * Painel de Pontos de Sangue (Issue #186, C8-C1 + C8-C2).
 *
 * Leitura via `GET /characters/:id/sangue` (R7.1); mutações via
 * Socket.IO R6.3 (#230):
 *  - dono da ficha: `sangue:ativar` (poderKey + requestId UUID) e
 *    `sangue:recuperar` (requestId UUID);
 *  - mestre ativo: `sangue:ajustar` (delta+motivo+requestId UUID)
 *    e `sangue:reconciliar-capacidade` (motivo).
 * O cliente NUNCA envia custo, ação, quantidade, capacidade ou
 * natureza — o servidor resolve tudo e o ACK devolve códigos
 * estáveis. `personagens:atualizados` pós-commit já dispara a
 * releitura (socket existente, sem evento novo).
 *
 * 403/404 → painel some (não-dono, espectador, ficha alheia).
 * Respostas HTTP obsoletas são descartadas por geração.
 */

interface PoderProprio { key: string; nome: string; nivel: number }

interface AckSangue {
  ok?: boolean;
  replay?: boolean;
  codigo?: string;
  erro?: string;
  estado?: { saldo?: number; capacidade?: number };
}

const ROTULO_ESTADO: Record<string, string> = {
  desabilitado: "Pontos de Sangue desabilitados nesta campanha.",
  indisponivel: "Ficha sem versão disponível para calcular a capacidade de Sangue.",
  capacidade_indisponivel: "Capacidade de Sangue indisponível nesta ficha.",
  ledger_invalido: "Registro de Sangue inválido — saldo não exibido por segurança.",
};

const ROTULO_ACAO = { descansar: "Descansar", alimentar: "Alimentar-se" } as const;

export default function PainelSangue({ characterId, ehMestre = false }: { characterId: string; ehMestre?: boolean }) {
  const [sangue, setSangue] = useState<SangueLeitura | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [semAcesso, setSemAcesso] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  // Contexto do personagem para permissões de UI (o servidor revalida
  // tudo — isto só decide QUAIS controles renderizar).
  const [ehEu, setEhEu] = useState(false);
  const [poderes, setPoderes] = useState<PoderProprio[]>([]);
  // Ações R6.3
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [msgAcao, setMsgAcao] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);
  const [poderSel, setPoderSel] = useState("");
  const [deltaAjuste, setDeltaAjuste] = useState("");
  const [motivoAjuste, setMotivoAjuste] = useState("");
  const [motivoReconciliar, setMotivoReconciliar] = useState("");
  // Geração da carga: resposta de um characterId anterior que chegue
  // DEPOIS da troca é descartada — nunca sobrescreve o estado atual.
  const geracao = useRef(0);
  // requestId UUID por INTENÇÃO completa (evento + characterId +
  // payload normalizado) — ativar:/recuperar:/ajustar: idempotentes
  // no servidor (#230). Retry da MESMA intenção reutiliza o UUID;
  // payload diferente gera UUID novo; somente ACK ok limpa a
  // intenção (timeout/erro ambíguo preserva para o retry).
  const reqIdRef = useRef<{ chave: string; id: string } | null>(null);

  const carregar = useCallback(async () => {
    const g = ++geracao.current;
    setCarregando(true);
    try {
      const [r, det] = await Promise.all([
        apiSangue.obter(characterId),
        api.obterPersonagem(characterId).catch(() => null),
      ]);
      if (g !== geracao.current) return; // resposta obsoleta
      setSangue(r);
      setSemAcesso(false);
      setErro(null);
      // ehEu do GET /characters/:id não distingue dono de mestre (o
      // backend devolve ehDono=true para qualquer leitor autorizado).
      // A lista da campanha tem ehEu real (membership.userId === eu)
      // — uso ela como fonte de posse; falha → fail-closed (sem
      // controles de dono; o socket revalida de qualquer forma).
      const cid = det?.personagem?.campaignId;
      let ehDono = false;
      if (cid) {
        const lista = await api.listarPersonagens(cid).catch(() => null);
        // Guarda de geração IMEDIATA após o await: sem ela, a posse de
        // A poderia ser gravada no estado de B numa troca de ficha.
        if (g !== geracao.current) return;
        ehDono = lista?.personagens?.some((p) => p.id === characterId && p.ehEu === true) === true;
      }
      setEhEu(ehDono);
      // Poderes do próprio personagem: campos selecao_nivel com
      // regraKind==="poder" e itens nível>=1. Nomes via biblioteca.
      const ficha = det?.ficha;
      const valores = ficha?.campos ?? {};
      const chaves = new Set<string>();
      for (const s of ficha?.estrutura?.secoes ?? []) {
        for (const campo of s.campos ?? []) {
          if (campo.tipo !== "selecao_nivel" || campo.regraKind !== "poder") continue;
          const v = valores[campo.id];
          if (!Array.isArray(v)) continue;
          for (const item of v as { key?: unknown; nivel?: unknown }[]) {
            // Poder adquirido = nível numérico finito > 0 (frações como
            // 0.5 contam — mesmo critério do D10/#237 e do socket R6.3).
            if (item && typeof item === "object" && typeof item.key === "string" && item.key
              && typeof item.nivel === "number" && Number.isFinite(item.nivel) && item.nivel > 0) chaves.add(item.key);
          }
        }
      }
      let lista: PoderProprio[] = [];
      if (chaves.size && cid) {
        const vinc = await api.obterVinculaveis(cid).catch(() => null);
        const biblioteca = vinc?.elementos?.["poder"] ?? [];
        lista = [...chaves].map((key) => ({
          key,
          nome: biblioteca.find((e) => e.key === key)?.name ?? key,
          nivel: 0,
        }));
      }
      if (g !== geracao.current) return;
      setPoderes(lista);
      setPoderSel((atual) => (lista.some((p) => p.key === atual) ? atual : (lista[0]?.key ?? "")));
    } catch (e) {
      if (g !== geracao.current) return; // resposta obsoleta
      if (e instanceof ApiErrorSangue && (e.status === 403 || e.status === 404)) {
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

  // Tempo real: mutações do personagem emitem personagens:atualizados.
  useEffect(() => {
    const socket = getSocket();
    const aoMudar = (d: { characterId?: string } | undefined) => {
      if (d?.characterId === characterId) void carregar();
    };
    socket.on("personagens:atualizados", aoMudar);
    return () => { socket.off("personagens:atualizados", aoMudar); };
  }, [characterId, carregar]);

  /** Emite evento R6.3 com ACK — requestId UUID estável por intenção.
   *  `chaveIntencao` identifica a intenção completa (evento+payload
   *  normalizado): mesma chave → mesmo UUID; chave nova → UUID novo. */
  const emitir = useCallback((evento: string, payload: Record<string, unknown>, comRequestId: boolean, chaveIntencao?: string): Promise<AckSangue> => {
    return new Promise((resolve) => {
      const socket = getSocket();
      let reqId: string | undefined;
      if (comRequestId && chaveIntencao) {
        if (reqIdRef.current?.chave !== chaveIntencao) {
          reqIdRef.current = { chave: chaveIntencao, id: crypto.randomUUID() };
        }
        reqId = reqIdRef.current.id;
      }
      const timer = window.setTimeout(() => resolve({ ok: false, codigo: "timeout", erro: "Sem resposta do servidor" }), 15000);
      socket.emit(evento, { ...payload, ...(reqId ? { requestId: reqId } : {}) }, (ack: AckSangue) => {
        window.clearTimeout(timer);
        resolve(ack ?? { ok: false, codigo: "erro_interno", erro: "ACK vazio" });
      });
    });
  }, []);

  const executar = useCallback(async (chave: string, evento: string, payload: Record<string, unknown>, comRequestId: boolean, okMsg: string) => {
    if (ocupado) return;
    setOcupado(chave);
    setMsgAcao(null);
    const payloadFull = { characterId, ...payload };
    // Payload já chega normalizado pelos call sites (delta numérico,
    // motivo trim); a chave cobre evento+characterId+payload —
    // intenção idêntica reutiliza o UUID mesmo após edições
    // intermediárias que voltaram ao mesmo valor.
    const chaveIntencao = comRequestId ? `${evento}|${JSON.stringify(payloadFull)}` : undefined;
    const ack = await emitir(evento, payloadFull, comRequestId, chaveIntencao);
    if (ack.ok) {
      reqIdRef.current = null; // operação concluída — próxima é nova
      setMsgAcao({ tipo: "ok", texto: ack.replay ? `${okMsg} (repetição já processada)` : okMsg });
      void carregar();
    } else {
      setMsgAcao({ tipo: "erro", texto: ack.erro ?? `Falha (${ack.codigo ?? "erro"})` });
    }
    setOcupado(null);
  }, [ocupado, emitir, characterId, carregar]);

  if (semAcesso) return null;

  const podeUsar = !!sangue && sangue.estado === "ok" && sangue.utilizavel === true;
  const acoesDisponiveis = podeUsar && ehEu;

  return (
    <div className="cartao painel-sangue-leitura" style={{ minWidth: 0 }}>
      <h3>Pontos de Sangue</h3>
      {carregando && <p className="meta" role="status">Carregando…</p>}
      {erro && <p className="ficha-aviso" role="alert">{erro}</p>}
      {msgAcao && (
        <p className={msgAcao.tipo === "ok" ? "sucesso" : "ficha-aviso"} role={msgAcao.tipo === "ok" ? "status" : "alert"}>
          {msgAcao.texto}
        </p>
      )}
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
              Ação de recuperação disponível: <strong>{ROTULO_ACAO[sangue.acaoRecuperacao.acao]}</strong>
              {" "}(+{sangue.acaoRecuperacao.quantidade} de Sangue)
            </p>
          )}

          {/* ---------- Ações do DONO (R6.3: ativar/recuperar) ---------- */}
          {acoesDisponiveis && (
            <div className="linha" role="group" aria-label="Ações de Sangue" style={{ flexWrap: "wrap", marginTop: "0.5rem" }}>
              {sangue.acaoRecuperacao && (
                <button
                  type="button" className="mini" disabled={ocupado !== null}
                  onClick={() => {
                    void executar("recuperar", "sangue:recuperar", {}, true, "Recuperação realizada");
                  }}
                >
                  {ocupado === "recuperar" ? "Recuperando…" : `${ROTULO_ACAO[sangue.acaoRecuperacao.acao]} (+${sangue.acaoRecuperacao.quantidade})`}
                </button>
              )}
              {poderes.length > 0 && (
                <>
                  <select
                    value={poderSel} onChange={(e) => setPoderSel(e.target.value)}
                    aria-label="Poder a ativar" disabled={ocupado !== null}
                  >
                    {poderes.map((p) => <option key={p.key} value={p.key}>{p.nome}</option>)}
                  </select>
                  <button
                    type="button" className="mini" disabled={ocupado !== null || !poderSel}
                    onClick={() => {
                      void executar("ativar", "sangue:ativar", { poderKey: poderSel }, true, "Poder ativado");
                    }}
                  >
                    {ocupado === "ativar" ? "Ativando…" : "Ativar poder"}
                  </button>
                </>
              )}
            </div>
          )}

          {/* ---------- Ações do MESTRE (R6.3: ajustar/reconciliar) ---------- */}
          {ehMestre && sangue.habilitado && (
            <details className="painel-sangue-mestre" style={{ marginTop: "0.5rem" }}>
              <summary className="meta">Ações do mestre</summary>
              <div className="linha" style={{ flexWrap: "wrap", marginTop: "0.35rem" }}>
                <input
                  type="number" step="1" value={deltaAjuste}
                  onChange={(e) => setDeltaAjuste(e.target.value)}
                  aria-label="Delta de Sangue (positivo ou negativo)"
                  placeholder="Δ saldo" style={{ width: "7em" }}
                />
                <input
                  type="text" value={motivoAjuste}
                  onChange={(e) => setMotivoAjuste(e.target.value)}
                  aria-label="Motivo do ajuste de Sangue"
                  placeholder="Motivo (obrigatório)" style={{ flex: "1 1 10em", minWidth: "8em" }}
                />
                <button
                  type="button" className="mini" disabled={ocupado !== null}
                  onClick={() => {
                    const delta = Number(deltaAjuste);
                    if (!Number.isFinite(delta) || delta === 0 || !motivoAjuste.trim()) {
                      setMsgAcao({ tipo: "erro", texto: "Informe um delta ≠ 0 e um motivo." });
                      return;
                    }
                    void executar("ajustar", "sangue:ajustar", { delta, motivo: motivoAjuste.trim() }, true, "Saldo ajustado");
                  }}
                >
                  {ocupado === "ajustar" ? "Ajustando…" : "Ajustar saldo"}
                </button>
              </div>
              <div className="linha" style={{ flexWrap: "wrap", marginTop: "0.35rem" }}>
                <input
                  type="text" value={motivoReconciliar}
                  onChange={(e) => setMotivoReconciliar(e.target.value)}
                  aria-label="Motivo da reconciliação de capacidade"
                  placeholder="Motivo da reconciliação (obrigatório)" style={{ flex: "1 1 10em", minWidth: "8em" }}
                />
                <button
                  type="button" className="mini secundario" disabled={ocupado !== null}
                  onClick={() => {
                    if (!motivoReconciliar.trim()) {
                      setMsgAcao({ tipo: "erro", texto: "Informe o motivo da reconciliação." });
                      return;
                    }
                    void executar("reconciliar", "sangue:reconciliar-capacidade", { motivo: motivoReconciliar.trim() }, false, "Capacidade reconciliada");
                  }}
                >
                  {ocupado === "reconciliar" ? "Reconciliando…" : "Reconciliar capacidade"}
                </button>
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
