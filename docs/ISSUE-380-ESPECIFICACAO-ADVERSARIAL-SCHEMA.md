# Issue #380 — especificação adversarial do reconhecimento de schema

## Objetivo

Transformar a investigação da Issue #380 em um contrato testável para o reconhecedor de schema usado por `scripts/adotar-legado.mjs`, antes de qualquer alteração de produção.

A regra principal é **fail-closed**: journal, hash ou contagem isolados nunca autorizam adoção.

## Estado atual auditado

O reconhecedor atual lê somente `created_at` de `__drizzle_migrations`, ordena os valores e compara com prefixos derivados de `servidor/migrations/meta/_journal.json`.

Consequências auditadas:

- a coluna `hash` não participa da decisão;
- nenhum objeto de schema obrigatório é verificado;
- journal forjada pode ser aceita sem tabelas de usuário;
- journal incompleta/interrompida pode ser indistinguível de uma aplicação íntegra;
- o diagnóstico precisa ser somente leitura e não pode gravar recibo ou journal em caso de bloqueio.

## Contrato de reconhecimento

O reconhecedor deve devolver uma decisão estruturada, sem efeitos colaterais:

```ts
type ReconhecimentoSchema =
  | {
      ok: true;
      familia: "1.0.8" | "1.0.9" | "atual";
      migrations: number;
      evidencias: {
        journalExata: true;
        hashesValidos: true;
        estruturaValida: true;
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
        | "integridade-sqlite"
        | "chaves-estrangeiras"
        | "banco-ilegivel";
      detalhe?: string;
    };
```

A decisão `ok: true` somente é permitida quando todas as provas abaixo forem verdadeiras:

1. `created_at` coincide exatamente com o prefixo esperado, na ordem esperada;
2. cada migration aplicada tem `hash` igual ao hash da SQL correspondente;
3. todos os objetos estruturais obrigatórios daquele prefixo existem com colunas, índices e triggers esperados;
4. `PRAGMA integrity_check` retorna `ok`;
5. `PRAGMA foreign_key_check` retorna zero linhas;
6. nenhum passo de diagnóstico grava arquivo, recibo, journal ou backup.

## Matriz adversarial mínima

| Caso | Fixture | Decisão esperada | Efeito externo |
|---|---|---|---|
| 34 autênticas | prefixo 0..33, hashes e objetos corretos | aceitar 1.0.8 | nenhum antes da fase de adoção |
| 36 autênticas | prefixo 0..35 íntegro | aceitar 1.0.9 | nenhum antes da fase de adoção |
| atual autêntica | journal completa e estrutura correspondente | aceitar atual | nenhum antes da fase de adoção |
| hash divergente | `created_at` correto, uma hash alterada | bloquear `hash-divergente` | nenhum |
| hash forjada | hash inventada para migration existente | bloquear `hash-divergente` | nenhum |
| linha extra | prefixo válido + uma linha de journal sem SQL correspondente | bloquear `journal-extra` | nenhum |
| linha faltante | prefixo truncado | bloquear `journal-interrompida` | nenhum |
| ordem alterada | mesmos valores fora da ordem | bloquear `journal-forjada` | nenhum |
| zero tabelas de usuário | apenas `__drizzle_migrations` presente | bloquear `estrutura-ausente` | nenhum |
| objeto removido | tabela/índice/trigger obrigatório ausente | bloquear `estrutura-ausente` | nenhum |
| objeto alterado | coluna/tipo/índice divergente | bloquear `estrutura-divergente` | nenhum |
| SQLite corrompido | banco ilegível ou integrity != ok | bloquear `integridade-sqlite` | nenhum |
| FK quebrada | `foreign_key_check` com linhas | bloquear `chaves-estrangeiras` | nenhum |
| recibo ausente | fixture válida sem recibo | reconhecer, mas não adotar sozinho | nenhum |
| recibo divergente | recibo incompatível com identidade/repo/schema | bloquear antes do reconhecimento final | nenhum |
| cópia manual de recibo | recibo válido copiado para outra fixture | decisão conforme ameaça aceita, documentada e testada | não alterar contrato silenciosamente |

## Requisitos das fixtures

Cada fixture deve ser descartável e isolada em diretório temporário:

- banco criado pelo migrator real ou por cópia de um banco produzido pelo migrator;
- journal e hashes derivados do repositório, sem valores escritos manualmente;
- nenhum acesso ao banco/instalação real;
- cleanup garantido mesmo em falha;
- snapshot dos arquivos externos antes e depois do diagnóstico para provar ausência de escrita.

Para diferenciar journal íntegra de journal interrompida, a fixture interrompida deve conter:

- as migrations SQL já aplicadas no banco;
- uma linha de journal presente para a migration não concluída, sem os objetos estruturais correspondentes;
- ou o inverso, conforme o protocolo real observado no migrator.

O teste deve provar que esses estados não colapsam para a mesma decisão positiva.

## Ordem de implementação recomendada

1. extrair o reconhecimento para uma função pura/isolada;
2. gerar o mapa esperado de migrations, hashes e objetos a partir dos artefatos reais;
3. implementar a matriz em fixtures temporárias;
4. conectar o reconhecedor ao fluxo de adoção sem alterar a política de backup;
5. provar que nenhuma falha grava recibo, journal ou estado externo;
6. executar a suíte no SHA exato e publicar a evidência.

## Fora do escopo desta etapa

- migrations novas;
- alteração do schema do produto;
- mudança no protocolo de recibo;
- mudança em `.github/workflows/ci.yml`;
- acesso à instalação real do usuário;
- release, tag ou bump de versão;
- adoção automática de cópia de recibo sem decisão explícita sobre o threat model.

## Critério de saída

A próxima PR de código só deve começar quando esta especificação tiver revisão humana ou quando a Issue #380 registrar uma decisão equivalente. A implementação deve manter compatibilidade com instalações legítimas e rejeitar qualquer banco em que journal, hash e estrutura não formem uma prova coerente.
