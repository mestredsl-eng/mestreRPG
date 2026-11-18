import { sql } from "drizzle-orm";
import type { getDb } from "../db/index.js";

export type ExecutorEscrita = Pick<ReturnType<typeof getDb>, "run">;

export async function gravarPapelStatusMembro(
  executor: ExecutorEscrita,
  membershipId: string,
  guildId: string,
  role: string,
  status: string,
): Promise<number> {
  const agora = new Date();
  // A linha só "perde GM capaz" quando o registro ATUAL é gm+ativo, a
  // CONTA do usuário está ativa (GM de conta bloqueada nunca foi capaz)
  // e os NOVOS valores deixam de sê-lo — comparações usam colunas da
  // própria linha e parâmetros vinculados, nunca strings do cliente.
  const perdeGmCapaz = sql`(
    role = 'gm'
    AND status = 'ativo'
    AND EXISTS (
      SELECT 1 FROM users ux
      WHERE ux.id = guild_members.user_id AND ux.status = 'ativo'
    )
    AND (${role} <> 'gm' OR ${status} <> 'ativo')
  )`;
  const r = await executor.run(sql`
    UPDATE guild_members
    SET role = ${role}, status = ${status}, updated_at = ${agora.getTime()}
    WHERE id = ${membershipId}
      AND guild_id = ${guildId}
      AND user_id IS NOT (
        SELECT responsible_user_id FROM guilds WHERE id = ${guildId}
      )
      AND NOT (
        ${perdeGmCapaz}
        AND (
          SELECT count(*)
          FROM guild_members gm
          JOIN users u ON u.id = gm.user_id
          WHERE gm.guild_id = ${guildId}
            AND gm.role = 'gm'
            AND gm.status = 'ativo'
            AND u.status = 'ativo'
        ) <= 1
      )
  `);
  return r.changes;
}

export async function gravarResponsavelGuilda(
  executor: ExecutorEscrita,
  guildId: string,
  responsavelAnteriorId: string | null,
  novoId: string,
): Promise<number> {
  const agora = new Date();
  const r = await executor.run(sql`
    UPDATE guilds
    SET responsible_user_id = ${novoId}, updated_at = ${agora.getTime()}
    WHERE id = ${guildId}
      AND responsible_user_id IS ${responsavelAnteriorId}
      AND EXISTS (
        SELECT 1 FROM guild_members gm
        JOIN users u ON u.id = gm.user_id
        WHERE gm.guild_id = ${guildId}
          AND gm.user_id = ${novoId}
          AND gm.role = 'gm'
          AND gm.status = 'ativo'
          AND u.status = 'ativo'
      )
  `);
  return r.changes;
}
