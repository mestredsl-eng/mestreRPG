import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type CampoDef, type EstruturaFicha, type PoolPontos, type ResultadoPontos } from "./api";

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
  biblioteca?: Record<string, { key: string; name: string; category: string | null }[]>;
  /** Personagem dono da ficha — habilita a prévia de pontos em tempo real (sem salvar). */
  personagemId?: string;
  /** Saldo de pontos já calculado pelo servidor para os dados atuais. */
  pontosInicial?: ResultadoPontos;
}

/** Contexto de pontos repassado aos campos que participam da distribuição. */
interface ContextoPontos {
  pontos: ResultadoPontos | null;
  cfg: EstruturaFicha["pontos"];
  custoDe: (campoId: string) => number;
  poolDe: (poolId: string) => PoolPontos | undefined;
}

export default function FichaForm({ estrutura, valores, calculados = {}, somenteLeitura = false, aoMudar, biblioteca, personagemId, pontosInicial }: Props) {
  const [pontos, setPontos] = useState<ResultadoPontos | null>(pontosInicial ?? null);

  // Prévia de pontos: recalcula no servidor (mesmo pipeline do GET/PATCH) com
  // debounce a cada alteração da ficha. Em modo leitura usa o valor inicial.
  useEffect(() => {
    if (somenteLeitura || !personagemId || !estrutura.pontos?.habilitado) {
      setPontos(pontosInicial ?? null);
      return;
    }
    let vivo = true;
    const timer = setTimeout(() => {
      api.previaPontos(personagemId, valores)
        .then((r) => { if (vivo) setPontos(r.pontos); })
        .catch(() => { /* prévia é best-effort; a validação real é do PATCH */ });
    }, 300);
    return () => { vivo = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valores, somenteLeitura, personagemId, estrutura]);

  const ctxPontos = useMemo<ContextoPontos | null>(() => {
    if (!estrutura.pontos?.habilitado) return null;
    return {
      pontos,
      cfg: estrutura.pontos,
      custoDe: (id) => pontos?.detalhes.find((d) => d.campoId === id)?.custo ?? 0,
      poolDe: (id) => pontos?.pools.find((p) => p.id === id),
    };
  }, [pontos, estrutura]);

  return (
    <div className="ficha">
      {ctxPontos && (ctxPontos.pontos || personagemId) && <PainelPontos ctx={ctxPontos} />}
      {estrutura.secoes
        .filter((s) => !s.parentId)
        .sort((a, b) => a.ordem - b.ordem)
        .map((secao, indice) => {
          const subsecoes = estrutura.secoes.filter((s) => s.parentId === secao.id);
          return (
            <div key={secao.id} className={`ficha-secao${indice === 0 ? " ficha-secao-capa" : ""}`}>
              <h3>{secao.titulo}</h3>
              {secao.descricao && <p className="meta">{secao.descricao}</p>}
              {secao.campos.map((campo) => (
                <CampoInput key={campo.id} campo={campo} valor={valores[campo.id]} calculado={calculados[campo.id]} somenteLeitura={somenteLeitura} aoMudar={aoMudar} biblioteca={biblioteca} ctxPontos={ctxPontos} />
              ))}
              {subsecoes.length > 0 && (
                <div className="ficha-subsecoes">
                  {subsecoes.map((sub) => (
                    <div key={sub.id} className="ficha-subsecao">
                      <h4>{sub.titulo}</h4>
                      {sub.campos.map((campo) => (
                        <CampoInput key={campo.id} campo={campo} valor={valores[campo.id]} calculado={calculados[campo.id]} somenteLeitura={somenteLeitura} aoMudar={aoMudar} biblioteca={biblioteca} ctxPontos={ctxPontos} />
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

function CampoInput({ campo, valor, calculado, somenteLeitura, aoMudar, biblioteca, ctxPontos }: {
  campo: CampoDef;
  valor: unknown;
  calculado?: number | string;
  somenteLeitura: boolean;
  aoMudar?: (id: string, v: unknown) => void;
  biblioteca?: Record<string, { key: string; name: string; category: string | null }[]>;
  ctxPontos?: ContextoPontos | null;
}) {
  const mudar = (v: unknown) => aoMudar?.(campo.id, v);
  // Opções vindas da biblioteca de regras (campo.regraKind) — spec §8
  const opcoesBiblioteca = campo.regraKind ? (biblioteca?.[campo.regraKind] ?? []) : [];
  const nomeDe = (key: string) => opcoesBiblioteca.find((o) => o.key === key)?.name ?? key;
  const rotulo = (
    <span className="campo-label">
      {campo.label}
      {campo.obrigatorio && <em className="obrigatorio">*</em>}
      {campo.descricao && <small className="meta">{campo.descricao}</small>}
    </span>
  );

  if (campo.tipo === "calculado") {
    return (
      <div className="campo">
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
    return (
      <div className="campo">
        {rotulo}
        <SeletorAtributo campo={campo} valor={valor ?? campo.padrao} somenteLeitura={somenteLeitura} aoMudar={aoMudar} ctx={ctxPontos} />
      </div>
    );
  }

  if (somenteLeitura) {
    const exibido = campo.regraKind && Array.isArray(valor)
      ? (valor as string[]).map(nomeDe).join(", ")
      : campo.regraKind && typeof valor === "string"
        ? nomeDe(valor)
        : undefined;
    return (
      <div className="campo">
        {rotulo}
        <div className="valor-leitura">{exibido ?? formatarValor(campo, valor)}</div>
      </div>
    );
  }

  const editavel = (conteudo: ReactNode) => <div className="campo">{rotulo}{conteudo}</div>;
  const atual = valor ?? campo.padrao;

  switch (campo.tipo) {
    case "texto":
      return editavel(
        <input
          type="text"
          value={String(atual ?? "")}
          maxLength={campo.maxCaracteres}
          onChange={(e) => mudar(e.target.value)}
        />
      );
    case "texto_longo":
      return editavel(
        <textarea
          rows={4}
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
        <input type="date" value={String(atual ?? "")} onChange={(e) => mudar(e.target.value)} />
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
        ? opcoesBiblioteca.map((o) => ({ v: o.key, l: o.name }))
        : (campo.opcoes ?? []).map((o) => ({ v: o, l: o }));
      return editavel(
        <select value={String(atual ?? "")} onChange={(e) => mudar(e.target.value)}>
          <option value="">—</option>
          {opcoes.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
        </select>
      );
    }
    case "selecao_multipla":
    case "lista": {
      const lista: string[] = Array.isArray(atual) ? (atual as string[]) : [];
      const opcoes = campo.regraKind && opcoesBiblioteca.length
        ? opcoesBiblioteca.map((o) => ({ v: o.key, l: o.name }))
        : (campo.opcoes ?? []).map((o) => ({ v: o, l: o }));
      const alternar = (op: string) => {
        mudar(lista.includes(op) ? lista.filter((x) => x !== op) : [...lista, op]);
      };
      return editavel(
        <div className="opcoes">
          {opcoes.map((o) => (
            <label key={o.v} className="checkbox-inline">
              <input type="checkbox" checked={lista.includes(o.v)} onChange={() => alternar(o.v)} />
              {o.l}
            </label>
          ))}
        </div>
      );
    }
    case "tabela": {
      const linhas: Record<string, unknown>[] = Array.isArray(atual) ? (atual as Record<string, unknown>[]) : [];
      const setLinha = (i: number, key: string, v: unknown) => {
        const novas = linhas.map((l, idx) => (idx === i ? { ...l, [key]: v } : l));
        mudar(novas);
      };
      return editavel(
        <div className="tabela-campos">
          {linhas.map((linha, i) => (
            <div key={i} className="linha-tabela">
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
          ))}
          <button type="button" className="mini" onClick={() => mudar([...linhas, {}])}>+ Adicionar</button>
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
function faixaAtributo(campo: CampoDef): { min: number; max: number; total: number } | null {
  const min = campo.minimo ?? 1;
  const max = campo.maximo ?? 5;
  if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) return null;
  const total = max - min + 1;
  if (total < 2 || total > 12) return null;
  return { min, max, total };
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
  const preenchidas = Number.isFinite(num) ? Math.max(0, Math.min(faixa.total, num - faixa.min + 1)) : 0;
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
    <div className={`seletor-atributos${somenteLeitura ? " somente-leitura" : ""}`}>
      <div className="bolinhas" role={somenteLeitura ? undefined : "radiogroup"} aria-label={campo.label}>
        {Array.from({ length: faixa.total }, (_, i) => {
          const v = faixa.min + i;
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
