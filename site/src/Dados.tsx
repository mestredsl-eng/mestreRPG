import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { api } from "./api";
import { getSocket } from "./socket";
import LancadorD10 from "./D10";
import Dado3D from "./Dado3D";
import type { ItemDadoMesa } from "./MesaDados3D";
import { TEMAS_MESA, TEMAS_MESA_IDS, TEMA_MESA_PADRAO, aplicarTemaMesa, ehTemaMesa, type TemaMesaId } from "./temasMesa";

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

export interface VisibilidadeMesa {
  aparencia: boolean;
  bandeja: boolean;
  rolagens: boolean;
}

export const VISIBILIDADE_PADRAO: VisibilidadeMesa = { aparencia: true, bandeja: true, rolagens: true };

export function usePreferenciasDados() {
  const [prefs, setPrefs] = useState(DADOS_PADRAO);
  const [temaMesa, setTemaMesa] = useState<TemaMesaId>(TEMA_MESA_PADRAO);
  const [visibilidade, setVisibilidade] = useState<VisibilidadeMesa>(VISIBILIDADE_PADRAO);
  const [pronto, setPronto] = useState(false);
  useEffect(() => {
    let vivo = true;
    api.me()
      .then((r) => {
        const p = r.usuario.preferences;
        const d = p?.dados;
        if (vivo && d?.corExterna && d?.corInterna) {
          const cores = { corExterna: d.corExterna, corInterna: d.corInterna };
          setPrefs(cores);
          aplicarPrefsDados(cores);
        }
        // Contas antigas sem temaMesa (ou com valor inválido) caem no
        // tema padrão — o JSON de preferências não exige migration.
        const tema = ehTemaMesa(p?.temaMesa) ? p.temaMesa : TEMA_MESA_PADRAO;
        if (vivo) { setTemaMesa(tema); aplicarTemaMesa(tema); }
        // Contas antigas sem visibilidade → tudo visível (Issue #147).
        const v = p?.visibilidade;
        if (vivo && v && typeof v === "object") {
          setVisibilidade({
            aparencia: v.aparencia !== false,
            bandeja: v.bandeja !== false,
            rolagens: v.rolagens !== false,
          });
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
  const salvarTema = async (tema: TemaMesaId) => {
    setTemaMesa(tema);
    aplicarTemaMesa(tema);
    try { await api.atualizarTemaMesa(tema); } catch { /* mantém local */ }
  };
  const salvarVisibilidade = async (parcial: Partial<VisibilidadeMesa>) => {
    const v = { ...visibilidade, ...parcial };
    setVisibilidade(v);
    try { await api.atualizarVisibilidadeMesa(v); } catch { /* mantém local */ }
  };
  return { prefs, temaMesa, visibilidade, pronto, salvar, salvarTema, salvarVisibilidade };
}

export type PreferenciasDados = ReturnType<typeof usePreferenciasDados>;

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

// ---------- Seletor de tema da bandeja (independente das cores dos dados) ----------

function SeletorTemaMesa({ tema, salvar }: { tema: TemaMesaId; salvar: (t: TemaMesaId) => void }) {
  return (
    <div className="temas-mesa">
      {TEMAS_MESA_IDS.map((id) => {
        const t = TEMAS_MESA[id];
        const selecionado = tema === id;
        return (
          <button
            key={id}
            type="button"
            className={`tema-mesa-card${selecionado ? " selecionado" : ""}`}
            aria-pressed={selecionado}
            onClick={() => salvar(id)}
          >
            <span
              className="tema-mesa-previa"
              style={{
                background: `linear-gradient(135deg, ${t.previa.claro}, ${t.previa.escuro})`,
                borderColor: t.previa.borda,
              }}
              aria-hidden="true"
            />
            <span className="tema-mesa-nome">{t.nome}</span>
            <span className="tema-mesa-desc">{t.descricao}</span>
          </button>
        );
      })}
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


function RolagemDados({ sessionId, aoErro, souMestre, aoPendencia }: {
  sessionId: string; aoErro: (e: string | null) => void; souMestre: boolean;
  aoPendencia?: (dados: ItemDadoMesa[] | null, requestId: string) => void;
}) {
  const [lados, setLados] = useState(20);
  const [qtd, setQtd] = useState(1);
  const [modo, setModo] = useState<"rolagem" | "dano">("rolagem");
  const [motivo, setMotivo] = useState("");
  const [privado, setPrivado] = useState(false);
  const [resultado, setResultado] = useState<ResultadoLivre | null>(null);
  const [rolando, setRolando] = useState(false);
  // timeout do ACK: sem resposta do servidor em 15s, libera o botão e
  // avisa — nunca deixa "Rolando…" eterno quando o socket cai
  const ackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (ackTimer.current) clearTimeout(ackTimer.current); }, []);

  const lancar = (e?: FormEvent) => {
    e?.preventDefault();
    if (rolando) return;
    const socket = getSocket();
    if (!socket.connected) {
      aoErro("Sem conexão com o servidor — aguardando reconexão. Tente novamente.");
      return;
    }
    const count = Math.max(1, Math.min(30, Math.round(qtd) || 1));
    const requestId = crypto.randomUUID();
    setRolando(true);
    // Tumble otimista no tabuleiro compartilhado da Mesa (Issue #147).
    aoPendencia?.(
      Array.from({ length: count }, () => ({ lados, valor: null })),
      requestId,
    );
    ackTimer.current = setTimeout(() => {
      ackTimer.current = null;
      setRolando(false);
      aoPendencia?.(null, requestId);
      aoErro("O servidor não respondeu à rolagem a tempo — verifique a conexão e tente novamente.");
    }, 15000);
    socket.emit("mesa:rolar", {
      sessionId,
      dados: [{ sides: lados, count }],
      motivo: motivo || (modo === "dano" ? "Dano" : undefined),
      modo: modo === "dano" ? "dano" : undefined,
      visibilidade: privado ? "privada" : "publica",
      requestId,
    }, (r: { ok?: boolean; erro?: string; id?: string; grupos?: { lados?: number; sides?: number; resultados: number[] }[]; total?: number; modo?: string }) => {
      if (ackTimer.current) { clearTimeout(ackTimer.current); ackTimer.current = null; }
      setRolando(false);
      aoPendencia?.(null, requestId);
      if (!r?.ok) { aoErro(r?.erro ?? "Erro ao rolar"); return; }
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

const OPCOES_VISIBILIDADE: { chave: keyof VisibilidadeMesa; rotulo: string; descricao: string }[] = [
  { chave: "aparencia", rotulo: "Aparência dos dados", descricao: "cores e pré-visualização dos dados" },
  { chave: "bandeja", rotulo: "Bandeja da mesa", descricao: "tabuleiro 3D compartilhado e tema da bandeja" },
  { chave: "rolagens", rotulo: "Rolagens", descricao: "histórico de rolagens da mesa" },
];

/** Cartão "Exibição" — preferências individuais de visibilidade.
 *  Separado dos lançadores para que espectadores (que não veem o
 *  PainelDados) também possam ajustar as próprias preferências
 *  (auditoria #149). Os toggles sempre ficam visíveis: esconder uma
 *  seção nunca impede de reexibi-la, e nada aqui afeta outros usuários. */
export function CartaoExibicao({ prefsDados }: { prefsDados: PreferenciasDados }) {
  const { visibilidade, salvarVisibilidade } = prefsDados;
  return (
    <section className="cartao cores-cartao">
      <h3>Exibição</h3>
      <div className="visibilidade-mesa">
        {OPCOES_VISIBILIDADE.map((op) => (
          <label key={op.chave} className="check">
            <input
              type="checkbox"
              checked={visibilidade[op.chave]}
              onChange={(e) => void salvarVisibilidade({ [op.chave]: e.target.checked })}
            />
            <span>
              <strong>{op.rotulo}</strong>
              <span className="meta"> — {op.descricao}</span>
            </span>
          </label>
        ))}
      </div>
    </section>
  );
}

export default function PainelDados({ sessionId, aoErro, minimoPadrao, souMestre, prefsDados, aoPendencia }: {
  sessionId: string; aoErro: (e: string | null) => void; minimoPadrao: number; souMestre: boolean;
  prefsDados: PreferenciasDados;
  aoPendencia?: (dados: ItemDadoMesa[] | null, requestId: string) => void;
}) {
  const [aba, setAba] = useState<"d10" | "livre">("d10");
  const { prefs, temaMesa, visibilidade, salvar, salvarTema } = prefsDados;
  return (
    <div className="painel-dados">
      <div className="abas-dados" role="tablist">
        <button type="button" role="tab" aria-selected={aba === "d10"} className={aba === "d10" ? "ativo" : ""} onClick={() => setAba("d10")}>Testes D10</button>
        <button type="button" role="tab" aria-selected={aba === "livre"} className={aba === "livre" ? "ativo" : ""} onClick={() => setAba("livre")}>Rolagem e dano</button>
      </div>
      {aba === "d10"
        ? <LancadorD10 sessionId={sessionId} aoErro={aoErro} minimoPadrao={minimoPadrao} aoPendencia={aoPendencia} />
        : <RolagemDados sessionId={sessionId} aoErro={aoErro} souMestre={souMestre} aoPendencia={aoPendencia} />}
      {/* Exibição: toggles sempre visíveis — esconder uma seção nunca
          impede de reexibi-la (Issue #147). Só afeta a apresentação
          do próprio usuário; rolagens e resultados seguem íntegros. */}
      <CartaoExibicao prefsDados={prefsDados} />
      {visibilidade.aparencia && (
        <section className="cartao cores-cartao">
          <h3>Aparência dos dados</h3>
          <SeletorCores prefs={prefs} salvar={salvar} />
        </section>
      )}
      {visibilidade.bandeja && (
        <section className="cartao cores-cartao">
          <h3>Bandeja da mesa</h3>
          <SeletorTemaMesa tema={temaMesa} salvar={salvarTema} />
        </section>
      )}
    </div>
  );
}
