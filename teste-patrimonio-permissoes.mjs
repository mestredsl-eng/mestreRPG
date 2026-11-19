// Testes de integração — Issue #165: permissões granulares do patrimônio.
// Cobre a matriz das 7 permissões do backend contra a API HTTP real:
//   patrimônio: jogadorAdicionaItens, jogadorRemoveItens,
//               jogadorEditaEquipamentos, jogadorEditaVeiculos, jogadorCriaContas
//   financeiro: jogadorCompraVenda, jogadorPix
// Inclui: cada permissão ligada/desligada, combinações independentes,
// mestre com acesso administrativo, campanha legada sem as chaves
// (defaults do schema) e PIX independente de compra/venda.
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, abrirDb, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("patrimonio-permissoes");
const BANCO = `${DIR}/teste.db`;
const ARQ = `${DIR}/arq`, BKS = `${DIR}/bks`;

await prepararBanco(BANCO);
const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
let proc;

// Permissões no formato interno do teste → chaves reais do backend.
const backendCfg = (p) => ({
  patrimonio: {
    jogadorAdicionaItens: p.adicionaItens,
    jogadorRemoveItens: p.removeItens,
    jogadorEditaEquipamentos: p.editaEquipamentos,
    jogadorEditaVeiculos: p.editaVeiculos,
    jogadorCriaContas: p.criaContas,
  },
  financeiro: { jogadorCompraVenda: p.compraVenda, jogadorPix: p.pix },
});
const TODAS = { adicionaItens: true, removeItens: true, editaEquipamentos: true, editaVeiculos: true, criaContas: true, compraVenda: true, pix: true };
const NENHUMA = Object.fromEntries(Object.keys(TODAS).map((k) => [k, false]));

try {
  proc = subirServidor(porta, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);

  const c = await criarCenario(BASE, BANCO, { jogadores: { j1: "perm_j1", j2: "perm_j2" }, ficha: false });
  const CM = c.cookieMestre, CAMP = c.campId;
  const J1 = c.jogadores.j1.cookie, J2 = c.jogadores.j2.cookie;
  const PJ1 = c.novoPersonagem(c.jogadores.j1.membershipId, "PJ J1");
  const PJ2 = c.novoPersonagem(c.jogadores.j2.membershipId, "PJ J2");

  // Escreve a config crua do rule_set ativo (mesmo efeito de um PUT /regras/config).
  // `null` remove a seção inteira → simula campanha legada sem as chaves.
  const definirCfg = (patrimonio, financeiro) => {
    const w = abrirDb(BANCO);
    try {
      const rs = w.prepare("select id, config from rule_sets where campaign_id=? and is_active=1").get(CAMP);
      const cfg = JSON.parse(rs.config || "{}");
      if (patrimonio === null) delete cfg.patrimonio; else cfg.patrimonio = patrimonio;
      if (financeiro === null) delete cfg.financeiro; else cfg.financeiro = financeiro;
      w.prepare("update rule_sets set config=? where id=?").run(JSON.stringify(cfg), rs.id);
    } finally { w.close(); }
  };
  const setPerm = (p) => { const b = backendCfg(p); definirCfg(b.patrimonio, b.financeiro); };

  // ---- Recursos criados pelo MESTRE (bypass total) para testes de negação ----
  const novoItem = async (qtd = 10) => {
    const r = await req(BASE, "POST", `/characters/${PJ1}/inventario`, { cookie: CM, body: { name: "Item " + crypto.randomUUID().slice(0, 8), quantity: qtd } });
    if (r.status !== 201) throw new Error("falha ao criar item mestre: " + r.status);
    return r.json.id;
  };
  const itemEstoque = await novoItem(10);
  const veicEstoque = (await req(BASE, "POST", `/characters/${PJ1}/veiculos`, { cookie: CM, body: { name: "Carro Base", kind: "carro" } })).json.id;
  const equipEstoque = (await req(BASE, "POST", `/characters/${PJ1}/equipamentos`, { cookie: CM, body: { name: "Armadura Base" } })).json.id;

  // Contas para testes financeiros — criadas pelo mestre (independentes das permissões).
  const contaA = (await req(BASE, "POST", `/characters/${PJ1}/financeiro/contas`, { cookie: CM, body: { type: "especie", name: "Carteira", balanceReais: 100000 } })).json.id;
  const contaB = (await req(BASE, "POST", `/characters/${PJ1}/financeiro/contas`, { cookie: CM, body: { type: "banco", name: "Poupança", balanceReais: 50000 } })).json.id;
  const contaJ2 = (await req(BASE, "POST", `/characters/${PJ2}/financeiro/contas`, { cookie: CM, body: { type: "especie", name: "Bolso J2", balanceReais: 1000 } })).json.id;
  if (!contaA || !contaB || !contaJ2) throw new Error("falha ao criar contas de apoio");

  // Operações sob teste (todas como J1 no PJ1, salvo indicado).
  const ops = {
    addItem: () => req(BASE, "POST", `/characters/${PJ1}/inventario`, { cookie: J1, body: { name: "Item J1", quantity: 2 } }),
    delItem: async () => { const id = await novoItem(3); return req(BASE, "DELETE", `/characters/${PJ1}/inventario/${id}`, { cookie: J1 }); },
    patchDown: async () => { const id = await novoItem(5); return req(BASE, "PATCH", `/characters/${PJ1}/inventario/${id}`, { cookie: J1, body: { quantity: 2 } }); },
    patchUp: async () => { const id = await novoItem(2); return req(BASE, "PATCH", `/characters/${PJ1}/inventario/${id}`, { cookie: J1, body: { quantity: 6 } }); },
    addEquip: () => req(BASE, "POST", `/characters/${PJ1}/equipamentos`, { cookie: J1, body: { name: "Equip J1" } }),
    delEquip: async () => { const id = (await req(BASE, "POST", `/characters/${PJ1}/equipamentos`, { cookie: CM, body: { name: "Equip del" } })).json.id; return req(BASE, "DELETE", `/characters/${PJ1}/equipamentos/${id}`, { cookie: J1 }); },
    addVeic: () => req(BASE, "POST", `/characters/${PJ1}/veiculos`, { cookie: J1, body: { name: "Veic J1", kind: "carro" } }),
    updVeic: () => req(BASE, "PATCH", `/characters/${PJ1}/veiculos/${veicEstoque}`, { cookie: J1, body: { name: "Veic Editado" } }),
    delVeic: async () => { const id = (await req(BASE, "POST", `/characters/${PJ1}/veiculos`, { cookie: CM, body: { name: "Veic del", kind: "carro" } })).json.id; return req(BASE, "DELETE", `/characters/${PJ1}/veiculos/${id}`, { cookie: J1 }); },
    addConta: () => req(BASE, "POST", `/characters/${PJ1}/financeiro/contas`, { cookie: J1, body: { type: "especie", name: "Conta J1", balanceReais: 10 } }),
    movEntrada: () => req(BASE, "POST", `/characters/${PJ1}/financeiro/movimentar`, { cookie: J1, body: { accountId: contaA, tipo: "entrada", valor: 10, descricao: "t", requestId: crypto.randomUUID() } }),
    compra: () => req(BASE, "POST", `/characters/${PJ1}/financeiro/operacao`, { cookie: J1, body: { tipo: "compra", accountId: contaA, valor: 10, descricao: "t", item: { name: "Item compra", quantity: 1 }, requestId: crypto.randomUUID() } }),
    pix: () => req(BASE, "POST", `/characters/${PJ1}/financeiro/transferir`, { cookie: J1, body: { origemAccountId: contaA, destinoAccountId: contaJ2, valor: 10, descricao: "pix", requestId: crypto.randomUUID() } }),
    transfContas: () => req(BASE, "POST", `/characters/${PJ1}/financeiro/transferir`, { cookie: J1, body: { origemAccountId: contaA, destinoAccountId: contaB, valor: 10, descricao: "mesma conta", requestId: crypto.randomUUID() } }),
  };
  // Resultado esperado (2xx = permitido) por operação e permissão relevante.
  const permDe = {
    addItem: "adicionaItens", patchUp: "adicionaItens",
    delItem: "removeItens", patchDown: "removeItens", delEquip: "removeItens", delVeic: "removeItens",
    addEquip: "editaEquipamentos",
    addVeic: "editaVeiculos", updVeic: "editaVeiculos",
    addConta: "criaContas",
    movEntrada: "compraVenda", compra: "compraVenda", transfContas: "compraVenda",
    pix: "pix",
  };
  const checar = async (rotulo, p) => {
    setPerm(p);
    for (const [op, fn] of Object.entries(ops)) {
      const r = await fn();
      const permitido = p[permDe[op]];
      const ok = permitido ? (r.status === 200 || r.status === 201) : r.status === 403;
      t(`${rotulo} · ${op} → ${r.status} (perm=${permDe[op]}:${permitido})`, ok, JSON.stringify(r.json).slice(0, 120));
    }
  };

  // ================= FASE A — campanha legada (sem chaves) =================
  sec("A. Campanha legada — seções patrimonio/financeiro ausentes (defaults do schema)");
  definirCfg(null, null);
  {
    const r1 = await ops.addItem(); t("legado addItem → 201 (adicionaItens default true)", r1.status === 201, r1.status);
    const r2 = await ops.delItem(); t("legado delItem → 403 (removeItens default false)", r2.status === 403, r2.status);
    const r3 = await ops.patchDown(); t("legado patchDown → 403", r3.status === 403, r3.status);
    const r4 = await ops.patchUp(); t("legado patchUp → 201", r4.status === 201 || r4.status === 200, r4.status);
    const r5 = await ops.addEquip(); t("legado addEquip → 201", r5.status === 201, r5.status);
    const r6 = await ops.addVeic(); t("legado addVeic → 201", r6.status === 201, r6.status);
    const r7 = await ops.addConta(); t("legado addConta → 201 (criaContas default true)", r7.status === 201, r7.status);
    const r8 = await ops.movEntrada(); t("legado movEntrada → 2xx (compraVenda default true)", r8.status === 200 || r8.status === 201, r8.status);
    const r9 = await ops.compra(); t("legado compra → 2xx", r9.status === 200 || r9.status === 201, r9.status);
    const r10 = await ops.pix(); t("legado pix → 2xx (pix default true)", r10.status === 200 || r10.status === 201, r10.status);
    const r11 = await ops.transfContas(); t("legado transfContas → 2xx", r11.status === 200 || r11.status === 201, r11.status);
  }

  // ================= FASE B — todas habilitadas =================
  sec("B. Todas as permissões habilitadas — jogador executa tudo");
  await checar("todas-on", TODAS);

  // ================= FASE C — todas desabilitadas =================
  sec("C. Todas as permissões desabilitadas — jogador bloqueado, mestre admin");
  await checar("todas-off", NENHUMA);
  {
    setPerm(NENHUMA);
    const mi = await novoItem(3);
    const r1 = await req(BASE, "DELETE", `/characters/${PJ1}/inventario/${mi}`, { cookie: CM });
    t("mestre delItem com tudo off → 200", r1.status === 200, r1.status);
    const r2 = await req(BASE, "POST", `/characters/${PJ1}/financeiro/contas`, { cookie: CM, body: { type: "especie", name: "Conta Mestre", balanceReais: 1 } });
    t("mestre addConta com tudo off → 201", r2.status === 201, r2.status);
    const r3 = await req(BASE, "POST", `/characters/${PJ1}/financeiro/operacao`, { cookie: CM, body: { tipo: "compra", accountId: contaA, valor: 10, descricao: "m", item: { name: "x", quantity: 1 }, requestId: crypto.randomUUID() } });
    t("mestre compra com tudo off → 2xx", r3.status === 200 || r3.status === 201, r3.status);
    const r4 = await req(BASE, "POST", `/characters/${PJ1}/financeiro/transferir`, { cookie: CM, body: { origemAccountId: contaA, destinoAccountId: contaJ2, valor: 10, descricao: "m", requestId: crypto.randomUUID() } });
    t("mestre pix com tudo off → 2xx", r4.status === 200 || r4.status === 201, r4.status);
    const r5 = await req(BASE, "POST", `/characters/${PJ1}/inventario`, { cookie: CM, body: { name: "Item mestre", quantity: 1 } });
    t("mestre addItem com tudo off → 201", r5.status === 201, r5.status);
    const r6 = await req(BASE, "POST", `/characters/${PJ1}/veiculos`, { cookie: CM, body: { name: "V mestre", kind: "carro" } });
    t("mestre addVeic com tudo off → 201", r6.status === 201, r6.status);
  }

  // ================= FASE D — combinações independentes =================
  sec("D1. adicionaItens=on, removeItens=off — adicionar ok, remover/decrementar bloqueado");
  await checar("add-sem-remove", { ...TODAS, removeItens: false });

  sec("D2. editaEquipamentos=off, editaVeiculos=on — permissões específicas independentes");
  await checar("equip-off-veic-on", { ...TODAS, editaEquipamentos: false });

  sec("D3. criaContas=off — demais permissões mantidas");
  await checar("sem-criar-contas", { ...TODAS, criaContas: false });

  sec("D4. compraVenda=off, pix=on — PIX liberado sem compra/venda");
  await checar("pix-sem-compra", { ...TODAS, compraVenda: false });

  sec("D5. compraVenda=on, pix=off — compra/venda liberada sem PIX");
  await checar("compra-sem-pix", { ...TODAS, pix: false });

  sec("D6. removeItens=on, adicionaItens=off — remover ok, adicionar/incrementar bloqueado");
  await checar("remove-sem-add", { ...TODAS, adicionaItens: false });

  // PATCH no item de estoque (quantidade já reduzida nas fases anteriores —
  // garante quantidade atual conhecida antes de testar decremento).
  sec("D7. Decremento no item de estoque respeita removeItens");
  {
    const atual = await req(BASE, "GET", `/characters/${PJ1}/inventario`, { cookie: CM });
    const estq = (atual.json?.itens ?? atual.json?.inventory ?? []).find((i) => i.id === itemEstoque);
    const qtdAtual = estq?.quantity ?? 10;
    setPerm({ ...TODAS, adicionaItens: true, removeItens: false });
    const rDown = await req(BASE, "PATCH", `/characters/${PJ1}/inventario/${itemEstoque}`, { cookie: J1, body: { quantity: Math.max(1, qtdAtual - 1) } });
    t(`decremento com removeItens=off → 403 (qtd ${qtdAtual})`, rDown.status === 403, rDown.status);
    setPerm({ ...TODAS, adicionaItens: false, removeItens: true });
    const rDown2 = await req(BASE, "PATCH", `/characters/${PJ1}/inventario/${itemEstoque}`, { cookie: J1, body: { quantity: Math.max(1, qtdAtual - 1) } });
    t("decremento com removeItens=on → 200", rDown2.status === 200, rDown2.status);
    const rUp = await req(BASE, "PATCH", `/characters/${PJ1}/inventario/${itemEstoque}`, { cookie: J1, body: { quantity: qtdAtual + 1 } });
    t("incremento com adicionaItens=off → 403", rUp.status === 403, rUp.status);
  }

  // ================= FASE E — transferência de inventário (correção #165) =================
  // Regra do backend: origem exige jogadorRemoveItens; destino de OUTRO
  // jogador exige jogadorAdicionaItens; destino do mesmo usuário segue as
  // regras de propriedade; mestre faz bypass total.
  sec("E. Transferência de item — origem removeItens, destino adicionaItens");
  const PJ1B = c.novoPersonagem(c.jogadores.j1.membershipId, "PJ J1 B");
  const transferir = (itemId, destinoId, qtd, cookie = J1) =>
    req(BASE, "POST", `/characters/${PJ1}/inventario/${itemId}/transferir`, {
      cookie,
      body: { destinoCharacterId: destinoId, ...(qtd !== undefined ? { quantidade: qtd } : {}) },
    });
  const qtdDe = async (charId, itemId, cookie = CM) => {
    const inv = await req(BASE, "GET", `/characters/${charId}/inventario`, { cookie });
    const it = (inv.json?.itens ?? []).find((i) => i.id === itemId);
    return it ? it.quantity : null;
  };
  const itensDe = async (charId, cookie = CM) => {
    const inv = await req(BASE, "GET", `/characters/${charId}/inventario`, { cookie });
    return inv.json?.itens ?? [];
  };

  // Personagem de OUTRA campanha para o teste de isolamento.
  const camp2 = await req(BASE, "POST", "/campaigns", { cookie: CM, body: { name: "Campanha Isolada" } });
  const camp2Id = camp2.json?.campanha?.id;
  let pjFora = null;
  if (camp2Id) {
    const w = abrirDb(BANCO);
    try {
      let mem2 = w.prepare("select id from memberships where campaign_id=? and user_id=?").get(camp2Id, c.adminId)?.id;
      if (!mem2) {
        mem2 = crypto.randomUUID(); const ag = Date.now();
        w.prepare("insert into memberships (id,campaign_id,user_id,role,permissions,status,joined_at,created_at,updated_at) values (?,?,?,'mestre','{}','ativo',?,?,?)")
          .run(mem2, camp2Id, c.adminId, ag, ag, ag);
      }
      pjFora = crypto.randomUUID(); const ag = Date.now();
      w.prepare("insert into characters (id,campaign_id,membership_id,template_version_id,name,data,overrides,status,is_npc,created_at,updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
        .run(pjFora, camp2Id, mem2, null, "PJ Fora", "{}", "{}", "aprovada", 0, ag, ag);
    } finally { w.close(); }
  }
  t("fixture: personagem de outra campanha criado", !!pjFora);

  // E1 — origem sem removeItens: transferência total bloqueada, nada muda.
  {
    setPerm({ ...TODAS, removeItens: false, adicionaItens: true });
    const it = await novoItem(8);
    const antes2 = await itensDe(PJ2);
    const r = await transferir(it, PJ2);
    t("E1 origem removeItens=off → 403", r.status === 403, r.status);
    t("E1 origem preserva quantidade 8", (await qtdDe(PJ1, it, J1)) === 8);
    t("E1 destino não recebeu item", !(await itensDe(PJ2)).some((i) => i.id === it) && (await itensDe(PJ2)).length === antes2.length);
  }

  // E2 — origem ok, destino de outro jogador sem adicionaItens: 403 nos dois lados.
  {
    setPerm({ ...TODAS, removeItens: true, adicionaItens: false });
    const it = await novoItem(8);
    const r = await transferir(it, PJ2);
    t("E2 destino outro jogador adicionaItens=off → 403", r.status === 403, r.status);
    t("E2 origem preserva quantidade 8", (await qtdDe(PJ1, it, J1)) === 8);
    t("E2 destino sem item transferido", !(await itensDe(PJ2)).some((i) => i.data?.transferidoDe === PJ1 && i.name.startsWith("Item ")));
  }

  // E3 — destino do MESMO jogador (PJ1B): só removeItens importa.
  {
    setPerm({ ...TODAS, removeItens: true, adicionaItens: false });
    const it = await novoItem(5);
    const r = await transferir(it, PJ1B, 2);
    t("E3 destino mesmo proprietário → 200 com adicionaItens=off", r.status === 200, r.status);
    t("E3 origem ficou com 3", (await qtdDe(PJ1, it, J1)) === 3);
    const invB = await itensDe(PJ1B, J1);
    t("E3 destino mesmo dono recebeu 2", invB.some((i) => i.quantity === 2 && i.data?.transferidoDe === PJ1));
  }

  // E4 — destino outro jogador COM adicionaItens: parcial e total permitidos.
  {
    setPerm({ ...TODAS });
    const itP = await novoItem(10);
    const rP = await transferir(itP, PJ2, 4);
    t("E4 parcial → 200", rP.status === 200, rP.status);
    t("E4 origem 10→6", (await qtdDe(PJ1, itP, J1)) === 6);
    const itT = await novoItem(7);
    const rT = await transferir(itT, PJ2);
    t("E4 total → 200", rT.status === 200, rT.status);
    t("E4 origem sem o item (total)", (await qtdDe(PJ1, itT, J1)) === null);
    const inv2 = await itensDe(PJ2);
    t("E4 destino recebeu o item total", inv2.some((i) => i.id !== itT && i.quantity === 7 && i.data?.transferidoDe === PJ1));
  }

  // E5 — mestre com tudo desligado: bypass administrativo total.
  {
    setPerm(NENHUMA);
    const it = await novoItem(4);
    const r = await transferir(it, PJ2, 4, CM);
    t("E5 mestre com tudo off → 200", r.status === 200, r.status);
    t("E5 origem zerou o item", (await qtdDe(PJ1, it)) === null);
  }

  // E6 — destino em OUTRA campanha: rejeitado antes de qualquer mutação.
  {
    setPerm(TODAS);
    const it = await novoItem(3);
    const r = await transferir(it, pjFora);
    t("E6 destino outra campanha → 400", r.status === 400, r.status);
    t("E6 origem preserva 3", (await qtdDe(PJ1, it, J1)) === 3);
  }

  // E7 — campanha legada (sem chaves): defaults do schema valem —
  // removeItens=false bloqueia jogador, mestre segue livre.
  {
    definirCfg(null, null);
    const it = await novoItem(6);
    const r = await transferir(it, PJ2);
    t("E7 legada: jogador removeItens default off → 403", r.status === 403, r.status);
    const rM = await transferir(it, PJ2, undefined, CM);
    t("E7 legada: mestre transfere → 200", rM.status === 200, rM.status);
  }
} finally {
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
