# Contrato — Publicações da Internet pública (W4/W5 + W8 subset)

**Issue:** #365 (F1/6 — Internet pública) · **Ordem:** checkpoint operacional W4/W5 (`7229145994`) · **Base:** `main@d8221ec` (W1/W3 leitura + W3 escrita mergeados)
**Status:** proposta de implementação — consolidando decisões já fechadas (v2.x + DP-1…DP-9 + D1/D2/D6/D12 + SITE-12) em contrato executável. Itens `[PROPOSTA]` exigem deliberação antes do código.

## 1. Escopo desta fatia

| Entrega | Telas | Conteúdo |
|---|---|---|
| `internet_publicacoes` | W4 lista, W5 matéria, W8 subset | Tipos `noticia` e `post_perfil`. `post_perfil` liga-se ao personagem/conta **via `autor_conta_id → internet_accounts.character_id`** — não existe coluna `perfil_id` no schema atual nem nesta migração; o perfil público (W9/W10) é vitrine derivada, não alvo de FK (§6.1) |
| Notícia automática de morte | W4/W5 selo | DP-8/DP-9 + contrato v2.6: `characters.data.__morte` epochs + `avaliarMorte` único |
| Denúncias/remoção | moderação | `internet_denuncias` + máquina `aberta→auto_removida|resolvida_admin` (DP-2/DP-3) |
| **Fora desta fatia** | W6/W7 (anúncio/classificado), W9/W10 (perfil), W11 (investigação), W2 (busca multi-escopo) | tabelas já previstas; endpoints próprios em fatias seguintes |

## 2. Schema — migração `0044` (aditiva)

```sql
CREATE TABLE internet_publicacoes (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES campaigns(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('noticia','post_perfil','anuncio','classificado')),
  titulo TEXT NOT NULL,
  corpo TEXT NOT NULL,               -- markdown-subset (mesmo validador de páginas)
  formato TEXT NOT NULL DEFAULT 'markdown',
  status TEXT NOT NULL DEFAULT 'rascunho'
    CHECK (status IN ('rascunho','publicado','retirado','removido')),
  visibilidade TEXT NOT NULL DEFAULT 'campanha'
    CHECK (visibilidade IN ('campanha','contatos')),
  autor_modo TEXT NOT NULL DEFAULT 'identificado'
    CHECK (autor_modo IN ('identificado','pseudonimo','anonimo')),
  pseudo_nome TEXT,                  -- obrigatório sse autor_modo='pseudonimo'
  autor_conta_id TEXT REFERENCES internet_accounts(id),  -- NULL só p/ origem='sistema'
  origem TEXT NOT NULL DEFAULT 'usuario' CHECK (origem IN ('usuario','sistema')),
  fonte_ref TEXT,                    -- ex.: noticia_id derivada / personagem alvo (morte)
  personagem_id TEXT REFERENCES characters(id),  -- alvo da matéria de morte (sistema)
  publicado_em INTEGER,              -- epoch ms; NULL em rascunho
  retirado_em INTEGER, retirado_motivo TEXT,
  denuncia_aberta INTEGER NOT NULL DEFAULT 0,
  denuncia_grave INTEGER NOT NULL DEFAULT 0,   -- ≥1 denunciaGrave ⇒ auto-remoção (DP-3)
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
-- dedup de notícia de morte é por (personagem_id, __morte[].em) em avaliarMorte (§5),
-- não por índice — uma nova morte após revertidaEm gera nova notícia.
CREATE INDEX internet_publicacoes_feed_idx
  ON internet_publicacoes (campaign_id, tipo, status, publicado_em DESC);

CREATE TABLE internet_denuncias (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  publicacao_id TEXT NOT NULL REFERENCES internet_publicacoes(id),
  denunciante_conta_id TEXT NOT NULL REFERENCES internet_accounts(id),
  motivo TEXT NOT NULL,
  denuncia_grave INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'aberta'
    CHECK (status IN ('aberta','contestada','em_analise','auto_removida','resolvida_admin','encerrada')),
  resolucao TEXT, resolvido_por TEXT,            -- user id admin plataforma (não mestre)
  prazo_contestacao_em INTEGER,                  -- DP-2: 7 dias a partir de auto_removida
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX internet_denuncias_uma_conta_idx
  ON internet_denuncias (publicacao_id, denunciante_conta_id);  -- 1 denúncia por conta/publicação
```

`characters.data.__morte` (chave reservada server-managed, v2.6): array de epochs
`[{em, causa?, revertidaEm?}]` — dedup por `(characterId, ocorrencia.em)`.
`avaliarMorte` é o **único** avaliador, chamado em todo caminho de escrita de `__hp`
(inclusive importação e dedup), não só na rota de vida.

## 3. Autoria e visibilidade (predicados fechados)

- `visivel(publicacao, leitor)` = `status='publicado'` ∧
  (`visibilidade='campanha'` ∨ leitor tem aresta de contato aceita vigente com o autor
  identificado ∧ sem bloqueio P3 na hora da leitura) ∧ campanha do leitor = `campaign_id`.
  Fronteira entre campanhas é **absoluta** (D1) — cross-campaign ⇒ 404 idêntico a inexistente.
- `contatos` **nunca** aparece em busca, prévia, contagem, timeline ou agregado (Quiz 2);
  só leitura direta autorizada. Site/perfil do autor seguem descobríveis.
- Anonimato (DP-6): só `classificado`/`anuncio` — nesta fatia **todo tipo entregue exige
  `autor_modo ∈ {identificado, pseudonimo}`**; `anonimo` → 400 (aceito no schema p/ fatias W6/W7).
  Publicação anônima (futuro) = imutável: sem PATCH/DELETE do autor.
- Autoria server-side: `autor_conta_id`/`origem`/`publicado_em` gravados pelo servidor,
  nunca do body. Pseudônimo validado: **charset do handle** `[A-Za-z0-9._-]`
  com caixa preservada para exibição (não é handle — não é lowercased nem
  único), comprimento próprio 2–60.
- **D8 — gate `profissao:jornalista` (fechado, NEWS-04/05):** `tipo='noticia'` publicado
  por personagem-jogador exige `profissao:jornalista` resolvido **server-side**: valor em
  campo `regraKind='profissao'` da estrutura da ficha do personagem, conferido por
  `extrairEscolhas` contra a definição ativa do ruleset da campanha — nunca label/body do
  cliente. Revalidado na transição rascunho→publicado (regraset alterado fecha o gate).
  `post_perfil` **não** exige (conteúdo de perfil, não matéria jornalística). Mestre
  publica independente da profissão (decisão C). Profissão é **somente elegibilidade** —
  nunca valor de teste/rolagem, nunca atributo/perícia paralela.
- **Pseudônimo em toda superfície:** feed, detalhe e qualquer agregado exibem `pseudoNome`
  quando `autor_modo='pseudonimo'` — handle, `autorContaId` e identidade real **nunca**
  aparecem para leitores não privilegiados. `autorContaId`/`version` só na resposta
  privilegiada (autor/mestre) do detalhe.

## 4. Endpoints (montados em `internet-escrita.ts` + `internet-publica.ts`)

Router autenticado (escrita, mesmo padrão W3: papel → `contaAutorizadaPara` → titularNaTx
in-tx → gate P5 por mutação → `limiteUsuario` cota de mutações cometidas → `expectedVersion`):

| Método/rota | Regra |
|---|---|
| `POST /publicacoes` | tipos `noticia`\|`post_perfil`; `visibilidade` **obrigatória** no body (declaração W8); **sempre nasce `rascunho`** — não existe `statusInicial`; gate P5 + D8 (`noticia` por jogador ⇒ `profissao:jornalista`); mestre sem conta elegível publica com `autor_conta_id=NULL`; rate limit idem W3 |
| `PATCH /publicacoes/:id` | **somente o autor** (titular da conta) + `expectedVersion` obrigatório; rascunho↔publicado via `publicado_em` (primeira publicação preservada); publicado→rascunho permitido. **D14: mestre NÃO edita conteúdo de publicação alheia** — recebe 404 idêntico a inexistente; única exceção: publicação `origem='usuario'` com `autor_conta_id=NULL` (criada pelo próprio mestre) é editável pelo mestre. `origem='sistema'`/`status='removido'` ⇒ 404 |
| `DELETE /publicacoes/:id` | **não existe** — remoção é por status `retirado`/`removido` (auditável) |
| `POST /publicacoes/:id/denunciar` | denunciante = conta elegível ≠ autor **que consiga ler a publicação** (`contatos` exige aresta aceita vigente sem bloqueio — 404 idêntico); 1 por par (unique); titularidade revalidada in-tx; `denuncia_aberta+1`; **DP-3 fechado: `≥2` contas distintas OU `denuncia_grave=1`** ⇒ `status='removido'` + `retirado_motivo='denuncia'` + denúncias `aberta→auto_removida` com `prazo_contestacao_em=agora+7d` **na mesma tx**. Mapeamento seguro: `denuncia_grave` deriva **somente** de `motivo='ilegal'` (flag do body nunca eleva motivo benigno) |
| `POST /publicacoes/:id/contestar` | **DP-2:** o autor contesta a remoção automática dentro de **7 dias** de `retirado_em` — `auto_removida→contestada`; fora do prazo → 409; não-autor → 404 |
| `GET /publicacoes/minhas` | publicações das contas do leitor em **qualquer status** (prévia do autor) com `version`/`status` para o PATCH — nunca vaza publicações de terceiros |

Router público/leitura (mesmo padrão W1/W3: `contaAutorizadaPara` revalidado ou mestre;
404 uniforme; `limiteUsuario` 60/min):

| Método/rota | Regra |
|---|---|
| `GET /publicacoes?tipo=noticia&origem=sistema&cursor=` | W4 — keyset `publicado_em DESC, id`; só `publicado` + `visivel()`; filtro `tipo` e `origem` (`usuario`\|`sistema`) opcionais; item = `{id,tipo,titulo,autor{…},origem,publicadoEm}` — **não** vaza `visibilidade` como "restrito aqui": item `contatos` invisível ao leitor sem aresta (simplesmente ausente) |
| `GET /publicacoes/:id` | W5 — corpo markdown renderizado no cliente; inclui `fonte` (handle do autor), `autorModo`, `personagemId` só p/ sistema; `contatos` sem aresta → 404 |

Moderação (DP-2 — **admin da plataforma**, nunca o mestre da campanha; `requireAdmin` em `/api/admin`):

| Método/rota | Regra |
|---|---|
| `GET /api/admin/internet-denuncias?campaignId=&status=` | fila de moderação (contestadas/em análise) com contexto da publicação |
| `POST /api/admin/internet-denuncias/:id/resolver` | `{decisao:'restaurar'\|'manter', resolucao?}` → denúncia `resolvida_admin` + `resolvido_por`=admin; `restaurar` devolve a publicação a `publicado` (preserva `publicado_em` original, `version+1`); `manter` deixa `removido`; demais denúncias pendentes da mesma publicação → `encerrada`; tudo em tx + audit `internet_denuncia_resolvida`. Denúncia já resolvida → 409 |

## 5. Notícia automática de morte (DP-8/DP-9, contrato v2.6)

- `avaliarMorte(characterId, hp, tx)` chamado **dentro da tx** de toda escrita de `__hp`:
  `hp ≤ 0` e personagem sem `__morte[].em` cobrindo ⇒ anexa epoch; se já existia morte
  revertida (`revertidaEm` set) e nova morte ⇒ novo epoch (dedup por `em`).
- Gatilho de publicação: **toda epoch nova** de `__morte` gera notícia
  (morte → ressurreição → nova morte = 2 notícias — cada morte real é evento
  noticiável; dedup por `(personagemId, epoch.em)` impede duplicata em retry),
  insere `internet_publicacoes` `tipo='noticia'`, `origem='sistema'`,
  `autor_conta_id=NULL`, `personagem_id`, `titulo`/`corpo` **gerados server-side**
  (template fixo "Morte de <nome>" + causa se houver), `visibilidade='campanha'`,
  `status='publicado'`, `publicado_em=agora`. `origem='sistema'` ⇒ somente leitura
  para todos exceto admin plataforma (DP-8: notícia **não** é apagada por
  ressurreição). **Importação NÃO gera notícia retroativa** — a epoch é
  re-derivada do `__hp` saneado só para dedup futuro; mortes do histórico não
  voltam a ser notícia.
- Ressurreição (DP-8): ação mestre auditada `personagem_ressuscitado` marca
  `revertidaEm` no epoch; **não** toca a publicação. Correção de causa (DP-9): só por
  **nova publicação** do autor/mestre — nunca edição da notícia de morte.
- `__morte` sobrevive a importação (sanear como chave reservada; dedup `(characterId, em)`).
  Cobertura de escritores de `__hp`: rota `/hp` (tx), criação de personagem (HP inicial
  patológico ≤0) e init legado no PATCH — todos passam por `avaliarMorte`.
- **Restauração "substituir"** (`restaurarEstado`): zera o domínio Internet da
  campanha — `internet_denuncias`, `internet_publicacoes`, `internet_messages`,
  `internet_conversations`/`participantes`, `internet_contacts`, `internet_pages`,
  `internet_sites` e `internet_accounts` são removidos antes de reimportar o pacote
  (comportamento vigente desde 1.1.1/1.1.2, estendido às tabelas 0044). `__morte`
  volta a ser derivado do `__hp` saneado — epoch preservada para dedup, **sem**
  notícia retroativa. Questão **D6** (preservar vs. zerar o domínio Internet no
  restore) permanece aberta para deliberação do Dono — o contrato registra o
  comportamento atual, não o decide.

## 6. Decisões registradas (deliberação Dono `7229555079` — fechadas)

1. `post_perfil` **sem `internet_profiles`**: gravado ligado ao personagem/conta via
   `autor_conta_id`; o perfil público (W9/W10) é vitrine derivada — sem coluna
   `perfil_id` nesta fatia.
2. Notícia de morte: **template 100% server-side** ("Morte de <nome>" + causa) — mestre
   não injeta corpo; correção só por nova publicação (DP-9).
3. Denúncia: motivos de **lista fechada** `spam|ofensa|ilegal|outro`; `denuncia_grave`
   deriva **somente** de `motivo='ilegal'` — a flag do body é aceita por
   compatibilidade mas nunca eleva motivo benigno (mapeamento seguro).
4. DP-2 fechado: contestação do autor em **7 dias**; resolução **exclusiva do admin da
   plataforma** (`/api/admin/internet-denuncias`); transições
   `aberta→auto_removida→contestada→resolvida_admin|encerrada`; reversão = `restaurar`
   devolve `publicado` preservando `publicado_em`.
5. DP-3 fechado: **≥2 contas distintas OU 1 `denuncia_grave`** ⇒ remoção na mesma tx.
6. D14: autor edita o próprio conteúdo; **mestre nunca reescreve título/corpo alheio** —
   moderação é por status, não por edição.
7. Pseudônimo: feed/detalhe/agregados exibem `pseudoNome`; handle/`autorContaId`/
   identidade real nunca vazam para leitores.
8. `expectedVersion` em `PATCH`: obrigatório (mesmo padrão W3) — sem exceção.

## 7. Invariantes de segurança (herdados, não negociáveis)

- Fail-closed: conta inativa/titular revogado → 404/403 antes de qualquer estado.
- Anti-oráculo: ordem autorização→existência→validação de body (lição W3 PATCH).
- TOCTOU: titularidade e `status='ativo'` re-lidos in-tx (`titularNaTx` padrão W3).
- `contatos` invisível em qualquer agregado — teste dedicado de oráculo.
- `__morte`/`__hp` nunca expostos ao cliente além do necessário (mestre vê tudo; jogador
  vê só o que a ficha já expõe hoje).
- Nenhuma classe/perícia paralela: investigação (W11) usa `tests`/`rolls` reais — fora desta fatia.
