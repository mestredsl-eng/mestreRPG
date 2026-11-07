import { useCallback, useEffect, useState } from "react";
import { api, type CampanhaResumo, type HistoricoSessao, type Sessao, type Snapshot } from "../api";

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
  const [historicos, setHistoricos] = useState<Record<string, HistoricoSessao>>({});
  const [resumoEdit, setResumoEdit] = useState(campanha.summary ?? "");
  const [descSnap, setDescSnap] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      const { sessoes: s } = await api.listarSessoes(campaignId);
      setSessoes(s);
      if (souMestre) {
        const { snapshots: sn } = await api.listarSnapshots(campaignId);
        setSnapshots(sn);
      }
      setErro(null);
    } catch (e) { setErro(e instanceof Error ? e.message : "Erro ao carregar"); }
  }, [campaignId, souMestre]);

  useEffect(() => { void carregar(); setResumoEdit(campanha.summary ?? ""); }, [carregar, campanha.summary]);

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

  const restaurar = async (s: Snapshot) => {
    if (!confirm(`Restaurar a campanha para "${s.description ?? s.createdAt}"?\nUm snapshot automático do estado atual será criado antes.`)) return;
    try {
      await api.restaurarSnapshot(campaignId, s.id);
      await carregar(); aoAtualizar();
      setMsg("Campanha restaurada. Um ponto automático foi salvo antes da restauração.");
      setTimeout(() => setMsg(null), 5000);
    } catch (e) { setErro(e instanceof Error ? e.message : "Erro ao restaurar"); }
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
                    {h.testes.length > 0 && <p className="dica">{h.testes.length} teste(s) realizado(s).</p>}
                    {h.rolagens.length > 0 && <p className="dica">{h.rolagens.length} rolagem(ns) registrada(s).</p>}
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

      {souMestre && (
        <section className="cartao">
          <h3>Recuperação e snapshots</h3>
          <div className="linha">
            <input placeholder="Descrição do ponto de recuperação (opcional)" value={descSnap} onChange={(e) => setDescSnap(e.target.value)} />
            <button onClick={criarSnap}>Criar ponto de recuperação</button>
          </div>
          <ul className="lista-anotacoes">
            {snapshots.map((s) => (
              <li key={s.id}>
                <div className="linha">
                  <strong>{s.description ?? "Sem descrição"}</strong>
                  <span className="dica">{new Date(s.createdAt).toLocaleString("pt-BR")} · {s.autor ? (s.autor.displayName ?? s.autor.username) : "—"}</span>
                  <button className="secundario" onClick={() => restaurar(s)}>Restaurar</button>
                </div>
              </li>
            ))}
            {!snapshots.length && <li className="dica">Nenhum snapshot criado.</li>}
          </ul>
        </section>
      )}
    </>
  );
}
