import { Router } from "express";
import { existsSync, statfsSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getDb, CAMINHOS, RAIZ } from "../db/index.js";
import { listarBackups } from "../lib/backup.js";

export const healthRouter = Router();
const db = getDb();

healthRouter.get("/health", async (_req, res) => {
  const checagens: Record<string, boolean> = {};
  const alertas: string[] = [];

  // backend (sempre true se respondeu)
  checagens.backend = true;

  // banco acessível
  try {
    const { users } = await import("../db/schema.js");
    await db.select({ id: users.id }).from(users).limit(1);
    checagens.banco = true;
  } catch { checagens.banco = false; alertas.push("banco_inacessivel"); }

  // diretório de arquivos acessível e gravável
  try {
    const probe = join(CAMINHOS.arquivos, ".healthcheck");
    writeFileSync(probe, "ok");
    unlinkSync(probe);
    checagens.arquivos = existsSync(CAMINHOS.arquivos);
  } catch { checagens.arquivos = false; }
  if (!checagens.arquivos) alertas.push("diretorio_arquivos_indisponivel");

  // disco
  try {
    const s = statfsSync(RAIZ);
    const livre = Number(s.bavail) * Number(s.bsize);
    const total = Number(s.blocks) * Number(s.bsize);
    checagens.disco = livre / total > 0.05;
    if (!checagens.disco) alertas.push("pouco_espaco_disco");
  } catch { checagens.disco = false; alertas.push("disco_indisponivel"); }

  // último backup
  try {
    const ultimos = await listarBackups();
    const ultimo = ultimos[0];
    checagens.backup = !!ultimo && ultimo.sucesso !== false;
    if (!ultimo) alertas.push("nenhum_backup");
    else if (ultimo.sucesso === false) alertas.push("ultimo_backup_falhou");
  } catch { checagens.backup = false; }

  const status = !checagens.banco || !checagens.arquivos ? "indisponivel" : alertas.length ? "avisos" : "ok";
  res.status(status === "indisponivel" ? 503 : 200).json({
    status, servico: "mestre-rpg-api", timestamp: new Date().toISOString(),
    checagens, alertas,
  });
});
