import { useCallback, useEffect, useState } from "react";
import { api, type PersonagemComDefeitos } from "./api";
import { useSincronizacaoCampanha } from "./useSincronizacao";

/**
 * Painel de defeitos dos personagens — ferramenta do mestre na Mesa.
 * Lista, por personagem, os defeitos registrados na ficha com o nível
 * atual e a descrição do nível, resolvidos pela biblioteca da campanha.
 * Somente consulta: nenhuma edição acontece aqui.
 *
 * Atualiza sozinho via `personagens:atualizados` (edição de ficha),
 * `regras:atualizadas` (renomear/descrição dos elementos) e
 * `campanha:restaurada` (snapshot/import substitui o estado inteiro —
 * sem os eventos de personagem/regras) — sempre rebuscando pela API,
 * que reaplica a autorização do mestre.
 */
export default function PainelDefeitos({ campaignId }: { campaignId: string }) {
  const [personagens, setPersonagens] = useState<PersonagemComDefeitos[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [recolhidos, setRecolhidos] = useState<Set<string>>(new Set());
  const [detalhesAbertos, setDetalhesAbertos] = useState<Set<string>>(new Set());

  const carregar = useCallback(async () => {
    try {
      const { personagens: lista } = await api.listarDefeitos(campaignId);
      setPersonagens(lista);
      setErro(null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar defeitos");
    }
  }, [campaignId]);

  useEffect(() => { void carregar(); }, [carregar]);
  useSincronizacaoCampanha(
    ["personagens:atualizados", "regras:atualizadas", "campanha:restaurada"],
    (evento, payload) => {
      // restauração é da campanha inteira: só rebusca se o evento for
      // desta campanha — sem campaignId ou de outra campanha não recarrega
      // (mesmo filtro estrito da Mesa)
      if (evento === "campanha:restaurada") {
        const cid = (payload as { campaignId?: string } | undefined)?.campaignId;
        if (cid !== campaignId) return;
      }
      void carregar();
    },
  );

  const alternarPersonagem = (id: string) => {
    setRecolhidos((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };
  const alternarDefeito = (id: string) => {
    setDetalhesAbertos((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };

  const jogadores = (personagens ?? []).filter((p) => !p.ehNpc);
  const npcs = (personagens ?? []).filter((p) => p.ehNpc);

  const blocoPersonagem = (p: PersonagemComDefeitos) => {
    const aberto = !recolhidos.has(p.id);
    return (
      <div key={p.id} className="defeito-personagem" data-personagem-id={p.id}>
        <button
          type="button"
          className="defeito-cabecalho"
          onClick={() => alternarPersonagem(p.id)}
          aria-expanded={aberto}
        >
          <strong>{p.nome}</strong>
          <span className="meta">{p.ehNpc ? "NPC" : `Jogador: ${p.jogador}`}</span>
          <span className="meta">{p.defeitos.length === 0 ? "sem defeitos" : `${p.defeitos.length} defeito${p.defeitos.length > 1 ? "s" : ""}`}</span>
        </button>
        {aberto && (
          <div className="defeito-lista">
            {p.defeitos.length === 0 && <p className="meta">Nenhum defeito registrado.</p>}
            {p.defeitos.map((d) => {
              const chave = `${p.id}:${d.kind}:${d.key}`;
              const detalheAberto = detalhesAbertos.has(chave);
              return (
                <div key={chave} className="defeito-item">
                  <button
                    type="button"
                    className="defeito-nome"
                    onClick={() => d.descricao && alternarDefeito(chave)}
                    aria-expanded={detalheAberto}
                    disabled={!d.descricao}
                  >
                    {d.nome}
                    <span className="badge">Nv. {d.nivel}</span>
                  </button>
                  {detalheAberto && d.descricao && (
                    <p className="meta defeito-descricao">{d.descricao}</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <section className="cartao">
      <h3>Defeitos dos personagens</h3>
      {erro && <p className="erro">{erro}</p>}
      {personagens === null && !erro && <p className="meta">Carregando…</p>}
      {personagens !== null && jogadores.length === 0 && npcs.length === 0 && (
        <p className="meta">Nenhum personagem ativo na campanha.</p>
      )}
      {jogadores.map(blocoPersonagem)}
      {npcs.length > 0 && (
        <>
          <h4 className="meta">NPCs</h4>
          {npcs.map(blocoPersonagem)}
        </>
      )}
    </section>
  );
}
