-- Publica o registro da correção entregue em v1.0.6 na Central de Novidades.
-- Chave estável + INSERT OR IGNORE tornam o seed seguro para reexecução.
INSERT OR IGNORE INTO novidades (
  id, titulo, resumo, conteudo, versao, categoria, estado,
  publicado_em, autor_id, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000000107',
  'Edição de anotações respeita o compartilhamento da campanha',
  'Com o compartilhamento desligado, jogadores só editam anotações que permanecem privadas.',
  'Quando a campanha está configurada para não compartilhar anotações de jogadores, o PATCH passa a avaliar a visibilidade efetiva da nota: edições de conteúdo, destinatários, status ou título sobre notas públicas, selecionadas ou de mestre são rejeitadas, e o jogador não pode promover a própria nota a tipo mestre. O jogador ainda pode rebaixar uma nota compartilhada para privada no mesmo PATCH, e os destinatários são limpos automaticamente. Mestres e a verificação de propriedade da nota permanecem inalterados.',
  '1.0.6',
  'correcao',
  'publicada',
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  NULL,
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  CAST(strftime('%s','now') AS INTEGER) * 1000
);
