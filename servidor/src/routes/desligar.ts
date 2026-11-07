import { Router } from "express";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RAIZ } from "../db/index.js";
import { solicitarDesligamento } from "../lib/ciclo-vida.js";
import { log } from "../lib/logs.js";

export const localRouter = Router();

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function segredoLocal(): string | null {
  try {
    const arq = resolve(RAIZ, "configuracao", "local.json");
    if (!existsSync(arq)) return null;
    const j = JSON.parse(readFileSync(arq, "utf-8")) as { segredoLocal?: string };
    return j.segredoLocal ?? null;
  } catch { return null; }
}

function ipLocal(req: { socket: { remoteAddress?: string } }): boolean {
  return LOOPBACK.has(req.socket.remoteAddress ?? "");
}

/**
 * POST /api/local/desligar — encerramento solicitado por script local (parar-mestre-rpg).
 * Exige: conexão originada do próprio computador (socket loopback, não cabeçalho)
 * e o segredo de configuracao/local.json (arquivo local, não versionado).
 * Não substitui a rota admin autenticada; é o canal do procedimento de parada.
 */
localRouter.post("/desligar", (req, res) => {
  if (!ipLocal(req)) {
    log("aviso", "tentativa de desligamento remoto recusada", { ip: req.socket.remoteAddress });
    return res.status(403).json({ erro: "Apenas conexões locais" });
  }
  const segredo = segredoLocal();
  const enviado = req.header("x-mestre-local") ?? "";
  if (!segredo || enviado !== segredo) {
    log("aviso", "desligamento local com token inválido");
    return res.status(401).json({ erro: "Não autorizado" });
  }
  const ok = solicitarDesligamento();
  if (!ok) return res.status(409).json({ erro: "Encerramento já em andamento ou indisponível" });
  log("info", "encerramento solicitado via script local");
  res.json({ ok: true, mensagem: "Encerrando servidor…" });
});
