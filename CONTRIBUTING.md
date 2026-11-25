# Como contribuir

Obrigado pelo interesse no Mestre RPG. Este documento explica como relatar problemas, propor melhorias e enviar alterações que possam ser revisadas com segurança.

## Antes de começar

1. Leia o [README](README.md) para conhecer a aplicação e o modo de operação.
2. Consulte o guia de operação em \`docs/GUIA-OPERACAO.md\` quando a mudança envolver instalação, atualização, banco de dados ou backups.
3. Procure Issues e Pull Requests existentes antes de abrir um novo registro.
4. Para mudanças grandes, decisões de arquitetura, alterações de banco ou novas áreas funcionais, converse primeiro em uma Issue. Isso evita trabalho duplicado e decisões incompatíveis.

O software-fonte deste repositório é distribuído sob a licença [MIT](LICENSE). Ela permite uso, cópia, modificação, distribuição, sublicenciamento e comercialização, desde que o aviso de copyright e o texto da licença sejam preservados. Essa permissão não concede direitos sobre marcas, nomes, logotipos, personagens, artes ou materiais de terceiros que estejam identificados como pertencentes a seus respectivos titulares. Antes de enviar uma contribuição, confirme que você é autor do material ou possui autorização para licenciá-lo sob MIT. Ao enviar uma contribuição de software, você concorda que ela será disponibilizada sob a mesma licença.

## Fluxo de trabalho

- Trabalhe em uma branch própria; não faça commits diretamente em \`main\`.
- Para contribuições comuns, use \`main\` como base.
- Se uma Pull Request depender de outra branch/PR, deixe essa dependência explícita na descrição e mantenha o destino correto. Não retargete PRs de outras pessoas.
- Prefira nomes objetivos, por exemplo: \`docs/issue-123-guia\`, \`fix/issue-123-validacao\` ou \`feat/issue-123-funcionalidade\`.
- Mantenha cada Pull Request focada em uma mudança revisável. Separe refatorações não relacionadas.
- Não faça merge, publicação, criação de tag ou release em nome dos mantenedores.

## Regras técnicas do projeto

### Segurança e autorização

- O backend é a autoridade. Esconder um botão ou bloquear uma tela no frontend não substitui validação de autorização no servidor.
- Valide permissões no ponto de leitura e em toda mutação relevante.
- Não confie em identificadores, valores, permissões ou dados de elegibilidade enviados apenas pelo cliente.
- Evite expor dados privados de campanhas, sessões, personagens, contas, credenciais ou logs.

### Banco de dados e compatibilidade

- Preserve dados existentes e compatibilidade com instalações já utilizadas.
- Migrações devem ser seguras para bancos com dados reais e fixtures legadas; prefira alterações aditivas e documente qualquer transformação.
- Não remova tabelas, colunas ou dados, nem faça migrações destrutivas, sem decisão explícita dos mantenedores e plano comprovável de recuperação.
- Teste migrações em banco descartável/fixture. Nunca use o banco de uma instalação real para validar uma contribuição.
- Considere exportação/importação de campanhas, snapshots, backups e restauração ao alterar modelos persistidos.
- Reaproveite as fontes de verdade existentes. Não crie inventários, saldos, ledgers ou cadastros paralelos para representar os mesmos dados.

### Interface e acessibilidade

- Preserve o funcionamento em desktop e dispositivos móveis.
- Considere teclado, foco visível, rótulos acessíveis, contraste, mensagens de erro claras e leitores de tela.
- Não declare conformidade WCAG sem evidência de avaliação apropriada. Consulte [ACCESSIBILITY.md](ACCESSIBILITY.md).

### Dependências e automação

- Evite adicionar dependências quando a stack existente já resolve o problema.
- Alterações em workflows, permissões do GitHub Actions, segredos, regras de proteção, configurações do repositório ou processos de publicação precisam de aprovação explícita dos mantenedores.
- Não inclua tokens, senhas, cookies, chaves, arquivos \`.env\`, bancos de campanha, backups ou dados pessoais em commits.

## Preparar e verificar a alteração

Na raiz do repositório:

1. Instale as dependências com \`npm ci\`.
2. Execute \`npm run build\`.
3. Rode os testes relevantes à área alterada, usando os scripts existentes em \`package.json\` e as instruções do workflow de CI.
4. Para mudanças de banco, inclua testes de migração/upgrade com dados representativos e verifique que os dados anteriores continuam íntegros.
5. Para mudanças de interface, verifique desktop e mobile e execute as homologações aplicáveis.

Informe exatamente quais comandos foram executados e seus resultados. Não marque um teste como aprovado se ele não foi executado. Diferencie testes locais, CI e verificações manuais.

## Abrir uma Pull Request

A descrição da PR deve explicar:

- Qual problema está sendo resolvido e qual Issue está relacionada.
- O que mudou e o que ficou fora do escopo.
- Efeitos sobre API, banco, dados existentes, permissões, segurança e compatibilidade.
- Testes executados, resultados e eventuais limitações.
- Dependências de outras PRs, quando houver.

Use o [modelo de Pull Request](.github/PULL_REQUEST_TEMPLATE.md) e revise o diff antes de enviar.

## Revisão

Uma Pull Request não está aprovada apenas por compilar ou passar em CI. Ela precisa de revisão humana, verificação de compatibilidade e aprovação dos mantenedores. O responsável pelo projeto decide prioridades, escopo, licenciamento, merge e publicação.

Contribuições que não atendam a estes critérios poderão receber pedidos de ajuste ou ser encerradas, sempre que possível com uma justificativa objetiva.
