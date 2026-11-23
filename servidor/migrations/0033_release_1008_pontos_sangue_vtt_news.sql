-- Publica na Central de Novidades os recursos entregues em v1.0.8.
-- Chave estável + INSERT OR IGNORE tornam o seed seguro para reexecução.
INSERT OR IGNORE INTO novidades (
  id, titulo, resumo, conteudo, versao, categoria, estado,
  publicado_em, autor_id, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000000109',
  'Pontos de Sangue, poderes e vida nos tokens',
  'Gerencie Pontos de Sangue por campanha, integre custos aos testes com Poderes e veja indicadores de vida no VTT respeitando as permissões da mesa.',
  'A versão 1.0.8 traz o recurso Pontos de Sangue configurável por campanha. O mestre define os custos dos Poderes e as ações de ativação e recuperação; os testes D10 elegíveis debitam o custo junto com o resultado, sem duplicar cobranças em tentativas repetidas. A capacidade de Sangue pode evoluir com XP, e a ficha e a Mesa exibem o saldo e os controles autorizados.

No VTT, tokens podem mostrar indicadores de vida e condição conforme a política de visibilidade da sessão. Informações restritas não são enviadas a participantes sem permissão. As exportações também passam a proteger em conjunto os históricos de XP e Sangue com HMAC v2.',
  '1.0.8',
  'novidade',
  'publicada',
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  NULL,
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  CAST(strftime('%s','now') AS INTEGER) * 1000
);
