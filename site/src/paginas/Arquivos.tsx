import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type ArquivoBiblioteca, type CampanhaResumo, type PastaBiblioteca } from "../api";
import { ModalConfirmar } from "../Modal";
import { useSincronizacaoCampanha } from "../useSincronizacao";

const CATEGORIAS = ["mapas", "npcs", "locais", "documentos", "imagens", "pistas", "regras", "referencias", "jogadores", "outros"];
const VIS_OPCOES = [
  { v: "mestre", l: "Somente mestre" },
  { v: "publica", l: "Todos os participantes" },
  { v: "selecionada", l: "Selecionados" },
] as const;

function fmtTamanho(bytes: number | null) {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function ehImagem(mime?: string | null) { return !!mime && mime.startsWith("image/") && mime !== "image/svg+xml"; }
function ehAudio(mime?: string | null) { return !!mime && mime.startsWith("audio/"); }
function ehVideo(mime?: string | null) { return !!mime && mime.startsWith("video/"); }
function ehPdf(mime?: string | null) { return mime === "application/pdf"; }

export default function Arquivos({ campaignId, campanha }: { campaignId: string; campanha: CampanhaResumo }) {
  const souMestre = campanha.meuPapel === "mestre";
  const ehEspectador = campanha.meuPapel === "espectador";
  const [arquivos, setArquivos] = useState<ArquivoBiblioteca[]>([]);
  const [pastas, setPastas] = useState<PastaBiblioteca[]>([]);
  const [pastaAtual, setPastaAtual] = useState<string | null>(null); // null = raiz, "__todos" = todas
  const [busca, setBusca] = useState("");
  const [filtroCat, setFiltroCat] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [visualizando, setVisualizando] = useState<ArquivoBiblioteca | null>(null);
  const [editando, setEditando] = useState<ArquivoBiblioteca | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [jogadoresEnviam, setJogadoresEnviam] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const [novaPasta, setNovaPasta] = useState<{ nome: string; pai: string | null } | null>(null);
  const [renomeandoPasta, setRenomeandoPasta] = useState<PastaBiblioteca | null>(null);
  const [confirmando, setConfirmando] = useState<{ tipo: "pasta"; p: PastaBiblioteca } | { tipo: "arquivo"; a: ArquivoBiblioteca } | null>(null);
  const [ocupado, setOcupado] = useState(false);

  // Geração da carga: respostas antigas não sobrescrevem o estado atual.
  const geracao = useRef(0);
  const carregar = useCallback(async () => {
    const g = ++geracao.current;
    try {
      const [a, p] = await Promise.all([api.listarArquivos(campaignId), api.listarPastas(campaignId)]);
      if (g !== geracao.current) return;
      setArquivos(a.arquivos); setPastas(p.pastas);
      setJogadoresEnviam(a.config.jogadoresEnviam);
      setErro(null);
    } catch (e) { if (g === geracao.current) setErro(e instanceof Error ? e.message : "Erro ao carregar"); }
  }, [campaignId]);
  useEffect(() => { void carregar(); }, [carregar]);
  // Issue #67: upload/moderação/edição/exclusão de outro membro atualiza a lista.
  useSincronizacaoCampanha(["arquivos:atualizados"], () => void carregar());

  const caminhoPasta = useCallback((p: PastaBiblioteca): string => {
    const partes = [p.name];
    let atual = p;
    const vistos = new Set<string>([p.id]);
    while (atual.parentId) {
      const pai = pastas.find((x) => x.id === atual.parentId);
      if (!pai || vistos.has(pai.id)) break;
      vistos.add(pai.id); partes.unshift(pai.name); atual = pai;
    }
    return partes.join(" / ");
  }, [pastas]);

  const filtrados = useMemo(() => arquivos.filter((a) => {
    if (pastaAtual === "__todos") return true;
    if (pastaAtual && a.folderId !== pastaAtual) return false;
    if (!pastaAtual && a.folderId) return false;
    if (busca && !`${a.displayName} ${a.fileName} ${a.description ?? ""}`.toLowerCase().includes(busca.toLowerCase())) return false;
    if (filtroCat && a.category !== filtroCat) return false;
    return true;
  }), [arquivos, pastaAtual, busca, filtroCat]);

  const pendentes = arquivos.filter((a) => a.status === "pendente");

  const enviar = async (files: FileList | null) => {
    if (!files?.length) return;
    setEnviando(true); setErro(null);
    for (const f of Array.from(files)) {
      try {
        await api.enviarArquivo(campaignId, f, { folderId: pastaAtual && pastaAtual !== "__todos" ? pastaAtual : null });
      } catch (e) { setErro(e instanceof Error ? e.message : `Falha ao enviar ${f.name}`); }
    }
    setEnviando(false); inputRef.current && (inputRef.current.value = "");
    await carregar();
    setMsg("Envio concluído."); setTimeout(() => setMsg(null), 3000);
  };

  const salvarPasta = async () => {
    if (!novaPasta?.nome.trim()) return;
    try {
      await api.criarPasta(campaignId, { name: novaPasta.nome.trim(), parentId: novaPasta.pai });
      setNovaPasta(null); await carregar();
    } catch (e) { setErro(e instanceof Error ? e.message : "Erro ao criar pasta"); }
  };

  const salvarRenomear = async () => {
    if (!renomeandoPasta) return;
    try {
      await api.atualizarPasta(campaignId, renomeandoPasta.id, { name: renomeandoPasta.name });
      setRenomeandoPasta(null); await carregar();
    } catch (e) { setErro(e instanceof Error ? e.message : "Erro"); }
  };

  const excluirPasta = async () => {
    if (confirmando?.tipo !== "pasta" || ocupado) return;
    const p = confirmando.p;
    setOcupado(true);
    try { await api.excluirPasta(campaignId, p.id); if (pastaAtual === p.id) setPastaAtual(null); setConfirmando(null); await carregar(); }
    catch (e) { setErro(e instanceof Error ? e.message : "Erro ao excluir pasta"); }
    finally { setOcupado(false); }
  };

  const salvarEdicao = async () => {
    if (!editando) return;
    try {
      await api.atualizarArquivo(campaignId, editando.id, {
        displayName: editando.displayName, description: editando.description,
        category: editando.category, folderId: editando.folderId,
        visibility: souMestre ? editando.visibility : undefined,
      });
      setEditando(null); await carregar();
    } catch (e) { setErro(e instanceof Error ? e.message : "Erro ao salvar"); }
  };

  const moderar = async (a: ArquivoBiblioteca, acao: "aprovar" | "rejeitar") => {
    try { await api.moderarArquivo(campaignId, a.id, acao); await carregar(); }
    catch (e) { setErro(e instanceof Error ? e.message : "Erro"); }
  };

  const excluirArquivo = async () => {
    if (confirmando?.tipo !== "arquivo" || ocupado) return;
    const a = confirmando.a;
    setOcupado(true);
    try { await api.excluirArquivo(campaignId, a.id); if (visualizando?.id === a.id) setVisualizando(null); setConfirmando(null); await carregar(); }
    catch (e) { setErro(e instanceof Error ? e.message : "Erro ao excluir"); }
    finally { setOcupado(false); }
  };

  const url = (a: ArquivoBiblioteca, download = false) => api.urlArquivo(campaignId, a.id, download);
  const podeEnviar = souMestre || (!ehEspectador && jogadoresEnviam);

  return (
    <section className="cartao">
      <div className="linha">
        <h3 style={{ margin: 0 }}>Arquivos</h3>
        {podeEnviar && <button onClick={() => inputRef.current?.click()} disabled={enviando}>{enviando ? "Enviando…" : "Enviar arquivo"}</button>}
        <input ref={inputRef} type="file" multiple hidden onChange={(e) => void enviar(e.target.files)} />
      </div>
      {erro && <p className="erro">{erro}</p>}
      {msg && <p className="sucesso">{msg}</p>}
      {!souMestre && !ehEspectador && jogadoresEnviam && <p className="dica">Arquivos enviados ficam pendentes até aprovação do mestre.</p>}
      {ehEspectador && <p className="dica">Modo espectador: apenas visualização.</p>}

      {souMestre && pendentes.length > 0 && (
        <div className="cartao" style={{ borderColor: "#a80" }}>
          <h4>Envios pendentes ({pendentes.length})</h4>
          <ul className="lista-anotacoes">
            {pendentes.map((a) => (
              <li key={a.id}>
                <div className="linha">
                  <strong>{a.displayName}</strong>
                  <span className="dica">{a.uploader?.displayName ?? a.uploader?.username ?? "?"} · {fmtTamanho(a.sizeBytes)}</span>
                  <button onClick={() => moderar(a, "aprovar")}>Aprovar</button>
                  <button className="secundario" onClick={() => moderar(a, "rejeitar")}>Rejeitar</button>
                  <button className="secundario" onClick={() => setConfirmando({ tipo: "arquivo", a })}>Excluir</button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="biblioteca">
        <aside className="biblioteca-pastas">
          <button className={pastaAtual === null ? "ativo" : "secundario"} onClick={() => setPastaAtual(null)}>Raiz</button>
          <button className={pastaAtual === "__todos" ? "ativo" : "secundario"} onClick={() => setPastaAtual("__todos")}>Todos os arquivos</button>
          {pastas.map((p) => (
            <div key={p.id} className="linha">
              <button className={pastaAtual === p.id ? "ativo" : "secundario"} style={{ flex: 1, textAlign: "left" }} onClick={() => setPastaAtual(p.id)} title={caminhoPasta(p)}>
                📁 {p.name}
              </button>
              {souMestre && (
                <>
                  <button className="secundario" onClick={() => setRenomeandoPasta({ ...p })} title="Renomear">✎</button>
                  <button className="secundario" onClick={() => setConfirmando({ tipo: "pasta", p })} title="Excluir pasta vazia">✕</button>
                </>
              )}
            </div>
          ))}
          {souMestre && (
            <button className="secundario" onClick={() => setNovaPasta({ nome: "", pai: pastaAtual && pastaAtual !== "__todos" ? pastaAtual : null })}>+ Nova pasta</button>
          )}
        </aside>

        <div className="biblioteca-lista">
          <div className="linha">
            <input placeholder="Pesquisar…" value={busca} onChange={(e) => setBusca(e.target.value)} />
            <select aria-label="Filtrar por categoria" value={filtroCat} onChange={(e) => setFiltroCat(e.target.value)}>
              <option value="">Todas categorias</option>
              {CATEGORIAS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>

          {novaPasta && (
            <div className="formulario">
              <input placeholder="Nome da pasta" value={novaPasta.nome} onChange={(e) => setNovaPasta({ ...novaPasta, nome: e.target.value })} />
              <div className="linha">
                <button onClick={salvarPasta}>Criar</button>
                <button className="secundario" onClick={() => setNovaPasta(null)}>Cancelar</button>
              </div>
            </div>
          )}
          {renomeandoPasta && (
            <div className="formulario">
              <input value={renomeandoPasta.name} onChange={(e) => setRenomeandoPasta({ ...renomeandoPasta, name: e.target.value })} />
              <div className="linha">
                <button onClick={salvarRenomear}>Salvar</button>
                <button className="secundario" onClick={() => setRenomeandoPasta(null)}>Cancelar</button>
              </div>
            </div>
          )}

          <ul className="lista-anotacoes">
            {filtrados.map((a) => (
              <li key={a.id}>
                <div className="linha">
                  <strong>{a.displayName}</strong>
                  {a.status === "pendente" && <span className="selo">pendente</span>}
                  {a.status === "rejeitado" && <span className="selo">rejeitado</span>}
                  <span className="dica">{a.category ?? "—"} · {fmtTamanho(a.sizeBytes)} · {new Date(a.createdAt).toLocaleDateString("pt-BR")}</span>
                </div>
                {a.description && <p className="dica">{a.description}</p>}
                <div className="linha">
                  {(ehImagem(a.mimeType) || ehPdf(a.mimeType) || ehAudio(a.mimeType) || ehVideo(a.mimeType)) && (
                    <button className="secundario" onClick={() => setVisualizando(a)}>Visualizar</button>
                  )}
                  <a className="secundario" href={url(a, true)} download={a.displayName}>Download</a>
                  {(souMestre || a.ehMeu) && <button className="secundario" onClick={() => setEditando({ ...a })}>Editar</button>}
                  {(souMestre || a.ehMeu) && <button className="secundario" onClick={() => setConfirmando({ tipo: "arquivo", a })}>Excluir</button>}
                </div>
              </li>
            ))}
            {!filtrados.length && <li className="dica">Nenhum arquivo nesta visualização.</li>}
          </ul>
        </div>
      </div>

      {visualizando && (
        <div className="modal-fundo" onClick={() => setVisualizando(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="linha">
              <strong>{visualizando.displayName}</strong>
              <button className="secundario" onClick={() => setVisualizando(null)}>Fechar</button>
            </div>
            {ehImagem(visualizando.mimeType) && <img src={url(visualizando)} alt={visualizando.displayName} style={{ maxWidth: "100%" }} />}
            {ehPdf(visualizando.mimeType) && <iframe src={url(visualizando)} style={{ width: "100%", height: "70vh", border: 0 }} title={visualizando.displayName} />}
            {ehAudio(visualizando.mimeType) && <audio src={url(visualizando)} controls style={{ width: "100%" }} />}
            {ehVideo(visualizando.mimeType) && <video src={url(visualizando)} controls style={{ maxWidth: "100%" }} />}
            <p><a href={url(visualizando, true)} download={visualizando.displayName}>Baixar arquivo</a></p>
          </div>
        </div>
      )}

      {editando && (
        <div className="modal-fundo" onClick={() => setEditando(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h4>Editar arquivo</h4>
            <label>Nome de exibição<input value={editando.displayName} onChange={(e) => setEditando({ ...editando, displayName: e.target.value })} /></label>
            <label>Descrição<textarea rows={2} value={editando.description ?? ""} onChange={(e) => setEditando({ ...editando, description: e.target.value })} /></label>
            <label>Categoria
              <select value={editando.category ?? ""} onChange={(e) => setEditando({ ...editando, category: e.target.value || null })}>
                <option value="">—</option>
                {CATEGORIAS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label>Pasta
              <select value={editando.folderId ?? ""} onChange={(e) => setEditando({ ...editando, folderId: e.target.value || null })}>
                <option value="">Raiz</option>
                {pastas.map((p) => <option key={p.id} value={p.id}>{caminhoPasta(p)}</option>)}
              </select>
            </label>
            {souMestre && (
              <label>Visibilidade
                <select value={editando.visibility} onChange={(e) => setEditando({ ...editando, visibility: e.target.value as ArquivoBiblioteca["visibility"] })}>
                  {VIS_OPCOES.map((v) => <option key={v.v} value={v.v}>{v.l}</option>)}
                </select>
              </label>
            )}
            <div className="linha">
              <button onClick={salvarEdicao}>Salvar</button>
              <button className="secundario" onClick={() => setEditando(null)}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {confirmando?.tipo === "pasta" && (
        <ModalConfirmar
          titulo="Excluir pasta"
          mensagem={`Excluir a pasta \"${confirmando.p.name}\"? Ela precisa estar vazia.`}
          rotuloConfirmar="Excluir"
          perigo
          ocupado={ocupado}
          aoConfirmar={() => void excluirPasta()}
          aoCancelar={() => { if (!ocupado) setConfirmando(null); }}
        />
      )}
      {confirmando?.tipo === "arquivo" && (
        <ModalConfirmar
          titulo="Excluir arquivo"
          mensagem={`Excluir \"${confirmando.a.displayName}\"? O arquivo vai para a lixeira interna.`}
          rotuloConfirmar="Excluir"
          perigo
          ocupado={ocupado}
          aoConfirmar={() => void excluirArquivo()}
          aoCancelar={() => { if (!ocupado) setConfirmando(null); }}
        />
      )}
    </section>
  );
}
