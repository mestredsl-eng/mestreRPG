-- Sessões: unicidade de (campaign_id, number).
--
-- Antes de criar o índice único, renumera duplicidades antigas: para cada
-- campanha, a ocorrência mais antiga de cada número é preservada e as
-- demais recebem números novos acima do MAX atual, na ordem de criação.
-- Sessões nunca são removidas — apenas renumeradas.
WITH ranked AS (
	SELECT id, campaign_id, number,
		ROW_NUMBER() OVER (PARTITION BY campaign_id, number ORDER BY created_at, id) AS rn
	FROM sessions
),
extras AS (
	SELECT s.id, s.campaign_id,
		ROW_NUMBER() OVER (PARTITION BY s.campaign_id ORDER BY s.created_at, s.id) AS seq_extra
	FROM sessions s
	WHERE s.id IN (SELECT id FROM ranked WHERE rn > 1)
),
base AS (
	SELECT campaign_id, MAX(number) AS maxnum FROM sessions GROUP BY campaign_id
)
UPDATE sessions
SET number = (
	SELECT b.maxnum + e.seq_extra
	FROM extras e
	JOIN base b ON b.campaign_id = e.campaign_id
	WHERE e.id = sessions.id
)
WHERE id IN (SELECT id FROM extras);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_campaign_number_idx` ON `sessions` (`campaign_id`,`number`);
