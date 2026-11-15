# Referências e metodologia — preços e pesos dos suplementos

**Data de referência:** novembro de 2026  
**Mercado-base:** Brasil, valores nominais em reais (BRL).

## Metodologia

Cada entrada recebeu peso aproximado em kg, valor de referência em reais quando há base razoável, faixa mínima/máxima estimada e unidade de compra. `valueCents` registra o preço em centavos. A faixa é uma margem prática para acomodar marcas, modelos, condições e diferenças regionais, não um intervalo estatístico.

Para equipamentos comuns, a referência é produto novo econômico/intermediário. Para carros, motos, barcos e aeronaves, em geral usamos referência de usado/seminovo em bom estado. Itens especializados e bens institucionais têm margens largas. Nos consumíveis, peso e valor se referem à caixa, pacote, rolo, conjunto ou porção anotada.

Pesos são massas típicas, não fichas técnicas de um modelo específico. Em veículos, o texto identifica se o peso é vazio ou em ordem de marcha. Consumo e autonomia são faixas indicativas, não garantias. Capacidade é lotação aproximada, sujeita à versão e configuração.

Não foram inventados fabricante, modelo exato, número de série, calibre, certificação clínica, homologação ou nível de proteção balística. Se não existe preço civil comparável para uma classe restrita/institucional, o preço fica em aberto.

## Fontes e pontos de comparação

1. **FIPE — Preço Médio de Veículos.** A FIPE informa médias de mercado consultadas por modelo e ressalta a influência de região, conservação e acessórios. Adequada para substituir valores genéricos por modelo/ano. https://www.fipe.org.br/pt-br/indices/veiculos/

2. **Radar 0km — classes de veículos, novembro de 2026.** Preços publicados para hatch, SUV, sedã e picape foram usados como limites de plausibilidade, sem tratar cada categoria como se tivesse preço único. https://radar0km.com.br/

3. **Compra pública de equipamentos laboratoriais — Universidade de Rio Verde/GO.** A tabela de referência consultada apresenta valores unitários para balança analítica, capela de exaustão, centrífuga, autoclave, estufa e pHmetro. São preços máximos de orçamento público, dependentes da especificação do edital. https://www.licitaurgente.com.br/licitacao/01815216000178-2026-205-registro-de-precos-para-futura-e-eventual-aquisicao-de-equip

4. **Radar de Instrumentos — guia atualizado em 13/11/2026.** Medianas de catálogo para mesa de som, microfone, violão, teclado e bateria foram usadas como pontos de comparação. https://radardeinstrumentos.com.br/guias/qual-instrumento-comprar

5. **Viva Camp — orçamento de camping, fevereiro de 2026.** Faixas publicadas para barraca de 2–3 pessoas, saco de dormir, fogareiro e cantil foram usadas para confrontar os itens básicos de sobrevivência. https://www.vivacamp.com.br/quanto-custa-acampar-orcamento-iniciantes/

6. **Jet Tracker — mercado de helicópteros.** Valores são preços pedidos em anúncios, não transações concluídas; foram usados apenas como referência de ordem de grandeza para helicópteros leves. https://jettracker.com.br/blog/quanto-custa-um-helicoptero

7. **Força Aérea dos Estados Unidos — F-16 Fighting Falcon.** A ficha oficial informa peso vazio aproximado de 8.936 kg e peso máximo de decolagem de 16.875 kg para o F-16C/D. https://www.af.mil/About-Us/Fact-Sheets/Display/Article/104505/f-16-fighting-falcon/

8. **F-16 Block 70 — Letter of Offer and Acceptance.** Documento institucional consultado indica exemplo de US$ 59.638.951,24 por aeronave F-16C Block 70 em lote de 56 unidades. Não é preço civil nem representa necessariamente o custo completo do programa. https://afsac.wpafb.af.mil/resources/flo-files/training/docs/08-Letter_of_Offer_and_Acceptance_%28LOA%29_101.pdf

9. **Banco Central do Brasil — histórico de cotações.** A conversão do exemplo institucional do F-16 usa a PTAX de venda de 13/11/2026, R$ 5,6518 por dólar. https://www.bcb.gov.br/estabilidadefinanceira/historicocotacoes

10. **Contratações públicas brasileiras de armamento e proteção.** Contratos e publicações oficiais dão contexto institucional, mas preços de lote, objeto contratado e regras de acesso não equivalem a venda civil de varejo. https://www.policiapenal.go.gov.br/sem-categoria/contrato-006-2025-dgpp.html ; https://www.sinj.df.gov.br/sinj/TextoArquivoDiario.aspx?id_file=1c2a3c7f-7394-3366-9c55-a81ef8e03fda ; https://www.gov.br/mj/pt-br/acesso-a-informacao/licitacoes-e-contratosv1/licitacoes-e-contratos-senasp/cglic/contratos_senasp/

## Compatibilidade com o Patrimônio do Mestre RPG

- `definition.weight`: kg da unidade padronizada.
- `definition.valueCents`: preço indicativo em centavos de BRL, omitido quando não há base apropriada.
- `definition.economia`: faixa, moeda, unidade, data e observações.
- Veículos: `definition.fuel`, `definition.capacity` e `definition.veiculo` registram combustível, lotação, consumo/autonomia e base do peso.

Os dados estão no JSON do Acervo. Para preencher automaticamente inventário, compras, catálogo da campanha e veículos, a aplicação precisa copiar os campos de `definition` para `itemTemplates.data` e para os campos correspondentes de veículo. A presença dos valores no JSON, isoladamente, não altera saldos financeiros nem patrimônio já existente.

## Revisão

Recomenda-se recalibrar preços quando a campanha mudar de região/época ou quando o mestre escolher fabricante, modelo, ano e estado de conservação. Substitua a faixa por preço individual quando houver ficha técnica, tabela oficial ou anúncio comparável.
