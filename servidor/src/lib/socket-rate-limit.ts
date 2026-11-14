import { log } from "./logs.js";

/**
 * Rate limiter em memória para eventos Socket.IO (Issue #68).
 *
 * Token bucket por chave, independente do socket: a chave deve ser
 * `userId:acao`, para que várias abas/conexões do mesmo usuário
 * compartilhem a mesma cota. Sem acoplamento a Express — os handlers de
 * socket chamam `consumir(chave)` e usam o resultado para responder o
 * ACK ou emitir feedback.
 *
 * Limite em memória vale para a instância atual do processo; a aplicação
 * já possui trava de instância única, então não há estado compartilhado
 * entre processos.
 */

export interface ResultadoLimite {
  permitido: boolean;
  /** ms até pelo menos 1 token voltar — preencher `retryAfterMs` do ACK */
  retryAfterMs: number;
}

export interface OpcoesLimitadorSocket {
  /** prefixo do nome do limite — aparece no log e isola buckets de teste */
  nome: string;
  /** capacidade máxima de tokens (limite de rajada) */
  capacidade: number;
  /** tokens repostos por segundo (taxa sustentada) */
  porSegundo: number;
  /** intervalo da limpeza de chaves expiradas (default 60s) */
  limpezaMs?: number;
  /** teto de chaves simultâneas; acima disso, chaves ociosas são podadas (default 10k) */
  maxChaves?: number;
}

interface Bucket {
  tokens: number;
  atualizadoEm: number;
}

export interface LimitadorSocket {
  consumir(chave: string): ResultadoLimite;
  /** zera os buckets (testes) */
  reiniciar(): void;
}

export function criarLimitadorSocket(op: OpcoesLimitadorSocket): LimitadorSocket {
  const buckets = new Map<string, Bucket>();
  const porMs = op.porSegundo / 1000;
  const maxChaves = op.maxChaves ?? 10_000;
  const limpezaMs = op.limpezaMs ?? 60_000;
  // tempo (ms) para um bucket esvaziado voltar a ficar cheio — um bucket
  // só é "podável" quando já recarregou por completo, pois antes disso
  // apagar a chave perdoaria cota ativa de outro usuário.
  const tempoReporTotal = op.capacidade / porMs;

  /** Remove somente buckets sem estado útil: já recarregados por completo
   *  (tokens no teto), tempo suficiente para recarga total, ou muito
   *  antigos. Nunca apaga bucket com cota parcialmente consumida. */
  const podar = (agora: number) => {
    for (const [k, b] of buckets) {
      const decorrido = agora - b.atualizadoEm;
      const tokensProjetados = Math.min(op.capacidade, b.tokens + decorrido * porMs);
      if (tokensProjetados >= op.capacidade || decorrido > limpezaMs * 10) {
        buckets.delete(k);
      }
    }
  };

  /** Menor espera até existir uma chave podável (para o retryAfterMs do fail-closed). */
  const esperaAteCapacidade = (agora: number): number => {
    let menor = Infinity;
    for (const b of buckets.values()) {
      // quanto falta para este bucket projetar tokens == capacidade
      const falta = (op.capacidade - b.tokens) / porMs;
      menor = Math.min(menor, b.atualizadoEm + falta);
    }
    if (!Number.isFinite(menor)) return tempoReporTotal;
    return Math.max(1, Math.ceil(menor - agora));
  };

  const timer = setInterval(() => {
    const agora = Date.now();
    for (const [k, b] of buckets) {
      const decorrido = agora - b.atualizadoEm;
      const tokensProjetados = Math.min(op.capacidade, b.tokens + decorrido * porMs);
      if (tokensProjetados >= op.capacidade || decorrido > limpezaMs * 10) buckets.delete(k);
    }
  }, limpezaMs);
  timer.unref();

  return {
    consumir(chave) {
      const agora = Date.now();
      let b = buckets.get(chave);
      if (!b) {
        // Teto REAL de chaves: se o mapa está cheio, poda apenas buckets
        // stateless; persistindo o teto, a chave NOVA é rejeitada
        // (fail-closed) — nunca se apaga a cota de outra chave ativa.
        if (buckets.size >= maxChaves) {
          podar(agora);
          if (buckets.size >= maxChaves) {
            const retryAfterMs = esperaAteCapacidade(agora);
            log("aviso", "socket rate limit saturado (maxChaves)", {
              limite: op.nome,
              chaves: buckets.size,
              retryAfterMs,
            });
            return { permitido: false, retryAfterMs };
          }
        }
        b = { tokens: op.capacidade, atualizadoEm: agora };
        buckets.set(chave, b);
      }
      const decorrido = Math.max(0, agora - b.atualizadoEm);
      b.tokens = Math.min(op.capacidade, b.tokens + decorrido * porMs);
      b.atualizadoEm = agora;
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return { permitido: true, retryAfterMs: 0 };
      }
      // porMs é tokens/ms — (1 - tokens)/porMs já é o tempo em ms
      const retryAfterMs = Math.max(1, Math.ceil((1 - b.tokens) / porMs));
      log("aviso", "socket rate limit excedido", {
        limite: op.nome,
        chave,
        retryAfterMs,
      });
      return { permitido: false, retryAfterMs };
    },
    reiniciar() {
      buckets.clear();
    },
  };
}

/**
 * Cotas da Mesa (Issue #68). Valores iniciais conservadores: protegem
 * contra flood sem atrapalhar uma sessão legítima. Ajuste centralizado
 * aqui — cada ação tem bucket próprio para que um tipo de evento não
 * consuma a cota de outro.
 */
// Cotas calibradas contra o uso legítimo observado nas suítes de
// regressão (emissões ACK sequenciais chegam a ~50-200 ops/s em loops
// de validação) e contra o uso interativo real (~1-3 ops/s). O burst
// cobre gestos legítimos; a taxa sustentada é o que bloqueia flood.
export const LIMITES_SOCKET_MESA = {
  /** `mesa:mensagem` — chat */
  chat: { nome: "mesa-chat", capacidade: 10, porSegundo: 3 },
  /** `mesa:rolar` — rolagens livres */
  rolagem: { nome: "mesa-rolagem", capacidade: 12, porSegundo: 3 },
  /** `mesa:teste:pedir` — solicitar teste de atributo */
  testePedir: { nome: "mesa-teste-pedir", capacidade: 15, porSegundo: 3 },
  /** `mesa:teste:rolar` — rolar teste pendente */
  testeRolar: { nome: "mesa-teste-rolar", capacidade: 10, porSegundo: 3 },
  /** `mesa:teste:decidir` — decidir resultado de teste */
  testeDecidir: { nome: "mesa-teste-decidir", capacidade: 10, porSegundo: 3 },
  /** `mesa:turno` + `mesa:timer` — controle de turno/tempo. A suíte de
   *  regressão do temporizador emite ~50 operações de validação em
   *  janelas curtas; o burst precisa cobri-las sem abrir flood sustentado. */
  turno: { nome: "mesa-turno", capacidade: 50, porSegundo: 8 },
  /** `mesa:entrar` — entrada/reconexão na sala (grava "entrou na mesa") */
  entrar: { nome: "mesa-entrar", capacidade: 15, porSegundo: 3 },
  /** `mesa:vtt:mapa` — definir/remover mapa (raro, só mestre) */
  vttMapa: { nome: "mesa-vtt-mapa", capacidade: 12, porSegundo: 2 },
  /** `mesa:vtt:token` — criar/mover/remover token; operações em massa
   *  legítimas chegam ao teto de domínio de 100 tokens (~200 ops
   *  sequenciais na suíte de regressão), então o burst é generoso —
   *  a proteção real é a taxa sustentada. */
  vttToken: { nome: "mesa-vtt-token", capacidade: 250, porSegundo: 20 },
  /** `mesa:vtt:nevoa` — traços/gestos de névoa (um emit por traço;
   *  desenhar rápido fica na casa de 1-3 traços/s) */
  vttNevoa: { nome: "mesa-vtt-nevoa", capacidade: 30, porSegundo: 6 },
} as const;

export type AcaoMesaLimitada = keyof typeof LIMITES_SOCKET_MESA;

/** Chave canônica: usuário autenticado + ação. Socket/aba não entra. */
export function chaveSocket(userId: string, acao: AcaoMesaLimitada): string {
  return `${LIMITES_SOCKET_MESA[acao].nome}:${userId}`;
}
