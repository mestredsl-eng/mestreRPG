# Release Candidate v1.0 — Mestre RPG

Documento de preparação da candidata. **Não é uma release publicada**: sem
tag, sem merge em `main`, sem fechamento de PRs.

- **Branch:** `integracao/acervo`
- **SHA da candidata (código testado):** `c666250` — validado em
  2026-11-10; o commit seguinte adiciona apenas este documento.
- **PRs:** #37 (`integracao/etapa2`, camada base, Draft) e #43
  (`integracao/acervo`, stack completa, Draft, base `integracao/etapa2`).

## Funcionalidades

- Contas, login, primeiro acesso/admin e campanhas com papéis
  mestre/jogador/espectador e aprovações.
- Convites por link com aprovação opcional.
- Modelos de ficha configuráveis, versionados e publicados; fichas com
  seções/campos arbitrários (texto, inteiro, decimal, moeda, data, listas,
  bolinhas, carteira), envio, aprovação, devolução e reabertura.
- HP e Vitalidade com histórico, transações e permissões por papel.
- Patrimônio: inventário com estoque, equipamentos, veículos e financeiro
  (contas, entradas, saídas, ajustes do mestre, transferências, saldo
  após cada movimento, casas decimais configuráveis).
- Mesa multiplayer em tempo real: presença, chat público/privado/secreto,
  rolagens livres d4/d6/d8/d10/d20, testes de habilidade D10, turnos,
  ampulheta com pausa/retomada/expiração, modo espectador, reconexão.
- **Dados 3D**: física de corpo rígido, poliedros reais, cores externa e
  de números independentes por usuário (persistidas no servidor),
  atualização imediata; resultado autoritativo do servidor.
- Acervo global: livros/suplementos, itens, importação/exportação JSON,
  backups e restauração, aplicação explícita às regras da campanha com
  resolução de conflitos e snapshots.
- Diário, snapshots de campanha, histórico e exportação.
- Backup e restauração completos (banco + sidecars WAL/SHM + arquivos +
  configuração), com rollback transacional e validação estrutural.
- Inicialização Windows (`iniciar-mestre-rpg.bat`) com detecção de
  frontend desatualizado.

## Testes (resultados reais no SHA da candidata)

26 suítes somando **940/940** verificações, todas executadas nesta branch:

- E2E navegador (Playwright): primeira partida 26/26, cobertura v1 12/12,
  dados 3D 22/22, patrimônio 11/11, homologação Acervo 123/123,
  homologação final v1 73/73, Etapa 2 46/46, mesa multiplayer 37/37,
  equipamentos 31/31.
- Backend/concorrência: equipamentos 79/79, Acervo-campanha 43/43,
  financeiro atômico 40/40, moedas 30/30, vitalidade 24/24,
  HP-histórico 16/16, venda-estoque 29/29, pontos 22/22,
  mesa-segurança 18/18, regressão 31/31, corrida Acervo 14/14,
  diff Acervo 2/2, acessibilidade 22/22, docs-operação 12/12,
  restauração-boot 100/100, atualização-instalação 29/29,
  física-dados 48/48.
- `tsc --noEmit` (servidor e site, strict): exit 0.
- Builds servidor/site: OK. Homologação visual: 0 achados.

## Instalação e atualização

- Instalação limpa: `iniciar-mestre-rpg.bat` (instala dependências,
  compila, migra e sobe em `http://localhost:3001`).
- Atualização: baixar a branch, `git pull`, executar o mesmo `.bat` —
  as migrations pendentes são aplicadas automaticamente.
- Homologado: instalação no schema 0013 → update real → dados preservados
  registro a registro → boot/login/API → restore pré-update → re-update.

## Backup e restauração

- Pelo painel (Histórico/Acervo) ou manualmente copiando `banco/`,
  `arquivos/` e `configuracao/`.
- Restauração: copiar o backup para `backups/<nome>/` no formato
  documentado em `docs/GUIA-OPERACAO.md` §9 e seguir o procedimento de
  flag do restaurador; rollback transacional comprovado em 100/100.

## Limitações conhecidas

- Mesa virtual (mapas/tokens/névoa) não incluída — pós-v1.
- Financeiro do personagem não se integra automaticamente a compras do
  inventário.
- Conversão ferimento → vitalidade é configuração futura.
- Homologado no Windows; acesso externo depende de proxy/túnel do usuário.
- Chunk do frontend >500 kB (warning do Vite, não funcional).
- Sem CI no GitHub: os resultados acima são execuções locais reproduzíveis
  por script, não status checks da plataforma.
