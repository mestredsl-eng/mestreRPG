-- Registra a integridade de XP/importações externas entregue na versão 1.0.5.
-- ID exclusivo e INSERT OR IGNORE garantem idempotência do seed.
INSERT OR IGNORE INTO novidades (
  id, titulo, resumo, conteudo, versao, categoria, estado,
  publicado_em, autor_id, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000000106',
  'Integridade do ledger XP e importações externas',
  'O ledger XP é autenticado e metadados reservados são saneados em importações externas.',
  'As exportações de campanha assinam o ledger XP de cada personagem com HMAC-SHA256 e uma chave mantida na instalação, fora do pacote exportado. A assinatura cobre a identidade do personagem, o saldo, o histórico, a âncora, os financiamentos e a impressão digital das regras. Em importações externas, ledger sem assinatura válida é rejeitado de forma fechada, com saldo, histórico e financiamentos descartados. Metadados reservados de XP, pontos, HP e vitalidade são validados e saneados; restaurações de snapshots internos preservam os dados confiáveis.',
  '1.0.5',
  'correcao',
  'publicada',
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  NULL,
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  CAST(strftime('%s','now') AS INTEGER) * 1000
);
