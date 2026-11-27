# Contrato — Publicações da Internet pública (W4/W5 + W8 subset)

**Issue:** #365 (F1/6 — Internet pública) · **Ordem:** checkpoint operacional W4/W5 (`7229145994`) · **Base:** `main@d8221ec` (W1/W3 leitura + W3 escrita mergeados)
**Status:** proposta de implementação — consolidando decisões já fechadas (v2.x + DP-1…DP-9 + D1/D2/D6/D12 + SITE-12) em contrato executável. Itens `[PROPOSTA]` exigem deliberação antes do código.

## 1. Escopo desta fatia

| Entrega | Telas | Conteúdo |
|---|---|---|
| `internet_publicacoes` | W4 lista, W5 matéria, W8 subset | Tipos `noticia` e `post_perfil` (post no perfil — perfil W9/W10 é fatia própria, mas `post_perfil` já grava com `perfilId` NULL-able; ver §6) |
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
  nunca do body. Pseudônimo validado (charset/length como `handle`).

## 4. Endpoints (montados em `internet-escrita.ts` + `internet-publica.ts`)

Router autenticado (escrita, mesmo padrão W3: papel → `contaAutorizadaPara` → titularNaTx
in-tx → gate P5 por mutação → `limiteUsuario` cota de mutações cometidas → `expectedVersion`):

| Método/rota | Regra |
|---|---|
| `POST /publicacoes` | tipos `noticia`\|`post_perfil`; `visibilidade` obrigatória no body (declaração W8); `status` só `rascunho` na criação; gate P5; rate limit idem W3 |
| `PATCH /publicacoes/:id` | autor da conta **ou** mestre; `expectedVersion` obrigatório; rascunho↔publicado transição via `publicado_em`; publicado→rascunho permitido (despublicar) |
| `DELETE /publicacoes/:id` | **não existe** — remoção é por status `retirado`/`removido` (auditável) |
| `POST /publicacoes/:id/denunciar` | denunciante = conta autenticada ≠ autor; 1 por par (unique); `denuncia_grave` flag do denunciante; ao persistir: `denuncia_aberta+1`; se `≥2 distintas` ou `denuncia_grave=1` ⇒ `status='removido'` + `retirado_motivo='denuncia'` **na mesma tx** (DP-3) |

Router público/leitura (mesmo padrão W1/W3: `contaAutorizadaPara` revalidado ou mestre;
404 uniforme; `limiteUsuario` 60/min):

| Método/rota | Regra |
|---|---|
| `GET /publicacoes?tipo=noticia&cursor=` | W4 — keyset `publicado_em DESC, id`; só `publicado` + `visivel()`; item = `{id,tipo,titulo,autor{handle,nomePublico?},publicadoEm,visibilidade?}` — **não** vaza `visibilidade` como "restrito aqui": item `contatos` invisível ao leitor sem aresta (simplesmente ausente) |
| `GET /publicacoes/:id` | W5 — corpo markdown renderizado no cliente; inclui `fonte` (handle do autor), `autorModo`, `personagemId` só p/ sistema; `contatos` sem aresta → 404 |
| `GET /publicacoes/mortos` **ou** filtro `?origem=sistema` | W4 selo "notícia automática" — derivável de `origem='sistema'`; `[PROPOSTA]` listar via `tipo=noticia&origem=sistema` para não criar rota nova |

## 5. Notícia automática de morte (DP-8/DP-9, contrato v2.6)

- `avaliarMorte(characterId, hp, tx)` chamado **dentro da tx** de toda escrita de `__hp`:
  `hp ≤ 0` e personagem sem `__morte[].em` cobrindo ⇒ anexa epoch; se já existia morte
  revertida (`revertidaEm` set) e nova morte ⇒ novo epoch (dedup por `em`).
- Gatilho de publicação: na mesma tx da **primeira** morte (não em `revertidaEm` posterior),
  insere `internet_publicacoes` `tipo='noticia'`, `origem='sistema'`,
  `autor_conta_id=NULL`, `personagem_id`, `titulo`/`corpo` **gerados server-side**
  (template fixo "Morte de <nome>" + causa se houver), `visibilidade='campanha'`,
  `status='publicado'`, `publicado_em=agora`. `[PROPOSTA]` template mínimo — mestre pode
  editar? **Não**: `origem='sistema'` ⇒ somente leitura para todos exceto admin plataforma
  (DP-8: notícia **não** é apagada por ressurreição).
- Ressurreição (DP-8): ação mestre auditada `personagem_ressuscitado` marca
  `revertidaEm` no epoch; **não** toca a publicação. Correção de causa (DP-9): só por
  **nova publicação** do autor/mestre — nunca edição da notícia de morte.
- `__morte` sobrevive a importação (sanear como chave reservada; dedup `(characterId, em)`).

## 6. Pendências / pontos de deliberação

1. `[PROPOSTA]` `post_perfil` sem `internet_profiles` (W9/W10 depois): aceitar com
   `perfilId` implícito = conta do autor, ou **restringir esta fatia a `tipo='noticia'`**?
   Recomendação: aceitar `post_perfil` gravando normalmente — perfil é só a vitrine.
2. `[PROPOSTA]` notícia de morte: título/corpo 100% template (sem texto do mestre)?
   Alternativa: mestre fornece `corpo` opcional na ação de morte — **mais flexível, mas
   acopla**. Recomendação: template fixo nesta fatia.
3. `[PROPOSTA]` denúncia: `denuncia_grave` é auto-declarada pelo denunciante (qualquer
   conta pode flagrar)? Ou só motivos de lista fechada (`spam|ofensa|ilegal|outro`)?
   Recomendação: `motivo` texto + `denuncia_grave` só quando `motivo='ilegal'` — lista
   fechada de motivos.
4. `expectedVersion` em `PATCH`: obrigatório (mesmo padrão W3) — sem exceção.
5. Auditoria D3: `auditTx` dentro da mesma tx em toda mutação + denúncia + morte
   (`personagem_morreu`/`personagem_ressuscitado`/`publicacao_denunciada`/`publicacao_removida`).

## 7. Invariantes de segurança (herdados, não negociáveis)

- Fail-closed: conta inativa/titular revogado → 404/403 antes de qualquer estado.
- Anti-oráculo: ordem autorização→existência→validação de body (lição W3 PATCH).
- TOCTOU: titularidade e `status='ativo'` re-lidos in-tx (`titularNaTx` padrão W3).
- `contatos` invisível em qualquer agregado — teste dedicado de oráculo.
- `__morte`/`__hp` nunca expostos ao cliente além do necessário (mestre vê tudo; jogador
  vê só o que a ficha já expõe hoje).
- Nenhuma classe/perícia paralela: investigação (W11) usa `tests`/`rolls` reais — fora desta fatia.
