import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  api,
  ApiError,
  type ConfigRegras,
  type ElementoRegra,
  type ElementoRegraInput,
  type LivroAcervoCampanha,
  type PersonagemResumo,
  type RegrasCampanha,
  type ResultadoValidacaoRegras,
  type TipoRegra,
} from "../api";
import { ModalConfirmar } from "../Modal";

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
  item: "Item",
  veiculo: "Veículo",
  dinheiro: "Dinheiro",
};

const KINDS = Object.keys(ROTULO_KIND) as TipoRegra[];

type Aba = "biblioteca" | "pontuacao" | "validacao" | "acervo";

/** Extrai campo/mensagem dos issues de validação retornados pela API. */
function mensagemApi(e: unknown, padrao: string): string {
  if (e instanceof ApiError) {
    const detalhes = e.detalhes;
    if (Array.isArray(detalhes) && detalhes.length) {
      const campos = detalhes
        .map((d) => {
          const i = d as { path?: unknown[]; message?: string };
          const caminho = (i.path ?? []).join(".");
          return caminho ? `${caminho}: ${i.message ?? "inválido"}` : (i.message ?? "inválido");
        })
        .join("; ");
      return `${e.message} — ${campos}`;
    }
    return e.message || padrao;
  }
  return e instanceof Error ? e.message : padrao;
}

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
  const [confirmando, setConfirmando] = useState<ElementoRegra | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [livrosAcervo, setLivrosAcervo] = useState<LivroAcervoCampanha[]>([]);
  const [conflitosAcervo, setConflitosAcervo] = useState<{ bookId: string; itens: { chave: string; nomeNoLivro: string; nomeNaCampanha: string }[] } | null>(null);
  const [decisoesAcervo, setDecisoesAcervo] = useState<Record<string, "manter_campanha" | "usar_livro">>({});

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
      setErro(mensagemApi(e, "Erro ao salvar elemento"));
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

  const remover = async () => {
    if (!confirmando || ocupado) return;
    setOcupado(true);
    try {
      await api.removerElementoRegra(campaignId, confirmando.id);
      setConfirmando(null);
      await carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao remover elemento");
    } finally {
      setOcupado(false);
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
      setErro(mensagemApi(e, "Erro ao salvar configuração"));
    }
  };

  const carregarAcervo = useCallback(async () => {
    try {
      const r = await api.listarAcervoCampanha(campaignId);
      setLivrosAcervo(r.livros);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar Acervo da campanha");
    }
  }, [campaignId]);

  useEffect(() => {
    if (aba === "acervo") void carregarAcervo();
  }, [aba, carregarAcervo]);

  const aplicarLivro = async (bookId: string, decisoes: Record<string, "manter_campanha" | "usar_livro"> = {}) => {
    setErro(null);
    try {
      const r = await api.aplicarLivroAcervo(campaignId, bookId, decisoes);
      setConflitosAcervo(null);
      setDecisoesAcervo({});
      setAviso("Livro aplicado: " + r.inseridos + " novo(s), " + r.atualizados + " atualizado(s), " + r.mantidos + " mantido(s) da campanha.");
      await Promise.all([carregarAcervo(), carregar()]);
    } catch (e) {
      if (e instanceof ApiError && e.detalhes && typeof e.detalhes === "object") {
        const d = e.detalhes as { conflitos?: { chave: string; nomeNoLivro: string; nomeNaCampanha: string }[] };
        if (Array.isArray(d.conflitos)) {
          setConflitosAcervo({ bookId, itens: d.conflitos });
          setDecisoesAcervo({});
          return;
        }
      }
      setErro(e instanceof Error ? e.message : "Erro ao aplicar livro do Acervo");
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
        <button className={aba === "acervo" ? "ativo" : "secundario"} onClick={() => setAba("acervo")}>Acervo</button>
      </div>

      {erro && <div className="erro">{erro}</div>}
      {aviso && <div className="ok-msg">{aviso}</div>}

      {aba === "biblioteca" && (
        <div>
          <div className="linha-ferramentas">
            <input aria-label="Buscar por nome, chave ou categoria" placeholder="Buscar por nome, chave ou categoria..." value={busca} onChange={(e) => setBusca(e.target.value)} />
            <select aria-label="Filtrar por tipo de elemento" value={filtroKind} onChange={(e) => setFiltroKind(e.target.value)}>
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
                      {(el.definition.gruposExclusividade?.length ?? 0) > 0 && <span className="tag">{el.definition.gruposExclusividade!.length} grupo(s)</span>}
                      {el.definition.formulas && Object.keys(el.definition.formulas).length > 0 && <span className="tag">fórmulas</span>}
                      {el.definition.obrigatorios?.length ? <span className="tag">exige {el.definition.obrigatorios.length}</span> : null}
                    </div>
                    <div className="elemento-acoes">
                      <button className="mini" onClick={() => void alternarDisponivel(el)}>{el.definition.disponivel === false ? "Ativar" : "Desativar"}</button>
                      <button className="mini" onClick={() => void duplicar(el)}>Duplicar</button>
                      <button className="mini" onClick={() => setEditando(el)}>Editar</button>
                      <button className="mini perigo" onClick={() => setConfirmando(el)}>Excluir</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {!elementosFiltrados.length && <p className="dica">Nenhum elemento encontrado. Use "Carregar biblioteca inicial" ou crie um novo.</p>}
        </div>
      )}

      {aba === "acervo" && (
        <div>
          <p className="dica">Aplique livros e suplementos do Acervo global nesta campanha. O conteúdo vira uma cópia independente: mudanças futuras no Acervo não alteram a campanha sozinhas.</p>
          <div className="linha-ferramentas">
            <button className="secundario" onClick={() => void carregarAcervo()}>Atualizar lista</button>
          </div>
          {livrosAcervo.map((livro) => (
            <div className="elemento" key={livro.id}>
              <div className="elemento-info">
                <strong>{livro.titulo}</strong>
                <span className="tag">{livro.tipo === "suplemento" ? "Suplemento" : "Livro"}</span>
                <span className="tag">v{livro.versao}</span>
                <span className="tag">{livro.totalItens} itens</span>
                {livro.aplicado && <span className="tag">Aplicado v{livro.versaoAplicada}</span>}
                {livro.atualizacaoDisponivel && <span className="tag">Atualização disponível</span>}
                {livro.sistema && <span className="dica">{livro.sistema}</span>}
                {livro.descricao && <span className="dica">{livro.descricao}</span>}
              </div>
              <div className="elemento-acoes">
                <button className="mini" onClick={() => void aplicarLivro(livro.id)}>
                  {livro.aplicado ? "Revisar / reaplicar" : "Aplicar à campanha"}
                </button>
              </div>
            </div>
          ))}
          {!livrosAcervo.length && <p className="dica">Nenhum livro ativo no Acervo. Cadastre ou importe livros na Biblioteca global.</p>}
          {conflitosAcervo && (
            <section className="cartao">
              <h4>Conflitos encontrados — escolha o que deve prevalecer</h4>
              <p className="dica">Nenhuma alteração foi gravada ainda. Para cada chave repetida, escolha manter a regra da campanha ou substituí-la pela versão do livro.</p>
              {conflitosAcervo.itens.map((item) => (
                <div className="linha-ferramentas" key={item.chave}>
                  <div>
                    <strong>{item.chave}</strong>
                    <div className="dica">Campanha: {item.nomeNaCampanha} · Livro: {item.nomeNoLivro}</div>
                  </div>
                  <select
                    value={decisoesAcervo[item.chave] ?? ""}
                    onChange={(e) => {
                      const v = e.target.value as "" | "manter_campanha" | "usar_livro";
                      setDecisoesAcervo((atual) => {
                        const novo = { ...atual };
                        if (v) novo[item.chave] = v;
                        else delete novo[item.chave];
                        return novo;
                      });
                    }}
                  >
                    <option value="">Escolha...</option>
                    <option value="manter_campanha">Manter campanha</option>
                    <option value="usar_livro">Usar livro</option>
                  </select>
                </div>
              ))}
              <div className="linha">
                <button
                  className="primario"
                  disabled={conflitosAcervo.itens.some((i) => !decisoesAcervo[i.chave])}
                  onClick={() => void aplicarLivro(conflitosAcervo.bookId, decisoesAcervo)}
                >Confirmar aplicação</button>
                <button className="secundario" onClick={() => { setConflitosAcervo(null); setDecisoesAcervo({}); }}>Cancelar</button>
              </div>
            </section>
          )}
        </div>
      )}

      {aba === "pontuacao" && regras && (
        <PainelPontuacao config={regras.config} onSalvar={salvarConfig} campaignId={campaignId} />
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
              {validacao.calculos && Object.keys(validacao.calculos).length > 0 && (
                <div>
                  <p><strong>Cálculos das fórmulas:</strong></p>
                  <ul>
                    {Object.entries(validacao.calculos).map(([k, v]) => <li key={k}><code>{k}</code> = {v}</li>)}
                  </ul>
                </div>
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
      {confirmando && (
        <ModalConfirmar
          titulo="Excluir elemento"
          mensagem={`Excluir "${confirmando.name}" da biblioteca? Personagens que o usam podem ficar inválidos.`}
          rotuloConfirmar="Excluir"
          perigo
          ocupado={ocupado}
          aoConfirmar={() => void remover()}
          aoCancelar={() => { if (!ocupado) setConfirmando(null); }}
        />
      )}
    </div>
  );
}

// ---------- Painel de pontuação ----------

interface CampoHp {
  id: string;
  label: string;
  semantico?: string;
  modelo?: string;
}

function PainelPontuacao({ config, onSalvar, campaignId }: { config: ConfigRegras; onSalvar: (c: ConfigRegras) => Promise<void>; campaignId: string }) {
  const [form, setForm] = useState<ConfigRegras>(config);
  const [custosTxt, setCustosTxt] = useState(""); // "talento:1,2,3,4,5" por linha
  const [erroLocal, setErroLocal] = useState<string | null>(null);
  const [camposHp, setCamposHp] = useState<CampoHp[] | null>(null);

  useEffect(() => {
    setForm({ ...config, transferencias: config.transferencias ?? [] });
    setCustosTxt(Object.entries(config.pontos.custos).map(([k, v]) => `${k}: ${v.join(",")}`).join("\n"));
  }, [config]);

  // Campos numéricos das versões PUBLICADAS das fichas da campanha —
  // permite escolher o atributo do HP pelo nome, sem saber o ID interno.
  // Nada é associado automaticamente: o mestre escolhe explicitamente.
  useEffect(() => {
    if (!form.hp?.habilitado || camposHp !== null) return;
    let vivo = true;
    (async () => {
      try {
        const { modelos } = await api.listarModelos(campaignId);
        const achados: CampoHp[] = [];
        for (const m of modelos.filter((x) => x.isActive)) {
          try {
            const { versoes } = await api.obterModelo(campaignId, m.id);
            // Somente versões publicadas (publishedAt) — rascunhos não valem.
            const pub = versoes
              .filter((v) => v.publishedAt && v.estrutura)
              .sort((a, b) => b.version - a.version)[0];
            for (const s of pub?.estrutura?.secoes ?? []) {
              for (const c of s.campos ?? []) {
                if (["inteiro", "decimal", "moeda"].includes(c.tipo)) {
                  achados.push({
                    id: c.id,
                    label: c.label,
                    semantico: c.semantico && c.semantico !== "livre" ? c.semantico : undefined,
                    modelo: modelos.length > 1 ? m.name : undefined,
                  });
                }
              }
            }
          } catch { /* modelo sem versão legível — ignora */ }
        }
        if (vivo) setCamposHp(achados);
      } catch {
        if (vivo) setCamposHp([]);
      }
    })();
    return () => { vivo = false; };
  }, [form.hp?.habilitado, camposHp, campaignId]);

  const setPontos = (patch: Partial<ConfigRegras["pontos"]>) =>
    setForm((f) => ({ ...f, pontos: { ...f.pontos, ...patch } }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErroLocal(null);
    const vit = form.vitalidade;
    if (vit?.niveis?.length) {
      for (const [i, n] of vit.niveis.entries()) {
        if (!n.nome?.trim()) { setErroLocal(`Vitalidade: o nome do nível ${i + 1} é obrigatório.`); return; }
        if (!Number.isInteger(n.penalidadeDados) || n.penalidadeDados < 0 || n.penalidadeDados > 30) {
          setErroLocal(`Vitalidade: a penalidade de "${n.nome}" deve ser um número inteiro entre 0 e 30.`); return;
        }
      }
    }
    if (form.hp?.habilitado) {
      if (!Number.isFinite(form.hp.base) || form.hp.base < 0) { setErroLocal("Pontos de Vida: HP base deve ser um número maior ou igual a zero."); return; }
      if (!Number.isFinite(form.hp.porNivel) || form.hp.porNivel < 0) { setErroLocal("Pontos de Vida: HP por nível deve ser um número maior ou igual a zero."); return; }
    }
    if (form.dados && (!Number.isInteger(form.dados.d10SucessoMinimo) || form.dados.d10SucessoMinimo < 2 || form.dados.d10SucessoMinimo > 10)) {
      setErroLocal("Dados (D10): o sucesso mínimo deve ser um número inteiro entre 2 e 10."); return;
    }
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

      <h4>Poderes e defeitos</h4>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={!!form.poderes?.exigirDefeito}
          onChange={(e) => setForm((f) => ({ ...f, poderes: { ...(f.poderes ?? { limitePoderes: 1, exigirDefeito: false }), exigirDefeito: e.target.checked } }))}
        />
        Poder exige ao menos 1 defeito como contrapartida
      </label>
      <div className="grade-form">
        <label>Limite de poderes
          <select
            value={form.poderes?.limitePoderes == null ? "ilimitado" : String(form.poderes.limitePoderes)}
            onChange={(e) => setForm((f) => ({
              ...f,
              poderes: { ...(f.poderes ?? { limitePoderes: 1, exigirDefeito: false }), limitePoderes: e.target.value === "ilimitado" ? null : Number(e.target.value) },
            }))}
          >
            {[1, 2, 3, 5, 10].map((n) => <option key={n} value={n}>{n}</option>)}
            <option value="ilimitado">Sem limite</option>
          </select>
        </label>
        <label>Limite de defeitos
          <select
            value={form.poderes?.limiteDefeitos == null ? "ilimitado" : String(form.poderes.limiteDefeitos)}
            onChange={(e) => setForm((f) => ({
              ...f,
              poderes: { ...(f.poderes ?? { limitePoderes: 1, exigirDefeito: false }), limiteDefeitos: e.target.value === "ilimitado" ? null : Number(e.target.value) },
            }))}
          >
            <option value="ilimitado">Sem limite</option>
            {[1, 2, 3, 5, 10].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>
      <p className="dica">Vale para elementos dos tipos "Poder" e "Defeito" selecionados na ficha. Custos negativos de defeitos concedem pontos.</p>

      <h4>Pontos de Vida (HP)</h4>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={!!form.hp?.habilitado}
          onChange={(e) => setForm((f) => ({
            ...f,
            hp: { ...(f.hp ?? { habilitado: false, base: 100, porNivel: 20, edicaoPor: "mestre" }), habilitado: e.target.checked },
          }))}
        />
        Habilitar pontos de vida
      </label>
      {form.hp?.habilitado && (
        <div className="grade-form">
          <label>HP base
            <input type="number" min="0" value={form.hp.base} onChange={(e) => setForm((f) => ({ ...f, hp: { ...f.hp!, base: Number(e.target.value) } }))} />
          </label>
          <label>HP por nível do atributo
            <input type="number" min="0" value={form.hp.porNivel} onChange={(e) => setForm((f) => ({ ...f, hp: { ...f.hp!, porNivel: Number(e.target.value) } }))} />
          </label>
          <label className="span-2">Atributo da ficha (opcional — HP fixo = base se vazio)
            <select
              value={form.hp.campoId ?? (form.hp.semantico ? `sem:${form.hp.semantico}` : "")}
              onChange={(e) => {
                const v = e.target.value;
                const sem = v.startsWith("sem:") ? v.slice(4) : undefined;
                const campo = v && !sem ? camposHp?.find((c) => c.id === v) : undefined;
                setForm((f) => ({
                  ...f,
                  hp: {
                    ...f.hp!,
                    campoId: campo?.id,
                    // semantico fica como fallback se o campoId deixar de existir
                    semantico: campo ? (campo.semantico ?? undefined) : sem,
                  },
                }));
              }}
            >
              <option value="">— nenhum (HP fixo = base) —</option>
              {form.hp.semantico && !form.hp.campoId && (
                <option value={`sem:${form.hp.semantico}`}>Semântico: {form.hp.semantico}</option>
              )}
              {(camposHp ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}{c.semantico ? ` (${c.semantico})` : ""}{c.modelo ? ` — ${c.modelo}` : ""}
                </option>
              ))}
              {form.hp.campoId && camposHp !== null && !camposHp.some((c) => c.id === form.hp!.campoId) && (
                <option value={form.hp.campoId}>Campo atual ({form.hp.campoId})</option>
              )}
            </select>
            <small className="meta">
              Escolha o campo numérico da ficha publicado que alimenta o HP (ex.: Vigor).
              {camposHp === null && " Carregando campos das fichas…"}
              {camposHp?.length === 0 && " Nenhum campo numérico encontrado em versões publicadas — publique uma ficha com campos numéricos ou deixe vazio para HP fixo."}
            </small>
          </label>
          <label>Quem altera HP
            <select value={form.hp.edicaoPor} onChange={(e) => setForm((f) => ({ ...f, hp: { ...f.hp!, edicaoPor: e.target.value } }))}>
              <option value="mestre">Somente o mestre</option>
              <option value="ambos">Mestre e dono</option>
              <option value="jogador">Somente o dono</option>
            </select>
          </label>
        </div>
      )}
      <p className="dica">HP máximo = base + atributo × HP por nível. O HP atual começa cheio e o histórico de dano/recuperação fica na ficha do personagem.</p>

      <h4>Vitalidade</h4>
      <p className="dica">Escala ordenada de ferimentos. A penalidade remove dados das rolagens do personagem; "bloqueia" impede ações (o mestre pode autorizar exceção). A ordem da lista é a gravidade.</p>
      {(form.vitalidade?.niveis ?? []).map((n, i) => (
        <div className="linha-ferramentas" key={i}>
          <input type="text" value={n.nome} onChange={(e) => {
            const niveis = [...form.vitalidade!.niveis];
            niveis[i] = { ...n, nome: e.target.value };
            setForm((f) => ({ ...f, vitalidade: { ...f.vitalidade!, niveis } }));
          }} />
          <label className="checkbox-inline">−
            <input type="number" min="0" max="30" value={n.penalidadeDados} onChange={(e) => {
              const niveis = [...form.vitalidade!.niveis];
              const bruto = e.target.value.trim();
              niveis[i] = { ...n, penalidadeDados: bruto === "" ? 0 : Number(bruto.replace(",", ".")) };
              setForm((f) => ({ ...f, vitalidade: { ...f.vitalidade!, niveis } }));
            }} /> dados
          </label>
          <label className="checkbox-inline">
            <input type="checkbox" checked={n.bloqueiaAcoes} onChange={(e) => {
              const niveis = [...form.vitalidade!.niveis];
              niveis[i] = { ...n, bloqueiaAcoes: e.target.checked };
              setForm((f) => ({ ...f, vitalidade: { ...f.vitalidade!, niveis } }));
            }} /> bloqueia ações
          </label>
          <button type="button" className="mini perigo" onClick={() => {
            const niveis = form.vitalidade!.niveis.filter((_, j) => j !== i);
            setForm((f) => ({ ...f, vitalidade: { ...f.vitalidade!, niveis: niveis.length ? niveis : f.vitalidade!.niveis } }));
          }}>✕</button>
        </div>
      ))}
      <div className="linha-ferramentas">
        <button type="button" className="secundario" onClick={() => setForm((f) => ({
          ...f,
          vitalidade: { ...(f.vitalidade ?? { edicaoPor: "mestre" }), niveis: [...(f.vitalidade?.niveis ?? []), { nome: "Novo estado", penalidadeDados: 0, bloqueiaAcoes: false }] },
        }))}>+ Nível</button>
        <label>Quem altera vitalidade
          <select value={form.vitalidade?.edicaoPor ?? "mestre"} onChange={(e) => setForm((f) => {
            // Garante ao menos 1 nível — o backend exige min(1).
            const niveis = f.vitalidade?.niveis?.length
              ? f.vitalidade.niveis
              : [{ nome: "Sem ferimentos", penalidadeDados: 0, bloqueiaAcoes: false }];
            return { ...f, vitalidade: { ...(f.vitalidade ?? {}), edicaoPor: e.target.value, niveis } };
          })}>
            <option value="mestre">Somente o mestre</option>
            <option value="ambos">Mestre e dono</option>
            <option value="jogador">Somente o dono</option>
          </select>
        </label>
      </div>

      <h4>Dados (D10)</h4>
      <div className="grade-form">
        <label>Sucesso mínimo no D10
          <input
            type="number" min="2" max="10"
            value={form.dados?.d10SucessoMinimo ?? 6}
            onChange={(e) => setForm((f) => ({ ...f, dados: { d10SucessoMinimo: Number(e.target.value) } }))}
          />
        </label>
      </div>
      <p className="dica">Usado pelo lançador D10 da mesa: resultados iguais ou acima desse valor contam como sucesso.</p>

      <h4>Transferência entre reservas</h4>
      <label className="checkbox">
        <input type="checkbox" checked={form.transferivelEntreReservas} onChange={(e) => setForm((f) => ({ ...f, transferivelEntreReservas: e.target.checked }))} />
        Permitir transferência de pontos entre reservas (somente pelas arestas abaixo)
      </label>
      {form.transferivelEntreReservas && (
        <div>
          <p className="dica">Origem → destino: pontos da reserva de origem podem cobrir déficit da destino. Limite opcional por aresta. Crie arestas nos dois sentidos se a troca for mútua.</p>
          {(form.transferencias ?? []).map((t, i) => {
            const poolsIds = ["principal", ...form.pontos.pools.map((p) => p.id).filter(Boolean)];
            const unicos = [...new Set(poolsIds)];
            return (
              <div className="linha-ferramentas" key={i}>
                <select value={t.origem} onChange={(e) => {
                  const transferencias = [...form.transferencias];
                  transferencias[i] = { ...t, origem: e.target.value };
                  setForm((f) => ({ ...f, transferencias }));
                }}>
                  {unicos.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
                <span>→</span>
                <select value={t.destino} onChange={(e) => {
                  const transferencias = [...form.transferencias];
                  transferencias[i] = { ...t, destino: e.target.value };
                  setForm((f) => ({ ...f, transferencias }));
                }}>
                  {unicos.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
                <input type="number" placeholder="Limite (opcional)" value={t.limite ?? ""} onChange={(e) => {
                  const transferencias = [...form.transferencias];
                  transferencias[i] = { ...t, limite: e.target.value === "" ? undefined : Number(e.target.value) };
                  setForm((f) => ({ ...f, transferencias }));
                }} />
                <button type="button" className="mini perigo" onClick={() => setForm((f) => ({ ...f, transferencias: f.transferencias.filter((_, j) => j !== i) }))}>✕</button>
              </div>
            );
          })}
          <button type="button" className="secundario" onClick={() => setForm((f) => ({ ...f, transferencias: [...(f.transferencias ?? []), { origem: "principal", destino: "vantagens" }] }))}>+ Aresta de transferência</button>
        </div>
      )}

      {erroLocal && <div className="erro">{erroLocal}</div>}
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
    gruposExclusividade: (def.gruposExclusividade ?? []).join(", "),
    formulasTxt: Object.entries(def.formulas ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n"),
    reservaPontos: def.reservaPontos ?? "",
    prerequisitos: (def.prerequisitos ?? []).map((p) => `${p.kind}:${p.key}${p.minLevel ? `@${p.minLevel}` : ""}`).join(", "),
    obrigatorios: (def.obrigatorios ?? []).join(", "),
    niveis: (def.niveis ?? []).map((n) => ({ descricao: n.descricao ?? "", custo: n.custo?.toString() ?? "" })),
    disponivel: def.disponivel !== false,
  });
  const [erroForm, setErroForm] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErroForm(null);
    const erros: string[] = [];
    // Aceita decimal com vírgula (pt-BR) ou ponto; vazio = ausente; lixo = erro nomeado.
    const num = (s: string, campo: string) => {
      const t = s.trim();
      if (t === "") return undefined;
      const n = Number(t.replace(",", "."));
      if (Number.isNaN(n)) { erros.push(`${campo}: "${s}" não é um número válido`); return undefined; }
      return n;
    };
    const listaRefs = (s: string) => {
      const out: { kind: string; key: string; minLevel?: number }[] = [];
      for (const bruto of s.split(",")) {
        const x = bruto.trim();
        if (!x) continue;
        const [ref, min] = x.split("@");
        const [kind, ...rest] = ref.split(":");
        const key = rest.join(":").trim();
        if (!kind?.trim() || !key) { erros.push(`Pré-requisitos: "${x}" deve estar no formato tipo:chave`); continue; }
        let minLevel: number | undefined;
        if (min !== undefined) {
          const n = Number(min.trim());
          if (Number.isNaN(n)) { erros.push(`Pré-requisitos: nível inválido em "${x}"`); continue; }
          minLevel = n;
        }
        out.push({ kind: kind.trim(), key, ...(minLevel !== undefined ? { minLevel } : {}) });
      }
      return out;
    };
    const listaKeys = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
    const formulas: Record<string, string> = {};
    for (const linha of form.formulasTxt.split("\n")) {
      const m = linha.match(/^\s*([a-zA-Z_][\w]*)\s*:\s*(.+)$/);
      if (m) formulas[m[1]] = m[2].trim();
    }
    const custoProgressivo = (form.custoProgressivo || "")
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x !== "")
      .map((x) => {
        const n = Number(x.replace(",", "."));
        if (Number.isNaN(n)) erros.push(`Custo progressivo: "${x}" não é um número válido`);
        return n;
      })
      .filter((n) => !Number.isNaN(n));
    const niveis = form.niveis.map((n, i) => ({
      descricao: n.descricao.trim() || undefined,
      custo: num(n.custo, `Nível ${i + 1} (custo)`),
    }));
    const custoPontos = num(form.custoPontos, "Custo por ponto");
    const minimo = num(form.minimo, "Mínimo");
    const maximo = num(form.maximo, "Máximo");
    const prerequisitos = listaRefs(form.prerequisitos);
    if (erros.length) { setErroForm(erros.join(" · ")); return; }
    await onSalvar({
      kind: form.kind,
      key: form.key.trim(),
      name: form.name.trim(),
      category: form.category.trim() || undefined,
      definition: {
        descricao: form.descricao.trim() || undefined,
        custoPontos,
        custoProgressivo: custoProgressivo.length ? custoProgressivo : undefined,
        minimo,
        maximo,
        grupoExclusividade: form.grupoExclusividade.trim() || undefined,
        gruposExclusividade: listaKeys(form.gruposExclusividade),
        formulas: Object.keys(formulas).length ? formulas : undefined,
        reservaPontos: form.reservaPontos.trim() || undefined,
        prerequisitos,
        obrigatorios: listaKeys(form.obrigatorios),
        niveis: niveis.length ? niveis : undefined,
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
              <label>Chave (id único)<input value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} placeholder="ex.: telepatia" required /><small className="meta">Somente letras minúsculas, números e _ (sem acentos)</small></label>
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
          <label>Grupo de exclusividade (legado — um só)<input value={form.grupoExclusividade} onChange={(e) => setForm({ ...form, grupoExclusividade: e.target.value })} placeholder="elementos do mesmo grupo não combinam" /></label>
          <label>Grupos de exclusividade (vários, por vírgula)<input value={form.gruposExclusividade} onChange={(e) => setForm({ ...form, gruposExclusividade: e.target.value })} placeholder="ex.: poderes_ocultos, transformacoes" /></label>
          <label>Fórmulas (nome: expressão por linha)
            <textarea rows={3} value={form.formulasTxt} onChange={(e) => setForm({ ...form, formulasTxt: e.target.value })} placeholder={"bonus: {forca} * 2\ncusto: {destreza} + 1\nrequisito: {inteligencia}"} />
            <small className="meta">Use {"{campo}"} para referenciar campos da ficha. Chaves especiais: custo, requisito, minimo, maximo. Sem código arbitrário.</small>
          </label>
          <label>Pré-requisitos<input value={form.prerequisitos} onChange={(e) => setForm({ ...form, prerequisitos: e.target.value })} placeholder="tipo:chave@nível, separados por vírgula" /></label>
          <label>Elementos obrigatórios<input value={form.obrigatorios} onChange={(e) => setForm({ ...form, obrigatorios: e.target.value })} placeholder="tipo:chave, separados por vírgula" /></label>
          <div>
            <strong>Níveis graduados (1–5)</strong>
            <p className="dica">Para elementos com graus (ex.: defeitos): cada linha é um nível com descrição e custo incremental próprios. Custo negativo concede pontos. O número de linhas define o máximo de níveis.</p>
            {form.niveis.map((n, i) => (
              <div className="linha-ferramentas" key={i}>
                <span className="meta" style={{ minWidth: 56 }}>Nv. {i + 1}</span>
                <input placeholder="Descrição do nível" value={n.descricao} onChange={(e) => {
                  const niveis = [...form.niveis];
                  niveis[i] = { ...n, descricao: e.target.value };
                  setForm({ ...form, niveis });
                }} />
                <input type="number" step="any" placeholder="Custo (+gasta / −concede)" value={n.custo} onChange={(e) => {
                  const niveis = [...form.niveis];
                  niveis[i] = { ...n, custo: e.target.value };
                  setForm({ ...form, niveis });
                }} style={{ maxWidth: 170 }} />
                <button type="button" className="mini perigo" onClick={() => setForm({ ...form, niveis: form.niveis.filter((_, j) => j !== i) })}>✕</button>
              </div>
            ))}
            {form.niveis.length < 5 && (
              <button type="button" className="mini" onClick={() => setForm({ ...form, niveis: [...form.niveis, { descricao: "", custo: "" }] })}>+ Nível</button>
            )}
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={form.disponivel} onChange={(e) => setForm({ ...form, disponivel: e.target.checked })} />
            Disponível na campanha
          </label>
          {erroForm && <p className="erro">{erroForm}</p>}
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
