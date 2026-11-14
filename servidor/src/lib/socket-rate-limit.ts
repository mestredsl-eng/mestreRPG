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

  const podar = (agora: number) => {
    // 1) Remove buckets expirados e cheios parados — não precisam de
    // estado. Buckets parcialmente consumidos são usuários ativos:
    // removê-los renovaria a cota de quem está sendo limitado.
    for (const [k, b] of buckets) {
      const ocioso = agora - b.atualizadoEm > limpezaMs * 10;
      const cheioParado = b.tokens >= op.capacidade && agora - b.atualizadoEm > limpezaMs;
      if (ocioso || cheioParado) buckets.delete(k);
    }
    // 2) Acima do teto: remove o bucket CHEIO menos recentemente usado.
    // Se só restarem buckets ativos, o mapa excede o teto — preferível
    // a memória temporária a renovar cota de usuário limitado.
    while (buckets.size > maxChaves) {
      let alvo: [string, Bucket] | null = null;
      for (const e of buckets) {
        if (e[1].tokens >= op.capacidade && (!alvo || e[1].atualizadoEm < alvo[1].atualizadoEm)) alvo = e;
      }
      if (!alvo) break;
      buckets.delete(alvo[0]);
    }
  };

  const timer = setInterval(() => {
    const agora = Date.now();
    for (const [k, b] of buckets) {
      if (agora - b.atualizadoEm > limpezaMs * 10) buckets.delete(k);
    }
  }, limpezaMs);
  timer.unref();

  return {
    consumir(chave) {
      const agora = Date.now();
      let b = buckets.get(chave);
      if (!b) {
        if (buckets.size >= maxChaves) podar(agora);
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
      // porMs já é tokens/ms — o resultado está em ms, sem *1000.
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
export const LIMITES_SOCKET_MESA = {
  /** `mesa:mensagem` — chat */
  chat: { nome: "mesa-chat", capacidade: 8, porSegundo: 2 },
  /** `mesa:rolar` — rolagens livres */
  rolagem: { nome: "mesa-rolagem", capacidade: 6, porSegundo: 1.5 },
  /** `mesa:teste:pedir` — solicitar teste de atributo */
  testePedir: { nome: "mesa-teste-pedir", capacidade: 4, porSegundo: 0.5 },
  /** `mesa:teste:rolar` — rolar teste pendente */
  testeRolar: { nome: "mesa-teste-rolar", capacidade: 6, porSegundo: 1.5 },
  /** `mesa:teste:decidir` — decidir resultado de teste */
  testeDecidir: { nome: "mesa-teste-decidir", capacidade: 6, porSegundo: 1.5 },
  /** `mesa:turno` + `mesa:timer` — controle de turno/tempo */
  turno: { nome: "mesa-turno", capacidade: 8, porSegundo: 2 },
  /** `mesa:vtt:mapa` — upload/troca de mapa (regrava vtt_state inteiro) */
  vttMapa: { nome: "mesa-vtt-mapa", capacidade: 4, porSegundo: 0.5 },
  /** `mesa:vtt:token` — criar/mover tokens (drag = bursts legítimos) */
  vttToken: { nome: "mesa-vtt-token", capacidade: 10, porSegundo: 2 },
  /** `mesa:vtt:nevoa` — 1 emit por gesto de pointerup, serializado no
   *  cliente; cota generosa cobre traços em rajada e flood fica bloqueado */
  vttNevoa: { nome: "mesa-vtt-nevoa", capacidade: 6, porSegundo: 2 },
  /** `mesa:vtt:nevoa:sincronizar` — leitura filtrada; tolerante a retries
   *  de reconexão e estado incerto */
  vttSync: { nome: "mesa-vtt-sync", capacidade: 10, porSegundo: 2 },
  /** `mesa:entrar` — entrada na mesa (join + msg de presença + leituras);
   *  folga para reconexões legítimas de socket */
  entrar: { nome: "mesa-entrar", capacidade: 10, porSegundo: 2 },
} as const;

export type AcaoMesaLimitada = keyof typeof LIMITES_SOCKET_MESA;

/** Chave canônica: usuário autenticado + ação. Socket/aba não entra. */
export function chaveSocket(userId: string, acao: AcaoMesaLimitada): string {
  return `${LIMITES_SOCKET_MESA[acao].nome}:${userId}`;
}
