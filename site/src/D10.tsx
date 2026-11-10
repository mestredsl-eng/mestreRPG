import { useState, type FormEvent } from "react";
import { getSocket } from "./socket";
import { FaceDado } from "./Dados";

interface Props {
  sessionId: string;
  aoErro: (e: string | null) => void;
  /** Meta de sucesso configurada pela campanha (regras.dados.d10SucessoMinimo). */
  minimoPadrao: number;
}

interface ResultadoD10 {
  id: string;
  resultados: number[];
  positivos: number;
  negativos: number;
  minimo: number;
  sucessos: number;
  falhas: number;
  ts: number;
}

const MAX_DADOS = 30;

/** D10 animado: apresenta o valor final autoritativo recebido do servidor. */
function D10Face({ valor, indice, minimo }: { valor: number; indice: number; minimo: number }) {
  return (
    <FaceDado
      lados={10}
      valor={valor}
      indice={indice}
      estado={valor >= minimo ? "sucesso" : "falha"}
      className="d10-face"
    />
  );
}

/**
 * Lançador de dados D10 — pool com dados negativos.
 * Os dados rolam no servidor (mesa:rolar), então o resultado entra no
 * chat, no histórico de rolagens e fica visível para a mesa.
 */
export default function LancadorD10({ sessionId, aoErro, minimoPadrao }: Props) {
  const [positivos, setPositivos] = useState(5);
  const [negativos, setNegativos] = useState(0);
  const [resultado, setResultado] = useState<ResultadoD10 | null>(null);
  const [rolando, setRolando] = useState(false);

  const efetivos = Math.max(0, Math.min(positivos, MAX_DADOS) - negativos);

  const lancar = (e?: FormEvent) => {
    e?.preventDefault();
    if (rolando) return;
    const pos = Math.max(0, Math.min(MAX_DADOS, Math.round(positivos) || 0));
    const neg = Math.max(0, Math.min(MAX_DADOS, Math.round(negativos) || 0));
    if (efetivos <= 0) {
      // Nenhum dado efetivo: registra só localmente (não há o que rolar).
      setResultado({ id: `local-${Date.now()}`, resultados: [], positivos: pos, negativos: neg, minimo: minimoPadrao, sucessos: 0, falhas: 0, ts: Date.now() });
      return;
    }
    setRolando(true);
    getSocket().emit("mesa:rolar", {
      sessionId,
      dados: [{ sides: 10, count: efetivos }],
      motivo: `D10 ${pos}${neg ? ` − ${neg} negativo${neg > 1 ? "s" : ""}` : ""}`,
      d10: { positivos: pos, negativos: neg, minimo: minimoPadrao },
      requestId: crypto.randomUUID(),
    }, (r: { ok?: boolean; erro?: string; id?: string; grupos?: { lados: number; resultados: number[] }[]; d10?: { sucessos: number; falhas: number; lancados: number } }) => {
      setRolando(false);
      if (!r?.ok) { aoErro(r?.erro ?? "Erro ao rolar D10"); return; }
      const res = r.grupos?.[0]?.resultados ?? [];
      setResultado({
        id: r.id ?? `d10-${Date.now()}`,
        resultados: res,
        positivos: pos,
        negativos: neg,
        minimo: minimoPadrao,
        sucessos: r.d10?.sucessos ?? res.filter((v) => v >= minimoPadrao).length,
        falhas: r.d10?.falhas ?? res.filter((v) => v < minimoPadrao).length,
        ts: Date.now(),
      });
    });
  };

  return (
    <section className="cartao">
      <h3>Lançador D10</h3>
      <form className="d10-form" onSubmit={lancar}>
        <div className="d10-controles">
          <label>
            Dados positivos
            <input type="number" min="0" max={MAX_DADOS} value={positivos}
              onChange={(e) => setPositivos(Number(e.target.value))} />
          </label>
          <label>
            Dados negativos
            <input type="number" min="0" max={MAX_DADOS} value={negativos}
              onChange={(e) => setNegativos(Number(e.target.value))} />
          </label>
        </div>
        <p className="meta">
          Efetivos: <strong>{efetivos}</strong> dado{efetivos === 1 ? "" : "s"} · sucesso ≥ {minimoPadrao}
          {negativos > 0 && ` · ${negativos} negativo${negativos > 1 ? "s" : ""} consumido${negativos > 1 ? "s" : ""}`}
        </p>
        <button type="submit" disabled={rolando}>{rolando ? "Rolando…" : resultado ? "Lançar novamente" : "Lançar D10"}</button>
      </form>

      {resultado && (
        <div className="d10-resultado">
          {resultado.resultados.length === 0 ? (
            <p className="meta">Nenhum dado efetivo para lançar.</p>
          ) : (
            <div className="d10-dados">
              {resultado.resultados.map((v, i) => (
                <D10Face key={`${resultado.id}-${i}`} valor={v} indice={i} minimo={resultado.minimo} />
              ))}
            </div>
          )}
          <div className="d10-resumo">
            <span className="d10-chip">Lançados: {resultado.resultados.length}</span>
            <span className="d10-chip d10-chip-ok">Sucessos: {resultado.sucessos}</span>
            <span className="d10-chip d10-chip-fail">Falhas: {resultado.falhas}</span>
            {resultado.negativos > 0 && <span className="d10-chip d10-chip-neg">Negativos: {resultado.negativos}</span>}
            <span className="d10-chip d10-chip-total">Resultado: {resultado.sucessos} sucesso{resultado.sucessos === 1 ? "" : "s"}</span>
          </div>
          <p className="meta">
            {resultado.positivos} positivo{resultado.positivos === 1 ? "" : "s"}
            {resultado.negativos ? ` − ${resultado.negativos} negativo${resultado.negativos === 1 ? "" : "s"}` : ""}
            {" · "}{new Date(resultado.ts).toLocaleTimeString("pt-BR")}
          </p>
        </div>
      )}
    </section>
  );
}
