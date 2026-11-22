# Issue #65 — matriz de escopos e guards de autorização

> Documento de auditoria arquitetural pós-v1. Não altera schema, migrations, rotas ou comportamento.
> A matriz separa explicitamente os três escopos que não podem ser confundidos:
> membership de campanha, GM de guilda e ADMIN global.

## Escopos normativos

| Escopo | Identidade de autorização | O que NÃO concede |
|---|---|---|
| ADMIN global | `users.is_admin = 1` e conta ativa | Não concede automaticamente papel de mestre/jogador/espectador em uma campanha; não substitui vínculo de GM em guilda |
| Guilda / GM | vínculo de membro da guilda com papel GM e conta ativa | Não concede acesso a campanhas sem membership; não concede ADMIN global |
| Campanha | `memberships` da campanha, papel `mestre`, `jogador` ou `espectador`, status ativo e permissões granulares | Não concede gestão de guilda nem administração da plataforma |
| Sessão multiplayer | membership de campanha válida + participante autorizado da sessão | Não altera o papel persistido da campanha nem o papel de GM da guilda |

## Regras de decisão

1. **Fail-closed:** ausência de usuário, status inativo, vínculo ausente ou papel incompatível deve negar.
2. **Escopo mínimo:** cada rota deve consultar apenas o escopo necessário para a ação.
3. **Não herança implícita:** ADMIN não vira GM; GM não vira mestre; mestre não vira ADMIN.
4. **Revalidação no ponto de escrita:** verificações feitas antes de UPDATE/DELETE não substituem predicados atômicos ou transação.
5. **Revogação imediata:** remoção/bloqueio de conta ou membership deve impedir novas ações e eventos de socket do escopo revogado.
6. **Resposta uniforme:** falhas de autorização não devem revelar existência de recursos de outro escopo.

## Mapeamento auditado na árvore atual da main

| Área | Guard/checagem observada | Escopo correto | Risco residual a acompanhar |
|---|---|---|---|
| Rotas de campanha | membership + papel/status da campanha | Campanha | Corridas em alterações de papel/status exigem UPDATE condicional |
| Convites de campanha/guilda | emissor autorizado + alvo válido + status | Campanha ou Guilda, conforme rota | Não aceitar convite como prova de membership até aceite persistido |
| Rotas de guilda | vínculo de guilda + papel GM + conta ativa | Guilda | Não reutilizar guard de campanha |
| Rotas ADMIN | `is_admin` + status da conta | ADMIN global | Não ampliar para operações de campanha sem checagem adicional |
| Patrimônio | permissões granulares da campanha + papel efetivo | Campanha | UI deve refletir a mesma matriz usada pelo servidor |
| Socket da Mesa | sessão + membership + papel + filtro do destinatário | Sessão/Campanha | Revogação deve remover acesso a todos os eventos, não apenas VTT |
| Sessões | membership de campanha e estado da sessão | Sessão/Campanha | Criação/alteração deve permanecer atômica |
| Ficha/personagem | vínculo com campanha + visibilidade do campo | Campanha/Ficha | Não vazar campos ocultos por mensagens de validação |

## Checklist obrigatório para novas rotas da Issue #65

- [ ] Identificar explicitamente o escopo da rota.
- [ ] Informar o guard/função de autorização reutilizado.
- [ ] Confirmar que ADMIN, GM e membership de campanha não são tratados como equivalentes.
- [ ] Testar usuário sem vínculo.
- [ ] Testar usuário com vínculo em outro escopo.
- [ ] Testar conta bloqueada/inativa.
- [ ] Testar tentativa de IDOR por `userId`, `guildId`, `campaignId` e `sessionId`.
- [ ] Testar revogação concorrente durante a escrita.
- [ ] Testar que eventos Socket.IO não continuam chegando após revogação.
- [ ] Registrar se a rota exige transação ou UPDATE condicional.

## Lacunas preparadas para a próxima fatia de implementação

A próxima fatia segura deve ser uma suíte negativa de autorização, sem migration:

1. Matriz de casos para ADMIN global, GM de guilda e membership de campanha.
2. Verificação de que um usuário com papel válido em um escopo não atravessa para outro.
3. Cenários HTTP e Socket.IO para revogação durante a operação.
4. Critério de aceite: nenhum caso de IDOR/elevação de privilégio retorna sucesso ou dados privados.

Este documento não declara que todos os guards atuais foram provados por execução local; ele registra o contrato arquitetural e as áreas que precisam de testes direcionados.