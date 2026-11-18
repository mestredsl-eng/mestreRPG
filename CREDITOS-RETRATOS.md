# Créditos — Galeria padrão de retratos (Issue #129)

## Origem das imagens

Todos os 140 retratos em `site/public/retratos/` são **assets SVG
procedurais originais do projeto Mestre RPG**, gerados por código —
não são fotografias, ilustrações de terceiros nem imagens baixadas.

- **Autor:** projeto Mestre RPG (gerador `scripts/gerar-retratos.mjs`)
- **Fonte:** composição vetorial determinística (PRNG com seed fixa por
  retrato) — nenhuma imagem externa, nenhum hotlink, nenhum serviço de
  terceiros em tempo de execução.
- **Licença:** o mesmo licenciamento do código do projeto. Como obra
  gerada pelo próprio projeto, não há atribuição de terceiros a fazer.

## Por que geração procedural

A Issue previa pesquisa de imagens CC0/domínio público. Na prática,
nenhuma biblioteca aberta confiável cobre as seis categorias exigidas
(vampiros, vampiras, lobisomens e criaturas fantásticas não existem em
pacotes de assets abertos com licença uniforme e qualidade consistente
de "retrato"). Fontes avaliadas:

- **Open Peeps** (CC0, pablostanley/open-peeps): cobre apenas pessoas
  humanas genéricas — sem vampiros/lobisomens/monstros.
- **game-icons.net** (CC-BY 3.0): ícones, não retratos; exigiria
  atribuição por ícone e não há categorias de personagem.
- **Wikimedia Commons**: licenças heterogêneas por arquivo e qualidade
  visual inconsistente para retratos de RPG.

A geração procedural garante: licença verificável (o gerador está no
repositório e é auditável), consistência visual entre as 140 peças,
zero dependência externa e regeneração reproduzível
(`node scripts/gerar-retratos.mjs`).

## Inventário

| Categoria   | Quantidade | Faixa de ids                    |
|-------------|-----------:|---------------------------------|
| Homens      |         20 | `homem-01` … `homem-20`         |
| Mulheres    |         20 | `mulher-01` … `mulher-20`       |
| Vampiros    |         20 | `vampiro-01` … `vampiro-20`     |
| Vampiras    |         20 | `vampira-01` … `vampira-20`     |
| Lobisomens  |         20 | `lobisomem-01` … `lobisomem-20` |
| Criaturas   |         40 | `criatura-<subtipo>-NN`         |
| **Total**   |    **140** |                                 |

Subtipos de criaturas: fantasma (10), esqueleto (8), orc (7), slime (6),
demônio (5), múmia (4).

## Observações

- Os SVGs são estáticos, sem scripts, sem referências externas e sem
  dados pessoais — seguros para `<img>` e para servir estaticamente.
- O manifesto validável pelo servidor está em
  `servidor/src/lib/retratos.ts` (gerado pelo mesmo script).
- Uploads de retrato próprios **não** fazem parte desta galeria: são
  validados por MIME real/magic bytes, tamanho e dimensões, e SVG é
  rejeitado (ver `servidor/src/routes/personagens.ts`).
