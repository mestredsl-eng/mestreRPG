import { useCallback, useEffect, useState } from "react";
import { ApiError, api, type Novidade } from "../api";
import { Modal } from "../Modal";
import { useNotificar } from "../Notificacoes";

const CATEGORIA_LABEL: Record<Novidade["categoria"], string> = {
  novidade: "Novidade",
  melhoria: "Melhoria",
  correcao: "Correção",
};

function formatarData(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
}

export default function Novidades({ aoMudarLeitura }: { aoMudarLeitura?: () => void }) {
  const [itens, setItens] = useState<Novidade[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aberta, setAberta] = useState<Novidade | null>(null);
  const { notificar } = useNotificar();

  const carregar = useCallback(async () => {
    try {
      const { novidades } = await api.listarNovidades();
      setItens(novidades);
      setErro(null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar novidades");
      setItens([]);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const abrir = async (n: Novidade) => {
    setAberta(n);
    // Marca como lida somente ao abrir de fato, vinculada à revisão do
    // conteúdo exibido — se o admin editou nesse meio-tempo, o servidor
    // rejeita (409) e recarregamos a lista para mostrar a versão nova.
    if (!n.lida) {
      try {
        await api.marcarNovidadeLida(n.id, n.revisao);
        setItens((lista) => lista?.map((x) => (x.id === n.id ? { ...x, lida: true } : x)) ?? lista);
        setAberta((atual) => (atual ? { ...atual, lida: true } : atual));
        aoMudarLeitura?.();
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          notificar("Esta publicação foi atualizada. Reabra para ver a versão nova.", "info");
          setAberta(null);
          await carregar();
          aoMudarLeitura?.();
        }
        // Falha de marcação não impede a leitura do conteúdo.
      }
    }
  };

  return (
    <section className="cartao">
      <h2>Novidades</h2>
      <p className="dica">Atualizações e comunicados do Mestre RPG.</p>

      {erro && <p className="erro">{erro}</p>}

      {itens === null ? (
        <p>Carregando…</p>
      ) : itens.length === 0 ? (
        <p className="vazio">Nenhuma novidade publicada por enquanto.</p>
      ) : (
        <ul className="lista-novidades">
          {itens.map((n) => (
            <li key={n.id}>
              <button type="button" className={`novidade-item${n.lida ? "" : " nao-lida"}`} onClick={() => void abrir(n)}>
                <span className="novidade-topo">
                  <span className={`badge badge-cat-${n.categoria}`}>{CATEGORIA_LABEL[n.categoria]}</span>
                  {!n.lida && <span className="ponto-nao-lida" aria-label="Não lida" />}
                  {n.versao && <span className="badge badge-versao">v{n.versao}</span>}
                  <span className="novidade-data">{formatarData(n.publicadoEm)}</span>
                </span>
                <strong className="novidade-titulo">{n.titulo}</strong>
                {n.resumo && <span className="novidade-resumo">{n.resumo}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}

      {aberta && (
        <Modal titulo={aberta.titulo} aoFechar={() => setAberta(null)}
          acoes={<button type="button" className="primario" onClick={() => setAberta(null)}>Fechar</button>}>
          <div className="novidade-detalhe">
            <div className="novidade-topo">
              <span className={`badge badge-cat-${aberta.categoria}`}>{CATEGORIA_LABEL[aberta.categoria]}</span>
              {aberta.versao && <span className="badge badge-versao">v{aberta.versao}</span>}
              <span className="novidade-data">{formatarData(aberta.publicadoEm)}</span>
            </div>
            {aberta.resumo && <p className="novidade-resumo-detalhe">{aberta.resumo}</p>}
            <div className="conteudo-novidade">{aberta.conteudo || "Sem conteúdo adicional."}</div>
          </div>
        </Modal>
      )}
    </section>
  );
}
