import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type CampanhaResumo, type ElementoVinculavel, type ModeloResumo, type PersonagemDetalhe, type PersonagemResumo } from "../api";
import { getSocket } from "../socket";
import FichaForm, { useFichaValores } from "../FichaForm";
import Vida from "../Vida";
import Patrimonio from "./Patrimonio";

const STATUS_LABEL: Record<string, string> = {
  rascunho: "Rascunho",
  aguardando_aprovacao: "Aguardando aprovação",
  devolvida: "Devolvida",
  reaberta: "Reaberta",
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
  const [biblioteca, setBiblioteca] = useState<Record<string, ElementoVinculavel[]> | null>(null);
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
        campaignId={campaignId}
        aoVoltar={async () => {
          setSelecionado(null);
          await carregar();
        }}
        aoSalvar={async (nome, data, status) => {
          const atualizado = await api.atualizarPersonagem(selecionado.personagem.id, { name: nome, data, status });
          setSelecionado(atualizado);
          await carregar();
        }}
        aoRecarregar={async () => {
          setSelecionado(await api.obterPersonagem(selecionado.personagem.id));
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
            souMestre={souMestre === true}
            aoCriar={async (nome, templateVersionId, isNpc) => {
              const criado = await api.criarPersonagem(campaignId, { name: nome, templateVersionId, isNpc });
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
                  <td>{p.name}{p.isNpc && <span className="badge badge-npc"> NPC</span>}</td>
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

function NovoPersonagem({ modelos, souMestre, aoCriar, aoCancelar }: {
  modelos: ModeloResumo[];
  souMestre: boolean;
  aoCriar: (nome: string, templateVersionId?: string, isNpc?: boolean) => Promise<void>;
  aoCancelar: () => void;
}) {
  const [nome, setNome] = useState("");
  const [modeloId, setModeloId] = useState("");
  const [isNpc, setIsNpc] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const submeter = async (e: FormEvent) => {
    e.preventDefault();
    setEnviando(true);
    setErro(null);
    try {
      const modelo = modelos.find((m) => m.id === modeloId);
      await aoCriar(nome, modelo?.versaoAtual?.id, isNpc || undefined);
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
      {souMestre && (
        <label className="check">
          <input type="checkbox" checked={isNpc} onChange={(e) => setIsNpc(e.target.checked)} />
          NPC — personagem do mestre (inimigo, aliado ou figurante; nasce aprovado)
        </label>
      )}
      {erro && <p className="erro">{erro}</p>}
      <div className="linha">
        <button type="submit" disabled={enviando}>{enviando ? "Criando…" : "Criar e preencher"}</button>
        <button type="button" className="secundario" onClick={aoCancelar}>Cancelar</button>
      </div>
      <p className="meta">{isNpc ? "O NPC nasce aprovado, com pontos selados — só você poderá editá-lo." : "O personagem será criado como rascunho — você pode salvar e continuar depois."}</p>
    </form>
  );
}

function PersonagemDetalheView({ detalhe, souMestre, biblioteca, campaignId, aoVoltar, aoSalvar, aoRecarregar }: {
  detalhe: PersonagemDetalhe;
  souMestre: boolean;
  biblioteca: Record<string, ElementoVinculavel[]> | null;
  campaignId: string;
  aoVoltar: () => Promise<void>;
  aoSalvar: (nome: string, data: Record<string, unknown>, status?: string) => Promise<void>;
  aoRecarregar: () => Promise<void>;
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

  // Ficha aprovada fica trancada para o jogador até o mestre reabrir;
  // bloqueada idem. O mestre sempre edita.
  const podeEditar = souMestre || (personagem.status !== "bloqueada" && personagem.status !== "aprovada");
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
            <h2>{personagem.name}{personagem.isNpc && <span className="badge badge-npc"> NPC</span>}</h2>
            <p className="meta ficha-dono">
              Jogador: <strong>{personagem.isNpc ? "Mestre (NPC)" : (personagem.donoNome ?? "—")}</strong>
              {" · "}
              <span className={`badge badge-${personagem.status}`}>{STATUS_LABEL[personagem.status] ?? personagem.status}</span>
              {ficha?.pontosBonus?.selado && <span className="badge badge-selo" title="Os pontos desta ficha estão selados — só o mestre pode alterá-los"> pontos selados</span>}
            </p>
          </div>
          <button className="secundario" onClick={() => void aoVoltar()}>Voltar</button>
        </div>
        {souMestre && editando && (
          <label>Nome do personagem<input value={nome} onChange={(e) => setNome(e.target.value)} /></label>
        )}
        {!editando && souMestre && <p className="meta">Nome do personagem: {personagem.name}</p>}
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
              {personagem.status === "aprovada" && <button className="secundario" onClick={() => void salvar("reaberta")}>Reabrir</button>}
              {personagem.status !== "devolvida" && personagem.status !== "aprovada" && <button className="secundario" onClick={() => void salvar("devolvida")}>Devolver</button>}
              {personagem.status !== "bloqueada" ? (
                <button className="perigo" onClick={() => void salvar("bloqueada")}>Bloquear</button>
              ) : (
                <button className="secundario" onClick={() => void salvar("rascunho")}>Desbloquear</button>
              )}
            </>
          )}
        </div>
      </section>

      <section className="cartao ficha-cartao">
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
        {souMestre && ficha && (
          <PainelPontosMestre ficha={ficha} characterId={personagem.id} aoMudar={aoRecarregar} />
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
        {ficha?.vida && (
          <Vida vidaInicial={ficha.vida} characterId={personagem.id} aoErro={setErro} />
        )}
        {estrutura && !estruturaVazia && (
          <FichaForm
            estrutura={estrutura}
            valores={valores}
            calculados={ficha?.calculados}
            somenteLeitura={!editando}
            aoMudar={editando ? aoMudar : undefined}
            biblioteca={biblioteca ?? undefined}
            personagemId={personagem.id}
            pontosInicial={ficha?.pontos}
            poderesCfg={ficha?.poderes ?? null}
            carteiras={ficha?.carteiras}
            ehMestre={souMestre}
          />
        )}
      </section>

      <Patrimonio characterId={personagem.id} campaignId={campaignId} souMestre={souMestre} />
    </>
  );
}

/** Painel do mestre: concede/remove o bônus individual de pontos
 *  (__pontos) com motivo — funciona mesmo com a ficha selada. */
function PainelPontosMestre({ ficha, characterId, aoMudar }: {
  ficha: NonNullable<PersonagemDetalhe["ficha"]>;
  characterId: string;
  aoMudar: () => Promise<void>;
}) {
  const pb = ficha.pontosBonus;
  const [acao, setAcao] = useState<"conceder" | "remover">("conceder");
  const [quantidade, setQuantidade] = useState("1");
  const [motivo, setMotivo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    const q = Number(quantidade);
    if (!Number.isInteger(q) || q < 1) { setErro("Quantidade deve ser um inteiro positivo"); return; }
    if (!motivo.trim()) { setErro("Informe o motivo"); return; }
    setEnviando(true);
    setErro(null);
    setMsg(null);
    try {
      await api.adminPontos(characterId, { acao, quantidade: q, motivo: motivo.trim() });
      setMsg(acao === "conceder" ? `+${q} pontos concedidos.` : `−${q} pontos removidos.`);
      setMotivo("");
      await aoMudar();
    } catch (err2) {
      setErro(err2 instanceof Error ? err2.message : "Erro ao alterar pontos");
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="painel-pontos">
      <p className="meta">
        Bônus do mestre: <strong>{pb?.bonus ?? 0}</strong> pts
        {pb?.selado && " · pontos selados (jogador não altera)"}
      </p>
      {pb?.historico && pb.historico.length > 0 && (
        <ul className="historico-pontos">
          {pb.historico.slice(-5).reverse().map((h, i) => (
            <li key={i} className="meta">
              {h.quantidade > 0 ? "+" : ""}{h.quantidade} — {h.motivo} ({h.autorNome ?? "?"}, {new Date(h.em).toLocaleDateString("pt-BR")})
            </li>
          ))}
        </ul>
      )}
      <form className="linha" onSubmit={enviar}>
        <select aria-label="Ação de pontos" value={acao} onChange={(e) => setAcao(e.target.value as "conceder" | "remover")}>
          <option value="conceder">Conceder</option>
          <option value="remover">Remover</option>
        </select>
        <input type="number" aria-label="Quantidade de pontos" min={1} value={quantidade} onChange={(e) => setQuantidade(e.target.value)} style={{ width: "5rem" }} required />
        <input type="text" placeholder="Motivo" value={motivo} onChange={(e) => setMotivo(e.target.value)} required style={{ flex: 1 }} />
        <button type="submit" disabled={enviando}>{enviando ? "…" : "Aplicar"}</button>
      </form>
      {erro && <p className="erro">{erro}</p>}
      {msg && <p className="online">{msg}</p>}
    </div>
  );
}
