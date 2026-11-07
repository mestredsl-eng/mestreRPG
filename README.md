# Mestre RPG

Plataforma própria de RPG hospedada no PC do mestre: campanhas online, fichas 100% personalizáveis, regras do mestre, mesa sincronizada em tempo real e controle total do mestre. Os jogadores participam pelo navegador, sem instalação.

## Stack

- **Backend:** Node.js + TypeScript (Express + Socket.IO + SQLite/Drizzle)
- **Frontend:** React + TypeScript (Vite)
- **Banco:** SQLite local (`banco/mestre-rpg.db`), migrações via Drizzle
- **Monorepo:** npm workspaces (`servidor/`, `site/`)

## Primeiros passos

```bash
npm install          # instala dependências dos workspaces
npm run db:migrate   # cria/atualiza o banco SQLite
npm run dev          # sobe API (3001) e front (5173) em paralelo
```

Ou, no Windows, dê dois cliques em `iniciar-mestre-rpg.bat`.

## Estrutura

```
servidor/   API Node/TS — rotas, sockets, banco, migrações
site/       Interface React — telas do mestre, jogador e espectador
banco/      SQLite local (não versionado)
arquivos/   Arquivos das campanhas (não versionado)
backups/    Backups locais (não versionado)
configuracao/  Configurações do servidor (servidor.json)
```

## Estado atual

- **Etapa 1 — Fundação:** estrutura, servidor, banco com schema completo e interface base.
- **Etapa 2 — Contas e autenticação:** login, sessões persistentes (cookie httpOnly), papéis de administrador, gerenciamento de usuários e Socket.IO autenticado.

Próximas etapas: campanhas e convites, editor de fichas, mesa virtual, dados e testes.
