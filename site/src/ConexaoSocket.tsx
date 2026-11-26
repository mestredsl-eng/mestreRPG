import { useEffect, useRef, useState } from "react";
import { getSocket } from "./socket";
import { useUltimaSync } from "./useSincronizacao";

export type EstadoConexao = "conectando" | "conectado" | "reconectando" | "desconectado";

const ROTULO: Record<EstadoConexao, string> = {
  conectando: "Conectando…",
  conectado: "Conectado",
  reconectando: "Reconectando…",
  desconectado: "Sem conexão",
};

/**
 * Estado real da conexão Socket.IO do singleton — só marca "conectado"
 * depois do evento `connect` do servidor. Não cria conexão nova.
 */
export function useEstadoConexao(): EstadoConexao {
  const socket = getSocket();
  const jaConectou = useRef(socket.connected);
  const [estado, setEstado] = useState<EstadoConexao>(() =>
    socket.connected ? "conectado" : socket.active ? "conectando" : "desconectado"
  );

  useEffect(() => {
    const aoConnect = () => {
      jaConectou.current = true;
      setEstado("conectado");
    };
    const aoDisconnect = () => {
      if (!socket.active) setEstado("desconectado");
      else setEstado(jaConectou.current ? "reconectando" : "conectando");
    };
    const aoErro = () => {
      // connect_error durante a tentativa — o estado depende se já houve conexão
      setEstado(jaConectou.current ? "reconectando" : "conectando");
    };
    socket.on("connect", aoConnect);
    socket.on("disconnect", aoDisconnect);
    socket.on("connect_error", aoErro);
    return () => {
      socket.off("connect", aoConnect);
      socket.off("disconnect", aoDisconnect);
      socket.off("connect_error", aoErro);
    };
  }, [socket]);

  return estado;
}

function rotuloHora(ts: number): string {
  return new Date(ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Indicador discreto de conexão — usar dentro de telas que dependem do tempo real.
 * Com `campaignId`, acrescenta a hora da última sincronização concluída
 * (Issue #285): o horário só avança após um GET autoritativo terminar
 * com sucesso — não no recebimento de evento nem no socket.connected.
 * `tela` identifica a aba cuja marca deve ser exibida (semântica por
 * tela ativa — a sincronização de outra aba não altera este horário).
 */
export function IndicadorConexao({ campaignId, tela }: { campaignId?: string; tela?: string }) {
  const estado = useEstadoConexao();
  const ultima = useUltimaSync(campaignId ?? "", tela ?? "");

  let texto = ROTULO[estado];
  let detalhe: string | null = null;
  if (estado === "conectado" && ultima !== null) {
    texto = `${ROTULO.conectado} · Atualizado às ${rotuloHora(ultima)}`;
    detalhe = tela ? "Última sincronização desta tela concluída com sucesso" : "Última atualização de dados concluída com sucesso";
  } else if (estado === "desconectado") {
    if (campaignId) texto = `${ROTULO.desconectado} · sincronização interrompida`;
    detalhe = "Sincronização interrompida — os dados exibidos podem estar desatualizados";
  } else if (estado === "reconectando") {
    detalhe = "Reconectando — a sincronização será retomada automaticamente";
  }

  return (
    <span
      className={`conexao conexao-${estado}`}
      title={detalhe ? `${ROTULO[estado]} — ${detalhe}` : "Status da conexão em tempo real"}
      data-sync-ts={ultima ?? ""}
    >
      <i aria-hidden="true" />
      {texto}
    </span>
  );
}
