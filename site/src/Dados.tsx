import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { api } from "./api";
import { getSocket } from "./socket";
import { tratarRateLimitSocket } from "./avisoRateLimit";
import LancadorD10 from "./D10";
import Dado3D from "./Dado3D";

// ---------- Preferências visuais de dados (por usuário, persistidas no servidor) ----------

export const DADOS_PADRAO = { corExterna: "#2b3350", corInterna: "#e8ecf7" };

/** Aplica as cores dos dados como variáveis CSS do documento.
 *  Cada navegador carrega as preferências do próprio usuário — o escopo
 *  por documento já garante que um jogador não altera a visão do outro. */
export function aplicarPrefsDados(prefs: { corExterna: string; corInterna: string }) {
  const r = document.documentElement.style;
  r.setProperty("--dado-fundo", prefs.corExterna);
  r.setProperty("--dado-texto", prefs.corInterna);
}

export function usePreferenciasDados() {
  const [prefs, setPrefs] = useState(DADOS_PADRAO);
  const [pronto, setPronto] = useState(false);
  useEffect(() => {
    let vivo = true;
    api.me()
      .then((r) => {
        const d = r.usuario.preferences?.dados;
        if (vivo && d?.corExterna && d?.corInterna) {
          const p = { corExterna: d.corExterna, corInterna: d.corInterna };
          setPrefs(p);
          aplicarPrefsDados(p);
        }
      })
      .catch(() => undefined)
      .finally(() => { if (vivo) setPronto(true); });
    return () => { vivo = false; };
  }, []);
  const salvar = async (corExterna: string, corInterna: string) => {
    const p = { corExterna, corInterna };
    setPrefs(p);
    aplicarPrefsDados(p);
    try { await api.atualizarPreferenciasDados(corExterna, corInterna); } catch { /* mantém local */ }
  };
  return { prefs, pronto, salvar };
}

// ---------- Tipos de dados disponíveis ----------

export const LADOS_DADOS = [4, 6, 8, 10, 20] as const;

interface FaceDadoProps {
  lados: number;
  valor: number;
  /** Índice do dado — escalona o fim da animação. */
  indice?: number;
  /** Estado visual pós-rolagem (sucesso/falha de teste D10). */
  estado?: "sucesso" | "falha" | null;
  className?: string;
}

/**
 * Face animada de dado com formato geométrico próprio por tipo (d4–d20).
 * As cores vêm das variáveis CSS --dado-fundo/--dado-texto definidas pelas
 * preferências do usuário — cada jogador vê os próprios dados.
 */
export function FaceDado({ lados, valor, indice = 0, estado, className }: FaceDadoProps) {
  return <Dado3D lados={lados} valor={valor} indice={indice} estado={estado} className={className} />;
}

// ---------- Seletor de cores com pré-visualização e contraste ----------

function luminancia(hex: string): number {
  const c = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  const f = (v: number) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function razaoContraste(a: string, b: string): number {
  const [l1, l2] = [luminancia(a), luminancia(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

function SeletorCores({ prefs, salvar }: {
  prefs: { corExterna: string; corInterna: string };
  salvar: (externa: string, interna: string) => void;
}) {
  const contraste = razaoContraste(prefs.corExterna, prefs.corInterna);
  const contrasteBaixo = contraste < 3;
  return (
    <div className="cores-dados">
      <div className="cores-dados-preview" style={{ "--dado-fundo": prefs.corExterna, "--dado-texto": prefs.corInterna } as CSSProperties}>
        {LADOS_DADOS.map((l) => <FaceDado key={l} lados={l} valor={l === 4 ? 3 : l === 20 ? 17 : Math.ceil(l / 2)} indice={0} />)}
      </div>
      <div className="cores-dados-controles">
        <label>
          Cor externa
          <input type="color" value={prefs.corExterna} onChange={(e) => salvar(e.target.value, prefs.corInterna)} />
        </label>
        <label>
          Cor dos números
          <input type="color" value={prefs.corInterna} onChange={(e) => salvar(prefs.corExterna, e.target.value)} />
        </label>
        <button type="button" className="secundario" onClick={() => salvar(DADOS_PADRAO.corExterna, DADOS_PADRAO.corInterna)}>
          Restaurar padrão
        </button>
      </div>
      <p className={`meta ${contrasteBaixo ? "cores-contraste-aviso" : ""}`}>
        Contraste: {contraste.toFixed(1)}:1{contrasteBaixo ? " — contraste baixo, os números podem ficar difíceis de ler" : ""}
      </p>
    </div>
  );
}

// ---------- Rolagem livre e dano (d4–d20, sem contagem de sucessos) ----------

interface ResultadoLivre {
  id: string;
  grupos: { lados: number; resultados: number[] }[];
  total: number;
  modo?: string | null;
  ts: number;
}

function RolagemDados({ sessionId, aoErro, souMestre }: {
  sessionId: string; aoErro: (e: string | null) => void; souMestre: boolean;
}) {
  const [lados, setLados] = useState(20);
  const [qtd, setQtd] = useState(1);
  const [modo, setModo] = useState<"rolagem" | "dano">("rolagem");
  const [motivo, setMotivo] = useState("");
  const [privado, setPrivado] = useState(false);
  const [resultado, setResultado] = useState<ResultadoLivre | null>(null);
  const [rolando, setRolando] = useState(false);

  const lancar = (e?: FormEvent) => {
    e?.preventDefault();
    if (rolando) return;
    const count = Math.max(1, Math.min(30, Math.round(qtd) || 1));
    setRolando(true);
    getSocket().emit("mesa:rolar", {
      sessionId,
      dados: [{ sides: lados, count }],
      motivo: motivo || (modo === "dano" ? "Dano" : undefined),
      modo: modo === "dano" ? "dano" : undefined,
      visibilidade: privado ? "privada" : "publica",
      requestId: crypto.randomUUID(),
    }, (r: { ok?: boolean; erro?: string; codigo?: string; retryAfterMs?: number; id?: string; grupos?: { lados?: number; sides?: number; resultados: number[] }[]; total?: number; modo?: string }) => {
      setRolando(false);
      if (!r?.ok) { if (!tratarRateLimitSocket(r, "rolagem", aoErro)) aoErro(r?.erro ?? "Erro ao rolar"); return; }
      setResultado({
        id: r.id ?? `rol-${Date.now()}`,
        grupos: (r.grupos ?? [{ lados, resultados: [] }]).map((g) => ({ lados: g.lados ?? g.sides ?? 20, resultados: g.resultados })),
        total: r.total ?? 0,
        modo: r.modo ?? (modo === "dano" ? "dano" : null),
        ts: Date.now(),
      });
      setMotivo("");
    });
  };

  return (
    <section className="cartao">
      <h3>Rolagem livre e dano</h3>
      <form className="rolagem-form" onSubmit={lancar}>
        <div className="rolagem-controles">
          <label>
            Dados
            <select value={lados} onChange={(e) => setLados(Number(e.target.value))}>
              {LADOS_DADOS.map((l) => <option key={l} value={l}>d{l}</option>)}
            </select>
          </label>
          <label>
            Quantidade
            <input type="number" min="1" max="30" value={qtd} onChange={(e) => setQtd(Number(e.target.value))} />
          </label>
          <label>
            Finalidade
            <select value={modo} onChange={(e) => setModo(e.target.value as "rolagem" | "dano")}>
              <option value="rolagem">Rolagem</option>
              <option value="dano">Dano</option>
            </select>
          </label>
        </div>
        <div className="linha">
          <input placeholder={modo === "dano" ? "Motivo do dano (ex.: espada)" : "Motivo (opcional)"} value={motivo} onChange={(e) => setMotivo(e.target.value)} />
          {souMestre && <label className="check"><input type="checkbox" checked={privado} onChange={(e) => setPrivado(e.target.checked)} /> Privada</label>}
          <button type="submit" disabled={rolando}>{rolando ? "Rolando…" : resultado ? "Lançar novamente" : "Lançar"}</button>
        </div>
      </form>

      {resultado && (
        <div className="rolagem-resultado">
          {resultado.grupos.map((g, gi) => (
            <div key={gi} className="dados-grupo">
              {g.resultados.map((v, i) => <FaceDado key={`${resultado.id}-${gi}-${i}`} lados={g.lados} valor={v} indice={i} />)}
            </div>
          ))}
          <div className="d10-resumo">
            {resultado.modo === "dano" && <span className="d10-chip d10-chip-neg">Dano</span>}
            <span className="d10-chip">{resultado.grupos.reduce((s, g) => s + g.resultados.length, 0)} dado{resultado.grupos.reduce((s, g) => s + g.resultados.length, 0) === 1 ? "" : "s"}</span>
            <span className="d10-chip d10-chip-total">{resultado.modo === "dano" ? "Dano total" : "Total"}: {resultado.total}</span>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------- Painel unificado: Testes D10 | Rolagem livre e dano ----------

export default function PainelDados({ sessionId, aoErro, minimoPadrao, souMestre }: {
  sessionId: string; aoErro: (e: string | null) => void; minimoPadrao: number; souMestre: boolean;
}) {
  const [aba, setAba] = useState<"d10" | "livre">("d10");
  const { prefs, salvar } = usePreferenciasDados();
  return (
    <div className="painel-dados">
      <div className="abas-dados" role="tablist">
        <button type="button" role="tab" aria-selected={aba === "d10"} className={aba === "d10" ? "ativo" : ""} onClick={() => setAba("d10")}>Testes D10</button>
        <button type="button" role="tab" aria-selected={aba === "livre"} className={aba === "livre" ? "ativo" : ""} onClick={() => setAba("livre")}>Rolagem e dano</button>
      </div>
      {aba === "d10"
        ? <LancadorD10 sessionId={sessionId} aoErro={aoErro} minimoPadrao={minimoPadrao} />
        : <RolagemDados sessionId={sessionId} aoErro={aoErro} souMestre={souMestre} />}
      <section className="cartao cores-cartao">
        <h3>Aparência dos dados</h3>
        <SeletorCores prefs={prefs} salvar={salvar} />
      </section>
    </div>
  );
}
