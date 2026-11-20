# Regressão P1 — andamento envenenado (W13/W14)

Suíte: `teste-bootstrap-p1-andamento-envenenado.mjs`
Defeito: `servidor/src/db/aplicar-restauracao.ts` → `autorizarBootstrap()`
grava `bootstrap-em-andamento` (`autorizacao-pendente`) **antes** de
consumir a autorização, incondicionalmente — inclusive sem autorização
válida (`autorizacaoId` indefinido). Consumo que falha deixa andamento
inválido persistido → `avaliarBootstrapAndamento()` bloqueia Gate 0,
migrador, servidor e restaurador permanentemente
(`autorizacaoId-ausente-ou-invalido` / `sem-prova-vinculada`).

## Baseline — SHA testado `db49214239e8bf512c14df8f8a59d4bacba62982`

Comando: `node teste-bootstrap-p1-andamento-envenenado.mjs`
(exit 1) — **8 ok / 18 falhas**.

| Cenário | 1ª tentativa | Recuperação com auth legítima |
|---|---|---|
| A — sem autorização | bloqueia ok | **FALHA** — andamento inválido residual |
| B — autorização corrompida | bloqueia ok | **FALHA** — idem |
| C — autorização divergente | bloqueia ok | **FALHA** — idem |
| D — só consumida de ciclo antigo | bloqueia ok | **FALHA** — idem |
| E — crash@pendente + auth some | bloqueia ok | **FALHA** — pendente stale sem prova vinculada |
| F — controle (auth direta) | — | **PASS** exit 0 + migrate 0 |

Em A–D o andamento residual é `etapa=autorizacao-pendente` sem
`autorizacaoId` → Gate 0 passa a responder
`bootstrap-andamento-invalido` para sempre. Em E o pendente carrega o
id do ciclo que sumiu → `sem-prova-vinculada` → bloqueio permanente.

## Contrato exigido pela suíte

1. tentativa sem autorização bloqueia (exit ≠ 0);
2. não pode envenenar o estado — autorização legítima posterior deve
   completar o primeiro boot (restaurador exit 0 + migrate exit 0);
3. andamento "pendente" residual precisa de `autorizacaoId` 32-hex
   semanticamente consistente.

## Após correção do Pai

Reexecutar o mesmo comando na nova árvore e registrar o delta. O teste
não toca produção — falhas aqui são evidência de defeito, não de teste.
