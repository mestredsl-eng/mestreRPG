import { useState, type ReactNode } from "react";
import type { CampoDef, EstruturaFicha } from "./api";

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
}

export default function FichaForm({ estrutura, valores, calculados = {}, somenteLeitura = false, aoMudar, biblioteca }: Props) {
  return (
    <div className="ficha">
      {estrutura.secoes
        .filter((s) => !s.parentId)
        .sort((a, b) => a.ordem - b.ordem)
        .map((secao) => {
          const subsecoes = estrutura.secoes.filter((s) => s.parentId === secao.id);
          return (
            <div key={secao.id} className="ficha-secao">
              <h3>{secao.titulo}</h3>
              {secao.descricao && <p className="meta">{secao.descricao}</p>}
              {secao.campos.map((campo) => (
                <CampoInput key={campo.id} campo={campo} valor={valores[campo.id]} calculado={calculados[campo.id]} somenteLeitura={somenteLeitura} aoMudar={aoMudar} biblioteca={biblioteca} />
              ))}
              {subsecoes.map((sub) => (
                <div key={sub.id} className="ficha-subsecao">
                  <h4>{sub.titulo}</h4>
                  {sub.campos.map((campo) => (
                    <CampoInput key={campo.id} campo={campo} valor={valores[campo.id]} calculado={calculados[campo.id]} somenteLeitura={somenteLeitura} aoMudar={aoMudar} biblioteca={biblioteca} />
                  ))}
                </div>
              ))}
            </div>
          );
        })}
    </div>
  );
}

function CampoInput({ campo, valor, calculado, somenteLeitura, aoMudar, biblioteca }: {
  campo: CampoDef;
  valor: unknown;
  calculado?: number | string;
  somenteLeitura: boolean;
  aoMudar?: (id: string, v: unknown) => void;
  biblioteca?: Record<string, { key: string; name: string; category: string | null }[]>;
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
