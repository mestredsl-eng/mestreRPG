-- Publica o registro da correção entregue em v1.0.5 na Central de Novidades.
-- Chave estável + INSERT OR IGNORE tornam o seed seguro para reexecução.
INSERT OR IGNORE INTO novidades (
  id, titulo, resumo, conteudo, versao, categoria, estado,
  publicado_em, autor_id, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000000105',
  'Substituição de campanha restrita ao mestre ativo',
  'A ação Substituir campanha só é exibida ao mestre ativo da campanha.',
  'Ao importar um pacote que aponta para uma campanha já existente, a interface só oferece a substituição quando a campanha consta na lista do usuário e a associação dele tem papel Mestre e status Ativo. Jogadores, espectadores, mestres pendentes, bloqueados ou removidos e usuários sem vínculo recebem a mensagem de campanha existente sem o modal. O servidor continua validando a autorização antes de restaurar qualquer dado.',
  '1.0.5',
  'correcao',
  'publicada',
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  NULL,
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  CAST(strftime('%s','now') AS INTEGER) * 1000
);
