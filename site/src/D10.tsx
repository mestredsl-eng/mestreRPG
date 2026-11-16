import { useEffect, useRef, useState, type FormEvent } from "react";
import { getSocket } from "./socket";
import MesaDados3D, { seedDeId } from "./MesaDados3D";
import MesaDadosArea from "./MesaDadosArea";

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
  // mesma semente cobre tumble (ACK pendente) e assentamento oficial
  const [rodada, setRodada] = useState(0);
  // timeout do ACK: libera o botão e avisa se o servidor não responder
  const ackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (ackTimer.current) clearTimeout(ackTimer.current); }, []);

  const efetivos = Math.max(0, Math.min(positivos, MAX_DADOS) - negativos);
  // A legenda acompanha a última resposta autoritativa do servidor quando
  // a regra da campanha muda enquanto esta Mesa já está aberta.
  const minimoExibido = resultado?.minimo ?? minimoPadrao;

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
    const socket = getSocket();
    if (!socket.connected) {
      aoErro("Sem conexão com o servidor — aguardando reconexão. Tente novamente.");
      return;
    }
    setRodada((r) => r + 1);
    setRolando(true);
    ackTimer.current = setTimeout(() => {
      ackTimer.current = null;
      setRolando(false);
      aoErro("O servidor não respondeu à rolagem a tempo — verifique a conexão e tente novamente.");
    }, 15000);
    socket.emit("mesa:rolar", {
      sessionId,
      dados: [{ sides: 10, count: efetivos }],
      motivo: `D10 ${pos}${neg ? ` − ${neg} negativo${neg > 1 ? "s" : ""}` : ""}`,
      d10: { positivos: pos, negativos: neg, minimo: minimoPadrao },
      requestId: crypto.randomUUID(),
    }, (r: { ok?: boolean; erro?: string; id?: string; grupos?: { lados: number; resultados: number[] }[]; d10?: { sucessos: number; falhas: number; lancados: number; minimo?: number } }) => {
      if (ackTimer.current) { clearTimeout(ackTimer.current); ackTimer.current = null; }
      setRolando(false);
      if (!r?.ok) { aoErro(r?.erro ?? "Erro ao rolar D10"); return; }
      const res = r.grupos?.[0]?.resultados ?? [];
      // Mínimo autoritativo devolvido pelo servidor (campanha). Se a
      // regra mudou com a Mesa aberta, o ACK traz o valor vigente —
      // o painel local fica consistente com o histórico compartilhado.
      const minimoEfetivo = r.d10?.minimo ?? minimoPadrao;
      setResultado({
        id: r.id ?? `d10-${Date.now()}`,
        resultados: res,
        positivos: pos,
        negativos: neg,
        minimo: minimoEfetivo,
        sucessos: r.d10?.sucessos ?? res.filter((v) => v >= minimoEfetivo).length,
        falhas: r.d10?.falhas ?? res.filter((v) => v < minimoEfetivo).length,
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
          Efetivos: <strong>{efetivos}</strong> dado{efetivos === 1 ? "" : "s"} · sucesso ≥ {minimoExibido}
          {negativos > 0 && ` · ${negativos} negativo${negativos > 1 ? "s" : ""} consumido${negativos > 1 ? "s" : ""}`}
        </p>
        <button type="submit" disabled={rolando}>{rolando ? "Rolando…" : resultado ? "Lançar novamente" : "Lançar D10"}</button>
      </form>

      {/* Mesa de dados sempre visível: bandeja vazia, tumble real
          durante o ACK e assentamento nas faces oficiais do servidor
          (sucesso/falha por dado). Nenhum valor é sorteado no cliente. */}
      <MesaDadosArea ariaLabel="Mesa de dados D10">
        <MesaDados3D
          dados={rolando
            ? Array.from({ length: efetivos }, () => ({ lados: 10, valor: null }))
            : resultado
              ? resultado.resultados.map((valor) => ({
                  lados: 10,
                  valor,
                  estado: valor >= resultado.minimo ? "sucesso" as const : "falha" as const,
                }))
              : []}
          semente={seedDeId(`${sessionId}-d10-${rodada}`)}
        />
      </MesaDadosArea>

      {resultado && (
        <div className="d10-resultado">
          {resultado.resultados.length === 0 ? (
            <p className="meta">Nenhum dado efetivo para lançar.</p>
          ) : null}
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
