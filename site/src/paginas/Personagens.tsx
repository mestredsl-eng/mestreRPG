import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type CampanhaResumo, type ModeloResumo, type PersonagemDetalhe, type PersonagemResumo } from "../api";
import { getSocket } from "../socket";
import FichaForm, { useFichaValores } from "../FichaForm";

const STATUS_LABEL: Record<string, string> = {
  rascunho: "Rascunho",
  aguardando_aprovacao: "Aguardando aprovação",
  devolvida: "Devolvida",
  aprovada: "Aprovada",
  bloqueada: "Bloqueada",
};

interface Props {
  campaignId: string;
  campanha: CampanhaResumo | null;
}

export default function Personagens({ campaignId, campanha }: Props) {
  const [personagens, setPersonagens] = useState<PersonagemResumo[]>([]);
  const [modelos, setModelos] = useState<ModeloResumo[]>([]);
  const [selecionado, setSelecionado] = useState<PersonagemDetalhe | null>(null);
  const [criando, setCriando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [biblioteca, setBiblioteca] = useState<Record<string, { key: string; name: string; category: string | null }[]> | null>(null);
  const souMestre = campanha?.meuPapel === "mestre";

  const carregar = useCallback(async () => {
    try {
      const [{ personagens }, { modelos }] = await Promise.all([
        api.listarPersonagens(campaignId),
        api.listarModelos(campaignId),
      ]);
      setPersonagens(personagens);
      setModelos(modelos);
      setErro(null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar");
    }
    // Biblioteca de regras (Etapa 5) — opcional, alimenta campos vinculados
    try {
      const { elementos } = await api.obterVinculaveis(campaignId);
      setBiblioteca(elementos);
    } catch {
      setBiblioteca(null);
    }
  }, [campaignId]);

  useEffect(() => {
    void carregar();
    const socket = getSocket();
    socket.emit("entrar-campanha", campaignId, () => undefined);
    const aoMudar = () => void carregar();
    socket.on("personagens:atualizados", aoMudar);
    socket.on("fichas:atualizadas", aoMudar);
    return () => {
      socket.off("personagens:atualizados", aoMudar);
      socket.off("fichas:atualizadas", aoMudar);
      socket.emit("sair-campanha", campaignId);
    };
  }, [carregar, campaignId]);

  const abrir = async (id: string) => {
    try {
      setSelecionado(await api.obterPersonagem(id));
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao abrir personagem");
    }
  };

  const modelosPublicados = modelos.filter((m) => m.isActive && m.versaoAtual?.publishedAt);

  if (selecionado) {
    return (
      <PersonagemDetalheView
        detalhe={selecionado}
        souMestre={souMestre}
        biblioteca={biblioteca}
        aoVoltar={async () => {
          setSelecionado(null);
          await carregar();
        }}
        aoSalvar={async (nome, data, status) => {
          const atualizado = await api.atualizarPersonagem(selecionado.personagem.id, { name: nome, data, status });
          setSelecionado(atualizado);
          await carregar();
        }}
      />
    );
  }

  return (
    <>
      <section className="cartao">
        <div className="linha-entre">
          <h2>Personagens</h2>
          <button onClick={() => setCriando((v) => !v)} disabled={modelosPublicados.length === 0}>
            {criando ? "Cancelar" : "Novo personagem"}
          </button>
        </div>
        {erro && <p className="erro">{erro}</p>}
        {modelosPublicados.length === 0 && (
          <p className="meta">Nenhum modelo de ficha publicado. O mestre precisa criar e publicar uma ficha primeiro.</p>
        )}
        {criando && modelosPublicados.length > 0 && (
          <NovoPersonagem
            modelos={modelosPublicados}
            aoCriar={async (nome, templateVersionId) => {
              const criado = await api.criarPersonagem(campaignId, { name: nome, templateVersionId });
              setCriando(false);
              setSelecionado(criado);
            }}
            aoCancelar={() => setCriando(false)}
          />
        )}
      </section>

      {personagens.length === 0 ? (
        <section className="cartao"><p>Nenhum personagem ainda.</p></section>
      ) : (
        <section className="cartao">
          <table className="tabela">
            <thead>
              <tr><th>Nome</th><th>Dono</th><th>Status</th><th>Atualizado</th></tr>
            </thead>
            <tbody>
              {personagens.map((p) => (
                <tr key={p.id} className="clicavel" onClick={() => void abrir(p.id)}>
                  <td>{p.name}</td>
                  <td>{p.displayName ?? p.dono}</td>
                  <td><span className={`badge badge-${p.status}`}>{STATUS_LABEL[p.status] ?? p.status}</span></td>
                  <td>{new Date(p.updatedAt).toLocaleString("pt-BR")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

function NovoPersonagem({ modelos, aoCriar, aoCancelar }: {
  modelos: ModeloResumo[];
  aoCriar: (nome: string, templateVersionId?: string) => Promise<void>;
  aoCancelar: () => void;
}) {
  const [nome, setNome] = useState("");
  const [modeloId, setModeloId] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const submeter = async (e: FormEvent) => {
    e.preventDefault();
    setEnviando(true);
    setErro(null);
    try {
      const modelo = modelos.find((m) => m.id === modeloId);
      await aoCriar(nome, modelo?.versaoAtual?.id);
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao criar");
    } finally {
      setEnviando(false);
    }
  };

  return (
    <form className="formulario" onSubmit={submeter}>
      <div className="grade-2">
        <label>Nome do personagem<input value={nome} onChange={(e) => setNome(e.target.value)} required /></label>
        <label>Modelo de ficha
          <select value={modeloId} onChange={(e) => setModeloId(e.target.value)} required>
            <option value="">Escolher…</option>
            {modelos.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
      </div>
      {erro && <p className="erro">{erro}</p>}
      <div className="linha">
        <button type="submit" disabled={enviando}>{enviando ? "Criando…" : "Criar e preencher"}</button>
        <button type="button" className="secundario" onClick={aoCancelar}>Cancelar</button>
      </div>
      <p className="meta">O personagem será criado como rascunho — você pode salvar e continuar depois.</p>
    </form>
  );
}

function PersonagemDetalheView({ detalhe, souMestre, biblioteca, aoVoltar, aoSalvar }: {
  detalhe: PersonagemDetalhe;
  souMestre: boolean;
  biblioteca: Record<string, { key: string; name: string; category: string | null }[]> | null;
  aoVoltar: () => Promise<void>;
  aoSalvar: (nome: string, data: Record<string, unknown>, status?: string) => Promise<void>;
}) {
  const { personagem, ficha } = detalhe;
  const estrutura = ficha?.estrutura ?? null;
  const inicial = ficha?.campos ?? {};
  const { valores, setValores, aoMudar } = useFichaValores(inicial as Record<string, unknown>);
  const [nome, setNome] = useState(personagem.name);
  const [editando, setEditando] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const podeEditar = souMestre || personagem.status !== "bloqueada";
  const estruturaVazia = !estrutura || estrutura.secoes.length === 0;

  const salvar = async (status?: string) => {
    setSalvando(true);
    setErro(null);
    setMsg(null);
    try {
      await aoSalvar(nome, valores, status);
      setMsg(status === "aguardando_aprovacao" ? "Ficha enviada para aprovação." : "Ficha salva.");
      setEditando(false);
    } catch (e) {
      const det = e instanceof ApiError ? e.detalhes : undefined;
      if (det && typeof det === "object") {
        const d = det as { erros?: { mensagem: string }[]; pontos?: string[] };
        const msgs = d.erros?.map((x) => x.mensagem) ?? d.pontos ?? [];
        if (msgs.length) {
          setErro(`${e instanceof Error ? e.message : "Erro"}: ${msgs.join("; ")}`);
        } else {
          setErro(e instanceof Error ? e.message : "Erro ao salvar");
        }
      } else {
        setErro(e instanceof Error ? e.message : "Erro ao salvar");
      }
    } finally {
      setSalvando(false);
    }
  };

  return (
    <>
      <section className="cartao">
        <div className="linha-entre">
          <div>
            <h2>{personagem.name}</h2>
            <p className="meta">
              <span className={`badge badge-${personagem.status}`}>{STATUS_LABEL[personagem.status] ?? personagem.status}</span>
            </p>
          </div>
          <button className="secundario" onClick={() => void aoVoltar()}>Voltar</button>
        </div>
        {souMestre && editando && (
          <label>Nome do personagem<input value={nome} onChange={(e) => setNome(e.target.value)} /></label>
        )}
        {!editando && souMestre && <p className="meta">Nome: {personagem.name}</p>}
        {erro && <p className="erro">{erro}</p>}
        {msg && <p className="online">{msg}</p>}
        <div className="linha">
          {!editando && podeEditar && <button onClick={() => setEditando(true)}>Editar ficha</button>}
          {editando && (
            <>
              <button onClick={() => void salvar()} disabled={salvando}>{salvando ? "Salvando…" : "Salvar"}</button>
              {!souMestre && <button className="secundario" onClick={() => void salvar("aguardando_aprovacao")} disabled={salvando}>Enviar para aprovação</button>}
              <button className="secundario" onClick={() => { setEditando(false); setValores(inicial as Record<string, unknown>); setNome(personagem.name); }}>Cancelar</button>
            </>
          )}
          {souMestre && !editando && (
            <>
              {personagem.status !== "aprovada" && <button onClick={() => void salvar("aprovada")}>Aprovar</button>}
              {personagem.status !== "devolvida" && <button className="secundario" onClick={() => void salvar("devolvida")}>Devolver</button>}
              {personagem.status !== "bloqueada" ? (
                <button className="perigo" onClick={() => void salvar("bloqueada")}>Bloquear</button>
              ) : (
                <button className="secundario" onClick={() => void salvar("rascunho")}>Desbloquear</button>
              )}
            </>
          )}
        </div>
      </section>

      <section className="cartao">
        <h3>Ficha</h3>
        {ficha?.pontos?.habilitado && (
          <div className="pontos-resumo">
            {ficha.pontos.pools.map((pool) => (
              <span key={pool.id} className={`badge ${pool.saldo < 0 ? "badge-negativo" : ""}`}>
                {pool.nome}: {pool.saldo}/{pool.disponiveis} pts
                {pool.recebidos ? ` (+${pool.recebidos} transf.)` : ""}
                {pool.cedidos ? ` (-${pool.cedidos} transf.)` : ""}
              </span>
            ))}
            {ficha.pontos.transferencias?.map((t, i) => (
              <span key={i} className="tag">{t.de} → {t.para}: {t.pontos} pts</span>
            ))}
          </div>
        )}
        {ficha?.validacao && !ficha.validacao.ok && ficha.validacao.erros.length > 0 && (
          <div className="caixa-validacao erro">
            <p><strong>Pendências das regras da campanha:</strong></p>
            <ul>
              {ficha.validacao.erros.map((e, i) => <li key={i}>{e.mensagem}</li>)}
            </ul>
          </div>
        )}
        {estruturaVazia && <p className="meta">Esta ficha ainda não possui campos configurados.</p>}
        {estrutura && !estruturaVazia && (
          <FichaForm
            estrutura={estrutura}
            valores={valores}
            calculados={ficha?.calculados}
            somenteLeitura={!editando}
            aoMudar={editando ? aoMudar : undefined}
            biblioteca={biblioteca ?? undefined}
          />
        )}
      </section>
    </>
  );
}
