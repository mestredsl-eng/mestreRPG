# Issue #349 — contrato consolidado da Internet diegética (v1.1.1)

> Fase F1/6 da release #348. Documento de arquitetura e decisões, somente leitura. Esta proposta não cria tabela, migration, endpoint, socket, UI ou alteração de workflow. As decisões P1–P12 foram aprovadas; somente o prazo exato de retenção automática (P13) permanece pendente. A rotina de expurgo não pode ser implementada/ativada até esse prazo ser definido.

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

Espectador-dono é negado para conta/mensagens. Para criar/gerir uma conta, o mestre continua sujeito à titularidade e elegibilidade do próprio personagem. A leitura de mensagens como mestre é uma permissão separada, restrita à própria campanha e somente leitura, conforme P10/§7; não amplia a gestão de contas. ADMIN global não recebe acesso implícito.

**Não alterar** os helpers atuais da Internet/comércio da v1.1.0: o novo gate é aditivo para preservar a semântica já publicada. Decisão aprovada do proprietário (P1): conta opt-in, uma por personagem; NPC não precisa de conta na 1.1.1.

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
- `bloqueado`: estado na aresta dirigida; por decisão aprovada P3, bloqueia envio nos dois sentidos (efeito bilateral de facto), mantendo a autoria/origem da aresta.
- Remover contato não deve apagar mensagens/histórico automaticamente. A semântica de remoção, visibilidade do histórico e eventual novo pedido deve seguir a decisão de produto; não inferir exclusão de conversa.

Não modelar contatos como par não ordenado nem derivá-los de conversas: isso não representa pedido pendente nem bloqueio independente de conversa.

### Conversas diretas e grupos

- Conversa direta: `parKey = min(contaA,contaB) + "|" + max(contaA,contaB)`; `UNIQUE(campaignId,parKey)`. A criação concorrente é resolvida pela constraint/transação, não por check-then-act. Grupos deixam `parKey` nulo.
- Participante: `papel = dono|membro`; status explícito `convidado|ativo|recusado|cancelado|saiu`; manter quem convidou e timestamps de convite/decisão/saída.
- Reconvite deve preservar trilha histórica (nova participação/evento auditável ou reativação transacional com histórico explícito); não apagar e recriar silenciosamente.
- Convite exige membership ativa e conta elegível na mesma campanha e, por decisão aprovada P4, contato previamente aceito.
- P6 aprovado: quando o proprietário do grupo sai, a propriedade deve ser transferida para outro membro elegível. O fluxo deve validar a elegibilidade do sucessor e registrar a transferência; nunca deixar a propriedade com membro inelegível.

## 5. Mensagens, ordenação, leitura e idempotência

- Ordenação canônica: `(createdAt,id)` do servidor. Não usar relógio do cliente nem assumir que timestamp sozinho é único.
- Paginação keyset por cursor opaco/validado; nunca offset mutável para histórico em tempo real.
- Cursor único por participante: `(lastReadCreatedAt,lastReadMessageId)`, atualizado na mesma linha/transaction do participante. **Não criar** tabela paralela `internet_leituras`.
- Não lida = mensagem posterior ao cursor na ordenação `(createdAt,id)`, desconsiderando mensagens do próprio autor.
- Envio exige `requestId` e persiste `payloadHash` (SHA-256 do payload canônico, NFC-normalizado).
- Constraint: `UNIQUE(conversationId,authorContaId,requestId)`.
- Mesmo requestId + mesmo hash: replay idempotente, devolver a mensagem existente (`replay:true`), sem segunda gravação.
- Mesmo requestId + hash diferente: `uso_conflito`, sem mutação.
- P8 aprovado: limitar cada mensagem a 4.000 caracteres e cada conta a 20 mensagens por minuto. Aplicar e validar os limites no servidor, com resposta estável de rate limit.

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

- **Leitura/envio normais:** mensagens diretas e de grupo são lidas/enviadas pelos participantes ativos com gate válido. Bloqueio, saída ou revogação impede novas entregas conforme a autorização atual; não se presume acesso apenas por conhecer um ID.
- **P10 — leitura pelo mestre (decisão aprovada):** um usuário com membership ativa e papel `mestre` pode ler o conteúdo das conversas privadas (diretas e em grupo) dos personagens daquela mesma campanha, mesmo quando não participa da conversa. Esse acesso é **somente leitura**, limitado à campanha em que exerce o papel de mestre e não autoriza enviar, editar, remover participantes ou gerir a conversa sem ser participante. A permissão de leitura do mestre deve ser um caminho de autorização separado do gate de titularidade da conta; não reutilizar nem ampliar o acesso ao inventário/conta. Cada leitura privilegiada — incluindo abertura e paginação do histórico — deve gerar registro de auditoria com ator, campanha, conversa, momento e operação. Não há acesso entre campanhas.
- **ADMIN global:** não recebe automaticamente o privilégio de leitura do mestre. A decisão P10 concede acesso ao papel de mestre na própria campanha, não ao administrador global.
- **P9 — exportações (decisão aprovada):** nenhuma mensagem ou conteúdo de conversa privada pode ser incluído em qualquer exportação, nem mesmo quando o próprio titular solicitar exportação de suas conversas. A regra vale para export comum da campanha e para export individual/privado. Não implementar uma exceção de portabilidade por usuário.
- **Backup técnico:** backup/snapshot operacional não é exportação de campanha e deve preservar os dados necessários à recuperação íntegra do banco. O ciclo de retenção/expiração dos backups deve ser compatível com P13 e o procedimento de restore não pode reintroduzir mensagens já expiradas no ambiente restaurado.
- **P12 — histórico após bloqueio/remoção/arquivamento (decisão aprovada):** preservar o histórico existente. Bloquear novas mensagens quando houver bloqueio e permitir ocultar a conversa da lista conforme a ação do usuário; ocultar não significa apagar conteúdo. A remoção de contato, saída ou arquivamento não apaga automaticamente o histórico antes do prazo de retenção.
- **P13 — retenção (decisão aprovada em princípio; parâmetro pendente):** deve existir um prazo fixo de retenção e as mensagens devem ser apagadas automaticamente ao completar esse prazo. **O número exato de dias/meses ainda não foi informado pelo proprietário**; não inventar um valor nem ativar/implementar o job de expurgo antes de essa duração ser definida. A implementação deverá aplicar o prazo de modo consistente também ao ciclo de backup/restore, para evitar ressuscitar mensagens expiradas.
- **P7 — transferência de personagem (decisão aprovada):** a conta e o histórico acompanham o personagem. A transferência exige confirmação explícita e deve registrar um evento de sistema/auditoria. O novo titular só recebe acesso conforme a transferência confirmada e a autorização vigente; a trilha deve identificar a transferência sem expor conteúdo a quem ainda não tem direito de acesso.


## 8. Matriz de autorização proposta

| Ator/estado | Criar/gerir conta própria | Gerir contatos | Ler/enviar conversa | Acesso a conversa alheia |
|---|---:|---:|---:|---:|
| Dono de personagem + membership ativa + papel jogador/mestre + gate elegível | Sim | Sim, no escopo aprovado | Sim, se participante ativo | Não |
| Jogador ativo sem personagem/conta elegível | Não | Sem conta, não | Não | Não |
| Mestre ativo da campanha | Conta própria somente se titular e elegível | Conforme conta própria | Sim, se participante ativo | **Sim, somente leitura de conversas privadas da própria campanha**, conforme P10/§7; sem gerir/enviar se não for participante |
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

## 10. Decisões do proprietário — respostas registradas

Em 26/11/2026, o proprietário respondeu expressamente às decisões P1–P13. As escolhas abaixo são decisões de produto aprovadas; não devem ser substituídas pelas recomendações técnicas anteriores.

| ID | Decisão aprovada pelo proprietário | Estado |
|---|---|---|
| P1 | Opt-in; uma conta por personagem; NPCs não precisam de conta na 1.1.1 | **APROVADO** |
| P2 | Contatos e conversas separados por campanha; sem escopo global | **APROVADO** |
| P3 / G2 | Bloqueio bilateral: bloquear em uma direção impede a comunicação nos dois sentidos | **APROVADO** |
| P4 / G3 | Convite para grupo exige contato aceito e conta ativa/elegível na mesma campanha | **APROVADO** |
| P5 / G4 | Criar conta somente após cumprir os requisitos de habilidade e dispositivo adequado, usando o gate canônico | **APROVADO** |
| P6 | Ao sair o proprietário do grupo, transferir a propriedade para outro membro elegível | **APROVADO** |
| P7 / B7 | A conta e o histórico acompanham o personagem, com confirmação e registro da transferência | **APROVADO** |
| P8 / D4 | Limite de 4.000 caracteres por mensagem e 20 mensagens por minuto | **APROVADO** |
| P9 | Nunca incluir mensagens privadas em exportações, nem mesmo quando solicitadas pelo próprio titular | **APROVADO** |
| P10 | O mestre pode ler as mensagens privadas dos personagens da própria campanha | **APROVADO** — leitura somente dentro da campanha e registrada em auditoria; ADMIN global não herda essa permissão |
| P11 | Perfil público mínimo; presença e indicador de digitação desligados por padrão | **APROVADO** |
| P12 | Preservar o histórico; bloquear novas mensagens ou ocultar a conversa da lista conforme a ação | **APROVADO** |
| P13 | Definir um prazo fixo de retenção e apagar mensagens após esse prazo | **APROVADO EM PRINCÍPIO** — falta informar a duração exata |

### Único parâmetro ainda pendente

O proprietário aprovou a existência de retenção fixa com expurgo automático, mas **não especificou quantos dias/meses**. A equipe não pode inventar essa duração. O job de expurgo e a regra temporal de exclusão ficam bloqueados até o número exato ser definido; as demais regras P1–P12 e o desenho geral de P13 estão aprovados.

### Salvaguardas decorrentes das decisões

- A leitura do mestre é um privilégio separado, somente leitura, limitado à campanha em que ele tem membership ativa com papel `mestre`, e auditado por operação. Não concede acesso cross-campanha nem poder de gestão da conversa.
- ADMIN global não recebe leitura privilegiada por extensão.
- Mensagens privadas não entram em nenhuma exportação; backup técnico continua preservando o banco para recuperação, respeitando expiração/restore compatível com a retenção aprovada.
- Nenhuma mensagem deve ser apagada antes da duração de retenção que vier a ser definida.


## 11. Plano de implementação após aceite

1. PAI mantém as decisões P1–P12 aprovadas neste contrato; o único parâmetro em aberto é a duração exata da retenção P13. Não solicitar novamente ao proprietário respostas já registradas.
2. INTERMEDIÁRIO revisa independentemente as decisões e especialmente as salvaguardas P9/P10, a matriz de autorização e o único parâmetro pendente P13.
3. Após a revisão, F2/F3/F4/F5/F6 podem implementar as regras aprovadas P1–P12 e a estrutura geral de retenção. A rotina de expurgo temporal P13 permanece desativada/fora do código executável até o proprietário informar a duração exata.
4. Migrações aditivas/idempotentes; testes em banco limpo e upgrade v1.1.0; concorrência, replay, revogação e backup/restore.
5. Cada implementação usa branch/PR pequena contra a main vigente, CI natural no SHA final, sem SKIP silencioso e sem editar workflow protegido.
6. Release somente após gates de #348 e autorização expressa do proprietário.

## 12. Pareceres e trilha de auditoria

- PAI v3: comentário #349 `7175640361` — gate específico de conta e defaults G2/G3/G4 propostos.
- INTERMEDIÁRIO: revisão suplementar #349 `7176128568` — corrige aresta de contato, fonte única do cursor, idempotência e valida o fan-out sem room de conteúdo.
- PAI: reconciliação F1×F2 #350 `7176550876`.
- INTERMEDIÁRIO: parecer final F1×F2×F3 #349 `7176869671` — **PASS técnico** na reconciliação.
- Plano realtime corrigido pelo PAI #351 `7175636585` — fan-out individual por usuário, revalidação a cada entrega, sem sala compartilhada de conteúdo.

**Status atual:** contrato tecnicamente coerente e revisado (PASS). Decisões do proprietário P1–P12 registradas e aprovadas; P13 aprovada quanto à retenção fixa/expurgo, com duração exata pendente. A equipe pode avançar nas regras aprovadas; não implementar/ativar expurgo antes do prazo exato. Nenhuma escolha aprovada pode ser reinterpretada.
