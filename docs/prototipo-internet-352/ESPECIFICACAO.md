# Internet diegética — especificação UX/F4 (#352)

**Status**: proposta para revisão — implementação só após contratos F1/F2/F3 aprovados.
**Protótipo navegável**: [`index.html`](./index.html) (wireframe, dados ilustrativos, sem backend).
**Referência de contrato**: proposta F1 v3 (#349, comentários `7175640361`/`7176552898`) — arestas de contato dirigidas, cursor de leitura em `internet_participantes`, gate `contaAutorizadaPara` exigindo membership ativa + papel mestre/jogador (espectador fora — hotfix #356/#357).

## 1. Mapa de telas

| # | Tela | Entrada | Conteúdo |
|---|------|---------|----------|
| S1 | Gate do dispositivo | Aba Personagens → detalhe → Internet | Reuso do gate canônico v1.1.0 (fail-closed). Negado: motivos reais (sem dispositivo, sem conectividade/perícia, acesso revogado) |
| S2 | Conta / identidade | Internet → aba "Conta" | @handle, perfil visível a contatos (nome do personagem, status) |
| S3 | Contatos | Internet → aba "Mensagens" → sub-abas | Contatos aceitos, pedidos recebidos/enviados, bloqueados; ação "+ Adicionar por @handle" |
| S4 | Caixa de entrada | Default da aba Mensagens | Conversas privadas e grupos, badge de não lidas, preview, ordenação por atividade |
| S5 | Conversa privada | Caixa → thread | Bolhas, timestamps, estados de envio, composer diegético |
| S6 | Grupo | Caixa → thread de grupo; S3 → detalhes | Criação (nome + contatos aceitos), membros, sair, renomear/remover (criador) |
| S7 | Histórico de pedidos (existente) | Aba "Histórico" | Commerce inalterado — fora do escopo de mensagens |

Abas do módulo Internet passam de 3 (Lojas/Vender/Histórico) para incluir **Mensagens** e **Conta** — proposta de navegação a confirmar com o Dono (pode virar sub-navegação dentro de uma única aba "Rede").

## 2. Estados obrigatórios (todos no protótipo)

| Estado | Tratamento |
|--------|-----------|
| Loading | Esqueleto + `aria-busy`, sem spinner bloqueante |
| Vazio | CTA diegético ("troque @handle…"), nunca jargão de sistema |
| Erro de GET | Mensagem honesta + "Tentar novamente"; conteúdo anterior preservado; 403 `internet_indisponivel` volta ao gate com motivo real |
| Sem dispositivo | Gate existente — cartão negado com motivo; aba Mensagens nem renderiza |
| Sem acesso à Internet | Segundo motivo do gate (dispositivo ok, sem conectividade/perícia) |
| Reconectando | Banner discreto + composer desabilitado; histórico legível; resync por invalidação no `connect` |
| Mensagem não enviada | Bolha permanece com ✗ + "Tentar novamente"/"Descartar"; reenvio com novo requestId (idempotência F1) |

## 3. Ações e confirmações

- **Sempre com confirmação modal**: bloquear contato, remover contato, cancelar pedido enviado, sair de grupo, remover membro de grupo, descartar mensagem longa.
- **Sem confirmação**: enviar mensagem, aceitar pedido (reversível), renomear grupo (criador).
- **Adição a grupo**: somente contatos com aresta `aceito` — espelha a regra de backend; a UI desabilita não-contatos com tooltip explicativo.

## 4. Regra visual diegético × OOC (explícita)

1. **Local**: mensagens diegéticas vivem exclusivamente no módulo Internet do personagem (abas Mensagens/Conta). O chat OOC permanece no painel da Mesa — nenhum componente compartilhado renderiza os dois.
2. **Identidade visual**: chip `diegético` (verde) vs `OOC` (roxo) nas superfícies onde a distinção importa; bolhas diegéticas nunca aparecem na Mesa e vice-versa.
3. **Semântica**: composer diegético usa placeholder de fala do personagem ("Escrever mensagem…"), reforçando que o texto é do personagem.
4. **Privacidade de notificação**: nenhuma notificação OOC cita conteúdo diegético; push/toast do app não revela existência de conversas (o indicador de não-lidas fica dentro do módulo).
5. **Mestre**: não lê conversas por padrão (contrato F1) — a UI não oferece "ver como mestre".

## 5. Acessibilidade

- Teclado: tabs com `role="tablist"`/`aria-selected` (padrão já usado em Internet.tsx); foco visível em todos os botões; ordem de tab = ordem visual.
- Leitor de tela: bolhas com `aria-label` contextual ("mensagem sua"/"de Lyra Stormwind, 21:40"); estado "não enviada" anunciado; `aria-live="polite"` só para novas mensagens recebidas na thread aberta (não para a lista inteira).
- Movimento reduzido: sem animações de entrada de bolha; transições desligadas sob `prefers-reduced-motion` (herda a fundação #132).
- Mobile (390px): lista de conversas ocupa a tela; thread abre em tela cheia com "Voltar"; composer fixo acima do teclado virtual.

## 6. Componentes/arquivos propostos (reservar pontos de integração)

```
site/src/paginas/Internet.tsx            — nova aba "mensagens"/"conta" (gate já existente)
site/src/paginas/internet/
  Mensagens.tsx                          — caixa + roteador de thread
  Contatos.tsx                           — S3
  Conversa.tsx                           — S5 (privada) e S6 (grupo, prop modo)
  ContaInternet.tsx                      — S2
site/src/api-internet.ts (ou extensão de api.ts) — somente após contrato F2
```

Socket: reusa `entrar-internet`/salas `internet:{cid}:{charId}` existentes; eventos de mensagem entram pelo plano F3 (#351) — **nenhum tipo/socket alterado nesta fase**.

## 7. Decisões de privacidade ainda abertas (sinalizadas no protótipo)

- **Perfil público**: o que `Conta` expõe além do nome do personagem (status online? personagem vinculado?). Default conservador: só @handle + nome do personagem.
- **Histórico pós-bloqueio**: bloquear apaga a thread dos dois lados ou só impede novas mensagens? (F1 define `bloqueado` bilateral de facto; UX precisa da regra de exibição.)
- **Indicador de digitação/presença**: recomendo **não** ter — vaza atividade; confirmação do proprietário.
- **Mestre em emergência**: se o mestre precisar moderação, deve ser via auditoria backend, nunca leitura na UI.

## 8. Fora de escopo (limites respeitados)

Sem segundo chat OOC, sem duplicar painel da Mesa, sem fetch simulado, sem alteração de API/socket/types, sem redesign geral.
