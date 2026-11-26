# Issue #349 — contrato consolidado da Internet diegética (v1.1.1)

> Fase F1/6 da release #348. Documento de arquitetura e decisões, somente leitura. Esta proposta não cria tabela, migration, endpoint, socket, UI ou alteração de workflow. A implementação continua bloqueada pelas decisões do proprietário listadas na seção 10.

## 1. Escopo e princípios

A v1.1.1 entrega apenas:
- conta diegética ligada a personagem e campanha;
- contatos;
- conversas diretas e em grupo;
- mensagens textuais persistentes, histórico, leitura/não lidas e entrega em tempo real.

Ficam fora da 1.1.1: buscador/sites públicos, jornais/notícias, anúncios, redes sociais, classificados, empresas/vagas, NPCs autônomos, anexos/binários, voz/vídeo e integrações externas (fatias posteriores do roadmap).

Princípios obrigatórios:
1. Estender o Mestre RPG existente. Não criar segunda identidade real, segundo inventário, segundo gate de permissões ou serviço paralelo.
2. O chat OOC da Mesa permanece independente. Mensagens diegéticas não usam `chat_messages` nem seus eventos.
3. O servidor é autoridade para identidade, titularidade, membership, dispositivo, convites, participantes, mensagens e visibilidade.
4. IDs do cliente são referências, nunca prova de autorização.
5. Todo acesso é isolado por campanha e por conta/personagem.
6. Migrações futuras serão aditivas e idempotentes; devem preservar bancos existentes, export/import, snapshots, backup/restore e atualização Windows.
7. Nenhuma alteração em `.github/workflows/ci.yml` sem autorização separada do proprietário.

## 2. O que já existe e deve ser reutilizado

Auditoria original do PAI na #349 (comentário `7174681870`):
- `users`/ `auth_sessions`: identidade real e autenticação já existentes; não são a identidade diegética.
- `campaigns`, `memberships` e `characters`: fronteiras de campanha, papel/status e vínculo do personagem ao titular real.
- `inventory_entries`, `equipment_entries`, `item_templates` e `config.internet`: catálogo/posse canônica e gate cumulativo de perícia + dispositivo da v1.1.0.
- `gate-internet.ts`: gate atual de acesso à Internet/comércio. Tem semântica de mesa e bypass de titularidade para mestre; não pode autorizar conta ou mensagem privada.
- `chat_messages`: chat OOC da campanha; explicitamente proibido como transporte das mensagens diegéticas.
- Socket.IO já dispõe de autenticação e room individual `usuario:{userId}`; não criar conexão paralela.
- Convenções existentes de `requestId`, `uso_conflito`, rate limit, transações, audit log e barreira de restauração devem ser reaproveitadas.

Não criar tabela `dispositivo_vinculado` na 1.1.1: o INTERMEDIÁRIO recomendou cortar essa segunda fonte de verdade. A elegibilidade usa o inventário/equipamento e o gate canônico já existente. Uma seleção explícita de dispositivo “em uso” pode ser feature futura, com contrato próprio.

## 3. Identidade e autorização da conta

### Modelo recomendado

- Uma conta diegética por personagem, opt-in pelo titular.
- Conta ligada a `characterId`, nunca diretamente ao username do usuário.
- ID interno opaco; handle legível e normalizado, único por campanha, independente da identidade real.
- A conta armazena `campaignId` imutável para impor `UNIQUE(campaignId, handle)` e coerência referencial com o personagem. A proposta técnica usa FK composta `(characterId,campaignId) → characters(id,campaignId)` (com chave única correspondente na tabela de personagens), ou validação transacional equivalente se o esquema existente exigir.
- Conta/personagem arquivado ou inativo não pode iniciar nova atividade; o tratamento do histórico é especificado adiante.

### Gate dedicado obrigatório

Criar, na futura implementação, um helper específico (proposto: `contaAutorizadaPara(contaId,userId)`) separado de `personagemAutorizadoInternet`/`gateInternetDoPersonagem`. Revalidar em cada operação relevante:

1. titularidade atual: `characters.membershipId → memberships.userId === userId`, sem bypass para mestre;
2. membership do usuário na campanha com `status="ativo"` e `role ∈ {"mestre","jogador"}`;
3. conta ativa e coerente com o personagem/campanha;
4. personagem não arquivado/inativo;
5. elegibilidade do dispositivo/perícia conforme decisão G4 da seção 10.

Espectador-dono é negado para conta/mensagens. Mestre só acessa conta do próprio personagem, se titular e elegível; não ganha leitura de conversa alheia por ser mestre. ADMIN global também não recebe acesso implícito.

**Não alterar** os helpers atuais da Internet/comércio da v1.1.0: o novo gate é aditivo para preservar a semântica já publicada. NPC/personagem do mestre sem titularidade normal: política pendente do proprietário; recomendação técnica é NPC não possuir conta diegética na 1.1.1.

## 4. Modelo de domínio consolidado

| Entidade | Chaves/escopo | Regras |
|---|---|---|
| Conta (`internet_accounts`) | campanha + personagem; handle único por campanha | uma conta por personagem; titularidade resolvida via personagem/membership |
| Contato (`internet_contacts`) | aresta dirigida: origem → destino + campanha | pedido unilateral; estado e autoria preservam quem iniciou |
| Conversa (`internet_conversations`) | ID opaco + campanha | direta ou grupo; status ativa/arquivada |
| Participante (`internet_participantes`) | conversa + conta | status explícito, papel e trilha de convite/entrada/saída |
| Mensagem (`internet_messages`) | conversa + autor + requestId | conteúdo textual, timestamp do servidor e fingerprint do payload |
| Cursor de leitura | colunas no próprio participante | única fonte de verdade, sem tabela separada de leituras |

### Contatos — aresta dirigida (canônico F1/F2)

`internet_contacts` representa `conta_origem → conta_destino`, com campanha, estado e autoria/origem do pedido. Unicidade proposta: `UNIQUE(campaign_id, conta_origem_id, conta_destino_id)`.

- `pendente`: pedido unilateral; a origem identifica quem pediu.
- `aceito`: contato aceito.
- `bloqueado`: estado na aresta dirigida; o efeito recomendado é bilateral de facto (bloqueia envio nos dois sentidos), sujeito à decisão G2 do proprietário.
- Remover contato não deve apagar mensagens/histórico automaticamente. A semântica de remoção, visibilidade do histórico e eventual novo pedido deve seguir a decisão de produto; não inferir exclusão de conversa.

Não modelar contatos como par não ordenado nem derivá-los de conversas: isso não representa pedido pendente nem bloqueio independente de conversa.

### Conversas diretas e grupos

- Conversa direta: `parKey = min(contaA,contaB) + "|" + max(contaA,contaB)`; `UNIQUE(campaignId,parKey)`. A criação concorrente é resolvida pela constraint/transação, não por check-then-act. Grupos deixam `parKey` nulo.
- Participante: `papel = dono|membro`; status explícito `convidado|ativo|recusado|cancelado|saiu`; manter quem convidou e timestamps de convite/decisão/saída.
- Reconvite deve preservar trilha histórica (nova participação/evento auditável ou reativação transacional com histórico explícito); não apagar e recriar silenciosamente.
- Convite exige membership ativa e conta elegível na mesma campanha. Exigir também contato aceito é o default G3 recomendado, pendente de aprovação do proprietário.
- O destino do grupo quando o criador sai (transferir owner, encerrar ou permitir grupo sem owner ativo) é decisão do proprietário; não presumir comportamento.

## 5. Mensagens, ordenação, leitura e idempotência

- Ordenação canônica: `(createdAt,id)` do servidor. Não usar relógio do cliente nem assumir que timestamp sozinho é único.
- Paginação keyset por cursor opaco/validado; nunca offset mutável para histórico em tempo real.
- Cursor único por participante: `(lastReadCreatedAt,lastReadMessageId)`, atualizado na mesma linha/transaction do participante. **Não criar** tabela paralela `internet_leituras`.
- Não lida = mensagem posterior ao cursor na ordenação `(createdAt,id)`, desconsiderando mensagens do próprio autor.
- Envio exige `requestId` e persiste `payloadHash` (SHA-256 do payload canônico, NFC-normalizado).
- Constraint: `UNIQUE(conversationId,authorContaId,requestId)`.
- Mesmo requestId + mesmo hash: replay idempotente, devolver a mensagem existente (`replay:true`), sem segunda gravação.
- Mesmo requestId + hash diferente: `uso_conflito`, sem mutação.
- Teto de caracteres e mensagens/minuto continuam pendentes (D4); usar rate limit server-side por conta/usuário após decisão do proprietário.

## 6. Socket.IO e entrega realtime — sem room de conteúdo

A conexão autenticada atual é reutilizada. O desenho corrigido do PAI (#351, comentário `7175636585`) e o parecer do INTERMEDIÁRIO (#349, comentário `7176128568`) eliminam completamente rooms de conversa para tráfego de conteúdo.

- Não criar `ic:{conversaId}` nem fazer broadcast de conteúdo para room compartilhada.
- `internet:conversa-entrar`: revalidar conta/titularidade/participação e devolver somente cursor/estado no ACK; nunca conteúdo de conversa.
- `internet:conversa-sair`: estado de participação vem do banco; não serve como autorização de room.
- `emitirInternetConversa(conversaId,event,data)`: carregar participantes ativos, resolver conta → personagem → membership → userId, reexecutar `contaAutorizadaPara` para cada destinatário em cada entrega e emitir individualmente para `usuario:{userId}`.
- Deduplicar `userId` quando a mesma pessoa tem mais de uma conta/personagem participante; payload contém `conversaId` e `contaId` para roteamento correto do cliente.
- Rebaixamento, remoção, saída, bloqueio ou revogação cortam a próxima entrega porque os participantes autorizados são consultados de novo no banco. Não depender de remoção best-effort de room.
- Após reconexão, cliente revalida e pede lacunas por cursor; sem polling recorrente e sem rejoin que contorne revogação.
- Eventos/payloads mínimos propostos: mensagem com `mensagemId,conversaId,contaId,autor/tipo,conteudo,createdAt,requestId`; ACK com `requestId,mensagemId,createdAt,replay`; atualização de conversa/convite/leitura sem revelar conteúdo a não participantes.
- OOC, namespace da Mesa e `sockets/mesa.ts` permanecem fora do escopo.

## 7. Privacidade, exportação, retenção e transferência

- Leitura/escrita de DM/grupo somente para participante ativo com gate válido. Mestre e ADMIN não têm acesso de auditoria implícito.
- Export comum da campanha: default fail-closed, **excluir mensagens/conversas privadas** para não permitir que um exportador receba conteúdo que não pode ler na UI.
- Export privado por titularidade (somente conversas das contas do próprio exportador) é uma alternativa de portabilidade, ainda pendente de decisão.
- Backup técnico/snapshot/restore precisa preservar o banco completo e as mensagens privadas para recuperação operacional; isso não concede ao operador direito de ler conteúdo na interface. O controle de acesso após restore continua igual.
- Não apagar mensagem/histórico ao remover contato, sair de grupo ou arquivar conta por acidente. Retenção, expurgo, histórico pós-bloqueio e visibilidade de conversas arquivadas precisam de decisão explícita.
- Transferência de personagem altera o titular real via membership. Se a conta acompanha o personagem, o novo titular poderia herdar mensagens privadas antigas. Herança do histórico, confirmação do novo titular, evento de sistema e opção de encerrar/recriar conta são decisões pendentes (B7); nenhum comportamento pode ser implementado por inferência.

## 8. Matriz de autorização proposta

| Ator/estado | Criar/gerir conta própria | Gerir contatos | Ler/enviar conversa | Acesso a conversa alheia |
|---|---:|---:|---:|---:|
| Dono de personagem + membership ativa + papel jogador/mestre + gate elegível | Sim | Sim, no escopo aprovado | Sim, se participante ativo | Não |
| Jogador ativo sem personagem/conta elegível | Não | Sem conta, não | Não | Não |
| Mestre ativo titular do personagem | Sim, nas mesmas condições | Sim, nas mesmas condições | Sim, se participante ativo | Não por ser mestre |
| Espectador, inclusive dono do personagem | Não | Não | Não | Não |
| Membership pendente/bloqueada/removida | Não | Não | Não | Não |
| ADMIN global | Não por padrão | Não por padrão | Não por padrão | Não |

Convite, envio, leitura, paginação, cursor e entrega por socket devem revalidar autorização. O gate 1.1.0 de comércio não substitui o gate de conta/mensagem.

## 9. Contratos HTTP e eventos (proposta; nomes finais a consolidar)

### HTTP

- Criar conta diegética: `POST /campaigns/:campaignId/internet/account`.
- Listar contatos: `GET /campaigns/:campaignId/internet/contacts`.
- Solicitar/aceitar/remover/bloquear contato: operações explícitas sobre a aresta dirigida.
- Criar/listar conversas: rotas próprias da Internet, fora de `chat_messages`.
- Buscar histórico: `GET /campaigns/:campaignId/internet/conversations/:id/messages?cursor=...` (keyset).
- Marcar leitura: operação idempotente que atualiza o cursor do participante.

Todos os handlers resolvem usuário autenticado + conta + personagem + membership + gate de dispositivo; IDs do cliente não autorizam.

### Socket.IO

- Reusar a conexão autenticada atual.
- Join/handshake de conversa apenas valida participante e devolve cursor/estado; nenhuma sala de conteúdo.
- Envio persiste primeiro sob transação/idempotência; ACK informa a mensagem persistida.
- Fan-out individual, revalidado por destinatário, para `usuario:{userId}`.
- Reconexão recupera mensagens posteriores ao cursor, sempre com autorização atual.
- Erros estáveis e sem oráculo de enumeração: autenticação inválida, membership inválida, conta inelegível/inativa, não participante, conversa não encontrada, payload inválido e `uso_conflito`.

Os caminhos acima são contratos propostos, não API implementada nem nomes definitivos.

## 10. Decisões do proprietário — BLOQUEIAM a implementação

Nenhum item abaixo está aprovado só por ter recomendação técnica. O proprietário deve escolher explicitamente:

| ID | Decisão necessária | Alternativas/recomendação registrada | Estado |
|---|---|---|---|
| P1 | Conta opt-in e uma por personagem; política para NPC/personagem do mestre | Recomenda-se opt-in, uma por personagem; NPC sem conta na 1.1.1 | **PENDENTE** |
| P2 | Escopo de contatos/conversas | Campanha-local na 1.1.1; sem identidade global | **PENDENTE confirmação** |
| P3 / G2 | Bloqueio de contato | Bilateral de facto (bloqueia as duas direções) ou unilateral | **PENDENTE** |
| P4 / G3 | Convite de grupo | Exigir contato aceito + conta ativa/elegível; ou permitir convite sem contato | **PENDENTE** |
| P5 / G4 | Criação de conta | Exigir gate completo de Internet (perícia + dispositivo canônico) no momento da criação; ou permitir pré-cadastro | **PENDENTE** |
| P6 | Criador sair de grupo | Transferir propriedade, encerrar grupo ou permitir grupo sem owner ativo | **PENDENTE** |
| P7 / B7 | Transferência de personagem | Conta/histórico acompanha o personagem com evento e confirmação; ou encerrar/recriar/segregar histórico | **PENDENTE** |
| P8 / D4 | Limite de mensagem e rate limit | 4.000 caracteres + 20/minuto (recomendação INTERMEDIÁRIO) ou 8.000 + 30/minuto (proposta F2) | **PENDENTE** |
| P9 | Export/import de mensagens | Excluir do export comum; opcionalmente incluir apenas conversas próprias do exportador. Backup técnico preserva tudo | **PENDENTE** |
| P10 | Moderação mestre/ADMIN | Nenhuma leitura privilegiada por padrão; decidir se existe ferramenta excepcional, com trilha de auditoria | **PENDENTE** |
| P11 | Privacidade do perfil e presença | Perfil público mínimo, presença/indicador de digitação desligado por padrão; confirmar visibilidade | **PENDENTE** |
| P12 | Histórico após bloqueio/remoção/arquivamento | Preservar histórico dos participantes autorizados versus restringir/ocultar após a ação | **PENDENTE** |
| P13 | Retenção/expurgo | Sem expurgo automático na 1.1.1 como proposta técnica; confirmar retenção/arquivamento | **PENDENTE** |

A recomendação fail-closed é preservar a privacidade: sem resposta, nenhuma exceção de leitura para mestre/ADMIN, nenhum export de DM por padrão, nenhum indicador de digitação e nenhum acesso baseado apenas em ID.

## 11. Plano de implementação após aceite

1. Proprietário responde às decisões P1–P13; PAI registra as respostas e consolida este contrato.
2. INTERMEDIÁRIO confere a versão consolidada e confirma que nenhuma decisão pendente foi transformada em default aprovado.
3. F2/F3 reservam schema/rotas/socket e delta de arquivos antes de escrever; F4 trabalha em UI sobre contratos firmes; F5 valida gate/dispositivo/privacidade; F6 fecha matriz de qualidade e durabilidade.
4. Migrações aditivas/idempotentes; testes em banco limpo e upgrade v1.1.0; concorrência, replay, revogação e backup/restore.
5. Cada implementação usa branch/PR pequena contra a main vigente, CI natural no SHA final, sem SKIP silencioso e sem editar workflow protegido.
6. Release somente após gates de #348 e autorização expressa do proprietário.

## 12. Pareceres e trilha de auditoria

- PAI v3: comentário #349 `7175640361` — gate específico de conta e defaults G2/G3/G4 propostos.
- INTERMEDIÁRIO: revisão suplementar #349 `7176128568` — corrige aresta de contato, fonte única do cursor, idempotência e valida o fan-out sem room de conteúdo.
- PAI: reconciliação F1×F2 #350 `7176550876`.
- INTERMEDIÁRIO: parecer final F1×F2×F3 #349 `7176869671` — **PASS técnico** na reconciliação.
- Plano realtime corrigido pelo PAI #351 `7175636585` — fan-out individual por usuário, revalidação a cada entrega, sem sala compartilhada de conteúdo.

**Status atual:** contrato tecnicamente coerente e revisado (PASS). Isso não significa aprovação das decisões de produto P1–P13. Não iniciar implementação antes das respostas do proprietário.
