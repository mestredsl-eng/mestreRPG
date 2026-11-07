import type { Request, Response, NextFunction } from "express";
import { log } from "./logs.js";

/**
 * Rate limiter em memória (Etapa 15, R4).
 *
 * Janela fixa por chave. A chave padrão é o IP efetivo (req.ip, que já
 * respeita `trust proxy`/`proxyHops`); rotas autenticadas devem passar
 * `chave` que prefira `req.usuario.id` — assim falsificar X-Forwarded-For
 * não ajuda a contornar o limite, e usuários atrás do mesmo NAT não
 * compartilham cota quando autenticados.
 *
 * Resposta 429 com Retry-After em segundos. Eventos são registrados no
 * log interno sem dados sensíveis.
 */

interface Entrada {
  count: number;
  resetEm: number;
}

const janelas = new Map<string, Entrada>();

// Limpeza periódica para não acumular chaves expiradas.
const timer = setInterval(() => {
  const agora = Date.now();
  for (const [k, v] of janelas) if (v.resetEm <= agora) janelas.delete(k);
}, 60_000);
timer.unref();

export interface OpcoesLimite {
  /** nome do limite — prefixa a chave e aparece no log */
  nome: string;
  /** tamanho da janela em ms */
  janelaMs: number;
  /** máximo de requisições por janela */
  max: number;
  /** função de chave; default: IP efetivo */
  chave?: (req: Request) => string;
}

const chavePadrao = (req: Request) => `ip:${req.ip ?? "desconhecido"}`;
const chaveUsuario = (req: Request) => `user:${req.usuario?.id ?? req.ip ?? "?"}`;

export function limitador(op: OpcoesLimite) {
  const chaveFn = op.chave ?? chavePadrao;
  return (req: Request, res: Response, next: NextFunction) => {
    const agora = Date.now();
    const chave = `${op.nome}:${chaveFn(req)}`;
    let reg = janelas.get(chave);
    if (!reg || reg.resetEm <= agora) {
      reg = { count: 0, resetEm: agora + op.janelaMs };
      janelas.set(chave, reg);
    }
    reg.count += 1;
    if (reg.count > op.max) {
      const retryAfter = Math.max(1, Math.ceil((reg.resetEm - agora) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      log("aviso", "rate limit excedido", {
        limite: op.nome,
        rota: `${req.method} ${req.baseUrl}${req.path}`,
      });
      res.status(429).json({ erro: "Muitas requisições. Aguarde e tente novamente." });
      return;
    }
    next();
  };
}

/** Limite por usuário autenticado (cai para IP se não houver sessão). */
export function limiteUsuario(op: Omit<OpcoesLimite, "chave">) {
  return limitador({ ...op, chave: chaveUsuario });
}

/** Limite por IP efetivo — para rotas públicas (ex.: login). */
export function limiteIp(op: Omit<OpcoesLimite, "chave">) {
  return limitador({ ...op, chave: chavePadrao });
}
