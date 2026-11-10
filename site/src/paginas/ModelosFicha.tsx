import { useCallback, useEffect, useRef, useState } from "react";
import { api, type EstruturaFicha, type ModeloResumo, type VersaoModelo } from "../api";
import EditorFicha from "../EditorFicha";
import { ModalConfirmar } from "../Modal";

const estruturaVazia = (): EstruturaFicha => ({
  versao: 1,
  secoes: [],
  pontos: { habilitado: false, pontosIniciais: 0, pools: [], custos: {} },
});

export default function ModelosFicha({ campaignId }: { campaignId: string }) {
  const [modelos, setModelos] = useState<ModeloResumo[]>([]);
  const [vinculaveis, setVinculaveis] = useState<{ kinds: string[]; elementos: Record<string, { key: string; name: string; category: string | null }[]> } | null>(null);
  const [selecionado, setSelecionado] = useState<string | null>(null);
  const [detalhe, setDetalhe] = useState<{ modelo: ModeloResumo; versoes: VersaoModelo[] } | null>(null);
  const [versaoSel, setVersaoSel] = useState<VersaoModelo | null>(null);
  const [estrutura, setEstrutura] = useState<EstruturaFicha | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [novoNome, setNovoNome] = useState("");
  const [criando, setCriando] = useState(false);
  const [confirmandoPublicar, setConfirmandoPublicar] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  // Impede que uma resposta antiga sobrescreva o modelo selecionado mais recentemente.
  const aberturaAtual = useRef(0);

  const carregar = useCallback(async () => {
    try {
      const { modelos } = await api.listarModelos(campaignId);
      setModelos(modelos);
      setErro(null);
      try {
        const { kinds, elementos } = await api.obterVinculaveis(campaignId);
        setVinculaveis({ kinds, elementos });
      } catch {
        setVinculaveis(null);
      }
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar modelos");
    }
  }, [campaignId]);

  useEffect(() => {
    void carregar();
    return () => { aberturaAtual.current += 1; };
  }, [carregar]);

  const abrirModelo = async (id: string) => {
    const requisicao = ++aberturaAtual.current;
    setSelecionado(id);
    setDetalhe(null);
    setVersaoSel(null);
    setEstrutura(null);
    try {
      const d = await api.obterModelo(campaignId, id);
      if (requisicao !== aberturaAtual.current) return;
      setDetalhe(d);
      // Versão atual = rascunho mais recente, senão a publicada atual
      const rascunho = d.versoes.find((v) => v.rascunho);
      const versao = rascunho ?? d.versoes.find((v) => v.id === d.modelo.currentVersionId) ?? d.versoes[0];
      setVersaoSel(versao ?? null);
      setEstrutura(versao?.estrutura ? { ...versao.estrutura } : estruturaVazia());
    } catch (e) {
      if (requisicao !== aberturaAtual.current) return;
      setErro(e instanceof Error ? e.message : "Erro ao abrir modelo");
    }
  };

  const salvar = async () => {
    if (!selecionado || !versaoSel || !estrutura) return;
    setSalvando(true);
    try {
      await api.salvarEstrutura(campaignId, selecionado, versaoSel.id, estrutura);
      setErro(null);
      await abrirModelo(selecionado);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao salvar estrutura");
    } finally {
      setSalvando(false);
    }
  };

  const novaVersao = async () => {
    if (!selecionado) return;
    try {
      await api.criarVersaoModelo(campaignId, selecionado);
      await abrirModelo(selecionado);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao criar versão");
    }
  };

  const publicar = async () => {
    if (!selecionado || !confirmandoPublicar || ocupado) return;
    setOcupado(true);
    try {
      await api.publicarVersao(campaignId, selecionado, confirmandoPublicar);
      setConfirmandoPublicar(null);
      await abrirModelo(selecionado);
      await carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao publicar");
    } finally {
      setOcupado(false);
    }
  };

  const criar = async () => {
    if (!novoNome.trim()) return;
    try {
      const { modelo } = await api.criarModelo(campaignId, { name: novoNome.trim() });
      setNovoNome("");
      setCriando(false);
      await carregar();
      await abrirModelo(modelo.id);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao criar modelo");
    }
  };

  const alternar = async (m: ModeloResumo, campo: "isActive" | "isDefault", valor: boolean) => {
    try {
      await api.atualizarModelo(campaignId, m.id, { [campo]: valor });
      await carregar();
      if (selecionado === m.id) await abrirModelo(m.id);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao atualizar modelo");
    }
  };

  const duplicar = async (m: ModeloResumo) => {
    try {
      await api.duplicarModelo(campaignId, m.id);
      await carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao duplicar");
    }
  };

  return (
    <>
      <section className="cartao">
        <div className="linha-entre">
          <h2>Modelos de ficha</h2>
          <button onClick={() => setCriando((v) => !v)}>{criando ? "Cancelar" : "Novo modelo"}</button>
        </div>
        {erro && <p className="erro">{erro}</p>}
        {criando && (
          <div className="linha">
            <input placeholder="Nome do modelo (ex.: Ficha Caçadores & Caçados)" value={novoNome} onChange={(e) => setNovoNome(e.target.value)} />
            <button onClick={() => void criar()}>Criar</button>
          </div>
        )}
        {modelos.length === 0 && !criando && <p>Nenhum modelo ainda. Crie o primeiro!</p>}
        {modelos.map((m) => (
          <div key={m.id} className={`linha-entre cartao-item ${selecionado === m.id ? "selecionado" : ""}`} onClick={() => void abrirModelo(m.id)}>
            <div>
              <strong>{m.name}</strong>
              {m.description && <p className="meta">{m.description}</p>}
              <p className="meta">
                {m.versaoAtual ? `v${m.versaoAtual.version}${m.versaoAtual.publishedAt ? " (publicada)" : " (rascunho)"}` : "sem versão"}
                {m.isDefault ? " · padrão" : ""}
                {!m.isActive ? " · inativo" : ""}
              </p>
            </div>
            <div className="acoes" onClick={(e) => e.stopPropagation()}>
              <button className="mini" onClick={() => void alternar(m, "isActive", !m.isActive)}>{m.isActive ? "Desativar" : "Ativar"}</button>
              <button className="mini" onClick={() => void alternar(m, "isDefault", !m.isDefault)}>{m.isDefault ? "Remover padrão" : "Tornar padrão"}</button>
              <button className="mini" onClick={() => void duplicar(m)}>Duplicar</button>
            </div>
          </div>
        ))}
      </section>

      {selecionado && detalhe && versaoSel && estrutura && (
        <section className="cartao">
          <div className="linha-entre">
            <h2>{detalhe.modelo.name}</h2>
            <div className="acoes">
              <select value={versaoSel.id} onChange={(e) => {
                const v = detalhe.versoes.find((x) => x.id === e.target.value);
                setVersaoSel(v ?? null);
                setEstrutura(v?.estrutura ? { ...v.estrutura } : estruturaVazia());
              }}>
                {detalhe.versoes.map((v) => (
                  <option key={v.id} value={v.id}>v{v.version}{v.publishedAt ? " (publicada)" : " (rascunho)"}</option>
                ))}
              </select>
              {versaoSel.rascunho && (
                <>
                  <button onClick={() => void salvar()} disabled={salvando}>{salvando ? "Salvando…" : "Salvar rascunho"}</button>
                  <button className="secundario" onClick={() => setConfirmandoPublicar(versaoSel.id)}>Publicar</button>
                </>
              )}
              <button className="secundario" onClick={() => void novaVersao()}>Nova versão</button>
            </div>
          </div>
          {versaoSel.publishedAt && <p className="meta">Versão publicada — para alterar, crie uma nova versão.</p>}
          {!versaoSel.rascunho && versaoSel.estrutura && (
            <EditorFicha inicial={estrutura} aoMudar={setEstrutura} vinculaveis={vinculaveis ?? undefined} campaignId={campaignId} />
          )}
          {versaoSel.rascunho && <EditorFicha inicial={estrutura} aoMudar={setEstrutura} vinculaveis={vinculaveis ?? undefined} campaignId={campaignId} />}
        </section>
      )}
      {confirmandoPublicar && (
        <ModalConfirmar
          titulo="Publicar versão"
          mensagem="Publicar esta versão para os jogadores? Versões publicadas não podem mais ser editadas."
          rotuloConfirmar="Publicar"
          ocupado={ocupado}
          aoConfirmar={() => void publicar()}
          aoCancelar={() => { if (!ocupado) setConfirmandoPublicar(null); }}
        />
      )}
    </>
  );
}
