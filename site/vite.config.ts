import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Cabeçalhos de segurança da SPA (Etapa 15, R2).
// A API aplica sua própria política em servidor/src/middleware/headers.ts.
const cabecalhosBase = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "X-Frame-Options": "SAMEORIGIN",
};

// CSP da SPA: scripts/estilos/fontes/imagens somente da mesma origem.
// style-src 'unsafe-inline' é necessário: React usa style attributes e o Vite
// injeta <style> em dev/HMR. connect-src permite 'self' + ws:/wss: porque o
// Socket.IO pode usar websocket em qualquer host da LAN ou do túnel — a
// autenticação da sessão continua sendo a barreira real.
const csp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");

const proxyApi = {
  "/api": "http://localhost:3001",
  "/socket.io": { target: "http://localhost:3001", ws: true },
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Em dev não enviamos CSP: o plugin React injeta um <script> inline de
    // preâmbulo/HMR que uma política script-src 'self' bloquearia.
    headers: cabecalhosBase,
    proxy: proxyApi,
  },
  preview: {
    port: 4173,
    headers: { ...cabecalhosBase, "Content-Security-Policy": csp },
    proxy: proxyApi,
  },
});
