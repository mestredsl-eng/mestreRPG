import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, type CategoriaNovidade, type NovidadeAdmin, type NovidadeInput } from "../api";
import { Modal, ModalConfirmar } from "../Modal";
import { useNotificar } from "../Notificacoes";

const CATEGORIAS: { valor: CategoriaNovidade; rotulo: string }[] = [
  { valor: "novidade", rotulo: "Novidade" },
  { valor: "melhoria", rotulo: "Melhoria" },
  { valor: "correcao", rotulo: "Correção" },
];

const FORM_VAZIO: NovidadeInput = {
  titulo: "",
  resumo: "",
  conteudo: "",
  versao: "",
  categoria: "novidade",
  estado: "rascunho",
};

function formatarData(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("pt-BR");
}

export default function AdminNovidades() {
  const [itens, setItens] = useState<NovidadeAdmin[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [editando, setEditando] = useState<NovidadeAdmin | "novo" | null>(null);
  const [confirmandoRemocao, setConfirmandoRemocao] = useState<NovidadeAdmin | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const { notificar } = useNotificar();

  const carregar = useCallback(async () => {
    try {
      const { novidades } = await api.listarNovidadesAdmin();
      setItens(novidades);
      setErro(null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar novidades");
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const alternarEstado = async (n: NovidadeAdmin) => {
    try {
      if (n.estado === "publicada") {
        await api.despublicarNovidade(n.id);
        notificar(`"${n.titulo}" voltou para rascunho.`, "info");
      } else {
        await api.publicarNovidade(n.id);
        notificar(`"${n.titulo}" publicada.`, "sucesso");
      }
      await carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao alterar estado");
    }
  };

  const remover = async () => {
    if (!confirmandoRemocao || ocupado) return;
    setOcupado(true);
    try {
      await api.removerNovidade(confirmandoRemocao.id);
      setConfirmandoRemocao(null);
      notificar(`Publicação "${confirmandoRemocao.titulo}" removida.`, "sucesso");
      await carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao remover publicação");
    } finally {
      setOcupado(false);
    }
  };

  return (
    <section className="cartao">
      <div className="linha-entre">
        <h2>Novidades</h2>
        <button onClick={() => setEditando("novo")}>Nova publicação</button>
      </div>
      <p className="dica">Comunique atualizações aos usuários. Rascunhos não aparecem na central.</p>

      {erro && <p className="erro">{erro}</p>}

      {itens === null ? (
        <p>Carregando…</p>
      ) : itens.length === 0 ? (
        <p className="vazio">Nenhuma publicação ainda.</p>
      ) : (
        <table className="tabela tabela-responsiva">
          <thead>
            <tr>
              <th>Título</th>
              <th>Categoria</th>
              <th>Versão</th>
              <th>Estado</th>
              <th>Publicada em</th>
              <th>Lidas</th>
              <th>Ações</th>
            </tr>
          </thead>
          <tbody>
            {itens.map((n) => (
              <tr key={n.id}>
                <td>{n.titulo}</td>
                <td>{CATEGORIAS.find((c) => c.valor === n.categoria)?.rotulo ?? n.categoria}</td>
                <td>{n.versao ? `v${n.versao}` : "—"}</td>
                <td><span className={`badge badge-${n.estado}`}>{n.estado === "publicada" ? "Publicada" : "Rascunho"}</span></td>
                <td>{formatarData(n.publicadoEm)}</td>
                <td>{n.leituras}</td>
                <td className="acoes">
                  <button className="mini" onClick={() => setEditando(n)}>Editar</button>
                  <button className="mini" onClick={() => void alternarEstado(n)}>
                    {n.estado === "publicada" ? "Despublicar" : "Publicar"}
                  </button>
                  <button className="mini perigo" onClick={() => setConfirmandoRemocao(n)}>Remover</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editando && (
        <FormNovidade
          novidade={editando === "novo" ? null : editando}
          aoSalvar={async (dados) => {
            if (editando === "novo") {
              await api.criarNovidade(dados);
              notificar("Publicação criada.", "sucesso");
            } else {
              await api.atualizarNovidade(editando.id, dados);
              notificar("Publicação atualizada.", "sucesso");
            }
            setEditando(null);
            await carregar();
          }}
          aoCancelar={() => setEditando(null)}
        />
      )}

      {confirmandoRemocao && (
        <ModalConfirmar
          titulo="Remover publicação"
          mensagem={`Remover "${confirmandoRemocao.titulo}"? As marcações de leitura associadas também serão removidas.`}
          rotuloConfirmar="Remover"
          perigo
          ocupado={ocupado}
          aoConfirmar={() => void remover()}
          aoCancelar={() => { if (!ocupado) setConfirmandoRemocao(null); }}
        />
      )}
    </section>
  );
}

function FormNovidade({
  novidade,
  aoSalvar,
  aoCancelar,
}: {
  novidade: NovidadeAdmin | null;
  aoSalvar: (dados: NovidadeInput) => Promise<void>;
  aoCancelar: () => void;
}) {
  const [form, setForm] = useState<NovidadeInput>(() => ({
    ...FORM_VAZIO,
    ...(novidade
      ? {
          titulo: novidade.titulo,
          resumo: novidade.resumo ?? "",
          conteudo: novidade.conteudo,
          versao: novidade.versao ?? "",
          categoria: novidade.categoria,
          estado: novidade.estado,
        }
      : {}),
  }));
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const salvar = async (e: FormEvent) => {
    e.preventDefault();
    if (ocupado) return;
    setOcupado(true);
    setErro(null);
    try {
      await aoSalvar({
        ...form,
        titulo: form.titulo.trim(),
        resumo: form.resumo?.trim() || null,
        versao: form.versao?.trim() || null,
      });
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao salvar");
    } finally {
      setOcupado(false);
    }
  };

  return (
    <Modal
      titulo={novidade ? `Editar — ${novidade.titulo}` : "Nova publicação"}
      aoFechar={() => { if (!ocupado) aoCancelar(); }}
      ocupado={ocupado}
    >
      <form className="formulario" onSubmit={salvar}>
        <label>Título
          <input value={form.titulo} onChange={(e) => setForm({ ...form, titulo: e.target.value })} required maxLength={140} autoFocus />
        </label>
        <div className="grade-2">
          <label>Categoria
            <select value={form.categoria} onChange={(e) => setForm({ ...form, categoria: e.target.value as CategoriaNovidade })}>
              {CATEGORIAS.map((c) => <option key={c.valor} value={c.valor}>{c.rotulo}</option>)}
            </select>
          </label>
          <label>Versão
            <input value={form.versao ?? ""} onChange={(e) => setForm({ ...form, versao: e.target.value })} maxLength={40} placeholder="ex.: 1.1.0" />
          </label>
        </div>
        <label>Resumo
          <input value={form.resumo ?? ""} onChange={(e) => setForm({ ...form, resumo: e.target.value })} maxLength={300} placeholder="Uma frase exibida na listagem" />
        </label>
        <label>Conteúdo
          <textarea value={form.conteudo ?? ""} onChange={(e) => setForm({ ...form, conteudo: e.target.value })} rows={8} maxLength={20000} placeholder="Texto da publicação — escrito para os usuários, sem detalhes técnicos internos." />
        </label>
        <label>Estado
          <select value={form.estado} onChange={(e) => setForm({ ...form, estado: e.target.value as NovidadeInput["estado"] })}>
            <option value="rascunho">Rascunho (invisível)</option>
            <option value="publicada">Publicada</option>
          </select>
        </label>
        {erro && <p className="erro">{erro}</p>}
        <div className="acoes-modal">
          <button type="button" className="secundario" onClick={aoCancelar} disabled={ocupado}>Cancelar</button>
          <button type="submit" disabled={ocupado}>{ocupado ? "Salvando…" : "Salvar"}</button>
        </div>
      </form>
    </Modal>
  );
}
