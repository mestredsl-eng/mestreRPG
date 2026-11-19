# Guia operacional — Mestre RPG v1.0

Manual para quem hospeda o Mestre RPG no próprio PC. Todos os comandos abaixo foram conferidos contra `package.json`, `servidor/src/config.ts`, `servidor/src/db/migrate.ts` e os scripts `.bat` do repositório — se algo divergir, o código-fonte é a referência.

> No Windows, os arquivos `iniciar-mestre-rpg.bat` e `parar-mestre-rpg.bat` automatizam quase tudo descrito aqui. Este guia explica o que eles fazem e como operar manualmente quando necessário.

---

## 1. Requisitos

- **Node.js 20.19 ou superior** (`engines` do `package.json` raiz exige `>=20.19`). Verifique com `node -v`.
- **npm** compatível (vem com o Node).
- Sistema operacional: desenvolvido e homologado no **Windows**; os comandos npm funcionam em Linux/macOS, mas os `.bat` são específicos do Windows.
- Espaço em disco: o health check sinaliza quando o espaço está baixo; reserve alguns GB para banco, arquivos de campanha e backups.

## 2. Instalação limpa

```bash
git clone <url-do-repositorio>
cd mestre-rpg
npm install            # instala dependências dos workspaces (servidor + site)
npm run db:migrate     # cria/atualiza o banco SQLite (servidor/migrations)
npm run build          # compila servidor (tsc) e site (vite → site/dist)
```

No Windows, `iniciar-mestre-rpg.bat` faz os passos 3–5 automaticamente na primeira execução.

## 3. Configuração

### Arquivo `configuracao/servidor.json` (opcional)

```json
{
  "host": "0.0.0.0",
  "porta": 3001,
  "sitePorta": 5173,
  "caminhos": { "banco": "banco/mestre-rpg.db", "arquivos": "arquivos/campanhas", "backups": "backups" },
  "arquivos": { "tamanhoMaxMb": 25, "formatosExtras": [] },
  "acesso": { "dominioPublico": "", "proxyHops": 0, "https": false }
}
```

Se o arquivo não existir ou estiver inválido, o servidor usa os padrões e avisa no console. Todos os campos são opcionais individualmente.

> **`acesso.proxyHops`:** `0` (padrão) é o correto para acesso direto pela rede local — o servidor não confia em headers `X-Forwarded-*` vindos do cliente. Só aumente para a **quantidade real de proxies/túneis confiáveis** à frente do backend (ex.: `1` para um único Cloudflare Tunnel/Caddy/nginx). Um valor menor que a topologia real quebra a detecção de IP/HTTPS; um valor maior expõe o servidor a falsificação de headers. A alteração só entra em vigor **após reiniciar o servidor** (vale tanto para `servidor.json` quanto para o painel admin).

### Variáveis de ambiente

| Variável | Efeito | Padrão |
|---|---|---|
| `MESTRE_PORTA` | Porta da API/SPA | `3001` (ou `porta` do `servidor.json`) |
| `MESTRE_BANCO` | Caminho do banco SQLite | `banco/mestre-rpg.db` |
| `MESTRE_ARQUIVOS` | Pasta de arquivos das campanhas | `arquivos/campanhas` |
| `MESTRE_BACKUPS` | Pasta de backups | `backups/` |
| `MESTRE_HOME` | Raiz alternativa (usado pelo restaurador) | raiz do projeto |

> As variáveis de ambiente têm precedência sobre os caminhos do `servidor.json` para banco/arquivos/backups (ver `servidor/src/db/index.ts`).

## 4. Desenvolvimento

```bash
npm run dev
```

Sobe API (`tsx watch`, porta 3001) e frontend Vite (porta 5173, proxy `/api` e `/socket.io` para 3001) em paralelo, com hot-reload.

## 5. Produção

```bash
npm run build        # já compilado? pode pular
npm start            # node servidor/dist/index.js → http://localhost:3001
```

Em produção **não é preciso** rodar o Vite: o backend serve `site/dist` diretamente (SPA + API + Socket.IO na mesma porta 3001). Acesse `http://localhost:3001` — a primeira conta criada vira administradora global.

## 6. Onde ficam os dados

| Conteúdo | Local |
|---|---|
| Banco SQLite | `banco/mestre-rpg.db` |
| Arquivos das campanhas | `arquivos/campanhas/<campanhaId>/` (excluídos vão para `.lixeira/`) |
| Backups | `backups/<data>_<tipo>/` |
| Logs | `logs/servidor.log` (rotação a cada 5 MB, 3 gerações) |
| Configuração | `configuracao/servidor.json`, `configuracao/local.json` (segredo local — não versionar) |

## 7. Parar o servidor corretamente

- **Windows:** `parar-mestre-rpg.bat` — chama `POST /api/local/desligar` (só conexões locais + segredo de `configuracao/local.json`), aguarda o encerramento real e só recorre a kill forçado se necessário.
- **Manual:** `Ctrl+C` no terminal, ou **Administração → Servidor → Encerrar servidor** (admin global), ou `POST /api/admin/servidor/desligar`.

O encerramento é controlado: para de aceitar conexões, fecha o Socket.IO, drena operações, executa backups pendentes e fecha o SQLite — não mate o processo com `taskkill /F` se puder evitar (pode corromper WAL).

## 8. Backup

### Pelo painel (recomendado)

**Administração → Servidor → Backups → Backup agora**. O backup inclui:

- banco SQLite copiado pela **API de backup do SQLite** (consistente mesmo com o servidor gravando — não copie o `.db` "cru" com o servidor rodando);
- todos os arquivos físicos das campanhas (exceto `.lixeira`);
- `configuracao/servidor.json`;
- versão do sistema e manifesto com SHA-256 dos arquivos.

Agenda automática configurável no mesmo painel (`manual`, `diario`, `semanal`, `ambos` + horário + retenção). Backups velhos só são apagados **depois** que o novo é validado.

### Manual (offline)

Com o servidor **parado**: copie `banco/mestre-rpg.db` + `arquivos/campanhas/` + `backups/` + `configuracao/servidor.json` para local seguro.

## 9. Restaurar um backup

1. **Administração → Servidor → Backups** → escolha o backup → **Restaurar**.
2. Digite `RESTAURAR` para confirmar. O sistema valida a integridade, cria um **backup de segurança do estado atual** e grava a restauração como pendente.
3. **Encerre o servidor** (`parar-mestre-rpg.bat`). Na próxima subida, o `.bat` executa `node servidor/dist/db/aplicar-restauracao.js` **antes** das migrations e da abertura do banco — a ordem é obrigatória: o restaurador troca o arquivo do banco, então as migrations rodam sobre o banco efetivamente restaurado.
4. **Se a restauração falhar ou for cancelada** (backup ausente/corrompido), o `.bat` **interrompe o boot** — o servidor nunca sobe sobre estado incerto. Antes de aplicar, o restaurador copia o estado atual inteiro (banco+sidecars, `arquivos/`, `configuracao/servidor.json`) para `backups/pre_restore_*/`; qualquer falha — inclusive na limpeza da flag de pendência — **reverte banco, arquivos e config** ao estado anterior e aborta. A flag só é considerada limpa após confirmação de que a linha sumiu do banco restaurado. Em falha durante a aplicação a flag permanece para nova tentativa no próximo boot; o estado anterior fica preservado em `pre_restore_*` para inspeção manual.

Apenas o **administrador global** restaura. Backups nunca são servidos publicamente.

**Fidelidade do snapshot:** a restauração reproduz exatamente o que o backup contém. Se o backup não tiver pasta `arquivos/`, os arquivos de campanha atuais são **removidos**; se não tiver `configuracao/servidor.json`, a configuração atual é **removida** e o servidor volta aos valores padrão. Tipos inválidos no backup (ex.: `arquivos` como arquivo) abortam com rollback completo.

## 10. Atualizar para uma versão nova

1. **Backup manual** (painel → Backups) ou confirme o automático mais recente.
2. Atualize o código — em clones Git, o `iniciar-mestre-rpg.bat` já faz isso automaticamente e com segurança (ver §10.1); manualmente, use `git pull` ou uma nova pasta.
3. `npm install` (se as dependências mudaram).
4. `npm run db:migrate` — migrações são **aditivas** (drizzle-kit, `servidor/migrations/0000…0017`) e não apagam dados.
5. Suba normalmente (`iniciar-mestre-rpg.bat` já compila, migra e restaura pendências).

**Nunca apague durante a atualização:** `banco/`, `arquivos/`, `backups/`, `configuracao/`, `logs/`. Esses diretórios contêm todos os dados — o código pode ser substituído inteiro sem perda.

### 10.1 Atualização automática no boot (Issue #155)

O `iniciar-mestre-rpg.bat` executa `node scripts/auto-update.mjs` **depois** de verificar que a porta 3001 está livre e **antes** de instalar dependências, compilar, restaurar e migrar. Se já houver um servidor rodando, nenhuma operação Git acontece — a segunda instância é encerrada como antes.

**Quando a atualização é tentada** — todas as condições precisam valer:

- `git` está instalado e a pasta contém um repositório (`.git`); instalações ZIP sem `.git` pulam silenciosamente.
- A URL **efetiva** de `origin` (consultada com `git remote get-url --all origin`, que expande regras `url.*.insteadOf`) precisa ser exatamente uma única URL do repositório oficial `github.com/mestredsl-eng/mestreRPG`; origem múltipla ou reescrita para outro destino é rejeitada.
- A branch atual tem upstream configurado **e exatamente `origin/<branch-da-branch-atual>`** — upstream de outro remoto ou de fork cancela a atualização, mesmo com `origin` oficial (sem upstream, nada é adivinhado).
- `git status --porcelain` está limpo — qualquer alteração local, rastreada ou não, adia a atualização. Nada é descartado, escondido (stash) ou limpo automaticamente.
- O `fetch` (não interativo, `GIT_TERMINAL_PROMPT=0`, timeout de 30 s) funciona — sem rede, autenticação ou dentro do timeout, o boot segue com a versão local.
- HEAD está apenas atrás do upstream — divergência cancela a atualização.

**Quando há commits novos:** o script mostra a quantidade, executa **somente `git pull --ff-only`** (nunca merge, rebase, force ou stash) e registra o SHA anterior. Se `package-lock.json`/`package.json` mudaram (ou `node_modules` não existe), roda `npm ci` e recompila servidor e frontend. Com lockfile inalterado, pula o `npm ci` e só recompila.

**Se algo falhar depois do pull** (npm ci ou build), o script tenta um **rollback seguro**: só executa `git reset --hard <SHA-anterior>` se a árvore continuar limpa e o HEAD for exatamente o commit obtido pelo pull — alterações surgidas durante o processo bloqueiam o rollback. Depois do rollback, as dependências da versão anterior são reinstaladas e o boot normal prossegue com o código local. Se nem isso for possível com segurança, o `.bat` para com instruções de recuperação manual — nenhum comando destrutivo é tentado por conta própria.

**Instalações sem `.git` (ZIP):** o script detecta a ausência de repositório e segue direto para o fluxo normal — atualizações manuais continuam sendo "substituir a pasta" conforme a seção 10.

**Sem rede:** o fetch falha rápido (sem prompt de credencial), um aviso é exibido no console e o servidor sobe normalmente com a versão local. Para atualizar depois, basta ter rede e executar o `.bat` novamente.

**Como identificar falhas de atualização:** procure linhas `[auto-update]` no console do `.bat`. Mensagens como "alterações locais detectadas", "falha ao buscar atualizações" ou "divergiu do remoto" indicam que a versão local foi mantida de propósito — revise com `git status`/`git pull` manual se quiser atualizar.

**Recuperação após falha de build/rollback:** com o servidor parado, rode `git status` para confirmar que não há alterações inesperadas, `git log --oneline -3` para ver o HEAD, e `npm ci && npm run build` para reconstruir. Se o HEAD ficou no commit novo com build quebrado e a árvore limpa, `git reset --hard <SHA-anterior>` (mostrado no log `[auto-update]`) retorna ao estado anterior — o SHA anterior também fica registrado temporariamente fora do repositório pelo próprio script.

## 11. Migrations

- Arquivos: `servidor/migrations/NNNN_*.sql` + `meta/` (journal do drizzle).
- Comando: `npm run db:migrate` (= `tsx src/db/migrate.ts -w servidor`). Idempotente: só aplica o que falta.
- Banco novo: cria todas as tabelas do zero. Banco existente: aplica só as novas.
- **Se uma migration falhar:** o migrador do drizzle é transacional por arquivo — o banco fica no último estado consistente. Não edite o `.db` na mão; restaure o backup do passo anterior ou corrija o SQL em `servidor/migrations/` e rode `npm run db:migrate` de novo. Se persistir, restaure o backup do passo 10.1.
- Gerar nova migration (só desenvolvimento): `npm run db:generate -w servidor` (drizzle-kit generate a partir de `src/db/schema.ts`).

## 12. Verificar se está funcionando

- `GET http://localhost:3001/api/health` → JSON com checks `ok`/`aviso`/`indisponível` (banco, arquivos, disco, backups) e alertas (`ultimo_backup_falhou`, `nenhum_backup`, pouco espaço).
- Abrir `http://localhost:3001` no navegador → tela de login.
- Painel **Administração → Servidor**: uptime, versão, último backup, logs recentes.

## 13. Diagnóstico de problemas comuns

| Sintoma | Causa provável | Ação |
|---|---|---|
| Porta 3001 ocupada | outra instância rodando | `parar-mestre-rpg.bat` ou troque `porta` no `servidor.json` |
| `/api/health` não responde | servidor não subiu ou migração falhou | veja `logs/servidor.log` e o console do `.bat`; rode `npm run db:migrate` manualmente |
| Login de jogador falha | usuário não existe ou senha errada | peça ao mestre para conferir o participante na aba Participantes; cadastro é por convite |
| Amigos não conseguem entrar | acesso externo mal configurado | veja `dominioPublico`/`proxyHops` no `servidor.json` e o README §"Acesso externo" |
| "Pouco espaço em disco" | health sinaliza limite | libere espaço ou mude `backup.pasta` para outro disco |
| Backup falhando | permissão na pasta de destino | verifique escrita em `backups/` ou ajuste `backup.pasta` |
| Dados "sumiram" após atualização | restore pendente ou banco errado | verifique `MESTRE_BANCO`/`caminhos.banco` e `logs/servidor.log` por `[restauracao]` |

## 14. Limitações conhecidas da v1.0

- **Novidades:** o indicador de publicações não lidas é atualizado ao carregar a sessão e após ações do próprio usuário; ainda não há notificação/push em tempo real para novas publicações.
- **Acesso externo:** depende de proxy/túnel configurado pelo usuário; confira `dominioPublico` e `proxyHops` na configuração.
- **Homologação:** o fluxo operacional foi homologado principalmente no Windows. Em Linux/macOS, os comandos npm são utilizáveis, mas os scripts `.bat` não.
- **Chunk do frontend >500 kB:** o Vite ainda emite um aviso de tamanho; não é falha funcional e permanece como oportunidade de code-splitting.
