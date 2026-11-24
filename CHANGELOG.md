# Changelog - Mestre RPG

## [Unreleased]

## [1.0.0.9] - 2026-11-24

### Novidades

- **Concessão de XP em lote:** o mestre seleciona vários personagens na ficha atual e concede pontos de experiência em uma única operação, com deduplicação por pedido e extrato das concessões.
- **Extrato de XP somente leitura:** histórico de concessões por personagem com âncora preservada quando eventos antigos são truncados, mantendo a rastreabilidade do saldo.
- **Pontos de Sangue na ficha configurável:** painel de Sangue vinculado à ficha configurada da campanha, exibindo saldo e capacidade conforme a configuração do mestre.
- **Atualização automática no boot com recuperação:** o `iniciar-mestre-rpg.bat` verifica o repositório oficial, aplica atualizações seguras com lock de instância única, journal durável e rollback automático após interrupções — incluindo encerramento abrupto durante a atualização — preservando banco, arquivos, configuração e backups. Instalações da 1.0.8 são atualizadas por procedimento controlado e testado.

### Integridade e segurança

- **Integridade SQLite e isolamento entre campanhas:** operações de modelos de ficha, upload de anexos e publicações passaram a usar transações atômicas com verificação de `changes`, revertendo integralmente quando o alvo fica indisponível; requisições cross-campaign retornam 404 sem alterar dados, auditoria ou eventos.
- **Backup de formato legado:** backups criados pela 1.0.8 e anteriores continuam sendo reconhecidos e validados pelo verificador atual, com restauração fail-closed.

### Acessibilidade

- **Nomes acessíveis nos controles financeiros:** os seis seletores de conta, moeda, tipo de movimentação, origem e destino do painel Dinheiro agora expõem nomes acessíveis, corrigindo violações de SC 4.1.2.
- **Matriz de homologação visual e de fluxos:** cobertura E2E de contraste WCAG 2.2 AA, regiões vivas `aria-live`, popovers de ajuda, ordem de tabulação e alvos de ponteiro nos fluxos críticos.

### Validação

- Suítes de regressão de ciclo de campanha, ficha de caçadores/round-trip e ciclo de vida do processo executadas na árvore candidata.
- Homologação Windows real: Node 22 e Node 20, gate BAT via `cmd.exe`, P10-C real e restauração fail-closed.
- Homologação Linux component-level do Boot Lock/Recovery em runner Ubuntu.

## [1.0.0.8] - 2026-11-22

### Novidades

- **Pontos de Sangue por campanha:** o mestre configura o recurso, os custos associados a Poderes e as ações de ativação e recuperação. A ficha e a Mesa exibem a leitura do saldo, e os controles do mestre permitem ajustes e reconciliação auditável.
- **Cobrança integrada ao D10:** testes que usam um Poder elegível debitam o custo na mesma transação do resultado. Custos zero permanecem válidos e tentativas repetidas não duplicam a cobrança.
- **Evolução da capacidade por XP:** a capacidade de Sangue pode evoluir pela progressão de experiência, respeitando os limites configurados pela campanha.
- **Vida e condição no VTT:** tokens podem exibir indicadores de vida e condição quando a política de visibilidade da sessão permite; dados restritos não são enviados a participantes sem permissão.

### Integridade e segurança

- **Assinatura conjunta XP + Sangue:** exportações de campanha protegem os dois ledgers em conjunto com HMAC v2, mantendo a compatibilidade de leitura prevista para pacotes assinados na versão anterior.
- **Pré-validação de migração de ficha:** adicionada uma base fail-closed para validar compatibilidade antes de futuras operações. A revinculação efetiva de fichas não faz parte desta versão.
- **Privacidade dos Pontos de Sangue:** a projeção de saldo/capacidade respeita a visibilidade efetiva da capacidade-base, do bônus de Qualidade e da natureza, incluindo overrides individuais e destinatários selecionados. Ações por Socket.IO são recusadas sem revelar saldo quando uma fonte necessária está privada; recuperação não aceita capacidade desconhecida nem teto informado pelo cliente.
- **Ledger decimal e compatibilidade histórica:** débitos, créditos, ajustes e limites usam aritmética decimal exata; históricos legados preservam o saldo persistido quando a evidência é ambígua e permitem reconstrução comprovada após recuperação limitada. A cobrança D10 não revela saldo em mensagens de erro.
- **Integridade de XP e regras importadas:** a prova de financiamento por XP da capacidade de Sangue só é aceita para o campo configurado pela campanha, com custo/vínculo revalidados. Excluir um Poder também remove seu custo órfão de forma transacional, preservando demais configurações e campanhas importadas com `pontos:null`.

### Validação

- Cobertura de ledger, ações, invariantes, cobrança D10, capacidade, permissões, VTT e integridade de importação executada na candidata de release.
- Homologação de atualização/restauração a partir de instalação legada com banco temporário, sem tocar nos dados reais do usuário.


## [1.0.0.7] - 2026-11-20

### Novidades

- **Patrimônio com permissões granulares (PR #177):** a campanha configura sete permissões separadas — itens, equipamentos, veículos, contas, compra, venda e PIX fictício — e o painel de Regras atualiza cada alteração em tempo real para todos os jogadores.
- **Régua de distância na Mesa Virtual (PR #178):** o mestre mede distâncias entre dois pontos do tabuleiro ou do mapa, com calibração exclusiva do mestre, suporte a mouse e toque, ajuste de proporção do mapa e encaixe por hit-test que não conflita com o pincel de desenho.
- **Registro na Central de Novidades:** a migration `0031_release_1007_patrimonio_regua_news.sql` publica esta entrega na categoria `novidade`, versão `1.0.7`, com seed idempotente por ID estável.

## [1.0.0.6] - 2026-11-19

### Correções e permissões

- **Edição de anotações respeita o compartilhamento da campanha:** com `jogadorCompartilha` desligado, o jogador só pode alterar anotações cuja visibilidade efetiva continue `privada`. Antes, um PATCH apenas de conteúdo ou de destinatários sobre nota pública ou selecionada contornava a restrição, e um jogador podia promover a própria nota a `kind: "mestre"`.
- **Downgrade controlado preservado:** o jogador ainda pode tornar uma nota compartilhada privada no mesmo PATCH, e o servidor limpa os destinatários ao fazer isso.
- **Paridade com a criação:** a mesma regra de `kind`/`visibility` aplicada no POST agora vale para o PATCH; mestres permanecem isentos e a propriedade da nota continua obrigatória.
- **Registro na Central de Novidades:** a migration `0030_release_1006_diario_permissoes_news.sql` publica esta correção na categoria `correcao`, versão `1.0.6`.

### Atualização automática na inicialização

- **Auto-update Git no boot:** o `iniciar-mestre-rpg.bat` agora verifica o repositório oficial antes de subir o servidor. Quando há commits novos em um fast-forward seguro, o updater aplica `git pull --ff-only`, reinstala dependências quando o lockfile muda e recompila o servidor e o frontend.
- **Proteções contra atualização insegura:** o updater se recusa a atualizar com Git ausente, sem `.git`, remoto diferente do oficial (incluindo URLs reescritas por `url.*.insteadOf` e múltiplas URLs), branch detached, upstream que não seja `origin/<branch-atual>`, árvore suja (rastreada ou não) ou divergência. Falhas de rede, autenticação e timeout apenas adiam a atualização — nunca bloqueiam a inicialização.
- **Rollback controlado:** se dependências ou builds falharem após o pull, o updater restaura o commit anterior somente com árvore limpa, HEAD exato e mesma branch, reinstala dependências e recompila ambos os workspaces; se a integridade não puder ser garantida, encerra com código de erro e instruções, sem sucesso falso.
- **Execução segura de npm no Windows:** comandos npm passam por allowlist fixa via `ComSpec`, sem shell livre; variáveis `GIT_*` herdadas do processo são descartadas para impedir redirecionamento de repositório.
- **Registro na Central de Novidades:** migration `0034_release_1006_auto_update_news.sql`, com seed idempotente próprio (`INSERT OR IGNORE`, UUID `...0110`), publica esta funcionalidade na versão `1.0.6`, categoria `novidade`.

### Testes

- `teste-auto-update.mjs` cobre 80 cenários: ausência de Git, instalação sem repositório, fast-forward, falhas de rede/auth/timeout, URLs reescritas e ambíguas, árvore suja, upstream inválido ou de fork, divergência, falhas de dependências e build, rollback completo com rebuild dos dois workspaces, proteção contra alterações locais durante o rollback, lockfiles aninhados, variáveis `GIT_*` hostis e recuperação manual pelo arquivo de estado — incluindo execução real de `npm.cmd` no runner Windows.

## [1.0.0.5] - 2026-11-19

### Integridade de importações e progressão XP

- **Ledger XP autenticado:** exportações assinam o ledger de cada personagem com HMAC-SHA256 e chave específica da instalação, cobrindo personagem, saldo, histórico, âncora, financiamentos e impressão digital das regras.
- **Importação externa fail-closed:** ledger sem assinatura válida perde saldo, histórico e financiamentos; metadados reservados de XP, pontos, HP e vitalidade são validados e saneados. Restaurações de snapshots internos preservam os metadados confiáveis.
- **Campos reservados protegidos:** IDs de campos iniciados por `__` são rejeitados para impedir colisões com metadados internos.
- **Registro na Central de Novidades:** migration `0029_release_1005_xp_import_integrity_news.sql`, com seed idempotente próprio, publica esta entrega na versão `1.0.5`.

### Correções e permissões

- **Substituição de campanha restrita ao mestre ativo:** a interface só oferece o modal de substituição quando a campanha importada já pertence ao usuário e a associação dele está com papel `mestre` e status `ativo`.
- **Falha fechada para associações não ativas:** jogador, espectador, mestre pendente, bloqueado ou removido e usuário sem vínculo recebem a mensagem de campanha existente sem receber a ação de substituição. A autorização do servidor permanece obrigatória e retorna 403 para esses cenários.
- **Registro na Central de Novidades:** a migration `0028_release_1005_campaign_substitution_news.sql` publica esta correção para os usuários da instalação, na categoria `correcao`, versão `1.0.5`; o seed usa ID estável e é idempotente.

### Testes

- **`homologacao-papeis-ui.mjs`: 69/69** — cenários de jogador, espectador, mestre ativo, mestre pendente, mestre bloqueado, mestre removido e usuário sem vínculo; inclui validações diretas da autorização HTTP.
- **CI no SHA `665acaaca7d688d9988f225a27e31f6a3d12f516`: 3/3 checks concluídos com sucesso** — build, typecheck, suítes e homologações Playwright.

---

## [1.0.0.4] - 2026-11-17

### Novidades

- **Iniciativa d20 na mesa:** o mestre pode rolar de 1 a 10 dados d20 por participante, incluindo jogadores ativos e NPCs aprovados e revelados. Os resultados são calculados pelo servidor, ordenados por total decrescente e desempatados alfabeticamente.
- **Resultados persistentes e sincronizados:** iniciativa, dados e ordem são persistidos na sessão, transmitidos em tempo real pelo Socket.IO e registrados no chat da mesa.
- **Compatibilidade com turnos manuais:** o mestre pode continuar usando ou redefinindo a ordem manual após uma iniciativa.

### Integridade, permissões e recuperação

- **Autorização no servidor:** apenas o mestre controla início, encerramento, avanço, ordem e rolagem de iniciativa.
- **NPCs protegidos:** somente NPCs da campanha aprovados, ativos e revelados pelo mestre podem participar.
- **Ordem vazia protegida:** o servidor rejeita iniciar turnos sem participantes; esvaziar a ordem encerra a sequência.
- **Estados legados resilientes:** a mesa abre sem crash mesmo quando encontra estado antigo inconsistente, e o mestre consegue reparar a ordem pela interface.

### Testes

- **servidor/testes/iniciativa.test.ts: 4/4** — cálculo, limites de dados e ordenação/desempate.
- **homologacao-mesa.mjs: 52/52** — iniciativa autoritativa, NPCs, permissões, ordem vazia, recuperação de estado legado e turnos manuais.
- **homologacao-mesa-virtual.mjs: 30/30** — abertura da mesa com estado legado inválido, sem erro de renderização e com controles de recuperação funcionais.
- **teste-permissao-tempo-real.mjs: 579/579** — permissões, revogação e sincronização de turnos.
- **CI #534:** servidor, build, suítes sem navegador e homologações Playwright concluídos com sucesso no SHA f872816c5d649528da7c1fa63940ff7e494bc19e.
- **Assistente de Desenvolvimento #376:** sucesso no mesmo SHA.

---

## [1.0.0.3] - 2026-11-17

### Novidades

- **Mesa de dados 3D com física Rapier** — bandeja compartilhada renderizada com Three.js e corpos rígidos Rapier, incluindo colisões entre dados, gravidade, atrito, quique, paredes e iluminação. D4, D6, D8, D10 e D20 preservam rótulos legíveis, temas e cores personalizadas.
- **Resultado autoritativo** — a física é apenas apresentação: o resultado continua definido pelo servidor e cada dado assenta na face oficial recebida.

### Acessibilidade, estabilidade e compatibilidade

- **Movimento reduzido** — dados já resolvidos aparecem assentados imediatamente quando `prefers-reduced-motion` está ativo.
- **Assentamento físico terminal** — corpos prontos dormem e não voltam a ser integrados pela gravidade; novos resultados podem acordá-los novamente.
- **Frequências de atualização** — o ciclo de renderização continua corretamente em telas de 60, 90, 120 e 144 Hz.
- **Carregamento sob demanda** — Three.js e Rapier/WASM são carregados ao abrir o visualizador; o renderer Canvas permanece como fallback sem WebGL.
- **CSP do preview** — a política permite `wasm-unsafe-eval` para inicialização do Rapier, sem liberar `unsafe-eval` geral.

### Testes

- **`homologacao-dados3d.mjs`: 111/111** — histórico pré-resolvido, ACK posterior com reduced-motion, velocidades linear/angular, quaternion e posição finais, frequências de 60/90/120/144 Hz, CSP/preview WASM e mobile.
- **CI #524:** servidor, typecheck, build, suítes sem navegador e homologações Playwright concluídos com sucesso no SHA `7715a48fb32bc9538134db098fa95a0698ba5ec0`.
- **Assistente de Desenvolvimento #370:** sucesso no mesmo SHA.

---

## [1.0.0.2] - 2026-11-17

### Novidades

- **Sistema de XP/Merit** — personagens passam a ter saldo e histórico próprios de XP, com concessões e remoções pelo mestre, registro de autor/motivo e consulta pelo jogador.
- **Compra de evolução com XP** — o preço do próximo nível é calculado pelas regras da campanha; jogadores podem adquirir níveis pela ficha, com confirmação em duas etapas e atualização em tempo real.
- **Progressão integrada à ficha** — o painel apresenta saldo, histórico, custos e disponibilidade, mantendo o fluxo de criação e edição de personagens.

### Integridade e compatibilidade

- **Sem cobrança dupla** — níveis financiados por XP são identificados separadamente e não consomem novamente os pontos de criação.
- **Validação transacional** — compras revalidam visibilidade, editabilidade, limites e regras antes de persistir; conflitos de edição concorrente são detectados.
- **Proteção de informações ocultas** — vínculos e preços de campos invisíveis não são expostos ao jogador, inclusive em cenários com vínculos compartilhados.
- **Compatibilidade com fichas existentes** — XP inicia em zero quando ausente; não requer migração de banco.

### Testes

- **`teste-progressao-xp.mjs`: 236/236** — regressões HTTP para concessão, compra, custos fracionários, financiamento, concorrência, limites e campos ocultos.
- **`homologacao-progressao.mjs`: 26/26** — homologação Playwright do fluxo de progressão.
- **CI #509 e CI dedicada #10: sucesso** — validações concluídas no SHA `e20f4bbaaceffb1d0e29abea2ad1052110e5d1c9` antes da integração.

---

## [1.0.0.1] - 2026-11-17

### Novidades

- **Entrega segura da Biblioteca** — arquivos agora são classificados pela extensão física gerada no servidor e pelo conteúdo real, não pelo MIME declarado no upload.
- **Compatibilidade com arquivos antigos** — a mesma proteção vale para arquivos já existentes, importados e restaurados, sem exigir migração do banco.

### Segurança

- **Proteção contra XSS armazenado** — SVG/HTML e conteúdo ativo disfarçado de TXT ou imagem deixam de ser executados na origem da aplicação.
- **MIME canônico** — uploads persistem o tipo derivado do conteúdo; o GET revalida a classificação antes de servir.
- **Fallback seguro** — conteúdo desconhecido, vazio, corrompido, incompatível ou ativo é entregue como anexo `application/octet-stream`, com `nosniff` e CSP `sandbox`; `?download=1` continua disponível.

### Testes

- **`teste-biblioteca-conteudo.mjs`: 42/42** — regressões HTTP reais para XSS, MIME forjado, arquivos legados, assinaturas incompletas/divergentes, formatos legítimos, download e isolamento entre campanhas.
- **CI #491: sucesso** — jobs de servidor e homologações Playwright concluídos no SHA da PR #138 antes do merge.

### Migração e atualização

- **Sem migração de banco** — a proteção é aplicada na leitura e no upload; campanhas, personagens e arquivos existentes são preservados.
- Faça backup antes de atualizar e siga o procedimento de atualização descrito no README.

---

## [1.0.0] - 2026-11-11

### Novidades

- **Sistema de convites** — mestre cria convites com código; jogadores se registram pelo fluxo público (preview → registro → aceite)
- **Fichas de personagem configuráveis** — modelos de ficha publicáveis, versões, campos dinâmicos
- **Fluxo de aprovação de fichas** — jogadores enviam fichas para aprovação; mestre aprova ou rejeita
- **Patrimônio (inventário e equipamentos)** — gestão de itens no inventário, equipamento/desequipamento, permissões granulares (`jogadorAdicionaItens`, `jogadorRemoveItens`, `transferable`)
- **Financeiro** — contas por personagem, saldo inicial configurável, movimentações (entrada, saída, compra, venda, PIX fictício), suporte a 0–4 casas decimais configuráveis por campanha
- **HP e Vitalidade** — alterações de HP e Vitalidade com histórico completo de transições (`nivelAnterior → nivelNovo`, motivo)
- **Bônus individual de pontos** — o mestre concede/remove pontos extras do pool principal de um personagem com motivo e histórico auditável (`POST /characters/:id/pontos`)
- **Mesa multiplayer** — presença em tempo real, chat público/privado/secreto, rolagens compartilhadas (D4, D6, D8, D10, D20), testes de habilidade D10 com cálculo de sucessos/falhas no servidor, turnos, ampulheta/timer
- **Diário de campanha** — anotações do mestre, visibilidade pública para jogadores
- **Snapshots de campanha** — criação manual de snapshots, restauração com snapshot automático pré-restauração de segurança
- **Acervo global** — biblioteca de livros de regras com itens, múltiplas edições, backups automáticos, export/import com envelope oficial, prévia sem persistência, conflitos, decisões de merge (`manter_campanha`, `usar_livro`), soft delete e restauração
- **Aplicação de livros às campanhas** — acervo global aplicável a campanhas específicas, rastreamento de versão aplicada, atualizações disponíveis, resolução de conflitos, aplicação atômica
- **Permissões e papéis** — `mestre`, `jogador`, `espectador` com controle granular de acesso

### Melhorias

- **Atomicidade e concorrência**
  - HP/Vitalidade: leitura, cálculo e gravação dentro da mesma transação para evitar lost updates
  - Aplicação de livro do acervo: decisão e escrita em transação única síncrona
  - Validação de redução de inventário com releitura do estado atual dentro da transação
  - Bônus de pontos (`/pontos`): releitura da ficha, cálculo e gravação dentro de `db.transaction` síncrona; auditoria e Socket.IO somente após o commit — concessões e remoções simultâneas não se perdem
- **Decimais configuráveis** — `moneyTransactions.amount` e `amountCents` respeitam `casasDecimais` da campanha em todos os fluxos financeiros
- **Teardown rigoroso** — `encerrarServidor` aguarda evento `exit` real (SIGTERM → timeout → SIGKILL → aguarda exit novamente)
- **Limpeza resiliente** — `limparDir` com retentativas e relatório explícito de falha; falhas de cleanup são fatais em testes
- **Suítes de teste** — infraestrutura de banco sintético com migrations, cleanup garantido de processos e diretórios temporários

### Correções

- **Inventário** — redução de quantidade exigia permissão `jogadorRemoveItens`; antes era possível reduzir 10→1 mesmo com remoção bloqueada
- **Financeiro** — saldo inicial e movimentações usavam divisão fixa por 100; agora usam conversão baseada em `casasDecimais`
- **Acervo** — `campaign_rule_books.appliedAt` estava mapeado para `created_at`; corrigido para a coluna `applied_at` (feature inteira quebrada)
- **Acervo** — restauração de backup relê estado atual antes de aplicar para evitar sobrescrever estado mais recente
- **Acervo** — importação recalcula destino e diff dentro da transação para evitar validação com estado obsoleto
- **Frontend desatualizado servido** — `site/dist` podia ficar com bundle velho enquanto `index.html` parecia novo (o `.bat` comparava só o html): a tela Acervo e demais recursos recentes não apareciam. Verificação de build agora compara o arquivo mais recente de `site/src` com o mais recente de **todo** `site/dist` (assets incluídos)
- **Inicialização** — `iniciar-mestre-rpg.bat` abortava com "... foi inesperado neste momento" após compilar o servidor: `)` dentro de `echo`/`rem` fechava blocos `if` prematuramente (bug introduzido na verificação de frontend desatualizado). Corrigido — boot completo verificado até `/api/health` OK
- **Homologação** — cenário de teste (criarCenario) gerava modelo não-default, bloqueando criação de fichas em campanhas novas
- **Homologação** — asserts fixos substituídos por verificações reais de estado pós-restart
- **Homologação** — validação D10 agora exige campos calculados do servidor (`minimo`, `lancados`, `sucessos`, `falhas`) e não apenas array de dados
- **Acessibilidade** — campos dinâmicos de ficha, filtros de acervo/arquivos/regras/patrimônio, papéis/status de participantes e formulário de bônus de pontos ganharam `aria-label`; auditoria visual em 3 viewports sem achados
- **Inicialização e restauração** — `iniciar-mestre-rpg.bat` agora aplica restauração pendente **antes** das migrations (schema do backup nunca fica desatualizado) e **interrompe o boot** se a restauração falhar/cancelar; `npm ci` com fallback para `npm install`; frontend recompilado quando `site/src` é mais novo que o build
- **Restaurador** — respeita `MESTRE_BANCO`/`MESTRE_ARQUIVOS`/`MESTRE_BACKUPS` (mesmos overrides do servidor); cria `banco/` na primeira instalação (até com `MESTRE_HOME` inexistente); preserva estado anterior (banco+sidecars, arquivos, config) em `pre_restore_*` **somente com cópias**; aplicação substitui arquivos/config por completo (sem mistura); **sidecars `-wal`/`-shm` removidos antes de trocar o banco e no rollback** — nenhum WAL de um banco fica associado a outro; **rollback transacional** desfaz banco, arquivos e config em qualquer falha — inclusive falha na limpeza da flag, que agora é confirmada e aborta com erro se não concluir; backup corrompido/ausente sai com código de erro e limpa a flag; **restauração é snapshot fiel** — backup sem `arquivos/` deixa o vivo sem arquivos e backup sem `configuracao/servidor.json` remove a config viva (servidor volta aos defaults), com rollback integral se a aplicação falhar; **validação estrutural do backup antes de qualquer alteração** — `configuracao/` como arquivo, `servidor.json` como diretório ou `arquivos` como link simbólico rejeitam a restauração sem tocar em nada
- **Backups** — pasta padrão `"backups"` agora resolve para `MESTRE_BACKUPS`/`MESTRE_HOME` (antes caía sempre em `<repo>/backups`, poluindo o diretório real em testes com overrides)
- **Documentação** — `docs/PRIMEIRA-PARTIDA.md`: roteiro não técnico do zero à mesa (instalação, mestre, convites, fichas, patrimônio, mesa, persistência, backup e recuperação), complementando `docs/GUIA-OPERACAO.md`. Instalação validada em checkout limpo (`npm ci` + build + migrate + boot + health)

### Notas de migração

- Configurações existentes de `casasDecimais` continuam funcionando; novos defaults podem ser definidos por campanha
- Livros do acervo existentes funcionam; backups são criados automaticamente em mutações futuras
- Snapshots de campanha anteriores continuam legíveis; o snapshot automático pré-restauração é novo

### Testes

- **`homologacao-primeira-partida.mjs`: 26/26** — primeira partida real via navegador (Playwright, 3 sessões independentes): setup admin → campanha → convite com aprovação → jogadores cadastram/entram → mestre aprova entradas → fichas criadas e enviadas → mestre aprova fichas → mesa com mestre+2 jogadores → chat → rolagens d4/d6/d8/d10/d20 → desafio D10 rolado pelo jogador → ordem de turno → item de inventário → restart do servidor com persistência de campanha, personagens, sessão e chat
- **`homologacao-v1-cobertura.mjs`: 12/12** — cobertura de interface das demais funcionalidades: veículo, conta financeira + movimentação, anotação de diário, ponto de recuperação (snapshot), livro+item no Acervo global, aplicação de livro à campanha (aba Regras → Acervo) e acesso de espectador à mesa
- **`teste-acessibilidade.mjs`: 22/22** — nomes acessíveis em todos os controles das abas da campanha e do patrimônio, navegação por Tab, foco visível, modal rotulado; correção: campo de busca do Acervo na campanha ganhou `aria-label`
- **Dados 3D integrados à mesa** — física de corpo rígido (`fisicaDado.ts`) com poliedros reais d4/d6/d8/d10/d20, animação, geometria corrigida do D10 (faces planas/opostas), cores externa e de números independentes persistidas no servidor e atualizadas sem nova rolagem; resultado continua autoritativo do servidor
- **`homologacao-dados3d.mjs`: 22/22** — canvas 3D real dos 5 tipos, múltiplos dados, cores personalizadas com persistência, histórico compartilhado, desafio D10 e mobile
- **`homologacao-patrimonio.mjs`: 11/11** — movimentação financeira real (saldo 100 → +50 → −30 → 120) com histórico "Saldo após", transferência de item entre personagens e visão idêntica mestre/jogador/mobile
- **`teste-fisica-dados.mjs`: 48/48** — simulação física isolada: faces finais corretas por tipo e limites de trajetória
- **`teste-atualizacao-instalacao.mjs`: 29/29** — homologação de atualização de instalação existente: banco no schema 0013 com dados reais → backup pré-update → `db:migrate` real (0014–0017) → comparação registro a registro sem perdas → servidor sobe, login e dados legados servidos pela API → restauração do backup pré-update via restaurador real → re-atualização com dados preservados

- Suítes principais:
  - `homologacao-final-v1.mjs`: 73/73 — cenário E2E completo (mestre + 2 jogadores, convite, fichas, aprovação, patrimônio, mesa, restart, retorno)
  - `teste-regressao-revisao.mjs`: 31/31 — bloqueios da revisão (inventário, HP/Vitalidade, decimais)
  - `teste-acervo-campanha.mjs`: 43/43 — aplicação atômica de livros, conflitos, rollback 409, decisões manter_campanha/usar_livro
  - `homologacao-acervo.mjs`: 123/123 — biblioteca global, import/export, backups, soft delete
  - `teste-acervo-diff.mjs`: 2/2 — diff de livros
  - `homologacao-mesa.mjs`: 37/37 — multiplayer, chat, rolagens, turnos, ampulheta (pausa/retomada/encerrar/expiração explícita), presença dos 3 participantes capturada antes da entrada (resistência `MRPG_PRESENCA_FALSO`), persistência
  - `teste-mesa-seguranca.mjs`: 18/18 — permissões Socket.IO, privacidade, reconexão, idempotência
  - `homologacao-etapa2.mjs`: 46/46 — patrimônio, financeiro, diário, snapshots, concorrência PATCH×HP
  - `homologacao-equipamentos.mjs`: 31/31 — equipamentos, concorrência, persistência
  - `teste-equipamentos.mjs`: 79/79 — equipamento/desequipamento
  - `teste-financeiro-atomico.mjs`: 40/40 — movimentações financeiras atômicas
  - `teste-moedas-regressao.mjs`: 30/30 — decimais configuráveis
  - `teste-vitalidade-historico.mjs`: 24/24 — histórico de vitalidade
  - `homologacao-hp-historico.mjs`: 16/16 — histórico de HP
  - `teste-venda-estoque.mjs`: 29/29 — venda de itens
  - `teste-pontos-concorrencia.mjs`: 22/22 — concessões/remoções simultâneas de pontos, corrida com PATCH, autorização, ausência de escrita parcial, TOCTOU com barreira determinística (gate restrito a `NODE_ENV=test`) e negativo de produção
  - `teste-acervo-corridas.mjs`: 14/14 — corridas assíncronas do Acervo com respostas atrasadas (Playwright)
  - `teste-docs-operacao.mjs`: 12/12 — guia operacional validado em ambiente isolado (backup/restauração)
  - `teste-restauracao-boot.mjs`: 100/100 — raiz vazia/inexistente→migrate→boot real, restore de schema antigo, corrompido/ausente, falhas com rollback, sidecars WAL/SHM, snapshot fiel sem arquivos/config, validação estrutural (config como arquivo, json como dir, symlink), overrides MESTRE_*
- Auditoria visual/acessibilidade: `auditoria-visual.mjs` percorre login, painel, campanhas, todas as abas da campanha, detalhe de personagem, acervo, administração e conta em desktop (1366×768), tablet (768×1024) e celular (390×844) — 0 achados de rolagem horizontal, elementos cortados, botões sem nome ou campos sem label após as correções de `aria-label`.
