import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  api,
  type Sessao, type MensagemMesa, type TesteMesa, type TurnosState,
  type Membro, type PersonagemResumo, type CampanhaResumo,
} from "../api";
import { getSocket } from "../socket";
import PainelDados, { FaceDado } from "../Dados";
import { ModalConfirmar } from "../Modal";
import { IndicadorConexao } from "../ConexaoSocket";

interface Props {
  campaignId: string;
  campanha: CampanhaResumo | null;
}

interface TimerView { status?: string; remainingMs?: number; totalMs?: number; endsAt?: number; servidorAgora?: number }

const LADOS = [4, 6, 8, 10, 20] as const;

function fmtTempo(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export default function Mesa({ campaignId, campanha }: Props) {
  const [sessoes, setSessoes] = useState<Sessao[]>([]);
  const [ativa, setAtiva] = useState<Sessao | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const souMestre = campanha?.meuPapel === "mestre";

  const carregar = useCallback(async () => {
    try {
      const { sessoes } = await api.listarSessoes(campaignId);
      setSessoes(sessoes);
      setErro(null);
    } catch (e) { setErro(e instanceof Error ? e.message : "Erro"); }
  }, [campaignId]);

  useEffect(() => { void carregar(); }, [carregar]);

  if (ativa) {
    return <MesaView campaignId={campaignId} sessao={ativa} souMestre={souMestre} aoSair={() => { setAtiva(null); void carregar(); }} />;
  }

  return (
    <section className="cartao">
      <div className="linha-entre">
        <h2>Mesa</h2>
        {souMestre && (
          <button onClick={async () => {
            try { const { sessao } = await api.criarSessao(campaignId); setAtiva(sessao); }
            catch (e) { setErro(e instanceof Error ? e.message : "Erro"); }
          }}>Iniciar sessão</button>
        )}
      </div>
      {erro && <p className="erro">{erro}</p>}
      {sessoes.length === 0 ? <p className="meta">Nenhuma sessão ainda.</p> : (
        <table className="tabela">
          <thead><tr><th>#</th><th>Nome</th><th>Status</th><th>Início</th></tr></thead>
          <tbody>
            {sessoes.map((s) => (
              <tr key={s.id} className="clicavel" onClick={() => s.status !== "encerrada" && setAtiva(s)}>
                <td>{s.number}</td>
                <td>{s.name}</td>
                <td><span className={`badge badge-${s.status === "ativa" ? "aprovada" : s.status === "pausada" ? "devolvida" : "bloqueada"}`}>{s.status}</span></td>
                <td>{s.startedAt ? new Date(s.startedAt).toLocaleString("pt-BR") : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ================= VIEW DA MESA =================

function MesaView({ campaignId, sessao, souMestre, aoSair }: {
  campaignId: string; sessao: Sessao; souMestre: boolean; aoSair: () => void;
}) {
  const [mensagens, setMensagens] = useState<MensagemMesa[]>([]);
  const [testes, setTestes] = useState<TesteMesa[]>([]);
  const [turnos, setTurnos] = useState<TurnosState>({ ordem: [], atual: -1, ativo: false });
  const [timer, setTimer] = useState<TimerView | null>(sessao.timerState ?? null);
  const [online, setOnline] = useState<string[]>([]);
  const [membros, setMembros] = useState<Membro[]>([]);
  const [personagens, setPersonagens] = useState<PersonagemResumo[]>([]);
  const [papel, setPapel] = useState<string>(souMestre ? "mestre" : "jogador");
  const [podeEnviar, setPodeEnviar] = useState(true);
  const [meuUserId, setMeuUserId] = useState<string>("");
  const [texto, setTexto] = useState("");
  const [comoAcao, setComoAcao] = useState(false);
  const [privado, setPrivado] = useState(false);
  const [secreto, setSecreto] = useState(false);
  const [destinoPriv, setDestinoPriv] = useState("");
  const [rolagens, setRolagens] = useState<{ id: string; dados: number[][]; lados: number[]; total: number | null; motivo?: string | null; autor?: string; ts: number; vitalidade?: { nivel: number; nome: string; penalidadeDados: number; dadosOriginais: number; dadosFinais: number; excecaoMestre?: boolean } | null; dadosOriginais?: number; d10?: { positivos: number; negativos: number; minimo: number; lancados: number; sucessos: number; falhas: number } | null }[]>([]);
  const [minimoD10, setMinimoD10] = useState(6);
  const [erro, setErro] = useState<string | null>(null);
  const [sessaoAtual, setSessaoAtual] = useState(sessao);
  const [confirmandoEncerrar, setConfirmandoEncerrar] = useState(false);
  const [ocupadoEncerrar, setOcupadoEncerrar] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);
  const [, forcarTick] = useState(0);

  const souDonoTeste = useCallback((t: TesteMesa) => {
    const p = personagens.find((x) => x.id === t.characterId);
    return !!p?.ehEu;
  }, [personagens]);

  // carga inicial
  useEffect(() => {
    void (async () => {
      try {
        const [msgs, tes, est, mem, pers, regras] = await Promise.all([
          api.listarMensagens(campaignId, sessao.id),
          api.listarTestes(campaignId, sessao.id),
          api.obterEstadoMesa(campaignId, sessao.id),
          api.listarMembros(campaignId).catch(() => ({ membros: [] as Membro[] })),
          api.listarPersonagens(campaignId).catch(() => ({ personagens: [] as PersonagemResumo[] })),
          api.obterRegras(campaignId).catch(() => null),
        ]);
        setMensagens(msgs.mensagens);
        setTestes(tes.testes);
        setTurnos(est.turnos);
        setTimer(est.sessao.timerState ?? null);
        setSessaoAtual(est.sessao);
        setMembros(mem.membros.filter((m) => m.status === "ativo"));
        setPersonagens(pers.personagens);
        const minD10 = regras?.config?.dados?.d10SucessoMinimo;
        if (typeof minD10 === "number") setMinimoD10(minD10);
        const eu = mem.membros.find((m) => m.ehEu);
        if (eu) setMeuUserId(eu.userId);
      } catch (e) { setErro(e instanceof Error ? e.message : "Erro ao carregar mesa"); }
    })();
  }, [campaignId, sessao.id]);

  // socket
  useEffect(() => {
    const socket = getSocket();
    socket.emit("entrar-campanha", campaignId, () => undefined);

    const aoMensagem = (m: MensagemMesa & { autorNome?: string }) => {
      setMensagens((prev) => prev.some((x) => x.id === m.id) ? prev : [...prev.slice(-400), m]);
    };
    const aoTeste = (t: TesteMesa & { alvo?: number | null; dados?: { lados: number; count: number }; pool?: { positivos: number; negativos: number; dadosLados: number }; privado?: boolean }) => {
      setTestes((prev) => prev.some((x) => x.id === t.id) ? prev : [t as TesteMesa, ...prev]);
      if (t.alvo !== undefined && t.alvo !== null) {
        setRolagens((r) => [...r, { id: `aviso-${t.id}`, dados: [], lados: [t.dados?.lados ?? 20], total: null, motivo: (t as { rotulo?: string }).rotulo ?? "Teste solicitado", autor: t.requestedBy, ts: Date.now() }]);
      }
    };
    const aoRolagem = (r: { id: string; testId?: string; dados?: number[]; grupos?: { lados: number; resultados: number[] }[]; total: number; lados?: number; count?: number; rolador?: string; motivo?: string | null; visibility?: string; alvo?: number | null; createdAt?: string; vitalidade?: { nivel: number; nome: string; penalidadeDados: number; dadosOriginais: number; dadosFinais: number; excecaoMestre?: boolean } | null; dadosOriginais?: number; d10?: { positivos: number; negativos: number; minimo: number; lancados: number; sucessos: number; falhas: number } | null }) => {
      if (r.testId) setTestes((prev) => prev.map((t) => t.id === r.testId ? { ...t, status: "rolado" } : t));
      const grupos = r.grupos ?? (r.dados ? [{ lados: r.lados ?? 20, resultados: r.dados }] : []);
      setRolagens((prev) => prev.some((x) => x.id === r.id) ? prev : [...prev, {
        id: r.id, dados: grupos.map((g) => g.resultados), lados: grupos.map((g) => g.lados),
        total: r.total, motivo: r.motivo ?? null, autor: r.rolador, ts: Date.now(),
        vitalidade: r.vitalidade ?? null, dadosOriginais: r.dadosOriginais, d10: r.d10 ?? null,
      }]);
    };
    const aoDecisao = (d: { testId: string; outcome: string; nota?: string | null; characterName?: string; visibility?: string }) => {
      setTestes((prev) => prev.map((t) => t.id === d.testId ? { ...t, status: "decidido", outcome: d.outcome, outcomeNote: d.nota ?? null } : t));
    };
    const aoTurnos = (t: { turnos: TurnosState }) => setTurnos(t.turnos);
    const aoTimer = (t: TimerView & { sessionId?: string }) => {
      if (t.sessionId === sessao.id || !t.sessionId) setTimer(t);
    };
    const aoPresenca = (p: { sessionId: string; online: string[] }) => {
      if (p.sessionId === sessao.id) setOnline(p.online);
    };
    const aoSessao = () => void api.obterEstadoMesa(campaignId, sessao.id).then((e) => { setSessaoAtual(e.sessao); setTurnos(e.turnos); }).catch(() => undefined);

    socket.on("mesa:mensagem", aoMensagem);
    socket.on("mesa:teste", aoTeste);
    socket.on("mesa:rolagem", aoRolagem);
    socket.on("mesa:decisao", aoDecisao);
    socket.on("mesa:turnos", aoTurnos);
    socket.on("mesa:timer", aoTimer);
    socket.on("mesa:presenca", aoPresenca);
    socket.on("sessao:atualizada", aoSessao);

    socket.emit("mesa:entrar", { sessionId: sessao.id }, (r: { ok?: boolean; papel?: string; podeEnviar?: boolean; turnos?: TurnosState; presenca?: string[] }) => {
      if (r?.ok) {
        if (r.papel) setPapel(r.papel);
        if (typeof r.podeEnviar === "boolean") setPodeEnviar(r.podeEnviar);
        if (r.turnos) setTurnos(r.turnos);
        if (r.presenca) setOnline(r.presenca);
      } else {
        setErro("Não foi possível entrar na mesa");
      }
    });

    return () => {
      socket.emit("mesa:sair", { sessionId: sessao.id });
      socket.off("mesa:mensagem", aoMensagem);
      socket.off("mesa:teste", aoTeste);
      socket.off("mesa:rolagem", aoRolagem);
      socket.off("mesa:decisao", aoDecisao);
      socket.off("mesa:turnos", aoTurnos);
      socket.off("mesa:timer", aoTimer);
      socket.off("mesa:presenca", aoPresenca);
      socket.off("sessao:atualizada", aoSessao);
      socket.emit("sair-campanha", campaignId);
    };
  }, [campaignId, sessao.id]);

  // auto-scroll chat
  useEffect(() => { chatRef.current?.scrollTo({ top: chatRef.current.scrollHeight }); }, [mensagens.length]);

  // tick local do timer entre eventos do servidor
  useEffect(() => {
    if (timer?.status !== "rodando") return;
    timerRef.current = window.setInterval(() => forcarTick((n) => n + 1), 500);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [timer?.status]);

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    const content = texto.trim();
    if (!content) return;
    const socket = getSocket();
    socket.emit("mesa:mensagem", {
      sessionId: sessao.id, content, clientId: crypto.randomUUID(),
      tipo: comoAcao ? "acao" : "texto",
      visibilidade: secreto ? "secreta" : privado ? "privada" : "publica",
      destinatarioUserId: privado ? destinoPriv || undefined : undefined,
    }, (r: { ok?: boolean; erro?: string }) => {
      if (!r?.ok) setErro(r?.erro ?? "Falha ao enviar");
      else setTexto("");
    });
  };

  const socketEmit = (evento: string, payload: Record<string, unknown>, cb?: (r: { ok?: boolean; erro?: string }) => void) => {
    getSocket().emit(evento, { sessionId: sessao.id, ...payload }, cb ?? ((r: { ok?: boolean; erro?: string }) => { if (r && !r.ok) setErro(r.erro ?? "Erro"); }));
  };

  const pausarSessao = async () => {
    const novo = sessaoAtual.status === "pausada" ? "ativa" : "pausada";
    await api.atualizarSessao(campaignId, sessao.id, { status: novo });
    setSessaoAtual({ ...sessaoAtual, status: novo });
  };
  const encerrarSessao = async () => {
    if (ocupadoEncerrar) return;
    setOcupadoEncerrar(true);
    try {
      await api.atualizarSessao(campaignId, sessao.id, { status: "encerrada" });
      aoSair();
    } finally {
      setOcupadoEncerrar(false);
    }
  };

  const restantes = timer?.status === "rodando" && timer.endsAt && timer.servidorAgora
    ? Math.max(0, timer.endsAt - timer.servidorAgora)
    : timer?.remainingMs ?? 0;

  const testesPendentes = testes.filter((t) => t.status === "pendente");
  const testesRecentes = testes.filter((t) => t.status !== "pendente").slice(0, 10);

  const nomeMembro = (membershipId: string) => {
    const m = membros.find((x) => x.membershipId === membershipId);
    return m ? (m.displayName || m.username) : "?";
  };
  const turnoAtualNome = turnos.ativo && turnos.atual >= 0 ? nomeMembro(turnos.ordem[turnos.atual]) : null;

  return (
    <div className="mesa-view">
    <>
      <section className="cartao">
        <div className="linha-entre">
          <div>
            <h2>Mesa — {sessaoAtual.name}</h2>
            <p className="meta">
              <span className={`badge badge-${sessaoAtual.status === "ativa" ? "aprovada" : "devolvida"}`}>{sessaoAtual.status}</span>
              {" "}Online: {online.length ? online.map((id) => membros.find((m) => m.userId === id)?.displayName || membros.find((m) => m.userId === id)?.username || "?").join(", ") : "ninguém"}
              {" · "}<IndicadorConexao />
            </p>
          </div>
          <div className="linha">
            {souMestre && sessaoAtual.status !== "encerrada" && (
              <>
                <button className="secundario" onClick={() => void pausarSessao()}>{sessaoAtual.status === "pausada" ? "Retomar" : "Pausar"}</button>
                <button className="perigo" onClick={() => setConfirmandoEncerrar(true)}>Encerrar</button>
              </>
            )}
            <button className="secundario" onClick={aoSair}>Sair da mesa</button>
          </div>
        </div>
        {erro && <p className="erro">{erro}</p>}
      </section>

      <div className="mesa-grade">
        {/* coluna esquerda: chat */}
        <section className="cartao mesa-chat">
          <h3>Chat</h3>
          <div className="chat-lista" ref={chatRef}>
            {mensagens.map((m) => (
              <div key={m.id} className={`chat-msg chat-${m.kind} ${m.visibility === "privada" ? "privada" : m.visibility === "mestre" ? "secreta" : ""}`}>
                <span className="chat-autor">{m.autorNome ?? m.autor?.displayName ?? m.autor?.username ?? "Sistema"}</span>
                <span className="chat-hora">{new Date(m.createdAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span>
                {m.visibility === "privada" && <span className="tag">privada</span>}
                {m.visibility === "mestre" && souMestre && <span className="tag">secreta</span>}
                <div className="chat-conteudo">{m.content}</div>
              </div>
            ))}
            {mensagens.length === 0 && <p className="meta">Sem mensagens ainda.</p>}
          </div>
          {sessaoAtual.status !== "encerrada" && (papel !== "espectador" || podeEnviar) && (
            <form className="chat-form" onSubmit={enviar}>
              <div className="linha">
                <label className="check"><input type="checkbox" checked={comoAcao} onChange={(e) => setComoAcao(e.target.checked)} /> Ação</label>
                {souMestre && <>
                  <label className="check"><input type="checkbox" checked={privado} onChange={(e) => { setPrivado(e.target.checked); if (e.target.checked) setSecreto(false); }} /> Privada</label>
                  <label className="check"><input type="checkbox" checked={secreto} onChange={(e) => { setSecreto(e.target.checked); if (e.target.checked) setPrivado(false); }} /> Secreta</label>
                </>}
              </div>
              {privado && !secreto && (
                <select value={destinoPriv} onChange={(e) => setDestinoPriv(e.target.value)}>
                  <option value="">Destinatário…</option>
                  {membros.filter((m) => m.userId !== meuUserId).map((m) => <option key={m.userId} value={m.userId}>{m.displayName || m.username}</option>)}
                </select>
              )}
              <div className="linha">
                <input value={texto} onChange={(e) => setTexto(e.target.value)} placeholder={comoAcao ? "Declare sua ação…" : "Mensagem…"} required />
                <button type="submit">Enviar</button>
              </div>
            </form>
          )}
          {papel === "espectador" && <p className="meta">{podeEnviar ? "Modo espectador — pode comentar no chat." : "Modo espectador — apenas leitura."}</p>}
        </section>

        {/* coluna direita: painéis */}
        <div className="mesa-lateral">
          {/* turno */}
          <section className="cartao">
            <h3>Turno</h3>
            {turnos.ativo ? (
              <p><strong>{turnoAtualNome ?? "—"}</strong> é a vez</p>
            ) : <p className="meta">Sem sequência ativa.</p>}
            {souMestre && (
              <div className="linha linha-botoes">
                <button className="secundario" onClick={() => socketEmit("mesa:turno", { acao: "iniciar", ordem: membros.map((m) => m.membershipId) })}>Iniciar</button>
                <button className="secundario" onClick={() => socketEmit("mesa:turno", { acao: "avancar" })}>Avançar</button>
                <button className="secundario" onClick={() => socketEmit("mesa:turno", { acao: "voltar" })}>Voltar</button>
                <button className="secundario" onClick={() => socketEmit("mesa:turno", { acao: "pular" })}>Pular</button>
                <button className="secundario" onClick={() => socketEmit("mesa:turno", { acao: "encerrar" })}>Encerrar</button>
              </div>
            )}
            {turnos.ativo && turnos.ordem.length > 0 && (
              <p className="meta">Ordem: {turnos.ordem.map((id, i) => (
                <span key={id} className={i === turnos.atual ? "tag tag-atual" : "tag"}>{nomeMembro(id)}</span>
              ))}</p>
            )}
          </section>

          {/* temporizador */}
          <section className="cartao">
            <h3>Temporizador</h3>
            <p className={`timer-display ${timer?.status === "rodando" ? "rodando" : ""}`}>
              {timer?.status === "rodando" || timer?.status === "pausado" ? fmtTempo(restantes) : "—"}
              {timer?.status === "pausado" && <span className="meta"> (pausado)</span>}
            </p>
            {souMestre && sessaoAtual.status !== "encerrada" && (
              <div className="linha linha-botoes">
                <button className="secundario" onClick={() => socketEmit("mesa:timer", { acao: timer?.status === "rodando" ? "pausar" : timer?.status === "pausado" ? "retomar" : "iniciar", duracaoSegundos: 300 })}>
                  {timer?.status === "rodando" ? "Pausar" : timer?.status === "pausado" ? "Retomar" : "Iniciar (5min)"}
                </button>
                <button className="secundario" onClick={() => socketEmit("mesa:timer", { acao: "reiniciar" })}>Reiniciar</button>
                <button className="secundario" onClick={() => socketEmit("mesa:timer", { acao: "encerrar" })}>Encerrar</button>
              </div>
            )}
          </section>

          {/* testes pendentes */}
          {testesPendentes.length > 0 && (
            <section className="cartao">
              <h3>Testes pendentes</h3>
              {testesPendentes.map((t) => {
                const ehDono = souDonoTeste(t);
                const podeAgir = souMestre || ehDono;
                return (
                  <div key={t.id} className="teste-card">
                    <p><strong>{personagens.find((p) => p.id === t.characterId)?.name ?? "?"}</strong> — {String((t.skillRef as { rotulo?: string } | null)?.rotulo ?? t.rotulo ?? "teste")}{(t.pool?.dadosLados ?? t.diceSides) === 10 && <span className="tag">D10</span>}</p>
                    {(() => {
                      const lados = t.pool?.dadosLados ?? t.diceSides;
                      const pool = t.pool ?? (t.modifiers?.positivos != null ? { positivos: t.modifiers.positivos, negativos: t.modifiers.malus ?? 0, dadosLados: lados } : null);
                      return pool ? (
                        <p className="meta">
                          {pool.positivos}d{pool.dadosLados} positivo{pool.positivos === 1 ? "" : "s"}
                          {pool.negativos ? ` · −${pool.negativos} negativo${pool.negativos === 1 ? "" : ""} → ${Math.max(0, pool.positivos - pool.negativos)} efetivo${pool.positivos - pool.negativos === 1 ? "" : "s"}` : ""}
                        </p>
                      ) : null;
                    })()}
                    {souMestre && <p className="meta">{t.diceCount}d{t.diceSides}{t.target != null ? ` · alvo ${t.target}` : ""}</p>}
                    {podeAgir && t.status === "pendente" && (
                      <div className="linha linha-botoes">
                        {(souMestre || ehDono) && (
                          <button onClick={() => getSocket().emit("mesa:teste:rolar", { testId: t.id, requestId: crypto.randomUUID() }, (r: { ok?: boolean; dados?: number[]; total?: number }) => {
                            if (r?.dados) setRolagens((prev) => [...prev, { id: `t-${t.id}`, dados: [r.dados!], lados: [t.diceSides], total: r.total ?? null, motivo: "Teste", ts: Date.now() }]);
                          })}>Rolar</button>
                        )}
                        {souMestre && (
                          <select id={`out-${t.id}`} defaultValue="">
                            <option value="" disabled>Decidir…</option>
                            <option value="sucesso">Sucesso</option>
                            <option value="parcial">Parcial</option>
                            <option value="falha">Falha</option>
                            <option value="falha_critica">Falha crítica</option>
                          </select>
                        )}
                        {souMestre && (
                          <>
                            <input id={`nota-${t.id}`} placeholder="Nota narrativa (opcional)" style={{ minWidth: 160 }} />
                            <button className="secundario" onClick={() => {
                              const sel = document.getElementById(`out-${t.id}`) as HTMLSelectElement;
                              if (!sel.value) return;
                              const nota = (document.getElementById(`nota-${t.id}`) as HTMLInputElement)?.value;
                              getSocket().emit("mesa:teste:decidir", { testId: t.id, outcome: sel.value, nota: nota || undefined }, () => undefined);
                            }}>Confirmar</button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          )}

          {/* solicitar teste (mestre) */}
          {souMestre && papel !== "espectador" && (
            <SolicitarTeste sessionId={sessao.id} personagens={personagens} aoErro={setErro} />
          )}

          {/* desafio D10 (mestre) */}
          {souMestre && papel !== "espectador" && (
            <DesafioD10 sessionId={sessao.id} personagens={personagens} aoErro={setErro} />
          )}

          {/* lançador unificado: testes D10 | rolagem livre e dano */}
          {papel !== "espectador" && sessaoAtual.status !== "encerrada" && (
            <PainelDados sessionId={sessao.id} aoErro={setErro} minimoPadrao={minimoD10} souMestre={souMestre} />
          )}

          {/* resultados de dados */}
          {rolagens.length > 0 && (
            <section className="cartao">
              <h3>Rolagens</h3>
              {rolagens.slice(-8).reverse().map((r) => (
                <div key={r.id} className="rolagem-item">
                  <div className="linha">
                    {r.dados.map((resultados, gi) => (
                      <span key={gi} className="dados-grupo">
                        {resultados.map((v, i) => <FaceDado key={i} valor={v} lados={r.lados[gi]} indice={i} />)}
                      </span>
                    ))}
                    {r.total !== null && <strong> = {r.total}</strong>}
                  </div>
                  <p className="meta">
                    {r.autor ?? ""}{r.motivo ? ` — ${r.motivo}` : ""} · {new Date(r.ts).toLocaleTimeString("pt-BR")}
                  </p>
                  {r.vitalidade && (
                    <p className="meta vitalidade-rolagem">
                      Vitalidade: {r.vitalidade.nome}
                      {r.vitalidade.penalidadeDados > 0 && ` (−${r.vitalidade.penalidadeDados} dado${r.vitalidade.penalidadeDados > 1 ? "s" : ""})`}
                      {` — ${r.vitalidade.dadosOriginais}d → ${r.vitalidade.dadosFinais}d`}
                      {r.vitalidade.excecaoMestre && " · exceção do mestre"}
                    </p>
                  )}
                  {r.d10 && (
                    <p className="meta d10-rolagem">
                      D10: {r.d10.positivos} positivo{r.d10.positivos === 1 ? "" : "s"}
                      {r.d10.negativos ? ` − ${r.d10.negativos} negativo${r.d10.negativos === 1 ? "" : "s"}` : ""}
                      {` → ${r.d10.lancados} lançado${r.d10.lancados === 1 ? "" : "s"} · `}
                      <strong>{r.d10.sucessos} sucesso{r.d10.sucessos === 1 ? "" : "s"}</strong>
                      {` / ${r.d10.falhas} falha${r.d10.falhas === 1 ? "" : "s"} (mín ${r.d10.minimo})`}
                    </p>
                  )}
                </div>
              ))}
            </section>
          )}
        </div>
      </div>

      {/* decisões recentes */}
      {testesRecentes.length > 0 && (
        <section className="cartao">
          <h3>Decisões recentes</h3>
          <table className="tabela">
            <thead><tr><th>Personagem</th><th>Resultado</th><th>Obs.</th></tr></thead>
            <tbody>
              {testesRecentes.map((t) => (
                <tr key={t.id}>
                  <td>{personagens.find((p) => p.id === t.characterId)?.name ?? "?"}</td>
                  <td><span className={`badge badge-${t.outcome === "sucesso" ? "aprovada" : t.outcome === "parcial" ? "devolvida" : "bloqueada"}`}>{t.outcome ?? t.status}</span></td>
                  <td>{t.outcomeNote ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {confirmandoEncerrar && (
        <ModalConfirmar
          titulo="Encerrar sessão"
          mensagem="Encerrar a sessão?"
          rotuloConfirmar="Encerrar"
          perigo
          ocupado={ocupadoEncerrar}
          aoConfirmar={() => void encerrarSessao()}
          aoCancelar={() => { if (!ocupadoEncerrar) setConfirmandoEncerrar(false); }}
        />
      )}
    </>
    </div>
  );
}

// ================= COMPONENTES =================

function SolicitarTeste({ sessionId, personagens, aoErro }: {
  sessionId: string; personagens: PersonagemResumo[];
  aoErro: (e: string | null) => void;
}) {
  const [aberto, setAberto] = useState(false);
  const [characterId, setCharacterId] = useState("");
  const [rotulo, setRotulo] = useState("");
  const [lados, setLados] = useState(20);
  const [count, setCount] = useState(1);
  const [minimo, setMinimo] = useState<number | "">("");
  const [privado, setPrivado] = useState(false);

  if (personagens.length === 0) return null;
  return (
    <section className="cartao">
      <div className="linha-entre">
        <h3>Solicitar teste</h3>
        <button className="secundario" onClick={() => setAberto(!aberto)}>+ Teste</button>
      </div>
      {aberto && (
        <form className="formulario" onSubmit={(e: FormEvent) => {
          e.preventDefault();
          getSocket().emit("mesa:teste:pedir", {
            sessionId, characterId, rotulo: rotulo || undefined,
            dadosLados: lados, dadosCount: count,
            minimo: minimo === "" ? undefined : Number(minimo),
            visibilidade: privado ? "privada" : "publica",
            requestId: crypto.randomUUID(),
          }, (r: { ok?: boolean; erro?: string }) => {
            if (r?.ok) { setAberto(false); setRotulo(""); }
            else aoErro(r?.erro ?? "Erro");
          });
        }}>
          <label>Personagem
            <select value={characterId} onChange={(e) => setCharacterId(e.target.value)} required>
              <option value="">Escolher…</option>
              {personagens.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.displayName ?? p.dono})</option>)}
            </select>
          </label>
          <label>Habilidade/atributo (rótulo)
            <input value={rotulo} onChange={(e) => setRotulo(e.target.value)} placeholder="Ex.: Percepção, Computação…" />
          </label>
          <div className="grade-2">
            <label>Dado
              <select value={lados} onChange={(e) => setLados(Number(e.target.value))}>
                {LADOS.map((l) => <option key={l} value={l}>d{l}</option>)}
              </select>
            </label>
            <label>Quantidade
              <input type="number" min="1" max="30" value={count} onChange={(e) => setCount(Number(e.target.value))} />
            </label>
            <label>Mínimo (opcional, oculto do jogador se privado)
              <input type="number" value={minimo} onChange={(e) => setMinimo(e.target.value === "" ? "" : Number(e.target.value))} />
            </label>
            <label className="check"><input type="checkbox" checked={privado} onChange={(e) => setPrivado(e.target.checked)} /> Visibilidade privada</label>
          </div>
          <button type="submit">Solicitar</button>
        </form>
      )}
    </section>
  );
}

/** Desafio D10: mestre escolhe personagem + campo numérico da ficha; o
 *  servidor calcula os dados positivos pelo valor do campo e aplica os
 *  dados negativos como malus. O jogador rola pelo fluxo de teste normal. */
// Semânticos que nunca representam valor testável em desafio (dinheiro, itens/equipamento).
const SEMANTICOS_NAO_TESTAVEIS = new Set(["moeda", "item"]);

interface CampoTeste { id: string; label: string; valor: number; secao: string }
interface GrupoTeste { titulo: string; campos: CampoTeste[] }

function DesafioD10({ sessionId, personagens, aoErro }: {
  sessionId: string; personagens: PersonagemResumo[]; aoErro: (e: string | null) => void;
}) {
  const [aberto, setAberto] = useState(false);
  const [characterId, setCharacterId] = useState("");
  const [grupos, setGrupos] = useState<GrupoTeste[]>([]);
  const [campoId, setCampoId] = useState("");
  const [negativos, setNegativos] = useState(0);
  const [privado, setPrivado] = useState(false);
  const [carregando, setCarregando] = useState(false);

  const escolherPersonagem = async (id: string) => {
    setCharacterId(id);
    setCampoId("");
    setGrupos([]);
    if (!id) return;
    setCarregando(true);
    try {
      const det = await api.obterPersonagem(id);
      const valores = det.ficha?.campos ?? {};
      const porSecao = new Map<string, CampoTeste[]>();
      for (const s of det.ficha?.estrutura?.secoes ?? []) {
        for (const c of s.campos ?? []) {
          if ((c.tipo !== "inteiro" && c.tipo !== "decimal") || SEMANTICOS_NAO_TESTAVEIS.has(c.semantico)) continue;
          const v = valores[c.id];
          if (typeof v === "number" && Number.isFinite(v)) {
            const titulo = s.titulo || "Outros campos";
            const lista = porSecao.get(titulo) ?? [];
            lista.push({ id: c.id, label: c.label, valor: v, secao: titulo });
            porSecao.set(titulo, lista);
          }
        }
      }
      setGrupos([...porSecao.entries()].map(([titulo, campos]) => ({ titulo, campos })));
    } catch { /* sem ficha acessível */ }
    setCarregando(false);
  };

  const campos = grupos.flatMap((g) => g.campos);
  if (personagens.length === 0) return null;
  const campoSel = campos.find((c) => c.id === campoId);
  const efetivos = campoSel ? Math.max(0, Math.round(campoSel.valor) - Math.max(0, Math.round(negativos) || 0)) : null;

  return (
    <section className="cartao">
      <div className="linha-entre">
        <h3>Desafio D10</h3>
        <button className="secundario" onClick={() => setAberto(!aberto)}>+ Desafio</button>
      </div>
      {aberto && (
        <form className="formulario" onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (!campoSel) { aoErro("Escolha a habilidade/atributo do personagem"); return; }
          getSocket().emit("mesa:teste:pedir", {
            sessionId, characterId, campoId: campoSel.id, rotulo: campoSel.label,
            dadosLados: 10, malus: Math.max(0, Math.round(negativos) || 0),
            visibilidade: privado ? "privada" : "publica",
            requestId: crypto.randomUUID(),
          }, (r: { ok?: boolean; erro?: string }) => {
            if (r?.ok) { setAberto(false); setNegativos(0); }
            else aoErro(r?.erro ?? "Erro");
          });
        }}>
          <label>Personagem
            <select value={characterId} onChange={(e) => void escolherPersonagem(e.target.value)} required>
              <option value="">Escolher…</option>
              {personagens.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.displayName ?? p.dono})</option>)}
            </select>
          </label>
          <label>Habilidade/atributo (define os dados positivos)
            <select value={campoId} onChange={(e) => setCampoId(e.target.value)} required disabled={!characterId || carregando}>
              <option value="">{carregando ? "Carregando ficha…" : "Escolher…"}</option>
              {grupos.map((g) => (
                <optgroup key={g.titulo} label={g.titulo}>
                  {g.campos.map((c) => <option key={c.id} value={c.id}>{c.label} ({Math.round(c.valor)})</option>)}
                </optgroup>
              ))}
            </select>
          </label>
          {campos.length === 0 && characterId && !carregando && (
            <p className="meta">Nenhum campo numérico preenchido nesta ficha.</p>
          )}
          {campoSel && (
            <p className="meta">
              {Math.round(campoSel.valor)} dado{Math.round(campoSel.valor) === 1 ? "" : "s"} positivo{Math.round(campoSel.valor) === 1 ? "" : "s"} (valor do campo)
            </p>
          )}
          <div className="grade-2">
            <label>Dados negativos (penalidade do mestre)
              <input type="number" min="0" max="30" value={negativos} onChange={(e) => setNegativos(Number(e.target.value))} />
            </label>
            <label className="check"><input type="checkbox" checked={privado} onChange={(e) => setPrivado(e.target.checked)} /> Desafio privado</label>
          </div>
          {efetivos !== null && (
            <p className="meta">Efetivos: <strong>{efetivos}</strong> d10 · sucesso ≥ mínimo da campanha</p>
          )}
          <button type="submit" disabled={!campoSel}>Enviar desafio</button>
        </form>
      )}
    </section>
  );
}
