-- Registra a atualização automática no boot entregue na versão 1.0.6.
-- ID exclusivo e INSERT OR IGNORE garantem idempotência do seed.
INSERT OR IGNORE INTO novidades (
  id, titulo, resumo, conteudo, versao, categoria, estado,
  publicado_em, autor_id, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000000109',
  'Atualização automática na inicialização',
  'O Mestre RPG verifica e aplica atualizações do repositório oficial ao iniciar, com proteções de segurança e rollback controlado.',
  'Ao iniciar pelo iniciar-mestre-rpg.bat, o Mestre RPG agora consulta o repositório oficial no GitHub antes de subir o servidor. Quando existem commits novos que podem ser aplicados com segurança, a atualização é feita automaticamente: dependências são reinstaladas quando o lockfile muda e o servidor e o frontend são recompilados. O updater se recusa a atualizar diante de qualquer situação de risco — Git ausente, remoto que não seja o oficial (incluindo URLs reescritas), branch detached, upstream incorreto, árvore suja ou divergência — e falhas de rede apenas adiam a atualização sem bloquear a inicialização. Se a atualização falhar depois do pull, um rollback controlado restaura o commit anterior com reinstalação de dependências e recompilação de ambos os workspaces, preservando os arquivos locais. Quem preferir atualizações manuais pode desativar o recurso nesta instalação definindo a variável de ambiente MESTRE_AUTO_UPDATE=0 antes de executar o iniciar-mestre-rpg.bat — o boot continua normalmente, apenas sem a verificação automática.',
  '1.0.6',
  'novidade',
  'publicada',
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  NULL,
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  CAST(strftime('%s','now') AS INTEGER) * 1000
);
