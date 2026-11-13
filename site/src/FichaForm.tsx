import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type CampoDef, type ConfigPoderes, type ElementoVinculavel, type EstruturaFicha, type PoolPontos, type ResultadoPontos, type SimulacaoResultado, type VidaResumo } from "./api";
import { AjudaPopover } from "./Modal";

/**
 * Renderiza a ficha a partir da estrutura JSON — sem nenhum campo fixo.
 * Usado na criação, edição e visualização de personagens.
 */

interface Props {
  estrutura: EstruturaFicha;
  valores: Record<string, unknown>;
  calculados?: Record<string, number | string>;
  somenteLeitura?: boolean;
  aoMudar?: (campoId: string, valor: unknown) => void;
  /** Biblioteca de regras da campanha (Etapa 5): campos com regraKind usam estas opções. */
  biblioteca?: Record<string, ElementoVinculavel[]>;
  /** Personagem dono da ficha — habilita a prévia de pontos em tempo real (sem salvar). */
  personagemId?: string;
  /** Saldo de pontos já calculado pelo servidor para os dados atuais. */
  pontosInicial?: ResultadoPontos;
  /** Config Poderes×Defeitos da campanha — UX de limite/aviso (backend valida). */
  poderesCfg?: ConfigPoderes | null;
  /** Resumos de carteira calculados no servidor (saldo inicial/entradas/saídas/saldo). */
  carteiras?: Record<string, { saldoInicial: number; entradas: number; saidas: number; saldo: number }>;
  /** Papel do usuário — controla se o saldo inicial da carteira é editável. */
  ehMestre?: boolean;
  /** Simulador do editor de fichas: prévia de pontos+regras sem personagem
   *  (POST /regras/simulacao — somente leitura, nada é gravado). */
  simulacao?: { campaignId: string; pontosFicticios?: number | null };
  /** IDs de campos com erro de validação do salvamento — destacam visualmente. */
  camposComErro?: ReadonlySet<string>;
}

/** Contexto de pontos repassado aos campos que participam da distribuição. */
interface ContextoPontos {
  pontos: ResultadoPontos | null;
  cfg: EstruturaFicha["pontos"];
  custoDe: (campoId: string) => number;
  poolDe: (poolId: string) => PoolPontos | undefined;
}

export default function FichaForm({ estrutura, valores, calculados = {}, somenteLeitura = false, aoMudar, biblioteca, personagemId, pontosInicial, poderesCfg, carteiras, ehMestre, simulacao, camposComErro }: Props) {
  const [pontos, setPontos] = useState<ResultadoPontos | null>(pontosInicial ?? null);
  const [avisoPoder, setAvisoPoder] = useState<string | null>(null);
  const [sim, setSim] = useState<SimulacaoResultado | null>(null);
  // Erros de regras vindos da prévia do personagem (pontos-previa) — mesmo
  // pipeline do simulador, exibidos no bloco .simulacao-erros.
  const [errosPrevia, setErrosPrevia] = useState<{ campoId?: string; codigo: string; mensagem: string }[] | null>(null);

  // Prévia de pontos: recalcula no servidor (mesmo pipeline do GET/PATCH) com
  // debounce a cada alteração da ficha. Em modo leitura usa o valor inicial.
  // No simulador do editor usa POST /regras/simulacao (sem personagem).
  useEffect(() => {
    const usarSimulacao = !!simulacao && !somenteLeitura;
    const usarPrevia = !!personagemId && !somenteLeitura && !usarSimulacao;
    if (!usarSimulacao && !usarPrevia) {
      setPontos(pontosInicial ?? null);
      setSim(null);
      setErrosPrevia(null);
      return;
    }
    let vivo = true;
    const timer = setTimeout(() => {
      const promessa = usarSimulacao
        ? api.simularFicha(simulacao!.campaignId, {
            estrutura,
            dados: valores,
            pontosFicticios: simulacao!.pontosFicticios ?? undefined,
          })
        : api.previaPontos(personagemId!, valores).then((r) => ({
            ok: true, erros: r.validacao?.erros ?? [], calculos: {}, pontos: r.pontos,
            pontosCfg: undefined as unknown as EstruturaFicha["pontos"],
          }));
      promessa
        .then((r) => {
          if (!vivo) return;
          setPontos(r.pontos);
          if (usarSimulacao) { setSim(r as SimulacaoResultado); setErrosPrevia(null); }
          else { setSim(null); setErrosPrevia((r as { erros?: { campoId?: string; codigo: string; mensagem: string }[] }).erros ?? []); }
        })
        .catch(() => { /* prévia é best-effort; a validação real é do PATCH */ });
    }, 300);
    return () => { vivo = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valores, somenteLeitura, personagemId, estrutura, simulacao?.campaignId, simulacao?.pontosFicticios]);

  // Config de pontos efetiva: no simulador vem do servidor (ruleset da
  // campanha tem prioridade sobre estrutura.pontos); fora dele, a da ficha.
  const cfgPontos = sim?.pontosCfg ?? estrutura.pontos;
  const ctxPontos = useMemo<ContextoPontos | null>(() => {
    if (!cfgPontos?.habilitado && !pontos?.habilitado) return null;
    return {
      pontos,
      cfg: cfgPontos,
      custoDe: (id) => pontos?.detalhes.find((d) => d.campoId === id)?.custo ?? 0,
      poolDe: (id) => pontos?.pools.find((p) => p.id === id),
    };
  }, [pontos, cfgPontos]);

  // ---- Poderes × Defeitos (UX; a validação real é do backend) ----
  const todosOsCampos = useMemo(() => estrutura.secoes.flatMap((s) => s.campos), [estrutura]);
  const ehPoder = (c: CampoDef) => c.regraKind === "poder" || c.regra?.kind === "poder";
  const ehDefeito = (c: CampoDef) => c.regraKind === "defeito" || c.regra?.kind === "defeito";
  const camposPoder = useMemo(() => todosOsCampos.filter(ehPoder), [todosOsCampos]); // eslint-disable-line react-hooks/exhaustive-deps
  const camposDefeito = useMemo(() => todosOsCampos.filter(ehDefeito), [todosOsCampos]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Chaves de elementos selecionadas num campo (strings ou {key,nivel}). */
  const chavesSelecionadas = (c: CampoDef): string[] => {
    const v = valores[c.id];
    if (Array.isArray(v)) {
      return v
        .map((x) => (typeof x === "object" && x !== null ? String((x as { key?: unknown }).key ?? "") : String(x)))
        .filter(Boolean);
    }
    return typeof v === "string" && v ? [v] : [];
  };

  const poderesSelecionados = useMemo(() => {
    const s = new Set<string>();
    for (const c of camposPoder) for (const k of chavesSelecionadas(c)) s.add(k);
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camposPoder, valores]);

  const defeitosSelecionados = useMemo(() => {
    const s = new Set<string>();
    for (const c of camposDefeito) for (const k of chavesSelecionadas(c)) s.add(k);
    return s;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camposDefeito, valores]);

  const faltaDefeito = !!poderesCfg?.exigirDefeito && poderesSelecionados.size > 0 && defeitosSelecionados.size === 0;

  /**
   * Alterna um poder respeitando o limite configurado.
   * limite=1 → selecionar outro substitui o anterior; limite=N → bloqueia
   * com aviso; null → comportamento normal de múltipla escolha.
   */
  const alternarPoder = (campo: CampoDef, op: string) => {
    setAvisoPoder(null);
    if (!aoMudar) return;
    const atuais = chavesSelecionadas(campo);
    const marcando = op !== "" && !atuais.includes(op);
    if (!marcando) {
      // desmarcar (ou limpar seleção única)
      aoMudar(campo.id, campo.tipo === "selecao_unica" ? "" : atuais.filter((k) => k !== op));
      return;
    }
    const limite = poderesCfg?.limitePoderes ?? null;
    if (limite != null) {
      const outros = new Set<string>();
      for (const c of camposPoder) {
        if (c.id === campo.id) continue;
        for (const k of chavesSelecionadas(c)) outros.add(k);
      }
      for (const k of atuais) if (k !== op) outros.add(k);
      if (outros.size + 1 > limite) {
        setAvisoPoder(
          limite === 1
            ? `Limite de poderes: apenas 1 poder por personagem — desmarque o poder atual antes de escolher outro.`
            : `Limite de ${limite} poderes atingido — remova um poder antes de escolher outro.`
        );
        return;
      }
    }
    aoMudar(campo.id, campo.tipo === "selecao_unica" ? op : [...atuais, op]);
  };

  return (
    <div className="ficha">
      {ctxPontos && (ctxPontos.pontos || personagemId || simulacao) && <PainelPontos ctx={ctxPontos} />}
      {sim?.vida && <PainelVidaSim vida={sim.vida} />}
      {avisoPoder && <div className="ficha-aviso">{avisoPoder}</div>}
      {faltaDefeito && (
        <div className="ficha-aviso">
          Poderes exigem ao menos 1 defeito como contrapartida — escolha um defeito para liberar o poder.
        </div>
      )}
      {(sim?.erros ?? errosPrevia ?? []).filter((e) => e.codigo !== "pontos").length > 0 && (
        <div className="ficha-aviso simulacao-erros">
          <strong>Regras ({(sim?.erros ?? errosPrevia ?? []).filter((e) => e.codigo !== "pontos").length}):</strong>
          <ul>
            {(sim?.erros ?? errosPrevia ?? []).filter((e) => e.codigo !== "pontos").map((e, i) => <li key={i}>{e.mensagem}</li>)}
          </ul>
        </div>
      )}
      {estrutura.secoes.filter((s) => !s.parentId).length >= 3 && (
        <nav className="ficha-navegacao" aria-label="Navegação das seções da ficha">
          <span className="ficha-navegacao-titulo">Ir para:</span>
          {estrutura.secoes
            .filter((s) => !s.parentId)
            .sort((a, b) => a.ordem - b.ordem)
            .map((secao, indice) => (
              <button
                key={secao.id}
                type="button"
                className="mini secundario"
                onClick={() => document.getElementById(`ficha-secao-${indice}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
              >
                {secao.titulo}
              </button>
            ))}
        </nav>
      )}
      {estrutura.secoes
        .filter((s) => !s.parentId)
        .sort((a, b) => a.ordem - b.ordem)
        .map((secao, indice) => {
          const subsecoes = estrutura.secoes.filter((s) => s.parentId === secao.id);
          // Seções densas (2+ campos de seleção de biblioteca) precisam de
          // mais largura para não virar uma lista vertical interminável.
          const camposDaSecao = [...secao.campos, ...subsecoes.flatMap((s) => s.campos)];
          const densa = camposDaSecao.filter((c) => TIPOS_SELECAO.has(c.tipo)).length >= 2;
          return (
            <div key={secao.id} id={`ficha-secao-${indice}`} className={`ficha-secao${indice === 0 ? " ficha-secao-capa" : ""}${densa ? " ficha-secao-densa" : ""}`}>
              <h3>{secao.titulo}</h3>
              {secao.descricao && <p className="meta">{secao.descricao}</p>}
              {secao.campos.map((campo, ci) => (
                <CampoInput key={campo.id} campo={campo} valor={valores[campo.id]} calculado={calculados[campo.id]} somenteLeitura={somenteLeitura || campo.editavel === false} aoMudar={aoMudar} biblioteca={biblioteca} ctxPontos={ctxPontos} aoAlternarPoder={ehPoder(campo) ? alternarPoder : undefined} carteiraResumo={carteiras?.[campo.id]} saldoEnviado={valores[`${campo.id}::saldo`]} ehMestre={ehMestre} destaque={indice === 0 && ci === 0} comErro={camposComErro?.has(campo.id)} />
              ))}
              {subsecoes.length > 0 && (
                <div className="ficha-subsecoes">
                  {subsecoes.map((sub) => (
                    <div key={sub.id} className="ficha-subsecao">
                      <h4>{sub.titulo}</h4>
                      {sub.campos.map((campo) => (
                        <CampoInput key={campo.id} campo={campo} valor={valores[campo.id]} calculado={calculados[campo.id]} somenteLeitura={somenteLeitura || campo.editavel === false} aoMudar={aoMudar} biblioteca={biblioteca} ctxPontos={ctxPontos} aoAlternarPoder={ehPoder(campo) ? alternarPoder : undefined} carteiraResumo={carteiras?.[campo.id]} saldoEnviado={valores[`${campo.id}::saldo`]} ehMestre={ehMestre} comErro={camposComErro?.has(campo.id)} />
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}

/** Tipos que precisam da largura toda da seção (listas, tabelas, textos longos). */
const TIPOS_LARGOS = new Set(["texto_longo", "tabela", "selecao_nivel", "selecao_multipla", "lista"]);

/** Tipos de campo que listam elementos da biblioteca/opções — indicam seção densa. */
const TIPOS_SELECAO = new Set(["selecao_nivel", "selecao_multipla", "lista"]);

function CampoInput({ campo, valor, calculado, somenteLeitura, aoMudar, biblioteca, ctxPontos, aoAlternarPoder, carteiraResumo, saldoEnviado, ehMestre, comErro, destaque }: {
  campo: CampoDef;
  valor: unknown;
  calculado?: number | string;
  somenteLeitura: boolean;
  aoMudar?: (id: string, v: unknown) => void;
  biblioteca?: Record<string, ElementoVinculavel[]>;
  ctxPontos?: ContextoPontos | null;
  aoAlternarPoder?: (campo: CampoDef, op: string) => void;
  carteiraResumo?: { saldoInicial: number; entradas: number; saidas: number; saldo: number };
  saldoEnviado?: unknown;
  ehMestre?: boolean;
  /** Campo apontado por erro de validação — ganha destaque e âncora de navegação. */
  comErro?: boolean;
  /** Primeiro campo da seção de capa (identificação) — ocupa a linha toda. */
  destaque?: boolean;
}) {
  const mudar = (v: unknown) => aoMudar?.(campo.id, v);
  // Classes de apresentação: tipo, origem na biblioteca e largura.
  // Nenhuma altera comportamento — só o grid visual da seção.
  const kind = campo.regraKind ?? campo.regra?.kind;
  const cls = [
    "campo",
    `campo-tipo-${campo.tipo}`,
    kind ? `campo-kind-${kind}` : "campo-kind-manual",
    (TIPOS_LARGOS.has(campo.tipo) || destaque) ? "campo-largo" : "",
    comErro ? "campo-com-erro" : "",
  ].filter(Boolean).join(" ");
  // Opções vindas da biblioteca de regras (campo.regraKind) — spec §8
  const opcoesBiblioteca = campo.regraKind ? (biblioteca?.[campo.regraKind] ?? []) : [];
  const nomeDe = (key: string) => opcoesBiblioteca.find((o) => o.key === key)?.name ?? key;
  const rotulo = (
    <span className="campo-label">
      {campo.label}
      {campo.obrigatorio && <em className="obrigatorio">*</em>}
      {campo.descricao && <small className="meta">{campo.descricao}</small>}
      {campo.editavel === false && <small className="meta">somente o mestre altera</small>}
    </span>
  );

  if (campo.tipo === "calculado") {
    return (
      <div id={`ficha-campo-${campo.id}`} className={cls}>
        {rotulo}
        <output className="calculado">{calculado ?? "—"}</output>
      </div>
    );
  }

  // Atributos e, quando a distribuição de pontos está ativa, qualquer campo
  // inteiro de faixa curta (habilidades, talentos etc.) usam bolinhas —
  // o valor continua salvo como número. Faixas longas (ex.: idade) caem
  // no input numérico porque faixaAtributo retorna null.
  if (campo.tipo === "inteiro" && faixaAtributo(campo) && (campo.semantico === "atributo" || !!ctxPontos)) {
    // Verifica se o campo tem um elemento vinculado na biblioteca com descrição
    let descricaoElemento: string | undefined = undefined;
    if (campo.regra?.key) {
      const elemento = (biblioteca?.[campo.regra.kind] ?? []).find((o) => o.key === campo.regra!.key);
      descricaoElemento = elemento?.descricao;
    }
    const rotuloComAjuda = (
      <span className="campo-label">
        {campo.label}
        {campo.obrigatorio && <em className="obrigatorio">*</em>}
        {campo.descricao && <small className="meta">{campo.descricao}</small>}
        {campo.editavel === false && <small className="meta">somente o mestre altera</small>}
        <AjudaPopover texto={descricaoElemento ?? ""} rotuloBotao={`Ver descrição de ${campo.label}`} />
      </span>
    );
    return (
      <div id={`ficha-campo-${campo.id}`} className={cls}>
        {rotuloComAjuda}
        <SeletorAtributo campo={campo} valor={valor ?? campo.padrao} somenteLeitura={somenteLeitura} aoMudar={aoMudar} ctx={ctxPontos} />
      </div>
    );
  }

  if (somenteLeitura) {
    if (campo.tipo === "tabela" && campo.carteira) {
      return (
        <div id={`ficha-campo-${campo.id}`} className={cls}>
          {rotulo}
          <CarteiraView campo={campo} valor={valor} somenteLeitura resumo={carteiraResumo} saldoEnviado={saldoEnviado} podeSaldo={false} />
        </div>
      );
    }
    if (campo.tipo === "tabela" && Array.isArray(valor) && valor.length > 0) {
      const linhas = valor as Record<string, unknown>[];
      const tot = inventarioTotals(campo, linhas);
      return (
        <div id={`ficha-campo-${campo.id}`} className={cls}>
          {rotulo}
          <div className="tabela-leitura">
            {linhas.map((linha, i) => {
              const partes = (campo.colunas ?? [])
                .map((col) => {
                  const v = linha[col.key];
                  if (v === undefined || v === "") return null;
                  return `${col.label}: ${formatarColuna(col.tipo, v)}`;
                })
                .filter(Boolean);
              const t = tot.porLinha[i];
              return (
                <div key={i} className="tabela-leitura-linha">
                  {partes.length ? partes.join(" · ") : `Registro ${i + 1}`}
                  {t && <div className="linha-totais">{t}</div>}
                </div>
              );
            })}
            {tot.resumo && <div className="tabela-resumo">{tot.resumo}</div>}
          </div>
        </div>
      );
    }
    if (campo.tipo === "selecao_nivel") {
      const itens = Array.isArray(valor) ? (valor as { key: string; nivel: number }[]) : [];
      return (
        <div id={`ficha-campo-${campo.id}`} className={cls}>
          {rotulo}
          <div className="valor-leitura selecao-nivel-leitura">
            {itens.length === 0 && "—"}
            {itens.map((item) => {
              const el = opcoesBiblioteca.find((o) => o.key === item.key);
              const desc = el?.niveis?.[item.nivel - 1]?.descricao;
              return (
                <div key={item.key} className="nivel-item">
                  <strong>{el?.name ?? item.key}</strong> — nível {item.nivel}
                  {desc && <div className="meta">{desc}</div>}
                </div>
              );
            })}
          </div>
        </div>
      );
    }
    const exibido = campo.regraKind && Array.isArray(valor)
      ? (valor as string[]).map(nomeDe).join(", ")
      : campo.regraKind && typeof valor === "string"
        ? nomeDe(valor)
        : undefined;
    return (
      <div id={`ficha-campo-${campo.id}`} className={cls}>
        {rotulo}
        <div className="valor-leitura">{exibido ?? formatarValor(campo, valor)}</div>
      </div>
    );
  }

  const editavel = (conteudo: ReactNode) => <div id={`ficha-campo-${campo.id}`} className={cls}>{rotulo}{conteudo}</div>;
  const atual = valor ?? campo.padrao;

  switch (campo.tipo) {
    case "texto":
      return editavel(
        <input
          type="text"
          aria-label={campo.label}
          value={String(atual ?? "")}
          maxLength={campo.maxCaracteres}
          onChange={(e) => mudar(e.target.value)}
        />
      );
    case "texto_longo":
      return editavel(
        <textarea
          rows={4}
          aria-label={campo.label}
          value={String(atual ?? "")}
          maxLength={campo.maxCaracteres}
          onChange={(e) => mudar(e.target.value)}
        />
      );
    case "inteiro":
    case "decimal":
    case "moeda":
      return editavel(
        <input
          type="number"
          aria-label={campo.label}
          step={campo.tipo === "inteiro" ? 1 : "any"}
          min={campo.minimo}
          max={campo.maximo}
          value={atual === "" || atual === null || atual === undefined ? "" : String(atual)}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "") { mudar(""); return; }
            const n = campo.tipo === "inteiro" ? parseInt(v, 10) : parseFloat(v);
            mudar(Number.isNaN(n) ? v : n);
          }}
        />
      );
    case "data":
      return editavel(
        <input type="date" aria-label={campo.label} value={String(atual ?? "")} onChange={(e) => mudar(e.target.value)} />
      );
    case "checkbox":
      return editavel(
        <label className="checkbox-inline">
          <input type="checkbox" checked={!!atual} onChange={(e) => mudar(e.target.checked)} />
          Sim
        </label>
      );
    case "selecao_unica": {
      const opcoes = campo.regraKind && opcoesBiblioteca.length
        ? opcoesBiblioteca.map((o) => ({ v: o.key, l: o.name, d: o.descricao }))
        : (campo.opcoes ?? []).map((o) => ({ v: o, l: o, d: undefined }));
      return editavel(
        <SeletorUnico
          rotulo={campo.label}
          opcoes={opcoes}
          valor={String(atual ?? "")}
          aoMudar={(v) => {
            if (aoAlternarPoder && v) aoAlternarPoder(campo, v);
            else mudar(v);
          }}
        />
      );
    }
    case "selecao_nivel": {
      // Elementos da biblioteca com nível graduado (ex.: defeitos 1–5).
      // Valor: [{ key, nivel }] — só entram itens com nivel >= 1.
      const itens = Array.isArray(atual) ? (atual as { key: string; nivel: number }[]) : [];
      const porKey = new Map(itens.map((i) => [i.key, i.nivel]));
      const opcoes: ElementoVinculavel[] = campo.regraKind && opcoesBiblioteca.length
        ? opcoesBiblioteca
        : (campo.opcoes ?? []).map((o) => ({ key: o, name: o, category: null }));
      const alternarNivel = (key: string, nivel: number) => {
        const novas = itens.filter((i) => i.key !== key);
        if (nivel > 0) novas.push({ key, nivel });
        mudar(novas);
      };
      return editavel(
        <div className="selecao-nivel">
          {opcoes.map((el) => {
            const nivel = porKey.get(el.key) ?? 0;
            const maxN = Math.max(1, Math.min(5, el.niveis?.length || el.maximo || 5));
            const desc = nivel > 0 ? el.niveis?.[nivel - 1]?.descricao : undefined;
            const custo = nivel > 0 ? custoNivelEl(el, nivel) : 0;
            return (
              <div key={el.key} className="nivel-item">
                <div className="nivel-linha">
                  <span className="nivel-nome">
                    {el.name}
                    <AjudaPopover texto={el.descricao ?? ""} rotuloBotao={`Ver descrição de ${el.name}`} />
                  </span>
                  <SeletorNivel valor={nivel} max={maxN} aoMudar={(n) => alternarNivel(el.key, n)} />
                </div>
                {nivel > 0 && desc && <div className="nivel-desc">{desc}</div>}
                {nivel > 0 && custo !== 0 && (
                  <span className={`seletor-custo${custo < 0 ? " custo-positivo" : ""}`}>
                    {custo > 0 ? `+${custo}` : custo} pts
                  </span>
                )}
              </div>
            );
          })}
          {opcoes.length === 0 && <p className="meta">Nenhum elemento de "{campo.regraKind}" disponível na biblioteca da campanha.</p>}
        </div>
      );
    }
    case "selecao_multipla":
    case "lista": {
      const lista: string[] = Array.isArray(atual) ? (atual as string[]) : [];
      const opcoes = campo.regraKind && opcoesBiblioteca.length
        ? opcoesBiblioteca.map((o) => ({ v: o.key, l: o.name, d: o.descricao }))
        : (campo.opcoes ?? []).map((o) => ({ v: o, l: o, d: undefined }));
      const alternar = (op: string) => {
        if (aoAlternarPoder) { aoAlternarPoder(campo, op); return; }
        mudar(lista.includes(op) ? lista.filter((x) => x !== op) : [...lista, op]);
      };
      return editavel(
        <div className="opcoes">
          {opcoes.map((o) => (
            <label key={o.v} className="checkbox-inline">
              <input type="checkbox" checked={lista.includes(o.v)} onChange={() => alternar(o.v)} />
              {o.l}
              <AjudaPopover texto={o.d ?? ""} rotuloBotao={`Ver descrição de ${o.l}`} />
            </label>
          ))}
        </div>
      );
    }
    case "tabela": {
      if (campo.carteira) {
        const podeSaldo = !!ehMestre || campo.carteira.saldoEditavelPor !== "mestre";
        return editavel(
          <CarteiraView
            campo={campo}
            valor={valor}
            somenteLeitura={false}
            aoMudar={aoMudar}
            resumo={carteiraResumo}
            saldoEnviado={saldoEnviado}
            podeSaldo={podeSaldo}
          />
        );
      }
      // Registro antigo: tabela com escalar vira linha única (espelha o backend).
      const linhas: Record<string, unknown>[] = Array.isArray(atual)
        ? (atual as Record<string, unknown>[])
        : atual !== undefined && atual !== null && atual !== "" ? [{ valor: atual }] : [];
      const setLinha = (i: number, key: string, v: unknown) => {
        const novas = linhas.map((l, idx) => (idx === i ? { ...l, [key]: v } : l));
        mudar(novas);
      };
      const tot = inventarioTotals(campo, linhas);
      return editavel(
        <div className="tabela-campos">
          {linhas.map((linha, i) => {
            const t = tot.porLinha[i];
            return (
              <div key={i} className="linha-tabela-grupo">
                <div className="linha-tabela">
                  {(campo.colunas ?? []).map((col) => (
                    <input
                      key={col.key}
                      type={col.tipo === "inteiro" || col.tipo === "decimal" || col.tipo === "moeda" ? "number" : col.tipo === "data" ? "date" : "text"}
                      placeholder={col.label}
                      value={String(linha[col.key] ?? "")}
                      onChange={(e) => setLinha(i, col.key, col.tipo.startsWith("int") || col.tipo === "decimal" || col.tipo === "moeda" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)}
                    />
                  ))}
                  <button type="button" className="mini perigo" onClick={() => mudar(linhas.filter((_, idx) => idx !== i))}>✕</button>
                </div>
                {t && <div className="linha-totais">{t}</div>}
              </div>
            );
          })}
          <button type="button" className="mini" onClick={() => mudar([...linhas, {}])}>+ Adicionar</button>
          {tot.resumo && <div className="tabela-resumo">{tot.resumo}</div>}
        </div>
      );
    }
    case "referencia":
      // Referência: texto simples apontando para outro campo (chave)
      return editavel(
        <input type="text" value={String(atual ?? "")} onChange={(e) => mudar(e.target.value)} placeholder="Chave do campo referenciado" />
      );
    default:
      return null;
  }
}

/**
 * Faixa de um atributo em bolinhas: usa minimo/maximo do campo
 * (padrão 1–5 quando não definidos). Retorna null quando a faixa
 * não é inteira/limitada — nesse caso o campo segue como número.
 */
function faixaAtributo(campo: CampoDef): { min: number; max: number; inicio: number; total: number } | null {
  const min = campo.minimo ?? 1;
  const max = campo.maximo ?? 5;
  if (!Number.isInteger(min) || !Number.isInteger(max) || max < min || min < 0) return null;
  // Bolinhas = quantidade de valores selecionáveis a partir de `inicio`.
  // Mínimo 0 não gera bolinha extra: zero é o estado "tudo vazio" e é
  // alcançado limpando a seleção (as bolinhas representam 1..máximo).
  const inicio = min === 0 ? 1 : min;
  const total = max - inicio + 1;
  if (total < 2 || total > 12) return null;
  return { min, max, inicio, total };
}

/** Custo acumulado de um elemento com níveis: soma custos incrementais. */
function custoNivelEl(el: ElementoVinculavel, nivel: number): number {
  let custo = 0;
  for (let i = 0; i < nivel; i++) custo += el.niveis?.[i]?.custo ?? el.custoPontos ?? 0;
  return custo;
}

/**
 * Seletor único com ajuda por opção — substitui o <select> nativo para que
 * cada opção da Biblioteca exiba seu próprio "?" sem precisar ser escolhida.
 * A opção em si é um botão role="option"; o AjudaPopover é irmão, nunca
 * filho, para não aninhar interativos dentro do role="option".
 */
function SeletorUnico({ rotulo, opcoes, valor, aoMudar }: {
  rotulo: string;
  opcoes: { v: string; l: string; d?: string }[];
  valor: string;
  aoMudar: (v: string) => void;
}) {
  const [aberto, setAberto] = useState(false);
  const [paraCima, setParaCima] = useState(false);
  const caixaRef = useRef<HTMLDivElement>(null);
  const gatilhoRef = useRef<HTMLButtonElement>(null);
  const listaRef = useRef<HTMLDivElement>(null);

  const rotuloAtual = opcoes.find((o) => o.v === valor)?.l ?? "—";
  // Mantém a opção vazia ("—") do <select> original: limpa a seleção.
  const opcoesLista = [{ v: "", l: "—", d: undefined }, ...opcoes];

  useEffect(() => {
    if (!aberto) return;
    const aoClicarFora = (e: MouseEvent) => {
      if (caixaRef.current && !caixaRef.current.contains(e.target as Node)) setAberto(false);
    };
    document.addEventListener("mousedown", aoClicarFora);
    return () => document.removeEventListener("mousedown", aoClicarFora);
  }, [aberto]);

  // Vira a lista para cima quando não há espaço suficiente abaixo do gatilho.
  useLayoutEffect(() => {
    if (!aberto) {
      setParaCima(false);
      return;
    }
    const gatilho = gatilhoRef.current;
    const lista = listaRef.current;
    if (!gatilho || !lista) return;
    const calcular = () => {
      const r = gatilho.getBoundingClientRect();
      const h = lista.offsetHeight;
      const espacoBaixo = window.innerHeight - r.bottom;
      const espacoCima = r.top;
      setParaCima(h + 8 > espacoBaixo && espacoCima > espacoBaixo);
    };
    calcular();
    window.addEventListener("resize", calcular);
    window.addEventListener("scroll", calcular, true);
    return () => {
      window.removeEventListener("resize", calcular);
      window.removeEventListener("scroll", calcular, true);
    };
  }, [aberto]);

  // Ao abrir, foca a opção selecionada (ou a primeira).
  useEffect(() => {
    if (!aberto) return;
    const lista = listaRef.current;
    if (!lista) return;
    const sel = lista.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    const primeiro = lista.querySelector<HTMLElement>('[role="option"]');
    (sel ?? primeiro)?.focus();
  }, [aberto]);

  const escolher = (v: string) => {
    aoMudar(v);
    setAberto(false);
    gatilhoRef.current?.focus();
  };

  const opcoesDom = () =>
    Array.from(listaRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);

  return (
    <div
      className="seletor-unico"
      ref={caixaRef}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setAberto(false);
      }}
    >
      <button
        type="button"
        ref={gatilhoRef}
        className="seletor-unico-gatilho"
        aria-haspopup="listbox"
        aria-expanded={aberto}
        aria-label={rotulo}
        onClick={() => setAberto((a) => !a)}
        onKeyDown={(e) => {
          if (!aberto && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ")) {
            e.preventDefault();
            setAberto(true);
          }
        }}
      >
        <span className="seletor-unico-valor">{rotuloAtual}</span>
        <span className="seletor-unico-seta" aria-hidden="true">▾</span>
      </button>
      {aberto && (
        <div
          className={`seletor-unico-lista${paraCima ? " para-cima" : ""}`}
          role="listbox"
          aria-label={rotulo}
          ref={listaRef}
          onKeyDown={(e) => {
            const itens = opcoesDom();
            const i = itens.indexOf(document.activeElement as HTMLElement);
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (itens.length) itens[(i + (e.key === "ArrowDown" ? 1 : -1) + itens.length) % itens.length].focus();
            } else if (e.key === "Home" || e.key === "End") {
              e.preventDefault();
              (e.key === "Home" ? itens[0] : itens[itens.length - 1])?.focus();
            } else if (e.key === "Escape") {
              // ESC originado do botão/popover de ajuda fecha só a ajuda —
              // o AjudaPopover trata a tecla no window; não derrubar a lista.
              if ((e.target as HTMLElement).closest(".ajuda-contextual")) return;
              e.preventDefault();
              e.stopPropagation();
              setAberto(false);
              gatilhoRef.current?.focus();
            }
          }}
        >
          {opcoesLista.map((o) => {
            const sel = o.v === valor;
            return (
              <div key={o.v || "__vazio"} className={`seletor-unico-opcao${sel ? " selecionada" : ""}`}>
                <button
                  type="button"
                  role="option"
                  aria-selected={sel}
                  aria-label={o.l}
                  className="seletor-unico-item"
                  onClick={() => escolher(o.v)}
                >
                  {sel && <span className="seletor-unico-check" aria-hidden="true">✓ </span>}
                  {o.l}
                </button>
                <AjudaPopover texto={o.d ?? ""} rotuloBotao={`Ver descrição de ${o.l}`} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Bolinhas de nível 1..max (0 = não escolhido) — usado por selecao_nivel. */
function SeletorNivel({ valor, max, aoMudar }: {
  valor: number;
  max: number;
  aoMudar: (nivel: number) => void;
}) {
  return (
    <div className="seletor-atributos">
      <div className="bolinhas" role="radiogroup">
        {Array.from({ length: max }, (_, i) => {
          const v = i + 1;
          const cheio = v <= valor;
          return (
            <button
              key={v}
              type="button"
              className={`bolinha ${cheio ? "cheia" : ""}`}
              aria-pressed={v === valor}
              aria-label={`nível ${v}`}
              onClick={() => aoMudar(v === valor ? 0 : v)}
            />
          );
        })}
      </div>
      <span className="seletor-valor">{valor > 0 ? valor : "—"}</span>
    </div>
  );
}

/** Pool padrão da distribuição — mesma regra do servidor ("principal" ou o primeiro). */
function poolPadraoId(cfg: EstruturaFicha["pontos"]): string {
  return (cfg.pools?.find((p) => p.id === "principal") ?? cfg.pools?.[0])?.id ?? "principal";
}

/**
 * Estimativa local do custo de um campo — espelha a parte "por campo" de
 * calcularPontos do servidor (custos vindos da biblioteca/elementos podem
 * somar valores a mais; a validação definitiva continua sendo do backend).
 */
function custoEstimado(campo: CampoDef, valor: unknown, cfg: EstruturaFicha["pontos"]): number {
  if (typeof valor !== "number" || Number.isNaN(valor)) return 0;
  if (campo.custoPontos === undefined && !campo.custoProgressivo?.length && !cfg?.custos?.[campo.semantico]) return 0;
  const base = typeof campo.padrao === "number" ? campo.padrao : (campo.minimo ?? 0);
  const diff = valor - base;
  if (diff <= 0) return 0;
  const tabela = campo.custoProgressivo?.length ? campo.custoProgressivo : cfg?.custos?.[campo.semantico];
  if (tabela?.length) {
    let custo = 0;
    for (let nivel = base; nivel < valor; nivel++) {
      const c = tabela[nivel];
      custo += typeof c === "number" ? c : (campo.custoPontos ?? 0);
    }
    return custo;
  }
  return diff * (campo.custoPontos ?? 0);
}

/** Seletor de atributo em bolinhas: valor continua sendo o número min..max. */
function SeletorAtributo({ campo, valor, somenteLeitura, aoMudar, ctx }: {
  campo: CampoDef;
  valor: unknown;
  somenteLeitura: boolean;
  aoMudar?: (id: string, v: unknown) => void;
  ctx?: ContextoPontos | null;
}) {
  const faixa = faixaAtributo(campo)!;
  const num = typeof valor === "number" ? valor : valor === "" || valor === null || valor === undefined ? NaN : Number(valor);
  const preenchidas = Number.isFinite(num) ? Math.max(0, Math.min(faixa.total, num - faixa.inicio + 1)) : 0;
  const foraDaFaixa = Number.isFinite(num) && (num < faixa.min || num > faixa.max);

  // Custo/pool deste campo quando a distribuição de pontos está ativa.
  const comCusto = !!ctx && (campo.custoPontos !== undefined || !!campo.custoProgressivo?.length || !!ctx.cfg.custos?.[campo.semantico]);
  const custoAtual = ctx?.custoDe(campo.id) ?? 0;
  const poolId = campo.reservaPontos ?? poolPadraoId(ctx?.cfg ?? { habilitado: false, pontosIniciais: 0, pools: [], custos: {} });
  const pool = ctx?.poolDe(poolId);
  // Uma bolinha só é clicável se o custo estimado couber no saldo do pool
  // (saldo atual + o que este campo já consome e seria liberado).
  const limiteGasto = (pool?.saldo ?? 0) + custoAtual;

  const escolher = (v: number) => {
    if (somenteLeitura || !aoMudar) return;
    // Clicar na bolinha já selecionada limpa o valor (quando o campo não é obrigatório).
    if (v === num && !campo.obrigatorio) aoMudar(campo.id, "");
    else aoMudar(campo.id, v);
  };

  return (
    <div className={`seletor-atributos seletor-bolinhas${somenteLeitura ? " somente-leitura" : ""}`}>
      <div className="bolinhas" role={somenteLeitura ? undefined : "radiogroup"} aria-label={campo.label}>
        {Array.from({ length: faixa.total }, (_, i) => {
          const v = faixa.inicio + i;
          const cheio = i < preenchidas;
          const custoCand = comCusto ? custoEstimado(campo, v, ctx!.cfg) : 0;
          const afford = !comCusto || !ctx?.pontos || custoCand <= limiteGasto + 1e-9;
          return somenteLeitura ? (
            <span key={v} className={`bolinha ${cheio ? "cheia" : ""}`} aria-hidden="true" />
          ) : (
            <button
              key={v}
              type="button"
              className={`bolinha ${cheio ? "cheia" : ""}`}
              aria-pressed={v === num}
              aria-label={`${campo.label}: ${v}`}
              title={comCusto ? `${v} — custo estimado ${custoCand} pts` : `${v}`}
              disabled={!afford}
              onClick={() => escolher(v)}
            />
          );
        })}
      </div>
      <span className="seletor-valor">
        {foraDaFaixa ? `${num} (fora de ${faixa.min}–${faixa.max})` : Number.isFinite(num) ? num : "—"}
      </span>
      {comCusto && (
        <span className={`seletor-custo${pool && pool.saldo < 0 ? " negativo" : ""}`}>
          {custoAtual > 0 ? `${custoAtual} pts` : "0 pts"}
          {pool ? ` · restam ${pool.saldo}` : ""}
        </span>
      )}
    </div>
  );
}

/** Painel de saldo de pontos no topo da ficha — atualiza a cada prévia. */
function PainelPontos({ ctx }: { ctx: ContextoPontos }) {
  const pontos = ctx.pontos;
  if (!pontos) return <div className="pontos-painel meta">Calculando pontos…</div>;
  const totalGastos = pontos.pools.reduce((s, p) => s + p.gastos, 0);
  const totalDisponiveis = pontos.pools.reduce((s, p) => s + p.disponiveis, 0);
  const saldo = pontos.pools.reduce((s, p) => s + p.saldo, 0);
  return (
    <div className={`pontos-painel${pontos.erros.length ? " com-erro" : ""}`}>
      <div className="pontos-resumo">
        <span className="badge">Disponíveis: {totalDisponiveis}</span>
        <span className="badge">Utilizados: {totalGastos}</span>
        <span className={`badge ${saldo < 0 ? "badge-negativo" : ""}`}>Restantes: {saldo}</span>
      </div>
      {pontos.pools.map((p) => (
        <div key={p.id} className="pontos-pool">
          <strong>{p.nome}</strong>: {p.gastos}/{p.disponiveis} usados
          {p.cedidos ? ` · cedeu ${p.cedidos}` : ""}
          {p.recebidos ? ` · recebeu ${p.recebidos}` : ""}
          <span className={p.saldo < 0 ? "negativo" : ""}> · saldo {p.saldo}</span>
        </div>
      ))}
      {pontos.transferencias && pontos.transferencias.length > 0 && (
        <div className="meta">
          Transferências: {pontos.transferencias.map((t) => `${t.de} → ${t.para}: ${t.pontos}`).join("; ")}
        </div>
      )}
      {pontos.erros.length > 0 && (
        <ul className="pontos-erros">
          {pontos.erros.map((e, i) => <li key={i}>{e}</li>)}
        </ul>
      )}
    </div>
  );
}

/** HP e Vitalidade simulados (somente leitura) — vem de /regras/simulacao.
 *  Reutiliza as mesmas classes do componente Vida da ficha real. */
function PainelVidaSim({ vida }: { vida: VidaResumo }) {
  const hp = vida.hp;
  const vit = vida.vitalidade;
  if (!hp && !vit) return null;
  const pct = hp ? Math.max(0, Math.min(100, (hp.atual / hp.maximo) * 100)) : 0;
  return (
    <div className="vida-cartao vida-sim">
      <h4>Pontos de Vida / Vitalidade <span className="meta">(simulação)</span></h4>
      {hp && (
        <div className="hp-resumo">
          <span className={`hp-atual${hp.atual / hp.maximo <= 0.25 ? " critico" : ""}`}>{hp.atual}</span>
          <span className="meta">/ {hp.maximo} HP</span>
          <div className="hp-barra">
            <div className="hp-preenchimento" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}
      {vit && (
        <div className="vitalidade-escala">
          {vit.niveis.map((n) => (
            <div
              key={n.indice}
              className={`vit-nivel somente-leitura${n.indice === vit.nivel ? " atual" : ""}`}
              title={n.bloqueiaAcoes ? "bloqueia ações" : undefined}
            >
              <span className="vit-nome">{n.nome}</span>
              <span className="vit-penalidade">
                {n.penalidadeDados ? `−${n.penalidadeDados} dados` : "sem penalidade"}
                {n.bloqueiaAcoes ? " · bloqueia" : ""}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Número finito ou null ("" e não-numéricos contam como ausente). */
function numOuNulo(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Espelha parseNumeroBR do backend: "1.111,11" -> 1111.11 etc. */
function parseBR(v: unknown): number | null {
  if (typeof v === "number") return Number.isNaN(v) ? null : v;
  if (typeof v !== "string") return null;
  let s = v.trim();
  if (!s) return null;
  const temVirg = s.includes(",");
  const temPonto = s.includes(".");
  if (temVirg && temPonto) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (temVirg) {
    s = s.replace(",", ".");
  } else if (temPonto && /^-?\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, "");
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

const tipoMov = (v: unknown) =>
  typeof v === "string" ? v.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim() : "";

interface ResumoCarteira { saldoInicial: number; entradas: number; saidas: number; saldo: number }

/** Totais da carteira derivados das movimentações — nunca digitados. */
function totaisCarteira(linhas: Record<string, unknown>[], saldoInicial: number): ResumoCarteira {
  let entradas = 0, saidas = 0;
  for (const l of linhas) {
    const v = parseBR(l.valor) ?? 0;
    const t = tipoMov(l.tipo);
    if (t === "entrada") entradas += v;
    else if (t === "saida") saidas += v;
  }
  return { saldoInicial, entradas, saidas, saldo: saldoInicial + entradas - saidas };
}

const ROTULO_TIPO: Record<string, string> = { entrada: "Entrada", saida: "Saída" };

/**
 * Carteira financeira (tabela semantico "moeda" com campo.carteira):
 * saldo inicial + movimentações -> saldo atual calculado.
 */
function CarteiraView({ campo, valor, somenteLeitura, aoMudar, resumo, saldoEnviado, podeSaldo }: {
  campo: CampoDef;
  valor: unknown;
  somenteLeitura: boolean;
  aoMudar?: (id: string, v: unknown) => void;
  resumo?: ResumoCarteira;
  saldoEnviado?: unknown;
  podeSaldo: boolean;
}) {
  const chaveSaldo = `${campo.id}::saldo`;
  const linhas: Record<string, unknown>[] = Array.isArray(valor) ? (valor as Record<string, unknown>[]) : [];
  const saldoInicial = numOuNulo(saldoEnviado) ?? resumo?.saldoInicial ?? parseBR(campo.padrao) ?? 0;
  const tot = totaisCarteira(linhas, saldoInicial);

  const setLinha = (i: number, key: string, v: unknown) => {
    aoMudar?.(campo.id, linhas.map((l, idx) => (idx === i ? { ...l, [key]: v } : l)));
  };
  const dataDe = (l: Record<string, unknown>) => {
    const d = l.data;
    if (typeof d === "string" && d) {
      const dt = new Date(d.length === 10 ? `${d}T12:00:00` : d);
      if (!Number.isNaN(dt.getTime())) return dt.toLocaleDateString("pt-BR");
    }
    return "";
  };

  return (
    <div className="carteira">
      <div className="carteira-resumo">
        <div className="carteira-saldo">
          <span>Saldo atual</span>
          <strong className={tot.saldo < 0 ? "negativo" : ""}>{fmtMoeda(tot.saldo)}</strong>
        </div>
        <div className="carteira-totais">
          <span>Saldo inicial: {fmtMoeda(saldoInicial)}</span>
          <span className="carteira-positivo">Entradas: {fmtMoeda(tot.entradas)}</span>
          <span className="carteira-negativo">Saídas: {fmtMoeda(tot.saidas)}</span>
        </div>
      </div>

      {!somenteLeitura && (
        <div className="carteira-acoes">
          {podeSaldo ? (
            <label className="carteira-saldo-input">
              Saldo inicial
              <input
                type="number"
                step="0.01"
                value={saldoInicial}
                onChange={(e) => aoMudar?.(chaveSaldo, e.target.value === "" ? "" : Number(e.target.value))}
              />
            </label>
          ) : (
            <span className="meta">Saldo inicial: {fmtMoeda(saldoInicial)} (somente o mestre pode alterar)</span>
          )}
          <button type="button" className="mini" onClick={() => aoMudar?.(campo.id, [...linhas, { tipo: "entrada", valor: "" }])}>
            + Adicionar movimentação
          </button>
        </div>
      )}

      <div className="carteira-historico">
        {linhas.length === 0 && <p className="meta">Nenhuma movimentação registrada.</p>}
        {linhas.map((l, i) => {
          const t = tipoMov(l.tipo);
          const rotulo = ROTULO_TIPO[t] ?? (t ? String(l.tipo) : "—");
          if (somenteLeitura) {
            const extras = (campo.colunas ?? [])
              .filter((c) => !["data", "descricao", "tipo", "valor"].includes(c.key))
              .map((c) => {
                const v = l[c.key];
                return v === undefined || v === "" ? null : `${c.label}: ${formatarColuna(c.tipo, v)}`;
              })
              .filter(Boolean);
            return (
              <div key={i} className={`carteira-linha ${t === "saida" ? "saida" : "entrada"}`}>
                <span className="carteira-data">{dataDe(l)}</span>
                <span className="carteira-desc">
                  {String(l.descricao ?? "")}
                  {extras.length > 0 && <span className="meta"> · {extras.join(" · ")}</span>}
                </span>
                <span className={`carteira-badge ${t === "saida" ? "negativo" : "positivo"}`}>{rotulo}</span>
                <span className="carteira-valor">{fmtMoeda(parseBR(l.valor) ?? 0)}</span>
              </div>
            );
          }
          return (
            <div key={i} className={`carteira-linha-edicao ${t === "saida" ? "saida" : ""}`}>
              <input type="date" value={String(l.data ?? "")} onChange={(e) => setLinha(i, "data", e.target.value)} aria-label="Data" />
              <input type="text" placeholder="Descrição" value={String(l.descricao ?? "")} onChange={(e) => setLinha(i, "descricao", e.target.value)} />
              <select value={t === "entrada" || t === "saida" ? t : "entrada"} onChange={(e) => setLinha(i, "tipo", e.target.value)} aria-label="Tipo">
                <option value="entrada">Entrada</option>
                <option value="saida">Saída</option>
              </select>
              <input
                type="number"
                step="0.01"
                min="0"
                placeholder="Valor"
                aria-label="Valor da movimentação"
                value={l.valor === undefined || l.valor === null ? "" : String(l.valor)}
                onChange={(e) => setLinha(i, "valor", e.target.value === "" ? "" : Number(e.target.value))}
              />
              <button type="button" className="mini perigo" onClick={() => aoMudar?.(campo.id, linhas.filter((_, idx) => idx !== i))}>✕</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function fmtNum(n: number): string {
  return n.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
}

function fmtMoeda(n: number): string {
  return `R$ ${n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatarColuna(tipo: string, v: unknown): string {
  if (tipo === "moeda") { const n = numOuNulo(v); return n === null ? String(v) : fmtMoeda(n); }
  if (tipo === "inteiro" || tipo === "decimal") { const n = numOuNulo(v); return n === null ? String(v) : fmtNum(n); }
  if (tipo === "data" && typeof v === "string" && v) {
    const d = new Date(v.length === 10 ? `${v}T12:00:00` : v);
    return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString("pt-BR");
  }
  return String(v);
}

/**
 * Totais derivados de uma tabela de inventário (semantico "item"):
 * quantidade × peso/espaco/valor_compra por linha + resumo geral.
 * Nada é digitado nem persistido — sempre calculado dos registros.
 */
function inventarioTotals(campo: CampoDef, linhas: Record<string, unknown>[]) {
  const ehInventario = campo.semantico === "item";
  if (!ehInventario) return { porLinha: linhas.map(() => null as string | null), resumo: null as string | null };
  const cols = new Set((campo.colunas ?? []).map((c) => c.key));
  const tem = (k: string) => cols.has(k);
  if (!["peso", "espaco", "valor_compra"].some(tem)) return { porLinha: linhas.map(() => null), resumo: null };

  const qtdDe = (l: Record<string, unknown>) => {
    if (!tem("quantidade")) return 1;
    return numOuNulo(l.quantidade) ?? 0;
  };
  const partesDe = (l: Record<string, unknown>) => {
    const q = qtdDe(l);
    const out: string[] = [];
    if (tem("peso")) { const p = numOuNulo(l.peso); if (p !== null) out.push(`Peso: ${fmtNum(q * p)} kg`); }
    if (tem("espaco")) { const e = numOuNulo(l.espaco); if (e !== null) out.push(`Espaço: ${fmtNum(q * e)}`); }
    if (tem("valor_compra")) { const v = numOuNulo(l.valor_compra); if (v !== null) out.push(`Valor: ${fmtMoeda(q * v)}`); }
    return out.length ? out.join(" · ") : null;
  };

  const porLinha = linhas.map(partesDe);
  const totPeso = linhas.reduce((a, l) => a + qtdDe(l) * (numOuNulo(l.peso) ?? 0), 0);
  const totEspaco = linhas.reduce((a, l) => a + qtdDe(l) * (numOuNulo(l.espaco) ?? 0), 0);
  const totValor = linhas.reduce((a, l) => a + qtdDe(l) * (numOuNulo(l.valor_compra) ?? 0), 0);
  const resumoPartes: string[] = [];
  if (tem("peso")) resumoPartes.push(`Peso total: ${fmtNum(totPeso)} kg`);
  if (tem("espaco")) resumoPartes.push(`Espaço total: ${fmtNum(totEspaco)}`);
  if (tem("valor_compra")) resumoPartes.push(`Valor total: ${fmtMoeda(totValor)}`);
  return { porLinha, resumo: resumoPartes.length ? resumoPartes.join(" · ") : null };
}

function formatarValor(campo: CampoDef, valor: unknown): string {
  if (valor === null || valor === undefined || valor === "") return "—";
  if (campo.tipo === "checkbox") return valor ? "Sim" : "Não";
  if (campo.tipo === "moeda") return `R$ ${Number(valor).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`;
  if (campo.tipo === "tabela" && Array.isArray(valor)) {
    return `${valor.length} registro(s)`;
  }
  if (Array.isArray(valor)) return valor.join(", ");
  if (typeof valor === "object") return JSON.stringify(valor);
  return String(valor);
}

/** Hook auxiliar para estado de ficha. */
export function useFichaValores(inicial: Record<string, unknown> = {}) {
  const [valores, setValores] = useState<Record<string, unknown>>(inicial);
  const aoMudar = (id: string, v: unknown) => setValores((prev) => ({ ...prev, [id]: v }));
  return { valores, setValores, aoMudar };
}
