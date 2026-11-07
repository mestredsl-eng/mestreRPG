import { io, type Socket } from "socket.io-client";

let socket: Socket | null = null;

/** Cliente Socket.IO singleton — autenticação via cookie de sessão. */
export function getSocket(): Socket {
  if (!socket) {
    socket = io({
      path: "/socket.io",
      withCredentials: true,
      transports: ["websocket", "polling"],
    });
  }
  return socket;
}

export function desconectarSocket() {
  socket?.disconnect();
  socket = null;
}
