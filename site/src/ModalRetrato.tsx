import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type ArquivoBiblioteca, type RetratoPersonagem } from "./api";

interface ItemGaleria {
  id: string;
  arquivo: string;
  categoria: string;
  rotulo: string;
}

const CATEGORIAS: { id: string; rotulo: string }[] = [
  { id: "", rotulo: "Todas" },
  { id: "homem", rotulo: "Homens" },
  { id: "mulher", rotulo: "Mulheres" },
  { id: "vampiro", rotulo: "Vampiros" },
  { id: "vampira", rotulo: "Vampiras" },
  { id: "lobisomem", rotulo: "Lobisomens" },
  { id: "criatura", rotulo: "Criaturas" },
];

let cacheGaleria: Promise<ItemGaleria[]> | null = null;
function carregarGaleria(): Promise<ItemGaleria[]> {
  cacheGaleria ??= fetch("/retratos/indice.json")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error("galeria indisponível"))))
    .then((j: { retratos?: ItemGaleria[] }) => j.retratos ?? [])
    .catch((e) => { cacheGaleria = null; throw e; });
  return cacheGaleria;
}

/** Modal de retrato (Issue #129): galeria padrão com filtro por
 *  categoria e busca, upload de imagem própria e seleção de imagem já
 *  existente na biblioteca da campanha. */
export default function ModalRetrato({ characterId, campaignId, retratoAtual, nome, aoMudar, aoFechar }: {
  characterId: string;
  campaignId: string;
  retratoAtual?: RetratoPersonagem | null;
  nome: string;
  aoMudar: (retrato: RetratoPersonagem | null) => void;
  aoFechar: () => void;
}) {
  const [aba, setAba] = useState<"galeria" | "biblioteca">("galeria");
  const [galeria, setGaleria] = useState<ItemGaleria[] | null>(null);
  const [categoria, setCategoria] = useState("");
  const [busca, setBusca] = useState("");
  const [biblioteca, setBiblioteca] = useState<ArquivoBiblioteca[] | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const inputArquivo = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void carregarGaleria().then(setGaleria).catch(() => setGaleria([]));
  }, []);
  useEffect(() => {
    if (aba !== "biblioteca" || biblioteca !== null) return;
    // Somente raster aceito pelo servidor como retrato — SVG, GIF, BMP
    // etc. não aparecem como opção (a validação definitiva continua no
    // PUT/GET do servidor: extensão, MIME, assinatura, tamanho, dimensões).
    api.listarArquivos(campaignId)
      .then((r) => setBiblioteca(r.arquivos.filter((a) =>
        a.mimeType === "image/png" || a.mimeType === "image/jpeg" || a.mimeType === "image/webp")))
      .catch(() => setBiblioteca([]));
  }, [aba, campaignId, biblioteca]);

  const visiveis = useMemo(() => {
    const q = busca.trim().toLowerCase();
    return (galeria ?? []).filter((g) =>
      (!categoria || g.categoria === categoria) &&
      (!q || g.rotulo.toLowerCase().includes(q) || g.categoria.toLowerCase().includes(q)));
  }, [galeria, categoria, busca]);

  const escolher = async (fn: () => Promise<unknown>) => {
    setOcupado(true);
    setErro(null);
    try {
      await fn();
      aoFechar();
    } catch (e) {
      setErro(e instanceof ApiError || e instanceof Error ? e.message : "Erro ao salvar retrato");
    } finally {
      setOcupado(false);
    }
  };

  const enviar = (arquivo: File) => void escolher(async () => {
    const r = await api.uploadRetrato(characterId, arquivo);
    aoMudar(r.retrato);
  });

  return (
    <div className="modal-fundo" onClick={() => { if (!ocupado) aoFechar(); }}>
      <div className="modal cartao modal-retrato" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`Retrato de ${nome}`}>
        <h4>Retrato — {nome}</h4>
        <div className="abas">
          <button type="button" className={aba === "galeria" ? "ativo" : ""} onClick={() => setAba("galeria")}>Galeria</button>
          <button type="button" className={aba === "biblioteca" ? "ativo" : ""} onClick={() => setAba("biblioteca")}>Biblioteca</button>
        </div>
        {aba === "galeria" && (
          <>
            <div className="linha filtros-lista">
              <input type="search" placeholder="Buscar retrato…" aria-label="Buscar retrato" value={busca} onChange={(e) => setBusca(e.target.value)} />
            </div>
            <div className="linha filtros-lista">
              {CATEGORIAS.map((c) => (
                <button key={c.id} type="button" className={`chip ${categoria === c.id ? "ativo" : ""}`} onClick={() => setCategoria(c.id)}>{c.rotulo}</button>
              ))}
            </div>
            {galeria === null ? <p className="meta">Carregando galeria…</p> : visiveis.length === 0 ? (
              <p className="meta">Nenhum retrato encontrado.</p>
            ) : (
              <div className="grade-retratos">
                {visiveis.map((g) => (
                  <button key={g.id} type="button" className="retrato-opcao" disabled={ocupado}
                    title={g.rotulo}
                    onClick={() => void escolher(async () => {
                      const r = await api.definirRetrato(characterId, { tipo: "galeria", id: g.id });
                      aoMudar(r.retrato);
                    })}>
                    <img src={`/retratos/${g.arquivo}`} alt={g.rotulo} loading="lazy" />
                    <span className="meta">{g.rotulo}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        {aba === "biblioteca" && (
          biblioteca === null ? <p className="meta">Carregando biblioteca…</p> : biblioteca.length === 0 ? (
            <p className="meta">Nenhuma imagem na biblioteca da campanha.</p>
          ) : (
            <div className="grade-retratos">
              {biblioteca.map((a) => (
                <button key={a.id} type="button" className="retrato-opcao" disabled={ocupado}
                  title={a.displayName}
                  onClick={() => void escolher(async () => {
                    const r = await api.definirRetrato(characterId, { tipo: "arquivo", arquivoId: a.id });
                    aoMudar(r.retrato);
                  })}>
                  <img src={api.urlArquivo(campaignId, a.id)} alt={a.displayName} loading="lazy" />
                  <span className="meta">{a.displayName}</span>
                </button>
              ))}
            </div>
          )
        )}
        {erro && <p className="erro">{erro}</p>}
        <div className="linha">
          <input ref={inputArquivo} type="file" accept="image/png,image/jpeg,image/webp" hidden
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) enviar(f); }} />
          <button type="button" className="secundario" disabled={ocupado} onClick={() => inputArquivo.current?.click()}>
            Enviar imagem própria…
          </button>
          {retratoAtual && (
            <button type="button" className="perigo" disabled={ocupado}
              onClick={() => void escolher(async () => {
                const r = await api.definirRetrato(characterId, null);
                aoMudar(r.retrato);
              })}>
              Remover retrato
            </button>
          )}
          <button type="button" className="secundario" onClick={aoFechar} disabled={ocupado}>Fechar</button>
        </div>
        <p className="meta">PNG, JPG ou WebP até 5 MB. O retrato é independente da arte do token da mesa.</p>
      </div>
    </div>
  );
}
