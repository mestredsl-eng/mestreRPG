import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  api,
  type ConfigRegras,
  type ElementoRegra,
  type ElementoRegraInput,
  type PersonagemResumo,
  type RegrasCampanha,
  type ResultadoValidacaoRegras,
  type TipoRegra,
} from "../api";

const ROTULO_KIND: Record<TipoRegra, string> = {
  atributo: "Atributo",
  talento: "Talento",
  habilidade: "Habilidade",
  conhecimento: "Conhecimento",
  profissao: "Profissão",
  especializacao: "Especialização",
  vantagem: "Vantagem",
  defeito: "Defeito",
  poder: "Poder",
  disciplina: "Disciplina",
  pericia: "Perícia",
  caracteristica: "Característica",
};

const KINDS = Object.keys(ROTULO_KIND) as TipoRegra[];

type Aba = "biblioteca" | "pontuacao" | "validacao";

export default function Regras({ campaignId }: { campaignId: string }) {
  const [aba, setAba] = useState<Aba>("biblioteca");
  const [regras, setRegras] = useState<RegrasCampanha | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [filtroKind, setFiltroKind] = useState<string>("");
  const [busca, setBusca] = useState("");
  const [editando, setEditando] = useState<ElementoRegra | "novo" | null>(null);
  const [personagens, setPersonagens] = useState<PersonagemResumo[]>([]);
  const [validacao, setValidacao] = useState<ResultadoValidacaoRegras | null>(null);
  const [personagemSel, setPersonagemSel] = useState("");

  const carregar = useCallback(async () => {
    try {
      const r = await api.obterRegras(campaignId);
      setRegras(r);
      setErro(null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar regras");
    }
  }, [campaignId]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const elementosFiltrados = useMemo(() => {
    if (!regras) return [];
    const q = busca.toLowerCase();
    return regras.elementos.filter((el) => {
      if (filtroKind && el.kind !== filtroKind) return false;
      if (q && !el.name.toLowerCase().includes(q) && !el.key.includes(q) && !(el.category ?? "").toLowerCase().includes(q)) return false;
      return true;
    });
  }, [regras, filtroKind, busca]);

  const grupos = useMemo(() => {
    const mapa = new Map<string, ElementoRegra[]>();
    for (const el of elementosFiltrados) {
      const cat = el.category ?? "Sem categoria";
      const lista = mapa.get(cat) ?? [];
      lista.push(el);
      mapa.set(cat, lista);
    }
    return [...mapa.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [elementosFiltrados]);

  const salvarElemento = async (dados: ElementoRegraInput) => {
    setErro(null);
    try {
      if (editando === "novo") {
        await api.criarElementoRegra(campaignId, dados);
      } else if (editando) {
        const { kind: _k, key: _key, ...resto } = dados;
        await api.atualizarElementoRegra(campaignId, editando.id, resto);
      }
      setEditando(null);
      await carregar();
      setAviso("Elemento salvo.");
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao salvar elemento");
    }
  };

  const alternarDisponivel = async (el: ElementoRegra) => {
    try {
      await api.atualizarElementoRegra(campaignId, el.id, {
        definition: { ...el.definition, disponivel: el.definition.disponivel === false },
      });
      await carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao atualizar elemento");
    }
  };

  const remover = async (el: ElementoRegra) => {
    if (!window.confirm(`Excluir "${el.name}" da biblioteca? Personagens que o usam podem ficar inválidos.`)) return;
    try {
      await api.removerElementoRegra(campaignId, el.id);
      await carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao remover elemento");
    }
  };

  const duplicar = async (el: ElementoRegra) => {
    try {
      await api.duplicarElementoRegra(campaignId, el.id);
      await carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao duplicar elemento");
    }
  };

  const semear = async () => {
    try {
      const r = await api.semearBiblioteca(campaignId);
      setAviso(`${r.inseridos} elementos adicionados à biblioteca.`);
      await carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar biblioteca inicial");
    }
  };

  const salvarConfig = async (config: ConfigRegras) => {
    try {
      await api.atualizarConfigRegras(campaignId, config);
      setAviso("Configuração de regras salva.");
      await carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao salvar configuração");
    }
  };

  const carregarPersonagens = async () => {
    try {
      const { personagens } = await api.listarPersonagens(campaignId);
      setPersonagens(personagens);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao listar personagens");
    }
  };

  const rodarValidacao = async () => {
    if (!personagemSel) return;
    try {
      setValidacao(await api.validarFichaRegras(campaignId, personagemSel));
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro na validação");
    }
  };

  return (
    <div className="painel">
      <div className="abas">
        <button className={aba === "biblioteca" ? "ativo" : "secundario"} onClick={() => setAba("biblioteca")}>Biblioteca</button>
        <button className={aba === "pontuacao" ? "ativo" : "secundario"} onClick={() => setAba("pontuacao")}>Pontuação</button>
        <button className={aba === "validacao" ? "ativo" : "secundario"} onClick={() => { setAba("validacao"); void carregarPersonagens(); }}>Validação de fichas</button>
      </div>

      {erro && <div className="erro">{erro}</div>}
      {aviso && <div className="ok-msg">{aviso}</div>}

      {aba === "biblioteca" && (
        <div>
          <div className="linha-ferramentas">
            <input placeholder="Buscar por nome, chave ou categoria..." value={busca} onChange={(e) => setBusca(e.target.value)} />
            <select value={filtroKind} onChange={(e) => setFiltroKind(e.target.value)}>
              <option value="">Todos os tipos</option>
              {KINDS.map((k) => <option key={k} value={k}>{ROTULO_KIND[k]}</option>)}
            </select>
            <button className="secundario" onClick={() => setEditando("novo")}>+ Novo elemento</button>
            <button className="secundario" onClick={() => void semear()}>Carregar biblioteca inicial</button>
          </div>
          <p className="dica">{regras?.total ?? 0} elementos cadastrados. Cada elemento pode ser vinculado a um campo da ficha no editor de fichas.</p>

          {grupos.map(([cat, itens]) => (
            <div key={cat} className="grupo-regras">
              <h4>{cat} <span className="contador">({itens.length})</span></h4>
              <div className="lista-elementos">
                {itens.map((el) => (
                  <div key={el.id} className={`elemento ${el.definition.disponivel === false ? "inativo" : ""}`}>
                    <div className="elemento-info">
                      <strong>{el.name}</strong>
                      <span className="tag">{ROTULO_KIND[el.kind]}</span>
                      {el.definition.custoPontos !== undefined && <span className="tag">custo {el.definition.custoPontos}/pt</span>}
                      {el.definition.custoProgressivo?.length ? <span className="tag">progressivo</span> : null}
                      {el.definition.grupoExclusividade && <span className="tag">exclusivo: {el.definition.grupoExclusividade}</span>}
                      {el.definition.obrigatorios?.length ? <span className="tag">exige {el.definition.obrigatorios.length}</span> : null}
                    </div>
                    <div className="elemento-acoes">
                      <button className="mini" onClick={() => void alternarDisponivel(el)}>{el.definition.disponivel === false ? "Ativar" : "Desativar"}</button>
                      <button className="mini" onClick={() => void duplicar(el)}>Duplicar</button>
                      <button className="mini" onClick={() => setEditando(el)}>Editar</button>
                      <button className="mini perigo" onClick={() => void remover(el)}>Excluir</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {!elementosFiltrados.length && <p className="dica">Nenhum elemento encontrado. Use "Carregar biblioteca inicial" ou crie um novo.</p>}
        </div>
      )}

      {aba === "pontuacao" && regras && (
        <PainelPontuacao config={regras.config} onSalvar={salvarConfig} />
      )}

      {aba === "validacao" && (
        <div>
          <div className="linha-ferramentas">
            <select value={personagemSel} onChange={(e) => setPersonagemSel(e.target.value)}>
              <option value="">Selecione um personagem...</option>
              {personagens.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.dono})</option>)}
            </select>
            <button className="primario" disabled={!personagemSel} onClick={() => void rodarValidacao()}>Validar</button>
          </div>
          {validacao && (
            <div className={`caixa-validacao ${validacao.ok ? "ok" : "erro"}`}>
              {validacao.ok ? (
                <p>✔ Ficha válida — todas as regras cumpridas. A aprovação final continua sendo do mestre.</p>
              ) : (
                <>
                  <p><strong>{validacao.totalErros} problema(s) encontrado(s):</strong></p>
                  <ul>
                    {validacao.erros.map((e, i) => <li key={i}>{e.mensagem}</li>)}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {editando && (
        <ModalElemento
          elemento={editando === "novo" ? null : editando}
          kinds={regras?.kinds ?? KINDS}
          todosElementos={regras?.elementos ?? []}
          onFechar={() => setEditando(null)}
          onSalvar={salvarElemento}
        />
      )}
    </div>
  );
}

// ---------- Painel de pontuação ----------

function PainelPontuacao({ config, onSalvar }: { config: ConfigRegras; onSalvar: (c: ConfigRegras) => Promise<void> }) {
  const [form, setForm] = useState<ConfigRegras>(config);
  const [custosTxt, setCustosTxt] = useState(""); // "talento:1,2,3,4,5" por linha

  useEffect(() => {
    setForm(config);
    setCustosTxt(Object.entries(config.pontos.custos).map(([k, v]) => `${k}: ${v.join(",")}`).join("\n"));
  }, [config]);

  const setPontos = (patch: Partial<ConfigRegras["pontos"]>) =>
    setForm((f) => ({ ...f, pontos: { ...f.pontos, ...patch } }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    // Interpreta custos "semantico: 1,2,3"
    const custos: Record<string, number[]> = {};
    for (const linha of custosTxt.split("\n")) {
      const m = linha.match(/^\s*([a-z_]+)\s*:\s*(.*)$/);
      if (!m) continue;
      custos[m[1]] = m[2].split(",").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
    }
    await onSalvar({ ...form, pontos: { ...form.pontos, custos } });
  };

  return (
    <form onSubmit={submit} className="formulario">
      <label className="checkbox">
        <input type="checkbox" checked={form.pontos.habilitado} onChange={(e) => setPontos({ habilitado: e.target.checked })} />
        Validar pontos nesta campanha
      </label>
      <div className="grade-form">
        <label>Pontos iniciais<input type="number" value={form.pontos.pontosIniciais} onChange={(e) => setPontos({ pontosIniciais: Number(e.target.value) })} /></label>
        <label>Pontos extras por personagem<input type="number" value={form.pontosExtras} onChange={(e) => setForm((f) => ({ ...f, pontosExtras: Number(e.target.value) }))} /></label>
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={form.aprovacaoAutomatica} onChange={(e) => setForm((f) => ({ ...f, aprovacaoAutomatica: e.target.checked }))} />
        Aprovação automática quando todas as regras forem cumpridas (padrão: aprovação manual pelo mestre)
      </label>

      <h4>Reservas de pontos</h4>
      {form.pontos.pools.map((pool, i) => (
        <div className="linha-ferramentas" key={i}>
          <input placeholder="id (ex.: vantagens)" value={pool.id} onChange={(e) => {
            const pools = [...form.pontos.pools];
            pools[i] = { ...pool, id: e.target.value };
            setPontos({ pools });
          }} />
          <input placeholder="Nome" value={pool.nome} onChange={(e) => {
            const pools = [...form.pontos.pools];
            pools[i] = { ...pool, nome: e.target.value };
            setPontos({ pools });
          }} />
          <input type="number" placeholder="Pontos" value={pool.pontos} onChange={(e) => {
            const pools = [...form.pontos.pools];
            pools[i] = { ...pool, pontos: Number(e.target.value) };
            setPontos({ pools });
          }} />
          <button type="button" className="mini perigo" onClick={() => setPontos({ pools: form.pontos.pools.filter((_, j) => j !== i) })}>✕</button>
        </div>
      ))}
      <button type="button" className="secundario" onClick={() => setPontos({ pools: [...form.pontos.pools, { id: "", nome: "", pontos: 0 }] })}>+ Reserva</button>

      <h4>Custos progressivos por tipo semântico</h4>
      <p className="dica">Uma linha por tipo: <code>talento: 1,2,3,4,5</code> (custo de subir do nível i para i+1). Vantagens e defeitos podem usar custos negativos para reservar pontos.</p>
      <textarea rows={4} value={custosTxt} onChange={(e) => setCustosTxt(e.target.value)} />

      <button className="primario" type="submit">Salvar configuração</button>
    </form>
  );
}

// ---------- Modal de elemento ----------

function ModalElemento({
  elemento,
  kinds,
  todosElementos,
  onFechar,
  onSalvar,
}: {
  elemento: ElementoRegra | null;
  kinds: TipoRegra[];
  todosElementos: ElementoRegra[];
  onFechar: () => void;
  onSalvar: (d: ElementoRegraInput) => Promise<void>;
}) {
  const def = elemento?.definition ?? {};
  const [form, setForm] = useState({
    kind: elemento?.kind ?? ("conhecimento" as TipoRegra),
    key: elemento?.key ?? "",
    name: elemento?.name ?? "",
    category: elemento?.category ?? "",
    descricao: def.descricao ?? "",
    custoPontos: def.custoPontos?.toString() ?? "",
    custoProgressivo: def.custoProgressivo?.join(",") ?? "",
    minimo: def.minimo?.toString() ?? "",
    maximo: def.maximo?.toString() ?? "",
    grupoExclusividade: def.grupoExclusividade ?? "",
    reservaPontos: def.reservaPontos ?? "",
    prerequisitos: (def.prerequisitos ?? []).map((p) => `${p.kind}:${p.key}${p.minLevel ? `@${p.minLevel}` : ""}`).join(", "),
    obrigatorios: (def.obrigatorios ?? []).join(", "),
    disponivel: def.disponivel !== false,
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const num = (s: string) => (s.trim() === "" ? undefined : Number(s));
    const listaRefs = (s: string) =>
      s.split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
        const [ref, min] = x.split("@");
        const [kind, ...rest] = ref.split(":");
        return { kind, key: rest.join(":"), ...(min ? { minLevel: Number(min) } : {}) };
      });
    const listaKeys = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
    await onSalvar({
      kind: form.kind,
      key: form.key,
      name: form.name,
      category: form.category || undefined,
      definition: {
        descricao: form.descricao || undefined,
        custoPontos: num(form.custoPontos),
        custoProgressivo: form.custoProgressivo ? form.custoProgressivo.split(",").map((n) => Number(n.trim())).filter((n) => !Number.isNaN(n)) : undefined,
        minimo: num(form.minimo),
        maximo: num(form.maximo),
        grupoExclusividade: form.grupoExclusividade || undefined,
        reservaPontos: form.reservaPontos || undefined,
        prerequisitos: listaRefs(form.prerequisitos),
        obrigatorios: listaKeys(form.obrigatorios),
        disponivel: form.disponivel,
      },
    });
  };

  return (
    <div className="modal-fundo" onClick={onFechar}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{elemento ? `Editar: ${elemento.name}` : "Novo elemento"}</h3>
        <form onSubmit={submit} className="formulario">
          {!elemento && (
            <div className="grade-form">
              <label>Tipo
                <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as TipoRegra })}>
                  {kinds.map((k) => <option key={k} value={k}>{ROTULO_KIND[k]}</option>)}
                </select>
              </label>
              <label>Chave (id único)<input value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} placeholder="ex.: telepatia" required /></label>
            </div>
          )}
          <label>Nome<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></label>
          <label>Categoria<input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="ex.: Tecnologia, Poderes" list="categorias-regra" /></label>
          <datalist id="categorias-regra">
            {[...new Set(todosElementos.map((e) => e.category).filter(Boolean) as string[])].map((c) => <option key={c} value={c} />)}
          </datalist>
          <label>Descrição<textarea rows={2} value={form.descricao} onChange={(e) => setForm({ ...form, descricao: e.target.value })} /></label>
          <div className="grade-form">
            <label>Custo por ponto<input type="number" step="any" value={form.custoPontos} onChange={(e) => setForm({ ...form, custoPontos: e.target.value })} placeholder="ex.: 7 ou -1" /></label>
            <label>Reserva de pontos<input value={form.reservaPontos} onChange={(e) => setForm({ ...form, reservaPontos: e.target.value })} placeholder="ex.: vantagens, defeitos" list="reservas-regra" /></label>
            <datalist id="reservas-regra">
              {(configPools(todosElementos)).map((p) => <option key={p} value={p} />)}
            </datalist>
            <label>Mínimo<input type="number" value={form.minimo} onChange={(e) => setForm({ ...form, minimo: e.target.value })} /></label>
            <label>Máximo<input type="number" value={form.maximo} onChange={(e) => setForm({ ...form, maximo: e.target.value })} /></label>
          </div>
          <label>Custo progressivo (vírgula)<input value={form.custoProgressivo} onChange={(e) => setForm({ ...form, custoProgressivo: e.target.value })} placeholder="ex.: 1,2,3,4,5" /></label>
          <label>Grupo de exclusividade<input value={form.grupoExclusividade} onChange={(e) => setForm({ ...form, grupoExclusividade: e.target.value })} placeholder="elementos do mesmo grupo não combinam" /></label>
          <label>Pré-requisitos<input value={form.prerequisitos} onChange={(e) => setForm({ ...form, prerequisitos: e.target.value })} placeholder="tipo:chave@nível, separados por vírgula" /></label>
          <label>Elementos obrigatórios<input value={form.obrigatorios} onChange={(e) => setForm({ ...form, obrigatorios: e.target.value })} placeholder="tipo:chave, separados por vírgula" /></label>
          <label className="checkbox">
            <input type="checkbox" checked={form.disponivel} onChange={(e) => setForm({ ...form, disponivel: e.target.checked })} />
            Disponível na campanha
          </label>
          <div className="acoes-modal">
            <button type="button" className="secundario" onClick={onFechar}>Cancelar</button>
            <button type="submit" className="primario">Salvar</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function configPools(elementos: ElementoRegra[]): string[] {
  return [...new Set(elementos.map((e) => e.definition.reservaPontos).filter(Boolean) as string[])];
}
