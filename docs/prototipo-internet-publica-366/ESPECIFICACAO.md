# Internet pública — especificação UX/F2 (#366)

**Status**: **UX aprovada pela revisão adversarial** (INTERMEDIÁRIO #366 —
2 rodadas incorporadas) e alinhada ao threat model #367 e à proposta de
domínio #365. **Segue Draft de produto**: PR #371 permanece draft até o Dono
Técnico fechar o contrato v2.2. **Quiz 1–20 do proprietário (26/11)
incorporados** — decisões respondidas marcadas DECIDIDAS na matriz §6;
restantes seguem proposta.
**HEAD da spec**: `b1079aa`+ (branch `docs/366-ux-internet-publica`, PR #371).
**Protótipo navegável**: [`index.html`](./index.html) (wireframe, dados ilustrativos, sem backend).
**Suplemento DP-1…DP-9**: [`SUPLEMENTO-DECISOES-DP.md`](./SUPLEMENTO-DECISOES-DP.md) — fechamento UX dependente das decisões de produto (ordem Dono 14:44).
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
| W1 | Explorar — Início | Rede → Explorar | Barra de pesquisa global, **diretório de sites da campanha** (D2 decidido), notícias em destaque, anúncios recentes — **prévia/contagem só do que o leitor pode ver** | `[contrato]` índice de sites/notícias/anúncios |
| W2 | Pesquisa | W1 (campo) ou sub-aba Pesquisa | Escopo: Tudo · Páginas · Notícias · Classificados · Perfis; resultados agrupados; estado sem resultado | `[contrato]` endpoint de busca + escopo |
| W3 | Página/Site | W1 atalhos, W2 resultado, link interno | Menu do site, conteúdo, "voltar" para origem | `[contrato]` estrutura site/página |
| W4 | Notícias — lista | Explorar → Notícias | Matérias com fonte, autor, data, escopo; **notícia automática de morte** com selo próprio — **definição proposta no contrato v2.5**: evento único `__morte` (chave reservada server-managed), gatilhos HP≤0 e declaração do mestre; pendente deliberação da escolha mecânica | `[contrato]` v2.5 |
| W5 | Matéria | W4 | Corpo, fonte, autoria, data, escopo de visibilidade; matéria automática de morte + **matéria derivada por jornalista** (gatilho = `__morte`, contrato v2.5) | `[contrato]` v2.5 |
| W6 | Classificados — lista | Explorar → Classificados | Filtro por categoria, validade/estado, autoria | `[contrato]` |
| W7 | Anúncio — detalhe | W6 | Conteúdo, autor, validade, estado (ativo/expirado/removido), ações permitidas | `[contrato]` |
| W8 | Publicar (anúncio/notícia/post) | W6/W4/W9 ("Publicar") | Formulário + **prévia** + **declaração de público por publicação** (`campanha`\|`contatos` — D1/D2 decididos) visível na criação **e** na edição; **seletor de identidade do autor** (verdadeira padrão / pseudônimo / anônimo — **anônimo só em `classificado`/`anuncio`**, notícia/post/páginas exigem fonte — DP-6 recomendação PAI v2.4, pendente deliberação); anônima publicada = **imutável**; marca o que exige autorização do mestre | `[contrato]` + regra de moderação |
| W9 | Perfil público | Explorar → Perfil (o próprio) ou resultado de busca | **Opcional** — Internet funciona sem perfil. Ativado: nome público, avatar, descrição (nome do personagem é padrão, alternativo permitido, edição livre); **ativação irreversível** — aviso inequívoco antes, zero controles de ocultar/desativar/excluir depois; permanece após a morte. **Publicações anônimas não aparecem no perfil para terceiros** (autoria omitida — QA v2.7 D2); para o próprio autor aparecem marcadas "anônima" | `[contrato]` |
| W10 | Ativação de perfil | W9 ("Ativar perfil público") | Aviso permanente irrevogável + confirmação única; depois disso o perfil passa a existir publicamente | `[contrato]` |
| W11 | Investigação jornalística | W4/W5 (matéria automática de morte) ou Explorar → Notícias | Acionada por jornalista elegível sobre matéria/notícia: lança teste do RPG real, mostra **resultado do teste + informações obtidas** — **sem aviso de que informação retornada é falsa**; repetição só com novas pistas/evidências/justificativa. **Resolvido no contrato v2.4**: `resultadoPct` é calculado por resolvedor determinístico sobre o lançamento persistido (`rolls.results` + `tests.target`), **independente do outcome narrativo**; exibe **% de confiabilidade diegética** ("informação fragmentada", "relato consistente") — nunca "verdade/falso"; a informação falsa é sorteada entre publicações **já visíveis** ao investigador (zero oráculo: alvo sem acesso → "informação insuficiente"). **Ressalva INTERMEDIÁRIO (não-bloqueante)**: a semântica exata — publicação real apresentada como pista vs. texto fabricado — ficou ambígua no contrato v2.4 e nesta spec; o que está garantido é o escopo `visivel` + zero oráculo. Definição de conteúdo fecha no spec de implementação | `[contrato]` mecânica real (Caçadores & Caçados — sem classe/perícia paralela) |

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
| Conteúdo removido/expirado | **Distinção de acesso legítimo (anti-enumeração)**: quem tinha acesso prévio vê estado honesto — **ex-leitor recebe só `disponibilidade` ("removido"/"expirado"), SEM motivo de moderação** (QA v2.7 B6); **autor vê motivo** (B9); mestre lê tudo auditado (B10). Quem **nunca** teve acesso recebe **404 diegético seco**. O contrato carrega o flag "visível-antes" vs "nunca-visível" |
| Sem permissão para publicar | Ação visível mas desabilitada **com motivo** ("publicar exige autorização do mestre" — se a regra exigir) |
| Pesquisa sem resultado | Estado vazio específico + sugestão de ampliar escopo. Resultado nunca vaza existência de conteúdo oculto (anti-enumeração V-02: "não existe" e "existe mas oculto" respondem igual) |
| Conteúdo restrito (`contatos`) para não-contato | **Invisível por completo**: não aparece em busca, prévias, contagens, timelines nem no agregado do perfil — sem placeholder, sem "conteúdo restrito aqui". Site/perfil do autor **existem e são descobríveis** normalmente; só o conteúdo restrito some (decisão Quiz 2) |
| Perfil inativo (padrão) | W9 mostra estado "perfil público não ativado" + CTA de ativação; **todo o resto do Explorar funciona** (publicar, pesquisar, ler) — perfil é opcional |
| Ativação de perfil (W10) | Aviso inequívoco: "ativado, o perfil fica **permanentemente público** — não pode ser ocultado, desativado ou apagado" + confirmação única. **Nenhum** controle de ocultar/desativar/excluir existe depois — a UI não desenha affordance que a regra proíbe |
| Perfil após morte do personagem | Perfil e publicações **permanecem** (decisão Quiz); estado indica "personagem falecido". Morto = existe ocorrência `__morte` **sem `revertidaEm`** (contrato v2.6 — `__morte` é array de épocas). **Ressurreição** (DP-8 recomendação v2.6): ação mestre auditada marca `revertidaEm` na ocorrência ativa, preserva histórico e **não retira** a notícia — correção de causa = nova publicação (DP-9), nunca sobrescrita; perfil reabre escrita após reversão | **Pendente DP-4/DP-5**: recomendação convergente PAI+INTERMEDIÁRIO = perfil de morto **somente-leitura** (fecha TN-04); perfil segue o **personagem** (`characterId`) — novo titular herda junto com autoria (simetria P7) — spec assume leitura até deliberação |
| Publicação anônima | W8 oferece identidade anônima **só nos tipos que permitem**; após publicada, anônima é **imutável** — sem editar, sem apagar (UI desabilita com motivo) |
| Personagem morto tentando publicar | Escrita bloqueada **server-side** (perfil, publicações, conta em modo escrita) mesmo com sessão válida — UI mostra motivo "personagem falecido"; leitura segue permitida |
| Denúncia → remoção | Conteúdo publicado pode ser denunciado; denúncia pode acionar **remoção automática pelo sistema**; autor vê estado "removido". **Contestação é resolvida por administrador da plataforma — não pelo Mestre**. **Pendente DP-3**: limiar de auto-remoção — recomendação convergente **≥2 denúncias distintas OU 1 + flag `denunciaGrave`** (threshold=1 é abuso trivial) |
| Notícia automática de morte | Matéria gerada pelo sistema com selo "automática" — gatilho `avaliarMorte` unificado (HP→0, declaração do mestre, ou importação — v2.6); **uma notícia por evento de morte** `(characterId, ocorrencia.em)` — morte→ressurreição→nova morte gera **nova notícia**; `causa` sanitizada ou genérica "morte por dano" | jornalista elegível pode derivar matéria própria a partir dela (W11) |
| Investigação (W11) | Mostra resultado do teste + **% de confiabilidade diegética** + informações obtidas; **nunca** sinaliza quais informações são falsas; alvo sem acesso → "informação insuficiente" (não "não encontrado"); repetição bloqueada sem novas evidências (`evidenciaRef`, 409) |
| Perdeu o dispositivo (gate revogado) | **Ler** conteúdo já publicado segue permitido (publicação é fato consumado — D-B do threat model); **editar/publicar** fica bloqueado pelo gate vigente, com motivo |

## 4. Matriz tela × estado × papel × ação

Papeis: **J** = jogador (personagem elegível), **M** = mestre, **E** =
espectador. Pela proposta #365, leitura pública exige conta Internet +
gate do leitor (`personagemAutorizadoInternet`) — logo **E não acessa o
Explorar** (sem conta/dispositivo); o "read-only" do espectador na matriz
do PAI aplica-se a contextos onde haja sessão autorizada, não à camada
pública via dispositivo. Escrita pública: J e M publicam; M adicionalmente
**retira** conteúdo alheio (moderação P10), nunca edita.

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
| W7 Anúncio | ativo | ✓ | ✓ | "Contatar" **somente** via fluxo de contato existente (aresta dirigida + aceite + bloqueio P3); se bloqueado, estado honesto sem vazar o bloqueio — ver D9 |
| W7 | expirado/removido — acesso legítimo prévio | ✓ | ✓ | Tela de estado com contexto (data/motivo quando público; motivo ao autor) |
| W7 | expirado/removido — nunca visível ao requisitante | ✓ | ✓ | **404 diegético** idêntico a inexistente (anti-enumeração V-02) |
| W8 Publicar | formulário | ✓* | ✓ | Preencher → prévia → confirmar |
| W8 | prévia | ✓* | ✓ | Revisar + trocar visibilidade antes de confirmar |
| W9 Perfil | próprio — inativo | ✓ | ✓ | CTA "Ativar perfil público" → W10 |
| W9 | próprio — ativo | ✓ | ✓ | Editar nome público/avatar/descrição (edição livre); **sem** ocultar/desativar/excluir |
| W9 | de outro personagem | ✓ | ✓ | Somente leitura conforme escopo; perfil inexistente = 404 diegético |
| W10 Ativação | aviso irrevogável | ✓ | ✓ | Ler aviso → confirmar uma vez → perfil passa a existir |
| W11 Investigação | disponível | ✓* | ✓ | Jogar teste do RPG → ver resultado + informações obtidas |
| W11 | repetição sem novidade | ✓* | ✓ | Bloqueada com motivo ("precisa de novas pistas/evidências") |

\* `J` só atua como jornalista se a elegibilidade for decidida — **D8
permanece proposta** (ver §6). A UI mostra a ação desabilitada com motivo
quando não permitida.

## 5. Recomendações de experiência

1. **Um único "Explorar"** com sub-navegação interna (Início/Pesquisa/Notícias/
   Classificados/Perfil) em vez de 5 sub-abas de primeiro nível — evita
   poluição e segue o padrão já homologado.
2. **Barra de pesquisa sempre visível** no topo do Explorar (não escondida em
   sub-aba) — é o gesto principal da camada pública.
3. **Publicar sempre com prévia + declaração de visibilidade** antes de
   confirmar; o que depende de mestre aparece marcado *antes* do envio, não
   como erro depois.
4. **Conteúdo indisponível é estado de tela — com fronteira de acesso.**
   Expirado/removido mostram aviso dedicado apenas a quem tinha acesso
   legítimo prévio (autor, mestre da campanha, ou já público para ele);
   para quem nunca teve acesso, 404 diegético seco — a tela de estado
   jamais vaza existência + estado de moderação (anti-enumeração, §6.1).
5. **Perfis são somente-leitura para terceiros** na 1.1.2; edição do próprio
   perfil fica na sub-área Perfil com os campos que o contrato autorizar.
6. **Favoritos e histórico: adiar.** Não há justificativa de produto ainda;
   adicionar depois é incremental sem quebrar a navegação.
7. **Classificados é quadro de avisos** (publicar/consultar/expirar) — a
   negociação/empresas é 1.1.3; a UI não deve sugerir ações de transação.
8. Reutilizar tokens/estados da F4 (`estilos-internet.css`, `abas.tsx`,
   `estados.tsx`) — zero linguagem visual nova.

## 6. Matriz de decisões D1–D13

Ordem do Dono Técnico (#366): tabela única com pergunta, opções reais,
recomendação, impacto no wireframe e o que bloqueia. **D1–D6 são herdadas
do contrato #365 (PAI)** — a UX registra apenas o impacto visível; **D7–D13
são decisões de UX/produto**. Duplicidades eliminadas: "personagem sem
conta acessa?" e "leitura anônima?" foram absorvidas por **D5** (gate em
tudo ⇒ sem conta/anônimo não acessa); "o que o perfil exibe" + "displayName
na busca" fundidas em **D10**; "moderação" + "motivo ao autor" fundidas em
**D7**; "quem cria sites" + "quem publica notícias" fundidas em **D8**.

| # | Origem | Pergunta | Opções reais | Recomendação | Impacto no wireframe | Bloqueia |
|---|--------|----------|--------------|--------------|----------------------|----------|
| D1 | PAI #365 | ~~Escopo "público": só campanha ou entre campanhas/servidor?~~ **DECIDIDO 26/11 (Quiz 1): fronteira entre campanhas ABSOLUTA — escopo = campanha** | — | campanha-only, definitivo | W8 seletor fixo `campanha\|contatos`; W2 sem escopo cross-campaign | — (decidido) |
| D2 | PAI #365 | ~~Sites visíveis a todos da campanha ou só a contatos?~~ **DECIDIDO 26/11 (Quiz 2, escolha A): sites descobríveis por TODOS os elegíveis da campanha; `contatos` restringe publicações individuais** | — | todos — diretório lista sites; perfil/site existe sem expor publicações restritas | W1 diretório de sites; W3/W9 existem mesmo sem publicações visíveis ao leitor | — (decidido) |
| D3 | PAI #365 | Histórico de edições de página: `version`+audit ou tabela de revisões/rollback? | a) version+audit b) revisions | a) adiar revisions (fatía A) | W3/W8 "versões anteriores" só existe se b) | Tabela nova se b) |
| D4 | PAI #365 | ~~Bio de perfil: coluna ou publicação fixada?~~ **DECIDIDO (Quiz): perfil exibe descrição editável** — implementa como campo do perfil | — | campo `descricao` no perfil | W9 campo descrição; edição livre | — (decidido) |
| D5 | PAI #365 | Todo endpoint público exige gate do leitor (conta Internet + dispositivo)? | a) gate em tudo b) discovery aberto | a) gate em tudo — **absorve** "sem conta acessa?" e "anônimo?" (sem conta = sem gate = sem acesso) | Todo o Explorar atrás do gate; estado "sem conta" já especificado | Regra de autorização |
| D6 | PAI #365 | Incluir tabelas públicas no export/backup P9? | a) sim b) não | a) sim (conteúdo diegético ≠ comunicação privada) | Nenhum impacto visual — registrado p/ completude | Contrato de export |
| D7 | UX | ~~Moderação~~ **DECIDIDO (Quiz): publicação livre + denúncia → remoção automática pelo sistema; contestação resolvida por administrador da plataforma — NÃO pelo Mestre.** Só admin da plataforma consulta identidade anônima em moderação excepcional (sem justificativa obrigatória, sem trilha de auditoria — escolha do proprietário) | — | — | W8 publica direto; ação "Denunciar" em conteúdos; estado removido; **sem** fila de aprovação, **sem** papel do mestre na contestação | Fluxo de denúncia/contestação |
| D8 | UX | Quem publica o quê + **elegibilidade para jornalista** (matéria derivada de notícia automática de morte)? | a) tudo livre p/ elegível b) notícias/fontes só mestre c) jornalista exige elegibilidade própria | **PARCIAL**: identidade do autor por tipo decidida (verdadeira padrão; pseudônimo/anônimo conforme tipo; anônima imutável). **Segue proposta**: elegibilidade de jornalista e restrições por tipo de publicação | W8 seletor de identidade; W11 ação de investigação; selo de fonte | Permissões de escrita; W11 |
| D9 | UX | Anúncio permite "Contatar"? | a) sim, via fluxo de contato existente b) não c) canal direto | a) — aresta dirigida + aceite + bloqueio P3; se bloqueado, estado honesto sem vazar o bloqueio | W7 ação Contatar | Ação de W7 |
| D10 | UX | ~~O que o perfil público exibe?~~ **DECIDIDO (Quiz): perfil OPCIONAL; exibe só nome público + avatar + descrição; nome do personagem é padrão, alternativo permitido; edição livre; ativação IRREVERSÍVEL (aviso inequívoco, sem ocultar/desativar/excluir); permanece após morte; utilizável sem perfil** | — | — | W9/W10 conforme §3; W2 indexa perfil só se ativado | — (decidido) |
| D11 | UX | Anúncio tem prazo? Quem remove? | a) expiração opcional pelo autor + remoção por autor/mestre b) prazo fixo c) sem expiração | a) `expiresAt` opcional (já no modelo); `expirado` derivado, sem job | W6 chip "expirado"; W8 campo validade; W7 estado | `meta.expiresAt` (já previsto) |
| D12 | UX | Pesquisa indexa o quê e com que escopo default? | a) título+páginas+notícias+anúncios+perfis(handle) b) +displayName c) só publicações | a) conforme contrato v1 (`titulo`+`handle`+`nome`), filtro por visibilidade do leitor no SQL; `displayName` fora do índice (depende de D10) | W2 escopos e agrupamento de resultados | Quase respondida pelo contrato — confirmar |
| D13 | UX | Sites têm navegação própria (menu) ou são páginas soltas? | a) menu derivado das páginas publicadas b) editor de menu c) sem navegação | a) menu simples derivado; sem editor de menu na fatia | W3 menu do site | W3 |

**Definição de "morte" — RESOLVIDA (contrato v2.6, PAI; APROVADO INTERMEDIÁRIO)**: `characters.data.__morte` como array de épocas (chave reservada, não forjável), avaliador único `avaliarMorte` cobrindo HP→0, declaração do mestre e importação, dedup por `(characterId, ocorrencia.em)`. Requisitos INTERMEDIÁRIO incorporados: ressurreição não apaga fato (notícia fica, correção = nova publicação), `causa` sanitizada, somente-leitura enforced server-side, `__morte` viaja no P7. **Contrato v2.6**: avaliador único `avaliarMorte` cobre todos os write paths de `__hp` (inclusive importação); `__morte` = array de épocas com `revertidaEm`; trava somente superfícies Internet (mesa/chat/economia fora do corte). **DP-8/DP-9** com recomendações explícitas pendentes de deliberação: reversão preserva histórico+notícia; causa enriquecida só por nova publicação.

**Pendências registradas (parecer #367 + pacote PAI v2.4)**: DP-2 prazo contestação (recomendação 7 dias); DP-3 limiar denúncia (recomendação ≥2 distintas ou 1+`denunciaGrave`); DP-4 perfil segue personagem; DP-5 perfil de morto somente-leitura; DP-6 anonimato só em classificado/anúncio; DP-7 avatar via pipeline `arquivos` existente; DP-8 mestre perde retirada preventiva; `pseudoNome` de publicação × `displayName` de perfil — W8 usa campo próprio, não `displayName`. **Resolvido v2.4**: `resultadoPct` determinístico sobre o lançamento, independente do outcome narrativo; informação falsa = sorteio entre publicações visíveis ao investigador (zero oráculo).

**Outras decisões Quiz 1–20 já incorporadas** (sem pergunta aberta de UX):
identidade verdadeira como padrão com pseudônimo/anônimo conforme tipo de
publicação; publicação anônima **imutável** após publicar; denúncia →
remoção automática pelo sistema; contestação e consulta a identidade
anônima **só por administrador da plataforma** (não pelo Mestre; sem
justificativa obrigatória e sem trilha de auditoria — escolha do
proprietário); notícia **automática de morte** + matéria derivada por
jornalista; investigação mostra resultado do teste do RPG e informações
obtidas **sem revelar quais são falsas**, com repetição só mediante novas
pistas/evidências/justificativa; princípio de implementação — digitalizar
regras de *Caçadores & Caçados*, sem mecânica paralela de jornalismo.

## 6.1 Alinhamento com o threat model #367 (checkpoint INTERMEDIÁRIO)

Restrições de segurança que a UX deve **refletir**, não contornar:

- **Anti-enumeração (V-01/V-02)**: id/termo de conteúdo oculto responde igual a inexistente — a UI nunca mostra "existe mas você não pode ver". **Inclui a tela de estado**: o aviso honesto de "expirado/removido" só se aplica a quem tinha acesso legítimo prévio; para quem nunca teve acesso é 404 seco — o contrato carrega o flag "visível-antes" vs "nunca-visível" (requisito de API, não só de UX).
- **Fronteira de escopo (D1)**: se a pesquisa/listagens cruzarem campanhas, o modelo de visibilidade muda de natureza — deliberar **D1** antes do fechamento do contrato; default seguro = escopo por campanha.
- **Visibilidade atômica (V-03)**: retirado/expirado some de lista, busca e perfil no mesmo instante — estados "em atualização" transitórios não devem prometer conteúdo.
- **Autoria server-side (V-05)**: o formulário de publicar **não** tem campo de "publicar como" — autoria é sempre a conta autenticada; se o contrato um dia permitir agirem por terceiros, a UX precisará de seletor explícito.
- **Conteúdo público × gate (V-04/D-B)**: publicação já feita sobrevive à perda do dispositivo; edição/rascunho exige gate vigente — a UI separa "ler" de "editar" em affordances distintas.
- **Perfil mínimo (V-08)**: W9 exibe handle + displayName + publicações — nunca userId, e-mail, dados OOC ou campos de ficha. `displayName` livre pode conter dado pessoal → aviso no formulário (depende de D10).
- **Links externos (V-07/D-D)**: se permitidos, sempre `noopener noreferrer` e nunca `javascript:`/`data:` — a prévia do W8 deve renderizar links como texto até a decisão.

## 6.2 Alinhamento com a proposta de domínio #365 (PAI, checkpoint 1)

O modelo proposto (`internet_sites` + `internet_pages` + `internet_publicacoes` tipado) é compatível com W1–W9. Deltas que a UX reflete:

- **`visibilidade = campanha | contatos`** (proposta): W8 ganha o seletor com esses dois escopos; "contatos" = aresta aceita vigente + sem bloqueio P3 na hora da leitura. Isso resolve a maior parte de **D1** dentro da campanha — a deliberação remanescente é apenas "entre campanhas/servidor?" (default seguro: não).
- **`post_perfil`**: W9 passa a ter timeline de publicações do autor, não só identidade.
- **Ciclo `rascunho|publicado|retirado|expirado|arquivado`**: `expirado` é derivado de `expiresAt` (sem job); `arquivado` é terminal de site/página — W3/W7 tratam como indisponível com a mesma fronteira de acesso legítimo. Rascunho responde 404 a não-autores (já coberto pela regra anti-enumeração).
- **Moderação mestre**: mestre retira publicação/página alheia mas **não edita** — para o autor, "retirado" pode vir de moderação; **D7** (motivo visível ao autor) ganha o caso "retirado pelo mestre".
- **HTTP-only**: a proposta não usa socket para a camada pública — leituras são request/response. O estado "reconectando" se aplica a escritas e à experiência geral do módulo; não há expectativa de tempo real em listas públicas.
- **Pesquisa v1 = LIKE/prefixo** em `titulo`+`handle`+`nome` (FTS5 adiado): W2 assume busca simples; o escopo "Perfis" indexa handle (P11) — displayName só com opt-in (D10).
- **Edição de página publicada → `version+1`**: W8/W3 assumem que editar conteúdo publicado cria nova versão; se o Dono exigir histórico/rollback (decisão **D3** do PAI — heredada), a UX precisará de "versões anteriores" — sinalizado, não especificado.
- **Slug público** (`/sites/:slug/p/:pageSlug`): URLs são adivinháveis por natureza — reforça que a fronteira "visível-antes vs nunca-visível" do §3 é requisito de contrato, não detalhe.
- **Transferência P7**: autoria via `characterId` é estável — sites/páginas/posts acompanham o personagem transferido sem migração; W9 não muda.

## 7. Congelamento independente de decisões

Partes da experiência que **não dependem** de nenhuma das 13 decisões e
podem ser congeladas já (wireframe + contratos de leitura estáveis):

- **Navegação "Explorar"**: sub-área dentro da aba Rede, sub-navegação APG
  (`abas.tsx`), "voltar" preservando contexto — estrutura W1–W9.
- **Barra de pesquisa sempre visível** no topo do Explorar e estados de
  resultado (sem resultado, erro+retry).
- **Casca de listas/detalhes**: W4/W5 (notícias), W6/W7 (classificados) —
  layout, filtros de categoria, paginação por cursor, chips de estado.
- **Estados honestos**: loading/aria-busy, vazio com CTA diegético, erro de
  GET com retry, 404 diegético, banner de reconexão — e a **fronteira
  visível-antes vs nunca-visível** (requisito de contrato já sinalizado).
- **Gate e papéis**: Explorar atrás do gate de conta/dispositivo; leitura
  por qualquer conta elegível; escrita separada de leitura.
- **Tokens/estados visuais**: reuso integral de `estilos-internet.css`,
  `abas.tsx`, `estados.tsx` — zero linguagem nova.
- **Responsividade**: layouts mobile/desktop do wireframe.
- **Com as decisões Quiz 1–20**: W9/W10 (perfil opcional, ativação
  irrevogável, campos nome público/avatar/descrição), seletor de
  identidade por tipo no W8, publicação anônima imutável, notícia
  automática de morte com selo, fluxo de denúncia/remoção automática.

**NÃO congelável** (depende de deliberação): elegibilidade de jornalista
e permissões por tipo de publicação (D8 residual), ação "Contatar" (D9),
campo de validade de anúncio (D11), escopo/índice da pesquisa (D12),
menu do site (D13), e histórico de edições de página (D3).

## 8. O que NÃO está proposto

- Nenhuma tela de empresa/vaga/trabalho (1.1.3), NPC autônomo ou automação de IA.
- Nenhuma mistura com chat OOC — todo conteúdo é diegético, dentro do módulo
  do personagem.
- Nenhuma mudança na camada privada (Mensagens/Conta) nem no comércio
  (Lojas/Vender/Pedidos).
- Nenhum componente implementado — o `index.html` é wireframe estático.
