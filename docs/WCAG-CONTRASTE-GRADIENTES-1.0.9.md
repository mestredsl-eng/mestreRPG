# WCAG — contraste medido sobre gradientes (evidência p/ disposição)

Complemento de `WCAG-REVIEW-1.0.9.md` (item 4, PR #318). As entradas de REVIEW por `bg-image` foram re-medidas com um avaliador que resolve `linear-gradient`/`radial-gradient` do computed style: cada parada de cor é composta sobre o fundo efetivo abaixo dela (incluindo alpha). Mesma fixture, servidor real, telas e viewports da suíte `teste-a11y-fluxos-297.mjs`.

**Isto é evidência, não disposição.** O gate humano continua pendente;
`computado-PASS`/`abaixo-3:1` são medições objetivas para acelerar
a revisão — não alteram o status REVIEW original.

## 1. Texto sobre gradiente (SC 1.4.3)

**1264 elementos medidos — 1264 computado-PASS, 0 computado-FAIL**.

| tela / fluxo | viewport | elementos | PASS | FAIL | pior razão |
|---|---|---|---|---|---|
| login→painel | celular-390 | 13 | 13 | 0 | 5.73:1 |
| campanha (visão geral) | celular-390 | 29 | 29 | 0 | 5.73:1 |
| aba Personagens | celular-390 | 36 | 36 | 0 | 5.73:1 |
| aba Diário | celular-390 | 25 | 25 | 0 | 5.73:1 |
| aba Arquivos | celular-390 | 27 | 27 | 0 | 5.73:1 |
| aba Convites | celular-390 | 29 | 29 | 0 | 5.73:1 |
| ficha detalhe | celular-390 | 59 | 59 | 0 | 5.73:1 |
| patrimônio Inventário | celular-390 | 59 | 59 | 0 | 5.73:1 |
| patrimônio Dinheiro | celular-390 | 61 | 61 | 0 | 5.73:1 |
| aba Mesa | celular-390 | 25 | 25 | 0 | 5.73:1 |
| login→painel | tablet-768 | 13 | 13 | 0 | 5.73:1 |
| campanha (visão geral) | tablet-768 | 29 | 29 | 0 | 5.73:1 |
| aba Personagens | tablet-768 | 36 | 36 | 0 | 5.73:1 |
| aba Diário | tablet-768 | 25 | 25 | 0 | 5.73:1 |
| aba Arquivos | tablet-768 | 27 | 27 | 0 | 5.73:1 |
| aba Convites | tablet-768 | 35 | 35 | 0 | 5.73:1 |
| ficha detalhe | tablet-768 | 64 | 64 | 0 | 5.73:1 |
| patrimônio Inventário | tablet-768 | 64 | 64 | 0 | 5.73:1 |
| patrimônio Dinheiro | tablet-768 | 68 | 68 | 0 | 5.73:1 |
| aba Mesa | tablet-768 | 25 | 25 | 0 | 5.73:1 |
| login→painel | desktop-1366 | 13 | 13 | 0 | 5.73:1 |
| campanha (visão geral) | desktop-1366 | 29 | 29 | 0 | 5.73:1 |
| aba Personagens | desktop-1366 | 36 | 36 | 0 | 5.73:1 |
| aba Diário | desktop-1366 | 25 | 25 | 0 | 5.73:1 |
| aba Arquivos | desktop-1366 | 27 | 27 | 0 | 5.73:1 |
| aba Convites | desktop-1366 | 35 | 35 | 0 | 5.73:1 |
| ficha detalhe | desktop-1366 | 64 | 64 | 0 | 5.73:1 |
| patrimônio Inventário | desktop-1366 | 64 | 64 | 0 | 5.73:1 |
| patrimônio Dinheiro | desktop-1366 | 68 | 68 | 0 | 5.73:1 |
| aba Mesa | desktop-1366 | 25 | 25 | 0 | 5.73:1 |
| jogador: campanha | desktop-1366 | 23 | 23 | 0 | 5.73:1 |
| jogador: personagens | desktop-1366 | 20 | 20 | 0 | 5.73:1 |
| jogador: campanha | celular-390 | 23 | 23 | 0 | 5.73:1 |
| jogador: personagens | celular-390 | 20 | 20 | 0 | 5.73:1 |
| jogador: campanha | tablet-768 | 23 | 23 | 0 | 5.73:1 |
| jogador: personagens | tablet-768 | 20 | 20 | 0 | 5.73:1 |

### Padrões computado-PASS (deduplicados por fundo+cor de texto)

| fundo(s) | cor do texto | limiar | n | pior | melhor | exemplos |
|---|---|---|---|---|---|---|
| span,button,nav,header.topo,div#root,body,html | rgb(180,169,177) | 4.5:1 | 210 | 8.08:1 | 8.08:1 | login→painel/celular-390/`span`; login→painel/celular-390/`span`; login→painel/celular-390/`span` |
| span,button.ativo,nav,header.topo,div#root,body,html | rgb(255,242,242) | 4.5:1 | 36 | 14.52:1 | 14.52:1 | login→painel/celular-390/`span`; campanha (visão geral)/celular-390/`span`; aba Personagens/celular-390/`span` |
| span,button.sair,nav,header.topo,div#root,body,html | rgb(230,154,161) | 4.5:1 | 36 | 5.73:1 | 5.73:1 | login→painel/celular-390/`span`; campanha (visão geral)/celular-390/`span`; aba Personagens/celular-390/`span` |
| button.secundario,div.linha,section.cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(232,230,227) | 4.5:1 | 36 | 11.40:1 | 11.40:1 | ficha detalhe/celular-390/`button.secundario`; ficha detalhe/celular-390/`button.secundario`; ficha detalhe/celular-390/`button.secundario` |
| button.secundario,div.abas,section.cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(201,205,211) | 4.5:1 | 36 | 8.90:1 | 8.90:1 | ficha detalhe/celular-390/`button.secundario`; ficha detalhe/celular-390/`button.secundario`; ficha detalhe/celular-390/`button.secundario` |
| th,tr,thead,table.tabela.tabela-responsiva,div,section.cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(154,160,166) | 4.5:1 | 34 | 6.48:1 | 6.48:1 | ficha detalhe/tablet-768/`th`; ficha detalhe/tablet-768/`th`; ficha detalhe/tablet-768/`th` |
| h2,div,div.linha-entre,section.cartao,main.container.container-largo,div#root,body,html | rgb(240,229,232) | 4.5:1 | 33 | 13.92:1 | 13.92:1 | campanha (visão geral)/celular-390/`h2`; aba Personagens/celular-390/`h2`; aba Diário/celular-390/`h2` |
| p.meta,div,div.linha-entre,section.cartao,main.container.container-largo,div#root,body,html | rgb(180,169,177) | 4.5:1 | 33 | 7.54:1 | 7.54:1 | campanha (visão geral)/celular-390/`p.meta`; aba Personagens/celular-390/`p.meta`; aba Diário/celular-390/`p.meta` |
| span.conexao.conexao-conectado,p.meta,div,div.linha-entre,section.cartao,main.container.container-largo,div#root,body,html | rgb(127,208,138) | 4.5:1 | 33 | 9.20:1 | 9.20:1 | campanha (visão geral)/celular-390/`span.conexao.conexao-conectado`; aba Personagens/celular-390/`span.conexao.conexao-conectado`; aba Diário/celular-390/`span.conexao.conexao-conectado` |
| button.secundario,div.linha-entre,section.cartao,main.container.container-largo,div#root,body,html | rgb(232,230,227) | 4.5:1 | 33 | 11.40:1 | 11.40:1 | campanha (visão geral)/celular-390/`button.secundario`; aba Personagens/celular-390/`button.secundario`; aba Diário/celular-390/`button.secundario` |
| button#aba-historico.secundario,div.abas,section.cartao,main.container.container-largo,div#root,body,html | rgb(201,205,211) | 4.5:1 | 33 | 8.90:1 | 8.90:1 | campanha (visão geral)/celular-390/`button#aba-historico.secundario`; aba Personagens/celular-390/`button#aba-historico.secundario`; aba Diário/celular-390/`button#aba-historico.secundario` |
| button#aba-mesa.secundario,div.abas,section.cartao,main.container.container-largo,div#root,body,html | rgb(201,205,211) | 4.5:1 | 30 | 8.90:1 | 8.90:1 | campanha (visão geral)/celular-390/`button#aba-mesa.secundario`; aba Personagens/celular-390/`button#aba-mesa.secundario`; aba Diário/celular-390/`button#aba-mesa.secundario` |
| button#aba-diario.secundario,div.abas,section.cartao,main.container.container-largo,div#root,body,html | rgb(201,205,211) | 4.5:1 | 30 | 8.90:1 | 8.90:1 | campanha (visão geral)/celular-390/`button#aba-diario.secundario`; aba Personagens/celular-390/`button#aba-diario.secundario`; aba Arquivos/celular-390/`button#aba-diario.secundario` |
| button#aba-arquivos.secundario,div.abas,section.cartao,main.container.container-largo,div#root,body,html | rgb(201,205,211) | 4.5:1 | 30 | 8.90:1 | 8.90:1 | campanha (visão geral)/celular-390/`button#aba-arquivos.secundario`; aba Personagens/celular-390/`button#aba-arquivos.secundario`; aba Diário/celular-390/`button#aba-arquivos.secundario` |
| button#aba-fichas.secundario,div.abas,section.cartao,main.container.container-largo,div#root,body,html | rgb(201,205,211) | 4.5:1 | 27 | 8.90:1 | 8.90:1 | campanha (visão geral)/celular-390/`button#aba-fichas.secundario`; aba Personagens/celular-390/`button#aba-fichas.secundario`; aba Diário/celular-390/`button#aba-fichas.secundario` |
| button#aba-regras.secundario,div.abas,section.cartao,main.container.container-largo,div#root,body,html | rgb(201,205,211) | 4.5:1 | 27 | 8.90:1 | 8.90:1 | campanha (visão geral)/celular-390/`button#aba-regras.secundario`; aba Personagens/celular-390/`button#aba-regras.secundario`; aba Diário/celular-390/`button#aba-regras.secundario` |
| button#aba-participantes.secundario,div.abas,section.cartao,main.container.container-largo,div#root,body,html | rgb(201,205,211) | 4.5:1 | 27 | 8.90:1 | 8.90:1 | campanha (visão geral)/celular-390/`button#aba-participantes.secundario`; aba Personagens/celular-390/`button#aba-participantes.secundario`; aba Diário/celular-390/`button#aba-participantes.secundario` |
| button#aba-info.secundario,div.abas,section.cartao,main.container.container-largo,div#root,body,html | rgb(201,205,211) | 4.5:1 | 27 | 8.90:1 | 8.90:1 | aba Personagens/celular-390/`button#aba-info.secundario`; aba Diário/celular-390/`button#aba-info.secundario`; aba Arquivos/celular-390/`button#aba-info.secundario` |
| button#aba-convites.secundario,div.abas,section.cartao,main.container.container-largo,div#root,body,html | rgb(201,205,211) | 4.5:1 | 24 | 8.90:1 | 8.90:1 | campanha (visão geral)/celular-390/`button#aba-convites.secundario`; aba Personagens/celular-390/`button#aba-convites.secundario`; aba Diário/celular-390/`button#aba-convites.secundario` |
| button.secundario,div.linha,div.linha-entre,section.cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(232,230,227) | 4.5:1 | 24 | 11.40:1 | 11.40:1 | aba Personagens/celular-390/`button.secundario`; aba Personagens/celular-390/`button.secundario`; ficha detalhe/celular-390/`button.secundario` |
| span,span.marca,header.topo,div#root,body,html | rgb(241,231,233) | 3:1 | 24 | 15.14:1 | 15.14:1 | login→painel/tablet-768/`span`; campanha (visão geral)/tablet-768/`span`; aba Personagens/tablet-768/`span` |
| button#aba-personagens.secundario,div.abas,section.cartao,main.container.container-largo,div#root,body,html | rgb(201,205,211) | 4.5:1 | 18 | 8.90:1 | 8.90:1 | campanha (visão geral)/celular-390/`button#aba-personagens.secundario`; aba Diário/celular-390/`button#aba-personagens.secundario`; aba Arquivos/celular-390/`button#aba-personagens.secundario` |
| p,section.cartao,div#painel-info,main.container.container-largo,div#root,body,html | rgb(238,231,232) | 4.5:1 | 18 | 14.04:1 | 14.04:1 | campanha (visão geral)/celular-390/`p`; campanha (visão geral)/celular-390/`p`; campanha (visão geral)/celular-390/`p` |
| strong,p,section.cartao,div#painel-info,main.container.container-largo,div#root,body,html | rgb(238,231,232) | 4.5:1 | 18 | 14.04:1 | 14.04:1 | campanha (visão geral)/celular-390/`strong`; campanha (visão geral)/celular-390/`strong`; campanha (visão geral)/celular-390/`strong` |
| button.perigo,div.linha,section.cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(255,255,255) | 4.5:1 | 18 | 9.00:1 | 9.00:1 | ficha detalhe/celular-390/`button.perigo`; ficha detalhe/celular-390/`button.perigo`; patrimônio Inventário/celular-390/`button.perigo` |
| h4,div.cartao.progressao-xp,div.ficha,section.cartao.ficha-cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(238,231,232) | 4.5:1 | 18 | 14.04:1 | 14.04:1 | ficha detalhe/celular-390/`h4`; ficha detalhe/celular-390/`h4`; patrimônio Inventário/celular-390/`h4` |
| p.meta,div.cartao.progressao-xp,div.ficha,section.cartao.ficha-cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(180,169,177) | 4.5:1 | 18 | 7.54:1 | 7.54:1 | ficha detalhe/celular-390/`p.meta`; ficha detalhe/celular-390/`p.meta`; patrimônio Inventário/celular-390/`p.meta` |
| span,span.marca,header.topo,div#root,body,html | rgb(241,231,233) | 4.5:1 | 12 | 15.14:1 | 15.14:1 | login→painel/celular-390/`span`; campanha (visão geral)/celular-390/`span`; aba Personagens/celular-390/`span` |
| th,tr,thead,table.tabela,section.cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(154,160,166) | 4.5:1 | 12 | 6.48:1 | 6.48:1 | aba Personagens/celular-390/`th`; aba Personagens/celular-390/`th`; aba Personagens/celular-390/`th` |
| td,tr.clicavel,tbody,table.tabela,section.cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(238,231,232) | 4.5:1 | 12 | 14.04:1 | 14.04:1 | aba Personagens/celular-390/`td`; aba Personagens/celular-390/`td`; aba Personagens/celular-390/`td` |
| th,tr,thead,table.tabela.tabela-responsiva,section.cartao,div#painel-convites,main.container.container-largo,div#root,body,html | rgb(154,160,166) | 4.5:1 | 12 | 6.48:1 | 6.48:1 | aba Convites/tablet-768/`th`; aba Convites/tablet-768/`th`; aba Convites/tablet-768/`th` |
| label,div.grade-2,form.formulario,section.cartao,div#painel-convites,main.container.container-largo,div#root,body,html | rgb(201,205,211) | 4.5:1 | 9 | 10.72:1 | 10.72:1 | aba Convites/celular-390/`label`; aba Convites/celular-390/`label`; aba Convites/celular-390/`label` |
| h2,div,div.linha,div.linha-entre,section.cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(240,229,232) | 4.5:1 | 9 | 13.92:1 | 13.92:1 | ficha detalhe/celular-390/`h2`; patrimônio Inventário/celular-390/`h2`; patrimônio Dinheiro/celular-390/`h2` |
| p.meta.ficha-dono,div,div.linha,div.linha-entre,section.cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(180,169,177) | 4.5:1 | 9 | 7.54:1 | 7.54:1 | ficha detalhe/celular-390/`p.meta.ficha-dono`; patrimônio Inventário/celular-390/`p.meta.ficha-dono`; patrimônio Dinheiro/celular-390/`p.meta.ficha-dono` |
| strong,p.meta.ficha-dono,div,div.linha,div.linha-entre,section.cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(232,234,237) | 4.5:1 | 9 | 14.20:1 | 14.20:1 | ficha detalhe/celular-390/`strong`; patrimônio Inventário/celular-390/`strong`; patrimônio Dinheiro/celular-390/`strong` |
| p.meta,section.cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(180,169,177) | 4.5:1 | 9 | 7.54:1 | 7.54:1 | ficha detalhe/celular-390/`p.meta`; patrimônio Inventário/celular-390/`p.meta`; patrimônio Dinheiro/celular-390/`p.meta` |
| button,div.linha,section.cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(255,255,255) | 4.5:1 | 9 | 8.65:1 | 8.65:1 | ficha detalhe/celular-390/`button`; patrimônio Inventário/celular-390/`button`; patrimônio Dinheiro/celular-390/`button` |
| h3,section.cartao.ficha-cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(238,231,232) | 3:1 | 9 | 14.04:1 | 14.04:1 | ficha detalhe/celular-390/`h3`; patrimônio Inventário/celular-390/`h3`; patrimônio Dinheiro/celular-390/`h3` |
| button,form.linha,div.painel-pontos | rgb(255,255,255) | 4.5:1 | 9 | 8.65:1 | 8.65:1 | ficha detalhe/celular-390/`button`; patrimônio Inventário/celular-390/`button`; patrimônio Dinheiro/celular-390/`button` |
| h3,div#ficha-secao-0.ficha-secao.ficha-secao-capa,div.ficha,section.cartao.ficha-cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(197,154,130) | 4.5:1 | 9 | 6.78:1 | 6.78:1 | ficha detalhe/celular-390/`h3`; patrimônio Inventário/celular-390/`h3`; patrimônio Dinheiro/celular-390/`h3` |
| h3,div.cartao.progressao-xp,div.ficha,section.cartao.ficha-cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(238,231,232) | 3:1 | 9 | 14.04:1 | 14.04:1 | ficha detalhe/celular-390/`h3`; patrimônio Inventário/celular-390/`h3`; patrimônio Dinheiro/celular-390/`h3` |
| p.meta,div,div.grade-2,div.cartao.progressao-xp,div.ficha,section.cartao.ficha-cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(180,169,177) | 4.5:1 | 9 | 7.54:1 | 7.54:1 | ficha detalhe/celular-390/`p.meta`; patrimônio Inventário/celular-390/`p.meta`; patrimônio Dinheiro/celular-390/`p.meta` |
| p.progresso-saldo,div,div.grade-2,div.cartao.progressao-xp,div.ficha,section.cartao.ficha-cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(238,231,232) | 4.5:1 | 9 | 14.04:1 | 14.04:1 | ficha detalhe/celular-390/`p.progresso-saldo`; patrimônio Inventário/celular-390/`p.progresso-saldo`; patrimônio Dinheiro/celular-390/`p.progresso-saldo` |
| strong,p.progresso-saldo,div,div.grade-2,div.cartao.progressao-xp,div.ficha,section.cartao.ficha-cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(238,231,232) | 4.5:1 | 9 | 14.04:1 | 14.04:1 | ficha detalhe/celular-390/`strong`; patrimônio Inventário/celular-390/`strong`; patrimônio Dinheiro/celular-390/`strong` |
| button.mini,div.linha,div.grade-2,div.cartao.progressao-xp,div.ficha,section.cartao.ficha-cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(232,230,227) | 4.5:1 | 9 | 11.40:1 | 11.40:1 | ficha detalhe/celular-390/`button.mini`; patrimônio Inventário/celular-390/`button.mini`; patrimônio Dinheiro/celular-390/`button.mini` |
| h3,section.cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(238,231,232) | 3:1 | 9 | 14.04:1 | 14.04:1 | ficha detalhe/celular-390/`h3`; patrimônio Inventário/celular-390/`h3`; patrimônio Dinheiro/celular-390/`h3` |
| button,form.formulario.linha,div,section.cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(255,255,255) | 4.5:1 | 9 | 8.65:1 | 8.65:1 | ficha detalhe/celular-390/`button`; patrimônio Inventário/celular-390/`button`; patrimônio Dinheiro/celular-390/`button` |
| h3,section.cartao.extrato-xp,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(238,231,232) | 3:1 | 9 | 14.04:1 | 14.04:1 | ficha detalhe/celular-390/`h3`; patrimônio Inventário/celular-390/`h3`; patrimônio Dinheiro/celular-390/`h3` |
| p.progresso-saldo,section.cartao.extrato-xp,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(238,231,232) | 4.5:1 | 9 | 14.04:1 | 14.04:1 | ficha detalhe/celular-390/`p.progresso-saldo`; patrimônio Inventário/celular-390/`p.progresso-saldo`; patrimônio Dinheiro/celular-390/`p.progresso-saldo` |
| strong,p.progresso-saldo,section.cartao.extrato-xp,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(138,180,255) | 3:1 | 9 | 8.19:1 | 8.19:1 | ficha detalhe/celular-390/`strong`; patrimônio Inventário/celular-390/`strong`; patrimônio Dinheiro/celular-390/`strong` |
| p.meta,section.cartao.extrato-xp,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(180,169,177) | 4.5:1 | 9 | 7.54:1 | 7.54:1 | ficha detalhe/celular-390/`p.meta`; patrimônio Inventário/celular-390/`p.meta`; patrimônio Dinheiro/celular-390/`p.meta` |
| h2,section.cartao,main.container,div#root,body,html | rgb(240,229,232) | 4.5:1 | 6 | 13.92:1 | 13.92:1 | login→painel/celular-390/`h2`; login→painel/celular-390/`h2`; login→painel/tablet-768/`h2` |
| p,section.cartao,main.container,div#root,body,html | rgb(238,231,232) | 4.5:1 | 6 | 14.04:1 | 14.04:1 | login→painel/celular-390/`p`; login→painel/celular-390/`p`; login→painel/tablet-768/`p` |
| h2,div.linha-entre,section.cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(240,229,232) | 4.5:1 | 6 | 13.92:1 | 13.92:1 | aba Personagens/celular-390/`h2`; aba Personagens/tablet-768/`h2`; aba Personagens/desktop-1366/`h2` |
| button,div.linha,div.linha-entre,section.cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(255,255,255) | 4.5:1 | 6 | 8.65:1 | 8.65:1 | aba Personagens/celular-390/`button`; aba Personagens/tablet-768/`button`; aba Personagens/desktop-1366/`button` |
| span.linha,td,tr.clicavel,tbody,table.tabela,section.cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(238,231,232) | 4.5:1 | 6 | 14.04:1 | 14.04:1 | aba Personagens/celular-390/`span.linha`; aba Personagens/celular-390/`span.linha`; aba Personagens/tablet-768/`span.linha` |
| button.secundario,aside.biblioteca-pastas,div.biblioteca,section.cartao,div#painel-arquivos,main.container.container-largo,div#root,body,html | rgb(232,230,227) | 4.5:1 | 6 | 11.40:1 | 11.40:1 | aba Arquivos/celular-390/`button.secundario`; aba Arquivos/celular-390/`button.secundario`; aba Arquivos/tablet-768/`button.secundario` |
| button.secundario,form.formulario.linha,div,section.cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(232,230,227) | 4.5:1 | 6 | 11.40:1 | 11.40:1 | ficha detalhe/celular-390/`button.secundario`; patrimônio Inventário/celular-390/`button.secundario`; ficha detalhe/tablet-768/`button.secundario` |
| button.secundario,div.linha,div,section.cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(232,230,227) | 4.5:1 | 6 | 11.40:1 | 11.40:1 | patrimônio Dinheiro/celular-390/`button.secundario`; patrimônio Dinheiro/celular-390/`button.secundario`; patrimônio Dinheiro/tablet-768/`button.secundario` |
| td.meta,tr,tbody,table.tabela.tabela-responsiva,div,section.cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(180,169,177) | 4.5:1 | 6 | 7.54:1 | 7.54:1 | ficha detalhe/tablet-768/`td.meta`; patrimônio Inventário/tablet-768/`td.meta`; patrimônio Dinheiro/tablet-768/`td.meta` |
| button,section.cartao,div#painel-info,main.container.container-largo,div#root,body,html | rgb(255,255,255) | 4.5:1 | 3 | 8.65:1 | 8.65:1 | campanha (visão geral)/celular-390/`button`; campanha (visão geral)/tablet-768/`button`; campanha (visão geral)/desktop-1366/`button` |
| button.secundario,div.abas,section.cartao,div#painel-diario,main.container.container-largo,div#root,body,html | rgb(201,205,211) | 4.5:1 | 3 | 8.90:1 | 8.90:1 | aba Diário/celular-390/`button.secundario`; aba Diário/tablet-768/`button.secundario`; aba Diário/desktop-1366/`button.secundario` |
| button.secundario,section.cartao,div#painel-diario,main.container.container-largo,div#root,body,html | rgb(232,230,227) | 4.5:1 | 3 | 11.40:1 | 11.40:1 | aba Diário/celular-390/`button.secundario`; aba Diário/tablet-768/`button.secundario`; aba Diário/desktop-1366/`button.secundario` |
| p.estado-vazio-texto,div.estado-vazio,li,ul.lista-anotacoes,section.cartao,div#painel-diario,main.container.container-largo,div#root,body,html | rgb(154,163,178) | 4.5:1 | 3 | 6.73:1 | 6.73:1 | aba Diário/celular-390/`p.estado-vazio-texto`; aba Diário/tablet-768/`p.estado-vazio-texto`; aba Diário/desktop-1366/`p.estado-vazio-texto` |
| h3,div.linha,section.cartao,div#painel-arquivos,main.container.container-largo,div#root,body,html | rgb(238,231,232) | 3:1 | 3 | 14.04:1 | 14.04:1 | aba Arquivos/celular-390/`h3`; aba Arquivos/tablet-768/`h3`; aba Arquivos/desktop-1366/`h3` |
| button,div.linha,section.cartao,div#painel-arquivos,main.container.container-largo,div#root,body,html | rgb(255,255,255) | 4.5:1 | 3 | 8.65:1 | 8.65:1 | aba Arquivos/celular-390/`button`; aba Arquivos/tablet-768/`button`; aba Arquivos/desktop-1366/`button` |
| p.estado-vazio-texto,div.estado-vazio,li,ul.lista-anotacoes,div.biblioteca-lista,div.biblioteca,section.cartao,div#painel-arquivos,main.container.container-largo,div#root,body,html | rgb(154,163,178) | 4.5:1 | 3 | 6.73:1 | 6.73:1 | aba Arquivos/celular-390/`p.estado-vazio-texto`; aba Arquivos/tablet-768/`p.estado-vazio-texto`; aba Arquivos/desktop-1366/`p.estado-vazio-texto` |
| h2,section.cartao,div#painel-convites,main.container.container-largo,div#root,body,html | rgb(240,229,232) | 4.5:1 | 3 | 13.92:1 | 13.92:1 | aba Convites/celular-390/`h2`; aba Convites/tablet-768/`h2`; aba Convites/desktop-1366/`h2` |
| label.checkbox,div.grade-2,form.formulario,section.cartao,div#painel-convites,main.container.container-largo,div#root,body,html | rgb(201,205,211) | 4.5:1 | 3 | 10.72:1 | 10.72:1 | aba Convites/celular-390/`label.checkbox`; aba Convites/tablet-768/`label.checkbox`; aba Convites/desktop-1366/`label.checkbox` |
| button,form.formulario,section.cartao,div#painel-convites,main.container.container-largo,div#root,body,html | rgb(255,255,255) | 4.5:1 | 3 | 8.65:1 | 8.65:1 | aba Convites/celular-390/`button`; aba Convites/tablet-768/`button`; aba Convites/desktop-1366/`button` |
| p.estado-vazio-texto,div.estado-vazio,section.cartao,div#painel-convites,main.container.container-largo,div#root,body,html | rgb(154,163,178) | 4.5:1 | 3 | 6.73:1 | 6.73:1 | aba Convites/celular-390/`p.estado-vazio-texto`; aba Convites/tablet-768/`p.estado-vazio-texto`; aba Convites/desktop-1366/`p.estado-vazio-texto` |
| p.meta,div.cartoes-registro,div,section.cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(180,169,177) | 4.5:1 | 3 | 7.54:1 | 7.54:1 | ficha detalhe/celular-390/`p.meta`; patrimônio Inventário/celular-390/`p.meta`; patrimônio Dinheiro/celular-390/`p.meta` |
| h4,div,section.cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(238,231,232) | 4.5:1 | 3 | 14.04:1 | 14.04:1 | patrimônio Dinheiro/celular-390/`h4`; patrimônio Dinheiro/tablet-768/`h4`; patrimônio Dinheiro/desktop-1366/`h4` |
| h2,div.linha-entre,section.cartao,div#painel-mesa,main.container.container-largo,div#root,body,html | rgb(240,229,232) | 4.5:1 | 3 | 13.92:1 | 13.92:1 | aba Mesa/celular-390/`h2`; aba Mesa/tablet-768/`h2`; aba Mesa/desktop-1366/`h2` |
| button,div.linha-entre,section.cartao,div#painel-mesa,main.container.container-largo,div#root,body,html | rgb(255,255,255) | 4.5:1 | 3 | 8.65:1 | 8.65:1 | aba Mesa/celular-390/`button`; aba Mesa/tablet-768/`button`; aba Mesa/desktop-1366/`button` |
| p.meta,section.cartao,div#painel-mesa,main.container.container-largo,div#root,body,html | rgb(180,169,177) | 4.5:1 | 3 | 7.54:1 | 7.54:1 | aba Mesa/celular-390/`p.meta`; aba Mesa/tablet-768/`p.meta`; aba Mesa/desktop-1366/`p.meta` |
| p.estado-vazio-texto,div.estado-vazio,section.cartao,div#painel-personagens,main.container.container-largo,div#root,body,html | rgb(154,163,178) | 4.5:1 | 3 | 6.73:1 | 6.73:1 | jogador: personagens/desktop-1366/`p.estado-vazio-texto`; jogador: personagens/celular-390/`p.estado-vazio-texto`; jogador: personagens/tablet-768/`p.estado-vazio-texto` |

## 2. Controles input/select/textarea — fronteira×externo (SC 1.4.11)

**147 campos medidos:** 111 com externo em gradiente (111 computado-PASS, 0 abaixo-3:1) + 36 com externo sólido (quocientes do auditor reproduzidos p/ contexto).

### Controles com externo sólido — quocientes reproduzidos (contexto p/ disposição)

São as entradas 'fronteira ambígua' da lista REVIEW: o auditor já tinha os quocientes; aqui ficam deduplicadas por (campo, fillMin, bordaMin) com o contexto de labels para a decisão humana.

| campo | fillMin | bordaMin | piorCaso | n amostras | telas | tipo | labels | placeholder |
|---|---|---|---|---|---|---|---|---|
| `select` | 1.04 | 4.29 | 4.29 | 9 | ficha detalhe/celular-390, patrimônio Inventário/celular-390, patrimônio Dinheiro/celular-390, ficha detalhe/tablet-768 | select | 0 | não |
| `input` | 1.04 | 4.29 | 4.29 | 18 | ficha detalhe/celular-390, patrimônio Inventário/celular-390, patrimônio Dinheiro/celular-390, ficha detalhe/tablet-768 | number | 0 | não |
| `input` | 1.02 | 4.04 | 4.04 | 9 | ficha detalhe/celular-390, patrimônio Inventário/celular-390, patrimônio Dinheiro/celular-390, ficha detalhe/tablet-768 | text | 0 | sim |

## 3. Indicador de foco × gradiente externo

- **login (foco)** (`button`, outline 2px): pior contraste vs gradiente externo = **3.89:1** → computado-PASS (limiar 3:1).
- **campanha (foco)** (`button.secundario`, outline 2px): pior contraste vs gradiente externo = **3.89:1** → computado-PASS (limiar 3:1).

## Notas metodológicas

- O pior contraste é o mínimo sobre uma AMOSTRAGEM do gradiente (9 pontos por segmento, interpolação sRGB entre paradas) — necessário porque a razão de contraste é não-linear na luminância: quando a luminância do texto/borda fica entre as das paradas, o mínimo real ocorre dentro do segmento, não nas extremidades.
- Paradas com alpha < 1 foram compostas sobre o fundo efetivo abaixo do gradiente (mesma composição `sobre()` do auditor).
- Texto: limiar 4.5:1 normal, 3.0:1 grande (≥24px ou ≥18.66px negrito) — idêntico ao `grande()` de `wcag-avaliador-297.mjs`.
- Controles (1.4.11): por parada de gradiente externa, usa-se o MELHOR identificador (preenchimento×externo ou borda×externo ≥3:1); o veredito final é o PIOR desses melhores — ou seja, PASS só se a fronteira for identificável em qualquer pixel do gradiente.
- `abaixo-3:1` não é violação confirmada: a SC 1.4.11 admite contexto adjacente (label visível) como alternativa à fronteira — a decisão é humana.
- Entradas 'select: affordance nativa do UA' e 'stepper nativo' envolvem renderização do user-agent não mensurável via DOM — permanecem para disposição humana mesmo com quocientes calculados.

## 4. Análise de correção de borda (opcional — insumo p/ decisão)

Cálculo offline (mesma fórmula WCAG) das cores de borda candidatas do próprio tema contra o conjunto de superfícies escuras onde os campos aparecem (paradas dos gradientes `.cartao`/`.ficha-secao`/body/html, todas entre ~#0b0a0f e ~#211b26). Borda com alpha é composta sobre cada externo antes do quociente — reproduz os ~1.3:1 medidos:

| cor de borda candidata | contraste vs superfícies (min–max) | atinge 3:1? |
|---|---|---|
| atual `rgba(154,130,145,.20–.24)` | 1.27–1.42:1 | não |
| `--horror-borda` `rgba(154,111,125,.24)` | 1.29–1.34:1 | não |
| `--horror-borda-forte` `rgba(177,91,105,.48)` | 1.81–1.84:1 | não |
| `--horror-vinho` `#8d3d4b` | 2.32–2.73:1 | não |
| **`--horror-vinho-claro` `#b85c69`** (já usado em foco/acentos) | **3.82–4.48:1** | **sim** |
| `--horror-ambar` `#b99a62` | 6.29–7.38:1 | sim |
| `--horror-texto-suave` `#b4a9b1` | 7.40–8.69:1 | sim |
| neutro `#5a6272` (sugestão intermediária) | 2.74–3.22:1 | **não uniforme** — falha nas superfícies mais escuras |
| neutro `#6a7285` | 3.49–4.09:1 | sim |
| neutro `#8a93a8` | 5.46–6.41:1 | sim |

Se a disposição humana decidir reforçar a fronteira dos campos, basta apontar `border-color` de `input`/`select`/`textarea` para `--horror-vinho-claro` (ou um tom intermediário entre vinho e âmbar) — uma alteração de tema de uma linha, sem tocar markup/JS; se preferir tom neutro, `#6a7285` também atinge 3:1 em todas as superfícies (`#5a6272` NÃO — ver tabela). Alternativa sem mudança visual: aceitar a identificação por label/contexto adjacente, prevista na própria SC 1.4.11. **Ambas as saídas dependem de decisão humana — este documento só quantifica o custo de cada uma.**
