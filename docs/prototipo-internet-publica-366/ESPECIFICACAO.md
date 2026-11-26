# Internet pública — especificação UX/F2 (#366)

**Status**: proposta para revisão — fase read-only/especificação da Release #364.
**Protótipo navegável**: [`index.html`](./index.html) (wireframe, dados ilustrativos, sem backend).
**Bases analisadas**:
- Visual/módulo: `feat/352-internet-f4` @ `6d2e565` (Internet diegética 1.1.1 — módulo "Rede", homologado 124/124 sobre backend `0607f40`)
- Documentação de contrato 1.1.1: `docs/prototipo-internet-352/ESPECIFICACAO.md` (branch `docs/352-prototipo-internet`)
- Doc do módulo atual: `site/src/paginas/Internet.tsx` + `site/src/paginas/internet/*` @ `6d2e565`

> Nada aqui implementa componentes, chama API nova ou altera a tela atual. Toda
> funcionalidade depende de contrato backend que **não existe ainda** — a spec
> marca cada dependência como `[contrato]` para a frente #365 (PAI) e #367
> (INTERMEDIÁRIO) deliberarem.

## 1. Onde a camada pública mora (proposta de navegação)

O módulo Internet hoje tem 4 abas (`Lojas | Vender | Pedidos | Rede`) e a aba
"Rede" abriga a camada privada (`Mensagens | Conta`, com sub-navegação
`Caixa de entrada | Contatos`).

**Proposta**: a camada pública entra como **terceira sub-área dentro da aba
"Rede"**, ao lado de Mensagens e Conta — sub-aba **"Explorar"**:

```
Internet (personagem elegível)
└─ aba "Rede"
   ├─ Mensagens          (privado — existe)
   ├─ Explorar           (público — NOVO)
   │   ├─ Início         (busca global + atalhos + destaques)
   │   ├─ Pesquisa       (resultados por escopo)
   │   ├─ Notícias       (lista → matéria)
   │   ├─ Classificados  (lista → detalhe → publicar)
   │   └─ Perfil         (presença pública do personagem)
   └─ Conta              (existe)
```

**Justificativa**: mantém um único ponto de entrada diegético (o dispositivo →
personagem → Internet), não cria aba de primeiro nível nova na campanha, e
reutiliza o padrão APG de sub-abas já homologado (`abas.tsx`). Alternativa
registrada: aba de primeiro nível "Web" — rejeitada por fragmentar a
identidade do módulo e por já existir gate único por dispositivo.

Navegação interna do "Explorar" usa o mesmo `role="tablist"` + roving tabindex
já implementado; "voltar" de página/site retorna à lista de origem (não à
raiz), preservando contexto de pesquisa/filtro via estado local.

## 2. Mapa de telas

| # | Tela | Entrada | Conteúdo | Dependência |
|---|------|---------|----------|-------------|
| W1 | Explorar — Início | Rede → Explorar | Barra de pesquisa global, sites/atalhos da campanha, notícias em destaque, anúncios recentes | `[contrato]` índice de sites/notícias/anúncios |
| W2 | Pesquisa | W1 (campo) ou sub-aba Pesquisa | Escopo: Tudo · Páginas · Notícias · Classificados · Perfis; resultados agrupados; estado sem resultado | `[contrato]` endpoint de busca + escopo |
| W3 | Página/Site | W1 atalhos, W2 resultado, link interno | Menu do site, conteúdo, "voltar" para origem | `[contrato]` estrutura site/página |
| W4 | Notícias — lista | Explorar → Notícias | Matérias com fonte, autor, data, escopo | `[contrato]` |
| W5 | Matéria | W4 | Corpo, fonte, autoria, data, escopo de visibilidade | `[contrato]` |
| W6 | Classificados — lista | Explorar → Classificados | Filtro por categoria, validade/estado, autoria | `[contrato]` |
| W7 | Anúncio — detalhe | W6 | Conteúdo, autor, validade, estado (ativo/expirado/removido), ações permitidas | `[contrato]` |
| W8 | Publicar (anúncio/notícia/post) | W6/W4/W9 ("Publicar") | Formulário + **prévia** + seletor de visibilidade; marca o que exige autorização do mestre | `[contrato]` + regra de moderação |
| W9 | Perfil público | Explorar → Perfil (o próprio) ou resultado de busca | Identidade do personagem, publicações, escopo do perfil | `[contrato]` |

**Favoritos/histórico**: incluídos como *opcionais* na spec — só se o contrato
justificar persistência por conta. Recomendação: **adiar** (ver §5).

## 3. Estados obrigatórios (reuso dos componentes homologados)

Todos reutilizam `EstadoCarregando` (aria-busy), `EstadoVazio` (CTA diegético),
`ErroRetry`, banner de reconexão e gate de dispositivo já existentes na F4:

| Estado | Tratamento proposto |
|--------|---------------------|
| Loading | Esqueleto/aria-busy por seção; nunca spinner bloqueante |
| Vazio | CTA diegético ("ainda não há anúncios nesta categoria…") |
| Erro de GET | Mensagem honesta + Tentar novamente; conteúdo anterior preservado |
| Offline/reconectando | Banner "Reconectando…" (padrão já existente); leitura liberada, ações de publicação desabilitadas |
| Sem dispositivo | Gate existente — Explorar nem renderiza |
| Sem conta | Vazio diegético (mesmo padrão de Mensagens) |
| Conteúdo removido/expirado | Tela dedicada honesta: "este anúncio não está mais disponível" + data de expiração quando houver; **nunca** 404 cru nem conteúdo residual. **Distinção autor×leitor** (threat model V-07/D-E): o autor vê que seu conteúdo foi retirado **com motivo**; terceiros veem apenas indisponível |
| Sem permissão para publicar | Ação visível mas desabilitada **com motivo** ("publicar exige autorização do mestre" — se a regra exigir) |
| Pesquisa sem resultado | Estado vazio específico + sugestão de ampliar escopo. Resultado nunca vaza existência de conteúdo oculto (anti-enumeração V-02: "não existe" e "existe mas oculto" respondem igual) |
| Perdeu o dispositivo (gate revogado) | **Ler** conteúdo já publicado segue permitido (publicação é fato consumado — D-B do threat model); **editar/publicar** fica bloqueado pelo gate vigente, com motivo |

## 4. Matriz tela × estado × papel × ação

Papeis: **J** = jogador (personagem elegível), **M** = mestre, **E** =
espectador (fora do gate — não vê a aba Rede).

| Tela | Estado | J | M | Ação principal |
|------|--------|---|---|----------------|
| W1 Início | ok | ✓ | ✓ | Buscar, abrir atalho, ver destaques |
| W1 | vazio (sem sites/notícias) | ✓ | ✓ | CTA "sua campanha ainda não tem páginas" |
| W1 | erro/offline | ✓ | ✓ | Retry; banner reconexão |
| W2 Pesquisa | ok | ✓ | ✓ | Filtrar por escopo, abrir resultado |
| W2 | sem resultado | ✓ | ✓ | Ampliar escopo / limpar filtros |
| W2 | erro | ✓ | ✓ | Retry |
| W3 Página | ok | ✓ | ✓ | Navegar links internos, voltar |
| W3 | removida/404 diegético | ✓ | ✓ | "Página indisponível" + voltar |
| W4/W5 Notícias | ok | ✓ | ✓ | Ler matéria |
| W4/W5 | vazia/erro | ✓ | ✓ | Vazio honesto / retry |
| W6 Classificados | ok | ✓ | ✓ | Filtrar, abrir detalhe |
| W6 | vazio por filtro | ✓ | ✓ | Limpar filtro |
| W7 Anúncio | ativo | ✓ | ✓ | Contatar? (ver dúvida D6) |
| W7 | expirado/removido | ✓ | ✓ | Somente leitura do aviso de estado |
| W8 Publicar | formulário | ✓* | ✓ | Preencher → prévia → confirmar |
| W8 | prévia | ✓* | ✓ | Revisar + trocar visibilidade antes de confirmar |
| W9 Perfil | próprio | ✓ | ✓ | Editar campos permitidos, ver publicações |
| W9 | de outro personagem | ✓ | ✓ | Somente leitura conforme escopo |

\* `J` só publica se a regra da campanha permitir — ver dúvida D1. A UI mostra
a ação desabilitada com motivo quando não permitida.

## 5. Recomendações de experiência

1. **Um único "Explorar"** com sub-navegação interna (Início/Pesquisa/Notícias/
   Classificados/Perfil) em vez de 5 sub-abas de primeiro nível — evita
   poluição e segue o padrão já homologado.
2. **Barra de pesquisa sempre visível** no topo do Explorar (não escondida em
   sub-aba) — é o gesto principal da camada pública.
3. **Publicar sempre com prévia + declaração de visibilidade** antes de
   confirmar; o que depende de mestre aparece marcado *antes* do envio, não
   como erro depois.
4. **Conteúdo indisponível é estado de tela**, não erro: expirado/removido
   mostram aviso dedicado com contexto (data, motivo quando público).
5. **Perfis são somente-leitura para terceiros** na 1.1.2; edição do próprio
   perfil fica na sub-área Perfil com os campos que o contrato autorizar.
6. **Favoritos e histórico: adiar.** Não há justificativa de produto ainda;
   adicionar depois é incremental sem quebrar a navegação.
7. **Classificados é quadro de avisos** (publicar/consultar/expirar) — a
   negociação/empresas é 1.1.3; a UI não deve sugerir ações de transação.
8. Reutilizar tokens/estados da F4 (`estilos-internet.css`, `abas.tsx`,
   `estados.tsx`) — zero linguagem visual nova.

## 6. Dúvidas de produto (afetam UX, não são decisões tomadas)

| # | Dúvida | Impacto na UX |
|---|--------|---------------|
| D1 | Publicação é livre ou exige aprovação do mestre? Pré-moderação ou denúncia+pós? | Define se W8 mostra "enviado para análise" ou publica direto; se ação fica desabilitada para jogador |
| D2 | Escopo de visibilidade: só dentro da campanha ou entre campanhas/servidor? | Define o seletor de visibilidade do W8 e o escopo da pesquisa |
| D3 | Quem cria sites/páginas — só mestre ou qualquer personagem? | Define se "Novo site" aparece para jogador |
| D4 | Notícias: qualquer personagem publica ou só fontes oficiais? | Define W8 para notícias e o rótulo de fonte |
| D5 | O que o perfil público exibe — nome do personagem, bio, publicações, nada? | Define W9 e o que a busca indexa de perfil |
| D6 | Anúncio permite contato direto (link para conversa privada existente)? | Se sim, W7 ganha ação "Contatar" reutilizando Mensagens |
| D7 | Anúncio tem prazo padrão? Quem remove (autor, mestre, expiração automática)? | Define estados de W7 e o formulário de W8 |
| D8 | Pesquisa indexa o quê — tudo que o personagem pode ver, ou só conteúdo "público"? | Define escopo default e honestidade dos resultados |
| D9 | Sites têm navegação própria (menu do site) ou são páginas soltas? | Define W3 |
| D10 | Personagem sem conta Internet acessa a camada pública? (hoje conta é pré-requisito do módulo) | Define se Explorar fica atrás do mesmo gate de conta |
| D11 | Leitura pública **sem login** existe? (ator anônimo — threat model D-A) | Se sim, é superfície fora do módulo do personagem; esta spec assume sempre autenticado |
| D12 | `displayName` livre pode conter dado pessoal real — indexar na busca global só com opt-in? (V-08) | Define o que W2 indexa de perfis e o aviso no formulário de perfil |
| D13 | Autor vê o próprio conteúdo retirado com motivo? (V-07/D-E — recomendo sim) | Define o estado "removido" do ponto de vista do autor em W7/W9 |

## 6.1 Alinhamento com o threat model #367 (checkpoint INTERMEDIÁRIO)

Restrições de segurança que a UX deve **refletir**, não contornar:

- **Anti-enumeração (V-01/V-02)**: id/termo de conteúdo oculto responde igual a inexistente — a UI nunca mostra "existe mas você não pode ver".
- **Visibilidade atômica (V-03)**: retirado/expirado some de lista, busca e perfil no mesmo instante — estados "em atualização" transitórios não devem prometer conteúdo.
- **Autoria server-side (V-05)**: o formulário de publicar **não** tem campo de "publicar como" — autoria é sempre a conta autenticada; se o contrato um dia permitir agirem por terceiros, a UX precisará de seletor explícito.
- **Conteúdo público × gate (V-04/D-B)**: publicação já feita sobrevive à perda do dispositivo; edição/rascunho exige gate vigente — a UI separa "ler" de "editar" em affordances distintas.
- **Perfil mínimo (V-08)**: W9 exibe handle + displayName + publicações — nunca userId, e-mail, dados OOC ou campos de ficha. `displayName` livre pode conter dado pessoal → aviso no formulário (depende de D12).
- **Links externos (V-07/D-D)**: se permitidos, sempre `noopener noreferrer` e nunca `javascript:`/`data:` — a prévia do W8 deve renderizar links como texto até a decisão.

## 7. O que NÃO está proposto

- Nenhuma tela de empresa/vaga/trabalho (1.1.3), NPC autônomo ou automação de IA.
- Nenhuma mistura com chat OOC — todo conteúdo é diegético, dentro do módulo
  do personagem.
- Nenhuma mudança na camada privada (Mensagens/Conta) nem no comércio
  (Lojas/Vender/Pedidos).
- Nenhum componente implementado — o `index.html` é wireframe estático.
