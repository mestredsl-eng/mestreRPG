import { sql } from "drizzle-orm";
import type { getDb } from "../db/index.js";

/** Executor mínimo de escrita — o db do servidor ou uma conexão drizzle
 *  equivalente (usado pelos testes para provar a guarda de forma
 *  determinística sem passar pela trava de instância do getDb). */
export type ExecutorEscrita = Pick<ReturnType<typeof getDb>, "run">;

/**
 * Grava papel/status do vínculo SOMENTE se o usuário ainda não for o
 * responsável atual da guilda NO INSTANTE da escrita — a condição vive
 * no próprio UPDATE (subselect em guilds.responsible_user_id), fechando
 * a corrida entre a leitura do handler e uma transferência de
 * responsabilidade que commite no meio do caminho. Retorna o número de
 * linhas alteradas (0 = bloqueado pelo guarda; o chamador responde 409).
 */
export async function gravarPapelStatusMembro(
  executor: ExecutorEscrita,
  membershipId: string,
  guildId: string,
  role: string,
  status: string,
): Promise<number> {
  const agora = new Date();
  const r = await executor.run(sql`
    UPDATE guild_members
    SET role = ${role}, status = ${status}, updated_at = ${agora.getTime()}
    WHERE id = ${membershipId}
      AND guild_id = ${guildId}
      AND user_id IS NOT (
        SELECT responsible_user_id FROM guilds WHERE id = ${guildId}
      )
  `);
  return r.changes;
}

/**
 * Compare-and-swap da transferência de responsável: grava somente se o
 * responsável lido na autorização AINDA for o atual (IS = igualdade
 * null-safe) E se o alvo continuar GM ativo com conta ativa NO INSTANTE
 * da escrita — o EXISTS fecha a corrida com PATCH/DELETE de membros.
 * Retorna o número de linhas alteradas (0 = perdeu a corrida; 409).
 */
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
