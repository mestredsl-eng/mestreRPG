import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Sistema global de notificações (Etapa D1).
 *
 * - Tipos: sucesso, erro, aviso, info — cores da identidade visual.
 * - Não bloqueia a página; empilha até MAX_VISIVEIS e descarta as mais antigas.
 * - Auto-dismiss: erros ficam mais tempo (leitura); sucesso/info somem rápido.
 * - Dedup: mesma mensagem+tipo dentro de JANELA_DEDUP_MS não duplica.
 * - Acessibilidade: aria-live=polite no container; erros usam role="alert".
 * - Sobrevive à navegação (provider na raiz do App).
 */

export type TipoNotificacao = "sucesso" | "erro" | "aviso" | "info";

interface Notificacao {
  id: number;
  tipo: TipoNotificacao;
  texto: string;
}

const DURACAO_MS: Record<TipoNotificacao, number> = {
  sucesso: 4000,
  info: 5000,
  aviso: 6500,
  erro: 9000,
};
const MAX_VISIVEIS = 4;
const JANELA_DEDUP_MS = 3000;

interface CtxNotificacoes {
  notificar: (texto: string, tipo?: TipoNotificacao, opcoes?: { deduplicar?: boolean }) => void;
}

const Contexto = createContext<CtxNotificacoes>({ notificar: () => {} });

export function useNotificar(): CtxNotificacoes {
  return useContext(Contexto);
}

let proximoId = 1;

export function ProvedorNotificacoes({ children }: { children: ReactNode }) {
  const [itens, setItens] = useState<Notificacao[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const pausados = useRef(new Set<number>());
  const vistos = useRef(new Map<string, number>());

  const remover = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    pausados.current.delete(id);
    setItens((atual) => atual.filter((n) => n.id !== id));
  }, []);

  const agendar = useCallback((id: number, tipo: TipoNotificacao) => {
    const t = setTimeout(() => remover(id), DURACAO_MS[tipo]);
    timers.current.set(id, t);
  }, [remover]);

  const notificar = useCallback((texto: string, tipo: TipoNotificacao = "info", opcoes?: { deduplicar?: boolean }) => {
    // Eventos com identidade própria (ex.: id+revisão) podem desativar a
    // deduplicação textual global sem afetar o comportamento dos demais toasts.
    if (opcoes?.deduplicar !== false) {
      const chave = `${tipo}|${texto}`;
      const agora = Date.now();
      const ultimo = vistos.current.get(chave);
      if (ultimo !== undefined && agora - ultimo < JANELA_DEDUP_MS) return;
      vistos.current.set(chave, agora);
      // limpeza oportunista do mapa de dedup
      if (vistos.current.size > 100) {
        for (const [k, ts] of vistos.current) if (agora - ts > 60_000) vistos.current.delete(k);
      }
    }

    const id = proximoId++;
    setItens((atual) => [...atual, { id, tipo, texto }].slice(-MAX_VISIVEIS));
    // Itens que saem da janela mantêm o timer; quando dispara, remover()
    // vira no-op (o id já não está na lista). Custo limitado e sem efeito colateral.
    agendar(id, tipo);
  }, [agendar, remover]);

  // limpeza geral no unmount
  useEffect(() => () => {
    for (const t of timers.current.values()) clearTimeout(t);
    timers.current.clear();
  }, []);

  const pausar = (id: number) => {
    if (pausados.current.has(id)) return;
    pausados.current.add(id);
    const t = timers.current.get(id);
    if (t) { clearTimeout(t); timers.current.delete(id); }
  };
  const retomar = (id: number, tipo: TipoNotificacao) => {
    if (!pausados.current.has(id)) return;
    pausados.current.delete(id);
    agendar(id, tipo);
  };

  return (
    <Contexto.Provider value={{ notificar }}>
      {children}
      <div className="notificacoes-viewport" aria-live="polite" aria-label="Notificações">
        {itens.map((n) => (
          <div
            key={n.id}
            className={`notificacao notificacao-${n.tipo}`}
            role={n.tipo === "erro" ? "alert" : "status"}
            onMouseEnter={() => pausar(n.id)}
            onMouseLeave={() => retomar(n.id, n.tipo)}
            onFocus={() => pausar(n.id)}
            onBlur={() => retomar(n.id, n.tipo)}
          >
            <span className="notificacao-texto">{n.texto}</span>
            <button
              type="button"
              className="notificacao-fechar"
              aria-label="Fechar notificação"
              onClick={() => remover(n.id)}
            >×</button>
          </div>
        ))}
      </div>
    </Contexto.Provider>
  );
}
