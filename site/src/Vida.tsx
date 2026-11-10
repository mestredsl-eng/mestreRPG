import { useEffect, useState } from "react";
import { api } from "./api";

/**
 * Pontos de Vida e Vitalidade — estado do personagem vindo de ficha.vida
 * (calculado no servidor a partir da config da campanha).
 */

type Vida = NonNullable<import("./api").PersonagemDetalhe["ficha"]>["vida"];

const TIPO_HP: Record<string, string> = {
  inicial: "HP inicial",
  dano: "Dano",
  recuperacao: "Recuperação",
  ajuste: "Ajuste",
};

function fmtData(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function Vida({ vidaInicial, characterId, aoErro }: {
  vidaInicial: Vida;
  characterId: string;
  aoErro?: (msg: string) => void;
}) {
  const [vida, setVida] = useState<Vida>(vidaInicial);
  const [qtd, setQtd] = useState("");
  const [motivo, setMotivo] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [historicoExpandido, setHistoricoExpandido] = useState(false);
  const [vitMotivo, setVitMotivo] = useState("");
  const [vitHistExpandido, setVitHistExpandido] = useState(false);

  useEffect(() => setVida(vidaInicial), [vidaInicial]);

  if (!vida || (!vida.hp && !vida.vitalidade)) return null;

  const hp = vida.hp;
  const vit = vida.vitalidade;
  const pct = hp ? Math.max(0, Math.min(100, (hp.atual / hp.maximo) * 100)) : 0;

  const agir = async (acao: "dano" | "recuperar" | "ajuste") => {
    const quantidade = Number(qtd);
    if (!Number.isFinite(quantidade) || (acao !== "ajuste" && quantidade <= 0) || (acao === "ajuste" && quantidade === 0)) {
      aoErro?.("Informe uma quantidade válida.");
      return;
    }
    setOcupado(true);
    try {
      const r = await api.alterarHp(characterId, { acao, quantidade, motivo: motivo || undefined });
      setVida((v) => (v ? { ...v, hp: r.hp } : v));
      setQtd(""); setMotivo("");
    } catch (e) {
      aoErro?.(e instanceof Error ? e.message : "Erro ao alterar HP");
    } finally {
      setOcupado(false);
    }
  };

  const mudarVitalidade = async (nivel: number) => {
    if (nivel === vit?.nivel || ocupado) return;
    setOcupado(true);
    try {
      const r = await api.alterarVitalidade(characterId, nivel, vitMotivo || undefined);
      setVida((v) => (v ? { ...v, vitalidade: r.vitalidade } : v));
      setVitMotivo("");
    } catch (e) {
      aoErro?.(e instanceof Error ? e.message : "Erro ao alterar vitalidade");
    } finally {
      setOcupado(false);
    }
  };

  return (
    <div className="vida-paineis">
      {hp && (
        <div className="vida-cartao">
          <h4>Pontos de Vida</h4>
          <div className="hp-resumo">
            <span className={`hp-atual ${hp.atual <= hp.maximo * 0.25 ? "critico" : ""}`}>
              {hp.atual}<small>/{hp.maximo}</small>
            </span>
            <div className="hp-barra" role="progressbar" aria-valuenow={hp.atual} aria-valuemin={0} aria-valuemax={hp.maximo}>
              <div className="hp-preenchimento" style={{ width: `${pct}%` }} />
            </div>
          </div>
          {vida.podeEditarHp && (
            <div className="hp-acoes">
              <input type="number" min="0" step="1" placeholder="Quantidade" value={qtd} onChange={(e) => setQtd(e.target.value)} />
              <input type="text" placeholder="Motivo (opcional)" value={motivo} onChange={(e) => setMotivo(e.target.value)} />
              <div className="linha">
                <button type="button" className="mini perigo" disabled={ocupado} onClick={() => void agir("dano")}>Dano</button>
                <button type="button" className="mini" disabled={ocupado} onClick={() => void agir("recuperar")}>Recuperar</button>
                <button type="button" className="mini secundario" disabled={ocupado} onClick={() => void agir("ajuste")}>Ajuste ±</button>
              </div>
            </div>
          )}
          <div className="hp-historico">
            {hp.historico.length > 0 && (
              <div className="linha" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <strong>Histórico ({hp.historico.length})</strong>
                {hp.historico.length > 8 && (
                  <button
                    type="button"
                    className="secundario mini"
                    aria-expanded={historicoExpandido}
                    onClick={() => setHistoricoExpandido((v) => !v)}
                  >
                    {historicoExpandido ? "Mostrar recentes" : "Ver histórico completo"}
                  </button>
                )}
              </div>
            )}
            {(historicoExpandido ? [...hp.historico].reverse() : [...hp.historico].reverse().slice(0, 8)).map((ev, i) => (
              <div key={i} className="hp-evento">
                <span className={`hp-qtd ${ev.quantidade < 0 ? "negativo" : ev.quantidade > 0 ? "positivo" : ""}`}>
                  {ev.quantidade > 0 ? "+" : ""}{ev.quantidade}
                </span>
                <span className="hp-tipo">{TIPO_HP[ev.tipo] ?? ev.tipo}</span>
                <span className="hp-motivo">{ev.motivo ?? ""}{ev.autorNome ? ` · ${ev.autorNome}` : ""}</span>
                <span className="hp-data">{fmtData(ev.em)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {vit && (
        <div className="vida-cartao">
          <h4>Vitalidade</h4>
          <p className="meta">
            Estado atual: <strong>{vit.nome}</strong>
            {vit.penalidadeDados > 0 && ` · −${vit.penalidadeDados} dado${vit.penalidadeDados > 1 ? "s" : ""} nas rolagens`}
            {vit.bloqueiaAcoes && " · bloqueia ações"}
          </p>
          <div className="vitalidade-escala" role={vida.podeEditarVitalidade ? "radiogroup" : undefined}>
            {vit.niveis.map((n) => {
              const atual = n.indice === vit.nivel;
              const conteudo = (
                <>
                  <span className="vit-nome">{n.nome}</span>
                  <span className="vit-penalidade">
                    {n.penalidadeDados > 0 ? `−${n.penalidadeDados}d` : n.bloqueiaAcoes ? "bloqueia" : "sem penalidade"}
                  </span>
                </>
              );
              return vida.podeEditarVitalidade ? (
                <button
                  key={n.indice}
                  type="button"
                  className={`vit-nivel ${atual ? "atual" : ""}`}
                  aria-pressed={atual}
                  disabled={ocupado}
                  onClick={() => void mudarVitalidade(n.indice)}
                >
                  {conteudo}
                </button>
              ) : (
                <div key={n.indice} className={`vit-nivel somente-leitura ${atual ? "atual" : ""}`}>{conteudo}</div>
              );
            })}
          </div>
          {vida.podeEditarVitalidade && (
            <div className="hp-acoes">
              <input type="text" placeholder="Motivo da mudança (opcional)" value={vitMotivo} onChange={(e) => setVitMotivo(e.target.value)} />
            </div>
          )}
          {vit.historico.length > 0 && (
            <div className="hp-historico">
              <div className="linha" style={{ justifyContent: "space-between", alignItems: "center" }}>
                <strong>Histórico ({vit.historico.length})</strong>
                {vit.historico.length > 8 && (
                  <button
                    type="button"
                    className="secundario mini"
                    aria-expanded={vitHistExpandido}
                    onClick={() => setVitHistExpandido((v) => !v)}
                  >
                    {vitHistExpandido ? "Mostrar recentes" : "Ver histórico completo"}
                  </button>
                )}
              </div>
              {(vitHistExpandido ? vit.historico : vit.historico.slice(-8)).slice().reverse().map((ev, i) => (
                <div key={i} className="hp-evento">
                  <span className="hp-tipo">{vit.niveis.find((n) => n.indice === ev.nivelAnterior)?.nome ?? ev.nivelAnterior} → {vit.niveis.find((n) => n.indice === ev.nivelNovo)?.nome ?? ev.nivelNovo}</span>
                  <span className="hp-motivo">{ev.motivo ?? ""}{ev.autorNome ? ` · ${ev.autorNome}` : ""}</span>
                  <span className="hp-data">{fmtData(ev.em)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
