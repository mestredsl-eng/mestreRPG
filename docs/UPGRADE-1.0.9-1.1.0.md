# Atualização controlada — Mestre RPG 1.0.9 → 1.1.0

> Este procedimento é destinado à publicação oficial da 1.1.0. Só execute depois de a versão estar publicada e o commit/tag oficial ter sido confirmado. Esta branch de preparação não é uma versão instalável.

## Escopo

O caminho cobre a atualização do código 1.0.9 para 1.1.0, incluindo as migrações 0036–0038. As migrações 0036 e 0037 adicionam as estruturas do comércio; a 0038 publica a nota de versão na Central de Novidades. A 0038 usa ID estável e INSERT OR IGNORE, portanto não cria notas duplicadas em reexecução.

## Antes de começar

1. Confirme que a instalação está na versão **1.0.9** e que não há outra atualização em andamento.
2. No painel **Administração → Servidor → Backups**, execute **Backup agora**. Aguarde a conclusão e confirme que o backup aparece como bem-sucedido.
3. Confira o manifesto do backup: versão de origem, banco SQLite, arquivos da campanha e configuração devem estar presentes e validados. Copie a pasta completa do backup para outro disco/local seguro; não dependa apenas da cópia dentro da instalação.
4. Avise os participantes e encerre a sessão de jogo. Não faça compras ou alterações de patrimônio durante a janela.
5. No Windows, execute `parar-mestre-rpg.bat` e aguarde o encerramento controlado. Não copie o arquivo SQLite enquanto o servidor estiver rodando e evite `taskkill /F`.

## Aplicar a atualização

### Clone Git oficial no Windows

1. Confirme que o clone aponta para `github.com/mestredsl-eng/mestreRPG`, está na branch oficial que acompanha `origin` e não possui alterações locais. O atualizador automático só trabalha com clone oficial, upstream correspondente e árvore limpa; ele não faz stash nem descarta arquivos.
2. Depois da publicação da 1.1.0 na branch oficial, execute `iniciar-mestre-rpg.bat`. O fluxo automático faz o fast-forward permitido, executa `npm ci` quando o manifesto/lockfile muda, recompila backend e frontend, aplica migrações e inicia o servidor.
3. Não force pull, não use rebase/force push e não substitua manualmente as pastas de dados. Se o atualizador recusar a operação (branch divergente, upstream diferente, árvore suja, origem não oficial ou falha de rede), pare e resolva a condição antes de tentar novamente.

### Instalação sem Git

1. Use somente o pacote oficial da release 1.1.0, depois de publicado.
2. Pare o servidor e mantenha intactas as pastas `banco/`, `arquivos/`, `backups/`, `configuracao/` e `logs/`.
3. Atualize os arquivos do programa sem apagar/substituir essas pastas de dados.
4. Na pasta do programa, execute `npm ci`, depois `npm run build` e `npm run db:migrate`. Se qualquer comando falhar, não inicie a aplicação: siga o rollback.

## Verificação pós-atualização

1. Confirme que o boot terminou sem erro de migration e que a aplicação responde em `http://localhost:3001/api/health`. Verifique especialmente `checagens.backend`, `checagens.banco` e `checagens.arquivos`; alertas de backup/disco devem ser avaliados separadamente.
2. Entre com uma conta administrativa já existente e confira campanhas, participantes, personagens, ficha, patrimônio, histórico financeiro e arquivos. Confirme que os dados anteriores continuam presentes.
3. Em uma campanha/personagem de teste, valide o gate da Internet: **Computador ≥ 1 OU Tecnologia ≥ 1**, junto com um **notebook ou celular** reconhecido no patrimônio. Sem um dos requisitos, o acesso deve ser negado; perder o requisito deve revogar o acesso.
4. Em campanha de teste, valide listagem de lojas, oferta, caixa, compra, recibo e histórico. Valide venda para loja apenas com item de teste que tenha procedência/preço unitário confiável. Não use contas, estoque ou personagens ativos de uma campanha real para simular transações.
5. Confirme que um backup novo pode ser criado após a atualização e preserve também o backup anterior até encerrar a homologação.

## Rollback

**Não faça downgrade apenas do código.** Depois que 0036/0037 forem aplicadas, o banco contém estruturas da 1.1.0; reverter somente os arquivos do programa pode deixar código antigo diante de schema novo.

1. Se a verificação falhar, pare o servidor pelo procedimento controlado.
2. Restaure como um conjunto o backup feito antes da atualização: banco, arquivos físicos das campanhas e configuração. Preserve a cópia original do backup.
3. Reponha o código 1.0.9 correspondente ao backup.
4. Inicie e confirme health, login e campanhas antes de liberar o acesso aos participantes.
5. Registre o erro e mantenha a instalação fora de uso até a causa ser corrigida.

## Critério de conclusão

A atualização só está concluída quando health, login, leitura das campanhas e dados patrimoniais/financeiros existentes estiverem íntegros, e um backup pós-atualização tiver sido validado. Este runbook não autoriza publicar a release nem executar a atualização em uma instalação real.
