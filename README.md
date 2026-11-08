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

- **Etapa 3 — Campanhas, participantes e convites:** criação/edição de campanhas com sistema de RPG livre, papéis por campanha (mestre/jogador/espectador), gestão de participantes com aprovação e bloqueio, convites por código/link com hash, limite de usos e expiração, sincronização via Socket.IO por sala de campanha.

- **Etapa 4 — Editor de fichas e personagens:** modelos de ficha por campanha com versões publicáveis, editor visual de seções/campos (13 tipos, incluindo calculados com fórmulas), visibilidade e permissão de edição por campo validadas no servidor, personagens com aprovação e fichas renderizadas dinamicamente.
- **Etapas 5–9:** motor de regras personalizável, inventário/equipamentos/veículos/finanças fictícias, mesa em tempo real (chat, testes, turnos, timer, espectador), diário/anotações/snapshots/histórico e biblioteca de arquivos das campanhas.
- **Etapa 10 — Backup e administração do servidor:** backups completos automáticos (banco + arquivos + configuração + versão), restauração com confirmação e rollback, painel "Servidor" no admin, logs operacionais com rotação, health detalhado, encerramento controlado e suporte a proxy HTTPS.
- **Etapa 11 — Diário, anotações e histórico de sessões:** anexos em anotações (arquivos da biblioteca vinculados à nota, com a mesma permissão do arquivo), compartilhamento seletivo por anotação e histórico de sessão enriquecido com alterações relevantes da campanha (auditoria) — detalhe interno visível só ao mestre.
- **Etapa 12 — Salvamento e recuperação de campanhas:** salvamento automático com debounce (qualquer mutação agenda um ponto "Automático", retenção de 20 por campanha), pontos de recuperação manuais com nome/data/descrição, restauração com confirmação `RESTAURAR` + snapshot prévio + auditoria, exportação/importação de campanha em JSON (binários embutidos; conflito de identificador exige substituição explícita pelo mestre), histórico de restaurações e resumo do estado atual na aba Histórico.
- **Etapa 13 — Modo espectador:** pessoas acompanham a campanha sem criar personagem, com acesso em tempo real à mesa, chat e rolagens públicas, acompanhamento de turnos, documentos/histórico autorizados, mensagens opcionais e permissões individuais por espectador (enviar mensagens, ver biblioteca, ver histórico) — validadas no backend.
- **Etapa 14 — Acabamento e mobile:** fundação responsiva global, tabelas densas convertidas em cartões no mobile, fileiras específicas da mesa/regras/arquivos adaptadas e homologação visual com screenshots, verificação de overflow horizontal e erros de console em desktop e celular.
- **Etapa 15 — Segurança e publicação:** correções de autorização de membros, robustez e tratamento de erros, atualização de dependências vulneráveis (drizzle-orm, zod), headers de segurança HTTP, restrição de origem do Socket.IO, rate limiting, SPA servida pelo próprio backend, suporte a proxy/HTTPS e acesso externo via NetBird/Tunnel.
- **Sistema financeiro do personagem:** carteira derivada de tabela `moeda` com saldo inicial, entradas, saídas e saldo atual calculado (`saldo inicial + entradas − saídas`), coluna de seleção Entrada/Saída, formatação BRL com tolerância a valores legados (`"1.111,11"`), permissões por campo e saldo inicial configurável — sem integração automática com compras do inventário.
- **Inventário com cálculos:** campos `tabela` semânticos `item` calculam peso/espaço/valor por linha (`quantidade × unidade`) e resumo geral, com validação de munição (`atual ≤ máxima`), valores não-negativos e tolerância a registros antigos.
- **Poderes × Defeitos:** elementos de regra com níveis graduados (`selecao_nivel`), custos por nível (inclusive negativos que concedem pontos), limites configuráveis de poderes/defeitos, exigência de defeito e validação no backend.
- **Pontos de Vida (HP) e Vitalidade:** HP máximo configurável por campanha (`base + atributo × por nível`, ex.: 100 + Vigor×20), HP atual persistido com dano/recuperação/ajuste, limites (0–máximo) e histórico com motivo e autor. Vitalidade: escala de níveis configurável que reduz dados nas rolagens — penalidade aplicada no backend, Incapacitado bloqueia ações do jogador (mestre pode autorizar exceção). HP e Vitalidade são independentes.
- **Biblioteca de regras inicial:** sementes de talentos, habilidades, conhecimentos, profissões, vantagens, defeitos, poderes, disciplinas, perícias, itens, veículos e dinheiro — semeadas por campanha sem duplicar.

### Pendências que dependem de decisão do mestre

- **VTT (mesa virtual):** mapas táticos, tokens, movimento e névoa de guerra foram explicitamente deixados fora do escopo aprovado — exigem autorização para uma etapa futura.
- **Conversão ferimento → vitalidade:** a relação automática entre dano de HP e nível de vitalidade ficou para configuração futura.

## Operação no Windows

### Iniciar

```bat
iniciar-mestre-rpg.bat
```

O script instala dependências se preciso, compila o backend e o frontend (`site/dist`, servido pelo próprio backend na porta 3001), roda as migrações, verifica se a porta 3001 já está em uso (evita instância duplicada) e sobe o servidor. A aplicação completa — API, frontend e Socket.IO — fica disponível em `http://localhost:3001`. Em desenvolvimento, `npm run dev` sobe o frontend com hot-reload em `http://localhost:5173` (proxy para a API).

### Encerrar

```bat
parar-mestre-rpg.bat
```

Ou feche a janela do servidor / envie `Ctrl+C` / use o botão **Encerrar servidor** no painel Admin → Servidor.

O encerramento é controlado e não depende só de sinais de console: o script chama `POST /api/local/desligar` (somente conexões do próprio computador + segredo em `configuracao/local.json`, que não é versionado), o servidor para de aceitar novas conexões, fecha o Socket.IO, limpa o agendador de backups, drena operações em andamento e fecha o banco SQLite. O `.bat` aguarda a confirmação via `/api/health` por ~20 s e, só se o servidor não cair, exibe aviso claro antes de recorrer ao encerramento forçado. Também é possível encerrar pelo painel admin (`POST /api/admin/servidor/desligar`, requer admin global).

### Onde ficam os dados

| Conteúdo | Local |
|---|---|
| Banco SQLite | `banco/mestre-rpg.db` |
| Arquivos das campanhas | `arquivos/campanhas/<campanhaId>/` (excluídos vão para `.lixeira/`) |
| Backups | `backups/<data>_<tipo>/` |
| Logs operacionais | `logs/servidor.log` (rotação a cada 5 MB, 3 gerações) |
| Configuração | `configuracao/servidor.json` |

### Backups

O backup completo inclui: banco SQLite (via API de backup do SQLite — consistente mesmo com o servidor gravando), todos os arquivos físicos das campanhas, `configuracao/servidor.json`, versão do sistema e um manifesto com a lista de arquivos. Backups antigos só são removidos **depois** que o novo backup é concluído e validado.

Configuração pelo painel **Administração → Servidor → Backups** (salva no banco):

- `backup.agenda`: `manual`, `diario`, `semanal` ou `ambos`
- `backup.hora`: horário do disparo (ex.: `"03:30"`)
- `backup.retencaoDiarios` / `backup.retencaoSemanais`: quantas cópias manter (padrão 7 e 4)
- `backup.pasta`: pasta de destino (padrão `backups/`)

Também é possível criar backup manual imediato pelo painel **Administração → Servidor → Backups**.

**Recuperação de agendamentos perdidos:** se o PC ficar desligado no horário programado, na próxima inicialização o servidor verifica a ocorrência mais recente de cada agenda (diária/semanal). Se ela ainda não foi coberta por um backup automático, executa **um único** backup de recuperação (não uma sequência por dia parado), registra nos logs como "backup recuperado de agendamento perdido" e marca a cobertura para não duplicar. Em caso de falha, tenta novamente em ~30 minutos sem bloquear a inicialização nem o funcionamento do servidor.

### Restaurar uma instalação

1. Abra **Administração → Servidor → Backups**, escolha o backup e clique em **Restaurar**.
2. Digite `RESTAURAR` para confirmar. O sistema valida a integridade, cria um **backup de segurança do estado atual** e marca a restauração como pendente.
3. **Encerre o servidor** (`parar-mestre-rpg.bat`). Na próxima inicialização, `iniciar-mestre-rpg.bat` aplica a restauração automaticamente antes de abrir o banco — o banco antigo é preservado em `backups/pre_restore_*/` para rollback.
4. Se a restauração falhar, o estado anterior é restaurado automaticamente; nenhum dado é perdido.

Apenas o **administrador global** pode restaurar. Backups nunca são servidos publicamente.

### Acesso externo via HTTPS (amigos pelo navegador)

O backend serve a aplicação completa (frontend + API + Socket.IO) na porta **3001**. Para acesso externo, use um proxy reverso/túnel HTTPS de sua escolha (Cloudflare Tunnel, NetBird ingress, Caddy, nginx etc.) apontando para `http://localhost:3001` — o HTTPS **termina no proxy**; o backend continua HTTP interno.

1. Aponte o túnel/proxy para `http://localhost:3001`.
2. Configure o domínio público no túnel (certificado TLS gerenciado pelo serviço).
3. Em **Administração → Servidor → Acesso externo** (ou `configuracao/servidor.json` → `acesso`), ajuste:
   - `proxyHops`: número de proxies confiáveis à frente (ex.: `1`). Ativa `trust proxy` para que cookies `Secure`, IPs reais e rate limit funcionem corretamente — **não** ative se o backend ficar exposto diretamente. A mudança vale na próxima inicialização do servidor.
   - `dominioPublico`: hostname puro do domínio público (ex.: `rpg.seudominio.com`, sem `https://`). É usado no controle de origens do Socket.IO — somente esse domínio, localhost e IPs privados/LAN são aceitos no handshake. A mudança vale na próxima inicialização.
   - `https`: marca que o acesso externo usa HTTPS (informativo).
4. Cookies de sessão são `HttpOnly` + `SameSite=Lax` e ganham flag `Secure` quando a conexão chega via HTTPS (detectado por `req.secure` → `X-Forwarded-Proto` respeitando `trust proxy`). Socket.IO funciona sobre WebSocket/polling através do túnel; o handshake valida a origem (Fase 5).
5. O proxy deve repassar `X-Forwarded-Proto`, `X-Forwarded-For` e os headers `Upgrade`/`Connection` do WebSocket. O redirecionamento HTTP→HTTPS, quando desejado, é responsabilidade do proxy (o backend não redireciona para não quebrar o acesso HTTP local/LAN).

**Acesso pela rede NetBird (mesh):** com o NetBird ativo, o servidor responde em `http://100.97.99.149:3001` para os peers da malha — sem HTTPS (tráfego já criptografado pelo WireGuard). Para publicar na internet via NetBird, crie um ingress/domínio no painel NetBird apontando para a porta 3001 e cadastre o hostname resultante em `dominioPublico`.

### Recuperação em outro computador Windows

1. Instale Node.js 20+ e clone/baixe o projeto.
2. `npm install` e `npm run db:migrate` (cria a estrutura vazia).
3. Pare o servidor e copie para o novo PC: `banco/mestre-rpg.db`, a pasta `arquivos/campanhas/` e, se quiser manter os backups, `backups/`.
4. Alternativa mais simples: copie a pasta `backups/<data>_manual/` inteira, substitua o banco pela cópia do backup e restaure `arquivos/` — o manifesto do backup indica exatamente o que foi incluído.
5. Ajuste `configuracao/servidor.json` se necessário e rode `iniciar-mestre-rpg.bat`.

### Diagnóstico

- `GET /api/health` — estado do backend, banco, diretório de arquivos, disco e backups (`ok`/`aviso`/`indisponível` + alertas).
- Painel **Administração → Servidor** — uptime, versão, contagens, último backup, logs recentes e configurações globais.
- Problemas comuns: porta 3001 ocupada (o `.bat` avisa e sugere `parar-mestre-rpg.bat`); "pouco espaço em disco" (o health sinaliza abaixo do limite); backup falhando (verifique permissão de escrita na pasta de destino).

## Estado atual
