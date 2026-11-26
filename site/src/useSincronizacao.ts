import { useEffect, useRef, useSyncExternalStore } from "react";
import { getSocket } from "./socket";

/**
 * Sincronização de páginas da campanha por invalidação via Socket.IO
 * (Issue #67).
 *
 * O servidor já emite eventos de invalidação na room `campanha:{id}`
 * (`emitirCampanha`) sem payload sensível — este hook apenas agenda uma
 * recarga: o callback deve buscar os dados de novo pela API HTTP, que
 * reaplica toda a filtragem de visibilidade do backend.
 *
 * - Coalescência: eventos da mesma página dentro de DEBOUNCE_MS geram uma
 *   única invalidação; eventos de nomes diferentes não se cancelam.
 * - Reconexão: o evento "connect" do socket agenda uma invalidação —
 *   a página visível se resincroniza ao voltar a conexão.
 * - Cleanup exato: todos os listeners e timers pendentes são removidos
 *   no unmount/troca de dependência; nada é emitido nem room criada aqui
 *   (o componente pai já gerencia `entrar-campanha`/`sair-campanha`).
 */

export type AoInvalidar = (evento: string, payload?: unknown) => void;

const DEBOUNCE_MS = 250;
/** Nome interno usado quando a invalidação vem de reconexão do socket. */
export const EVENTO_RECONEXAO = "reconexao";

export function useSincronizacaoCampanha(eventos: readonly string[], aoInvalidar: AoInvalidar) {
  // sempre o callback mais recente, sem religar listeners a cada render
  const cbRef = useRef(aoInvalidar);
  cbRef.current = aoInvalidar;
  const chave = eventos.join("\n");

  useEffect(() => {
    const socket = getSocket();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    const agendar = (chaveEvento: string, evento: string, payload?: unknown) => {
      const t = timers.get(chaveEvento);
      if (t) clearTimeout(t);
      timers.set(
        chaveEvento,
        setTimeout(() => {
          timers.delete(chaveEvento);
          cbRef.current(evento, payload);
        }, DEBOUNCE_MS)
      );
    };

    const handlers = eventos.map((ev) => {
      const h = (payload?: unknown) => agendar(ev, ev, payload);
      socket.on(ev, h);
      return [ev, h] as const;
    });
    // reconexão (e conexão inicial tardia) → resincroniza os dados visíveis
    const aoConectar = () => agendar(EVENTO_RECONEXAO, EVENTO_RECONEXAO);
    socket.on("connect", aoConectar);

    return () => {
      for (const [ev, h] of handlers) socket.off(ev, h);
      socket.off("connect", aoConectar);
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
    // `eventos` deve ser uma lista estável (constante de módulo ou memoizada);
    // a chave serializada cobre o caso de literal inline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chave]);
}

/**
 * Issue #285 — marca da última sincronização concluída por campanha.
 *
 * As páginas chamam `registrarSyncOk(campaignId)` somente depois que a
 * busca autoritativa (GET) termina com sucesso — nunca no recebimento
 * do evento nem no `socket.connected`. O store é por campanha: uma
 * resposta tardia da campanha A não altera o indicador da campanha B.
 */
const marcasSync = new Map<string, number>();
const ouvintesSync = new Set<() => void>();

export function registrarSyncOk(campaignId: string) {
  marcasSync.set(campaignId, Date.now());
  ouvintesSync.forEach((o) => o());
}

export function useUltimaSync(campaignId: string): number | null {
  return useSyncExternalStore(
    (cb) => {
      ouvintesSync.add(cb);
      return () => ouvintesSync.delete(cb);
    },
    () => marcasSync.get(campaignId) ?? null,
    () => null
  );
}
