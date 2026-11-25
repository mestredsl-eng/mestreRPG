# Issue #349 — proposta de arquitetura e contrato da Internet diegética

> Fase 1/6 da Issue #348. Documento somente documental: não cria tabela, migration, endpoint, socket ou alteração de workflow.

## 1. Decisões de escopo recomendadas

- **Identidade:** conta diegética vinculada explicitamente a um personagem dentro de uma campanha; criação opt-in pelo dono ativo do personagem.
- **Handle:** identificador legível único por campanha, separado do username da conta real; normalização case-insensitive e reserva de nomes proibidos.
- **Escopo:** contatos, conversas e mensagens são **locais à campanha** na 1.1.1. Não há identidade global entre campanhas.
- **Privacidade:** conversa privada/grupo é legível por participantes autorizados; mestre e ADMIN não recebem leitura implícita.
- **Dispositivo:** entrada depende do gate canônico já existente (item/dispositivo possuído e personagem autorizado), nunca apenas de texto enviado pelo cliente.

## 2. Modelo de domínio proposto

| Entidade | Chave/escopo | Regras principais |
|---|---|---|
| Conta diegética | `campaign_id + handle_normalizado` | pertence a um personagem da mesma campanha; uma por personagem na 1.1.1 |
| Contato | `campaign_id + owner_account_id + target_account_id` | estado `pendente/aceito/bloqueado/removido`; sem atravessar campanhas |
| Conversa | ID opaco + campanha | `privada` ou `grupo`; estado ativa/arquivada |
| Participante | conversa + conta diegética | papel participante/owner; entrada/saída registrada |
| Mensagem | ID monotônico por conversa | conteúdo textual, autor, created_at, idempotency_key opcional |
| Leitura | conversa + participante | último message_id lido; sem marcar leitura para quem não participa |

### Relações proibidas

- conta diegética não pode apontar para personagem de outra campanha;
- participante não pode ser incluído por `userId` sem resolver conta/personagem/membership;
- conversa diegética não usa a tabela/eventos do chat OOC.

## 3. Matriz de acesso inicial

| Papel/estado | Criar conta | Gerir contatos | Ler conversa participante | Enviar | Criar grupo | Ver conversa alheia |
|---|---:|---:|---:|---:|---:|---:|
| Dono ativo do personagem | Sim | Sim | Sim | Sim | Sim | Não |
| Jogador ativo não participante | Não | Sim | Não | Não | Sim, com convidados aceitos | Não |
| Mestre ativo | Não por padrão | Não por padrão | Só se participante | Só se participante | Não por padrão | Não |
| Espectador | Não | Não | Não | Não | Não | Não |
| Membership pendente/bloqueada/removida | Não | Não | Não | Não | Não | Não |
| ADMIN global | Não por padrão | Não por padrão | Não por padrão | Não por padrão | Não por padrão | Não |

Qualquer exceção de moderação precisa ser decisão explícita do proprietário e contrato separado; não deve aparecer por inferência de papel.

## 4. Política de grupos e histórico

- Criador vira owner da conversa.
- Convite exige membership ativa do convidado e conta diegética na mesma campanha.
- Aceite é explícito; convite não equivale a participação.
- Owner pode remover participante; participante pode sair.
- Grupo encerrado fica somente leitura para participantes já autorizados.
- Histórico não é apagado fisicamente por uma operação normal de UI; exclusão/arquivamento deve ser auditável.
- Mudanças de participantes não reescrevem mensagens antigas.

## 5. Leitura, não lidas e idempotência

- Ordenação por `message_id`/cursor do servidor, não pelo relógio do cliente.
- Paginação por cursor opaco; limite máximo fixo.
- `send` aceita `requestId` único por conta/conversa; replay retorna a mensagem já criada.
- `mark-read` é idempotente e só avança o ponteiro.
- Reconexão usa `afterMessageId` e retorna lacunas autorizadas; sem polling recorrente.
- Falhas de autorização não distinguem conversa inexistente de conversa de terceiro quando o contrato exigir ocultação.

## 6. Contratos mínimos propostos

### HTTP

- `POST /campaigns/:campaignId/internet/account`
- `GET /campaigns/:campaignId/internet/contacts`
- `POST /campaigns/:campaignId/internet/contacts/requests`
- `POST /campaigns/:campaignId/internet/conversations`
- `GET /campaigns/:campaignId/internet/conversations/:id/messages?after=`
- `POST /campaigns/:campaignId/internet/conversations/:id/read`

Todos os endpoints devem resolver a identidade pelo usuário autenticado + personagem + membership + gate de dispositivo; IDs do cliente são somente referências.

### Socket.IO

- `internet:join` → sala autorizada por conversa.
- `internet:leave` → remove inscrição local.
- `internet:send` → ACK com `{ ok, messageId, replay }`.
- `internet:read` → ACK idempotente.
- `internet:message` → somente para participantes autorizados da conversa.

Erros mínimos: `nao_autenticado`, `membership_invalida`, `dispositivo_indisponivel`, `conta_nao_criada`, `nao_participante`, `conversa_nao_encontrada`, `request_repetido`, `payload_invalido`.

## 7. Arquivos e dependências para implementação futura

- **Backend:** schema/migrations aditivas, serviços de domínio e rotas próprias da Internet.
- **Realtime:** módulo Socket.IO separado do chat OOC, reutilizando autenticação e revalidação existentes.
- **Frontend:** área dentro do shell da Internet; sem segundo inventário, segundo gate ou segundo chat OOC.
- **Qualidade:** matriz adversarial de IDOR, revogação, retry, reconexão, export/import e backup/restore.

Não reservar `.github/workflows/ci.yml` nesta fase. A integração da suíte deve ser coordenada por PR própria posterior.

## 8. Decisões pendentes do proprietário

1. Aprovar conta diegética opt-in e uma conta por personagem na 1.1.1.
2. Confirmar contatos/conversas restritos à campanha.
3. Confirmar se grupos podem existir sem o criador permanecer participante.
4. Confirmar se haverá ferramenta de moderação excepcional do mestre/ADMIN.
5. Confirmar retenção/arquivamento e eventual limite de tamanho de mensagem.
