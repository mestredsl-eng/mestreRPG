# Suplemento UX — decisões DP-1…DP-9 (#366, contrato v2.6)

**Status**: documentação de fechamento — PR #371 permanece **Draft**.
**Base**: `ESPECIFICACAO.md` @ `4e08cb8` + contrato v2.6 (#365, APROVADO
INTERMEDIÁRIO) + pacote de deliberação DP-1…DP-9 v2.7 do PAI (#365,
14:58 — recomendações idênticas às aqui descritas) + matriz de QA (#369). Nenhuma tela paralela; tudo dentro do
módulo Rede → Explorar, reutilizando `abas.tsx`, `estados.tsx`,
`estilos-internet.css`.

## 1. Matriz DP → superfícies UX afetadas

| DP | Tema | Estado | Telas/controles/estados que mudam conforme a decisão |
|----|------|--------|------------------------------------------------------|
| **DP-1** | Trilha de desanonimização admin | **DECIDIDA (fechada)** | Nenhuma superfície nova. A consulta excepcional de identidade anônima é backend/admin plataforma — **a UI do jogador nunca exibe** que houve consulta, justificativa ou auditoria. Wireframe não desenha nada |
| **DP-2** | Prazo de contestação | Recomendação PAI v2.7 **(a) 7 dias** | W7/W5: estado "removido" do autor ganha contador "contestar até DD/MM"; após o prazo, ação some. Se prazo for outro, só o número muda — estrutura congelável |
| **DP-3** | Limiar de auto-remoção | Recomendação PAI v2.7 **(a) ≥2 denúncias distintas OU 1+`denunciaGrave`** | Contador de denúncias **nunca** visível ao autor (anti-oráculo). Afeta apenas o tempo até "removido pelo sistema" aparecer — UX idêntica, timing diferente |
| **DP-4** | Perfil segue o personagem (`characterId`) | Recomendação PAI v2.7 **(a)** | W9/W10 após transferência P7: perfil migra com o personagem; novo titular herda edição. Se decidisse "segue conta", W9 mostraria perfil órfão — **recomendo a opção do contrato** |
| **DP-5** | Perfil de morto somente-leitura | Recomendação PAI v2.7 **(a)** (converge INTERMEDIÁRIO, fecha TN-04) | W9 de morto: campos de edição **desabilitados com motivo** "personagem falecido"; publicações do morto não editáveis/apagáveis pelo titular. Leitura normal |
| **DP-6** | Tipos com anonimato | Recomendação PAI v2.7 **(a): `classificado`+`anuncio` sim; `noticia`, `post_perfil`, páginas não** | W8: opção "Anônimo" aparece **somente** quando o tipo selecionado permite; nos demais tipos o seletor nem renderiza a opção (não é disabled — é ausente, pois a regra é do tipo, não do usuário). `pseudoNome` é campo próprio da publicação, não `displayName` do perfil |
| **DP-7** | Avatar via pipeline `arquivos` | Recomendação PAI v2.7 **(a)** | W10/W9: campo avatar = upload pelo pipeline existente (mesma moderação/ownership dos arquivos); estados de upload (enviando/erro/tamanho) reutilizam componentes de arquivo já homologados |
| **DP-8** | Reversão de morte (ressurreição) | Recomendação PAI v2.7 **(a)** (v2.6) | W9: após reversão auditada, perfil **reabre escrita**; estado "personagem falecido" some; notícia antiga **permanece** (fato consumado); correção de causa = nova publicação, nunca edição retroativa |
| **DP-9** | Causa enriquecida pós-morte | Recomendação PAI v2.7 **(a)** (v2.6) | Não cria tela nova: mestre publica **nova** matéria/notícia complementando a causa; a notícia automática original não é editável por ninguém |

**Observação INTERMEDIÁRIO (DP-8 dele, proposta distinta)**: "mestre perde
retirada preventiva" — coerente com o fluxo atual (denúncia→remoção
automática→contestação admin plataforma). Se o dono mantiver retirada
preventiva do mestre, W7/W3 ganham ação "retirar" para o papel M — sinalizado
como dependência de deliberação, não implementado.

## 2. Decidido × recomendação — resumo de bloqueio

| Item | Estado |
|------|--------|
| DP-1 trilha admin | **DECIDIDA** — sem UI |
| DP-2 prazo contestação | Recomendação 7d — muda só número no W7/W5 |
| DP-3 limiar denúncia | Recomendação ≥2/1+grave — muda só timing, não layout |
| DP-4 perfil→personagem | Recomendação contrato — afeta W9 pós-P7 |
| DP-5 morto somente-leitura | Recomendação convergente — afeta W9/W8 |
| DP-6 anonimato por tipo | Recomendação — afeta seletor W8 |
| DP-7 avatar pipeline | Recomendação — afeta W10/W9 |
| DP-8 reversão morte | Recomendação v2.6 — afeta W9 |
| DP-9 causa pós-morte | Recomendação v2.6 — sem tela nova |

**Decisões que bloqueiam o congelamento dos wireframes**: DP-2 (número no
estado de contestação), DP-5 (campos editáveis vs. somente-leitura no W9 de
morto), DP-6 (presença da opção Anônimo no W8 por tipo). DP-3, DP-4, DP-7,
DP-8, DP-9 têm recomendação convergente e **não mudam estrutura** — podem
congelar com a recomendação e ajustar número/regra depois.

## 3. Matriz de estados — denúncia/contestação/remoção (contrato v2.6)

Máquina de estados do contrato: `aberta → auto_removida → contestado →
em_analise_admin → resolvida_admin | encerrada`. O que cada papel vê:

| Estado | Leitor comum | Autor do conteúdo | Denunciante | Admin plataforma |
|--------|--------------|-------------------|-------------|------------------|
| `aberta` (denúncia registrada, conteúdo no ar) | Nada muda — sem contador, sem aviso | Nada visível | "denúncia recebida" | Fila de moderação |
| `auto_removida` | Conteúdo some (lista/busca/perfil no mesmo instante — V-03); acesso direto = 404 se nunca visível / estado honesto se já visível | "removido pelo sistema" + prazo de contestação (DP-2) + CTA "Contestar" | Notificação de resolução parcial | — |
| `contestado` | Idem removido | "em contestação" + protocolo | — | Em análise |
| `em_analise_admin` | Idem | "em análise pela administração" | — | Fila prioritária |
| `resolvida_admin` (mantida a remoção) | Permanece indisponível; estado honesto para quem tinha acesso | "remoção confirmada" — fim | — | Fecha caso |
| `resolvida_admin` (revertida) | Conteúdo **volta** ao ar | "contestado aceito — conteúdo restaurado" | — | Fecha caso |
| `encerrada` (sem contestação no prazo) | Permanece removido | "removido — prazo de contestação encerrado" | — | — |

**Regras de UI transversais**: limite de 3 contestações por conta/recurso
(excesso → estado "limite atingido" com motivo); reversão só se não houver
contra-denúncia; todo o fluxo é diegético — "admin plataforma" aparece como
"administração da plataforma", nunca como "mestre".

## 4. Matriz de estados — perfil de morto/ressuscitado

| Estado | W9 (próprio) | W9 (terceiros) | W8 publicar |
|--------|---------------|----------------|-------------|
| Ativo | Editar nome público/avatar/descrição | Leitura + timeline visível ao leitor | Normal |
| Falecido (`__morte` ativa) | Somente leitura + selo "personagem falecido" (DP-5) | Leitura + selo; conteúdo permanece | **Bloqueado server-side** — motivo "personagem falecido" |
| Ressuscitado (ocorrência revertida) | Edição reabre; histórico de mortes preservado internamente | Leitura normal; notícia antiga permanece | Normal |
| Nova morte (2ª época) | Somente leitura de novo | Nova notícia automática gerada (dedup por evento) | Bloqueado de novo |

Avatar (DP-7): upload pelo pipeline `arquivos` — mesmos estados de
upload/erro/permissão dos anexos existentes; sem pipeline novo.

## 5. Anonimato por tipo (DP-6) — comportamento do W8

| Tipo de publicação | Opções de identidade renderizadas |
|--------------------|-----------------------------------|
| `classificado`, `anuncio` | Identidade real · Pseudônimo · **Anônimo** |
| `noticia`, `post_perfil`, páginas de site | Identidade real · Pseudônimo — **sem Anônimo** |

- Anônimo publicado = **imutável** (sem editar/apagar — UI desabilita com
  motivo, não esconde).
- `pseudoNome` é campo da publicação; `displayName` é do perfil — nunca
  confundir na UI (nota INTERMEDIÁRIO).
- Consulta de identidade anônima: **inexistente para jogador** (DP-1
  fechada) — nem mestre vê; só admin plataforma, fora da UI do módulo.

## 6. Responsividade, teclado e ARIA (spec de estados)

Breakpoints do wireframe/protótipo: **390px** (mobile), **768px** (tablet),
**desktop**. Regras:

- **390px**: `.dupla`/grid de estados colapsa para coluna única; tablists
  do Explorar mantêm roving tabindex com setas ←/→ + Home/End (APG já
  homologado); alvos de toque ≥44px; prévia do W8 empilha abaixo do
  formulário.
- **768px**: duas colunas em estados; formulário W8 lado a lado
  (campos | prévia) quando couber.
- **Desktop**: layout do wireframe atual.
- **Teclado/foco**: ordem de tab = DOM; foco visível ≥3:1 (padrão #132 já
  homologado); modais de confirmação (denunciar, ativar perfil, publicar)
  prendem foco e anunciam `role="alertdialog"`; estados de erro usam
  `role="alert"` + texto honesto + ação "Tentar novamente".
- **Leitores de tela**: estados assíncronos anunciam via `aria-live`
  (padrão `estados.tsx`); contadores de paginação keyset anunciam
  "carregando mais"; nunca depender só de cor para estado (chip + texto).

## 7. Rastreabilidade — tela/ação → contrato v2.6 → vetores QA

| Tela/ação | Contrato v2.6 | Vetor QA (#369) |
|-----------|---------------|------------------|
| W1 diretório de sites | sites `ativo` visíveis a elegíveis da campanha | isolamento campanha (TN-01) |
| W8 seletor `campanha\|contatos` | `visibilidade` por publicação; filtro `visivel(leitor)` na query | V-01/V-02 anti-enumeração |
| W8 identidade real/pseudo/anônimo | `pseudoNome` por publicação; anonimato por tipo (DP-6) | V-05 autoria, V-08 perfil |
| W8 anônima imutável | status terminal para edição do autor | V-03 atomicidade |
| W9 ativação irrevogável | perfil opcional, permanente, pós-morte | DP-4/DP-5 |
| W9 morto somente-leitura | `__morte` enforce server-side | TN-04, V-04 |
| W10 aviso irrevogável | ativação sem undo | — |
| W11 investigação | `resultadoPct` determinístico; `informacaoFalsa` interna; `evidenciaRef` | V-02 oráculo, TN-07 |
| Denúncia/contestação | máquina `aberta→…→resolvida_admin` | V-03 remoção atômica |
| Notícia automática de morte | gatilho `avaliarMorte`; dedup `(characterId,em)` | TN-08, P7 |
| 404 vs estado honesto | flag "visível-antes" do contrato | V-02 oráculo de existência |
| Avatar upload | pipeline `arquivos` existente | — |

## 8. O que NÃO muda com as DP

Congelável independente de DP-2..DP-9 (já listado em §7 da spec): navegação
Explorar/APG, barra de pesquisa, cascas W4–W7, estados honestos base,
gate+papéis, tokens, responsividade. As DP afetam **conteúdo e timing de
estados**, não a arquitetura de navegação.
