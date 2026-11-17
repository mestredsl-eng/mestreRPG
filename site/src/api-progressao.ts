/**
 * API de progressão XP/Merit (Issue #124) — módulo próprio para não
 * tocar api.ts enquanto a frente do retrato (PR #131) estiver aberta.
 * O servidor é a autoridade de saldo, preço e nível: o cliente nunca
 * envia valores — só kind/key/nivelAlvo da compra pretendida.
 */

const API_BASE = "/api";

export class ApiErrorProgresso extends Error {
  detalhes?: unknown;
  codigo?: string;
  status: number;
  constructor(mensagem: string, detalhes?: unknown, status = 0, codigo?: string) {
    super(mensagem);
    this.detalhes = detalhes;
    this.codigo = codigo;
    this.status = status;
  }
}

async function requisicao<T>(caminho: string, opcoes: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${caminho}`, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(opcoes.headers ?? {}) },
    ...opcoes,
  });
  const corpo = await res.json().catch(() => ({}));
  if (!res.ok) {
    const c = corpo as { erro?: string; mensagem?: string; detalhes?: unknown; codigo?: string };
    throw new ApiErrorProgresso(c.mensagem ?? c.erro ?? `HTTP ${res.status}`, c.detalhes, res.status, c.codigo);
  }
  return corpo as T;
}

// ---------- Tipos (espelham servidor/src/lib/progressao.ts) ----------

export interface CompraXp {
  kind: string;
  key: string;
  nome: string;
  campoId: string;
  nivelAnterior: number;
  nivelNovo: number;
  custoXp: number;
}

export interface EventoXp {
  em: string;
  tipo: "concessao" | "remocao" | "compra" | "ajuste";
  quantidade: number;
  motivo: string | null;
  autorId: string | null;
  autorNome: string | null;
  saldoResultante: number;
  compra?: CompraXp;
}

export interface ElementoDisponivel {
  kind: string;
  key: string;
  nome: string;
  nivelAtual: number;
  /** Preço em XP do próximo nível calculado pelo servidor; null = sem preço. */
  precoProximo: number | null;
  compravel: boolean;
  motivo?: string;
}

export interface Progressao {
  xp: { saldo: number; historico: EventoXp[] };
  disponiveis: ElementoDisponivel[];
}

export const apiProgressao = {
  obter: (characterId: string) =>
    requisicao<Progressao>(`/characters/${characterId}/progressao`),

  concederXp: (characterId: string, dados: { acao: "conceder" | "remover"; quantidade: number; motivo: string }) =>
    requisicao<{ ok: boolean; xp: { saldo: number; historico: EventoXp[] } }>(`/characters/${characterId}/xp`, {
      method: "POST",
      body: JSON.stringify(dados),
    }),

  comprarNivel: (characterId: string, dados: { kind: string; key: string; nivelAlvo: number }) =>
    requisicao<{ ok: boolean; xp: { saldo: number }; compra: CompraXp }>(`/characters/${characterId}/comprar-ponto`, {
      method: "POST",
      body: JSON.stringify(dados),
    }),
};
