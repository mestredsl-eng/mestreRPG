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
  const seqSessoesRef = useRef(0);

  const carregar = useCallback(async () => {
    const seq = ++seqSessoesRef.current;
    try {
      const { sessoes } = await api.listarSessoes(campaignId);
      if (seq !== seqSessoesRef.current) return; // resposta de geração antiga
      setSessoes(sessoes);
      setErro(null);
      return sessoes;
    } catch (e) { setErro(e instanceof Error ? e.message : "Erro"); return null; }
  }, [campaignId]);

  useEffect(() => { void carregar(); }, [carregar]);

  // campanha:restaurada — snapshot/import substituiu o estado: a sessão
  // selecionada pode ter sumido ou trocado de ID. Rebusca a lista real
  // (resposta de geração antiga é descartada pelo seq) e, se o ID não
  // existir mais, desmonta a MesaView — nenhum mapa/token/mensagem da
  // sessão antiga permanece na tela.
  const [restKey, setRestKey] = useState(0);
  useEffect(() => {
    const socket = getSocket();
    const aoRestaurada = (d: { campaignId?: string }) => {
      if (d?.campaignId !== campaignId) return;
      void carregar().then((lista) => {
        if (!lista) return;
        setAtiva((atual) => {
          if (!atual) return atual;
          const mantida = lista.find((s) => s.id === atual.id) ?? null;
          // ID preservado: MesaView permanece, mas restKey força a
          // recarga completa do estado autoritativo pós-restore
          if (mantida) setRestKey((k) => k + 1);
          return mantida; // ID substituído → volta à lista
        });
      });
    };
    socket.on("campanha:restaurada", aoRestaurada);
    return () => { socket.off("campanha:restaurada", aoRestaurada); };
  }, [campaignId, carregar]);

  if (ativa) {
    return <MesaView campaignId={campaignId} sessao={ativa} souMestre={souMestre} restKey={restKey} aoSair={() => { setAtiva(null); void carregar(); }} />;
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

function MesaView({ campaignId, sessao, souMestre, restKey = 0, aoSair }: {
  campaignId: string; sessao: Sessao; souMestre: boolean; restKey?: number; aoSair: () => void;
}) {
  const [mensagens, setMensagens] = useState<MensagemMesa[]>([]);
  const [testes, setTestes] = useState<TesteMesa[]>([]);
  const [turnos, setTurnos] = useState<TurnosState>({ ordem: [], atual: -1, ativo: false });
  const [timer, setTimer] = useState<TimerView | null>(sessao.timerState ?? null);
  const [duracaoTimerMinutos, setDuracaoTimerMinutos] = useState("5");
  const [online, setOnline] = useState<string[]>([]);
  const [membros, setMembros] = useState<Membro[]>([]);
  const [personagens, setPersonagens] = useState<PersonagemResumo[]>([]);
  const [papel, setPapel] = useState<string>(souMestre ? "mestre" : "jogador");
  // papel ATUAL vem do ACK de mesa:entrar — a prop inicial só serve
  // para o primeiro render; após cada entrada/reentrada o servidor é
  // a fonte de verdade para todos os controles administrativos.
  const ehMestreAtual = papel === "mestre";
  const [entradaFalhou, setEntradaFalhou] = useState(false);
  const [podeEnviar, setPodeEnviar] = useState(true);
  // geração de permissões: incrementa a cada mesa:permissao:atualizada —
  // respostas assíncronas de sincronização emitidas antes da mudança mais
  // recente são descartadas (não restauram papel/permissões obsoletos)
  const [permSeq, setPermSeq] = useState(0);
  const permSeqRef = useRef(0);
  // papel efetivo conhecido pelo cliente — atualizado SINCRONAMENTE no
  // handler do evento privado (antes de qualquer render) para que a
  // comparação de privilégio nunca use um valor defasado de efeito
  const papelRef = useRef(papel);
  useEffect(() => { papelRef.current = papel; }, [papel]);
  const nivelPapelFn = (p?: string | null) => (p === "mestre" ? 2 : p === "espectador" ? 0 : 1);
  // queda de privilégio pendente de sincronização autorizada: o
  // tabuleiro VTT NÃO pode renderizar a visão anterior enquanto a
  // resposta válida da geração atual não chegar — estado participa do
  // render (não depende de useEffect para ativar a proteção)
  const [visaoBloqueada, setVisaoBloqueada] = useState(false);
  // recarga filtrada por papel: descarta resposta de geração antiga —
  // dados privados recebidos enquanto o usuário era mestre não podem
  // ser repovoados por HTTP emitido antes da mudança de papel
  const recarregarFiltrado = useCallback(() => {
    const seq = permSeqRef.current;
    void Promise.all([
      api.listarMensagens(campaignId, sessao.id),
      api.listarTestes(campaignId, sessao.id),
      api.obterEstadoMesa(campaignId, sessao.id),
    ]).then(([msgs, tes, est]) => {
      if (seq !== permSeqRef.current) return;
      setMensagens(msgs.mensagens);
      setTestes(tes.testes);
      setTurnos(est.turnos);
      setTimer(est.sessao.timerState ?? null);
      setSessaoAtual(est.sessao);
    }).catch(() => undefined);
  }, [campaignId, sessao.id]);
  const revogadoRef = useRef(false);
  const [meuUserId, setMeuUserId] = useState<string>("");
  // meuUserId também em ref: callbacks de socket não podem usar um
  // closure com o valor antigo após troca de conta/papel
  const meuUserIdRef = useRef("");
  useEffect(() => { meuUserIdRef.current = meuUserId; }, [meuUserId]);
  // espelhos em ref do estado carregado pela API confiável — os handlers
  // de socket são registrados uma vez e não podem capturar `personagens`/
  // `testes` obsoletos do closure; ehEu vem do servidor (listarPersonagens)
  const personagensRef = useRef<PersonagemResumo[]>([]);
  const testesRef = useRef<TesteMesa[]>([]);
  useEffect(() => { personagensRef.current = personagens; }, [personagens]);
  useEffect(() => { testesRef.current = testes; }, [testes]);
  // personagens acompanham o papel efetivo: mestre/jogador recebem a
  // lista autorizada pelo servidor; espectador não consulta o endpoint
  // (a requisição seria recusada) — a lista é esvaziada. A geração
  // permSeqRef descarta respostas emitidas antes da mudança de papel
  // mais recente: um GET iniciado como mestre não pode repovoar a
  // lista depois de um rebaixamento.
  const recarregarPersonagens = useCallback(() => {
    const seq = permSeqRef.current;
    const limpar = () => { personagensRef.current = []; setPersonagens([]); };
    if (papelRef.current === "espectador") { limpar(); return; }
    void api.listarPersonagens(campaignId).then((pers) => {
      if (seq !== permSeqRef.current) return;
      personagensRef.current = pers.personagens;
      setPersonagens(pers.personagens);
    }).catch(() => {
      if (seq !== permSeqRef.current) return;
      limpar(); // erro: não conservar lista privilegiada obsoleta
    });
  }, [campaignId]);
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

  // carga completa (mensagens, testes, turnos, timer, sessão, membros,
  // personagens, regras): geração própria via permSeqRef — respostas de
  // gerações antigas são descartadas. Usada na carga inicial, na
  // reconexão e após campanha:restaurada com ID preservado.
  const recarregarCompleta = useCallback(() => {
    const seq = permSeqRef.current;
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
        if (seq !== permSeqRef.current) return; // gerada antes de mudança de papel
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

  // carga inicial
  useEffect(() => { recarregarCompleta(); }, [recarregarCompleta]);

  // restauração com ID preservado: a MesaView continua montada, mas
  // TODO o estado em memória é substituído pelo autoritativo — limpa
  // antes de recarregar para que dados do papel/estado anterior não
  // permaneçam visíveis; rolagens são efêmeras (sem endpoint HTTP)
  // e são descartadas
  useEffect(() => {
    if (restKey > 0) {
      setMensagens([]); setTestes([]); setRolagens([]); setTurnos({ ordem: [], atual: -1, ativo: false });
      recarregarCompleta();
    }
  }, [restKey, recarregarCompleta]);

  // papel devolvido pela sincronização ordenada do VTT: autoritativo,
  // mas só se emitido depois da permissão mais recente recebida —
  // permissões individuais só mudam via evento privado ou ACK de entrada
  // (o sync não transporta permissões)
  const aoPapelServidorEstavel = useCallback((p: string | undefined, seq: number) => {
    if (seq !== permSeqRef.current) return;
    // ACK válido da geração atual: visão autorizada aplicada pelo
    // filho — libera o bloqueio de queda de privilégio e rebusca o
    // histórico já filtrado pelo papel confirmado
    setVisaoBloqueada(false);
    recarregarFiltrado();
    if (!p) return;
    const papelAntes = papelRef.current;
    papelRef.current = p;
    setPapel(p);
    if (p !== papelAntes) recarregarPersonagens();
  }, [recarregarFiltrado, recarregarPersonagens]);

  // socket
  useEffect(() => {
    const socket = getSocket();
    socket.emit("entrar-campanha", campaignId, () => undefined);

    // Filtro de autorização no cliente (defesa em profundidade — o
    // servidor também filtra na emissão e no histórico): um evento
    // privado produzido antes de uma mudança de papel pode chegar
    // atrasado; a regra é a MESMA de mensagemVisivel/visibilidade do
    // backend, avaliada contra o papel ATUAL (papelRef, síncrono).
    const papelAtual = () => papelRef.current;
    const souMestreAtual = () => papelAtual() === "mestre";
    // `privado` contraditório prevalece: qualquer valor "truthy" que não
    // seja explicitamente false marca o conteúdo como privado — um
    // pacote visibility:"publica" + privado:true NUNCA vira público
    const flagPrivado = (v: unknown) => v != null && v !== false;
    const autorizaMensagem = (m: { visibility?: string; authorId?: string | null; recipients?: unknown; privado?: unknown }) => {
      const vis = m.visibility;
      // rótulos privados explícitos: mestre/secreta só para mestre atual
      if (vis === "mestre" || vis === "secreta") return souMestreAtual();
      if (vis === "privada") {
        if (souMestreAtual()) return true;
        const rec = Array.isArray(m.recipients) ? m.recipients : [];
        return m.authorId === meuUserIdRef.current || rec.includes(meuUserIdRef.current);
      }
      // publica/sistema sem flag privada → público; COM flag contraditória
      // o conteúdo é tratado como privado → só o mestre atual o vê
      if (vis === "publica" || vis === "sistema") return flagPrivado(m.privado) ? souMestreAtual() : true;
      // ausência/tipo inválido/rótulo desconhecido: fail-closed
      return souMestreAtual();
    };
    // propriedade atual do personagem segundo o estado carregado pela
    // API (ehEu é computado no servidor) — usada para autorizar conteúdo
    // privado do DONO do personagem, nunca por campos do próprio pacote
    const souDonoPersonagemRef = (characterId?: string | null) =>
      !!characterId && personagensRef.current.some((p) => p.id === characterId && p.ehEu);
    // teste conhecido pelo estado local: amarra o evento ao registro
    // já validado (characterId do pacote precisa bater com o do teste)
    const testeConhecidoRef = (testId?: string | null) =>
      !!testId ? testesRef.current.find((x) => x.id === testId) ?? null : null;
    // classificação fail-closed alinhada ao servidor: somente "publica"
    // é pública e somente "privada" chega ao dono — "mestre"/"secreta"/
    // "sistema"/ausente/inválido são exclusivos de mestres atuais.
    // `privado` contraditório nunca promove nada a público.
    const classeEventoTeste = (vis: unknown, flagPriv: unknown): "publica" | "privada" | "mestre" => {
      // a classificação RESERVADA prevalece sobre qualquer flag
      // contraditória: privado:true nunca rebaixa mestre/secreta/
      // desconhecida para um conteúdo que o dono possa ver
      if (vis === "mestre" || vis === "secreta") return "mestre";
      if (vis !== "publica" && vis !== "privada") return "mestre"; // ausente/nula/vazia/inválida
      if (vis === "privada") return "privada";
      return flagPrivado(flagPriv) ? "privada" : "publica";
    };
    const aoMensagem = (m: MensagemMesa & { autorNome?: string; visibility?: string; authorId?: string | null; recipients?: unknown }) => {
      if (!autorizaMensagem(m)) return; // descarta antes de entrar no estado
      setMensagens((prev) => prev.some((x) => x.id === m.id) ? prev : [...prev.slice(-400), m]);
    };
    const aoTeste = (t: TesteMesa & { alvo?: number | null; dados?: { lados: number; count: number }; pool?: { positivos: number; negativos: number; dadosLados: number }; privado?: boolean; visibility?: string }) => {
      // teste: só "publica" é pública e só "privada" chega ao dono;
      // mestre/secreta/desconhecida são exclusivas de mestres atuais —
      // `privado:true` contraditório é tratado como privado
      const classe = classeEventoTeste((t as { visibility?: string }).visibility, (t as { privado?: unknown }).privado);
      if (classe === "mestre" && !souMestreAtual()) return;
      if (classe === "privada" && !souMestreAtual() && !souDonoPersonagemRef(t.characterId)) return;
      setTestes((prev) => prev.some((x) => x.id === t.id) ? prev : [t as TesteMesa, ...prev]);
      if (t.alvo !== undefined && t.alvo !== null) {
        setRolagens((r) => [...r, { id: `aviso-${t.id}`, dados: [], lados: [t.dados?.lados ?? 20], total: null, motivo: (t as { rotulo?: string }).rotulo ?? "Teste solicitado", autor: t.requestedBy, ts: Date.now() }]);
      }
    };
    const aoRolagem = (r: { id: string; testId?: string; characterId?: string | null; dados?: number[]; grupos?: { lados: number; resultados: number[] }[]; total: number; lados?: number; count?: number; rolador?: string; motivo?: string | null; visibility?: string; privado?: unknown; userId?: string; alvo?: number | null; createdAt?: string; vitalidade?: { nivel: number; nome: string; penalidadeDados: number; dadosOriginais: number; dadosFinais: number; excecaoMestre?: boolean } | null; dadosOriginais?: number; d10?: { positivos: number; negativos: number; minimo: number; lancados: number; sucessos: number; falhas: number } | null }) => {
      // rolagem: mesma classificação fail-closed — mestre/secreta/
      // desconhecida só para mestre atual; privada segue a regra de
      // dono/teste conhecido/rolador livre
      const classeR = classeEventoTeste(r.visibility, r.privado);
      if (classeR === "mestre" && !souMestreAtual()) return;
      if (classeR === "privada" && !souMestreAtual()) {
        const tst = testeConhecidoRef(r.testId);
        // rolagem de teste que o cliente não conhece (estado da API/
        // eventos legítimos) é forjada ou fora de contexto — rejeita;
        // nunca cai no characterId livre do pacote
        if (r.testId && !tst) return;
        if (tst && r.characterId && tst.characterId !== r.characterId) return; // pacote inconsistente
        const donoOk = souDonoPersonagemRef(tst?.characterId ?? r.characterId);
        // rolagem DE TESTE: só mestre ou dono do personagem — userId
        // adulterado não autoriza. Rolagem LIVRE privada: o próprio
        // rolador também é destinatário legítimo (contrato do servidor)
        if (!donoOk && (r.testId || r.userId !== meuUserIdRef.current)) return;
      }
      if (r.testId) setTestes((prev) => prev.map((t) => t.id === r.testId ? { ...t, status: "rolado" } : t));
      const grupos = r.grupos ?? (r.dados ? [{ lados: r.lados ?? 20, resultados: r.dados }] : []);
      setRolagens((prev) => prev.some((x) => x.id === r.id) ? prev : [...prev, {
        id: r.id, dados: grupos.map((g) => g.resultados), lados: grupos.map((g) => g.lados),
        total: r.total, motivo: r.motivo ?? null, autor: r.rolador, ts: Date.now(),
        vitalidade: r.vitalidade ?? null, dadosOriginais: r.dadosOriginais, d10: r.d10 ?? null,
      }]);
    };
    const aoDecisao = (d: { testId: string; characterId?: string | null; outcome: string; nota?: string | null; characterName?: string; visibility?: string; privado?: unknown }) => {
      // decisão: mesma classificação fail-closed — mestre/secreta/
      // desconhecida só para mestre atual; privada exige teste conhecido
      // e dono atual do personagem (ehEu do estado da API)
      const classeD = classeEventoTeste(d.visibility, d.privado);
      if (classeD === "mestre" && !souMestreAtual()) return;
      if (classeD === "privada" && !souMestreAtual()) {
        const tst = testeConhecidoRef(d.testId);
        // decisão privada de teste desconhecido → forjada/fora de
        // contexto — rejeita (nunca usa characterId livre do pacote)
        if (d.testId && !tst) return;
        if (tst && d.characterId && tst.characterId !== d.characterId) return;
        if (!souDonoPersonagemRef(tst?.characterId ?? d.characterId)) return;
      }
      setTestes((prev) => prev.map((t) => t.id === d.testId ? { ...t, status: "decidido", outcome: d.outcome, outcomeNote: d.nota ?? null } : t));
    };
    const aoTurnos = (t: { turnos: TurnosState }) => setTurnos(t.turnos);
    const aoTimer = (t: TimerView & { sessionId?: string }) => {
      if (t.sessionId === sessao.id || !t.sessionId) setTimer(t);
    };
    const aoPresenca = (p: { sessionId: string; online: string[] }) => {
      if (p.sessionId === sessao.id) setOnline(p.online);
    };
    const aoSessao = () => {
      const seq = permSeqRef.current;
      void api.obterEstadoMesa(campaignId, sessao.id).then((e) => {
        if (seq !== permSeqRef.current) return; // resposta de geração antiga
        setSessaoAtual(e.sessao); setTurnos(e.turnos);
      }).catch(() => undefined);
    };
    // Notificação privada pós-persistência do servidor: papel/status/
    // permissões ATUAIS da minha membership nesta campanha. Só o canal
    // usuario:* a entrega — nunca é payload de campanha inteira.
    const aoPermissao = (d: { campaignId?: string; papel?: string; status?: string; permissoes?: { enviarMensagens?: boolean } }) => {
      if (d?.campaignId !== campaignId) return;
      permSeqRef.current += 1;
      setPermSeq(permSeqRef.current);
      if (d.status && d.status !== "ativo") {
        // revogação: o servidor já removeu este socket das salas da
        // sessão — invalidar a visão inteira até uma NOVA entrada
        // autorizada (nunca restaurar pelo ACK antigo)
        revogadoRef.current = true;
        setEntradaFalhou(true);
        setVisaoBloqueada(true);
        setPapel("espectador");
        papelRef.current = "espectador";
        // revogação invalida TODO o histórico carregado — inclusive o
        // que foi recebido enquanto o usuário tinha privilégios maiores
        setMensagens([]);
        setTestes([]);
        setRolagens([]);
        personagensRef.current = [];
        setPersonagens([]);
        setErro("Seu acesso a esta campanha foi revogado — entre novamente para solicitar acesso.");
        return;
      }
      if (revogadoRef.current) {
        // reativação: só um caminho de autorização novo restaura o acesso
        revogadoRef.current = false;
        setEntradaFalhou(false);
        entrar();
      }
      if (d.papel) {
        // compara o privilégio ANTES de aplicar: queda exige proteção
        // visual imediata (mesmo render) + invalidação do histórico
        // que pode conter dados do papel anterior (mensagens privadas/
        // secretas, testes e rolagens já carregados em memória)
        const papelAntes = papelRef.current;
        const nivelAntes = nivelPapelFn(papelAntes);
        const nivelDepois = nivelPapelFn(d.papel);
        if (nivelDepois < nivelAntes) {
          setVisaoBloqueada(true);
          setMensagens([]);
          setTestes([]);
          setRolagens([]);
          // redução de privilégio: a lista de personagens é limpa no
          // mesmo render — uma resposta HTTP emitida como papel anterior
          // não pode repovoá-la (guarda de geração em recarregarPersonagens)
          personagensRef.current = [];
          setPersonagens([]);
          recarregarFiltrado();
        } else {
          setVisaoBloqueada(false);
        }
        papelRef.current = d.papel;
        setPapel(d.papel);
        if (d.papel !== papelAntes) recarregarPersonagens();
      }
      // mesma regra do servidor (mesa:mensagem): espectador só envia se
      // tiver enviarMensagens explícito
      setPodeEnviar((d.papel ?? "jogador") !== "espectador" || d.permissoes?.enviarMensagens === true);
    };
    socket.on("mesa:mensagem", aoMensagem);
    socket.on("mesa:teste", aoTeste);
    socket.on("mesa:rolagem", aoRolagem);
    socket.on("mesa:decisao", aoDecisao);
    socket.on("mesa:turnos", aoTurnos);
    socket.on("mesa:timer", aoTimer);
    socket.on("mesa:presenca", aoPresenca);
    socket.on("sessao:atualizada", aoSessao);
    socket.on("mesa:permissao:atualizada", aoPermissao);

    // mesa:entrar também na reconexão do socket: sem isso o novo socket
    // nunca volta à sala sessao:* e a mesa (vtt, chat, timer) fica muda
    // até recarregar a página. O servidor revalida tudo e devolve o
    // vttState filtrado — a visão é reconstruída do zero. A intenção de
    // permanecer na sessão NÃO depende de ACK anterior: se o socket
    // cair depois de o servidor processar a entrada mas antes do ACK,
    // a reconexão precisa solicitar nova entrada mesmo assim. O listener
    // é registrado antes da primeira solicitação; socket já conectado
    // entra uma única vez, desconectado aguarda o connect.
    let ativo = true;
    let entradaPendente = false;
    let tentativaEntrada = 0;
    const entrar = () => {
      // nunca envia entrada com socket desconectado (o emit seria
      // enfileirado); uma única entrada ativa por conexão
      if (!ativo || entradaPendente || !socket.connected) return;
      // reconexão = novo socket.id no servidor: as rooms campanha:*/
      // sessao:* são por conexão e precisam ser refeitas — sem isso a
      // mesa fica surda a eventos de campanha (restauração, presença)
      socket.emit("entrar-campanha", campaignId, () => undefined);
      const tentativa = ++tentativaEntrada;
      entradaPendente = true;
      socket.emit("mesa:entrar", { sessionId: sessao.id }, (r: { ok?: boolean; papel?: string; podeEnviar?: boolean; turnos?: TurnosState; presenca?: string[]; sessao?: Sessao; erro?: string }) => {
        // ACK de tentativa antiga (conexão anterior) não libera a
        // trava nem atualiza estado de uma tentativa mais recente
        if (!ativo || tentativa !== tentativaEntrada) return;
        entradaPendente = false;
        if (r?.ok) {
          setEntradaFalhou(false);
          if (r.papel) { papelRef.current = r.papel; setPapel(r.papel); }
          if (typeof r.podeEnviar === "boolean") setPodeEnviar(r.podeEnviar);
          if (r.turnos) setTurnos(r.turnos);
          if (r.presenca) setOnline(r.presenca);
          if (r.sessao) setSessaoAtual(r.sessao); // inclui vttState fresco (mapa/tokens/névoa)
          // reconexão pode ter perdido campanha:restaurada: a entrada
          // autorizada devolve o estado atual — recarga COMPLETA
          // (mensagens/testes/membros/personagens/regras/timer/sessão)
          // descartando gerações HTTP antigas via permSeqRef
          recarregarCompleta();
        } else {
          // sessão substituída por restauração/importação: o ID não
          // existe mais — desmonta a view e volta à lista real em vez
          // de manter mapa/tokens/mensagens de uma sessão morta
          if (typeof r?.erro === "string" && /não encontrada/i.test(r.erro)) { aoSair(); return; }
          // rejeição de autorização: invalida a visão — o servidor
          // não juntou o socket à sala, então nenhum evento novo
          // chegará; controles e painel saem de cena até nova entrada
          setEntradaFalhou(true);
          setPapel("espectador");
          setErro("Não foi possível entrar na mesa — acesso não autorizado");
        }
      });
    };
    const aoConnect = () => entrar();
    // disconnect invalida a tentativa em curso: o próximo connect
    // dispara nova entrada mesmo que o ACK anterior nunca tenha chegado
    const aoDisconnect = () => { entradaPendente = false; };
    socket.on("connect", aoConnect);
    socket.on("disconnect", aoDisconnect);
    if (socket.connected) entrar();

    return () => {
      ativo = false;
      socket.emit("mesa:sair", { sessionId: sessao.id });
      socket.off("mesa:mensagem", aoMensagem);
      socket.off("mesa:teste", aoTeste);
      socket.off("mesa:rolagem", aoRolagem);
      socket.off("mesa:decisao", aoDecisao);
      socket.off("mesa:turnos", aoTurnos);
      socket.off("mesa:timer", aoTimer);
      socket.off("mesa:presenca", aoPresenca);
      socket.off("sessao:atualizada", aoSessao);
      socket.off("mesa:permissao:atualizada", aoPermissao);
      socket.off("connect", aoConnect);
      socket.off("disconnect", aoDisconnect);
      socket.emit("sair-campanha", campaignId);
    };
  }, [campaignId, sessao.id, recarregarFiltrado, recarregarCompleta, recarregarPersonagens, restKey]);

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
  const minutosTimer = duracaoTimerMinutos.trim() === "" ? NaN : Number(duracaoTimerMinutos);
  const duracaoTimerValida = Number.isInteger(minutosTimer) && minutosTimer >= 1 && minutosTimer <= 1440;
  const duracaoTimerSegundos = duracaoTimerValida ? minutosTimer * 60 : null;
  const acaoTimer = timer?.status === "rodando" ? "pausar" : timer?.status === "pausado" ? "retomar" : "iniciar";

  const testesPendentes = testes.filter((t) => t.status === "pendente");
  const testesRecentes = testes.filter((t) => t.status !== "pendente").slice(0, 10);

  const nomeMembro = (membershipId: string) => {
    const m = membros.find((x) => x.membershipId === membershipId);
    return m ? (m.displayName || m.username) : "?";
  };
  const turnoAtualNome = turnos.ativo && turnos.atual >= 0 ? nomeMembro(turnos.ordem[turnos.atual]) : null;

  // entrada rejeitada: não apresenta a visão antiga como atual —
  // sem chat, mapa, tokens nem controles até uma nova entrada autorizada
  if (entradaFalhou) {
    return (
      <div className="mesa-view">
        <section className="cartao">
          <div className="linha-entre">
            <h2>Mesa — {sessaoAtual.name}</h2>
            <button className="secundario" onClick={aoSair}>Sair da mesa</button>
          </div>
          {erro && <p className="erro">{erro}</p>}
        </section>
      </div>
    );
  }

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
            {ehMestreAtual && sessaoAtual.status !== "encerrada" && (
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
                {m.visibility === "mestre" && ehMestreAtual && <span className="tag">secreta</span>}
                <div className="chat-conteudo">{m.content}</div>
              </div>
            ))}
            {mensagens.length === 0 && <p className="meta">Sem mensagens ainda.</p>}
          </div>
          {sessaoAtual.status !== "encerrada" && (papel !== "espectador" || podeEnviar) && (
            <form className="chat-form" onSubmit={enviar}>
              <div className="linha">
                <label className="check"><input type="checkbox" checked={comoAcao} onChange={(e) => setComoAcao(e.target.checked)} /> Ação</label>
                {ehMestreAtual && <>
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
            {ehMestreAtual && (
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
              {timer?.status === "rodando" || timer?.status === "pausado" ? fmtTempo(restantes)
                : timer?.status === "parado" && (timer?.totalMs ?? 0) > 0 ? "Tempo encerrado" : "—"}
              {timer?.status === "pausado" && <span className="meta"> (pausado)</span>}
            </p>
            {ehMestreAtual && sessaoAtual.status !== "encerrada" && (
              <>
                <div className="linha-ferramentas">
                  <label>
                    Duração (minutos)
                    <input type="number" min="1" max="1440" step="1" value={duracaoTimerMinutos} onChange={(e) => setDuracaoTimerMinutos(e.target.value)} aria-label="Duração do temporizador em minutos" />
                  </label>
                  <span className="meta">De 1 minuto a 24 horas</span>
                </div>
                {!duracaoTimerValida && (
                  <p className="erro">Duração inválida — informe um número inteiro de minutos entre 1 e 1440.</p>
                )}
                <div className="linha linha-botoes">
                  <button className="secundario" disabled={acaoTimer === "iniciar" && !duracaoTimerValida}
                    onClick={() => socketEmit("mesa:timer", { acao: acaoTimer, duracaoSegundos: duracaoTimerSegundos ?? undefined })}>
                    {acaoTimer === "pausar" ? "Pausar" : acaoTimer === "retomar" ? "Retomar" : duracaoTimerValida ? "Iniciar (" + minutosTimer + " min)" : "Iniciar"}
                  </button>
                  <button className="secundario" disabled={!duracaoTimerValida}
                    onClick={() => socketEmit("mesa:timer", { acao: "reiniciar", duracaoSegundos: duracaoTimerSegundos ?? undefined })}>Reiniciar com duração escolhida</button>
                  <button className="secundario" onClick={() => socketEmit("mesa:timer", { acao: "encerrar" })}>Encerrar</button>
                </div>
              </>
            )}
          </section>

          {/* testes pendentes */}
          {testesPendentes.length > 0 && (
            <section className="cartao">
              <h3>Testes pendentes</h3>
              {testesPendentes.map((t) => {
                const ehDono = souDonoTeste(t);
                const podeAgir = ehMestreAtual || ehDono;
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
                    {ehMestreAtual && <p className="meta">{t.diceCount}d{t.diceSides}{t.target != null ? ` · alvo ${t.target}` : ""}</p>}
                    {podeAgir && t.status === "pendente" && (
                      <div className="linha linha-botoes">
                        {(ehMestreAtual || ehDono) && (
                          <button onClick={() => getSocket().emit("mesa:teste:rolar", { testId: t.id, requestId: crypto.randomUUID() }, (r: { ok?: boolean; dados?: number[]; total?: number }) => {
                            if (r?.dados) setRolagens((prev) => [...prev, { id: `t-${t.id}`, dados: [r.dados!], lados: [t.diceSides], total: r.total ?? null, motivo: "Teste", ts: Date.now() }]);
                          })}>Rolar</button>
                        )}
                        {ehMestreAtual && (
                          <select id={`out-${t.id}`} defaultValue="">
                            <option value="" disabled>Decidir…</option>
                            <option value="sucesso">Sucesso</option>
                            <option value="parcial">Parcial</option>
                            <option value="falha">Falha</option>
                            <option value="falha_critica">Falha crítica</option>
                          </select>
                        )}
                        {ehMestreAtual && (
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
          {ehMestreAtual && (
            <SolicitarTeste sessionId={sessao.id} personagens={personagens} aoErro={setErro} />
          )}

          {/* desafio D10 (mestre) */}
          {ehMestreAtual && (
            <DesafioD10 sessionId={sessao.id} personagens={personagens} aoErro={setErro} />
          )}

          {/* lançador unificado: testes D10 | rolagem livre e dano */}
          {papel !== "espectador" && sessaoAtual.status !== "encerrada" && (
            <PainelDados sessionId={sessao.id} aoErro={setErro} minimoPadrao={minimoD10} souMestre={ehMestreAtual} />
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
        souMestre={ehMestreAtual}
        ehEspectador={papel === "espectador"}
        meuUserId={meuUserId}
        membros={membros}
        encerrada={sessaoAtual.status === "encerrada"}
        inicial={sessaoAtual.vttState ?? sessao.vttState ?? null}
        atualizacaoPapel={permSeq}
        geracaoRef={permSeqRef}
        visaoBloqueada={visaoBloqueada}
        aoPapelServidor={aoPapelServidorEstavel}
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

function TabuleiroVtt({ campaignId, sessionId, souMestre, ehEspectador, meuUserId, membros, encerrada, inicial, atualizacaoPapel, geracaoRef, visaoBloqueada, aoPapelServidor }: {
  campaignId: string; sessionId: string; souMestre: boolean; ehEspectador: boolean; meuUserId: string;
  membros: Membro[]; encerrada: boolean; inicial: VttState | string | null;
  atualizacaoPapel: number;
  // geração autoritativa de permissões: referência do PAI, incrementada
  // sincronicamente no handler de mesa:permissao:atualizada — o filho
  // consulta .current no instante da resposta, sem depender de efeito
  geracaoRef: { current: number };
  // queda de privilégio sinalizada pelo pai já no processamento do
  // evento — participa do render, não espera useEffect
  visaoBloqueada: boolean;
  aoPapelServidor: (p: string | undefined, seq: number) => void;
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
        // broadcast genérico ATUALIZA a visão, mas NÃO libera o estado
        // incerto: pode ser mutação de outra operação, não a pendente
        sincronizarAutoritativo(d.vtt);
        setVtt(d.vtt);
      }
    };
    socket.on("mesa:vtt", aoVtt);
    return () => { socket.off("mesa:vtt", aoVtt); };
  }, [sessionId]);

  // sincroniza com o estado persistido quando a sessão é recarregada
  // (ex.: entrada tardia na sala — eventos emitidos antes do join se perdem)
  const inicialConteudoRef = useRef<string | null>(null);
  useEffect(() => {
    const ini = vttInicialParse(inicial);
    // recargas que devolvem o MESMO vttState (nova referência de objeto,
    // conteúdo idêntico) não podem derrubar o rascunho do pincel —
    // só uma mudança real de estado reinicia a visão
    const chave = JSON.stringify(ini);
    if (inicialConteudoRef.current === chave) return;
    inicialConteudoRef.current = chave;
    sincronizarAutoritativo(ini);
    setVtt(ini);
    setPincel(false); setPreviewNevoa(null); // sessão/troca de estado: limpa rascunho
    nivelAutorizadoRef.current = nivelAtual; // snapshot de entrada é autorizado
    marcarVisaoPapel(false);
    // snapshot de entrada também NÃO libera o estado incerto — só a
    // sincronização ordenada (mesa:vtt:nevoa:sincronizar) confirma
    // que toda operação já entregue terminou
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inicial]);

  // ---------- névoa de guerra ----------
  const nevoaCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pincel, setPincel] = useState(false);          // modo desenho (só mestre)
  const [raioNevoa, setRaioNevoa] = useState(0.08);    // raio normalizado 0–1
  const [pendenteNevoa, setPendenteNevoa] = useState(false);
  const [previewNevoa, setPreviewNevoa] = useState<{ pontos: { x: number; y: number }[] } | null>(null);
  const desenhoRef = useRef<{ pontos: { x: number; y: number }[]; pointerId: number } | null>(null);
  const fimDesenhoRef = useRef<(() => void) | null>(null); // cancela gesto ativo + listeners
  const pendenteNevoaRef = useRef(false);                  // trava de operação única
  // estado incerto: a operação foi enviada mas o ACK não chegou no
  // timeout — o Socket.IO pode tê-la enfileirado e o servidor ainda
  // pode processá-la. NÃO é rejeição: mutações ficam bloqueadas até o
  // estado autoritativo do servidor reconciliar a visão local.
  const [nevoaIncerta, setNevoaIncerta] = useState(false);
  const nevoaIncertaRef = useRef(false);
  // geração de permissões: vem do PAI via geracaoRef (atualizada
  // sincronicamente no handler do evento privado). O prop
  // atualizacaoPapel apenas dispara o efeito de ressincronização.
  // nível de privilégio da visão ATUALMENTE exibida (2=mestre, 1=jogador,
  // 0=espectador): atualizado somente quando um estado autorizado é
  // aplicado (snapshot de entrada ou ACK válido da sincronização)
  const nivelAtual = souMestre ? 2 : ehEspectador ? 0 : 1;
  const nivelAutorizadoRef = useRef(nivelAtual);
  // visão segura durante rebaixamento: esconde mapa/tokens até a sync
  // válida trazer a visão filtrada — nunca exibe privilégio antigo
  const [visaoPapelPendente, setVisaoPapelPendente] = useState(false);
  const visaoPapelPendenteRef = useRef(false);
  const marcarVisaoPapel = (v: boolean) => { visaoPapelPendenteRef.current = v; setVisaoPapelPendente(v); };
  // espelho da proteção vinda do pai (queda de privilégio) para os
  // callbacks de reconexão consultarem sem depender de efeito
  const visaoBloqueadaRef = useRef(visaoBloqueada);
  visaoBloqueadaRef.current = visaoBloqueada;
  const nevoa = vtt.nevoa ?? { ativa: false, revelados: [] };
  const souMestreCena = souMestre && !encerrada && !!vtt.mapa;
  const [tamTab, setTamTab] = useState({ w: 0, h: 0 });

  // ResizeObserver: o canvas acompanha o tabuleiro (rotação, viewport,
  // redimensionamento) e o desenho é refeito sem distorcer os traços —
  // as coordenadas normalizadas 0–1 não mudam.
  useEffect(() => {
    const el = tabRef.current;
    if (!el) return;
    const medir = () => setTamTab({ w: el.clientWidth, h: el.clientHeight });
    medir();
    const ro = new ResizeObserver(medir);
    ro.observe(el);
    return () => ro.disconnect();
  }, [vtt.mapa?.fileId]);

  // redesenha a camada de névoa quando o estado autoritativo muda.
  // Ordem: limpeza → névoa autoritativa (só se ativa) → destaque do mestre
  // → prévia do pincel SEMPRE por último (independe de nevoa.ativa).
  useEffect(() => {
    const cv = nevoaCanvasRef.current;
    const el = tabRef.current;
    if (!cv || !el) return;
    const w = tamTab.w || el.clientWidth, h = tamTab.h || el.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (nevoa.ativa) {
      if (!souMestre) {
        // não-mestres: véu visualmente opaco com buracos revelados
        // (destination-out). Não é confidencialidade dos bytes da imagem.
        ctx.save();
        ctx.fillStyle = "#0a0d14";
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
    // prévia do traço em desenho (mestre) — visível mesmo com névoa
    // ainda desativada: o primeiro traço é o que a ativa no servidor
    if (pincel && previewNevoa && previewNevoa.pontos.length) {
      ctx.save();
      ctx.fillStyle = "rgba(255,209,102,0.35)";
      ctx.strokeStyle = "rgba(255,209,102,0.8)";
      ctx.lineWidth = 1.5;
      desenharTracoNevoa(ctx, w, h, { raioX: raioNevoa, raioY: raioNevoa, pontos: previewNevoa.pontos });
      ctx.restore();
    }
  }, [nevoa, previewNevoa, pincel, raioNevoa, souMestre, tamTab, vtt.mapa?.fileId]);

  // limpa estados temporários ao trocar de sessão — cancela desenho
  // incompleto e TODOS os listeners do gesto antes de zerar o estado
  useEffect(() => {
    fimDesenhoRef.current?.();
    setPincel(false); setPreviewNevoa(null); desenhoRef.current = null; setPendenteNevoa(false);
    nevoaIncertaRef.current = false; setNevoaIncerta(false); // estado incerto é por sessão
  }, [sessionId]);
  // idem ao desmontar o componente
  useEffect(() => () => { fimDesenhoRef.current?.(); }, []);

  // retorna null fora do retângulo do tabuleiro — nunca gruda o traço
  // nas bordas quando o ponteiro sai da área do mapa
  const pontoNormalizado = (ev: { clientX: number; clientY: number }) => {
    const el = tabRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const x = (ev.clientX - r.left) / r.width;
    const y = (ev.clientY - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  };

  // Sincronização ORDENADA (barreira): mesa:vtt:nevoa:sincronizar entra
  // na mesma fila VTT do servidor que as mutações — como o transporte
  // preserva a ordem por conexão, a resposta só é produzida depois que
  // toda operação de névoa já entregue tiver terminado, e devolve o
  // estado filtrado autoritativo pós-operações. SOMENTE este ACK limpa
  // nevoaIncerta; broadcasts genéricos e snapshots de entrada não.
  const [syncPendente, setSyncPendente] = useState(false);
  const syncPendenteRef = useRef(false);
  // identificador sequencial por requisição: timeout/ACK de uma sync
  // antiga NUNCA controlam trava, erro ou pendência de uma sync mais
  // recente — cada requisição só pode ser encerrada por ela mesma
  const syncReqRef = useRef(0);
  const sincronizarNevoa = () => {
    const sock = getSocket();
    if (!sock.connected) {
      // não enfileira pedido antigo: a reconexão dispara nova tentativa
      setErroVtt("Sem conexão — sincronização não enviada; será tentada ao reconectar");
      return;
    }
    if (syncPendenteRef.current) return;
    syncPendenteRef.current = true;
    setSyncPendente(true);
    setErroVtt("Sincronização da névoa em andamento — aguardando estado autoritativo…");
    let respondido = false;
    const reqId = ++syncReqRef.current;
    const seqPerm = geracaoRef.current; // geração de permissões no envio
    const timeout = window.setTimeout(() => {
      // timeout de requisição antiga não controla trava/erro de uma
      // sincronização mais recente
      if (respondido || reqId !== syncReqRef.current) return;
      respondido = true;
      syncPendenteRef.current = false;
      setSyncPendente(false);
      // nunca libera por decurso de tempo: estado incerto permanece.
      // Se a geração de permissões avançou enquanto esta sync estava
      // pendente, a resposta futura (se chegar) será obsoleta — dispara
      // já a sincronização da geração vigente.
      setErroVtt("Sincronização sem resposta — ações continuam bloqueadas; tente 'Sincronizar névoa' novamente");
      if (seqPerm !== geracaoRef.current) sincronizarNevoa();
    }, 8000);
    sock.volatile.emit("mesa:vtt:nevoa:sincronizar", { sessionId }, (r: { ok?: boolean; erro?: string; papel?: string; vtt?: VttState }) => {
      if (respondido || reqId !== syncReqRef.current) return; // tardia ou de requisição superada
      respondido = true;
      window.clearTimeout(timeout);
      syncPendenteRef.current = false;
      setSyncPendente(false);
      // VALIDADE ANTES DE QUALQUER EFEITO: se uma permissão mais nova
      // chegou depois deste envio, a resposta inteira é obsoleta —
      // não aplica VTT, não sincroniza referência, não muda papel,
      // não libera nevoaIncerta, não limpa erro. O estado pendente já
      // foi liberado acima para a geração vigente poder sincronizar.
      if (seqPerm !== geracaoRef.current) {
        sincronizarNevoa(); // dispara sync da geração atual
        return;
      }
      if (r?.ok && r.vtt) {
        sincronizarAutoritativo(r.vtt);
        setVtt(r.vtt);
        nivelAutorizadoRef.current = nivelAtual; // visão agora autorizada p/ papel atual
        marcarVisaoPapel(false);
        // papel autoritativo do servidor — o pai descarta se uma
        // permissão mais nova chegou depois deste envio
        aoPapelServidor(r.papel, seqPerm);
        nevoaIncertaRef.current = false;
        setNevoaIncerta(false);
        setErroVtt(null);
      } else {
        setErroVtt(r?.erro ?? "Sincronização falhou — ações continuam bloqueadas; tente novamente");
      }
    });
  };
  // estado incerto + reconexão: tenta a sincronização ordenada no connect
  useEffect(() => {
    const socket = getSocket();
    const aoConnectSync = () => {
      // reconexão: retoma sincronização pendente — seja por estado
      // incerto de névoa ou por visão aguardando papel autorizado
      if ((nevoaIncertaRef.current || visaoPapelPendenteRef.current || visaoBloqueadaRef.current) && !syncPendenteRef.current) sincronizarNevoa();
    };
    socket.on("connect", aoConnectSync);
    return () => { socket.off("connect", aoConnectSync); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // mudança de papel/status/permissão recebida pelo canal privado:
  // rebusca a visão autorizada via sincronização ordenada — cobre
  // promoção a mestre (visão completa), rebaixamento (visão filtrada) e
  // transição a espectador. Não libera nevoaIncerta por caminho paralelo:
  // o ACK do sync continua sendo a única barreira.
  const primeiroPerm = useRef(true);
  useEffect(() => {
    if (primeiroPerm.current) { primeiroPerm.current = false; return; }
    // rebaixamento de privilégio: a visão exibida pode conter dados do
    // papel anterior — esconde mapa/tokens até a sync autorizada chegar.
    // promoção/subida mantém a visão anterior (já menos privilegiada).
    if (nivelAtual < nivelAutorizadoRef.current) marcarVisaoPapel(true);
    if (!encerrada) sincronizarNevoa();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atualizacaoPapel]);

  // perda de papel de mestre com gesto de desenho ativo: cancela o
  // traço imediatamente — controles admin somem e o traço não pode
  // continuar sendo coletado para um papel sem autorização
  useEffect(() => {
    if (!souMestre) {
      fimDesenhoRef.current?.();
      setPincel(false); setPreviewNevoa(null); desenhoRef.current = null;
    }
  }, [souMestre]);

  const emitirNevoa = (acao: string, traco?: { raioX: number; raioY: number; pontos: { x: number; y: number }[] }) => {
    if (nevoaIncertaRef.current) {
      setErroVtt("Resultado de uma ação anterior é desconhecido — sincronize antes de nova ação");
      return;
    }
    const sock = getSocket();
    if (!sock.connected) {
      // Socket.IO enfileiraria o emit para depois — não enviar: o
      // usuário precisa saber que a ação NÃO foi disparada
      setErroVtt("Sem conexão com o servidor — ação de névoa não enviada");
      return;
    }
    if (pendenteNevoaRef.current) return; // uma operação por vez
    pendenteNevoaRef.current = true;
    setPendenteNevoa(true);
    setErroVtt(null);
    let respondido = false;
    const timeout = window.setTimeout(() => {
      if (respondido) return;
      respondido = true;
      pendenteNevoaRef.current = false;
      setPendenteNevoa(false);
      setPreviewNevoa(null);
      // ACK expirado ≠ rejeição: o emit pode ter sido entregue e o
      // servidor ainda pode aplicá-lo — ou pode nunca ter chegado.
      // Bloqueia novas mutações até a SINCRONIZAÇÃO ORDENADA confirmar
      // o estado; nunca reenvia a operação.
      nevoaIncertaRef.current = true;
      setNevoaIncerta(true);
      setErroVtt("Sem confirmação do servidor — resultado desconhecido; sincronizando…");
      sincronizarNevoa();
    }, 5000);
    // volatile: se a conexão cair durante o envio, a mutação NÃO fica
    // na fila de saída para execução tardia — ou foi entregue (e a
    // sincronização ordenada resolve) ou nunca existirá no servidor
    sock.volatile.emit("mesa:vtt:nevoa", { sessionId, acao, traco }, (r: { ok?: boolean; erro?: string }) => {
      if (respondido) return; // ACK tardio após o timeout: ignorar
      respondido = true;
      window.clearTimeout(timeout);
      pendenteNevoaRef.current = false;
      setPendenteNevoa(false);
      if (r && r.ok === false) {
        setErroVtt(r.erro ?? "Ação de névoa recusada");
        setPreviewNevoa(null); // rejeição: limpa prévia, nada é confirmado localmente
      }
      // sucesso: o broadcast mesa:vtt traz o estado autoritativo
    });
  };

  // Gesto único de desenho: pointerId fixo, cleanup único que remove
  // TODOS os listeners registrados. pointerup finaliza e emite uma
  // única operação; pointercancel/lostpointercapture/blur/aba oculta
  // descartam o rascunho sem emitir nada. Um segundo ponteiro não
  // interfere: eventos de outro pointerId são ignorados e um novo
  // pointerdown é bloqueado enquanto há desenho ativo.
  const iniciarPincel = (e: ReactPointerEvent) => {
    if (!pincel || !souMestreCena || pendenteNevoaRef.current || nevoaIncertaRef.current || desenhoRef.current) return;
    const p = pontoNormalizado(e);
    if (!p) return;
    e.preventDefault();
    const pid = e.pointerId;
    try { (e.currentTarget as HTMLElement).setPointerCapture?.(pid); } catch { /* ok */ }
    desenhoRef.current = { pontos: [p], pointerId: pid };
    setPreviewNevoa({ pontos: [p] });

    const mover = (ev: PointerEvent) => {
      const d = desenhoRef.current;
      if (!d || d.pointerId !== ev.pointerId) return;
      const q = pontoNormalizado(ev);
      if (!q) return; // fora do tabuleiro: não acrescenta ponto de borda
      const ultimo = d.pontos[d.pontos.length - 1];
      // dedup por distância mínima para não inflar o traço
      if (Math.hypot(q.x - ultimo.x, q.y - ultimo.y) < 0.004) return;
      d.pontos.push(q);
      setPreviewNevoa({ pontos: [...d.pontos] });
    };
    function soltar(ev: PointerEvent) {
      const d = desenhoRef.current;
      if (!d || d.pointerId !== ev.pointerId) return;
      limpar();
      setPreviewNevoa(null);
      if (!d.pontos.length) return;
      const q = pontoNormalizado(ev); // pode ser null se soltou fora
      if (q) {
        const ultimo = d.pontos[d.pontos.length - 1];
        if (Math.hypot(q.x - ultimo.x, q.y - ultimo.y) >= 0.004) d.pontos.push(q);
      }
      const pontos = amostrarPontos(d.pontos);
      emitirNevoa("revelar", { raioX: raioNevoa, raioY: raioNevoa, pontos });
    }
    // cancelar(ev) com evento: só o ponteiro ativo cancela — um
    // pointercancel de ponteiro secundário é ignorado, como já ocorre
    // em pointermove/pointerup/lostpointercapture. Sem evento (blur,
    // aba oculta, troca de sessão, desmontar) cancela incondicionalmente.
    function cancelar(ev?: PointerEvent) {
      const d = desenhoRef.current;
      if (!d) return;
      if (ev && d.pointerId !== ev.pointerId) return;
      limpar();
      setPreviewNevoa(null);
    }
    function aoPerderCaptura(ev: PointerEvent) {
      const d = desenhoRef.current;
      if (d && d.pointerId === ev.pointerId) cancelar(ev);
    }
    function aoVisibilidade() { if (document.hidden) cancelar(); }
    function aoBlur() { cancelar(); }
    function limpar() {
      window.removeEventListener("pointermove", mover);
      window.removeEventListener("pointerup", soltar);
      window.removeEventListener("pointercancel", cancelar);
      window.removeEventListener("lostpointercapture", aoPerderCaptura);
      window.removeEventListener("blur", aoBlur);
      document.removeEventListener("visibilitychange", aoVisibilidade);
      desenhoRef.current = null;
      if (fimDesenhoRef.current === cancelar) fimDesenhoRef.current = null;
    }
    window.addEventListener("pointermove", mover);
    window.addEventListener("pointerup", soltar);
    window.addEventListener("pointercancel", cancelar);
    window.addEventListener("lostpointercapture", aoPerderCaptura);
    window.addEventListener("blur", aoBlur);
    document.addEventListener("visibilitychange", aoVisibilidade);
    fimDesenhoRef.current = cancelar;
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
      {visaoBloqueada || visaoPapelPendente ? (
        <p className="dica">Permissões atualizadas — aguardando a visão autorizada do servidor…</p>
      ) : !vtt.mapa ? (
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
            disabled={pendenteNevoa || nevoaIncerta}
            onClick={() => { fimDesenhoRef.current?.(); setPincel((p) => !p); }}
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
          <button className="secundario" disabled={pendenteNevoa || nevoaIncerta || nevoa.revelados.length === 0}
            onClick={() => emitirNevoa("desfazer")}>Desfazer traço</button>
          <button className="secundario" disabled={pendenteNevoa || nevoaIncerta}
            onClick={() => emitirNevoa("ocultarTudo")}>Ocultar tudo</button>
          <button className="secundario" disabled={pendenteNevoa || nevoaIncerta}
            onClick={() => emitirNevoa("revelarTudo")}>Revelar tudo</button>
          {nevoaIncerta && (
            <button className="primario" disabled={syncPendente} onClick={sincronizarNevoa}>
              {syncPendente ? "Sincronizando…" : "Sincronizar névoa"}
            </button>
          )}
          <span className="meta">
            Névoa: {nevoa.ativa ? `ativa (${nevoa.revelados.length} traço${nevoa.revelados.length === 1 ? "" : "s"})` : "desativada"}
          </span>
        </div>
      )}
    </section>
  );
}
