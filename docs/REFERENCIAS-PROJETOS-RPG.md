# Avaliação de projetos de referência para o Mestre RPG

**Data da análise:** 10/11/2026  
**Escopo:** identificar código e padrões reaproveitáveis sem substituir a arquitetura existente do Mestre RPG.

## Resumo executivo

A recomendação é **não incorporar nenhum desses projetos como aplicação inteira**. O Mestre RPG já possui uma arquitetura própria (React/Vite + Node/Express + Socket.IO + SQLite/Drizzle) e regras personalizadas de Caçadores Caçados. Os projetos analisados usam stacks, modelos de dados e/ou sistemas de jogo diferentes.

Há, porém, ideias úteis que podem ser adaptadas:

1. **Tableloom** — melhor referência arquitetural para módulos de sistemas, conteúdo versionado, conteúdo próprio da campanha e separação entre núcleo e regras de cada jogo.
2. **Fumble** — referência de experiência de compêndio, busca, organização de conteúdo e importação/exportação de homebrew; não copiar seu modelo de armazenamento local nem seus dados de D&D.
3. **Nexus VTT** — referência para contratos versionados entre módulos e biblioteca documental; sua arquitetura de vários serviços é excessiva para o estágio e a infraestrutura atual do Mestre RPG.
4. **Keeper** — referência visual/editorial de compêndio, mas não foi localizado um arquivo LICENSE na raiz consultada. Não reutilizar código até confirmar uma licença explícita.

## Comparativo

| Projeto | O que vale estudar | Limitações para o Mestre RPG | Recomendação |
|---|---|---|---|
| [Tableloom](https://github.com/daeken/Tableloom) | Módulos independentes por sistema, conteúdo versionado, overrides de campanha, instâncias próprias e separação core/SDK | Node 24, Fastify, PixiJS e arquitetura diferente; o próprio README informa que os módulos de jogo ainda são scaffolds e não há fichas/regras publicadas prontas | **Referência principal de arquitetura**, adaptar conceitos sem importar a aplicação |
| [Fumble](https://github.com/PKrystian/Fumble) | Compêndio pesquisável, wiki de campanha, notas, homebrew e fluxos de importação/exportação | Ferramenta client-side sem login/backend, estado em localStorage e foco em D&D 2024; conteúdo de terceiros tem licenças próprias | **Referência de UX e formatos**, não importar dados nem substituir o backend |
| [Nexus VTT](https://github.com/joelmale/nexusVTT) | Contratos tipados/versionados, separação entre VTT, fichas e biblioteca documental | Monorepo de múltiplos serviços, PostgreSQL, Redis, Docker e Node 26; custo operacional alto comparado ao stack atual | **Referência pontual de contratos**, não incorporar microserviços |
| [Keeper](https://github.com/farirpgs/keeper) | Apresentação de compêndio e navegação de recursos | README consultado descreve um compêndio de recursos; licença não confirmada na raiz | **Inspiração visual somente** até verificar licença |

## Licenças e propriedade intelectual

- **Tableloom:** README declara MIT e o arquivo LICENSE consultado contém a licença MIT. Se algum trecho de código for incorporado futuramente, preservar o aviso de copyright e o texto da licença.
- **Fumble:** README declara MIT para código e materiais originais do projeto. O próprio projeto exclui dados de jogos, livros, aventuras, arte, marcas e outros materiais de terceiros da licença MIT. Não copiar seu conteúdo de D&D.
- **Nexus VTT:** README e arquivo LICENSE consultados declaram MIT. Preservar os avisos caso código seja incorporado.
- **Keeper:** não foi encontrado LICENSE na raiz consultada. Ausência de arquivo não significa autorização de reutilização. Não copiar código ou conteúdo até identificar uma licença válida.

Licença MIT do código **não** concede direitos sobre livros comerciais, textos de regras, ilustrações, marcas ou conteúdo de terceiros.

## Como aplicar ao Mestre RPG

### 1. Acervo global de livros

A proposta de `rule_books`, `rule_book_items` e `rule_book_backups` deve ser implementada nativamente no banco SQLite/Drizzle atual.

Do Tableloom, aproveitar conceitualmente:
- conteúdo separado do núcleo da aplicação;
- definições versionadas;
- distinção entre catálogo publicado e alterações próprias;
- IDs/chaves estáveis para referências.

Não importar seu SDK nem alterar o stack do Mestre RPG.

### 2. Conteúdo extensível

Manter `kind` extensível e `definition` como JSON validado. O acervo pode guardar habilidades, atributos, equipamentos, regras de combate, tabelas e outros conteúdos sem obrigar o motor de fichas a conhecer todos os tipos.

A validação de cada tipo pode evoluir por schemas específicos, sem quebrar o envelope geral de importação/exportação.

### 3. Futuro vínculo com campanhas

Quando a etapa de livros globais estiver estável, estudar um vínculo explícito entre campanha e livros selecionados, com precedência clara entre:
- conteúdo original do livro;
- alterações específicas da campanha;
- elementos nativos já existentes em `rule_sets` / `rule_definitions`.

Essa integração deve ser uma etapa própria. Não misturar agora com o CRUD atual por campanha nem alterar cálculos.

### 4. Importação/exportação

Usar o envelope versionado próprio do Mestre RPG e adotar as boas práticas observadas nos projetos:
- prévia antes de gravar;
- validação completa;
- IDs internos não transportados como identidade;
- backup antes de atualizar;
- confirmação explícita de conflitos;
- exportação e importação simétricas.

## Decisão

**Não copiar um projeto inteiro nem adicionar dependências externas nesta etapa.** A melhor solução é implementar o acervo global no código atual do Mestre RPG e usar Tableloom como referência principal para arquitetura modular, Fumble para UX de compêndio e Nexus para contratos versionados.

Esta análise é documental. Nenhum código ou conteúdo dos repositórios citados foi copiado para o Mestre RPG.
