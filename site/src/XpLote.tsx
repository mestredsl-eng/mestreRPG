import { useMemo, useState } from "react";
import { Modal } from "./Modal";
import { apiProgressao, ApiErrorProgresso } from "./api-progressao";
import type { PersonagemResumo } from "./api";
import "./xp-lote.css";

interface ResultadoItem { characterId: string; quantidade: number; saldoResultante: number }

export interface OperacaoXpLote { hash: string; requestId: string }

/**
 * Concessão de XP em lote (Issue #185 item 3) — somente mestre.
 *
 * Fluxo: seleção de personagens ativos → XP individual + motivo →
 * revisão com totais → confirmação → POST /campaigns/:id/xp-lote.
 * O requestId é estável para a MESMA operação: gerado na primeira
 * tentativa e preservado em retries de rede; qualquer edição do
 * payload gera um novo ID (nova operação). Duplo clique é bloqueado
 * por `enviando` + `ocupado` no Modal.
 */
export default function XpLote({ campaignId, personagens, nomes, operacaoRef, aoFechar }: {
  campaignId: string;
  personagens: PersonagemResumo[];
  nomes: Map<string, string>;
  operacaoRef: { current: OperacaoXpLote | null };
  aoFechar: () => void;
}) {
  // Apenas personagens NÃO arquivados são elegíveis — arquivado é
  // rejeitado pelo backend e nem deve aparecer como opção.
  const elegiveis = useMemo(() => personagens.filter((p) => p.status !== "arquivado"), [personagens]);
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const [itens, setItens] = useState<Record<string, string>>({});
  const [motivo, setMotivo] = useState("");
  const [etapa, setEtapa] = useState<"editar" | "confirmar" | "resultado">("editar");
  const [resultado, setResultado] = useState<{ itens: ResultadoItem[]; totalXp: number; repetido: boolean } | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [erroCampo, setErroCampo] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  // A intenção vive no componente pai, que não desmonta quando o modal
  // fecha. Assim um ACK perdido não apaga o requestId da operação.
  const operacao = operacaoRef;

  const qtdDe = (id: string) => {
    const n = Number.parseInt(itens[id] ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const itensValidos = [...selecionados].map((characterId) => ({ characterId, quantidade: qtdDe(characterId) }));
  const todosValidos = itensValidos.length > 0 && itensValidos.every((i) => i.quantidade !== null);
  const totalXp = itensValidos.reduce((s, i) => s + (i.quantidade ?? 0), 0);

  const alternar = (id: string) => {
    setSelecionados((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
    setErro(null); setErroCampo(null);
  };
  const selecionarTodos = () => {
    setSelecionados(new Set(elegiveis.map((p) => p.id)));
    setItens((m) => {
      const n = { ...m };
      for (const p of elegiveis) if (!(p.id in n)) n[p.id] = "10";
      return n;
    });
  };

  const payloadHash = () => JSON.stringify({
    campaignId,
    motivo: motivo.trim(),
    itens: itensValidos.map((i) => [i.characterId, i.quantidade]).sort(),
  });
  const requestIdPara = () => {
    const hash = payloadHash();
    if (!operacao.current || operacao.current.hash !== hash) {
      operacao.current = { hash, requestId: crypto.randomUUID() };
    }
    return operacao.current.requestId;
  };

  const submeter = async () => {
    if (enviando || !todosValidos || !motivo.trim()) return;
    setEnviando(true);
    setErro(null);
    setErroCampo(null);
    try {
      const r = await apiProgressao.concederXpLote(campaignId, {
        requestId: requestIdPara(),
        motivo: motivo.trim(),
        itens: itensValidos.map((i) => ({ characterId: i.characterId, quantidade: i.quantidade! })),
      });
      setResultado({ itens: r.itens, totalXp: r.lote.totalXp, repetido: r.repetido });
      setEtapa("resultado");
      operacao.current = null; // operação concluída — próxima é nova
    } catch (e) {
      const api = e instanceof ApiErrorProgresso ? e : null;
      const msg = api?.message ?? (e instanceof Error ? e.message : "Falha ao conceder XP");
      setErro(msg);
      // Qualquer erro é potencialmente ambíguo: preserve a intenção.
      // Se o payload mudar, requestIdPara gera uma nova operação por hash.
      if (api?.characterId) setErroCampo(api.characterId);
      // 400/403/404/409: permanece na etapa de confirmação? Não — volta à
      // edição para o mestre revisar/corrigir (sem sucesso falso).
      setEtapa("editar");
    } finally {
      setEnviando(false);
    }
  };

  const nomeDe = (id: string) => nomes.get(id) ?? id;

  return (
    <Modal
      titulo={etapa === "resultado" ? "XP concedido" : etapa === "confirmar" ? "Confirmar concessão de XP" : "Conceder XP em lote"}
      aoFechar={() => { if (!enviando) aoFechar(); }}
      ocupado={enviando}
    >
      {etapa === "editar" && (
        <>
          <p className="meta">Concessão de XP para vários personagens da campanha. Arquivados não são elegíveis.</p>
          <div className="linha">
            <button type="button" className="secundario" onClick={selecionarTodos}>Selecionar todos</button>
            <button type="button" className="secundario" onClick={() => { setSelecionados(new Set()); setItens({}); }}>Limpar</button>
          </div>
          <div className="xp-lote-lista">
            {elegiveis.map((p) => (
              <div key={p.id} className={`xp-lote-item${selecionados.has(p.id) ? " selecionado" : ""}${erroCampo === p.id ? " erro-campo" : ""}`}>
                <label className="check">
                  <input type="checkbox" checked={selecionados.has(p.id)} onChange={() => alternar(p.id)} />
                  <span>{p.name}{p.isNpc ? " (NPC)" : ""}</span>
                </label>
                {selecionados.has(p.id) && (
                  <label className="xp-lote-qtd">XP
                    <input
                      type="number" min={1} max={1000000} step={1}
                      value={itens[p.id] ?? ""}
                      onChange={(e) => { setItens((m) => ({ ...m, [p.id]: e.target.value })); setErro(null); }}
                      aria-label={`Quantidade de XP para ${p.name}`}
                    />
                  </label>
                )}
              </div>
            ))}
          </div>
          <label>Motivo (obrigatório, fica na auditoria)
            <input aria-label="Motivo da concessão" value={motivo} onChange={(e) => { setMotivo(e.target.value); setErro(null); }} maxLength={300} placeholder="Ex.: XP da sessão 3" />
          </label>
          {erro && <p className="erro">{erro}</p>}
          <div className="linha">
            <button
              type="button"
              disabled={!todosValidos || !motivo.trim()}
              onClick={() => setEtapa("confirmar")}
            >
              Revisar e confirmar
            </button>
            <button type="button" className="secundario" onClick={aoFechar}>Cancelar</button>
          </div>
        </>
      )}

      {etapa === "confirmar" && (
        <>
          <p>Revise antes de conceder — a operação é <strong>tudo-ou-nada</strong>:</p>
          <ul className="xp-lote-resumo">
            {itensValidos.map((i) => (
              <li key={i.characterId}>
                {nomeDe(i.characterId)} — <strong>{i.quantidade} XP</strong>
              </li>
            ))}
          </ul>
          <p className="meta">
            {itensValidos.length} personagem(ns) · <strong>{totalXp} XP no total</strong> · motivo: “{motivo.trim()}”
          </p>
          {erro && <p className="erro">{erro}</p>}
          <div className="linha">
            <button type="button" disabled={enviando} onClick={() => void submeter()}>
              {enviando ? "Concedendo…" : "Confirmar concessão"}
            </button>
            <button type="button" className="secundario" disabled={enviando} onClick={() => { setErro(null); setEtapa("editar"); }}>
              Voltar
            </button>
          </div>
        </>
      )}

      {etapa === "resultado" && resultado && (
        <>
          {resultado.repetido && <p className="meta">Esta operação já havia sido registrada (retry idempotente) — nenhum XP foi duplicado.</p>}
          <ul className="xp-lote-resumo">
            {resultado.itens.map((i) => (
              <li key={i.characterId}>
                {nomeDe(i.characterId)} — +{i.quantidade} XP · saldo {i.saldoResultante}
              </li>
            ))}
          </ul>
          <p className="meta"><strong>{resultado.totalXp} XP</strong> distribuídos em {resultado.itens.length} personagem(ns).</p>
          <div className="linha">
            <button type="button" onClick={aoFechar}>Fechar</button>
          </div>
        </>
      )}
    </Modal>
  );
}
