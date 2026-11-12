import { useCallback, useEffect, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  api,
  type Sessao, type MensagemMesa, type TesteMesa, type TurnosState,
  type Membro, type PersonagemResumo, type CampanhaResumo,
  type VttState, type TokenVtt, arquivoUrl,
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

    socket.emit("mesa:entrar", { sessionId: sessao.id }, (r: { ok?: boolean; papel?: string; podeEnviar?: boolean; turnos?: TurnosState; presenca?: string[]; sessao?: Sessao }) => {
      if (r?.ok) {
        if (r.papel) setPapel(r.papel);
        if (typeof r.podeEnviar === "boolean") setPodeEnviar(r.podeEnviar);
        if (r.turnos) setTurnos(r.turnos);
        if (r.presenca) setOnline(r.presenca);
        if (r.sessao) setSessaoAtual(r.sessao); // inclui vttState fresco (mapa/tokens)
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

      {/* mesa virtual: mapa + tokens */}
      <TabuleiroVtt
        campaignId={campaignId}
        sessionId={sessao.id}
        souMestre={souMestre}
        ehEspectador={papel === "espectador"}
        meuUserId={meuUserId}
        membros={membros}
        encerrada={sessaoAtual.status === "encerrada"}
        inicial={sessao.vttState ?? sessaoAtual.vttState ?? null}
      />

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
// Mesmo critério do backend (campoElegivelParaTeste em lib/ficha.ts):
// usadoEmTestes explícito manda; sem a flag (fichas antigas), cai no
// fallback por semântica — números "livres" (idade, contadores) não entram.
const SEMANTICOS_TESTAVEIS_FALLBACK = new Set(["atributo", "habilidade", "conhecimento", "talento"]);

function campoElegivelTeste(c: { tipo: string; semantico?: string; usadoEmTestes?: boolean }): boolean {
  if (c.tipo !== "inteiro" && c.tipo !== "decimal") return false;
  if (c.semantico === "moeda" || c.semantico === "item") return false;
  if (c.usadoEmTestes === true) return true;
  if (c.usadoEmTestes === false) return false;
  return SEMANTICOS_TESTAVEIS_FALLBACK.has(c.semantico ?? "");
}

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
          if (!campoElegivelTeste(c)) continue;
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
            <p className="meta">Nenhum campo elegível para teste nesta ficha. Marque "Usado em testes" no editor de fichas ou use atributos/habilidades/conhecimentos.</p>
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

// ================= MESA VIRTUAL (mapa + tokens) =================

// Posicao confirmada pelo servidor para um token. `rev` incrementa a
// cada mudança de posição vinda de estado autoritativo (mesa:vtt ou
// estado inicial) — movimentos otimistas locais nunca a alteram.
type PosicaoConfirmada = { x: number; y: number; rev: number };

// ---------- névoa de guerra (Etapa 2) ----------
// Geometria idêntica ao backend (servidor/src/lib/vtt.ts): cada traço é uma
// cápsula elíptica de raios (raioX, raioY) em coordenadas normalizadas 0–1.
// No canvas (espaço de pixels w×h) o raio elíptico vira (raioX*w, raioY*h).
const NEVOA_RAIO_MIN = 0.005;
const NEVOA_RAIO_MAX = 0.5;
const NEVOA_MAX_PONTOS = 128;

function vttInicialParse(inicial: VttState | string | null | undefined): VttState {
  if (!inicial) return { mapa: null, tokens: [] };
  if (typeof inicial === "string") {
    try { return JSON.parse(inicial) as VttState; } catch { return { mapa: null, tokens: [] }; }
  }
  return inicial;
}

/** Desenha uma cápsula elíptica (traço do backend) em coords normalizadas→pixels. */
function desenharTracoNevoa(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  traco: { raioX: number; raioY: number; pontos: { x: number; y: number }[] },
) {
  const ps = traco.pontos;
  if (!ps.length) return;
  ctx.save();
  ctx.scale(w, h); // espaço normalizado 0–1
  if (ps.length === 1) {
    ctx.beginPath();
    ctx.ellipse(ps[0].x, ps[0].y, traco.raioX, traco.raioY, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = 2; // diâmetro unitário no espaço escalado pelo raio
  for (let i = 0; i < ps.length - 1; i++) {
    const a = ps[i], b = ps[i + 1];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    ctx.save();
    ctx.translate(mx, my);
    ctx.scale(traco.raioX, traco.raioY);
    ctx.beginPath();
    ctx.moveTo((a.x - mx) / traco.raioX, (a.y - my) / traco.raioY);
    ctx.lineTo((b.x - mx) / traco.raioX, (b.y - my) / traco.raioY);
    ctx.stroke();
    ctx.restore();
  }
  // extremidades: elipses nos pontos iniciais/finais para cantos arredondados
  for (const p of [ps[0], ps[ps.length - 1]]) {
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, traco.raioX, traco.raioY, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Amostragem para o limite de 128 pontos, preservando início e fim. */
function amostrarPontos(ps: { x: number; y: number }[], max = NEVOA_MAX_PONTOS): { x: number; y: number }[] {
  if (ps.length <= max) return ps;
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < max; i++) {
    const idx = Math.round((i * (ps.length - 1)) / (max - 1));
    out.push(ps[idx]);
  }
  out[0] = ps[0];
  out[max - 1] = ps[ps.length - 1];
  return out;
}

function TabuleiroVtt({ campaignId, sessionId, souMestre, ehEspectador, meuUserId, membros, encerrada, inicial }: {
  campaignId: string; sessionId: string; souMestre: boolean; ehEspectador: boolean; meuUserId: string;
  membros: Membro[]; encerrada: boolean; inicial: VttState | string | null;
}) {
  const [vtt, setVtt] = useState<VttState>(() => vttInicialParse(inicial));
  const [erroVtt, setErroVtt] = useState<string | null>(null);
  const [novoNome, setNovoNome] = useState("");
  const [novoUserId, setNovoUserId] = useState("");
  const [selVtt, setSelVtt] = useState<string | null>(null);
  const tabRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ id: string; movendo: boolean } | null>(null);
  const confRef = useRef<Map<string, PosicaoConfirmada>>(new Map());

  // Sincroniza a referência autoritativa SOMENTE com estados vindos do
  // servidor. O setVtt otimista do arraste nunca passa por aqui.
  const sincronizarAutoritativo = (estado: VttState) => {
    const mapa = confRef.current;
    const vistos = new Set<string>();
    for (const tk of estado.tokens ?? []) {
      vistos.add(tk.id);
      const prev = mapa.get(tk.id);
      if (!prev) mapa.set(tk.id, { x: tk.x, y: tk.y, rev: 1 });
      else if (prev.x !== tk.x || prev.y !== tk.y) mapa.set(tk.id, { x: tk.x, y: tk.y, rev: prev.rev + 1 });
    }
    for (const id of [...mapa.keys()]) if (!vistos.has(id)) mapa.delete(id);
  };

  useEffect(() => {
    const socket = getSocket();
    const aoVtt = (d: { sessionId?: string; vtt?: VttState }) => {
      if (d?.sessionId === sessionId && d.vtt) {
        sincronizarAutoritativo(d.vtt);
        setVtt(d.vtt);
      }
    };
    socket.on("mesa:vtt", aoVtt);
    return () => { socket.off("mesa:vtt", aoVtt); };
  }, [sessionId]);

  // sincroniza com o estado persistido quando a sessão é recarregada
  // (ex.: entrada tardia na sala — eventos emitidos antes do join se perdem)
  useEffect(() => {
    const ini = vttInicialParse(inicial);
    sincronizarAutoritativo(ini);
    setVtt(ini);
    setPincel(false); setPreviewNevoa(null); // sessão/troca de estado: limpa rascunho
  }, [inicial]);

  // ---------- névoa de guerra ----------
  const nevoaCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pincel, setPincel] = useState(false);          // modo desenho (só mestre)
  const [raioNevoa, setRaioNevoa] = useState(0.08);    // raio normalizado 0–1
  const [pendenteNevoa, setPendenteNevoa] = useState(false);
  const [previewNevoa, setPreviewNevoa] = useState<{ pontos: { x: number; y: number }[] } | null>(null);
  const desenhoRef = useRef<{ pontos: { x: number; y: number }[] } | null>(null);
  const nevoa = vtt.nevoa ?? { ativa: false, revelados: [] };
  const souMestreCena = souMestre && !encerrada && !!vtt.mapa;

  // redesenha a camada de névoa quando o estado autoritativo muda
  useEffect(() => {
    const cv = nevoaCanvasRef.current;
    const el = tabRef.current;
    if (!cv || !el) return;
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!nevoa.ativa) return;
    if (souMestre || ehEspectador || true) {
      // não-mestres: véu opaco com buracos revelados (destination-out)
      if (!souMestre) {
        ctx.save();
        ctx.fillStyle = "rgba(8,10,16,0.96)";
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = "destination-out";
        ctx.fillStyle = "#000";
        for (const tr of nevoa.revelados) desenharTracoNevoa(ctx, w, h, tr);
        ctx.restore();
      } else {
        // mestre: destaque sutil das áreas reveladas (mapa segue visível)
        ctx.save();
        ctx.fillStyle = "rgba(120,200,255,0.10)";
        for (const tr of nevoa.revelados) desenharTracoNevoa(ctx, w, h, tr);
        ctx.strokeStyle = "rgba(120,200,255,0.35)";
        ctx.lineWidth = 1;
        for (const tr of nevoa.revelados) desenharTracoNevoa(ctx, w, h, tr);
        ctx.restore();
      }
    }
    // prévia do traço em desenho (mestre)
    if (pincel && previewNevoa && previewNevoa.pontos.length) {
      ctx.save();
      ctx.fillStyle = "rgba(255,209,102,0.35)";
      ctx.strokeStyle = "rgba(255,209,102,0.8)";
      ctx.lineWidth = 1.5;
      desenharTracoNevoa(ctx, w, h, { raioX: raioNevoa, raioY: raioNevoa, pontos: previewNevoa.pontos });
      ctx.restore();
    }
  }, [nevoa, previewNevoa, pincel, raioNevoa, souMestre, vtt.mapa?.fileId]);

  // limpa estados temporários ao trocar de sessão
  useEffect(() => {
    setPincel(false); setPreviewNevoa(null); desenhoRef.current = null; setPendenteNevoa(false);
  }, [sessionId]);

  const pontoNormalizado = (ev: { clientX: number; clientY: number }) => {
    const el = tabRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)),
    };
  };

  const emitirNevoa = (acao: string, traco?: { raioX: number; raioY: number; pontos: { x: number; y: number }[] }) => {
    setPendenteNevoa(true);
    setErroVtt(null);
    getSocket().emit("mesa:vtt:nevoa", { sessionId, acao, traco }, (r: { ok?: boolean; erro?: string }) => {
      setPendenteNevoa(false);
      if (r && r.ok === false) {
        setErroVtt(r.erro ?? "Ação de névoa recusada");
        setPreviewNevoa(null); // rejeição: limpa prévia, nada é confirmado localmente
      }
      // sucesso: o broadcast mesa:vtt traz o estado autoritativo
    });
  };

  const iniciarPincel = (e: ReactPointerEvent) => {
    if (!pincel || !souMestreCena || pendenteNevoa) return;
    const p = pontoNormalizado(e);
    if (!p) return;
    e.preventDefault();
    try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); } catch { /* ok */ }
    desenhoRef.current = { pontos: [p] };
    setPreviewNevoa({ pontos: [p] });
    const mover = (ev: PointerEvent) => {
      const d = desenhoRef.current;
      if (!d) return;
      const q = pontoNormalizado(ev);
      if (!q) return;
      const ultimo = d.pontos[d.pontos.length - 1];
      // dedup por distância mínima para não inflar o traço
      if (Math.hypot(q.x - ultimo.x, q.y - ultimo.y) < 0.004) return;
      d.pontos.push(q);
      setPreviewNevoa({ pontos: [...d.pontos] });
    };
    const soltar = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", mover);
      window.removeEventListener("pointerup", soltar);
      window.removeEventListener("pointercancel", soltar);
      const d = desenhoRef.current;
      desenhoRef.current = null;
      setPreviewNevoa(null);
      if (!d || d.pontos.length === 0) return;
      const q = pontoNormalizado(ev);
      if (q) {
        const ultimo = d.pontos[d.pontos.length - 1];
        if (Math.hypot(q.x - ultimo.x, q.y - ultimo.y) >= 0.004) d.pontos.push(q);
      }
      const pontos = amostrarPontos(d.pontos);
      emitirNevoa("revelar", { raioX: raioNevoa, raioY: raioNevoa, pontos });
    };
    const cancelar = () => {
      window.removeEventListener("pointermove", mover);
      window.removeEventListener("pointerup", soltar);
      window.removeEventListener("pointercancel", cancelar);
      desenhoRef.current = null;
      setPreviewNevoa(null);
    };
    window.addEventListener("pointermove", mover);
    window.addEventListener("pointerup", soltar);
    window.addEventListener("pointercancel", cancelar);
  };

  const emitir = (payload: Record<string, unknown>, cb?: (r: { ok?: boolean; erro?: string }) => void) => {
    getSocket().emit("mesa:vtt:token", { sessionId, ...payload }, (r: { ok?: boolean; erro?: string }) => {
      if (r && r.ok === false) setErroVtt(r.erro ?? "Ação recusada");
      cb?.(r);
    });
  };
  const emitirMapa = (payload: Record<string, unknown>) => {
    getSocket().emit("mesa:vtt:mapa", { sessionId, ...payload }, (r: { ok?: boolean; erro?: string }) => {
      if (r && r.ok === false) setErroVtt(r.erro ?? "Ação recusada");
    });
  };

  const ehDono = (tk: TokenVtt) =>
    souMestre || (!!meuUserId && (tk.userId === meuUserId || !!membros.find((m) => m.userId === meuUserId && tk.userId === m.userId)));

  const iniciarArraste = (tk: TokenVtt) => (e: ReactPointerEvent) => {
    if (encerrada || ehEspectador || (!souMestre && !ehDono(tk))) return;
    e.preventDefault();
    try { (e.target as HTMLElement).setPointerCapture?.(e.pointerId); } catch { /* ponteiro sintético/inativo */ }
    dragRef.current = { id: tk.id, movendo: true };
    const mover = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d || d.id !== tk.id) return;
      const el = tabRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      const y = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
      // otimista local; servidor confirma via mesa:vtt
      setVtt((v) => ({ ...v, tokens: v.tokens.map((t) => (t.id === tk.id ? { ...t, x, y } : t)) }));
    };
    const soltar = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", mover);
      window.removeEventListener("pointerup", soltar);
      const d = dragRef.current;
      dragRef.current = null;
      if (!d || d.id !== tk.id) return;
      const el = tabRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const x = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      const y = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
      // posição final do drop também é otimista — garante que o visual
      // corresponda exatamente às coordenadas emitidas ao servidor
      setVtt((v) => ({ ...v, tokens: v.tokens.map((t) => (t.id === tk.id ? { ...t, x, y } : t)) }));
      // Rollback: rejeição/timeout só reverte se (a) a revisão
      // autoritativa do token não mudou desde o início desta operação
      // e (b) o token ainda está visualmente na posição otimista deste
      // drop. Restaura conf0 — última posição confirmada pelo servidor —
      // nunca o estado capturado do closure de renderização.
      const conf0 = confRef.current.get(tk.id) ?? { x: tk.x, y: tk.y, rev: 0 };
      const rev0 = conf0.rev;
      const reverter = () => setVtt((v) => {
        const conf = confRef.current.get(tk.id);
        if (!conf || conf.rev !== rev0) return v;
        const atual = v.tokens.find((t) => t.id === tk.id);
        if (!atual || atual.x !== x || atual.y !== y) return v;
        return { ...v, tokens: v.tokens.map((t) => (t.id === tk.id ? { ...t, x: conf0.x, y: conf0.y } : t)) };
      });
      let respondido = false;
      const timeout = window.setTimeout(() => {
        if (respondido) return;
        respondido = true;
        setErroVtt("Sem resposta do servidor — posição revertida");
        reverter();
      }, 5000);
      emitir({ acao: souMestre ? "atualizar" : "mover", token: { id: tk.id, x, y } }, (resp) => {
        respondido = true;
        window.clearTimeout(timeout);
        if (resp && resp.ok === false) reverter();
      });
    };
    window.addEventListener("pointermove", mover);
    window.addEventListener("pointerup", soltar);
  };

  const enviarMapa = async (arquivo: File) => {
    setErroVtt(null);
    try {
      const up = await api.enviarArquivo(campaignId, arquivo, { category: "mapa", visibility: "publica" });
      emitirMapa({ acao: "definir", mapa: { fileId: up.id, nome: arquivo.name } });
    } catch (e) {
      setErroVtt(e instanceof Error ? e.message : "Falha no upload do mapa");
    }
  };

  return (
    <section className="cartao mesa-vtt">
      <div className="linha-entre">
        <h3>Tabuleiro</h3>
        {souMestre && !encerrada && (
          <div className="linha">
            <label className="botao-mini secundario">
              {vtt.mapa ? "Trocar mapa" : "Definir mapa"}
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void enviarMapa(f); e.target.value = ""; }} />
            </label>
            {vtt.mapa && <button className="secundario" onClick={() => emitirMapa({ acao: "remover" })}>Remover mapa</button>}
          </div>
        )}
      </div>
      {erroVtt && <p className="erro">{erroVtt}</p>}
      {!vtt.mapa ? (
        <p className="dica">{souMestre ? "Nenhum mapa definido. Envie uma imagem para montar o tabuleiro." : "O mestre ainda não definiu um mapa para esta sessão."}</p>
      ) : (
        <div
          ref={tabRef}
          className="vtt-tabuleiro"
          style={{ backgroundImage: `url(${arquivoUrl(campaignId, vtt.mapa.fileId)})` }}
        >
          <canvas
            ref={nevoaCanvasRef}
            className={`vtt-nevoa-canvas ${pincel ? "vtt-nevoa-canvas-pincel" : ""}`}
            onPointerDown={iniciarPincel}
          />
          {vtt.tokens.filter((t) => t.ativo).map((tk) => {
            const meu = ehDono(tk);
            return (
              <button
                key={tk.id}
                type="button"
                className={`vtt-token ${meu ? "vtt-token-meu" : ""} ${tk.userId === meuUserId || (!tk.userId && !tk.personagemId && souMestre) ? "" : ""}`}
                style={{ left: `${tk.x * 100}%`, top: `${tk.y * 100}%`, background: tk.cor, borderColor: tk.cor }}
                title={tk.nome}
                onPointerDown={iniciarArraste(tk)}
                onClick={() => { if (souMestre && !encerrada) setSelVtt(tk.id); }}
              >{tk.nome.slice(0, 2).toUpperCase()}</button>
            );
          })}
        </div>
      )}
      {souMestre && !encerrada && vtt.mapa && (
        <div className="linha vtt-controles">
          <input placeholder="Nome do token" value={novoNome} onChange={(e) => setNovoNome(e.target.value)} />
          <select value={novoUserId} onChange={(e) => setNovoUserId(e.target.value)}>
            <option value="">Sem dono</option>
            {membros.filter((m) => m.status !== "removido").map((m) => (
              <option key={m.userId} value={m.userId}>{m.displayName || m.username}</option>
            ))}
          </select>
          <button
            className="primario"
            onClick={() => {
              if (!novoNome.trim()) return;
              emitir({
                acao: "criar",
                token: { nome: novoNome.trim(), cor: "#4f8ef7", x: 0.5, y: 0.5, userId: novoUserId || null },
              }, () => { setNovoNome(""); setNovoUserId(""); });
            }}
          >Adicionar token</button>
          {selVtt && (
            <button className="perigo" onClick={() => { emitir({ acao: "remover", token: { id: selVtt } }); setSelVtt(null); }}>Remover selecionado</button>
          )}
        </div>
      )}
      {souMestreCena && (
        <div className="linha vtt-controles vtt-nevoa-controles">
          <button
            className={pincel ? "primario" : "secundario"}
            disabled={pendenteNevoa}
            onClick={() => { setPincel((p) => !p); setPreviewNevoa(null); desenhoRef.current = null; }}
          >{pincel ? "Sair do pincel" : "Pincel de névoa"}</button>
          {pincel && (
            <label className="vtt-nevoa-raio">
              Raio
              <input
                type="range" min={NEVOA_RAIO_MIN} max={NEVOA_RAIO_MAX} step={0.005}
                value={raioNevoa}
                onChange={(e) => setRaioNevoa(Number(e.target.value))}
              />
              <span>{Math.round(raioNevoa * 100)}%</span>
            </label>
          )}
          <button className="secundario" disabled={pendenteNevoa || nevoa.revelados.length === 0}
            onClick={() => emitirNevoa("desfazer")}>Desfazer traço</button>
          <button className="secundario" disabled={pendenteNevoa}
            onClick={() => emitirNevoa("ocultarTudo")}>Ocultar tudo</button>
          <button className="secundario" disabled={pendenteNevoa}
            onClick={() => emitirNevoa("revelarTudo")}>Revelar tudo</button>
          <span className="meta">
            Névoa: {nevoa.ativa ? `ativa (${nevoa.revelados.length} traço${nevoa.revelados.length === 1 ? "" : "s"})` : "desativada"}
          </span>
        </div>
      )}
    </section>
  );
}
