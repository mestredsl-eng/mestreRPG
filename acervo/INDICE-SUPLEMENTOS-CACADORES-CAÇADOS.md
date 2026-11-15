# Acervo de suplementos — Caçadores Caçados

Pacote organizado para o **Mestre RPG**, construído tomando como referência o dump da campanha e o formato de importação oficial `mestre-rpg-biblioteca`, versão 1.

## Pacote completo

- [pacote-completo-cacadores-cacados.v1.json](./pacote-completo-cacadores-cacados.v1.json) — **um único arquivo com os nove livros**, pronto para importar no Acervo.
- [Pasta de suplementos](./suplementos/) — JSONs individuais para baixar, revisar e evoluir separadamente.
- [Referências de preços, pesos e critérios](./REFERENCIAS-PRECOS-PESOS-2026.md) — metodologia e fontes consultadas.

## Conteúdo

| Livro | Conteúdo | Itens |
|---|---|---:|
| I | Arsenal, Veículos e Equipamentos | 35 |
| II | Medicina, Investigação e Sobrevivência | 41 |
| III | Equipamentos Profissionais e Tecnologia Atual | 40 |
| IV | Armas, Combate e Proteção | 30 |
| V | Transporte, Aviação e Veículos Especiais | 25 |
| VI | Ciências, Geologia e Laboratório | 29 |
| VII | Medicina, Investigação e Resgate Avançado | 30 |
| VIII | Profissões, Artes, Esportes e Animais | 31 |
| IX | Tecnologia Profissional e Segurança Eletrônica | 29 |
| **Total** | **9 livros** | **290** |

## Dados econômicos e físicos — revisão de novembro de 2026

Todos os 290 itens têm peso aproximado em kg, valor de referência em reais quando há base defensável, faixa estimada de mercado e unidade de compra. Os dados ficam dentro de `definition`:

- `weight`: massa em kg da unidade indicada.
- `valueCents`: preço de referência em centavos de BRL; omitido quando não existe preço civil/institucional comparável e confiável.
- `economia.precoReferenciaBRL`: preço de referência legível em reais ou `null` quando não se aplica.
- `economia.faixaPrecoBRL`: faixa mínima/máxima estimada ou `null`.
- `economia.unidadeCompra`: unidade, par, kit, caixa, pacote, rolo ou veículo a que preço e peso se referem.
- `economia.dataReferencia`: `2026-11`.

Os veículos também registram combustível, capacidade/lotação, consumo ou autonomia aproximados e a base usada para o peso. Veículos terrestres usam referência de usados/seminovos em bom estado; bens e equipamentos geralmente usam configurações novas econômicas/intermediárias. Consumíveis foram padronizados por caixa, pacote, conjunto ou rolo quando necessário.

**São estimativas para referência de jogo, não cotações, avaliação pericial ou garantia de preço.** Modelo, ano, condição, região, certificação, acessórios, instalação, documentação e disponibilidade podem alterar bastante o custo. Para classes restritas ou institucionais sem preço civil regular, o valor fica em aberto em vez de criar falsa precisão.

## Pré-requisitos

Os requisitos usam as chaves realmente existentes no dump da ficha. Exemplos:

- Armas brancas: `pericia:armas_brancas`, nível 1.
- Armas de fogo: `pericia:armas_de_fogo`, nível 1.
- Veículos comuns: `pericia:conducao`, nível 1.
- Caça F-16 Fighting Falcon: `pericia:conducao`, nível 5.
- Ferramentas científicas e profissionais: Conhecimentos ou Talentos existentes, conforme a atividade.

## Importação

No Mestre RPG, abra **Acervo → Importar JSON**, selecione `pacote-completo-cacadores-cacados.v1.json`, confira a prévia dos nove livros e confirme. O pacote é um envelope de importação, não é o dump de campanha. Ao importar, preserve os dados existentes quando a prévia indicar conflitos; não substitua livros sem revisar.

## Origem do conteúdo

Base de regras: dump `dump-cacadores-e-cacas.json` fornecido pelo usuário. Dados de personagens, membros e informações particulares da campanha não foram copiados para os livros.
