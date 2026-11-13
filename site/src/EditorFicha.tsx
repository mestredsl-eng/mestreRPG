import { useMemo, useState } from "react";
import type { CampoDef, ElementoVinculavel, EstruturaFicha, SecaoDef, TipoCampo } from "./api";
import FichaForm from "./FichaForm";

const TIPOS: { v: TipoCampo; l: string }[] = [
  { v: "texto", l: "Texto curto" },
  { v: "texto_longo", l: "Texto longo" },
  { v: "inteiro", l: "Número inteiro" },
  { v: "decimal", l: "Número decimal" },
  { v: "moeda", l: "Valor monetário" },
  { v: "data", l: "Data" },
  { v: "checkbox", l: "Caixa de seleção" },
  { v: "selecao_unica", l: "Seleção única" },
  { v: "selecao_multipla", l: "Múltipla escolha" },
  { v: "selecao_nivel", l: "Seleção com níveis (biblioteca)" },
  { v: "lista", l: "Lista de opções" },
  { v: "tabela", l: "Registros (tabela)" },
  { v: "calculado", l: "Campo calculado" },
  { v: "referencia", l: "Referência a campo" },
];

const SEMANTICOS: { v: string; l: string }[] = [
  { v: "livre", l: "Livre" },
  { v: "atributo", l: "Atributo" },
  { v: "habilidade", l: "Habilidade" },
  { v: "conhecimento", l: "Conhecimento" },
  { v: "profissao", l: "Profissão" },
  { v: "especializacao", l: "Especialização" },
  { v: "poder", l: "Poder" },
  { v: "vantagem", l: "Vantagem" },
  { v: "defeito", l: "Defeito" },
  { v: "talento", l: "Talento" },
  { v: "moeda", l: "Moeda/Dinheiro" },
  { v: "item", l: "Item/Inventário" },
];

const VISIBILIDADES = [
  ["todos", "Todos da campanha"],
  ["dono_mestre", "Dono e mestre"],
  ["mestre", "Somente mestre"],
  ["selecionados", "Jogadores selecionados"],
];
const EDITAVEIS = [
  ["ambos", "Dono e mestre"],
  ["jogador", "Somente o dono"],
  ["mestre", "Somente o mestre"],
];

const novoId = () => crypto.randomUUID().slice(0, 8);

function custosTexto(custos: Record<string, number[]>): string {
  return Object.entries(custos ?? {}).map(([k, v]) => `${k}: ${v.join(",")}`).join("\n");
}

function parseCustos(texto: string): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const linha of texto.split("\n")) {
    const m = linha.match(/^\s*([a-zA-Z_]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const vals = m[2].split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    if (vals.length) out[m[1]] = vals;
  }
  return out;
}

function campoVazio(tipo: TipoCampo): CampoDef {
  return {
    id: novoId(),
    label: "Novo campo",
    tipo,
    semantico: "livre",
    obrigatorio: false,
    repetivel: false,
    visibilidade: "todos",
    editavelPor: "ambos",
    usadoEmTestes: false,
  };
}

interface Vinculaveis {
  kinds: string[];
  elementos: Record<string, ElementoVinculavel[]>;
}

interface Props {
  inicial: EstruturaFicha;
  aoMudar: (e: EstruturaFicha) => void;
  /** Biblioteca de regras da campanha (Etapa 5) — permite vincular campos a elementos. */
  vinculaveis?: Vinculaveis;
  /** Campanha da ficha — habilita o simulador interativo da prévia. */
  campaignId?: string;
}

const ROTULO_KIND: Record<string, string> = {
  atributo: "Atributo", talento: "Talento", habilidade: "Habilidade", conhecimento: "Conhecimento",
  profissao: "Profissão", especializacao: "Especialização", vantagem: "Vantagem", defeito: "Defeito",
  poder: "Poder", disciplina: "Disciplina", pericia: "Perícia", caracteristica: "Característica",
};

export default function EditorFicha({ inicial, aoMudar, vinculaveis, campaignId }: Props) {
  const [estrutura, setEstrutura] = useState<EstruturaFicha>(inicial);
  const [aba, setAba] = useState<"editar" | "previa">("editar");
  const [secaoEditando, setSecaoEditando] = useState<string | null>(null);
  const [campoEditando, setCampoEditando] = useState<{ secaoId: string; campoId: string } | null>(null);

  const commit = (nova: EstruturaFicha) => {
    setEstrutura(nova);
    aoMudar(nova);
  };

  const mover = (lista: SecaoDef[], de: number, para: number) => {
    const copia = [...lista];
    const [item] = copia.splice(de, 1);
    copia.splice(para, 0, item);
    return copia.map((s, i) => ({ ...s, ordem: i }));
  };

  const atualizarSecao = (secaoId: string, patch: Partial<SecaoDef>) => {
    commit({ ...estrutura, secoes: estrutura.secoes.map((s) => (s.id === secaoId ? { ...s, ...patch } : s)) });
  };

  const atualizarCampo = (secaoId: string, campoId: string, patch: Partial<CampoDef>) => {
    commit({
      ...estrutura,
      secoes: estrutura.secoes.map((s) =>
        s.id === secaoId ? { ...s, campos: s.campos.map((c) => (c.id === campoId ? { ...c, ...patch } : c)) } : s
      ),
    });
  };

  const adicionarSecao = () => {
    const id = novoId();
    commit({
      ...estrutura,
      secoes: [...estrutura.secoes, { id, titulo: "Nova seção", ordem: estrutura.secoes.length, campos: [] }],
    });
    setSecaoEditando(id);
  };

  const adicionarCampo = (secaoId: string) => {
    const campo = campoVazio("texto");
    commit({
      ...estrutura,
      secoes: estrutura.secoes.map((s) => (s.id === secaoId ? { ...s, campos: [...s.campos, campo] } : s)),
    });
    setCampoEditando({ secaoId, campoId: campo.id });
  };

  const topo = estrutura.secoes.filter((s) => !s.parentId);
  const filhosDe = (id: string) => estrutura.secoes.filter((s) => s.parentId === id);

  const campoEditandoObj = useMemo(() => {
    if (!campoEditando) return null;
    const secao = estrutura.secoes.find((s) => s.id === campoEditando.secaoId);
    return secao?.campos.find((c) => c.id === campoEditando.campoId) ?? null;
  }, [campoEditando, estrutura]);

  return (
    <div>
      <div className="abas">
        <button className={aba === "editar" ? "ativo" : "secundario"} onClick={() => setAba("editar")}>Editor</button>
        <button className={aba === "previa" ? "ativo" : "secundario"} onClick={() => setAba("previa")}>Pré-visualização</button>
      </div>

      {aba === "previa" ? (
        <SimuladorFicha estrutura={estrutura} vinculaveis={vinculaveis} campaignId={campaignId} />
      ) : (
        <>
          <section className="cartao">
            <h3>Pontos e regras</h3>
            <label className="checkbox-inline">
              <input
                type="checkbox"
                checked={estrutura.pontos.habilitado}
                onChange={(e) => commit({ ...estrutura, pontos: { ...estrutura.pontos, habilitado: e.target.checked } })}
              />
              Campanha usa distribuição de pontos
            </label>
            {estrutura.pontos.habilitado && (
              <div className="formulario">
                <div className="grade-2">
                  <label>Pontos iniciais
                    <input type="number" value={estrutura.pontos.pontosIniciais} onChange={(e) => commit({ ...estrutura, pontos: { ...estrutura.pontos, pontosIniciais: Number(e.target.value) } })} />
                  </label>
                </div>
                <h4>Reservas de pontos da ficha</h4>
                <p className="dica">Pools próprios desta ficha — usados quando a campanha não define reservas próprias (configuração da campanha tem prioridade).</p>
                {(estrutura.pontos.pools ?? []).map((pool, i) => (
                  <div className="linha-ferramentas" key={i}>
                    <input placeholder="id (ex.: atributos)" value={pool.id} onChange={(e) => {
                      const pools = [...(estrutura.pontos.pools ?? [])];
                      pools[i] = { ...pool, id: e.target.value };
                      commit({ ...estrutura, pontos: { ...estrutura.pontos, pools } });
                    }} />
                    <input placeholder="Nome" value={pool.nome} onChange={(e) => {
                      const pools = [...(estrutura.pontos.pools ?? [])];
                      pools[i] = { ...pool, nome: e.target.value };
                      commit({ ...estrutura, pontos: { ...estrutura.pontos, pools } });
                    }} />
                    <input type="number" placeholder="Pontos" aria-label="Pontos do pool" value={pool.pontos} onChange={(e) => {
                      const pools = [...(estrutura.pontos.pools ?? [])];
                      pools[i] = { ...pool, pontos: Number(e.target.value) };
                      commit({ ...estrutura, pontos: { ...estrutura.pontos, pools } });
                    }} />
                    <button type="button" className="mini perigo" onClick={() => {
                      commit({ ...estrutura, pontos: { ...estrutura.pontos, pools: (estrutura.pontos.pools ?? []).filter((_, j) => j !== i) } });
                    }}>✕</button>
                  </div>
                ))}
                <button type="button" className="secundario" onClick={() => {
                  commit({ ...estrutura, pontos: { ...estrutura.pontos, pools: [...(estrutura.pontos.pools ?? []), { id: "", nome: "", pontos: 0 }] } });
                }}>+ Reserva</button>
                <label>Custos progressivos por tipo semântico
                  <textarea
                    rows={3}
                    placeholder={"talento: 1,2,3,4,5\nhabilidade: 1,1,2,2,3"}
                    value={custosTexto(estrutura.pontos.custos)}
                    onChange={(e) => commit({ ...estrutura, pontos: { ...estrutura.pontos, custos: parseCustos(e.target.value) } })}
                  />
                  <small className="meta">Uma linha por tipo: <code>semantico: custo1,custo2,…</code> (custo de subir do nível i para i+1).</small>
                </label>
              </div>
            )}
          </section>

          <button onClick={adicionarSecao}>+ Adicionar seção</button>

          <div className="editor-secoes">
          {topo.map((secao, idx) => (
            <SecaoEditor
              key={secao.id}
              secao={secao}
              estrutura={estrutura}
              indice={idx}
              total={topo.length}
              expandida={secaoEditando === secao.id}
              aoAlternar={() => setSecaoEditando(secaoEditando === secao.id ? null : secao.id)}
              aoMover={(dir) => commit({ ...estrutura, secoes: mover(estrutura.secoes, estrutura.secoes.indexOf(secao), estrutura.secoes.indexOf(secao) + dir) })}
              aoAtualizar={(patch) => atualizarSecao(secao.id, patch)}
              aoRemover={() => commit({ ...estrutura, secoes: estrutura.secoes.filter((s) => s.id !== secao.id && s.parentId !== secao.id) })}
              aoAdicionarCampo={() => adicionarCampo(secao.id)}
              aoEditarCampo={(campoId) => setCampoEditando({ secaoId: secao.id, campoId })}
              aoAtualizarCampo={(campoId, patch) => atualizarCampo(secao.id, campoId, patch)}
              aoRemoverCampo={(campoId) => commit({ ...estrutura, secoes: estrutura.secoes.map((s) => (s.id === secao.id ? { ...s, campos: s.campos.filter((c) => c.id !== campoId) } : s)) })}
              filhos={filhosDe(secao.id).map((sub) => (
                <SecaoEditor
                  key={sub.id}
                  secao={sub}
                  estrutura={estrutura}
                  indice={0}
                  total={1}
                  sub
                  expandida={secaoEditando === sub.id}
                  aoAlternar={() => setSecaoEditando(secaoEditando === sub.id ? null : sub.id)}
                  aoMover={() => undefined}
                  aoAtualizar={(patch) => atualizarSecao(sub.id, patch)}
                  aoRemover={() => commit({ ...estrutura, secoes: estrutura.secoes.filter((s) => s.id !== sub.id) })}
                  aoAdicionarCampo={() => adicionarCampo(sub.id)}
                  aoEditarCampo={(campoId) => setCampoEditando({ secaoId: sub.id, campoId })}
                  aoAtualizarCampo={(campoId, patch) => atualizarCampo(sub.id, campoId, patch)}
                  aoRemoverCampo={(campoId) => commit({ ...estrutura, secoes: estrutura.secoes.map((s) => (s.id === sub.id ? { ...s, campos: s.campos.filter((c) => c.id !== campoId) } : s)) })}
                />
              ))}
            />
          ))}
          </div>
        </>
      )}

      {campoEditando && campoEditandoObj && (
        <EditorCampo
          campo={campoEditandoObj}
          estrutura={estrutura}
          vinculaveis={vinculaveis}
          aoSalvar={(patch) => {
            atualizarCampo(campoEditando.secaoId, campoEditando.campoId, patch);
            setCampoEditando(null);
          }}
          aoFechar={() => setCampoEditando(null)}
        />
      )}
    </div>
  );
}

function SecaoEditor(props: {
  secao: SecaoDef;
  estrutura: EstruturaFicha;
  indice: number;
  total: number;
  sub?: boolean;
  expandida: boolean;
  aoAlternar: () => void;
  aoMover: (dir: number) => void;
  aoAtualizar: (patch: Partial<SecaoDef>) => void;
  aoRemover: () => void;
  aoAdicionarCampo: () => void;
  aoEditarCampo: (campoId: string) => void;
  aoAtualizarCampo: (campoId: string, patch: Partial<CampoDef>) => void;
  aoRemoverCampo: (campoId: string) => void;
  filhos?: React.ReactNode;
}) {
  const { secao, expandida } = props;
  return (
    <section className={`cartao ${props.sub ? "subsecao-editor" : ""}`}>
      <div className="linha-entre">
        <button className="link" onClick={props.aoAlternar}>
          {expandida ? "▾" : "▸"} {secao.titulo} <span className="meta">({secao.campos.length} campos)</span>
        </button>
        <div className="acoes">
          {!props.sub && (
            <>
              <button className="mini" disabled={props.indice === 0} onClick={() => props.aoMover(-1)}>↑</button>
              <button className="mini" disabled={props.indice === props.total - 1} onClick={() => props.aoMover(1)}>↓</button>
            </>
          )}
          <button className="mini perigo" onClick={props.aoRemover}>Excluir</button>
        </div>
      </div>

      {expandida && (
        <div className="formulario">
          <label>Título da seção<input value={secao.titulo} onChange={(e) => props.aoAtualizar({ titulo: e.target.value })} /></label>
          <label>Descrição<input value={secao.descricao ?? ""} onChange={(e) => props.aoAtualizar({ descricao: e.target.value })} /></label>

          {secao.campos.map((campo, i) => (
            <div key={campo.id} className="campo-editor-linha">
              <span className="campo-editor-nome">
                {campo.label} <span className="meta">[{TIPOS.find((t) => t.v === campo.tipo)?.l ?? campo.tipo}{campo.semantico !== "livre" ? ` · ${campo.semantico}` : ""}]</span>
              </span>
              <span className="acoes">
                <button className="mini" disabled={i === 0} onClick={() => {
                  const campos = [...secao.campos];
                  [campos[i - 1], campos[i]] = [campos[i], campos[i - 1]];
                  props.aoAtualizar({ campos });
                }}>↑</button>
                <button className="mini" disabled={i === secao.campos.length - 1} onClick={() => {
                  const campos = [...secao.campos];
                  [campos[i + 1], campos[i]] = [campos[i], campos[i + 1]];
                  props.aoAtualizar({ campos });
                }}>↓</button>
                <button className="mini" onClick={() => props.aoEditarCampo(campo.id)}>Editar</button>
                <button className="mini perigo" onClick={() => props.aoRemoverCampo(campo.id)}>✕</button>
              </span>
            </div>
          ))}

          <button className="mini" onClick={props.aoAdicionarCampo}>+ Adicionar campo</button>
          {props.filhos}
        </div>
      )}
    </section>
  );
}

function EditorCampo({ campo, estrutura, vinculaveis, aoSalvar, aoFechar }: {
  campo: CampoDef;
  estrutura: EstruturaFicha;
  vinculaveis?: Vinculaveis;
  aoSalvar: (patch: Partial<CampoDef>) => void;
  aoFechar: () => void;
}) {
  const [edit, setEdit] = useState<CampoDef>({ ...campo });
  const precisaOpcoes = ["selecao_unica", "selecao_multipla", "selecao_nivel", "lista"].includes(edit.tipo);
  const camposDisponiveis = useMemo(() => {
    const todos: { id: string; label: string }[] = [];
    for (const s of estrutura.secoes) for (const c of s.campos) if (c.id !== edit.id) todos.push({ id: c.id, label: c.label });
    return todos;
  }, [estrutura, edit.id]);

  // Opções disponíveis para campos de seleção — mesma regra do FichaForm:
  // biblioteca quando regraKind tem elementos, senão opções manuais.
  const candidatosSelecao = useMemo<ElementoVinculavel[]>(() => {
    if (!precisaOpcoes) return [];
    const els = edit.regraKind ? (vinculaveis?.elementos[edit.regraKind] ?? []) : [];
    if (els.length) return els;
    return (edit.opcoes ?? []).map((o) => ({ key: o, name: o, category: null }));
  }, [precisaOpcoes, edit.regraKind, edit.opcoes, vinculaveis]);

  const set = <K extends keyof CampoDef>(k: K, v: CampoDef[K]) => setEdit({ ...edit, [k]: v });

  // Valor inicial de selecao_nivel: [{ key, nivel }] — mesmo formato dos dados.
  const padroesNivel = (): { key: string; nivel: number }[] =>
    Array.isArray(edit.padrao) ? (edit.padrao as { key: string; nivel: number }[]) : [];
  const alternarPadraoNivel = (key: string, nivel: number) => {
    const novas = padroesNivel().filter((i) => i.key !== key);
    if (nivel > 0) novas.push({ key, nivel });
    set("padrao", novas.length ? novas : undefined);
  };
  // Valor inicial de selecao_multipla/lista: array de chaves.
  const padroesLista = (): string[] => (Array.isArray(edit.padrao) ? edit.padrao.map(String) : []);
  const alternarPadraoOpcao = (key: string, marcado: boolean) => {
    const novas = marcado ? [...padroesLista(), key] : padroesLista().filter((k) => k !== key);
    set("padrao", novas.length ? novas : undefined);
  };

  return (
    <section className="cartao formulario-edicao">
      <h3>Editando campo</h3>
      <div className="grade-2">
        <label>Nome<input value={edit.label} onChange={(e) => set("label", e.target.value)} /></label>
        <label>Tipo
          <select value={edit.tipo} onChange={(e) => set("tipo", e.target.value as TipoCampo)}>
            {TIPOS.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}
          </select>
        </label>
        <label>Classificação
          <select value={edit.semantico} onChange={(e) => set("semantico", e.target.value)}>
            {SEMANTICOS.map((s) => <option key={s.v} value={s.v}>{s.l}</option>)}
          </select>
        </label>
        <label>Categoria<input placeholder="Ex.: Ciências, Mecânica" value={edit.categoria ?? ""} onChange={(e) => set("categoria", e.target.value || undefined)} /></label>
        <label>Visibilidade
          <select value={edit.visibilidade} onChange={(e) => set("visibilidade", e.target.value)}>
            {VISIBILIDADES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        <label>Quem pode editar
          <select value={edit.editavelPor} onChange={(e) => set("editavelPor", e.target.value)}>
            {EDITAVEIS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
        {edit.tipo === "inteiro" || edit.tipo === "decimal" || edit.tipo === "moeda" ? (
          <>
            <label>Mínimo<input type="number" value={edit.minimo ?? ""} onChange={(e) => set("minimo", e.target.value === "" ? undefined : Number(e.target.value))} /></label>
            <label>Máximo<input type="number" value={edit.maximo ?? ""} onChange={(e) => set("maximo", e.target.value === "" ? undefined : Number(e.target.value))} /></label>
            <label>Custo por ponto<input type="number" step="any" placeholder="Ex.: 1" value={edit.custoPontos ?? ""} onChange={(e) => set("custoPontos", e.target.value === "" ? undefined : Number(e.target.value))} /><small className="meta">Custo fixo por unidade acima da base (padrão/mínimo). Ignorado se houver custo progressivo.</small></label>
            <label>Custo progressivo<input placeholder="Ex.: 1,1,2,2,3" value={(edit.custoProgressivo ?? []).join(",")} onChange={(e) => {
              const vals = e.target.value.split(",").map((s) => s.trim()).filter(Boolean).map(Number).filter((n) => Number.isFinite(n));
              set("custoProgressivo", vals.length ? vals : undefined);
            }} /><small className="meta">Tabela por nível: custos[i] = preço de subir do nível i para i+1.</small></label>
            <label>Reserva de pontos
              <select value={edit.reservaPontos ?? ""} onChange={(e) => set("reservaPontos", e.target.value || undefined)}>
                <option value="">— principal —</option>
                {[...new Set(["principal", ...(estrutura.pontos?.pools ?? []).map((p) => p.id).filter(Boolean)])].map((id) => (
                  <option key={id} value={id}>{id}</option>
                ))}
              </select>
            </label>
          </>
        ) : edit.tipo === "texto" || edit.tipo === "texto_longo" ? (
          <label>Máx. caracteres<input type="number" value={edit.maxCaracteres ?? ""} onChange={(e) => set("maxCaracteres", e.target.value === "" ? undefined : Number(e.target.value))} /></label>
        ) : null}
        {edit.tipo === "selecao_nivel" ? (
          <div className="span-2">
            <span className="meta">Valor inicial — elementos que já vêm com nível</span>
            {candidatosSelecao.map((el) => {
              const nivel = padroesNivel().find((i) => i.key === el.key)?.nivel ?? 0;
              const maxN = Math.max(1, Math.min(5, el.niveis?.length || el.maximo || 5));
              return (
                <div key={el.key} className="linha valor-inicial-nivel">
                  <span className="nivel-nome">{el.name}</span>
                  <select value={nivel} onChange={(e) => alternarPadraoNivel(el.key, Number(e.target.value))}>
                    {Array.from({ length: maxN + 1 }, (_, n) => (
                      <option key={n} value={n}>{n === 0 ? "—" : `Nv.${n}`}</option>
                    ))}
                  </select>
                </div>
              );
            })}
            {candidatosSelecao.length === 0 && (
              <small className="meta">Nenhuma opção disponível — cadastre opções manuais ou escolha o tipo da biblioteca acima.</small>
            )}
          </div>
        ) : edit.tipo === "selecao_unica" ? (
          <label>Valor inicial
            <select value={typeof edit.padrao === "string" ? edit.padrao : ""} onChange={(e) => set("padrao", e.target.value || undefined)}>
              <option value="">— nenhum —</option>
              {candidatosSelecao.map((el) => <option key={el.key} value={el.key}>{el.name}</option>)}
            </select>
          </label>
        ) : edit.tipo === "selecao_multipla" || edit.tipo === "lista" ? (
          <div className="span-2">
            <span className="meta">Valor inicial — opções já marcadas</span>
            {candidatosSelecao.map((el) => (
              <label key={el.key} className="checkbox-inline">
                <input
                  type="checkbox"
                  checked={padroesLista().includes(el.key)}
                  onChange={(e) => alternarPadraoOpcao(el.key, e.target.checked)}
                /> {el.name}
              </label>
            ))}
            {candidatosSelecao.length === 0 && (
              <small className="meta">Nenhuma opção disponível — cadastre opções manuais ou escolha o tipo da biblioteca acima.</small>
            )}
          </div>
        ) : edit.tipo === "checkbox" ? (
          <label className="checkbox-inline">
            <input type="checkbox" checked={edit.padrao === true} onChange={(e) => set("padrao", e.target.checked ? true : undefined)} /> Vem marcado por padrão
          </label>
        ) : (
          <label>Valor inicial<input value={String(edit.padrao ?? "")} onChange={(e) => set("padrao", e.target.value === "" ? undefined : isNaN(Number(e.target.value)) ? e.target.value : Number(e.target.value))} /></label>
        )}
        {edit.tipo === "referencia" && (
          <label>Campo referenciado
            <select value={edit.referencia ?? ""} onChange={(e) => set("referencia", e.target.value || undefined)}>
              <option value="">—</option>
              {camposDisponiveis.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
        )}
        {edit.tipo === "calculado" && (
          <label className="span-2">Fórmula
            <input placeholder="Ex.: sum({forca},{destreza}) ou {peso} * 2" value={edit.formula ?? ""} onChange={(e) => set("formula", e.target.value)} />
            <small className="meta">Use {"{idDoCampo}"} para referências e sum/count/avg/min/max.</small>
          </label>
        )}
        <label>Descrição<input value={edit.descricao ?? ""} onChange={(e) => set("descricao", e.target.value || undefined)} /></label>
        {precisaOpcoes && (
          <label className="span-2">Opções (uma por linha)
            <textarea rows={4} value={(edit.opcoes ?? []).join("\n")} onChange={(e) => set("opcoes", e.target.value.split("\n").map((s) => s.trim()).filter(Boolean))} />
          </label>
        )}
        {/* Vínculo com a biblioteca de regras (Etapa 5) */}
        {vinculaveis && ["inteiro", "decimal", "moeda"].includes(edit.tipo) && (
          <label className="span-2">Elemento da biblioteca (regras)
            <select
              value={edit.regra ? `${edit.regra.kind}:${edit.regra.key}` : ""}
              onChange={(e) => {
                const v = e.target.value;
                if (!v) { set("regra", undefined); return; }
                const [kind, ...rest] = v.split(":");
                set("regra", { kind, key: rest.join(":") });
              }}
            >
              <option value="">— nenhum —</option>
              {vinculaveis.kinds.flatMap((kind) =>
                (vinculaveis.elementos[kind] ?? []).map((el) => (
                  <option key={`${kind}:${el.key}`} value={`${kind}:${el.key}`}>{ROTULO_KIND[kind] ?? kind}: {el.name}</option>
                ))
              )}
            </select>
            <small className="meta">Vincula este campo a um elemento: custos, limites, pré-requisitos e exclusividades da biblioteca passam a valer para ele.</small>
          </label>
        )}
        {vinculaveis && precisaOpcoes && (
          <label className="span-2">Opções da biblioteca (regras)
            <select
              value={edit.regraKind ?? ""}
              onChange={(e) => set("regraKind", e.target.value || undefined)}
            >
              <option value="">— usar opções manuais —</option>
              {vinculaveis.kinds.filter((k) => (vinculaveis.elementos[k] ?? []).length > 0).map((k) => (
                <option key={k} value={k}>{ROTULO_KIND[k] ?? k} ({(vinculaveis.elementos[k] ?? []).length})</option>
              ))}
            </select>
            <small className="meta">Se definido, as opções deste campo vêm da biblioteca (ex.: poderes, vantagens). O jogador escolhe entre os elementos disponíveis.</small>
          </label>
        )}
        {edit.tipo === "tabela" && (
          <label className="span-2">Colunas (key|label|tipo|opções por linha — tipo: texto|inteiro|decimal|moeda|data|selecao; opções separadas por vírgula, ex.: entrada,saida)
            <textarea
              rows={3}
              value={(edit.colunas ?? []).map((c) => `${c.key}|${c.label}|${c.tipo}${c.opcoes?.length ? `|${c.opcoes.join(",")}` : ""}`).join("\n")}
              onChange={(e) => set("colunas", e.target.value.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
                const [key, label, tipo, opcoes] = l.split("|");
                const t = ["inteiro", "decimal", "moeda", "data", "selecao"].includes(tipo ?? "") ? tipo! : "texto";
                const ops = (opcoes ?? "").split(",").map((o) => o.trim()).filter(Boolean);
                return { key: (key ?? "").trim(), label: (label ?? key ?? "").trim(), tipo: t as string, ...(ops.length ? { opcoes: ops } : {}) };
              }))}
            />
          </label>
        )}
        {edit.tipo === "tabela" && edit.semantico === "moeda" && (
          <div className="span-2 linha">
            <label className="checkbox-inline">
              <input
                type="checkbox"
                checked={!!edit.carteira}
                onChange={(e) => set("carteira", e.target.checked ? { saldoEditavelPor: "mestre" } : undefined)}
              />{" "}
              Carteira financeira (saldo inicial + entradas/saídas calculam o saldo)
            </label>
            {edit.carteira && (
              <label>
                Quem altera o saldo inicial
                <select
                  value={edit.carteira.saldoEditavelPor}
                  onChange={(e) => set("carteira", { saldoEditavelPor: e.target.value })}
                >
                  {EDITAVEIS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
            )}
          </div>
        )}
      </div>
      <div className="linha">
        <label className="checkbox-inline"><input type="checkbox" checked={edit.obrigatorio} onChange={(e) => set("obrigatorio", e.target.checked)} /> Obrigatório</label>
        <label className="checkbox-inline"><input type="checkbox" checked={edit.repetivel} onChange={(e) => set("repetivel", e.target.checked)} /> Repetível</label>
        <label className="checkbox-inline"><input type="checkbox" checked={edit.usadoEmTestes === true} onChange={(e) => set("usadoEmTestes", e.target.checked)} /> Usado em testes</label>
      </div>
      <div className="linha">
        <button onClick={() => aoSalvar(edit)}>Salvar campo</button>
        <button className="secundario" onClick={aoFechar}>Cancelar</button>
      </div>
    </section>
  );
}

/**
 * Simulador da prévia: a ficha renderizada com dados 100% locais.
 * Interage com POST /regras/simulacao (mesmo pipeline da ficha real,
 * somente leitura) — nada é gravado em personagem, campanha ou banco.
 */
function SimuladorFicha({ estrutura, vinculaveis, campaignId }: {
  estrutura: EstruturaFicha;
  vinculaveis?: Vinculaveis;
  campaignId?: string;
}) {
  const [valores, setValores] = useState<Record<string, unknown>>({});
  const [pontosFict, setPontosFict] = useState("");
  const [simKey, setSimKey] = useState(0);
  const bruto = pontosFict.trim() === "" ? null : Number(pontosFict.replace(",", "."));
  const pontosFicticios = bruto !== null && Number.isFinite(bruto) && bruto >= 0 ? bruto : null;

  const restaurar = () => {
    setValores({});
    setPontosFict("");
    setSimKey((k) => k + 1); // remonta o FichaForm: zera pontos/avisos internos
  };

  return (
    <section className="cartao">
      <div className="linha-entre simulador-barra">
        <span className="badge badge-simulacao">SIMULAÇÃO — DADOS FICTÍCIOS</span>
        <div className="simulador-controles">
          <label>Pontos fictícios
            <input
              type="number"
              min="0"
              placeholder="configuração real"
              value={pontosFict}
              onChange={(e) => setPontosFict(e.target.value)}
            />
          </label>
          <button type="button" className="secundario" onClick={restaurar}>Restaurar simulação</button>
        </div>
      </div>
      <p className="meta">
        Monte um personagem de teste: compre atributos, escolha defeitos/poderes e veja pontos,
        custos e erros de regra em tempo real. Nada aqui é salvo — serve para validar a ficha
        antes de publicar para os jogadores.
      </p>
      {campaignId ? (
        <FichaForm
          key={simKey}
          estrutura={estrutura}
          valores={valores}
          somenteLeitura={false}
          aoMudar={(id, v) => setValores((s) => ({ ...s, [id]: v }))}
          biblioteca={vinculaveis?.elementos}
          simulacao={{ campaignId, pontosFicticios }}
        />
      ) : (
        <p className="meta">Simulador indisponível sem campanha.</p>
      )}
    </section>
  );
}
