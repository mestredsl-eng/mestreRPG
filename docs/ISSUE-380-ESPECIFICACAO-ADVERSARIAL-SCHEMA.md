# Issue #380 — especificação adversarial do reconhecimento de schema

## Objetivo

Transformar a investigação da Issue #380 em um contrato testável para o reconhecedor de schema usado por `scripts/adotar-legado.mjs`, antes de qualquer alteração de produção.

A regra principal é **fail-closed**: journal, hash, contagem ou estrutura isolados nunca autorizam adoção.

**Revisão vigente:** este documento incorpora a revisão L4/T7 aprovada na issue (`comentários 7204971329` e `7205292890`), incluindo identidade de instalação dentro do SQLite, a ressalva *trust on first use* e a política de cache corrigida.

## Estado atual auditado

O reconhecedor atual lê somente `created_at` de `__drizzle_migrations`, ordena os valores e compara com prefixos derivados de `servidor/migrations/meta/_journal.json`.

Consequências auditadas:

- a coluna `hash` não participa da decisão;
- nenhum objeto de schema obrigatório é verificado;
- journal forjada pode ser aceita sem tabelas de usuário;
- journal incompleta/interrompida pode ser indistinguível de uma aplicação íntegra;
- o recibo prova que a instalação existiu, mas **não** atesta o estado atual do banco — um banco pode ser substituído após a emissão;
- o diagnóstico precisa ser somente leitura e não pode gravar recibo ou journal em caso de bloqueio.

## Camadas de verificação

A decisão final é a conjunção de quatro camadas fail-closed, avaliadas em ordem:

| Camada | O que prova | Sinais |
|---|---|---|
| **L1 — journal↔arquivos** | cada linha de `__drizzle_migrations` corresponde a uma migration real do `_journal.json` da instalação, com `hash = sha256` do `.sql` do worktree | `created_at`↔`when`, `hash`, cardinalidade/bi-jeção |
| **L2 — assinatura estrutural** | o schema efetivo do banco é idêntico ao produzido pelo replay real do migrator para o prefixo reconhecido | `sqlite_master` (type/name/sql), `PRAGMA table_info` por tabela |
| **L3 — dados-sentinela** | migrations data-only (invisíveis a L2) aplicaram seus efeitos | marcadores por versão (ex.: seed `novidades` 1.1.0) |
| **L4 — identidade do banco** | o banco presente pertence à linhagem de dados desta instalação | `instalacaoIdBanco` em `server_settings` × recibo externo |

Nenhuma camada isolada autoriza: journal perfeito com objetos faltando falha em L2; estrutura perfeita com journal forjado falha em L1; banco de outra instalação com mesmo schema falha em L4.

## Contrato de reconhecimento

O reconhecedor deve devolver uma decisão estruturada, sem efeitos colaterais:

```ts
type ReconhecimentoSchema =
  | {
      ok: true;
      familia: "1.0.8" | "1.0.9" | "schema-39" | "atual" | `prefixo-${number}`;
      migrations: number;
      evidencias: {
        journalExata: true;
        hashesValidos: true;
        estruturaValida: true;
        sentinelasDados: true;
        identidadeBanco: "confirmada" | "atribuida";
        integrityCheck: "ok";
        foreignKeyCheck: "ok";
      };
    }
  | {
      ok: false;
      motivo:
        | "journal-ausente"
        | "journal-forjada"
        | "journal-extra"
        | "journal-interrompida"
        | "hash-divergente"
        | "estrutura-ausente"
        | "estrutura-divergente"
        | "sentinela-ausente"
        | "banco-nao-pertence-a-esta-instalacao"
        | "identidade-nao-atada"
        | "integridade-sqlite"
        | "chaves-estrangeiras"
        | "banco-ilegivel";
      detalhe?: string;
    };
```

A decisão `ok: true` somente é permitida quando todas as provas abaixo forem verdadeiras:

1. L1: `created_at` casa por bi-jeção com `entries[i]` do `_journal.json` e cada `hash` iguala `sha256` do `.sql` correspondente lido do worktree;
2. L2: `ASSINATURA_DB(candidato, k) == REFERENCIA(k)` para o prefixo `k` reconhecido (detalhes abaixo);
3. L3: todas as sentinelas de dados do prefixo presentes;
4. L4: `instalacaoIdBanco` do banco confere com o recibo, ou a transição verify-once está autorizada (§Identidade);
5. `PRAGMA integrity_check` retorna `ok` e `PRAGMA foreign_key_check` retorna zero linhas;
6. nenhum passo de diagnóstico grava arquivo, recibo, journal ou backup.

### L2 — assinatura estrutural por replay

`REFERENCIA(k)` é obtida executando as migrations `entries[0..k)` num SQLite descartável (`:memory:` ou tmp) com o próprio migrator da instalação e extraindo a forma canônica:

```
SELECT type, name, sql FROM sqlite_master
  WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name
+ para cada tabela: PRAGMA table_info → colunas ordenadas por cid
→ assinatura = sha256(JSON canônico)
```

`ASSINATURA_DB` aplica a mesma extração ao banco candidato. Comparar `sqlite_master.sql` como texto é seguro porque ambos os lados executam os mesmos statements do mesmo worktree; a canonicalização exata (trim/normalização) é decisão de implementação. Contagem de tabelas, `created_at` ou "número mágico" **não** constituem assinatura — fixture `s39-interrompida-obj` prova que nomes de objetos podem coincidir enquanto colunas/índices divergem.

O replay é barato (≤42 migrations em memória) e cacheável por `(hash do _journal.json, hash dos .sql, versão do algoritmo)` — nunca por estado do banco candidato.

## Identidade do banco (L4)

### Âncora persistida

`instalacaoIdBanco`: UUID gravado em `server_settings` (tabela key-value existente; viaja com backup/restore por ser dado; **não exige migration**). Chave reservada `protocolo.instalacaoIdBanco` com valor `{ id, criadoEm, versaoProtocolo }`. A chave é protegida contra escrita pela API de settings — só os módulos do protocolo a alteram.

O recibo externo (`instalacao-recibo.json`) passa a registrar `instalacaoIdBanco` e `assinaturaSchema`. A âncora vive **dentro** do banco de propósito: qualquer restore/cópia carrega a identidade junto — a identidade descreve o conteúdo, não o invólucro.

### Ciclo de vida

- **Bootstrap novo / adoção:** após todas as provas (candidato + integridade + L1–L3 + backup validado), o produtor de estado gera o UUID e grava a linha no banco **antes** de atualizar o recibo externo — a ordem canônica e a recuperação de crash estão em §Recuperação de crash. Se o banco já contém id bem-formado (clone de instalação adotada), **preserva-se o id existente** — é o que permite clonagem legítima.
- **Boot subsequente (`instalacao-concluida`):** lê a linha do banco e compara com o recibo:
  - confere ⇒ segue;
  - banco sem id + recibo legado sem id ⇒ **verify-once**: grava id no banco e no recibo, segue (idempotente);
  - divergente, ou ausente onde exigido ⇒ `banco-nao-pertence-a-esta-instalacao` → bloqueio fail-closed, sem apagar nada.

### Ressalva *trust on first use* (obrigatória)

Um banco legado **sem id** combinado com recibo legado **sem id** não permite provar retrospectivamente a proveniência. No primeiro boot de transição, o sistema atribui identidade ao banco que estiver configurado naquele momento. Se outro banco tiver sido colocado ali antes dessa primeira vinculação, **não há evidência suficiente para distingui-lo** sem âncora externa ou decisão explícita do operador — esse caso **não** é descrito como substituição detectável; é risco residual aceito e documentado, mitigável apenas por decisão humana (ex.: operador confirma a origem do arquivo).

### Cenários de ciclo de vida

| Cenário | Resultado | Risco residual |
|---|---|---|
| Backup pós-ID da mesma instalação restaurado | id preservado ⇒ boot normal | nenhum — mesma linhagem |
| Backup pré-ID da mesma instalação restaurado pelo fluxo oficial | ver §Restauração — reatribuição assistida | backup pré-ID de outra instalação é indistinguível — ver ressalva |
| Banco sem id colocado manualmente com recibo exigindo id | bloquear `banco-nao-pertence-a-esta-instalacao` — sem TOFU | nenhum |
| Banco legado de OUTRA instalação, sem id, no lugar do banco | verify-once atribui id novo ⇒ **aceito** (TOFU) | não distinguível retrospectivamente — declarado |
| Cópia de `.db` com id=X em instalação com recibo id=Y | divergência ⇒ `banco-nao-pertence-a-esta-instalacao` | nenhum |
| Clone integral (db+state+recibo) em outro diretório | `repoCanon` falha primeiro → re-adoção preserva id do banco ⇒ clone funcional | aceito — é linhagem coerente |
| Adulteração manual da linha de id no banco | atacante precisa igualar o recibo; sem segredo, id é observável no banco ⇒ spoof possível | declarado: âncora prova linhagem, não autenticidade — evolução HMAC com segredo local fora de escopo |
| Adulteração do recibo (id trocado) | banco é âncora primária; mismatch ⇒ bloqueio | nenhum |
| `MESTRE_BANCO` apontado para outro arquivo autêntico | id divergente ⇒ bloqueido | nenhum |

### Restauração de backups e identidade

O fluxo oficial `aplicar-restauracao` é o **único** caminho autorizado a reatribuir identidade; substituição manual de arquivo nunca invoca TOFU fora do verify-once de transição. A ordem de gravação e a recuperação de crash desse fluxo estão em §Recuperação de crash (R0–R4b).

- **Backup pós-ID** (criado após a primeira vinculação): o `instalacaoIdBanco` viaja dentro do `.db` — restaurar preserva o id automaticamente, sem passo extra.
- **Backup pré-ID da mesma instalação, restaurado pelo fluxo oficial:** antes de trocar o arquivo, o fluxo captura o id vigente do banco corrente (já conferido com o recibo) e grava um **recibo de restauração** fora do banco com `fase` e hashes pré/pós-mutação (detalhes em §Recuperação de crash, R0–R4b). Após a troca e a reatribuição, o banco restaurado recebe o id vigente — a prova é a **captura pré-troca pelo fluxo oficial**, não TOFU. Se o banco restaurado contém id divergente do vigente ⇒ `banco-nao-pertence-a-esta-instalacao`, sem reatribuição.
- **Substituição manual** (arquivo copiado por fora do fluxo) de banco sem id quando o recibo já exige id ⇒ **bloqueio** `banco-nao-pertence-a-esta-instalacao`. Não existe verify-once fora da transição legado→vinculado.
- **Prova de proveniência do backup:** o manifesto do backup (gravado pelo sistema no diretório de backups da instalação) registra `sha256` do arquivo, data e — quando existir — o id do banco de origem. Backup pré-ID não carrega id de origem; nesse caso a prova de linhagem é a posse do arquivo dentro do diretório de backups gerenciado pela instalação **mais** a confirmação explícita do operador no fluxo de restauração. Um backup pré-ID de **outra** instalação restaurado pelo fluxo oficial é indistinguível de um legítimo pré-ID — risco residual declarado, mitigável apenas por decisão humana; **não** é apresentado como detectável.

### Recuperação de crash — matriz SQLite × recibo

**Não há transação atômica entre SQLite e filesystem.** Este protocolo usa ordem canônica de gravação + artefatos de intenção duráveis + recuperação idempotente. Onde o código conhecido ainda não garante o mecanismo, o item está marcado como **requisito de implementação / risco aberto** — não como propriedade existente.

**Correção de proveniência (achado do Dono):** `ASSINATURA_DB`/`assinaturaSchema` provam **estrutura**, não linhagem — dois bancos autênticos do mesmo schema têm a mesma assinatura, e a linha de id no SQLite pode ser escrita por edição direta do arquivo. A prova de linhagem vem de **artefatos de intenção externos gravados antes da mutação**, nunca da assinatura nem da leitura da linha isolada.

### Artefatos de intenção (requisitos de implementação)

- **`vinculacao-pendente.json`** — gravado atomicamente (tmp+rename) **antes** de qualquer mutação do banco na vinculação inicial/verificação única. Conteúdo: `{ uuidEsperado, criadoEm, fase }`. É a prova externa durável de intenção; substitui a prova circular anterior.
- **Recibo de restauração** ganha campo `fase` (`iniciado` → `arquivo-trocado` → `reatribuindo` → `concluida`), `sha256BackupRestaurado` (imagem **pré-mutação**) e `sha256PosReatribuicao` (evidência **pós-escrita**, gravada junto com `concluida`). Os dois hashes são distintos por construção: a escrita do id altera os bytes do banco.

### Ordem canônica — vinculação (V)

`V1` gravar `vinculacao-pendente` `{uuidEsperado, fase:"pendente"}` → `V2` gravar linha de id no DB → `V3` atualizar recibo externo `{instalacaoIdBanco, assinaturaSchema}` → `V4` marcar pending `fase:"concluida"` (ou removê-lo). O banco é âncora primária; pending e recibo são evidências externas.

### Ordem canônica — restauração pré-ID (R)

`R1` gravar recibo de restauração `{idVigente, sha256BancoSubstituido, sha256BackupRestaurado, fase:"iniciado"}` (tmp+rename, validado) → preservar banco substituído (mover, não apagar) → trocar arquivo → `R2` fase `"arquivo-trocado"` → verificar `sha256(arquivo presente) == sha256BackupRestaurado` e L1–L3+integridade → `R3` fase `"reatribuindo"` → gravar id (statement único — atomicidade SQLite por statement) → `R4` fase `"concluida"` + `sha256PosReatribuicao` numa única escrita atômica.

### Matriz de estados — vinculação

| # | Crash em | Estado resultante | Fonte autoritativa | Recuperação |
|---|---|---|---|---|
| V1 | após pending, antes do id no DB | pending=`pendente`; DB sem id; recibo legado | pending (intenção registrada antes de qualquer mutação) | **Completar forward:** gravar `uuidEsperado` no DB → recibo → `concluida`. Idempotente: se DB já tem id==uuidEsperado, pular V2 |
| V2 | após id no DB, antes do recibo | pending=`pendente`; DB id=X; recibo sem id | pending + linha DB | Se `id_DB == uuidEsperado` e L1–L3+integridade passam ⇒ completar V3/V4. Se `id_DB ≠ uuidEsperado` ⇒ banco trocado na janela ⇒ **bloquear** `banco-nao-pertence-a-esta-instalacao`, sem recibo positivo |
| V3 | após recibo, antes de concluir pending | DB=X; recibo=X; pending=`pendente` | recibo+DB convergidos | Marcar pending `concluida`; boot normal |
| V4 | pending ausente/concluída, estados convergidos | — | — | Boot normal |

Estado ambíguo não coberto (pending existe mas DB tem id≠uuidEsperado, ou recibo já tem id≠pending) ⇒ **bloqueio fail-closed**, decisão do operador. Pending malformado/ilegível é tratado como ausente somente se DB e recibo já convergiram; caso contrário bloqueia.

### Matriz de estados — restauração pré-ID

| # | Crash em | Estado resultante | Fonte autoritativa | Recuperação |
|---|---|---|---|---|
| R0 | antes de R1 ou receipt-restauração ausente/inválido | Restore não iniciado | — | Ignorar/abortar; operador repete o fluxo |
| R1–R2a | após troca, antes de fase `arquivo-trocado` ou antes da verificação | Arquivo restaurado no lugar; fase ∈ {`iniciado`} ou sem evidência de verificação | recibo de restauração | Recomputar `sha256(arquivo)`: ==`sha256BackupRestaurado` + L1–L3 ⇒ avançar para R3. Divergente ⇒ **não aceitar**, bloquear |
| R2b | fase=`arquivo-trocado`, arquivo conferido, antes de `reatribuindo` | Idem, verificação já registrada | recibo de restauração (`fase` durável) | Idempotente: revalidar sha256+L1–L3 (barato) ⇒ gravar fase `reatribuindo` |
| R3 | fase=`reatribuindo`, crash antes/durante a escrita do id | DB restaurado possivelmente sem id ou com id parcial | fase `reatribuindo` = protocolo autorizou a mutação | **Statement único ⇒ sem linha parcial** (atomicidade SQLite). Se id ausente ⇒ gravar `idVigente`; se `id==idVigente` ⇒ seguir; se `id≠idVigente` ⇒ bloquear. Depois R4 |
| R4a | após id gravado, antes de R4 | DB id=`idVigente`; recibo fase=`reatribuindo`, sem `sha256PosReatribuicao` | fase `reatribuindo` + linha DB | Idempotente: confirmar `id==idVigente` ⇒ gravar `concluida`+`sha256PosReatribuicao` (hash recalculado **agora**, é evidência do estado pós-escrita, não gate). Sem nova janela: R4 é escrita atômica única |
| R4b | durante R4 | tmp+rename ⇒ recibo antigo (`reatribuindo`) ou novo (`concluida`) | — | Ambos os estados são cobertos por R3/R4a — convergência garantida |

**Separação de hashes (achado do Dono):** `sha256BackupRestaurado` é comparado **somente** antes da mutação (R2). Após a escrita do id os bytes mudam legitimamente — `sha256PosReatribuicao` é **evidência registrada**, nunca gate de boot futuro (dados mudam a cada boot; mesmo princípio de `sha256Banco`).

### Riscos abertos declarados

- **Janela `reatribuindo`:** entre R3 e R4 o arquivo já diverge do hash do backup por causa da nossa escrita; uma adulteração externa nessa janela não é distinguível da mutação legítima. Janela é de segundos, dentro do processo do fluxo oficial, e o banco substituído fica preservado para rollback — **risco residual declarado**, mitigável por execução serial do restore.
- `vinculacao-pendente`/recibo de restauração/recibo externo pressupõem escrita atômica tmp+rename e integridade na leitura — **requisito de implementação** a verificar no código.
- Forjar `vinculacao-pendente` exige escrita no diretório de estado — mesmo nível de ameaça de forjar o recibo; declarado, não agravado.
- Preservação do banco substituído durante restore é obrigatória para rollback manual; política de retenção/limpeza fica fora desta especificação.

## O que é e não é detectável

**Detectável:** substituição de arquivo inteiro, restore de outra linhagem, journal/schema adulterado, rollback para estado sem identidade.

**NÃO detectável:** edição cirúrgica de valores de dados; clonagem bit-a-bit coerente; banco sem-id plantado antes do primeiro verify-once (TOFU); reescrita da linha de id pelo atacante com acesso de escrita ao banco (sem segredo). Nenhuma promessa de detectar edição arbitrária de dados com apenas assinatura estrutural + id em texto claro.

## Cache e custo por boot

- Identidade: 1 SELECT indexado em `server_settings` por boot — sem hash de arquivo.
- `sha256Banco`/mtime **não** são prova de identidade nem gatilho de invalidação: dados mudam legitimamente a cada boot (WAL, novas linhas, registro de backups). Fora da decisão.
- `REFERENCIA(k)` (o replay) é cacheada por `(hash do _journal.json + hash dos .sql + versão do algoritmo)` e recomputada apenas quando: primeira verificação pós-recibo, integridade suspeita, ou mudança de versão do protocolo. **A comparação L2 nunca é dispensada:** em todo boot, `ASSINATURA_DB(candidato)` é extraída do banco presente e comparada com a referência cacheada antes de `ok:true`. O cache elimina o custo do replay (≤42 migrations em memória); o custo restante por boot é a extração da assinatura do candidato (`sqlite_master` + `PRAGMA table_info` por tabela) — da ordem de dezenas de consultas indexadas, aceitável para um gate fail-closed. Se o custo medido se mostrar inviável, a alternativa é **declarar o risco explicitamente e alterar o contrato** — não manter L2 obrigatória no papel e dispensada na prática.

## Matriz adversarial mínima

| Caso | Fixture | Decisão esperada | Efeito externo |
|---|---|---|---|
| 34 autênticas | prefixo 0..33, hashes e objetos corretos | aceitar 1.0.8 | nenhum antes da fase de adoção |
| 36 autênticas | prefixo 0..35 íntegro | aceitar 1.0.9 | nenhum antes da fase de adoção |
| schema-39 autêntica | prefixo 0..38 (v1.1.0) íntegro | aceitar schema-39 | nenhum antes da fase de adoção |
| atual autêntica | journal completa e estrutura correspondente | aceitar atual | nenhum antes da fase de adoção |
| prefixo intermediário autêntico (38/40/41) | crash natural ⇒ lote atômico rollback ⇒ prefixo menor consistente | aceitar `prefixo-k` (recomendado) | nenhum |
| hash divergente | `created_at` correto, uma hash alterada | bloquear `hash-divergente` | nenhum |
| hash forjada | hash inventada para migration existente | bloquear `hash-divergente` | nenhum |
| linha extra | prefixo válido + uma linha de journal sem SQL correspondente | bloquear `journal-extra` | nenhum |
| linha faltante | prefixo truncado | bloquear `journal-interrompida` | nenhum |
| ordem alterada | mesmos valores fora da ordem | bloquear `journal-forjada` | nenhum |
| zero tabelas de usuário | apenas `__drizzle_migrations` presente | bloquear `estrutura-ausente` | nenhum |
| objeto removido | tabela/índice/trigger obrigatório ausente | bloquear `estrutura-ausente` | nenhum |
| objeto alterado | coluna/tipo/índice divergente (ex.: `shop_orders` sem `created_by`) | bloquear `estrutura-divergente` | nenhum |
| journal verdadeiro + objetos faltando (hash forjado correto) | `s39-interrompida-obj` com hashes reais | bloquear `estrutura-divergente` (L2) | nenhum |
| sentinela ausente | migration data-only não aplicada (ex.: seed `novidades` 1.1.0) | bloquear `sentinela-ausente` | nenhum |
| SQLite corrompido | banco ilegível ou integrity != ok | bloquear `integridade-sqlite` | nenhum |
| FK quebrada | `foreign_key_check` com linhas | bloquear `chaves-estrangeiras` | nenhum |
| recibo ausente | fixture válida sem recibo | reconhecer, mas não adotar sozinho | nenhum |
| recibo divergente | recibo incompatível com identidade/repo/schema | bloquear antes do reconhecimento final | nenhum |
| **T7a** | recibo id=X; banco substituído por autêntico de outra instalação (id=Y, mesmo schema) | bloquear `banco-nao-pertence-a-esta-instalacao` | nenhum |
| **T7b** | T7a + state-dir da outra instalação copiado junto | re-adoção preserva id=Y; clone funcional | decisão documentada |
| **T7c** | backup da mesma instalação restaurado (id=X) | boot normal | — |
| **T7d** | N alterações legítimas de dados em uso normal | boot normal (estrutura+id intactos) | — |
| **T7e** | banco sem id + recibo legado sem id | verify-once atribui id ⇒ boot normal; TOFU declarado | grava id (transição) |
| **T7f** | recibo adulterado com id≠banco | bloquear (banco é âncora primária) | nenhum |
| **T7g** | `MESTRE_BANCO` → outro arquivo autêntico | bloquear `banco-nao-pertence-a-esta-instalacao` | nenhum |
| **T7h** | backup pré-ID da mesma instalação restaurado via `aplicar-restauracao` | recibo de restauração gravado; id vigente reatribuído ⇒ boot normal | grava linha de id + recibo de restauração |
| **T7i** | banco sem id colocado manualmente com recibo exigindo id | bloquear `banco-nao-pertence-a-esta-instalacao` — sem TOFU | nenhum |
| cópia manual de recibo | recibo válido copiado para outra fixture | decisão conforme ameaça aceita, documentada e testada | não alterar contrato silenciosamente |

## Requisitos das fixtures

Cada fixture deve ser descartável e isolada em diretório temporário:

- banco criado pelo migrator real ou por cópia de um banco produzido pelo migrator;
- journal e hashes derivados do repositório, sem valores escritos manualmente;
- fixtures de identidade precisam de `instalacaoIdBanco` controlado (presente/ausente/divergente) sem tocar banco real;
- nenhum acesso ao banco/instalação real;
- cleanup garantido mesmo em falha;
- snapshot dos arquivos externos antes e depois do diagnóstico para provar ausência de escrita.

Para diferenciar journal íntegra de interrompida, a fixture interrompida deve conter as migrations SQL aplicadas com linha de journal para migration não concluída, **sem** os objetos estruturais correspondentes — e variante com hashes forjados corretos para provar que L1 sozinha não basta.

## Ordem de implementação recomendada

1. extrair o reconhecimento para uma função pura/isolada (L1–L3);
2. gerar o mapa esperado de migrations, hashes e objetos a partir dos artefatos reais; implementar `REFERENCIA(k)` por replay com cache por artefatos;
3. implementar a matriz em fixtures temporárias;
4. L4: módulo `identidade-banco` (ler/gravar/proteger a chave em `server_settings`), extensão de `gravarReciboInstalacao`/`lerReciboInstalacao` com `instalacaoIdBanco`+`assinaturaSchema` (parse tolerante a recibos legados), verify-once e bloqueio `banco-nao-pertence-a-esta-instalacao`;
5. conectar o reconhecedor ao fluxo de adoção sem alterar a política de backup;
6. provar que nenhuma falha grava recibo, journal ou estado externo;
7. executar a suíte no SHA exato e publicar a evidência.

## Fora do escopo desta etapa

- migrations novas ou alteração do schema do produto (a linha de identidade usa tabela existente);
- implementação de qualquer camada — esta PR é somente documentação;
- mudança em `.github/workflows/ci.yml`;
- acesso à instalação real do usuário;
- release, tag ou bump de versão;
- autenticação criptográfica da identidade (HMAC/segredo) — evolução futura registrada como risco residual;
- adoção automática de cópia de recibo sem decisão explícita sobre o threat model.

## Critério de saída

A próxima PR de código só deve começar quando esta especificação tiver revisão humana ou quando a Issue #380 registrar uma decisão equivalente. A implementação deve manter compatibilidade com instalações legítimas, rejeitar qualquer banco em que journal, hash, estrutura e identidade não formem uma prova coerente, e declarar explicitamente os limites de detecção (TOFU, edição de dados, clonagem).
