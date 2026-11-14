import { io, type Socket } from "socket.io-client";

let socket: Socket | null = null;

/** Cliente Socket.IO singleton — autenticação via cookie de sessão. */
export function getSocket(): Socket {
  if (!socket) {
    socket = io({
      path: "/socket.io",
      withCredentials: true,
      // Polling primeiro: funciona através de proxies/túneis que não
      // aceitam o upgrade WebSocket (ex.: NetBird). O socket.io faz o
      // upgrade automático para websocket quando o transporte está
      // disponível — nunca fica preso tentando WS primeiro.
      transports: ["polling", "websocket"],
      tryAllTransports: false,
    });
    // alça de diagnóstico SOMENTE em localhost (homologações Playwright):
    // permite injetar pacotes forjados pelo MESMO transporte do app.
    // A autorização real é sempre do servidor — o cliente não tem
    // privilégio extra por alcançar esta referência.
    if (typeof window !== "undefined" && /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)) {
      (window as unknown as { __mesaSocket?: Socket }).__mesaSocket = socket;
    }
  }
  return socket;
}

export function desconectarSocket() {
  socket?.disconnect();
  socket = null;
}
