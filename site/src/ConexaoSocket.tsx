import { useEffect, useRef, useState } from "react";
import { getSocket } from "./socket";

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

/** Indicador discreto de conexão — usar dentro de telas que dependem do tempo real. */
export function IndicadorConexao() {
  const estado = useEstadoConexao();
  return (
    <span className={`conexao conexao-${estado}`} title="Status da conexão em tempo real">
      <i aria-hidden="true" />
      {ROTULO[estado]}
    </span>
  );
}
