# Acervo de suplementos — Caçadores Caçados

Pacote organizado para o **Mestre RPG**, construído tomando como referência o dump enviado da campanha e o formato de importação oficial `mestre-rpg-biblioteca`, versão 1.

## Pacote completo

- [pacote-completo-cacadores-cacados.v1.json](./pacote-completo-cacadores-cacados.v1.json) — **um único arquivo com os nove livros**, pronto para importar no Acervo.
- [Pasta de suplementos](./suplementos/) — JSONs individuais para baixar, revisar e evoluir separadamente.

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

Os três livros originais foram preservados e complementados. Os seis livros novos acrescentam 174 itens. Ao todo, 189 itens têm pré-requisitos registrados.

## Pré-requisitos

Os requisitos usam as chaves realmente existentes no dump da ficha. Exemplos:

- Armas brancas: `pericia:armas_brancas`, nível 1.
- Armas de fogo: `pericia:armas_de_fogo`, nível 1.
- Veículos comuns: `pericia:conducao`, nível 1.
- Caça F-16 Fighting Falcon: `pericia:conducao`, nível 5.
- Ferramentas científicas e profissionais: Conhecimentos ou Talentos existentes, conforme a atividade, por exemplo `conhecimento:geologia`, `conhecimento:medicina`, `conhecimento:investigacao`, `conhecimento:computador`, `talento:quimico`, `talento:tecnologia`, `talento:artista` e `talento:esportes`.

O campo segue a estrutura oficial de regras:

```json
{
  "prerequisitos": [
    {
      "kind": "pericia",
      "key": "conducao",
      "minLevel": 5
    }
  ]
}
```

## Limites intencionais do conteúdo

- Não foram criados atributos, perícias, talentos, profissões ou poderes novos.
- Não foram atribuídos preços, pesos, danos, alcances, bônus ou capacidades sem definição na base.
- As descrições são de catálogo. Valores e efeitos específicos continuam sob decisão do mestre e das regras da campanha.
- Os pré-requisitos estão gravados no formato reconhecido pelo motor de regras. **A checagem automática ao adquirir/adicionar um registro no Inventário ou em Veículos ainda exige integração específica no fluxo de Patrimônio**; este pacote de dados, sozinho, não bloqueia operações.

## Importação

No Mestre RPG, abra **Acervo → Importar JSON**, selecione `pacote-completo-cacadores-cacados.v1.json`, confira a prévia dos nove livros e confirme. O pacote é um envelope de importação, não é o dump de campanha. Ao importar, preserve os dados existentes quando a prévia indicar conflitos; não substitua livros sem revisar.

## Referência

Base de conteúdo: dump `dump-cacadores-e-cacas.json` fornecido pelo usuário. Foram usados nomes e chaves de regras da ficha para definir os requisitos. Dados de personagens, membros e informações particulares da campanha não foram copiados para os livros.
