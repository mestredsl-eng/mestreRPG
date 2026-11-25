-- Registra a entrega v1.1.0 na Central de Novidades.
-- O ID estável + INSERT OR IGNORE tornam o seed seguro para reexecução.
INSERT OR IGNORE INTO novidades (
  id, titulo, resumo, conteudo, versao, categoria, estado,
  publicado_em, autor_id, created_at, updated_at
) VALUES (
  '00000000-0000-4000-8000-000000000112',
  'Mestre RPG 1.1.0 — Internet diegética, lojas e Equipamento/Armazém',
  'Acesso à Internet por Computador ou Tecnologia e dispositivo físico; lojas por campanha com compra, venda e caixa; consulta unificada do patrimônio.',
  'A versão 1.1.0 inaugura a Internet diegética com um gate validado pelo servidor: o personagem precisa ter pelo menos um ponto em Computador ou Tecnologia e possuir um dispositivo físico reconhecido no patrimônio (como notebook ou celular). A posse considera também o equipamento efetivamente equipado; nomes de itens sem referência canônica não liberam o acesso. A elegibilidade é revalidada nas operações e nas entregas em tempo real. A Internet passa a oferecer lojas da campanha, ofertas, caixas, recibos, compras e venda de itens para lojas, com validação de estoque, saldo, preço, quantidade e permissões no servidor. A movimentação fica vinculada ao patrimônio e ao histórico financeiro do personagem. A nova área Equipamento/Armazém reúne a consulta de inventário, equipamentos, vínculos e veículos, com peso e capacidade quando disponíveis. As operações financeiras permanecem na Internet e a edição do patrimônio segue no painel Patrimônio.',
  '1.1.0',
  'novidade',
  'publicada',
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  NULL,
  CAST(strftime('%s','now') AS INTEGER) * 1000,
  CAST(strftime('%s','now') AS INTEGER) * 1000
);
