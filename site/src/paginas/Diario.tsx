import { useCallback, useEffect, useState } from "react";
import { ModalConfirmar } from "../Modal";
import { api, type Anotacao, type ArquivoBiblioteca, type CampanhaResumo, type Membro, type PersonagemResumo } from "../api";

const CATEGORIAS = ["acontecimento", "pista", "npc", "local", "objetivo", "suspeita", "informacao", "lembrete", "livre", "segredo", "planejamento", "evento_futuro", "consequencia"];
const VISIBILIDADES = [
  { v: "privada", l: "Somente eu" },
  { v: "mestre", l: "Mestre" },
  { v: "publica", l: "Todos os participantes" },
  { v: "selecionada", l: "Jogadores selecionados" },
] as const;

export default function Diario({ campaignId, campanha }: { campaignId: string; campanha: CampanhaResumo }) {
  const souMestre = campanha.meuPapel === "mestre";
  const [aba, setAba] = useState<"diario" | "mestre">("diario");
  const [anotacoes, setAnotacoes] = useState<Anotacao[]>([]);
  const [personagens, setPersonagens] = useState<PersonagemResumo[]>([]);
  const [membros, setMembros] = useState<Membro[]>([]);
  const [arquivos, setArquivos] = useState<ArquivoBiblioteca[]>([]);
  const [anexando, setAnexando] = useState<string | null>(null);
  const [editando, setEditando] = useState<Anotacao | null>(null);
  const [novo, setNovo] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [busca, setBusca] = useState("");
  const [filtroVis, setFiltroVis] = useState("");
  const [filtroCat, setFiltroCat] = useState("");
  const [filtroImportantes, setFiltroImportantes] = useState(false);
  const [filtroData, setFiltroData] = useState("");
  const [form, setForm] = useState({ title: "", content: "", category: "livre", characterId: "", important: false, visibility: "privada" as Anotacao["visibility"], recipients: [] as string[] });

  const carregar = useCallback(async () => {
    try {
      const { anotacoes: lista } = await api.listarAnotacoes(campaignId, aba);
      setAnotacoes(lista);
      setErro(null);
    } catch (e) { setErro(e instanceof Error ? e.message : "Erro ao carregar"); }
  }, [campaignId, aba]);

  useEffect(() => { void carregar(); }, [carregar]);
  // Trocar de aba recarrega uma lista diferente — filtros da aba anterior
  // não se aplicam (categorias/visibilidade podem não existir nela) e
  // esconderiam anotações sem controle visível para removê-los.
  useEffect(() => {
    setBusca(""); setFiltroVis(""); setFiltroCat(""); setFiltroImportantes(false); setFiltroData("");
  }, [aba]);
  useEffect(() => {
    api.listarPersonagens(campaignId).then((r) => setPersonagens(r.personagens.filter((p) => p.ehEu || souMestre))).catch(() => {});
    api.listarMembros(campaignId).then((r) => setMembros(r.membros.filter((m) => m.status === "ativo" && m.userId !== undefined))).catch(() => {});
    api.listarArquivos(campaignId).then((r) => setArquivos(r.arquivos.filter((a) => a.status === "aprovado"))).catch(() => {});
  }, [campaignId, souMestre]);

  const abrirEdicao = (n: Anotacao | null) => {
    setEditando(n);
    setNovo(n === null);
    setForm(n
      ? { title: n.title, content: n.content, category: n.category ?? "livre", characterId: n.characterId ?? "", important: !!n.important, visibility: n.visibility, recipients: (n.recipients ?? []) as string[] }
      : { title: "", content: "", category: aba === "mestre" ? "planejamento" : "livre", characterId: "", important: false, visibility: "privada", recipients: [] });
  };

  const salvar = async () => {
    try {
      const dados = {
        title: form.title, content: form.content, category: form.category || undefined,
        characterId: form.characterId || undefined,
        kind: aba === "mestre" ? "mestre" as const : "diario" as const,
        important: form.important, visibility: form.visibility,
        recipients: form.visibility === "selecionada" ? form.recipients : undefined,
      };
      if (editando) await api.atualizarAnotacao(campaignId, editando.id, dados);
      else await api.criarAnotacao(campaignId, dados);
      setEditando(null); setNovo(false);
      await carregar();
    } catch (e) { setErro(e instanceof Error ? e.message : "Erro ao salvar"); }
  };

  const [confirmando, setConfirmando] = useState<Anotacao | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const remover = async () => {
    if (!confirmando || ocupado) return;
    setOcupado(true);
    try { await api.excluirAnotacao(campaignId, confirmando.id); setConfirmando(null); await carregar(); }
    catch (e) { setErro(e instanceof Error ? e.message : "Erro ao excluir"); }
    finally { setOcupado(false); }
  };

  const alternarImportante = async (n: Anotacao) => {
    try { await api.atualizarAnotacao(campaignId, n.id, { important: !n.important }); await carregar(); }
    catch (e) { setErro(e instanceof Error ? e.message : "Erro"); }
  };

  const anexar = async (noteId: string, fileId: string) => {
    if (!fileId) return;
    try { await api.anexarArquivoNota(campaignId, noteId, fileId); setAnexando(null); await carregar(); }
    catch (e) { setErro(e instanceof Error ? e.message : "Erro ao anexar"); }
  };
  const desanexar = async (n: Anotacao, fileId: string) => {
    try { await api.removerAnexoNota(campaignId, n.id, fileId); await carregar(); }
    catch (e) { setErro(e instanceof Error ? e.message : "Erro ao remover anexo"); }
  };

  const visLabel = (n: Anotacao) => VISIBILIDADES.find((v) => v.v === n.visibility)?.l ?? n.visibility;

  // Busca e filtros — aplicados SOMENTE sobre a lista que o backend já
  // autorizou retornar (nada de consulta extra nem vazamento de privadas).
  const q = busca.trim().toLowerCase();
  const dataMin = filtroData ? new Date(`${filtroData}T00:00:00`).getTime() : null;
  const visiveis = anotacoes.filter((n) =>
    (!filtroVis || n.visibility === filtroVis) &&
    (!filtroCat || (n.category ?? "") === filtroCat) &&
    (!filtroImportantes || !!n.important) &&
    (dataMin === null || new Date(n.createdAt).getTime() >= dataMin) &&
    (!q || n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q))
  );
  const temFiltro = !!(q || filtroVis || filtroCat || filtroImportantes || filtroData);
  const categoriasPresentes = [...new Set(anotacoes.map((n) => n.category).filter((c): c is string => !!c))].sort();

  return (
    <section className="cartao">
      <div className="abas">
        <button className={aba === "diario" ? "ativo" : "secundario"} onClick={() => setAba("diario")}>Diário</button>
        <button className={aba === "mestre" ? "ativo" : "secundario"} onClick={() => setAba("mestre")}>Anotações do mestre</button>
      </div>
      {erro && <p className="erro">{erro}</p>}

      {aba === "mestre" && !souMestre && (
        <p className="dica">Você vê apenas anotações do mestre compartilhadas com você.</p>
      )}

      {(novo || editando) && (
        <div className="formulario">
          <h3>{editando ? "Editar anotação" : aba === "mestre" ? "Nova anotação do mestre" : "Nova anotação"}</h3>
          <input placeholder="Título" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <textarea placeholder="Conteúdo" rows={6} value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} />
          <div className="linha">
            <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {CATEGORIAS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            {aba === "diario" && (
              <select value={form.characterId} onChange={(e) => setForm({ ...form, characterId: e.target.value })}>
                <option value="">Sem personagem vinculado</option>
                {personagens.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
            <select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value as Anotacao["visibility"] })}>
              {VISIBILIDADES.map((v) => <option key={v.v} value={v.v}>{v.l}</option>)}
            </select>
            <label><input type="checkbox" checked={form.important} onChange={(e) => setForm({ ...form, important: e.target.checked })} /> Importante</label>
          </div>
          {form.visibility === "selecionada" && (
            <div className="linha">
              {membros.map((m) => (
                <label key={m.membershipId}>
                  <input type="checkbox" checked={form.recipients.includes(m.userId)}
                    onChange={(e) => setForm({ ...form, recipients: e.target.checked ? [...form.recipients, m.userId] : form.recipients.filter((r) => r !== m.userId) })} />
                  {" "}{m.displayName ?? m.username}
                </label>
              ))}
            </div>
          )}
          <div className="linha">
            <button onClick={salvar} disabled={!form.title.trim()}>Salvar</button>
            <button className="secundario" onClick={() => { setEditando(null); setNovo(false); }}>Cancelar</button>
          </div>
        </div>
      )}

      {!novo && !editando && (
        <button className="secundario" onClick={() => abrirEdicao(null)}>
          {aba === "mestre" ? "Nova anotação do mestre" : "Nova anotação"}
        </button>
      )}

      {anotacoes.length > 0 && (
        <div className="linha filtros-lista">
          <input type="search" placeholder="Buscar em título ou conteúdo…" aria-label="Buscar anotação" value={busca} onChange={(e) => setBusca(e.target.value)} />
          <select aria-label="Filtrar por visibilidade" value={filtroVis} onChange={(e) => setFiltroVis(e.target.value)}>
            <option value="">Toda visibilidade</option>
            {VISIBILIDADES.map((v) => <option key={v.v} value={v.v}>{v.l}</option>)}
          </select>
          {categoriasPresentes.length > 0 && (
            <select aria-label="Filtrar por categoria" value={filtroCat} onChange={(e) => setFiltroCat(e.target.value)}>
              <option value="">Todas as categorias</option>
              {categoriasPresentes.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          <label className="filtro-check"><input type="checkbox" checked={filtroImportantes} onChange={(e) => setFiltroImportantes(e.target.checked)} /> Importantes</label>
          <input type="date" aria-label="Filtrar a partir de" value={filtroData} onChange={(e) => setFiltroData(e.target.value)} />
        </div>
      )}

      <ul className="lista-anotacoes">
        {visiveis.map((n) => (
          <li key={n.id} className={n.important ? "importante" : ""}>
            <div className="linha">
              <strong>{n.title}</strong>
              {n.important ? <span className="selo">★</span> : null}
              <span className="dica">{n.category} · {visLabel(n)}{n.owner && !n.ehMinha ? ` · ${n.owner.displayName ?? n.owner.username}` : ""}</span>
            </div>
            <p className="pre-wrap">{n.content}</p>
            {(n.anexos?.length ?? 0) > 0 && (
              <ul className="lista-anexos">
                {n.anexos!.map((a) => (
                  <li key={a.id} className="linha">
                    <a href={api.urlArquivo(campaignId, a.fileId)} target="_blank" rel="noreferrer">{a.displayName}</a>
                    {n.ehMinha && <button className="secundario" onClick={() => desanexar(n, a.fileId)}>✕</button>}
                  </li>
                ))}
              </ul>
            )}
            {n.ehMinha && anexando === n.id && (
              <div className="linha">
                <select autoFocus value="" onChange={(e) => void anexar(n.id, e.target.value)} onBlur={() => setAnexando(null)}>
                  <option value="">Escolher arquivo da biblioteca…</option>
                  {arquivos.map((a) => <option key={a.id} value={a.id}>{a.displayName}</option>)}
                </select>
              </div>
            )}
            <div className="linha">
              <span className="dica">{new Date(n.updatedAt).toLocaleString("pt-BR")}</span>
              {n.ehMinha && (
                <>
                  <button className="secundario" onClick={() => setAnexando(anexando === n.id ? null : n.id)}>Anexar</button>
                  <button className="secundario" onClick={() => alternarImportante(n)}>{n.important ? "Desmarcar" : "Marcar importante"}</button>
                  <button className="secundario" onClick={() => abrirEdicao(n)}>Editar</button>
                  <button className="secundario" onClick={() => setConfirmando(n)}>Excluir</button>
                </>
              )}
            </div>
          </li>
        ))}
        {!anotacoes.length && <li className="dica">Nenhuma anotação.</li>}
        {anotacoes.length > 0 && !visiveis.length && <li className="dica">{temFiltro ? "Nenhuma anotação corresponde aos filtros." : "Nenhuma anotação."}</li>}
      </ul>
      {confirmando && (
        <ModalConfirmar
          titulo="Excluir anotação"
          mensagem={`Excluir "${confirmando.title}"?`}
          rotuloConfirmar="Excluir"
          perigo
          ocupado={ocupado}
          aoConfirmar={() => void remover()}
          aoCancelar={() => { if (!ocupado) setConfirmando(null); }}
        />
      )}
    </section>
  );
}
