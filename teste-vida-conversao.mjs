// Testes — conversão de ferimentos em Vitalidade (config conversaoFerimento).
// Cobre: ativação/desativação, limiares de HP, nunca reduzir vitalidade,
// recuperação não cura, ajuste ±, manual, idempotência por estado,
// concorrência, atomicidade, fichas antigas, permissões, histórico,
// penalidade/bloqueio em rolagem (socket) e persistência após restart.
// Banco isolado via teste-base — nunca toca a base real.
import { io as ioClient } from "socket.io-client";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, comDb, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("vida-conversao");
const BANCO = `${DIR}/teste.db`;
const ARQ = `${DIR}/arq`, BKS = `${DIR}/bks`;

const CONFIG = {
  hp: { habilitado: true, base: 100, porNivel: 20, campoId: "for", edicaoPor: "ambos" },
  vitalidade: {
    edicaoPor: "ambos",
    niveis: [
      { nome: "São", penalidadeDados: 0, bloqueiaAcoes: false },
      { nome: "Machucado", penalidadeDados: 1, bloqueiaAcoes: false },
      { nome: "Ferido", penalidadeDados: 1, bloqueiaAcoes: false },
      { nome: "Incapacitado", penalidadeDados: 0, bloqueiaAcoes: true },
    ],
  },
  conversaoFerimento: {
    habilitada: true,
    limiares: [
      { ate: 50, nivel: 1 },
      { ate: 25, nivel: 2 },
      { ate: 10, nivel: 3 },
    ],
  },
};

await prepararBanco(BANCO);
const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
let proc;
let ids;
const vidaDe = async (charId, cookie) =>
  (await req(BASE, "GET", `/characters/${charId}`, { cookie })).json?.ficha?.vida;
const hpPost = (charId, cookie, body) => req(BASE, "POST", `/characters/${charId}/hp`, { cookie, body });
const putConfig = (cookie, body) => req(BASE, "PUT", `/campaigns/${ids.camp}/regras/config`, { cookie, body });

try {
  proc = subirServidor(porta, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);

  const cenario = await criarCenario(BASE, BANCO, {
    jogadores: { jogador: "jogador_conversao" },
    config: CONFIG,
  });
  ids = {
    camp: cenario.campId, admin: cenario.adminId,
    charM: cenario.personagemMestre,
    charJ: cenario.novoPersonagem(cenario.jogadores.jogador.membershipId, "Personagem do Jogador"),
  };
  // Ficha antiga: tem __vitalidade nível 2 mas NUNCA teve __hp.
  ids.charAntigo = cenario.novoPersonagem(cenario.membMestre, "Veterano Antigo", {
    __vitalidade: { nivel: 2, historico: [] },
  });
  const cm = cenario.cookieMestre, cj = cenario.jogadores.jogador.cookie;
  console.log("seed:", ids);

  // ===== 1. Config =====
  sec("Config: persistência e validações");
  {
    const cfg = await req(BASE, "GET", `/campaigns/${ids.camp}/regras`, { cookie: cm });
    t("conversaoFerimento persistida", cfg.json?.config?.conversaoFerimento?.habilitada === true
      && cfg.json.config.conversaoFerimento.limiares?.length === 3, JSON.stringify(cfg.json?.config?.conversaoFerimento));

    const casos = [
      ["percentual > 100", { conversaoFerimento: { habilitada: true, limiares: [{ ate: 150, nivel: 1 }] } }],
      ["nível fora da escala", { conversaoFerimento: { habilitada: true, limiares: [{ ate: 50, nivel: 9 }] } }],
      ["percentual duplicado", { conversaoFerimento: { habilitada: true, limiares: [{ ate: 50, nivel: 1 }, { ate: 50, nivel: 2 }] } }],
    ];
    for (const [nome, patch] of casos) {
      const r = await putConfig(cm, patch);
      t(`rejeita ${nome}`, r.status === 400, `status=${r.status} ${JSON.stringify(r.json?.erro ?? "").slice(0, 80)}`);
    }
    // conversão habilitada sem HP -> rejeitada
    const rSemHp = await putConfig(cm, { hp: { habilitado: false } });
    t("conversão sem HP habilitado -> 400", rSemHp.status === 400, `status=${rSemHp.status} ${JSON.stringify(rSemHp.json?.erro ?? "").slice(0, 80)}`);
    await putConfig(cm, { hp: { habilitado: true } });
    const cfg2 = await req(BASE, "GET", `/campaigns/${ids.camp}/regras`, { cookie: cm });
    t("config válida restaurada", cfg2.json?.config?.hp?.habilitado === true);
  }

  // ===== 2. Conversão desativada =====
  sec("Conversão desativada");
  {
    await putConfig(cm, { conversaoFerimento: { habilitada: false } });
    const r = await hpPost(ids.charM, cm, { acao: "dano", quantidade: 60 });
    t("dano aplicado", r.status === 200 && r.json?.hp?.atual === 140, `hp=${r.json?.hp?.atual}`);
    t("resposta sem vitalidade", r.json?.vitalidade === undefined || r.json?.vitalidade === null);
    const v = await vidaDe(ids.charM, cm);
    t("vitalidade intacta nível 0", v?.vitalidade?.nivel === 0, `nivel=${v?.vitalidade?.nivel}`);
    await putConfig(cm, { conversaoFerimento: { habilitada: true } });
  }

  // ===== 3. Ativada — sem cruzar limiar =====
  sec("Dano sem cruzar limiar");
  {
    const r = await hpPost(ids.charM, cm, { acao: "dano", quantidade: 10 }); // 140->130 = 65%
    t("HP 130 (65%)", r.json?.hp?.atual === 130, `hp=${r.json?.hp?.atual}`);
    t("sem ferimento na resposta", !r.json?.ferimento, JSON.stringify(r.json?.ferimento));
    const v = await vidaDe(ids.charM, cm);
    t("vitalidade continua 0", v?.vitalidade?.nivel === 0);
    t("sem evento de vitalidade", (v?.vitalidade?.historico ?? []).length === 0, `n=${v?.vitalidade?.historico?.length}`);
  }

  // ===== 4. Cruza um limiar =====
  sec("Dano cruzando um limiar (65% -> 45%)");
  {
    const r = await hpPost(ids.charM, cm, { acao: "dano", quantidade: 40, motivo: "Espinho na floreva" }); // 130->90 = 45%
    t("HP 90", r.json?.hp?.atual === 90, `hp=${r.json?.hp?.atual}`);
    t("ferimento {0->1} na resposta", r.json?.ferimento?.de === 0 && r.json?.ferimento?.para === 1, JSON.stringify(r.json?.ferimento));
    t("vitalidade na resposta = Machucado", r.json?.vitalidade?.nivel === 1 && r.json?.vitalidade?.nome === "Machucado");
    const v = await vidaDe(ids.charM, cm);
    const ev = v?.vitalidade?.historico?.at(-1);
    t("histórico vit: 0->1 origem conversao", ev?.nivelAnterior === 0 && ev?.nivelNovo === 1 && ev?.origem === "conversao-ferimento", JSON.stringify(ev));
    t("motivo referencia o dano", /dano de 40 HP/.test(ev?.motivo ?? ""), ev?.motivo);
    t("autor = mestre", ev?.autorId === ids.admin && !!ev?.autorNome, JSON.stringify({ a: ev?.autorId, n: ev?.autorNome }));
  }

  // ===== 5. Cruza vários limiares =====
  sec("Dano cruzando vários limiares (45% -> 20%)");
  {
    const r = await hpPost(ids.charM, cm, { acao: "dano", quantidade: 50 }); // 90->40 = 20%
    t("HP 40", r.json?.hp?.atual === 40);
    t("ferimento {1->2} direto", r.json?.ferimento?.de === 1 && r.json?.ferimento?.para === 2, JSON.stringify(r.json?.ferimento));
    t("nível = Ferido (não +1 por limiar)", r.json?.vitalidade?.nivel === 2 && r.json?.vitalidade?.nome === "Ferido");
    const v = await vidaDe(ids.charM, cm);
    t("histórico vit tem 2 eventos", v?.vitalidade?.historico?.length === 2, `n=${v?.vitalidade?.historico?.length}`);
  }

  // ===== 6. HP chega a zero =====
  sec("HP zero -> nível máximo");
  {
    const r = await hpPost(ids.charM, cm, { acao: "dano", quantidade: 40 }); // 40->0 = 0%
    t("HP 0", r.json?.hp?.atual === 0);
    t("ferimento {2->3}", r.json?.ferimento?.de === 2 && r.json?.ferimento?.para === 3, JSON.stringify(r.json?.ferimento));
    t("Incapacitado (bloqueia)", r.json?.vitalidade?.nome === "Incapacitado" && r.json?.vitalidade?.bloqueiaAcoes === true);
  }

  // ===== 7. Recuperação não cura vitalidade =====
  sec("Recuperação de HP não reduz vitalidade");
  {
    const r = await hpPost(ids.charM, cm, { acao: "recuperar", quantidade: 200 });
    t("HP 200", r.json?.hp?.atual === 200);
    t("sem ferimento na recuperação", !r.json?.ferimento);
    const v = await vidaDe(ids.charM, cm);
    t("vitalidade continua Incapacitado", v?.vitalidade?.nivel === 3);
    t("sem evento novo de vitalidade", v?.vitalidade?.historico?.length === 3, `n=${v?.vitalidade?.historico?.length}`);
  }

  // ===== 8. Ajuste positivo não converte =====
  sec("Ajuste positivo sem conversão");
  {
    // HP está no máximo (200); primeiro aplica dano para abrir espaço
    await hpPost(ids.charM, cm, { acao: "dano", quantidade: 60 }); // 200->140 = 70% -> exigido null (vit já 3)
    const antes = (await vidaDe(ids.charM, cm))?.vitalidade?.historico?.length ?? 0;
    const r = await hpPost(ids.charM, cm, { acao: "ajuste", quantidade: 60 }); // 140->200
    t("ajuste +60 -> HP 200", r.json?.hp?.atual === 200, `hp=${r.json?.hp?.atual}`);
    const v = await vidaDe(ids.charM, cm);
    t("vitalidade inalterada", v?.vitalidade?.nivel === 3);
    t("sem evento novo", v?.vitalidade?.historico?.length === antes, `n=${v?.vitalidade?.historico?.length}`);
  }

  // ===== 9. Ajuste negativo segue regra de dano =====
  sec("Ajuste negativo converte (personagem do jogador)");
  {
    const r = await hpPost(ids.charJ, cj, { acao: "ajuste", quantidade: -160 }); // 200->40 = 20%
    t("jogador aplica ajuste -160", r.status === 200 && r.json?.hp?.atual === 40, `status=${r.status} hp=${r.json?.hp?.atual}`);
    t("ferimento {0->2}", r.json?.ferimento?.de === 0 && r.json?.ferimento?.para === 2, JSON.stringify(r.json?.ferimento));
    const v = await vidaDe(ids.charJ, cj);
    t("vit = Ferido", v?.vitalidade?.nivel === 2);
    t("origem conversao no histórico", v?.vitalidade?.historico?.at(-1)?.origem === "conversao-ferimento");
  }

  // ===== 10. Alteração manual de vitalidade =====
  sec("Alteração manual pelo mestre");
  {
    const r = await req(BASE, "POST", `/characters/${ids.charJ}/vitalidade`, { cookie: cm, body: { nivel: 0, motivo: "Tratamento completo" } });
    t("mestre zera vitalidade", r.status === 200 && r.json?.vitalidade?.nivel === 0);
    const v = await vidaDe(ids.charJ, cj);
    const ev = v?.vitalidade?.historico?.at(-1);
    t("evento manual origem=manual", ev?.origem === "manual" && ev?.motivo === "Tratamento completo", JSON.stringify(ev));
    // dano pequeno volta a cruzar limiar -> conversão reaplica
    await hpPost(ids.charJ, cj, { acao: "dano", quantidade: 5 }); // 40->35 = 17.5%
    const v2 = await vidaDe(ids.charJ, cj);
    t("conversão reaplica após cura manual", v2?.vitalidade?.nivel === 2, `nivel=${v2?.vitalidade?.nivel}`);
  }

  // ===== 11/12. Idempotência por estado + concorrência =====
  sec("Idempotência e concorrência");
  {
    // charM: vit3, HP200 -> dano 150 -> HP50 (25%) exigido 2 < 3: sem evento novo
    const histAntes = (await vidaDe(ids.charM, cm))?.vitalidade?.historico?.length ?? 0;
    const r = await hpPost(ids.charM, cm, { acao: "dano", quantidade: 150 }); // 200->50
    t("HP 50 (25%)", r.json?.hp?.atual === 50, `hp=${r.json?.hp?.atual}`);
    t("sem ferimento (nível já maior)", !r.json?.ferimento, JSON.stringify(r.json?.ferimento));
    const v = await vidaDe(ids.charM, cm);
    t("vit segue 3, histórico inalterado", v?.vitalidade?.nivel === 3 && v?.vitalidade?.historico?.length === histAntes);

    // dois danos simultâneos no charJ (HP35, vit2): 35-10-10=15 (7.5%) -> nível 3
    const [d1, d2] = await Promise.all([
      hpPost(ids.charJ, cj, { acao: "dano", quantidade: 10 }),
      hpPost(ids.charJ, cj, { acao: "dano", quantidade: 10 }),
    ]);
    t("duas respostas 200", d1.status === 200 && d2.status === 200, `${d1.status}/${d2.status}`);
    const vJ = await vidaDe(ids.charJ, cj);
    t("HP final 15 (sem perda de atualização)", vJ?.hp?.atual === 15, `hp=${vJ?.hp?.atual}`);
    t("vit final Incapacitado (nível 3)", vJ?.vitalidade?.nivel === 3, `nivel=${vJ?.vitalidade?.nivel}`);
    const ult = vJ?.vitalidade?.historico?.at(-1);
    t("último evento vit origem conversao 2->3", ult?.origem === "conversao-ferimento" && ult?.nivelAnterior === 2 && ult?.nivelNovo === 3, JSON.stringify(ult));
    const hpHist = vJ?.hp?.historico ?? [];
    t("histórico HP registrou os 2 danos", hpHist.filter((e) => e.tipo === "dano" && e.quantidade === -10).length >= 2, `n=${hpHist.length}`);
  }

  // ===== 13. Falha não deixa estado parcial =====
  sec("Rejeição sem efeito parcial");
  {
    const antes = await vidaDe(ids.charM, cm);
    const r = await hpPost(ids.charM, cm, { acao: "dano", quantidade: 10 }); // HP50->40? não: 50-10=40 (20%) -> exigido 2 < 3
    t("dano normal ok", r.status === 200);
    // agora HP 40; esgota e tenta de novo
    await hpPost(ids.charM, cm, { acao: "dano", quantidade: 40 }); // ->0
    const v0 = await vidaDe(ids.charM, cm);
    const histVit0 = v0?.vitalidade?.historico?.length ?? 0;
    const rej = await hpPost(ids.charM, cm, { acao: "dano", quantidade: 10 }); // HP já zero -> 400
    t("dano em HP zero -> 400", rej.status === 400, `status=${rej.status}`);
    const v1 = await vidaDe(ids.charM, cm);
    t("vitalidade inalterada após rejeição", v1?.vitalidade?.nivel === v0?.vitalidade?.nivel);
    t("histórico vit sem evento extra", v1?.vitalidade?.historico?.length === histVit0);
    t("HP continua 0", v1?.hp?.atual === 0);
    t("histórico HP sem evento extra", v1?.hp?.historico?.length === v0?.hp?.historico?.length);
  }

  // ===== 14/15. Fichas antigas =====
  sec("Fichas antigas");
  {
    const vAnt = await vidaDe(ids.charAntigo, cm);
    t("antigo: HP máximo virtual 200", vAnt?.hp?.maximo === 200 && vAnt?.hp?.atual === 200, `hp=${vAnt?.hp?.atual}/${vAnt?.hp?.maximo}`);
    t("antigo: vitalidade nível 2 preservado", vAnt?.vitalidade?.nivel === 2, `nivel=${vAnt?.vitalidade?.nivel}`);
    const r1 = await hpPost(ids.charAntigo, cm, { acao: "dano", quantidade: 10 }); // 200->190 = 95%
    t("dano pequeno não converte (95%)", r1.status === 200 && !r1.json?.ferimento, JSON.stringify(r1.json?.ferimento));
    const vA2 = await vidaDe(ids.charAntigo, cm);
    t("vit antigo segue 2", vA2?.vitalidade?.nivel === 2);
    const r2 = await hpPost(ids.charAntigo, cm, { acao: "dano", quantidade: 170 }); // 190->20 = 10%
    t("dano grande -> nível 3", r2.json?.ferimento?.de === 2 && r2.json?.ferimento?.para === 3, JSON.stringify(r2.json?.ferimento));
    const dados = JSON.parse(comDb(BANCO, (db) => db.prepare("select data from characters where id=?").get(ids.charAntigo).data));
    t("__hp inicializado no primeiro dano", dados.__hp?.atual === 20 && dados.__hp?.historico?.length === 2, JSON.stringify(dados.__hp).slice(0, 120));
  }

  // ===== 16/17. HP desabilitado =====
  sec("HP desabilitado");
  {
    // Desligar HP exige desligar a conversão junto (validação de config);
    // o caso "conversão ativa sem HP" já foi rejeitado na seção 1.
    await putConfig(cm, { conversaoFerimento: { habilitada: false }, hp: { habilitado: false } });
    const r = await hpPost(ids.charAntigo, cm, { acao: "dano", quantidade: 10 });
    t("POST /hp -> 400 sem HP", r.status === 400, `status=${r.status} ${JSON.stringify(r.json?.erro ?? "")}`);
    const v = await vidaDe(ids.charAntigo, cm);
    t("vitalidade intacta", v?.vitalidade?.nivel === 3);
    await putConfig(cm, { conversaoFerimento: { habilitada: true }, hp: { habilitado: true } });
    const cfg = await req(BASE, "GET", `/campaigns/${ids.camp}/regras`, { cookie: cm });
    t("HP restaurado", cfg.json?.config?.hp?.habilitado === true);
  }

  // ===== 18. Permissões =====
  sec("Permissões");
  {
    await putConfig(cm, { hp: { edicaoPor: "mestre" }, vitalidade: { edicaoPor: "mestre" } });
    const rHp = await hpPost(ids.charJ, cj, { acao: "dano", quantidade: 5 });
    t("jogador sem permissão HP -> 403", rHp.status === 403, `status=${rHp.status}`);
    const vAntes = await vidaDe(ids.charJ, cj);
    const rVit = await req(BASE, "POST", `/characters/${ids.charJ}/vitalidade`, { cookie: cj, body: { nivel: 0 } });
    t("jogador sem permissão vitalidade -> 403", rVit.status === 403, `status=${rVit.status}`);
    const vDepois = await vidaDe(ids.charJ, cj);
    t("nada alterado pelo jogador", vDepois?.hp?.atual === vAntes?.hp?.atual && vDepois?.vitalidade?.nivel === vAntes?.vitalidade?.nivel);
    // mestre aplica dano no char do jogador -> conversão ocorre
    const rM = await hpPost(ids.charJ, cm, { acao: "dano", quantidade: 10 }); // HP15->5 = 2.5%
    t("mestre causa dano -> 200", rM.status === 200, `status=${rM.status}`);
    t("conversão já no nível máximo", !rM.json?.ferimento || rM.json?.ferimento?.para === 3, JSON.stringify(rM.json?.ferimento));
    await putConfig(cm, { hp: { edicaoPor: "ambos" }, vitalidade: { edicaoPor: "ambos" } });
  }

  // ===== 19. Histórico e auditoria =====
  sec("Histórico e auditoria");
  {
    const v = await vidaDe(ids.charM, cm);
    const evs = v?.vitalidade?.historico ?? [];
    t("3 eventos de vitalidade (0->1,1->2,2->3)", evs.length === 3
      && evs[0].nivelNovo === 1 && evs[1].nivelNovo === 2 && evs[2].nivelNovo === 3, `n=${evs.length}`);
    t("todos origem conversao-ferimento", evs.every((e) => e.origem === "conversao-ferimento"));
    t("todos com motivo e autor", evs.every((e) => /dano de \d+ HP/.test(e.motivo ?? "") && e.autorId === ids.admin));
    const audit = JSON.parse(comDb(BANCO, (db) =>
      db.prepare("select detail from audit_logs where action='personagem.hp' and detail like '%\"para\"%' order by created_at desc limit 1").get()?.detail ?? "{}"));
    t("auditoria registra ferimento", typeof audit?.ferimento?.para === "number", JSON.stringify(audit).slice(0, 150));
    const dados = JSON.parse(comDb(BANCO, (db) => db.prepare("select data from characters where id=?").get(ids.charM).data));
    t("__vitalidade persistida nível 3", dados.__vitalidade?.nivel === 3);
    t("__hp e __vitalidade coexistem", !!dados.__hp && !!dados.__vitalidade);
  }

  // ===== 20/21. Penalidade e bloqueio em rolagem =====
  sec("Penalidade e bloqueio refletidos na rolagem");
  {
    // charJ está Incapacitado (nível 3) — volta para Machucado (nível 1, −1 dado)
    await req(BASE, "POST", `/characters/${ids.charJ}/vitalidade`, { cookie: cm, body: { nivel: 1 } });
    const s = await req(BASE, "POST", `/campaigns/${ids.camp}/sessoes`, { cookie: cm, body: { name: "Sessão Conversão" } });
    const SID = s.json?.sessao?.id;
    t("sessão criada", !!SID, `status=${s.status}`);
    const sockM = ioClient(BASE, { extraHeaders: { cookie: cm }, transports: ["polling", "websocket"] });
    const sockJ = ioClient(BASE, { extraHeaders: { cookie: cj }, transports: ["polling", "websocket"] });
    await Promise.all([new Promise((r) => sockM.on("connect", r)), new Promise((r) => sockJ.on("connect", r))]);
    const emitir = (sock, ev, payload) => new Promise((res) => sock.emit(ev, payload, res));
    const entrar = (sock) => new Promise((res) => sock.emit("mesa:entrar", { sessionId: SID }, res));
    await entrar(sockM); await entrar(sockJ);
    const esperar = (sock, ev, pred = () => true, ms = 6000) => new Promise((res) => {
      const h = (d) => { if (pred(d)) { clearTimeout(t); sock.off(ev, h); res(d); } };
      const t = setTimeout(() => { sock.off(ev, h); res(null); }, ms);
      sock.on(ev, h);
    });

    // penalidade: 6d20 -1 -> 5 dados
    const p1 = await emitir(sockM, "mesa:teste:pedir", { sessionId: SID, characterId: ids.charJ, dadosLados: 20, dadosCount: 6, requestId: "cv-t1-" + crypto.randomUUID().slice(0, 8) });
    t("teste pedido", p1?.ok === true, JSON.stringify(p1).slice(0, 120));
    const tid1 = p1?.id;
    const esp1 = esperar(sockJ, "mesa:rolagem", (r) => r.testId === tid1);
    const roll1 = await emitir(sockJ, "mesa:teste:rolar", { testId: tid1, requestId: "cv-r1-" + crypto.randomUUID().slice(0, 8) });
    const rol1 = await esp1;
    t("rolagem ok", roll1?.ok === true, JSON.stringify(roll1).slice(0, 150));
    t("penalidade −1: 6d -> 5d", rol1?.vitalidade?.dadosOriginais === 6 && rol1?.vitalidade?.dadosFinais === 5, JSON.stringify(rol1?.vitalidade));
    t("5 resultados", rol1?.dados?.length === 5, `n=${rol1?.dados?.length}`);

    // bloqueio: Incapacitado -> jogador bloqueado, mestre exceção
    await req(BASE, "POST", `/characters/${ids.charJ}/vitalidade`, { cookie: cm, body: { nivel: 3 } });
    const p2 = await emitir(sockM, "mesa:teste:pedir", { sessionId: SID, characterId: ids.charJ, dadosLados: 20, dadosCount: 2, requestId: "cv-t2-" + crypto.randomUUID().slice(0, 8) });
    const tid2 = p2?.id;
    const rollBloq = await emitir(sockJ, "mesa:teste:rolar", { testId: tid2 });
    t("Incapacitado bloqueia jogador", rollBloq?.ok === false && /Incapacitado/i.test(rollBloq?.erro ?? ""), JSON.stringify(rollBloq));
    const esp2 = esperar(sockM, "mesa:rolagem", (r) => r.testId === tid2);
    const rollM = await emitir(sockM, "mesa:teste:rolar", { testId: tid2, requestId: "cv-r2-" + crypto.randomUUID().slice(0, 8) });
    const rol2 = await esp2;
    t("mestre autoriza exceção", rollM?.ok === true && rol2?.vitalidade?.excecaoMestre === true, JSON.stringify(rol2?.vitalidade));
    sockM.close(); sockJ.close();
  }

  // ===== 22. Persistência após reinício =====
  sec("Persistência após reinício");
  {
    await encerrarServidor(proc);
    proc = subirServidor(porta, { banco: BANCO, arquivos: ARQ, backups: BKS });
    await esperarSaudavel(BASE, proc);
    const v = await vidaDe(ids.charM, cm);
    t("vit nível 3 persiste", v?.vitalidade?.nivel === 3, `nivel=${v?.vitalidade?.nivel}`);
    t("histórico vit persiste (3)", v?.vitalidade?.historico?.length === 3, `n=${v?.vitalidade?.historico?.length}`);
    t("HP persiste", v?.hp?.atual === 0, `hp=${v?.hp?.atual}`);
    const cfg = await req(BASE, "GET", `/campaigns/${ids.camp}/regras`, { cookie: cm });
    t("conversaoFerimento persiste", cfg.json?.config?.conversaoFerimento?.habilitada === true);
  }
} finally {
  await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
