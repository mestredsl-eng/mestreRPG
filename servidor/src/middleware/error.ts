import type { Request, Response, NextFunction } from "express";

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  console.error("[erro]", err);
  const mensagem = err instanceof Error ? err.message : "Erro interno";
  res.status(500).json({ erro: mensagem });
}
