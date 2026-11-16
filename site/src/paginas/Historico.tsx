import { useCallback, useEffect, useRef, useState } from "react";
import { ModalConfirmar } from "../Modal";
import { api, type CampanhaResumo, type EstadoAtualCampanha, type HistoricoSessao, type Restauracao, type Sessao, type Snapshot } from "../api";
import { useSincronizacaoCampanha } from "../useSincronizacao";
import { resumirRolagemHistorico } from "../lib/rolagensHistorico";

const KIND_SNAPSHOT: Record<string, string> = { manual: "Manual", automatico: "Automático", pre_restauracao: "Pré-restauração" };
const OUTCOME_LABEL: Record<string, string> = { sucesso: "Sucesso", parcial: "Parcial", falha: "Falha", falha_critica: "Falha crítica" };

function fmtDuracao(ms: number | null) {
  if (ms == null) return "—";
  const min = Math.floor(ms / 60000);
  const h = Math.floor(min / 60);
  return h > 0 ? `${h}h${String(min % 60).padStart(2, "0")}min` : `${min}min`;
}

export default function Historico({ campaignId, campanha, aoAtualizar }: { campaignId: string; campanha: CampanhaResumo; aoAtualizar: () => void }) {
  const souMestre = campanha.meuPapel === "mestre";
  const [sessoes, setSessoes] = useState<Sessao[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [restauracoes, setRestauracoes] = useState<Restauracao[]>([]);
  const [estado, setEstado] = useState<EstadoAtualCampanha | null>(null);
  const [historicos, setHistoricos] = useState<Record<string, HistoricoSessao>>({});
  const [resumoEdit, setResumoEdit] = useState(campanha.summary ?? "");
  const [descSnap, setDescSnap] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirmando, setConfirmando] = useState<Snapshot | null>(null);
  const [ocupado, setOcupado] = useState(false);

  // Geração da carga: respostas antigas não sobrescrevem o estado atual.
  const geracao = useRef(0);
  const carregar = useCallback(async () => {
    const g = ++geracao.current;
    try {
      const { sessoes: s } = await api.listarSessoes(campaignId);
      if (g !== geracao.current) return;
      setSessoes(s);
      if (souMestre) {
        const { snapshots: sn } = await api.listarSnapshots(campaignId);
        const [est, rests] = await Promise.all([api.estadoCampanha(campaignId), api.listarRestauracoes(campaignId)]);
        if (g !== geracao.current) return;
        setSnapshots(sn);
        setEstado(est); setRestauracoes(rests.restauracoes);
      }
      setErro(null);
    } catch (e) { if (g === geracao.current) setErro(e instanceof Error ? e.message : "Erro ao carregar"); }
  }, [campaignId, souMestre]);

  useEffect(() => { void carregar(); setResumoEdit(campanha.summary ?? ""); }, [carregar, campanha.summary]);

  // Issue #67: sessão criada/encerrada, novo snapshot e restauração da
  // campanha invalidam as listas. Histórico já aberto de uma sessão é
  // descartado para forçar nova leitura (visibilidade reaplicada no GET).
  // O debounce do hook conserva só o último payload — não dá para confiar
  // no sessionId para invalidação seletiva, então qualquer evento de sessão
  // descarta todos os históricos abertos (são poucos e recarregam sob demanda).
  useSincronizacaoCampanha(["sessao:atualizada", "snapshots:atualizados", "campanha:restaurada"], (evento) => {
    setHistoricos({});
    if (evento === "campanha:restaurada") aoAtualizar();
    void carregar();
  });

  const abrirHistorico = async (sid: string) => {
    if (historicos[sid]) return;
    try {
      const h = await api.historicoSessao(campaignId, sid);
      setHistoricos((p) => ({ ...p, [sid]: h }));
    } catch (e) { setErro(e instanceof Error ? e.message : "Erro ao carregar histórico"); }
  };

  const salvarResumo = async () => {
    try {
      await api.atualizarCampanha(campaignId, { summary: resumoEdit || null });
      setMsg("Resumo atualizado."); aoAtualizar();
      setTimeout(() => setMsg(null), 3000);
    } catch (e) { setErro(e instanceof Error ? e.message : "Erro ao salvar"); }
  };

  const criarSnap = async () => {
    try {
      await api.criarSnapshot(campaignId, descSnap || undefined);
      setDescSnap(""); await carregar(); setMsg("Ponto de recuperação criado.");
      setTimeout(() => setMsg(null), 3000);
    } catch (e) { setErro(e instanceof Error ? e.message : "Erro ao criar snapshot"); }
  };

  const exportar = async () => {
    try {
      const pacote = await api.exportarCampanha(campaignId);
      const blob = new Blob([JSON.stringify(pacote)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `campanha-${campanha.name ?? campaignId}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      setMsg("Campanha exportada.");
      setTimeout(() => setMsg(null), 3000);
    } catch (e) { setErro(e instanceof Error ? e.message : "Erro ao exportar"); }
  };

  const restaurar = async () => {
    if (!confirmando || ocupado) return;
    setOcupado(true);
    try {
      await api.restaurarSnapshot(campaignId, confirmando.id);
      setConfirmando(null);
      await carregar(); aoAtualizar();
      setMsg("Campanha restaurada. Um ponto automático foi salvo antes da restauração.");
      setTimeout(() => setMsg(null), 5000);
    } catch (e) { setErro(e instanceof Error ? e.message : "Erro ao restaurar"); }
    finally { setOcupado(false); }
  };

  const encerradas = sessoes.filter((s) => s.status === "encerrada");
  const ultima = encerradas[0] ?? sessoes[0];

  return (
    <>
      {erro && <p className="erro">{erro}</p>}
      {msg && <p className="sucesso">{msg}</p>}

      <section className="cartao">
        <h3>Resumo da campanha</h3>
        <p><strong>Sessões realizadas:</strong> {encerradas.length}</p>
        <p><strong>Última sessão:</strong> {ultima ? `${ultima.name ?? `Sessão ${ultima.number}`} (${ultima.startedAt ? new Date(ultima.startedAt).toLocaleDateString("pt-BR") : "—"})` : "—"}</p>
        {souMestre ? (
          <>
            <textarea rows={5} value={resumoEdit} onChange={(e) => setResumoEdit(e.target.value)} placeholder="Resumo geral escrito pelo mestre…" />
            <button onClick={salvarResumo}>Salvar resumo</button>
          </>
        ) : (
          <p className="pre-wrap">{campanha.summary ?? "—"}</p>
        )}
      </section>

      <section className="cartao">
        <h3>Histórico de sessões</h3>
        <ul className="lista-anotacoes">
          {sessoes.map((s) => {
            const h = historicos[s.id];
            return (
              <li key={s.id}>
                <div className="linha">
                  <strong>{s.name ?? `Sessão ${s.number}`}</strong>
                  <span className="dica">{s.status} · {s.startedAt ? new Date(s.startedAt).toLocaleString("pt-BR") : "—"}</span>
                  <button className="secundario" onClick={() => abrirHistorico(s.id)}>Histórico</button>
                </div>
                {h && (
                  <div className="historico-sessao">
                    <p className="dica">Duração: {fmtDuracao(h.duracaoMs)} · {h.participantes.length} participante(s) no chat: {h.participantes.map((p) => p.displayName ?? p.username).join(", ") || "—"}</p>
                    {h.eventos.length > 0 && (
                      <ul>
                        {h.eventos.map((e) => (
                          <li key={e.id}><span className="dica">{new Date(e.createdAt).toLocaleTimeString("pt-BR")}</span> {e.content}</li>
                        ))}
                      </ul>
                    )}
                    {h.testes.length > 0 && (
                      <div>
                        <p className="dica">{h.testes.length} teste(s) realizado(s):</p>
                        <ul>
                          {h.testes.map((t) => {
                            const rotulo = (t.skillRef as { rotulo?: string } | null)?.rotulo ?? t.rotulo ?? "teste";
                            const lados = t.pool?.dadosLados ?? t.diceSides;
                            const positivos = t.pool?.positivos ?? t.diceCount;
                            const negativos = t.pool?.negativos ?? 0;
                            const pedidoPor = h.participantes.find((p) => p.id === t.requestedBy);
                            // Sucessos D10 vivem no roll vinculado (results.d10) —
                            // o registro do teste não carrega esse campo.
                            const d10Teste = t.d10 ?? (t.rollId ? h.rolagens.find((r) => r.id === t.rollId)?.results?.d10 : null) ?? null;
                            return (
                              <li key={t.id}>
                                <span className="dica">{new Date(t.createdAt).toLocaleTimeString("pt-BR")}</span>{" "}
                                <strong>{rotulo}</strong>
                                {lados === 10 && <span className="tag">D10</span>}{" "}
                                {positivos}d{lados}{negativos > 0 ? ` (−${negativos})` : ""}
                                {d10Teste ? ` · ${d10Teste.sucessos}/${d10Teste.lancados} sucessos` : ""}
                                {" · "}
                                {t.outcome
                                  ? <>{OUTCOME_LABEL[t.outcome] ?? t.outcome}{t.outcomeNote ? ` — ${t.outcomeNote}` : ""}</>
                                  : t.status === "pendente" ? "pendente" : t.status}
                                {pedidoPor ? <span className="dica"> · {pedidoPor.displayName ?? pedidoPor.username}</span> : null}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    )}
                    {(() => {
                      // Rolagens já exibidas como teste (rollId) não se repetem aqui.
                      const rollIdsTestes = new Set(h.testes.map((t) => t.rollId).filter(Boolean) as string[]);
                      const rolagens = h.rolagens.filter((r) => !rollIdsTestes.has(r.id));
                      if (!rolagens.length) return h.rolagens.length > 0 ? null : <p className="dica">Nenhuma rolagem registrada.</p>;
                      return (
                        <div>
                          <p className="dica">{rolagens.length} rolagem(ns) registrada(s):</p>
                          <ul>
                            {rolagens.map((r) => {
                              // O HTTP devolve o formato persistido ({ sides, count }); o
                              // Socket.IO legado usa { lados, resultados }. O normalizador
                              // aceita ambos e mantém fallback para registros antigos.
                              const { descricao: descDados, valores } = resumirRolagemHistorico(
                                r.dice ?? [], r.results?.grupos ?? [],
                              );
                              const total = r.results?.total;
                              return (
                                <li key={r.id}>
                                  <span className="dica">{new Date(r.createdAt).toLocaleTimeString("pt-BR")}</span>{" "}
                                  <strong>{r.autor ? (r.autor.displayName ?? r.autor.username) : "—"}</strong>{" "}
                                  rolou {descDados}
                                  {total !== undefined ? ` → ${total}` : ""}
                                  {valores.length > 0 && valores.length <= 15 ? <span className="dica"> ({valores.join(", ")})</span> : null}
                                  {r.results?.d10 ? ` · D10: ${r.results.d10.sucessos}/${r.results.d10.lancados} sucessos` : ""}
                                  {r.results?.modo === "dano" ? " · dano" : ""}
                                  {r.visibility === "privada" ? " · privada" : ""}
                                  {r.reason ? <span className="dica"> · {r.reason}</span> : null}
                                </li>
                              );
                            })}
                          </ul>
                        </div>
                      );
                    })()}
                    {(h.alteracoes?.length ?? 0) > 0 && (
                      <p className="dica">{h.alteracoes!.length} alteração(ões) relevante(is): {h.alteracoes!.map((a) => a.action).join(", ")}</p>
                    )}
                    {h.resumo && <p className="pre-wrap"><strong>Resumo:</strong> {h.resumo}</p>}
                  </div>
                )}
              </li>
            );
          })}
          {!sessoes.length && <li className="dica">Nenhuma sessão registrada.</li>}
        </ul>
      </section>

      {souMestre && estado && (
        <section className="cartao">
          <h3>Estado atual da campanha</h3>
          <p className="dica">
            Status: <strong>{estado.campanha?.status ?? "—"}</strong> ·
            Sessão ativa: {estado.sessaoAtiva ? `nº ${estado.sessaoAtiva.number} (${estado.sessaoAtiva.status})` : "nenhuma"} ·
            {" "}{estado.totais.personagens} personagem(ns) · {estado.totais.membrosAtivos} membro(s) · {estado.totais.mensagens} mensagem(ns)
          </p>
          <p className="dica">Último ponto de recuperação: {estado.ultimoPonto ? `${estado.ultimoPonto.description ?? KIND_SNAPSHOT[estado.ultimoPonto.kind] ?? estado.ultimoPonto.kind} (${new Date(estado.ultimoPonto.createdAt).toLocaleString("pt-BR")})` : "nenhum"}</p>
          <button className="secundario" onClick={exportar}>Exportar campanha (.json)</button>
        </section>
      )}

      {souMestre && (
        <section className="cartao">
          <h3>Recuperação e snapshots</h3>
          <div className="linha">
            <input placeholder="Nome do ponto de recuperação (opcional)" value={descSnap} onChange={(e) => setDescSnap(e.target.value)} />
            <button onClick={criarSnap}>Criar ponto de recuperação</button>
          </div>
          <p className="dica">Alterações recentes são salvas automaticamente em segundo plano (pontos "Automático").</p>
          <ul className="lista-anotacoes">
            {snapshots.map((s) => (
              <li key={s.id}>
                <div className="linha">
                  <strong>{s.description ?? "Sem descrição"}</strong>
                  <span className="dica">{KIND_SNAPSHOT[s.kind] ?? s.kind} · {new Date(s.createdAt).toLocaleString("pt-BR")} · {s.autor ? (s.autor.displayName ?? s.autor.username) : "—"}</span>
                  <button className="secundario" onClick={() => setConfirmando(s)}>Restaurar</button>
                </div>
              </li>
            ))}
            {!snapshots.length && <li className="dica">Nenhum ponto de recuperação criado.</li>}
          </ul>
        </section>
      )}

      {souMestre && restauracoes.length > 0 && (
        <section className="cartao">
          <h3>Histórico de restaurações</h3>
          <ul className="lista-anotacoes">
            {restauracoes.map((r) => (
              <li key={r.id}>
                <div className="linha">
                  <span>{new Date(r.createdAt).toLocaleString("pt-BR")}</span>
                  <span className="dica">
                    por {r.autor ? (r.autor.displayName ?? r.autor.username) : "—"}
                    {r.detalhe?.descricao ? ` · ${r.detalhe.descricao}` : ""}
                    {r.detalhe?.arquivosRecuperados != null ? ` · ${r.detalhe.arquivosRecuperados} arquivo(s) recuperado(s)` : ""}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {confirmando && (
        <ModalConfirmar
          titulo="Restaurar campanha"
          mensagem={`Restaurar a campanha para "${confirmando.description ?? confirmando.createdAt}"?\nUm snapshot automático do estado atual será criado antes.`}
          rotuloConfirmar="Restaurar"
          perigo
          ocupado={ocupado}
          aoConfirmar={() => void restaurar()}
          aoCancelar={() => { if (!ocupado) setConfirmando(null); }}
        />
      )}
    </>
  );
}
