-- Registra as entregas da versão 1.0.9 na Central de Novidades.
-- ID exclusivo e INSERT OR IGNORE garantem idempotência do seed.
INSERT OR IGNORE INTO novidades (
  id, titulo, resumo, conteudo, versao, categoria, estado,
  publicado_em, autor_id, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000000111',
  'Mestre RPG 1.0.9 — XP em lote, extrato e atualização segura',
  'Concessão de XP em lote, extrato de XP somente leitura, pontos de Sangue na ficha configurável e atualização automática com recuperação após interrupções.',
  'A versão 1.0.9 reúne melhorias de progressão e estabilidade. O mestre pode conceder XP a vários personagens em lote e consultar o extrato de XP somente leitura, que preserva a âncora do histórico mesmo quando eventos antigos são truncados. A ficha configurada da campanha passa a exibir o painel de Pontos de Sangue. O iniciar-mestre-rpg.bat agora atualiza o Mestre RPG automaticamente a partir do repositório oficial, com proteção contra atualizações inseguras, journal durável e rollback automático — inclusive após encerramento abrupto durante a atualização — preservando banco, arquivos, configuração e backups. Instalações da versão 1.0.8 são atualizadas por procedimento controlado e testado. A versão também reforça a integridade do banco SQLite e o isolamento entre campanhas, e torna os controles financeiros do painel Dinheiro acessíveis a leitores de tela.',
  '1.0.9',
  'novidade',
  'publicada',
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  NULL,
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  CAST(strftime('%s','now') AS INTEGER) * 1000
);
