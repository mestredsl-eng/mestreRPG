import { config } from "../config.js";

/**
 * Política de origens permitidas para o Socket.IO (Etapa 15, R3).
 *
 * CORS não substitui autenticação — o handshake continua exigindo sessão
 * válida (ver sockets/index.ts). Esta camada só decide se a origem do
 * navegador é legítima antes mesmo da autenticação.
 *
 * Origens aceitas:
 *  - sem header Origin: clientes não-browser (curl, socket.io-client em
 *    Node, testes). Não há risco de CSRF porque não existe navegador;
 *  - localhost / 127.0.0.1 / [::1] — desenvolvimento e acesso local;
 *  - IPs privados IPv4 (10/8, 172.16/12, 192.168/16, 169.254/16) e
 *    sufixos .local/.lan/.internal — acesso pela rede local (LAN);
 *  - o domínio público configurado (config.acesso.dominioPublico ou o
 *    ajuste salvo em server_settings "acesso") — acesso externo via
 *    túnel/proxy.
 *
 * Qualquer outra origem é rejeitada.
 */

function hostLocalOuLan(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]") return true;
  if (h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".internal")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/**
 * @param dominioPublico domínio configurado pelo admin (server_settings)
 *   ou configuracao/servidor.json. Pode vir com ou sem esquema/porta.
 */
export function origemPermitida(origin: string | undefined, dominioPublico?: string): boolean {
  if (!origin) return true; // cliente não-browser: sem risco de CSRF
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  if (hostLocalOuLan(u.hostname)) return true;

  const dominio = (dominioPublico ?? config.acesso.dominioPublico ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  if (!dominio) return false;
  // aceita o domínio configurado com ou sem porta explícita
  const semPorta = dominio.replace(/:\d+$/, "");
  return u.hostname.toLowerCase() === semPorta || u.host.toLowerCase() === dominio;
}
