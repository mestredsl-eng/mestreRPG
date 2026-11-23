/**
 * API de leitura de Pontos de Sangue (Issue #186, R7.1/C8-C1).
 * Módulo isolado — não toca api.ts nem api-progressao.ts.
 * O servidor é a autoridade: saldo/capacidade/natureza/ação efetiva
 * vêm prontos do GET; o cliente nunca lê characters.data nem
 * expõe usos/histórico bruto.
 */

const API_BASE = "/api";

export class ApiErrorSangue extends Error {
  status: number;
  constructor(mensagem: string, status = 0) {
    super(mensagem);
    this.status = status;
  }
}

/** Estado seguro devolvido pelo GET /characters/:id/sangue. */
export type EstadoSangue =
  | "ok"
  | "desabilitado"
  | "indisponivel"
  | "capacidade_indisponivel"
  | "ledger_invalido";

export interface NaturezaSangue {
  rotulo: string;
  conhecida: boolean;
  metaHumanoComPoder: boolean;
}

export interface AcaoRecuperacaoSangue {
  acao: "descansar" | "alimentar";
  quantidade: number;
}

/** Projeção mínima e estável do GET — nunca inclui usos, histórico,
 *  data bruto nem UUIDs internos. */
export interface SangueLeitura {
  estado: EstadoSangue;
  motivo?: string;
  habilitado: boolean;
  utilizavel: boolean;
  saldo: number | null;
  capacidadeMax: number | null;
  natureza: NaturezaSangue | null;
  acaoRecuperacao: AcaoRecuperacaoSangue | null;
}

export const apiSangue = {
  obter: async (characterId: string): Promise<SangueLeitura> => {
    const res = await fetch(`${API_BASE}/characters/${encodeURIComponent(characterId)}/sangue`, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const corpo = await res.json().catch(() => ({}));
    if (!res.ok) {
      const c = corpo as { erro?: string; mensagem?: string };
      throw new ApiErrorSangue(c.mensagem ?? c.erro ?? `HTTP ${res.status}`, res.status);
    }
    return corpo as SangueLeitura;
  },
};
