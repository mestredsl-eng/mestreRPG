# WCAG — contraste medido sobre gradientes (evidência p/ disposição)

Complemento de `WCAG-REVIEW-1.0.9.md` (item 4, PR #318). As entradas de REVIEW por `bg-image` foram re-medidas com um avaliador que resolve `linear-gradient`/`radial-gradient` do computed style: cada parada de cor é composta sobre o fundo efetivo abaixo dela (incluindo alpha). Mesma fixture, servidor real, telas e viewports da suíte `teste-a11y-fluxos-297.mjs`.

**Isto é evidência, não disposição.** O gate humano continua pendente;
`computado-PASS`/`abaixo-3:1` são medições objetivas para acelerar
a revisão — não alteram o status REVIEW original.

## 1. Texto sobre gradiente (SC 1.4.3)

**1209 elementos medidos — 1209 computado-PASS, 0 computado-FAIL**.

| tela / fluxo | viewport | elementos | PASS | FAIL | pior razão |
|---|---|---|---|---|---|
| login→painel | celular-390 | 13 | 13 | 0 | 5.73:1 |
| campanha (visão geral) | celular-390 | 28 | 28 | 0 | 5.73:1 |
| aba Personagens | celular-390 | 35 | 35 | 0 | 5.73:1 |
| aba Diário | celular-390 | 24 | 24 | 0 | 5.56:1 |
| aba Arquivos | celular-390 | 26 | 26 | 0 | 5.56:1 |
| aba Convites | celular-390 | 27 | 27 | 0 | 5.73:1 |
| ficha detalhe | celular-390 | 56 | 56 | 0 | 5.73:1 |
| patrimônio Inventário | celular-390 | 56 | 56 | 0 | 5.73:1 |
| patrimônio Dinheiro | celular-390 | 58 | 58 | 0 | 5.73:1 |
| aba Mesa | celular-390 | 24 | 24 | 0 | 5.73:1 |
| login→painel | tablet-768 | 13 | 13 | 0 | 5.73:1 |
| campanha (visão geral) | tablet-768 | 28 | 28 | 0 | 5.73:1 |
| aba Personagens | tablet-768 | 35 | 35 | 0 | 5.73:1 |
| aba Diário | tablet-768 | 24 | 24 | 0 | 5.56:1 |
| aba Arquivos | tablet-768 | 26 | 26 | 0 | 5.56:1 |
| aba Convites | tablet-768 | 33 | 33 | 0 | 5.73:1 |
| ficha detalhe | tablet-768 | 61 | 61 | 0 | 5.73:1 |
| patrimônio Inventário | tablet-768 | 61 | 61 | 0 | 5.73:1 |
| patrimônio Dinheiro | tablet-768 | 65 | 65 | 0 | 5.73:1 |
| aba Mesa | tablet-768 | 24 | 24 | 0 | 5.73:1 |
| login→painel | desktop-1366 | 13 | 13 | 0 | 5.73:1 |
| campanha (visão geral) | desktop-1366 | 28 | 28 | 0 | 5.73:1 |
| aba Personagens | desktop-1366 | 35 | 35 | 0 | 5.73:1 |
| aba Diário | desktop-1366 | 24 | 24 | 0 | 5.56:1 |
| aba Arquivos | desktop-1366 | 26 | 26 | 0 | 5.56:1 |
| aba Convites | desktop-1366 | 33 | 33 | 0 | 5.73:1 |
| ficha detalhe | desktop-1366 | 61 | 61 | 0 | 5.73:1 |
| patrimônio Inventário | desktop-1366 | 61 | 61 | 0 | 5.73:1 |
| patrimônio Dinheiro | desktop-1366 | 65 | 65 | 0 | 5.73:1 |
| aba Mesa | desktop-1366 | 24 | 24 | 0 | 5.73:1 |
| jogador: campanha | desktop-1366 | 21 | 21 | 0 | 5.73:1 |
| jogador: personagens | desktop-1366 | 19 | 19 | 0 | 5.73:1 |
| jogador: campanha | celular-390 | 22 | 22 | 0 | 5.73:1 |
| jogador: personagens | celular-390 | 19 | 19 | 0 | 5.73:1 |
| jogador: campanha | tablet-768 | 22 | 22 | 0 | 5.73:1 |
| jogador: personagens | tablet-768 | 19 | 19 | 0 | 5.73:1 |

### Padrões computado-PASS (deduplicados por fundo+cor de texto)

| fundo(s) | cor do texto | limiar | n | pior | melhor | exemplos |
|---|---|---|---|---|---|---|
| button.secundario,div.abas,section.cartao,main.container.container-largo,div#root,body,html | rgb(201,205,211) | 4.5:1 | 311 | 8.90:1 | 10.72:1 | campanha (visão geral)/celular-390/`button.secundario`; campanha (visão geral)/celular-390/`button.secundario`; campanha (visão geral)/celular-390/`button.secundario` |
| span,button,nav,header.topo,div#root,body,html | rgb(180,169,177) | 4.5:1 | 210 | 8.08:1 | 8.08:1 | login→painel/celular-390/`span`; login→painel/celular-390/`span`; login→painel/celular-390/`span` |
| span,button.ativo,nav,header.topo,div#root,body,html | rgb(255,242,242) | 4.5:1 | 36 | 14.52:1 | 14.52:1 | login→painel/celular-390/`span`; campanha (visão geral)/celular-390/`span`; aba Personagens/celular-390/`span` |
| span,button.sair,nav,header.topo,div#root,body,html | rgb(230,154,161) | 4.5:1 | 36 | 5.73:1 | 5.73:1 | login→painel/celular-390/`span`; campanha (visão geral)/celular-390/`span`; aba Personagens/celular-390/`span` |
| th,tr,thead,table.tabela.tabela-responsiva,div,section.cartao,main.container.container-largo,div#root,body,html | rgb(154,160,166) | 4.5:1 | 34 | 6.48:1 | 6.48:1 | ficha detalhe/tablet-768/`th`; ficha detalhe/tablet-768/`th`; ficha detalhe/tablet-768/`th` |
| h2,div,div.linha-entre,section.cartao,main.container.container-largo,div#root,body,html | rgb(240,229,232) | 4.5:1 | 33 | 13.92:1 | 13.92:1 | campanha (visão geral)/celular-390/`h2`; aba Personagens/celular-390/`h2`; aba Diário/celular-390/`h2` |
| p.meta,div,div.linha-entre,section.cartao,main.container.container-largo,div#root,body,html | rgb(180,169,177) | 4.5:1 | 33 | 7.54:1 | 7.54:1 | campanha (visão geral)/celular-390/`p.meta`; aba Personagens/celular-390/`p.meta`; aba Diário/celular-390/`p.meta` |
| button.secundario,div.linha-entre,section.cartao,main.container.container-largo,div#root,body,html | rgb(232,230,227) | 4.5:1 | 33 | 11.40:1 | 11.40:1 | campanha (visão geral)/celular-390/`button.secundario`; aba Personagens/celular-390/`button.secundario`; aba Diário/celular-390/`button.secundario` |
| button.secundario,div.linha,div.linha-entre,section.cartao,main.container.container-largo,div#root,body,html | rgb(232,230,227) | 4.5:1 | 24 | 11.40:1 | 11.40:1 | aba Personagens/celular-390/`button.secundario`; aba Personagens/celular-390/`button.secundario`; ficha detalhe/celular-390/`button.secundario` |
| span,span.marca,header.topo,div#root,body,html | rgb(241,231,233) | 3:1 | 24 | 15.14:1 | 15.14:1 | login→painel/tablet-768/`span`; campanha (visão geral)/tablet-768/`span`; aba Personagens/tablet-768/`span` |
| p,section.cartao,main.container.container-largo,div#root,body,html | rgb(238,231,232) | 4.5:1 | 21 | 14.04:1 | 14.04:1 | campanha (visão geral)/celular-390/`p`; campanha (visão geral)/celular-390/`p`; campanha (visão geral)/celular-390/`p` |
| strong,p,section.cartao,main.container.container-largo,div#root,body,html | rgb(238,231,232) | 4.5:1 | 18 | 14.04:1 | 14.04:1 | campanha (visão geral)/celular-390/`strong`; campanha (visão geral)/celular-390/`strong`; campanha (visão geral)/celular-390/`strong` |
| button.secundario,div.linha,section.cartao,main.container.container-largo,div#root,body,html | rgb(232,230,227) | 4.5:1 | 18 | 11.40:1 | 11.40:1 | ficha detalhe/celular-390/`button.secundario`; ficha detalhe/celular-390/`button.secundario`; patrimônio Inventário/celular-390/`button.secundario` |
| button.perigo,div.linha,section.cartao,main.container.container-largo,div#root,body,html | rgb(255,255,255) | 4.5:1 | 18 | 9.00:1 | 9.00:1 | ficha detalhe/celular-390/`button.perigo`; ficha detalhe/celular-390/`button.perigo`; patrimônio Inventário/celular-390/`button.perigo` |
| h4,div.cartao.progressao-xp,div.ficha,section.cartao.ficha-cartao,main.container.container-largo,div#root,body,html | rgb(238,231,232) | 4.5:1 | 18 | 14.04:1 | 14.04:1 | ficha detalhe/celular-390/`h4`; ficha detalhe/celular-390/`h4`; patrimônio Inventário/celular-390/`h4` |
| p.meta,div.cartao.progressao-xp,div.ficha,section.cartao.ficha-cartao,main.container.container-largo,div#root,body,html | rgb(180,169,177) | 4.5:1 | 18 | 7.54:1 | 7.54:1 | ficha detalhe/celular-390/`p.meta`; ficha detalhe/celular-390/`p.meta`; patrimônio Inventário/celular-390/`p.meta` |
| span,span.marca,header.topo,div#root,body,html | rgb(241,231,233) | 4.5:1 | 12 | 15.14:1 | 15.14:1 | login→painel/celular-390/`span`; campanha (visão geral)/celular-390/`span`; aba Personagens/celular-390/`span` |
| th,tr,thead,table.tabela,section.cartao,main.container.container-largo,div#root,body,html | rgb(154,160,166) | 4.5:1 | 12 | 6.48:1 | 6.48:1 | aba Personagens/celular-390/`th`; aba Personagens/celular-390/`th`; aba Personagens/celular-390/`th` |
| td,tr.clicavel,tbody,table.tabela,section.cartao,main.container.container-largo,div#root,body,html | rgb(238,231,232) | 4.5:1 | 12 | 14.04:1 | 14.04:1 | aba Personagens/celular-390/`td`; aba Personagens/celular-390/`td`; aba Personagens/celular-390/`td` |
| button,div.linha,section.cartao,main.container.container-largo,div#root,body,html | rgb(255,255,255) | 4.5:1 | 12 | 8.65:1 | 8.65:1 | aba Arquivos/celular-390/`button`; ficha detalhe/celular-390/`button`; patrimônio Inventário/celular-390/`button` |
| p.meta,section.cartao,main.container.container-largo,div#root,body,html | rgb(180,169,177) | 4.5:1 | 12 | 7.54:1 | 7.54:1 | ficha detalhe/celular-390/`p.meta`; patrimônio Inventário/celular-390/`p.meta`; patrimônio Dinheiro/celular-390/`p.meta` |
| th,tr,thead,table.tabela.tabela-responsiva,section.cartao,main.container.container-largo,div#root,body,html | rgb(154,160,166) | 4.5:1 | 12 | 6.48:1 | 6.48:1 | aba Convites/tablet-768/`th`; aba Convites/tablet-768/`th`; aba Convites/tablet-768/`th` |
| h2,div.linha-entre,section.cartao,main.container.container-largo,div#root,body,html | rgb(240,229,232) | 4.5:1 | 9 | 13.92:1 | 13.92:1 | aba Personagens/celular-390/`h2`; aba Mesa/celular-390/`h2`; aba Personagens/tablet-768/`h2` |
| label,div.grade-2,form.formulario,section.cartao,main.container.container-largo,div#root,body,html | rgb(201,205,211) | 4.5:1 | 9 | 10.72:1 | 10.72:1 | aba Convites/celular-390/`label`; aba Convites/celular-390/`label`; aba Convites/celular-390/`label` |
| h2,div,div.linha,div.linha-entre,section.cartao,main.container.container-largo,div#root,body,html | rgb(240,229,232) | 4.5:1 | 9 | 13.92:1 | 13.92:1 | ficha detalhe/celular-390/`h2`; patrimônio Inventário/celular-390/`h2`; patrimônio Dinheiro/celular-390/`h2` |
| p.meta.ficha-dono,div,div.linha,div.linha-entre,section.cartao,main.container.container-largo,div#root,body,html | rgb(180,169,177) | 4.5:1 | 9 | 7.54:1 | 7.54:1 | ficha detalhe/celular-390/`p.meta.ficha-dono`; patrimônio Inventário/celular-390/`p.meta.ficha-dono`; patrimônio Dinheiro/celular-390/`p.meta.ficha-dono` |
| strong,p.meta.ficha-dono,div,div.linha,div.linha-entre,section.cartao,main.container.container-largo,div#root,body,html | rgb(232,234,237) | 4.5:1 | 9 | 14.20:1 | 14.20:1 | ficha detalhe/celular-390/`strong`; patrimônio Inventário/celular-390/`strong`; patrimônio Dinheiro/celular-390/`strong` |
| h3,section.cartao.ficha-cartao,main.container.container-largo,div#root,body,html | rgb(238,231,232) | 3:1 | 9 | 14.04:1 | 14.04:1 | ficha detalhe/celular-390/`h3`; patrimônio Inventário/celular-390/`h3`; patrimônio Dinheiro/celular-390/`h3` |
| button,form.linha,div.painel-pontos | rgb(255,255,255) | 4.5:1 | 9 | 8.65:1 | 8.65:1 | ficha detalhe/celular-390/`button`; patrimônio Inventário/celular-390/`button`; patrimônio Dinheiro/celular-390/`button` |
| h3,div#ficha-secao-0.ficha-secao.ficha-secao-capa,div.ficha,section.cartao.ficha-cartao,main.container.container-largo,div#root,body,html | rgb(197,154,130) | 4.5:1 | 9 | 6.78:1 | 6.78:1 | ficha detalhe/celular-390/`h3`; patrimônio Inventário/celular-390/`h3`; patrimônio Dinheiro/celular-390/`h3` |
| h3,div.cartao.progressao-xp,div.ficha,section.cartao.ficha-cartao,main.container.container-largo,div#root,body,html | rgb(238,231,232) | 3:1 | 9 | 14.04:1 | 14.04:1 | ficha detalhe/celular-390/`h3`; patrimônio Inventário/celular-390/`h3`; patrimônio Dinheiro/celular-390/`h3` |
| p.meta,div,div.grade-2,div.cartao.progressao-xp,div.ficha,section.cartao.ficha-cartao,main.container.container-largo,div#root,body,html | rgb(180,169,177) | 4.5:1 | 9 | 7.54:1 | 7.54:1 | ficha detalhe/celular-390/`p.meta`; patrimônio Inventário/celular-390/`p.meta`; patrimônio Dinheiro/celular-390/`p.meta` |
| p.progresso-saldo,div,div.grade-2,div.cartao.progressao-xp,div.ficha,section.cartao.ficha-cartao,main.container.container-largo,div#root,body,html | rgb(238,231,232) | 4.5:1 | 9 | 14.04:1 | 14.04:1 | ficha detalhe/celular-390/`p.progresso-saldo`; patrimônio Inventário/celular-390/`p.progresso-saldo`; patrimônio Dinheiro/celular-390/`p.progresso-saldo` |
| strong,p.progresso-saldo,div,div.grade-2,div.cartao.progressao-xp,div.ficha,section.cartao.ficha-cartao,main.container.container-largo,div#root,body,html | rgb(238,231,232) | 4.5:1 | 9 | 14.04:1 | 14.04:1 | ficha detalhe/celular-390/`strong`; patrimônio Inventário/celular-390/`strong`; patrimônio Dinheiro/celular-390/`strong` |
| button.mini,div.linha,div.grade-2,div.cartao.progressao-xp,div.ficha,section.cartao.ficha-cartao,main.container.container-largo,div#root,body,html | rgb(232,230,227) | 4.5:1 | 9 | 11.40:1 | 11.40:1 | ficha detalhe/celular-390/`button.mini`; patrimônio Inventário/celular-390/`button.mini`; patrimônio Dinheiro/celular-390/`button.mini` |
| h3,section.cartao,main.container.container-largo,div#root,body,html | rgb(238,231,232) | 3:1 | 9 | 14.04:1 | 14.04:1 | ficha detalhe/celular-390/`h3`; patrimônio Inventário/celular-390/`h3`; patrimônio Dinheiro/celular-390/`h3` |
| button,form.formulario.linha,div,section.cartao,main.container.container-largo,div#root,body,html | rgb(255,255,255) | 4.5:1 | 9 | 8.65:1 | 8.65:1 | ficha detalhe/celular-390/`button`; patrimônio Inventário/celular-390/`button`; patrimônio Dinheiro/celular-390/`button` |
| h3,section.cartao.extrato-xp,main.container.container-largo,div#root,body,html | rgb(238,231,232) | 3:1 | 9 | 14.04:1 | 14.04:1 | ficha detalhe/celular-390/`h3`; patrimônio Inventário/celular-390/`h3`; patrimônio Dinheiro/celular-390/`h3` |
| p.progresso-saldo,section.cartao.extrato-xp,main.container.container-largo,div#root,body,html | rgb(238,231,232) | 4.5:1 | 9 | 14.04:1 | 14.04:1 | ficha detalhe/celular-390/`p.progresso-saldo`; patrimônio Inventário/celular-390/`p.progresso-saldo`; patrimônio Dinheiro/celular-390/`p.progresso-saldo` |
| strong,p.progresso-saldo,section.cartao.extrato-xp,main.container.container-largo,div#root,body,html | rgb(138,180,255) | 3:1 | 9 | 8.19:1 | 8.19:1 | ficha detalhe/celular-390/`strong`; patrimônio Inventário/celular-390/`strong`; patrimônio Dinheiro/celular-390/`strong` |
| p.meta,section.cartao.extrato-xp,main.container.container-largo,div#root,body,html | rgb(180,169,177) | 4.5:1 | 9 | 7.54:1 | 7.54:1 | ficha detalhe/celular-390/`p.meta`; patrimônio Inventário/celular-390/`p.meta`; patrimônio Dinheiro/celular-390/`p.meta` |
| h2,section.cartao,main.container,div#root,body,html | rgb(240,229,232) | 4.5:1 | 6 | 13.92:1 | 13.92:1 | login→painel/celular-390/`h2`; login→painel/celular-390/`h2`; login→painel/tablet-768/`h2` |
| p,section.cartao,main.container,div#root,body,html | rgb(238,231,232) | 4.5:1 | 6 | 14.04:1 | 14.04:1 | login→painel/celular-390/`p`; login→painel/celular-390/`p`; login→painel/tablet-768/`p` |
| button,div.linha,div.linha-entre,section.cartao,main.container.container-largo,div#root,body,html | rgb(255,255,255) | 4.5:1 | 6 | 8.65:1 | 8.65:1 | aba Personagens/celular-390/`button`; aba Personagens/tablet-768/`button`; aba Personagens/desktop-1366/`button` |
| span.linha,td,tr.clicavel,tbody,table.tabela,section.cartao,main.container.container-largo,div#root,body,html | rgb(238,231,232) | 4.5:1 | 6 | 14.04:1 | 14.04:1 | aba Personagens/celular-390/`span.linha`; aba Personagens/celular-390/`span.linha`; aba Personagens/tablet-768/`span.linha` |
| button.secundario,aside.biblioteca-pastas,div.biblioteca,section.cartao,main.container.container-largo,div#root,body,html | rgb(232,230,227) | 4.5:1 | 6 | 11.40:1 | 11.40:1 | aba Arquivos/celular-390/`button.secundario`; aba Arquivos/celular-390/`button.secundario`; aba Arquivos/tablet-768/`button.secundario` |
| button.secundario,form.formulario.linha,div,section.cartao,main.container.container-largo,div#root,body,html | rgb(232,230,227) | 4.5:1 | 6 | 11.40:1 | 11.40:1 | ficha detalhe/celular-390/`button.secundario`; patrimônio Inventário/celular-390/`button.secundario`; ficha detalhe/tablet-768/`button.secundario` |
| button.secundario,div.linha,div,section.cartao,main.container.container-largo,div#root,body,html | rgb(232,230,227) | 4.5:1 | 6 | 11.40:1 | 11.40:1 | patrimônio Dinheiro/celular-390/`button.secundario`; patrimônio Dinheiro/celular-390/`button.secundario`; patrimônio Dinheiro/tablet-768/`button.secundario` |
| td.meta,tr,tbody,table.tabela.tabela-responsiva,div,section.cartao,main.container.container-largo,div#root,body,html | rgb(180,169,177) | 4.5:1 | 6 | 7.54:1 | 7.54:1 | ficha detalhe/tablet-768/`td.meta`; patrimônio Inventário/tablet-768/`td.meta`; patrimônio Dinheiro/tablet-768/`td.meta` |
| button,section.cartao,main.container.container-largo,div#root,body,html | rgb(255,255,255) | 4.5:1 | 3 | 8.65:1 | 8.65:1 | campanha (visão geral)/celular-390/`button`; campanha (visão geral)/tablet-768/`button`; campanha (visão geral)/desktop-1366/`button` |
| button.secundario,section.cartao,main.container.container-largo,div#root,body,html | rgb(232,230,227) | 4.5:1 | 3 | 11.40:1 | 11.40:1 | aba Diário/celular-390/`button.secundario`; aba Diário/tablet-768/`button.secundario`; aba Diário/desktop-1366/`button.secundario` |
| li.dica,ul.lista-anotacoes,section.cartao,main.container.container-largo,div#root,body,html | rgb(139,147,167) | 4.5:1 | 3 | 5.56:1 | 5.56:1 | aba Diário/celular-390/`li.dica`; aba Diário/tablet-768/`li.dica`; aba Diário/desktop-1366/`li.dica` |
| h3,div.linha,section.cartao,main.container.container-largo,div#root,body,html | rgb(238,231,232) | 3:1 | 3 | 14.04:1 | 14.04:1 | aba Arquivos/celular-390/`h3`; aba Arquivos/tablet-768/`h3`; aba Arquivos/desktop-1366/`h3` |
| li.dica,ul.lista-anotacoes,div.biblioteca-lista,div.biblioteca,section.cartao,main.container.container-largo,div#root,body,html | rgb(139,147,167) | 4.5:1 | 3 | 5.56:1 | 5.56:1 | aba Arquivos/celular-390/`li.dica`; aba Arquivos/tablet-768/`li.dica`; aba Arquivos/desktop-1366/`li.dica` |
| h2,section.cartao,main.container.container-largo,div#root,body,html | rgb(240,229,232) | 4.5:1 | 3 | 13.92:1 | 13.92:1 | aba Convites/celular-390/`h2`; aba Convites/tablet-768/`h2`; aba Convites/desktop-1366/`h2` |
| label.checkbox,div.grade-2,form.formulario,section.cartao,main.container.container-largo,div#root,body,html | rgb(201,205,211) | 4.5:1 | 3 | 10.72:1 | 10.72:1 | aba Convites/celular-390/`label.checkbox`; aba Convites/tablet-768/`label.checkbox`; aba Convites/desktop-1366/`label.checkbox` |
| button,form.formulario,section.cartao,main.container.container-largo,div#root,body,html | rgb(255,255,255) | 4.5:1 | 3 | 8.65:1 | 8.65:1 | aba Convites/celular-390/`button`; aba Convites/tablet-768/`button`; aba Convites/desktop-1366/`button` |
| p.meta,div.cartoes-registro,div,section.cartao,main.container.container-largo,div#root,body,html | rgb(180,169,177) | 4.5:1 | 3 | 7.54:1 | 7.54:1 | ficha detalhe/celular-390/`p.meta`; patrimônio Inventário/celular-390/`p.meta`; patrimônio Dinheiro/celular-390/`p.meta` |
| h4,div,section.cartao,main.container.container-largo,div#root,body,html | rgb(238,231,232) | 4.5:1 | 3 | 14.04:1 | 14.04:1 | patrimônio Dinheiro/celular-390/`h4`; patrimônio Dinheiro/tablet-768/`h4`; patrimônio Dinheiro/desktop-1366/`h4` |
| button,div.linha-entre,section.cartao,main.container.container-largo,div#root,body,html | rgb(255,255,255) | 4.5:1 | 3 | 8.65:1 | 8.65:1 | aba Mesa/celular-390/`button`; aba Mesa/tablet-768/`button`; aba Mesa/desktop-1366/`button` |

## 2. Controles input/select/textarea — fronteira×externo (SC 1.4.11)

**147 campos medidos:** 111 com externo em gradiente (0 computado-PASS, 111 abaixo-3:1) + 36 com externo sólido (quocientes do auditor reproduzidos p/ contexto).

### Controles sobre gradiente abaixo de 3:1 (pior caso)

| tela | viewport | campo | tipo | fillMin | bordaMin | piorCaso | contexto |
|---|---|---|---|---|---|---|---|
| aba Personagens | celular-390 | `input` | input | 1.01 | 1.29 | 1.29 | search · placeholder |
| aba Personagens | celular-390 | `select` | select | 1.01 | 1.29 | 1.29 | select |
| aba Arquivos | celular-390 | `input` | input | 1.01 | 1.29 | 1.29 | text · placeholder |
| aba Arquivos | celular-390 | `select` | select | 1.01 | 1.29 | 1.29 | select |
| aba Convites | celular-390 | `select` | select | 1 | 1.28 | 1.28 | select · 1 label(is) · Papel inicial
Jogador
Espectad |
| aba Convites | celular-390 | `input` | input | 1 | 1.28 | 1.28 | number · 1 label(is) · placeholder · Máx. de usos |
| aba Convites | celular-390 | `input` | input | 1 | 1.28 | 1.28 | number · 1 label(is) · placeholder · Expira em (horas) |
| aba Convites | celular-390 | `input` | input | 1 | — | 1 | checkbox · 1 label(is) · Exigir aprovação do mestre |
| ficha detalhe | celular-390 | `select` | select | 1.01 | 1.29 | 1.29 | select |
| ficha detalhe | celular-390 | `input` | input | 1.01 | 1.29 | 1.29 | number |
| ficha detalhe | celular-390 | `input` | input | 1.01 | 1.29 | 1.29 | text · placeholder |
| ficha detalhe | celular-390 | `input` | input | 1.01 | 1.29 | 1.29 | text · placeholder |
| ficha detalhe | celular-390 | `select` | select | 1.01 | 1.29 | 1.29 | select |
| ficha detalhe | celular-390 | `select` | select | 1 | 1.28 | 1.28 | select |
| ficha detalhe | celular-390 | `input` | input | 1 | 1.28 | 1.28 | text · placeholder |
| ficha detalhe | celular-390 | `input` | input | 1 | 1.28 | 1.28 | number |
| ficha detalhe | celular-390 | `input` | input | 1 | 1.28 | 1.28 | text · placeholder |
| ficha detalhe | celular-390 | `input` | input | 1 | 1.28 | 1.28 | number · placeholder |
| ficha detalhe | celular-390 | `input` | input | 1 | 1.28 | 1.28 | text · placeholder |
| patrimônio Inventário | celular-390 | `select` | select | 1.01 | 1.29 | 1.29 | select |
| patrimônio Inventário | celular-390 | `input` | input | 1.01 | 1.29 | 1.29 | number |
| patrimônio Inventário | celular-390 | `input` | input | 1.01 | 1.29 | 1.29 | text · placeholder |
| patrimônio Inventário | celular-390 | `input` | input | 1.01 | 1.29 | 1.29 | text · placeholder |
| patrimônio Inventário | celular-390 | `select` | select | 1.01 | 1.29 | 1.29 | select |
| patrimônio Inventário | celular-390 | `select` | select | 1 | 1.28 | 1.28 | select |
| patrimônio Inventário | celular-390 | `input` | input | 1 | 1.28 | 1.28 | text · placeholder |
| patrimônio Inventário | celular-390 | `input` | input | 1 | 1.28 | 1.28 | number |
| patrimônio Inventário | celular-390 | `input` | input | 1 | 1.28 | 1.28 | text · placeholder |
| patrimônio Inventário | celular-390 | `input` | input | 1 | 1.28 | 1.28 | number · placeholder |
| patrimônio Inventário | celular-390 | `input` | input | 1 | 1.28 | 1.28 | text · placeholder |
| patrimônio Dinheiro | celular-390 | `select` | select | 1.01 | 1.29 | 1.29 | select |
| patrimônio Dinheiro | celular-390 | `input` | input | 1.01 | 1.29 | 1.29 | number |
| patrimônio Dinheiro | celular-390 | `input` | input | 1.01 | 1.29 | 1.29 | text · placeholder |
| patrimônio Dinheiro | celular-390 | `select` | select | 1 | 1.28 | 1.28 | select |
| patrimônio Dinheiro | celular-390 | `select` | select | 1 | 1.28 | 1.28 | select |
| patrimônio Dinheiro | celular-390 | `input` | input | 1 | 1.28 | 1.28 | number · placeholder |
| patrimônio Dinheiro | celular-390 | `input` | input | 1 | 1.28 | 1.28 | text · placeholder |
| aba Personagens | tablet-768 | `input` | input | 1.01 | 1.29 | 1.29 | search · placeholder |
| aba Personagens | tablet-768 | `select` | select | 1.01 | 1.29 | 1.29 | select |
| aba Arquivos | tablet-768 | `input` | input | 1.01 | 1.29 | 1.29 | text · placeholder |
| aba Arquivos | tablet-768 | `select` | select | 1.01 | 1.29 | 1.29 | select |
| aba Convites | tablet-768 | `select` | select | 1 | 1.28 | 1.28 | select · 1 label(is) · Papel inicial
Jogador
Espectad |
| aba Convites | tablet-768 | `input` | input | 1 | 1.28 | 1.28 | number · 1 label(is) · placeholder · Máx. de usos |
| aba Convites | tablet-768 | `input` | input | 1 | 1.28 | 1.28 | number · 1 label(is) · placeholder · Expira em (horas) |
| aba Convites | tablet-768 | `input` | input | 1 | — | 1 | checkbox · 1 label(is) · Exigir aprovação do mestre |
| ficha detalhe | tablet-768 | `select` | select | 1.01 | 1.29 | 1.29 | select |
| ficha detalhe | tablet-768 | `input` | input | 1.01 | 1.29 | 1.29 | number |
| ficha detalhe | tablet-768 | `input` | input | 1.01 | 1.29 | 1.29 | text · placeholder |
| ficha detalhe | tablet-768 | `input` | input | 1.01 | 1.29 | 1.29 | text · placeholder |
| ficha detalhe | tablet-768 | `select` | select | 1.01 | 1.29 | 1.29 | select |
| ficha detalhe | tablet-768 | `select` | select | 1 | 1.28 | 1.28 | select |
| ficha detalhe | tablet-768 | `input` | input | 1 | 1.28 | 1.28 | text · placeholder |
| ficha detalhe | tablet-768 | `input` | input | 1 | 1.28 | 1.28 | number |
| ficha detalhe | tablet-768 | `input` | input | 1 | 1.28 | 1.28 | text · placeholder |
| ficha detalhe | tablet-768 | `input` | input | 1 | 1.28 | 1.28 | number · placeholder |
| ficha detalhe | tablet-768 | `input` | input | 1 | 1.28 | 1.28 | text · placeholder |
| patrimônio Inventário | tablet-768 | `select` | select | 1.01 | 1.29 | 1.29 | select |
| patrimônio Inventário | tablet-768 | `input` | input | 1.01 | 1.29 | 1.29 | number |
| patrimônio Inventário | tablet-768 | `input` | input | 1.01 | 1.29 | 1.29 | text · placeholder |
| patrimônio Inventário | tablet-768 | `input` | input | 1.01 | 1.29 | 1.29 | text · placeholder |
| patrimônio Inventário | tablet-768 | `select` | select | 1.01 | 1.29 | 1.29 | select |
| patrimônio Inventário | tablet-768 | `select` | select | 1 | 1.28 | 1.28 | select |
| patrimônio Inventário | tablet-768 | `input` | input | 1 | 1.28 | 1.28 | text · placeholder |
| patrimônio Inventário | tablet-768 | `input` | input | 1 | 1.28 | 1.28 | number |
| patrimônio Inventário | tablet-768 | `input` | input | 1 | 1.28 | 1.28 | text · placeholder |
| patrimônio Inventário | tablet-768 | `input` | input | 1 | 1.28 | 1.28 | number · placeholder |
| patrimônio Inventário | tablet-768 | `input` | input | 1 | 1.28 | 1.28 | text · placeholder |
| patrimônio Dinheiro | tablet-768 | `select` | select | 1.01 | 1.29 | 1.29 | select |
| patrimônio Dinheiro | tablet-768 | `input` | input | 1.01 | 1.29 | 1.29 | number |
| patrimônio Dinheiro | tablet-768 | `input` | input | 1.01 | 1.29 | 1.29 | text · placeholder |
| patrimônio Dinheiro | tablet-768 | `select` | select | 1 | 1.28 | 1.28 | select |
| patrimônio Dinheiro | tablet-768 | `select` | select | 1 | 1.28 | 1.28 | select |
| patrimônio Dinheiro | tablet-768 | `input` | input | 1 | 1.28 | 1.28 | number · placeholder |
| patrimônio Dinheiro | tablet-768 | `input` | input | 1 | 1.28 | 1.28 | text · placeholder |
| aba Personagens | desktop-1366 | `input` | input | 1.01 | 1.29 | 1.29 | search · placeholder |
| aba Personagens | desktop-1366 | `select` | select | 1.01 | 1.29 | 1.29 | select |
| aba Arquivos | desktop-1366 | `input` | input | 1.01 | 1.29 | 1.29 | text · placeholder |
| aba Arquivos | desktop-1366 | `select` | select | 1.01 | 1.29 | 1.29 | select |
| aba Convites | desktop-1366 | `select` | select | 1 | 1.28 | 1.28 | select · 1 label(is) · Papel inicial
Jogador
Espectad |
| aba Convites | desktop-1366 | `input` | input | 1 | 1.28 | 1.28 | number · 1 label(is) · placeholder · Máx. de usos |
| aba Convites | desktop-1366 | `input` | input | 1 | 1.28 | 1.28 | number · 1 label(is) · placeholder · Expira em (horas) |
| aba Convites | desktop-1366 | `input` | input | 1 | — | 1 | checkbox · 1 label(is) · Exigir aprovação do mestre |
| ficha detalhe | desktop-1366 | `select` | select | 1.01 | 1.29 | 1.29 | select |
| ficha detalhe | desktop-1366 | `input` | input | 1.01 | 1.29 | 1.29 | number |
| ficha detalhe | desktop-1366 | `input` | input | 1.01 | 1.29 | 1.29 | text · placeholder |
| ficha detalhe | desktop-1366 | `input` | input | 1.01 | 1.29 | 1.29 | text · placeholder |
| ficha detalhe | desktop-1366 | `select` | select | 1.01 | 1.29 | 1.29 | select |
| ficha detalhe | desktop-1366 | `select` | select | 1 | 1.28 | 1.28 | select |
| ficha detalhe | desktop-1366 | `input` | input | 1 | 1.28 | 1.28 | text · placeholder |
| ficha detalhe | desktop-1366 | `input` | input | 1 | 1.28 | 1.28 | number |
| ficha detalhe | desktop-1366 | `input` | input | 1 | 1.28 | 1.28 | text · placeholder |
| ficha detalhe | desktop-1366 | `input` | input | 1 | 1.28 | 1.28 | number · placeholder |
| ficha detalhe | desktop-1366 | `input` | input | 1 | 1.28 | 1.28 | text · placeholder |
| patrimônio Inventário | desktop-1366 | `select` | select | 1.01 | 1.29 | 1.29 | select |
| patrimônio Inventário | desktop-1366 | `input` | input | 1.01 | 1.29 | 1.29 | number |
| patrimônio Inventário | desktop-1366 | `input` | input | 1.01 | 1.29 | 1.29 | text · placeholder |
| patrimônio Inventário | desktop-1366 | `input` | input | 1.01 | 1.29 | 1.29 | text · placeholder |
| patrimônio Inventário | desktop-1366 | `select` | select | 1.01 | 1.29 | 1.29 | select |
| patrimônio Inventário | desktop-1366 | `select` | select | 1 | 1.28 | 1.28 | select |
| patrimônio Inventário | desktop-1366 | `input` | input | 1 | 1.28 | 1.28 | text · placeholder |
| patrimônio Inventário | desktop-1366 | `input` | input | 1 | 1.28 | 1.28 | number |
| patrimônio Inventário | desktop-1366 | `input` | input | 1 | 1.28 | 1.28 | text · placeholder |
| patrimônio Inventário | desktop-1366 | `input` | input | 1 | 1.28 | 1.28 | number · placeholder |
| patrimônio Inventário | desktop-1366 | `input` | input | 1 | 1.28 | 1.28 | text · placeholder |
| patrimônio Dinheiro | desktop-1366 | `select` | select | 1.01 | 1.29 | 1.29 | select |
| patrimônio Dinheiro | desktop-1366 | `input` | input | 1.01 | 1.29 | 1.29 | number |
| patrimônio Dinheiro | desktop-1366 | `input` | input | 1.01 | 1.29 | 1.29 | text · placeholder |
| patrimônio Dinheiro | desktop-1366 | `select` | select | 1 | 1.28 | 1.28 | select |
| patrimônio Dinheiro | desktop-1366 | `select` | select | 1 | 1.28 | 1.28 | select |
| patrimônio Dinheiro | desktop-1366 | `input` | input | 1 | 1.28 | 1.28 | number · placeholder |
| patrimônio Dinheiro | desktop-1366 | `input` | input | 1 | 1.28 | 1.28 | text · placeholder |

### Controles com externo sólido — quocientes reproduzidos (contexto p/ disposição)

São as entradas 'fronteira ambígua' da lista REVIEW: o auditor já tinha os quocientes; aqui ficam deduplicadas por (campo, fillMin, bordaMin) com o contexto de labels para a decisão humana.

| campo | fillMin | bordaMin | piorCaso | n amostras | telas | tipo | labels | placeholder |
|---|---|---|---|---|---|---|---|---|
| `select` | 1.04 | 1.43 | 1.43 | 9 | ficha detalhe/celular-390, patrimônio Inventário/celular-390, patrimônio Dinheiro/celular-390, ficha detalhe/tablet-768 | select | 0 | não |
| `input` | 1.04 | 1.43 | 1.43 | 18 | ficha detalhe/celular-390, patrimônio Inventário/celular-390, patrimônio Dinheiro/celular-390, ficha detalhe/tablet-768 | number | 0 | não |
| `input` | 1.02 | 1.34 | 1.34 | 9 | ficha detalhe/celular-390, patrimônio Inventário/celular-390, patrimônio Dinheiro/celular-390, ficha detalhe/tablet-768 | text | 0 | sim |

## 3. Indicador de foco × gradiente externo

- **login (foco)** (`button`, outline 2px): pior contraste vs gradiente externo = **3.89:1** → computado-PASS (limiar 3:1).
- **campanha (foco)** (`button.secundario`, outline 2px): pior contraste vs gradiente externo = **3.89:1** → computado-PASS (limiar 3:1).

## Notas metodológicas

- O pior contraste é o mínimo entre TODAS as paradas de cor de todos os gradientes do fundo efetivo — conservador: pixels do meio do gradiente têm contraste intermediário, nunca pior que as extremidades.
- Paradas com alpha < 1 foram compostas sobre o fundo efetivo abaixo do gradiente (mesma composição `sobre()` do auditor).
- Texto: limiar 4.5:1 normal, 3.0:1 grande (≥24px ou ≥18.66px negrito) — idêntico ao `grande()` de `wcag-avaliador-297.mjs`.
- Controles (1.4.11): por parada de gradiente externa, usa-se o MELHOR identificador (preenchimento×externo ou borda×externo ≥3:1); o veredito final é o PIOR desses melhores — ou seja, PASS só se a fronteira for identificável em qualquer pixel do gradiente.
- `abaixo-3:1` não é violação confirmada: a SC 1.4.11 admite contexto adjacente (label visível) como alternativa à fronteira — a decisão é humana.
- Entradas 'select: affordance nativa do UA' e 'stepper nativo' envolvem renderização do user-agent não mensurável via DOM — permanecem para disposição humana mesmo com quocientes calculados.
