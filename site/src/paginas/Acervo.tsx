import { useCallback, useEffect, useRef, useState } from "react";
import { api, type BackupLivro, type DecisaoImportacao, type EnvelopeAcervo, type ItemLivroAcervo, type LivroAcervoResumo, type PreviaImportacaoAcervo } from "../api";
import { useAuth } from "../auth";
import { useNotificar } from "../Notificacoes";
import { Modal, ModalConfirmar } from "../Modal";

const FORMATO = "mestre-rpg-biblioteca";

interface FormLivro {
  titulo: string;
  descricao: string;
  autor: string;
  sistema: string;
  edicao: string;
  tipo: "livro" | "suplemento";
}
const FORM_VAZIO: FormLivro = { titulo: "", descricao: "", autor: "", sistema: "", edicao: "", tipo: "livro" };

function paraForm(l: LivroAcervoResumo): FormLivro {
  return {
    titulo: l.titulo, descricao: l.descricao ?? "", autor: l.autor ?? "",
    sistema: l.sistema ?? "", edicao: l.edicao ?? "", tipo: l.tipo === "suplemento" ? "suplemento" : "livro",
  };
}

export default function Acervo() {
  const { estado } = useAuth();
  const ehAdmin = estado.status === "autenticado" && estado.usuario.isAdmin;
  const { notificar } = useNotificar();

  const [livros, setLivros] = useState<LivroAcervoResumo[]>([]);
  const [busca, setBusca] = useState("");
  const [filtroTipo, setFiltroTipo] = useState("");
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);

  const [livroAberto, setLivroAberto] = useState<LivroAcervoResumo | null>(null);
  const [itens, setItens] = useState<ItemLivroAcervo[]>([]);
  const [carregandoItens, setCarregandoItens] = useState(false);

  const [modalLivro, setModalLivro] = useState<"novo" | LivroAcervoResumo | null>(null);
  const [formLivro, setFormLivro] = useState<FormLivro>(FORM_VAZIO);
  const [salvandoLivro, setSalvandoLivro] = useState(false);

  const [modalItem, setModalItem] = useState<"novo" | ItemLivroAcervo | null>(null);
  const [formItem, setFormItem] = useState({ kind: "", key: "", name: "", category: "", parentKey: "", definition: "", ordem: "0" });
  const [salvandoItem, setSalvandoItem] = useState(false);

  const [arquivoImport, setArquivoImport] = useState<EnvelopeAcervo | null>(null);
  const [previa, setPrevia] = useState<PreviaImportacaoAcervo | null>(null);
  const [decisoes, setDecisoes] = useState<Map<number, DecisaoImportacao>>(new Map());
  const [confirmando, setConfirmando] = useState(false);

  const [backups, setBackups] = useState<BackupLivro[]>([]);
  const [mostrarBackups, setMostrarBackups] = useState(false);
  const [backupParaRestaurar, setBackupParaRestaurar] = useState<BackupLivro | null>(null);

  const carregarLivros = useCallback(async () => {
    setCarregando(true);
    try {
      const r = await api.listarLivrosAcervo(busca || undefined, filtroTipo || undefined);
      setLivros(r.livros);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar acervo");
    } finally {
      setCarregando(false);
    }
  }, [busca, filtroTipo]);

  useEffect(() => { void carregarLivros(); }, [carregarLivros]);

  const abrirLivro = async (l: LivroAcervoResumo) => {
    setLivroAberto(l);
    setCarregandoItens(true);
    try {
      const r = await api.obterLivroAcervo(l.id);
      setItens(r.itens);
      setLivroAberto(r.livro);
    } catch (e) {
      notificar(e instanceof Error ? e.message : "Erro ao abrir livro", "erro");
    } finally {
      setCarregandoItens(false);
    }
  };

  const carregarBackups = async (bookId: string) => {
    try {
      const r = await api.listarBackupsLivro(bookId);
      setBackups(r.backups);
    } catch { setBackups([]); }
  };

  useEffect(() => { if (livroAberto && mostrarBackups) void carregarBackups(livroAberto.id); }, [livroAberto, mostrarBackups]);

  // ---------- livro: criar/editar ----------
  const salvarLivro = async () => {
    setSalvandoLivro(true);
    try {
      const dados = {
        titulo: formLivro.titulo.trim(),
        descricao: formLivro.descricao || null,
        autor: formLivro.autor || null,
        sistema: formLivro.sistema || null,
        edicao: formLivro.edicao || null,
        tipo: formLivro.tipo,
      };
      if (modalLivro === "novo") {
        await api.criarLivroAcervo(dados);
        notificar("Livro criado.", "sucesso");
      } else if (modalLivro) {
        await api.atualizarLivroAcervo(modalLivro.id, dados);
        notificar("Livro atualizado.", "sucesso");
        if (livroAberto?.id === modalLivro.id) setLivroAberto({ ...livroAberto, ...dados, tipo: formLivro.tipo });
      }
      setModalLivro(null);
      await carregarLivros();
    } catch (e) {
      notificar(e instanceof Error ? e.message : "Erro ao salvar livro", "erro");
    } finally {
      setSalvandoLivro(false);
    }
  };

  const excluirLivro = async (l: LivroAcervoResumo) => {
    if (!window.confirm(`Excluir "${l.titulo}" e todos os seus itens?`)) return;
    try {
      await api.removerLivroAcervo(l.id);
      notificar("Livro excluído.", "sucesso");
      if (livroAberto?.id === l.id) setLivroAberto(null);
      await carregarLivros();
    } catch (e) {
      notificar(e instanceof Error ? e.message : "Erro ao excluir livro", "erro");
    }
  };

  // ---------- item: criar/editar ----------
  const abrirModalItem = (item: "novo" | ItemLivroAcervo) => {
    if (item === "novo") {
      setFormItem({ kind: "", key: "", name: "", category: "", parentKey: "", definition: "", ordem: String(itens.length) });
      setModalItem("novo");
    } else {
      setFormItem({
        kind: item.kind, key: item.key, name: item.name,
        category: item.category ?? "", parentKey: item.parentKey ?? "",
        definition: JSON.stringify(item.definition ?? {}, null, 2),
        ordem: String(item.ordem),
      });
      setModalItem(item);
    }
  };

  const salvarItem = async () => {
    if (!livroAberto) return;
    let definition: Record<string, unknown> = {};
    if (formItem.definition.trim()) {
      try { definition = JSON.parse(formItem.definition); }
      catch { notificar("Definition não é um JSON válido", "erro"); return; }
    }
    const dados = {
      kind: formItem.kind.trim(), key: formItem.key.trim(), name: formItem.name.trim(),
      category: formItem.category || null, parentKey: formItem.parentKey || null,
      definition, ordem: Number(formItem.ordem) || 0,
    };
    if (!dados.kind || !dados.key || !dados.name) { notificar("Tipo, chave e nome são obrigatórios", "erro"); return; }
    setSalvandoItem(true);
    try {
      if (modalItem === "novo") {
        await api.adicionarItemLivro(livroAberto.id, dados);
      } else if (modalItem) {
        await api.atualizarItemLivro(livroAberto.id, modalItem.id, dados);
      }
      setModalItem(null);
      const r = await api.obterLivroAcervo(livroAberto.id);
      setItens(r.itens);
      notificar("Item salvo.", "sucesso");
    } catch (e) {
      notificar(e instanceof Error ? e.message : "Erro ao salvar item", "erro");
    } finally {
      setSalvandoItem(false);
    }
  };

  const excluirItem = async (item: ItemLivroAcervo) => {
    if (!livroAberto || !window.confirm(`Remover item "${item.name}" (${item.kind}:${item.key})?`)) return;
    try {
      await api.removerItemLivro(livroAberto.id, item.id);
      setItens((prev) => prev.filter((i) => i.id !== item.id));
      notificar("Item removido.", "sucesso");
    } catch (e) {
      notificar(e instanceof Error ? e.message : "Erro ao remover item", "erro");
    }
  };

  // ---------- importação ----------
  const arquivoRef = useRef<HTMLInputElement>(null);

  const lerArquivo = async (file: File) => {
    try {
      const texto = await file.text();
      const json = JSON.parse(texto);
      if (json?.formato !== FORMATO) throw new Error(`Formato inválido — esperado "${FORMATO}"`);
      setArquivoImport(json as EnvelopeAcervo);
      const p = await api.previaImportacaoAcervo(json as EnvelopeAcervo);
      setPrevia(p);
      // decisões padrão: manter tudo (nada sobrescreve sem escolha)
      const mapa = new Map<number, DecisaoImportacao>();
      for (const l of p.livros) {
        mapa.set(l.indice, { indice: l.indice, metadados: "manter", itens: {} });
      }
      setDecisoes(mapa);
    } catch (e) {
      notificar(e instanceof Error ? e.message : "Arquivo inválido", "erro");
      setArquivoImport(null);
      setPrevia(null);
    }
  };

  const alternarDecisao = (indice: number, campo: "metadados" | string, valor: "atualizar" | "manter") => {
    setDecisoes((prev) => {
      const m = new Map(prev);
      const atual = m.get(indice) ?? { indice, metadados: "manter" as const, itens: {} };
      if (campo === "metadados") atual.metadados = valor;
      else atual.itens = { ...atual.itens, [campo]: valor };
      m.set(indice, atual);
      return m;
    });
  };

  const confirmarImportacao = async () => {
    if (!arquivoImport || !previa) return;
    setConfirmando(true);
    try {
      const lista = previa.livros.map((l) => decisoes.get(l.indice) ?? { indice: l.indice, metadados: "manter" as const, itens: {} });
      const r = await api.confirmarImportacaoAcervo(arquivoImport, lista);
      const criados = r.resultados.filter((x) => x.acao === "criado").length;
      const atualizados = r.resultados.filter((x) => x.acao === "atualizado").length;
      notificar(`Importação concluída: ${criados} novo(s), ${atualizados} atualizado(s).`, "sucesso");
      setArquivoImport(null); setPrevia(null); setDecisoes(new Map());
      await carregarLivros();
    } catch (e) {
      notificar(e instanceof Error ? e.message : "Erro na importação", "erro");
    } finally {
      setConfirmando(false);
    }
  };

  // ---------- exportação ----------
  const baixar = (url: string, nome: string) => {
    const a = document.createElement("a");
    a.href = url; a.download = nome;
    document.body.appendChild(a); a.click(); a.remove();
  };

  // ---------- render ----------
  return (
    <>
      <section className="cartao">
        <div className="linha" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem" }}>
          <h2 style={{ margin: 0 }}>Acervo de Livros de Regras</h2>
          <div className="linha">
            {ehAdmin && (
              <>
                <button className="secundario" onClick={() => { setFormLivro(FORM_VAZIO); setModalLivro("novo"); }}>+ Novo livro</button>
                <button className="secundario" onClick={() => arquivoRef.current?.click()}>Importar JSON</button>
                <button className="secundario" onClick={() => baixar(api.urlExportarAcervo(), `acervo-regras.json`)}>Exportar acervo</button>
              </>
            )}
          </div>
        </div>
        <p className="suave">
          Acervo global de livros e suplementos — independente das regras de cada campanha.
          {ehAdmin ? " Somente administradores podem alterar o acervo." : " Você pode consultar; alterações exigem permissão de administrador."}
        </p>
        <div className="linha" style={{ flexWrap: "wrap" }}>
          <input
            type="search" placeholder="Buscar por título, autor, sistema ou edição…"
            value={busca} onChange={(e) => setBusca(e.target.value)}
            style={{ flex: "1 1 220px" }}
          />
          <select value={filtroTipo} onChange={(e) => setFiltroTipo(e.target.value)}>
            <option value="">Todos os tipos</option>
            <option value="livro">Livros</option>
            <option value="suplemento">Suplementos</option>
          </select>
        </div>
        <input ref={arquivoRef} type="file" accept=".json,application/json" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void lerArquivo(f); e.target.value = ""; }} />
      </section>

      {erro && <p className="erro">{erro}</p>}
      {carregando ? <p>Carregando…</p> : livros.length === 0 ? (
        <section className="cartao"><p>Nenhum livro no acervo ainda.</p></section>
      ) : (
        <section className="cartao">
          <table className="tabela">
            <thead>
              <tr><th>Título</th><th>Tipo</th><th>Autor</th><th>Sistema</th><th>Edição</th><th>Itens</th><th></th></tr>
            </thead>
            <tbody>
              {livros.map((l) => (
                <tr key={l.id}>
                  <td><strong>{l.titulo}</strong>{l.descricao ? <div className="suave">{l.descricao.slice(0, 80)}{l.descricao.length > 80 ? "…" : ""}</div> : null}</td>
                  <td>{l.tipo === "suplemento" ? "Suplemento" : "Livro"}</td>
                  <td>{l.autor ?? "—"}</td>
                  <td>{l.sistema ?? "—"}</td>
                  <td>{l.edicao ?? "—"}</td>
                  <td>{l.totalItens ?? 0}</td>
                  <td className="linha">
                    <button className="secundario" onClick={() => void abrirLivro(l)}>Abrir</button>
                    {ehAdmin && <button className="secundario" onClick={() => baixar(api.urlExportarLivro(l.id), `${l.titulo}.json`)}>Exportar</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* ---------- detalhe do livro ---------- */}
      {livroAberto && (
        <section className="cartao">
          <div className="linha" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
            <h2 style={{ margin: 0 }}>{livroAberto.titulo} <span className="suave">({livroAberto.tipo === "suplemento" ? "Suplemento" : "Livro"} · v{livroAberto.versao})</span></h2>
            <div className="linha">
              {ehAdmin && (
                <>
                  <button className="secundario" onClick={() => { setFormLivro(paraForm(livroAberto)); setModalLivro(livroAberto); }}>Editar</button>
                  <button className="secundario" onClick={() => abrirModalItem("novo")}>+ Item</button>
                  <button className="secundario" onClick={() => { setMostrarBackups((v) => !v); }}>Backups</button>
                  <button className="perigo" onClick={() => void excluirLivro(livroAberto)}>Excluir</button>
                </>
              )}
              <button className="secundario" onClick={() => setLivroAberto(null)}>Fechar</button>
            </div>
          </div>
          <table className="tabela">
            <tbody>
              {livroAberto.autor && <tr><th>Autor</th><td>{livroAberto.autor}</td></tr>}
              {livroAberto.sistema && <tr><th>Sistema</th><td>{livroAberto.sistema}</td></tr>}
              {livroAberto.edicao && <tr><th>Edição</th><td>{livroAberto.edicao}</td></tr>}
              {livroAberto.descricao && <tr><th>Descrição</th><td>{livroAberto.descricao}</td></tr>}
            </tbody>
          </table>

          {mostrarBackups && ehAdmin && (
            <div style={{ marginTop: "0.75rem" }}>
              <h3>Histórico de backups</h3>
              {backups.length === 0 ? <p className="suave">Nenhum backup ainda — backups são gerados antes de importações e restaurações.</p> : (
                <table className="tabela">
                  <thead><tr><th>Data</th><th>Motivo</th><th>Itens</th><th></th></tr></thead>
                  <tbody>
                    {backups.map((b) => (
                      <tr key={b.id}>
                        <td>{new Date(b.createdAt).toLocaleString("pt-BR")}</td>
                        <td>{b.motivo}</td>
                        <td>{b.itens}</td>
                        <td><button className="secundario" onClick={() => setBackupParaRestaurar(b)}>Restaurar</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          <h3 style={{ marginTop: "1rem" }}>Itens ({itens.length})</h3>
          {carregandoItens ? <p>Carregando…</p> : itens.length === 0 ? (
            <p className="suave">Este livro ainda não tem itens.</p>
          ) : (
            <table className="tabela">
              <thead><tr><th>Tipo</th><th>Chave</th><th>Nome</th><th>Categoria</th><th>Ordem</th><th></th></tr></thead>
              <tbody>
                {itens.map((it) => (
                  <tr key={it.id}>
                    <td><code>{it.kind}</code></td>
                    <td><code>{it.key}</code></td>
                    <td>{it.name}</td>
                    <td>{it.category ?? "—"}</td>
                    <td>{it.ordem}</td>
                    <td className="linha">
                      {ehAdmin && (
                        <>
                          <button className="secundario" onClick={() => abrirModalItem(it)}>Editar</button>
                          <button className="perigo" onClick={() => void excluirItem(it)}>Remover</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {/* ---------- modal livro ---------- */}
      {modalLivro && (
        <Modal titulo={modalLivro === "novo" ? "Novo livro" : "Editar livro"} aoFechar={() => setModalLivro(null)} ocupado={salvandoLivro}
          acoes={<>
            <button className="secundario" onClick={() => setModalLivro(null)}>Cancelar</button>
            <button onClick={() => void salvarLivro()} disabled={salvandoLivro || !formLivro.titulo.trim()}>{salvandoLivro ? "Salvando…" : "Salvar"}</button>
          </>}>
          <div className="formulario">
            <label>Título<input value={formLivro.titulo} onChange={(e) => setFormLivro({ ...formLivro, titulo: e.target.value })} required /></label>
            <label>Tipo
              <select value={formLivro.tipo} onChange={(e) => setFormLivro({ ...formLivro, tipo: e.target.value as "livro" | "suplemento" })}>
                <option value="livro">Livro</option>
                <option value="suplemento">Suplemento</option>
              </select>
            </label>
            <label>Autor<input value={formLivro.autor} onChange={(e) => setFormLivro({ ...formLivro, autor: e.target.value })} /></label>
            <label>Sistema<input value={formLivro.sistema} onChange={(e) => setFormLivro({ ...formLivro, sistema: e.target.value })} placeholder="Ex.: Caçadores & Caçados" /></label>
            <label>Edição<input value={formLivro.edicao} onChange={(e) => setFormLivro({ ...formLivro, edicao: e.target.value })} placeholder="Ex.: 1ª edição" /></label>
            <label>Descrição<textarea rows={3} value={formLivro.descricao} onChange={(e) => setFormLivro({ ...formLivro, descricao: e.target.value })} /></label>
          </div>
        </Modal>
      )}

      {/* ---------- modal item ---------- */}
      {modalItem && livroAberto && (
        <Modal titulo={modalItem === "novo" ? "Novo item" : "Editar item"} aoFechar={() => setModalItem(null)} ocupado={salvandoItem}
          acoes={<>
            <button className="secundario" onClick={() => setModalItem(null)}>Cancelar</button>
            <button onClick={() => void salvarItem()} disabled={salvandoItem}>{salvandoItem ? "Salvando…" : "Salvar"}</button>
          </>}>
          <div className="formulario">
            <label>Tipo (kind)<input value={formItem.kind} onChange={(e) => setFormItem({ ...formItem, kind: e.target.value })} placeholder="atributo, habilidade, regra_combate, tabela…" required disabled={modalItem !== "novo"} /></label>
            <label>Chave (key)<input value={formItem.key} onChange={(e) => setFormItem({ ...formItem, key: e.target.value })} placeholder="forca, ataque_fogo…" required disabled={modalItem !== "novo"} /></label>
            <label>Nome<input value={formItem.name} onChange={(e) => setFormItem({ ...formItem, name: e.target.value })} required /></label>
            <label>Categoria<input value={formItem.category} onChange={(e) => setFormItem({ ...formItem, category: e.target.value })} /></label>
            <label>Item pai (parentKey)<input value={formItem.parentKey} onChange={(e) => setFormItem({ ...formItem, parentKey: e.target.value })} /></label>
            <label>Ordem<input type="number" min={0} value={formItem.ordem} onChange={(e) => setFormItem({ ...formItem, ordem: e.target.value })} /></label>
            <label>Definition (JSON)<textarea rows={6} value={formItem.definition} onChange={(e) => setFormItem({ ...formItem, definition: e.target.value })} placeholder='{"custo": 1, "efeito": "…"}' style={{ fontFamily: "monospace" }} /></label>
          </div>
        </Modal>
      )}

      {/* ---------- prévia de importação ---------- */}
      {previa && arquivoImport && (
        <Modal titulo="Prévia da importação" aoFechar={() => { setPrevia(null); setArquivoImport(null); setDecisoes(new Map()); }} ocupado={confirmando}
          acoes={<>
            <button className="secundario" onClick={() => { setPrevia(null); setArquivoImport(null); setDecisoes(new Map()); }}>Cancelar</button>
            <button onClick={() => void confirmarImportacao()} disabled={confirmando}>{confirmando ? "Importando…" : "Confirmar importação"}</button>
          </>}>
          <p>
            {previa.totalLivros} livro(s) no arquivo — {previa.novos} novo(s), {previa.atualizacoes} atualização(ões).
            Itens ausentes no arquivo são sempre preservados; conflitos só são aplicados com decisão explícita.
          </p>
          {previa.livros.map((l) => {
            const dec = decisoes.get(l.indice) ?? { indice: l.indice, metadados: "manter" as const, itens: {} };
            return (
              <div key={l.indice} className="cartao" style={{ marginBottom: "0.75rem" }}>
                <h3 style={{ marginTop: 0 }}>
                  {l.titulo} <span className="suave">— {l.acao === "novo" ? "novo" : "atualizar"}</span>
                </h3>
                <p className="suave">
                  +{l.resumo.itensNovos} novos · ~{l.resumo.itensAlterados} alterados · =
                  {l.resumo.itensIdenticos} idênticos · preservados {l.resumo.itensAusentesPreservados}
                </p>
                {l.metadadosAlterados.length > 0 && l.acao === "atualizar" && (
                  <div>
                    <strong>Metadados que mudariam:</strong>
                    <ul>
                      {l.metadadosAlterados.map((m) => (
                        <li key={m.campo}><code>{m.campo}</code>: {String(m.de ?? "—")} → {String(m.para ?? "—")}</li>
                      ))}
                    </ul>
                    <div className="linha">
                      <label><input type="radio" checked={dec.metadados === "manter"} onChange={() => alternarDecisao(l.indice, "metadados", "manter")} /> Manter atuais</label>
                      <label><input type="radio" checked={dec.metadados === "atualizar"} onChange={() => alternarDecisao(l.indice, "metadados", "atualizar")} /> Atualizar metadados</label>
                    </div>
                  </div>
                )}
                {l.conflitos.length > 0 && (
                  <div>
                    <strong>Conflitos de itens (kind:key):</strong>
                    <ul>
                      {l.conflitos.map((c) => {
                        const ck = `${c.kind}:${c.key}`;
                        return (
                          <li key={ck}>
                            <code>{ck}</code> — {c.name} ({c.campos.join(", ")})
                            <span className="linha" style={{ marginLeft: "0.75rem" }}>
                              <label><input type="radio" checked={dec.itens[ck] !== "atualizar"} onChange={() => alternarDecisao(l.indice, ck, "manter")} /> manter</label>
                              <label><input type="radio" checked={dec.itens[ck] === "atualizar"} onChange={() => alternarDecisao(l.indice, ck, "atualizar")} /> atualizar</label>
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </div>
            );
          })}
        </Modal>
      )}

      {/* ---------- restaurar backup ---------- */}
      {backupParaRestaurar && (
      <ModalConfirmar
        titulo="Restaurar backup"
        mensagem={`Restaurar o livro para o estado de ${new Date(backupParaRestaurar.createdAt).toLocaleString("pt-BR")} (${backupParaRestaurar.motivo})? O estado atual será salvo como backup antes.`}
        rotuloConfirmar="Restaurar"
        aoCancelar={() => setBackupParaRestaurar(null)}
        aoConfirmar={() => void (async () => {
          try {
            await api.restaurarBackupLivro(backupParaRestaurar.id);
            notificar("Backup restaurado.", "sucesso");
            if (livroAberto) {
              const r = await api.obterLivroAcervo(livroAberto.id);
              setItens(r.itens); setLivroAberto(r.livro);
              await carregarBackups(livroAberto.id);
            }
          } catch (e) {
            notificar(e instanceof Error ? e.message : "Erro ao restaurar", "erro");
          } finally {
            setBackupParaRestaurar(null);
          }
        })()}
      />
      )}
    </>
  );
}
