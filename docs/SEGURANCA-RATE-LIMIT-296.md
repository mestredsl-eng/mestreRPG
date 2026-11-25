# Rate limiting e abuso — limites existentes (Issue #296)

Inventário dos limites implementados no stack atual, para a matriz de
ameaças da auditoria adversarial. Documento descritivo — não introduz
requisito novo; cada item aponta o código que o impõe.

## Implementação

Dois mecanismos, ambos em memória no processo do servidor:

- **HTTP** — `servidor/src/lib/ratelimit.ts`: janela fixa por
  `(nome, chave)`; chave padrão `ip:<req.ip>` ou `user:<id>` via
  `limiteUsuario`. Estouro → `429` com `Retry-After`.
- **Socket.IO** — `servidor/src/lib/socket-rate-limit.ts`: balde de
  tokens por `userId:acao` (sustentado + burst). Estouro → ACK
  `{ ok:false }` com motivo; sem desconexão.

## Limites HTTP por endpoint

| Endpoint / ação | Janela | Máx | Chave |
|---|---|---|---|
| `POST /auth/login` (por IP) | 5 min | 10 | IP |
| `POST /auth/login` (por usuário) | 5 min | 20 | username normalizado |
| Troca de senha | 5 min | 10 | usuário |
| Registro (`/auth/setup` e afins) | 5 min | 10 | usuário/IP |
| Criar convite de campanha | 5 min | 20 | usuário |
| Consulta/preview de convite | 5 min | 30 / 60 | usuário |
| Aceite de convite | 5 min | 20 | usuário |
| Convite de guilda (consulta/aceite) | 5 min | 30 / 20 | usuário |
| Upload de arquivo | 5 min | 40 | usuário |
| Upload de retrato | 5 min | 20 | usuário |
| Exportar campanha | 5 min | 12 | usuário |
| Importar campanha | 10 min | 20 | usuário |
| Backup: criar / verificar / restaurar | 5 / 5 / 10 min | 6 / 10 / 3 | usuário |
| Compra de ponto (XP) | 5 min | 120 | usuário |
| Prévia de pontos | 5 min | 240 | usuário |

## Limites Socket.IO

- Mesa (`servidor/src/sockets/mesa.ts`) e Sangue
  (`servidor/src/sockets/sangue.ts`): um limitador por tipo de ação,
  chave `userId:acao` — abas e reconexões do mesmo usuário compartilham
  o bucket (não multiplica cota).
- Bucket saturado (`maxChaves` 10.000) descarta a chave mais antiga com
  log — comportamento fail-open documentado no código.

## Cobertura de teste

- `teste-rate-limit-socket.mjs` — obrigatório na CI (job Servidor):
  prova de tokens, burst e isolamento por ação/usuário.
- `teste-proxy-acesso.mjs` — prova que `req.ip` respeita
  `X-Forwarded-For` somente na profundidade configurada
  (`acesso.proxyHops`), impedindo bypass de limite por IP forjado.

## Limites conhecidos / fora de escopo

- Limitadores são **em memória**: reinício do processo zera as janelas
  (aceito para app single-instância local).
- Não há rate limit global por IP em todas as rotas GET — deliberado:
  o produto é local/LAN; os endpoints sensíveis (auth, convites,
  uploads, backups, import/export) estão cobertos.
- Conexões socket autenticadas não têm limite de eventos totais —
  apenas por ação, conforme acima.
