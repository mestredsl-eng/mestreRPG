# Inspeção visual FILHO — FAIL provável / REVIEW da matriz WCAG #297

Ordem `7173173001` (#322). SHA `a5e8c54`, papel **mestre**, viewports
celular-390 / tablet-768 / desktop-1366. Método: medição de pixels
renderizados (recorte do texto + anel de fundo adjacente aos glifos, DSF=2)
+ estilos computados + sonda de controle — screenshot é evidência de apoio,
não substitui medição. Scripts: `inspecionar-wcag-297.mjs`,
`inspecionar-wcag-297-parte2.mjs`; dados brutos em `inspecao-visual/dados*.json`.

## 1. Casos de texto FAIL provável → **falsos positivos confirmados (PASS)**

O "pior pixel" da matriz media o elemento inteiro e capturava (a) fringe de
antialias e (b) tinta de elementos vizinhos dentro do recorte. A medição
local — fundo sólido adjacente aos glifos (4–14 px da tinta, fora da zona
de blend) — mostra:

| Caso | Viewport | fg | Fundo adjacente medido | Req | Disposição |
|---|---|---|---|---|---|
| `li.dica` "Nenhuma anotação." (Diário) | 3/3 | rgb(139,147,167) | mín 5.62–5.71 · med ~5.7 | 4.5 | **PASS** |
| `li.dica` "Nenhum arquivo…" (Arquivos) | 3/3 | rgb(139,147,167) | mín 5.68–5.80 · med ~5.8 | 4.5 | **PASS** |
| `label.checkbox` "Exigir aprovação…" (Convites) | 3/3 | rgb(201,205,211) | mín ~11.1–11.2 | 4.5 | **PASS** |
| `p.meta.ficha-dono` (ficha detalhe) | 3/3 | rgb(180,169,177) | mín 7.59–7.60 (desktop/tablet); celular: p5 7.70, único pixel <4.5 = tinta vizinha rgb(241,231,233) na borda do recorte | 4.5 | **PASS** |
| `p.meta.ficha-dono` (patrimônio Inventário/Dinheiro) | 3/3 | rgb(180,169,177) | med ~8.1; pixels <4.5 = linha de texto mais claro adjacente (rgb(241,231,233)), não fundo | 4.5 | **PASS** |

Corrobora o analítico de gradientes (`WCAG-CONTRASTE-GRADIENTES-1.0.9.md`,
≥5.56:1 nos mesmos padrões). **Nenhum FAIL real de texto nestes 4 casos.**

## 2. Caso de foco REVIEW → **PASS confirmado**

`avaliarFocoIndicador` não conseguia computar porque o adjacente é
`bg-image`. Inspeção com Tab real: **todas** as paradas de foco nas telas
login→painel e campanha, nos 3 viewports, exibem
`outline: solid 2px rgb(184, 92, 105)` (+ box-shadow de reforço em inputs e
botão ativo). Medição do outline vs fundo adjacente real (moda do anel do
recorte, rgb(24,24,24)): **4.04:1 ≥ 3** — consistente e visível.
Evidência: `foco-painel-desktop-1366.png`, `foco-campanha-desktop-1366.png`,
`dados-parte2.json`.

## 3. Casos de input REVIEW → **1 achado real novo + demais resolvidos**

Os 12 REVIEW "sem pixels de fundo amostráveis" eram falha de amostragem do
gerador (controles nativos/pequenos), não ausência de evidência. Elementos
reais identificados por aba/viewport:

| Elemento | Tela | Medição | Disposição |
|---|---|---|---|
| `input[type=text]` "Pesquisar…" | Arquivos | **sem `<label>`**; `::placeholder` rgb(117,117,117) vs bg rgb(20,22,26) = **3.93:1 <4.5**; borda rgb(44,48,56) ≈1.3:1; preenchimento ≈1.2:1 — **nenhum identificador ≥3:1/4.5:1** | **FAIL confirmado (novo)** — SC 1.4.11 sem cue válido |
| `input[type=number]` "Máx. de usos" | Convites | label visível rgb(201,205,211) ≈11:1 (contexto válido); stepper nativo do UA; borda ≈1.4:1 | mesma classe "fronteira ambígua" já FAIL provável na matriz (ficha/patrimônio) — decisão humana pendente, não achado novo |
| `input[type=number]` "Expira em (horas)" | Convites | idem | idem |
| `input[type=checkbox]` "Exigir aprovação…" | Convites | nativo (appearance auto, borda 0px); caixa UA medida: corpo ~rgb(50–60) vs externo ~rgb(16–25) ≈1.5–2:1 <3; label adjacente ≈11:1 | fronteira <3 com contexto válido — mesma classe ambígua; estado (check) é do UA |
| `input[type=text]` "Pesquisar…" | login (Usuário/Senha) | labels + placeholder ≈11.7:1 — contexto válido | sem achado |

## 4. Fora do escopo desta inspeção (já classificado)

As 123 ocorrências SC 1.4.11 de fronteiras de controles (`input`/`select`/
`textarea`, ~1.0–1.4:1) já têm confirmação por dois métodos independentes —
questão aberta é **normativa** (label adjacente dispensa a fronteira?),
não de medição. Spot-check confirma o padrão: borda rgb(44,48,56)/
rgb(42,47,63) ~1px sobre fundos escuros ≈1.3–1.4:1.

## Resumo para o PAI

- **Falsos positivos encerrados**: 4 casos de texto FAIL provável → PASS
  (18 ocorrências).
- **REVIEW resolvidos**: foco → PASS (18 ocorrências); inputs → 1 FAIL real
  novo (`input[type=text]` Pesquisar… em Arquivos, 3 viewports) + 3 por
  viewport reclassificados na classe fronteira-ambígua já conhecida.
- **Falha real nova para correção**: campo "Pesquisar…" de Arquivos sem
  label e placeholder 3.93:1 — precisa de `<label>`/aria ou reforço de
  placeholder/borda.
