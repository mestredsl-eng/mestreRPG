// Backup pré-migration do auto-update (Issue #155).
// Usa o mecanismo de snapshot consistente já existente em lib/backup.ts
// (better-sqlite3.backup + integrity_check + manifesto v2), marcado como
// PROTEGIDO contra a retenção diária/semanal enquanto o journal do
// updater estiver ativo. Se a proteção não puder ser gravada, o backup
// falha — nunca existe backup transacional desprotegido.
import { criarBackup } from "../lib/backup.js";

export interface ResultadoBackupPreUpdate {
  id: string;
  dir: string;
  sucesso: boolean;
  erros: string[];
  tamanho: number;
}

/**
 * Cria o backup completo pós-restauração e pré-migration.
 * `meta` registra shaAnterior/shaNovo/fase no manifesto para rastreio.
 */
export async function criarBackupPreUpdate(
  meta: { shaAnterior?: string; shaNovo?: string; fase?: string } = {},
  nota?: string,
): Promise<ResultadoBackupPreUpdate> {
  const r = await criarBackup("pre_update", nota ?? "Backup pré-migration do auto-update", {
    proteger: true,
    meta: { origem: "auto-update", ...meta },
  });
  return { id: r.id, dir: r.dir, sucesso: r.sucesso, erros: r.erros, tamanho: r.tamanho };
}
