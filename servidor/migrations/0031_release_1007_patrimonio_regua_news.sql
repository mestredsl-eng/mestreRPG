-- Publica na Central de Novidades as funcionalidades entregues em v1.0.7
-- (PRs #177 Patrimônio granular e #178 Régua de distância na Mesa Virtual).
-- Chave estável + INSERT OR IGNORE tornam o seed seguro para reexecução.
INSERT OR IGNORE INTO novidades (
  id, titulo, resumo, conteudo, versao, categoria, estado,
  publicado_em, autor_id, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000000108',
  'Patrimônio com permissões granulares e régua de distância na mesa virtual',
  'O mestre controla cada permissão do patrimônio separadamente e mede distâncias direto no tabuleiro.',
  'Patrimônio: a campanha agora configura sete permissões granulares — itens, equipamentos, veículos, contas, compra, venda e PIX fictício — e o painel de Regras reflete cada alteração em tempo real para todos os jogadores. Régua: a Mesa Virtual ganhou uma régua de distância entre dois pontos do tabuleiro ou do mapa, com calibração exclusiva do mestre, suporte a mouse e toque, ajuste de proporção do mapa e encaixe (snap) por hit-test que não conflita com o pincel de desenho.',
  '1.0.7',
  'novidade',
  'publicada',
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  NULL,
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  CAST(strftime('%s','now') AS INTEGER) * 1000
);
