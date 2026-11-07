import type { Request, Response, NextFunction } from "express";
import { log } from "../lib/logs.js";

interface ErroHttp extends Error {
  status?: number;
  statusCode?: number;
  type?: string;
}

/**
 * Middleware central de erros (Express 4).
 * Nunca expõe stack, caminhos internos ou detalhes de banco ao cliente;
 * o detalhe técnico vai apenas para o log interno (sem segredos).
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const e = err as ErroHttp;
  const rota = `${req.method} ${req.originalUrl ?? req.url}`;
  const statusHttp = e?.status ?? e?.statusCode;

  // Erros do body-parser (JSON malformado, payload acima do limite etc.)
  if (statusHttp === 413 || e?.type === "entity.too.large") {
    log("aviso", "payload excede o limite", { rota });
    res.status(413).json({ erro: "Payload muito grande" });
    return;
  }
  if (
    statusHttp === 400 ||
    e?.type === "entity.parse.failed" ||
    e?.type === "encoding.unsupported" ||
    e instanceof URIError
  ) {
    log("aviso", "requisição malformada", { rota, tipo: e?.type ?? e?.name });
    res.status(400).json({ erro: "Requisição malformada" });
    return;
  }

  log("erro", "erro interno", { rota, erro: String(e?.stack ?? err) });
  res.status(500).json({ erro: "Erro interno do servidor" });
}
