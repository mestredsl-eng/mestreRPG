import type { Request, Response, NextFunction } from "express";

/**
 * Cabeçalhos de segurança HTTP (Etapa 15, R2).
 *
 * Aplicados a todas as respostas da API. A API só devolve JSON e arquivos
 * para download/preview same-origin, então a CSP é deliberadamente mínima:
 * `frame-ancestors 'self'` permite o preview de PDF/imagem em iframe na
 * própria origem (site/paginas/Arquivos.tsx) e bloqueia clickjacking por
 * sites externos. Não enviamos `default-src 'none'` porque quebraria a
 * renderização de PDFs no visualizador interno do navegador.
 *
 * A SPA (site/) recebe a política completa via headers do Vite — ver
 * site/vite.config.ts.
 */
export function headersSeguranca(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
  next();
}
