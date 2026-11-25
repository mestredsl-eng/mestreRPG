# Auditoria adversarial de autenticação, autorização e isolamento — Issue #296

Relatório consolidado da frente de segurança da v1.0.9. Consolida, em um único
documento, a matriz ameaça → rota/evento → papel → resultado esperado
(entregável 1), o inventário de testes negativos automatizados (entregável 2)
e os achados por severidade (entregáveis 3 e 4).

- **Base**: `main` pós-`a1522a8` (inclui PRs #325, #330, #332, #333, #334,
  #337, #339 e #340).
- **Método**: suítes `teste-*.mjs` autocontidas — banco SQLite temporário,
  migrations reais, servidor spawnado e teardown seguro. Nenhuma toca dados
  reais do proprietário. Fixtures descartáveis apenas.
- **Execução**: todas as suítes citadas são **steps obrigatórios da CI**
  (job `Servidor — typecheck, build e suítes sem navegador`, exceto onde
  indicado `Navegador`). Um step ausente ou falho reprova o workflow.

## 1. Matriz ameaça → rota/evento → papel → resultado esperado → prova

| # | Ameaça (matriz mínima da issue) | Alvo | Papel do ator | Resultado esperado | Suíte de prova | Status |
|---|---|---|---|---|---|---|
| 1 | Sem autenticação / token inválido / sessão encerrada | Rotas HTTP e handshake Socket.IO | anônimo | 401/redirect; socket não autentica | `teste-sessoes-conta.mjs` (sem tokens, sessão expirada), `teste-sessoes-socket.mjs` (handshake com sessão revogada), `teste-autorizacao-negativa.mjs` (revogação corta HTTP+socket) | ✅ coberto |
| 2 | Sessão revogada reutilizada / revogação em uso | `DELETE /auth/sessions`, sockets vivos | usuário | perda de auth imediata + desconexão de sockets da sessão | `teste-sessoes-conta.mjs` (42 verificações) | ✅ coberto |
| 3 | Usuário sem membership / membership removida / papel espectador | rotas e eventos de campanha | jogador sem vínculo / espectador | 403/negação; eventos mestre-only não chegam | `teste-escopo-cruzado.mjs` (38), `teste-autorizacao-eventos-passivos.mjs` (G3/G4), `teste-arquivos-ci.mjs` (membro removido sem reuso) | ✅ coberto |
| 4 | IDs de campanha/personagem/arquivo/convite trocados entre campanhas | `PATCH/GET` por id, uploads, convites | membro de outra campanha | 403/404; zero vazamento cross-campaign | `teste-escopo-cruzado.mjs` (HTTP+socket), `teste-arquivos-ci.mjs` (isolamento), `teste-autorizacao-negativa.mjs`, `teste-guildas-admin.mjs` (IDOR entre guildas) | ✅ coberto |
| 5 | Acesso direto a endpoint/evento que a UI oculta | ações de mestre, detalhes de sessão, versão admin de eventos | espectador/jogador | proteção no servidor, não na UI | `teste-autorizacao-eventos-passivos.mjs` (eventos `mesa:teste:detalhe`, `mesa:teste` com `alvo`), `teste-mesa-seguranca.mjs` (ações exclusivas do mestre) | ✅ coberto |
| 6 | Socket conectado antes da revogação, ação depois dela | eventos `mesa:*`, `campanha:*` | sessão revogada | ações negadas; socket da sessão desconectado; demais sessões intactas | `teste-autorizacao-negativa.mjs` (G1/G5), `teste-sessoes-conta.mjs`, `teste-sessoes-socket.mjs` (logout isola por sessão, troca de contas) | ✅ coberto |
| 7 | Mass assignment / campos inesperados em payloads | `PATCH` ficha, membership, `/admin/users` | jogador/mestre/qualquer autenticado | chaves `__*`, fora do modelo e de outras tabelas descartadas; readback no banco confirma | `teste-mass-assignment.mjs` (18 verificações, PR #339) | ✅ coberto |
| 8 | Repetição de requests / replay / `requestId` conflitante | rolagens D10, idempotência de ações, aceite de convite | qualquer papel | ACK duplicado, zero efeitos novos, contagens no banco estáveis | `teste-mesa-d10-e2e.mjs` (requestId, 3 contextos Playwright), `teste-mesa-virtual.mjs`, `teste-rate-limit-socket.mjs` (idempotência preservada sob rate limit), `teste-convite-cadastro.mjs` (corrida de aceite: exatamente 1 vence) | ✅ coberto |
| 9 | Vazamento em erros, logs, exports e respostas | JSON malformado, erros 4xx/5xx, exports | qualquer papel | 400/erro sem stack trace nem dados internos | `teste-mass-assignment.mjs` (JSON malformado → 400 sem stack); exports auditados em suítes de backup/import (`teste-importacao-integridade.mjs`) | ✅ coberto |
| 10 | CORS/cookies/headers e configuração de proxy | cookies de sessão, `X-Forwarded-*`, `trust proxy` | cliente direto / atrás de proxy | cookie `Secure` só com proxy configurado; headers de proxy ignorados sem `proxyHops`; IP efetivo e rate limit não falsificáveis | `teste-proxy-acesso.mjs` (18), `auth-cookie.test.ts` (parser: percent-encoding, prefixo similar, header ausente) | ✅ coberto |
| 11 | Rate limiting / abuso de convites e operações sensíveis | login, troca de senha, registro, upload, pontos, convites, sockets | anônimo/autenticado | janelas e limites existentes rejeitam abuso; limites documentados (não inventados) | `teste-rate-limit-socket.mjs` (ACK `RATE_LIMITED`, cota por usuário/ação, rejeição não grava), `teste-convite-cadastro.mjs` (limite de usos, corrida), inventário HTTP em `docs/SEGURANCA-RATE-LIMIT-296.md` | ✅ coberto |
| 12 | Privilégio de um escopo vazando para outro (ADMIN global × GM de guilda × mestre de campanha) | rotas HTTP e eventos socket | ADMIN sem membership, GM sem membership | negação cruzada; privilégio nunca atravessa escopo | `teste-escopo-cruzado.mjs`, `teste-guildas-admin.mjs` (74 verificações: IDOR guildas, último GM, multi-ADMIN, auditoria) | ✅ coberto |
| 13 | Último mestre ativo / integridade de papel na campanha | `PATCH/DELETE` members | dois mestres concorrentes | corrida nunca zera mestres ativos (WHERE condicional) | `teste-autorizacao-concorrencia.mjs` + seção de corrida em `teste-guildas-admin.mjs` | ✅ coberto |
| 14 | Cadastro anônimo por convite: `isAdmin` forjado, limite de usos, proteção do admin principal | `POST /auth/register`, `/auth/setup` | anônimo | registro só com convite ativo; nenhum admin extra; `/auth/setup` bloqueado | `teste-convite-cadastro.mjs` (32 verificações), `teste-escopo-cruzado.mjs` (isAdmin forjado) | ✅ coberto |
| 15 | Anexos: traversal, MIME perigoso, colisão, isolamento, falha parcial | upload/download de arquivos | membro/jogador | uuid no disco, validações, zero órfãos após kill | `teste-arquivos-ci.mjs` (27 verificações) | ✅ coberto |

## 2. Inventário de suítes adversariais obrigatórias na CI

Job `Servidor` (sem navegador), `.github/workflows/ci.yml`:

| Suíte | Verificações | Frente da matriz |
|---|---|---|
| `teste-autorizacao-negativa.mjs` | ~24 pontos | revogação, negação sem efeitos colaterais |
| `teste-autorizacao-eventos-passivos.mjs` | ~17 | rebaixamento de papel, isolamento de rooms |
| `teste-autorizacao-concorrencia.mjs` | ~19 | corrida do último mestre |
| `teste-rate-limit-socket.mjs` | ~25 | rate limit Socket.IO |
| `teste-sessoes-socket.mjs` | ~21 | isolamento de sessões socket |
| `teste-sessoes-conta.mjs` | 42 | gestão/revogação de sessões HTTP |
| `teste-mass-assignment.mjs` | 18 | payloads poluídos |
| `teste-escopo-cruzado.mjs` | 38 | negação cruzada de escopo |
| `teste-guildas-admin.mjs` | 74 | IDOR guildas, multi-ADMIN, auditoria |
| `teste-convite-cadastro.mjs` | 32 | convite, isAdmin forjado, corrida de aceite |
| `teste-proxy-acesso.mjs` | 18 | trust proxy / headers |
| `teste-arquivos-ci.mjs` | 27 | anexos adversariais |
| `auth-cookie.test.ts` (tsx) | 4 testes | parser de cookie de sessão |

Job `Navegador` (Playwright):

| Suíte | Verificações | Frente |
|---|---|---|
| `teste-mesa-d10-e2e.mjs` | 29 | D10 canônico, requestId, OOC×diegético, reconexão |
| `homologacao-mesa-virtual` / `teste-mesa-virtual.mjs` | — | idempotência, turnos, reconexão socket |
| `teste-mesa-seguranca.mjs` | ~18 | papéis e privacidade dentro da mesa |

Contagens marcadas com `~` são pontos de verificação estáticos no código;
as demais foram medidas em execução local/CI. Suítes de apoio não
adversariais (D10, Sangue, XP, backup) reforçam injeções de falha mas não
constam desta matriz.

## 3. Achados por severidade

### Vulnerabilidades confirmadas

**Nenhuma.** Todas as suítes negativas passam na `main` publicada: cada
tentativa de ultrapassar autenticação, escopo, papel, propriedade ou
estado de conta é negada no servidor e não produz efeito colateral
verificável (readback em banco, contagens de eventos, presença em disco).

### Hipóteses registradas (não confirmadas como vulnerabilidade)

- **Rate limit HTTP em memória por instância** (`servidor/src/lib/ratelimit.ts`):
  janelas não persistem entre restarts e não são compartilhadas entre
  réplicas. Aceitável para o modelo de implantação atual (instância
  única local/LAN); se o produto passar a multi-réplica, reavaliar.
  Documentado em `docs/SEGURANCA-RATE-LIMIT-296.md` — não é requisito
  inventado, é característica existente.
- **`server_settings` ganha chaves no boot** (agendamento de backup):
  comportamento legítimo observado na adoção 1.0.8→1.0.9 (#272), não
  vetor de segurança.

### Falsos positivos descartados

- **`__proto__`/chaves `__` em payloads**: inicialmente suspeitas de
  poluir protótipo; verificado que `validarFicha` descarta estruturalmente
  chaves fora do modelo e `__`-reservadas — prova com readback no banco
  em `teste-mass-assignment.mjs`.
- **Headers `X-Forwarded-*`**: comportamento correto — ignorados sem
  `proxyHops` configurado; spoofing de IP/rate-limit impossível em
  cliente direto (`teste-proxy-acesso.mjs`).

### Limitações conhecidas do escopo testado

- Testes rodam contra servidor real em fixtures descartáveis — não há
  exploração externa, carga destrutiva ou teste fora do repositório
  (restrição da própria issue, respeitada).
- Cobertura de UI é indireta: a matriz prova que a proteção está no
  servidor; a UI não foi auditada visualmente para ocultar ações
  proibidas (frente do FILHO — superfícies de menu/atalhos seguem o
  mesmo gate de API, e `teste-autorizacao-eventos-passivos` prova que
  eventos privilegiados não chegam ao cliente).
- Concorrência testada em nível de request/single-process; cenários de
  multi-instância simultânea não se aplicam ao modelo de implantação.

## 4. Reauditoria independente (entregável 5)

Pendente por definição: exige revisor independente dos fixes e
confirmação de que testes anteriores não foram enfraquecidos. Nenhum
teste pré-existente foi modificado para acomodar correção nesta frente;
as suítes adicionadas são novas ou resgatadas de branches abandonadas
com adaptação documentada em PR (`auth-cookie.test.ts`,
`teste-sessoes-conta.mjs`, `teste-mass-assignment.mjs`,
`teste-guildas-admin.mjs`, `teste-convite-cadastro.mjs` — esta última
ligada na CI neste PR).

**Recomendação**: issue permanece aberta até (a) reauditoria
independente registrada por colaborador elegível e (b) disposição do
proprietário sobre os achados. Todo o material de evidência está
versionado: este documento, `docs/SEGURANCA-RATE-LIMIT-296.md` e os
steps obrigatórios do workflow.
