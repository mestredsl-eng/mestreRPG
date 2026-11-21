import { useEffect, useMemo, useRef, useState } from "react";
import { api, type ConfigAcaoRecuperacao, type ConfigCapacidadeSangue, type ConfigNaturezaSangue, type ConfigSangue, type ElementoRegra, type ModoCapacidadeSangue } from "../api";

/**
 * Painel "Pontos de Sangue" das Regras do mestre (Issue #186, C8-A).
 *
 * Edita SOMENTE `config.sangue` — o PUT /regras/config do servidor faz
 * merge parcial, então enviamos apenas a chave `sangue` e as demais
 * configurações são preservadas. A validação autoritativa (tipos de
 * campo por modo, mapa obrigatório, coeficiente, vínculos em TODAS as
 * estruturas ativas) continua no servidor — erros 400 são exibidos.
 *
 * Escopo: edita vínculos, capacidade, bônus, naturezas, custos por Poder
 * e quantidades de recuperação de Sangue já suportados pelo schema atual.
 * Ativar Poderes, debitar Sangue e executar ações de recuperação durante a
 * sessão pertencem ao runtime e não são acionados por esta tela.
 */

// Mesma classificação do servidor (regras.ts): tipos que produzem
// número direto / níveis somáveis / rótulo selecionável.
const TIPOS_VALOR = ["inteiro", "decimal", "moeda"];
const TIPOS_SOMA = ["selecao_nivel", "selecao_multipla", "lista"];
const TIPOS_MAPA = ["selecao_unica", "selecao_multipla", "selecao_nivel", "lista"];
const TIPOS_NATUREZA = TIPOS_MAPA;

const modoInferido = (tipo: string): ModoCapacidadeSangue =>
  TIPOS_VALOR.includes(tipo) ? "valor" : tipo === "selecao_nivel" ? "somaNiveis" : "mapa";
const modosCompativeis = (tipo: string): ModoCapacidadeSangue[] => {
  const m = modoInferido(tipo);
  if (m === "valor") return ["valor"];
  if (m === "somaNiveis") return ["somaNiveis", "mapa"];
  return ["mapa"];
};
const tipoCompativel = (tipo: string, modo: ModoCapacidadeSangue) =>
  modo === "valor" ? TIPOS_VALOR.includes(tipo)
    : modo === "somaNiveis" ? TIPOS_SOMA.includes(tipo)
    : TIPOS_MAPA.includes(tipo);

interface CampoFicha {
  id: string;
  label: string;
  tipo: string;
  semantico?: string;
  modelo: string;
  versao: number;
}

interface NaturezaForm { rotulo: string; metaHumano: boolean; recuperacao: "" | "descansar" | "alimentar" }
interface MapaLinha { rotulo: string; valor: string }

const msgErro = (e: unknown, padrao: string) => {
  if (e instanceof Error) return e.message;
  return padrao;
};

function MapaEditor({ mapa, aoMudar, idPrefixo }: {
  mapa: MapaLinha[];
  aoMudar: (linhas: MapaLinha[]) => void;
  idPrefixo: string;
}) {
  return (
    <div className="sangue-mapa">
      {mapa.map((l, i) => (
        <div className="linha" key={i}>
          <input
            aria-label={`${idPrefixo} rótulo ${i + 1}`}
            placeholder="Rótulo (ex.: Lobisomem)"
            value={l.rotulo}
            onChange={(e) => aoMudar(mapa.map((x, j) => j === i ? { ...x, rotulo: e.target.value } : x))}
          />
          <input
            aria-label={`${idPrefixo} capacidade ${i + 1}`}
            type="number" min={0} step="any" placeholder="Capacidade"
            value={l.valor}
            onChange={(e) => aoMudar(mapa.map((x, j) => j === i ? { ...x, valor: e.target.value } : x))}
          />
          <button type="button" className="secundario" onClick={() => aoMudar(mapa.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button type="button" className="secundario" onClick={() => aoMudar([...mapa, { rotulo: "", valor: "" }])}>
        + rótulo
      </button>
      <p className="meta">Modo “mapa”: cada rótulo do campo selecionado precisa de uma capacidade ≥ 0.</p>
    </div>
  );
}

function SeletorCampo({ campos, valor, rotuloVazio, onChange, filtroTipos, id, vazioBloqueado }: {
  campos: CampoFicha[] | null;
  valor: string | undefined;
  rotuloVazio: string;
  onChange: (id: string) => void;
  filtroTipos?: string[];
  id: string;
  /** Issue #223 P2: vínculo escalar não pode ser removido (merge parcial
   *  do servidor não tem tombstone) — esconde a opção vazia quando há
   *  valor, para a UI não prometer uma limpeza impossível. */
  vazioBloqueado?: boolean;
}) {
  const opcoes = useMemo(
    () => (campos ?? []).filter((c) => !filtroTipos || filtroTipos.includes(c.tipo)),
    [campos, filtroTipos],
  );
  const atualForaDaLista = valor && campos !== null && !opcoes.some((c) => c.id === valor);
  return (
    <select id={id} value={valor ?? ""} onChange={(e) => onChange(e.target.value)}>
      <option value="" disabled={vazioBloqueado === true && !!valor}>{rotuloVazio}</option>
      {opcoes.map((c) => (
        <option key={`${c.modelo}-${c.versao}-${c.id}`} value={c.id} title={c.id}>
          {c.label} ({c.tipo}) — {c.modelo} v{c.versao}
        </option>
      ))}
      {atualForaDaLista && <option value={valor}>Campo atual ({valor})</option>}
      {campos === null && <option value="" disabled>Carregando campos das fichas…</option>}
      {campos !== null && opcoes.length === 0 && <option value="" disabled>Nenhum campo elegível nas fichas publicadas</option>}
    </select>
  );
}

export default function RegrasSangue({ config, poderes, campaignId, onSalvar }: {
  config: ConfigSangue | undefined;
  /** Elementos kind="poder" do ruleset — chave do custo é `key`, nunca campoId. */
  poderes: ElementoRegra[];
  campaignId: string;
  onSalvar: (sangue: ConfigSangue) => Promise<void>;
}) {
  const [form, setForm] = useState<ConfigSangue>(() => ({ habilitado: false, ...config }));
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [campos, setCampos] = useState<CampoFicha[] | null>(null);
  const [bqAtivo, setBqAtivo] = useState(false);
  const [naturezas, setNaturezas] = useState<NaturezaForm[]>([]);
  const [custoPoderes, setCustoPoderes] = useState<Record<string, string>>({});
  const [acaoDescansar, setAcaoDescansar] = useState<{ on: boolean; qtd: string }>({ on: false, qtd: "" });
  const [acaoAlimentar, setAcaoAlimentar] = useState<{ on: boolean; qtd: string }>({ on: false, qtd: "" });
  const [mapaCap, setMapaCap] = useState<MapaLinha[]>([]);
  const [mapaBq, setMapaBq] = useState<MapaLinha[]>([]);
  // Issue #223 P2 — seções-objeto que existiam na config carregada:
  // esvaziá-las na UI deve enviar {} explícito (o servidor substitui o
  // objeto inteiro), em vez de omitir a chave e preservar o valor antigo.
  const secoesRef = useRef({ capacidade: false, naturezas: false, rec: false, poderes: false });

  // Formulário "sujo": sync externo (regras:atualizadas) atualiza o config
  // mas NÃO sobrescreve edições em andamento — o mestre reverte ou salva.
  const [sujo, setSujo] = useState(false);
  const aplicarDeConfig = (cfg: ConfigSangue | undefined) => {
    secoesRef.current = {
      capacidade: !!cfg?.capacidade && Object.values(cfg.capacidade).some((v) => v !== undefined),
      naturezas: !!cfg?.naturezas && Object.keys(cfg.naturezas).length > 0,
      rec: !!cfg?.recuperacaoSangue && Object.keys(cfg.recuperacaoSangue).length > 0,
      poderes: !!cfg?.poderes && Object.keys(cfg.poderes).length > 0,
    };
    setForm({ habilitado: false, ...cfg });
    const bq = cfg?.capacidade?.bonusQualidade;
    setBqAtivo(!!bq && Object.values(bq).some((v) => v !== undefined));
    setNaturezas(Object.entries(cfg?.naturezas ?? {}).map(([rotulo, n]) => ({
      rotulo, metaHumano: n.metaHumanoComPoder === true,
      recuperacao: (n.recuperacao ?? "") as NaturezaForm["recuperacao"],
    })));
    setCustoPoderes(Object.fromEntries(Object.entries(cfg?.poderes ?? {}).map(([k, v]) => [k, String(v.custo)])));
    const acoes = cfg?.recuperacaoSangue?.acoes;
    setAcaoDescansar({ on: acoes?.descansar?.habilitada === true, qtd: acoes?.descansar?.quantidade !== undefined ? String(acoes.descansar.quantidade) : "" });
    setAcaoAlimentar({ on: acoes?.alimentar?.habilitada === true, qtd: acoes?.alimentar?.quantidade !== undefined ? String(acoes.alimentar.quantidade) : "" });
    setMapaCap(Object.entries(cfg?.capacidade?.mapa ?? {}).map(([rotulo, valor]) => ({ rotulo, valor: String(valor) })));
    setMapaBq(Object.entries(bq?.mapa ?? {}).map(([rotulo, valor]) => ({ rotulo, valor: String(valor) })));
  };
  useEffect(() => {
    if (!sujo) aplicarDeConfig(config);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);

  // Campos de TODAS as versões publicadas dos modelos ativos — personagens
  // podem estar vinculados a versões anteriores; a validação definitiva
  // (vínculo presente em toda estrutura ativa) é do servidor.
  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const { modelos } = await api.listarModelos(campaignId);
        const achados = new Map<string, CampoFicha>();
        for (const m of modelos.filter((x) => x.isActive)) {
          try {
            const { versoes } = await api.obterModelo(campaignId, m.id);
            for (const v of versoes.filter((x) => x.publishedAt && x.estrutura)) {
              for (const s of v.estrutura?.secoes ?? []) {
                for (const c of s.campos ?? []) {
                  const chave = `${c.id}`;
                  // dedup por id: primeira ocorrência (versão mais recente primeiro)
                  if (!achados.has(chave)) {
                    achados.set(chave, {
                      id: c.id, label: c.label, tipo: c.tipo,
                      semantico: c.semantico && c.semantico !== "livre" ? c.semantico : undefined,
                      modelo: m.name, versao: v.version,
                    });
                  }
                }
              }
            }
          } catch { /* modelo ilegível — ignora */ }
        }
        if (vivo) setCampos([...achados.values()]);
      } catch {
        if (vivo) setCampos([]);
      }
    })();
    return () => { vivo = false; };
  }, [campaignId]);

  const campoCap = campos?.find((c) => c.id === form.campoCapacidadeId);
  const campoBq = campos?.find((c) => c.id === form.capacidade?.bonusQualidade?.campoId);

  const setCap = (patch: Partial<ConfigCapacidadeSangue> | undefined) =>
    setForm((f) => {
      const cap = { ...(f.capacidade ?? {}), ...(patch ?? {}) };
      const limpo = Object.fromEntries(Object.entries(cap).filter(([, v]) => v !== undefined)) as ConfigCapacidadeSangue;
      const { capacidade: _antiga, ...resto } = f;
      return { ...resto, ...(Object.keys(limpo).length ? { capacidade: limpo } : {}) };
    });

  const montarPayload = (): ConfigSangue => {
    const s: ConfigSangue = { habilitado: form.habilitado === true };
    if (form.campoCapacidadeId) s.campoCapacidadeId = form.campoCapacidadeId;
    if (form.campoNaturezaId) s.campoNaturezaId = form.campoNaturezaId;
    const cap: ConfigCapacidadeSangue = {};
    const modoCap = form.capacidade?.modo;
    if (modoCap) cap.modo = modoCap;
    if (modoCap === "mapa" || (!modoCap && campoCap && modoInferido(campoCap.tipo) === "mapa")) {
      const mapa: Record<string, number> = {};
      for (const l of mapaCap) {
        if (!l.rotulo.trim() || l.valor.trim() === "") continue;
        const n = Number(l.valor);
        if (Number.isFinite(n) && n >= 0) mapa[l.rotulo.trim()] = n;
      }
      if (Object.keys(mapa).length) cap.mapa = mapa;
    }
    if (bqAtivo) {
      const bq = form.capacidade?.bonusQualidade ?? {};
      const nbq: NonNullable<ConfigCapacidadeSangue["bonusQualidade"]> = {};
      if (bq.campoId) nbq.campoId = bq.campoId;
      if (bq.coeficiente !== undefined && Number.isFinite(bq.coeficiente)) nbq.coeficiente = bq.coeficiente;
      if (bq.modo) nbq.modo = bq.modo;
      const modoBq = bq.modo ?? (campoBq ? modoInferido(campoBq.tipo) : undefined);
      if (modoBq === "mapa") {
        const mapa: Record<string, number> = {};
        for (const l of mapaBq) {
          if (!l.rotulo.trim() || l.valor.trim() === "") continue;
          const n = Number(l.valor);
          if (Number.isFinite(n) && n >= 0) mapa[l.rotulo.trim()] = n;
        }
        if (Object.keys(mapa).length) nbq.mapa = mapa;
      }
      if (Object.keys(nbq).length) cap.bonusQualidade = nbq;
    }
    if (Object.keys(cap).length || secoesRef.current.capacidade) s.capacidade = cap;
    const nats: Record<string, ConfigNaturezaSangue> = {};
    for (const n of naturezas) {
      if (!n.rotulo.trim()) continue;
      const entrada: ConfigNaturezaSangue = {};
      if (n.metaHumano) entrada.metaHumanoComPoder = true;
      if (n.recuperacao) entrada.recuperacao = n.recuperacao;
      nats[n.rotulo.trim()] = entrada;
    }
    if (Object.keys(nats).length || secoesRef.current.naturezas) s.naturezas = nats;
    const recSangue: NonNullable<ConfigSangue["recuperacaoSangue"]> = {};
    if (form.recuperacaoSangue?.habilitado) recSangue.habilitado = true;
    const montarAcao = (a: { on: boolean; qtd: string }): ConfigAcaoRecuperacao | undefined => {
      if (!a.on) return undefined; // ação desabilitada = ausente (inerte)
      // qtd vazia → quantidade ausente (servidor rejeita: fail-closed).
      // Number("") seria 0 — nunca enviar zero disfarçado.
      const q = a.qtd.trim() === "" ? NaN : Number(a.qtd);
      return { habilitada: true, quantidade: Number.isFinite(q) ? q : undefined };
    };
    const aD = montarAcao(acaoDescansar);
    const aA = montarAcao(acaoAlimentar);
    if (aD || aA) recSangue.acoes = { ...(aD ? { descansar: aD } : {}), ...(aA ? { alimentar: aA } : {}) };
    if (Object.keys(recSangue).length || secoesRef.current.rec) s.recuperacaoSangue = recSangue;
    const pds: Record<string, { custo: number }> = {};
    for (const [key, txt] of Object.entries(custoPoderes)) {
      if (txt.trim() === "") continue; // vazio = gratuito (sem entrada)
      const n = Number(txt);
      if (Number.isFinite(n) && n >= 0) pds[key] = { custo: n };
    }
    if (Object.keys(pds).length || secoesRef.current.poderes) s.poderes = pds;
    return s;
  };

  const salvar = async () => {
    setErro(null); setAviso(null);
    const custoInvalido = Object.entries(custoPoderes).find(([key, txt]) => {
      if (txt.trim() === "") return false; // vazio = gratuito
      const n = Number(txt);
      return !Number.isFinite(n) || n < 0;
    });
    if (custoInvalido) {
      const [key] = custoInvalido;
      const nome = poderes.find((p) => p.key === key)?.name ?? key;
      setErro(`Custo de Sangue inválido para ${nome}: informe um número finito maior ou igual a zero, ou deixe vazio para gratuito.`);
      setSujo(true);
      return; // não chamar onSalvar: nenhuma configuração é enviada
    }
    setSalvando(true);
    try {
      await onSalvar(montarPayload());
      setSujo(false);
      setAviso("Configuração de Pontos de Sangue salva.");
    } catch (e) {
      setErro(msgErro(e, "Erro ao salvar configuração de Sangue"));
    } finally {
      setSalvando(false);
    }
  };

  const bq = form.capacidade?.bonusQualidade;
  const modoBqEfetivo = bq?.modo ?? (campoBq ? modoInferido(campoBq.tipo) : undefined);
  const precisaMapaCap = (form.capacidade?.modo ?? (campoCap ? modoInferido(campoCap.tipo) : undefined)) === "mapa";

  return (
    <section className="cartao painel-sangue" onChangeCapture={() => setSujo(true)}>
      <h3>Pontos de Sangue</h3>
      <p className="dica">
        Esta tela configura vínculos de ficha, capacidade, bônus, naturezas,
        custos por Poder e quantidades de recuperação de Sangue.
        Ativar Poderes, debitar Sangue e executar ações de recuperação durante
        a sessão ainda dependem das etapas de runtime; esta tela apenas salva
        a configuração.
      </p>

      <label className="check">
        <input
          type="checkbox"
          aria-label="Habilitar Pontos de Sangue"
          checked={form.habilitado === true}
          onChange={(e) => setForm((f) => ({ ...f, habilitado: e.target.checked }))}
        />
        Habilitar Pontos de Sangue nesta campanha
      </label>
      {form.habilitado === true && !form.campoCapacidadeId && (
        <p className="meta">O servidor exige o vínculo do campo de capacidade para habilitar.</p>
      )}

      <h4>Capacidade</h4>
      <label>Campo de capacidade
        <SeletorCampo
          id="sangue-campo-capacidade"
          campos={campos}
          valor={form.campoCapacidadeId}
          rotuloVazio="— selecionar campo —"
          filtroTipos={[...TIPOS_VALOR, ...TIPOS_SOMA, ...TIPOS_MAPA]}
          vazioBloqueado
          onChange={(v) => {
            setForm((f) => ({ ...f, campoCapacidadeId: v || undefined }));
            // modo explícito incompatível com o novo campo é descartado
            setForm((f) => {
              const cap = f.capacidade;
              if (!cap?.modo || !v) return f;
              const novo = campos?.find((c) => c.id === v);
              if (novo && !tipoCompativel(novo.tipo, cap.modo)) {
                const { modo: _m, ...resto } = cap;
                return { ...f, capacidade: Object.keys(resto).length ? resto : undefined };
              }
              return f;
            });
          }}
        />
      </label>
      {campoCap && (
        <label>Modo de leitura da capacidade
          <select
            aria-label="Modo de leitura da capacidade"
            value={form.capacidade?.modo ?? modoInferido(campoCap.tipo)}
            onChange={(e) => {
              const modo = e.target.value as ModoCapacidadeSangue;
              setCap({ modo });
              if (modo !== "mapa") setMapaCap([]);
            }}
          >
            {modosCompativeis(campoCap.tipo).map((m) => (
              <option key={m} value={m}>{m === "valor" ? "valor (número direto)" : m === "somaNiveis" ? "somaNiveis (níveis/itens)" : "mapa (rótulo → capacidade)"}</option>
            ))}
          </select>
        </label>
      )}
      {precisaMapaCap && (
        <MapaEditor mapa={mapaCap} aoMudar={setMapaCap} idPrefixo="capacidade" />
      )}

      <h4>Bônus por qualidade (opcional)</h4>
      <label className="check">
        <input type="checkbox" aria-label="Configurar bônus de qualidade" checked={bqAtivo} onChange={(e) => {
          setBqAtivo(e.target.checked);
          if (!e.target.checked) setCap({ bonusQualidade: undefined });
          else setCap({ bonusQualidade: {} });
        }} />
        Configurar bônus de qualidade
      </label>
      {bqAtivo && (
        <>
          <label>Campo de qualidade
            <SeletorCampo
              id="sangue-campo-qualidade"
              campos={campos}
              valor={bq?.campoId}
              rotuloVazio="— selecionar campo —"
              filtroTipos={[...TIPOS_VALOR, ...TIPOS_SOMA, ...TIPOS_MAPA]}
              onChange={(v) => setCap({
                bonusQualidade: { ...(form.capacidade?.bonusQualidade ?? {}), campoId: v || undefined },
              })}
            />
          </label>
          <label>Coeficiente (obrigatório com qualquer opção de qualidade)
            <input
              type="number" min={0} step="any"
              aria-label="Coeficiente do bônus de qualidade"
              value={bq?.coeficiente ?? ""}
              onChange={(e) => setCap({
                bonusQualidade: {
                  ...(form.capacidade?.bonusQualidade ?? {}),
                  coeficiente: e.target.value === "" ? undefined : Number(e.target.value),
                },
              })}
            />
          </label>
          {campoBq && (
            <label>Modo do bônus
              <select
                aria-label="Modo do bônus de qualidade"
                value={bq?.modo ?? modoInferido(campoBq.tipo)}
                onChange={(e) => {
                  const modo = e.target.value as ModoCapacidadeSangue;
                  setCap({ bonusQualidade: { ...(form.capacidade?.bonusQualidade ?? {}), modo } });
                  if (modo !== "mapa") setMapaBq([]);
                }}
              >
                {modosCompativeis(campoBq.tipo).map((m) => (
                  <option key={m} value={m}>{m === "valor" ? "valor" : m === "somaNiveis" ? "somaNiveis" : "mapa"}</option>
                ))}
              </select>
            </label>
          )}
          {modoBqEfetivo === "mapa" && (
            <MapaEditor mapa={mapaBq} aoMudar={setMapaBq} idPrefixo="qualidade" />
          )}
        </>
      )}

      <h4>Natureza do personagem (opcional)</h4>
      <label>Campo de natureza
        <SeletorCampo
          id="sangue-campo-natureza"
          campos={campos}
          valor={form.campoNaturezaId}
          rotuloVazio="— sem vínculo de natureza —"
          filtroTipos={TIPOS_NATUREZA}
          vazioBloqueado
          onChange={(v) => setForm((f) => ({ ...f, campoNaturezaId: v || undefined }))}
        />
      </label>
      {(form.campoCapacidadeId || form.campoNaturezaId) && (
        <p className="meta">Os vínculos de campo não podem ser removidos — o merge parcial do servidor preserva valores omitidos. Para trocar, selecione outro campo.</p>
      )}
      <p className="meta">A natureza é opcional: sem ela o recurso funciona, mas “Meta humano com Poder” não pode ser determinada.</p>

      <h4>Rótulos de natureza</h4>
      <p className="meta">Rótulos são livres — o mestre define os nomes que o campo de natureza pode produzir. Natureza sem mapeamento permanece desconhecida.</p>
      {naturezas.map((n, i) => (
        <div className="sangue-natureza" key={i}>
          <div className="linha">
            <input
              aria-label={`Natureza ${i + 1} rótulo`}
              placeholder="Rótulo (ex.: Vampiro)"
              value={n.rotulo}
              onChange={(e) => setNaturezas(naturezas.map((x, j) => j === i ? { ...x, rotulo: e.target.value } : x))}
            />
            <label className="check">
              <input
                type="checkbox"
                aria-label={`Meta humano com Poder natureza ${i + 1}`}
                checked={n.metaHumano}
                onChange={(e) => setNaturezas(naturezas.map((x, j) => j === i ? { ...x, metaHumano: e.target.checked } : x))}
              />
              Meta humano com Poder
            </label>
            <button type="button" className="secundario" onClick={() => setNaturezas(naturezas.filter((_, j) => j !== i))}>✕</button>
          </div>
          <select
            aria-label={`Natureza ${i + 1} ação de recuperação`}
            value={n.recuperacao}
            onChange={(e) => setNaturezas(naturezas.map((x, j) => j === i ? { ...x, recuperacao: e.target.value as NaturezaForm["recuperacao"] } : x))}
          >
            <option value="">— sem ação de recuperação —</option>
            <option value="descansar">Descansar</option>
            <option value="alimentar">Alimentar-se</option>
          </select>
        </div>
      ))}
      <button type="button" className="secundario" onClick={() => setNaturezas([...naturezas, { rotulo: "", metaHumano: false, recuperacao: "" }])}>
        + natureza
      </button>

      <h4>Poderes — custo de Sangue por ativação</h4>
      {poderes.length === 0 ? (
        <p className="meta">Nenhum Poder cadastrado na biblioteca de regras desta campanha.</p>
      ) : (
        <>
          <p className="meta">Custo em pontos de Sangue debitado a cada ativação do Poder. Campo vazio = gratuito; zero é válido.</p>
          {poderes.map((p) => (
            <div className="linha" key={p.key}>
              <span>{p.name} <span className="meta">({p.key})</span></span>
              <input
                aria-label={`Custo de Sangue do Poder ${p.name}`}
                type="number" min={0} step="any" placeholder="gratuito"
                value={custoPoderes[p.key] ?? ""}
                onChange={(e) => setCustoPoderes((m) => ({ ...m, [p.key]: e.target.value }))}
              />
            </div>
          ))}
        </>
      )}

      <h4>Recuperação de Sangue</h4>
      <label className="check">
        <input
          type="checkbox"
          aria-label="Habilitar sinalizador de recuperação"
          checked={form.recuperacaoSangue?.habilitado === true}
          onChange={(e) => setForm((f) => ({ ...f, recuperacaoSangue: e.target.checked ? { habilitado: true } : undefined }))}
        />
        Habilitar sinalizador de recuperação de Sangue
      </label>
      <h5>Ações de recuperação (opcional)</h5>
      <p className="meta">Cada ação exige quantidade quando habilitada. Ação desabilitada/ausente não recupera Sangue. O vínculo natureza→ação é definido nos rótulos acima.</p>
      {([["descansar", "Descansar", acaoDescansar, setAcaoDescansar], ["alimentar", "Alimentar-se", acaoAlimentar, setAcaoAlimentar]] as const).map(([id, rotulo, estado, setEstado]) => (
        <div className="linha" key={id}>
          <label className="check">
            <input
              type="checkbox"
              aria-label={`Habilitar ação ${rotulo}`}
              checked={estado.on}
              onChange={(e) => setEstado({ on: e.target.checked, qtd: estado.qtd })}
            />
            {rotulo}
          </label>
          {estado.on && (
            <input
              aria-label={`Quantidade de Sangue — ${rotulo}`}
              type="number" min={0} step="any" placeholder="quantidade"
              value={estado.qtd}
              onChange={(e) => setEstado({ on: estado.on, qtd: e.target.value })}
            />
          )}
        </div>
      ))}

      {erro && <p className="erro">{erro}</p>}
      {aviso && <p className="online">{aviso}</p>}
      <div className="linha">
        <button type="button" onClick={() => void salvar()} disabled={salvando}>
          {salvando ? "Salvando…" : "Salvar Pontos de Sangue"}
        </button>
        <button
          type="button" className="secundario" disabled={salvando}
          onClick={() => { aplicarDeConfig(config); setSujo(false); setErro(null); setAviso(null); }}
        >
          Reverter alterações
        </button>
      </div>
    </section>
  );
}
