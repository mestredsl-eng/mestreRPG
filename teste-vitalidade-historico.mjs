// Testes — histórico de Vitalidade (nível anterior/novo, data, autor, motivo).
// Banco criado do zero em diretório temporário + migrations + fixtures
// sintéticas (teste-base.mjs) — nunca copia a base real.
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, comDb, abrirDb, sessao, req,
  encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("vitalidade");
const BANCO = `${DIR}/teste.db`;
const ARQ = `${DIR}/arq`, BKS = `${DIR}/bks`;
const dadosPersonagem = (id) => JSON.parse(comDb(BANCO, (db) => db.prepare("select data from characters where id=?").get(id).data));

await prepararBanco(BANCO);
const porta = await portaLivre();
const BASE = `http://localhost:${porta}`;
let proc, ids, cookieMestre, cookieJogador;

async function vitalidadeDe(charId, cookie = cookieMestre) {
  const r = await req(BASE, "GET", `/characters/${charId}`, { cookie });
  return r.json?.ficha?.vida?.vitalidade ?? null;
}

try {
  proc = subirServidor(porta, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);

  const cenario = await criarCenario(BASE, BANCO, { jogadores: { jogador: "jogador_vitalidade" } });
  ids = { admin: cenario.adminId, camp: cenario.campId };
  // Personagem do mestre = "Veterano" antigo: removemos __vitalidade se houver
  const charId = cenario.personagemMestre;
  const w = abrirDb(BANCO);
  w.prepare("update characters set name=?, data=? where id=?")
    .run("Veterano", "{}", charId);
  const charJogador = cenario.novoPersonagem(cenario.jogadores.jogador.membershipId, "Personagem do jogador");
  w.close();
  ids.charId = charId; ids.charJogador = charJogador;
  cookieMestre = cenario.cookieMestre;
  cookieJogador = cenario.jogadores.jogador.cookie;
  console.log("seed:", ids);

  // ===== 1. Personagem antigo sem vitalidade =====
  sec("Personagem antigo (sem __vitalidade)");
  {
    const vit = await vitalidadeDe(ids.charId);
    t("resumo existe com nível 0", vit && vit.nivel === 0, JSON.stringify(vit).slice(0, 120));
    t("histórico vazio para personagem antigo", Array.isArray(vit?.historico) && vit.historico.length === 0, `hist=${vit?.historico?.length}`);
  }

  // ===== 2. Alterações repetidas com motivo =====
  sec("Alterações repetidas");
  {
    const r1 = await req(BASE, "POST", `/characters/${ids.charId}/vitalidade`, {
      cookie: cookieMestre, body: { nivel: 2, motivo: "Combate na taverna" },
    });
    t("1ª alteração → 200", r1.status === 200, `status=${r1.status} ${JSON.stringify(r1.json).slice(0, 120)}`);
    const r2 = await req(BASE, "POST", `/characters/${ids.charId}/vitalidade`, {
      cookie: cookieMestre, body: { nivel: 4 },
    });
    t("2ª alteração → 200", r2.status === 200, `status=${r2.status}`);
    const vit = await vitalidadeDe(ids.charId);
    t("nível final = 4", vit?.nivel === 4, `nivel=${vit?.nivel}`);
    t("histórico tem 2 eventos", vit?.historico?.length === 2, `n=${vit?.historico?.length}`);
    const [e1, e2] = vit.historico;
    t("evento 1: 0→2 com motivo e autor", e1.nivelAnterior === 0 && e1.nivelNovo === 2 && e1.motivo === "Combate na taverna" && !!e1.autorId && !!e1.autorNome, JSON.stringify(e1));
    t("evento 2: 2→4 sem motivo", e2.nivelAnterior === 2 && e2.nivelNovo === 4 && e2.motivo === null, JSON.stringify(e2));
    t("data ISO válida", !Number.isNaN(Date.parse(e1.em)) && !Number.isNaN(Date.parse(e2.em)));
    t("ordem cronológica (mais antigo primeiro)", Date.parse(e1.em) <= Date.parse(e2.em));
  }

  // ===== 3. Persistência no banco =====
  sec("Estado persistido em characters.data");
  {
    const dados = dadosPersonagem(ids.charId);
    const vit = dados.__vitalidade;
    t("__vitalidade.nivel = 4", vit?.nivel === 4, JSON.stringify(vit).slice(0, 150));
    t("__vitalidade.historico persistido (2)", vit?.historico?.length === 2, `n=${vit?.historico?.length}`);
    t("alteradoPor = admin", vit?.alteradoPor === ids.admin);
  }

  // ===== 4. PATCH genérico não adultera histórico =====
  sec("PATCH genérico não falsifica/apaga procedência");
  {
    const forjado = await req(BASE, "PATCH", `/characters/${ids.charId}`, {
      cookie: cookieMestre,
      body: { data: { __vitalidade: { nivel: 0, historico: [] }, __hp: { atual: 9999, historico: [] } } },
    });
    t("PATCH aceito", forjado.status === 200, `status=${forjado.status} ${JSON.stringify(forjado.json).slice(0, 150)}`);
    const dados = dadosPersonagem(ids.charId);
    t("__vitalidade.nivel continua 4", dados.__vitalidade?.nivel === 4, `nivel=${dados.__vitalidade?.nivel}`);
    t("histórico continua com 2 eventos", dados.__vitalidade?.historico?.length === 2, `n=${dados.__vitalidade?.historico?.length}`);
    t("__hp forjado não persistiu", dados.__hp?.atual !== 9999, `hp=${dados.__hp?.atual}`);
  }

  // ===== 5. Permissões =====
  sec("Permissões");
  {
    const rJogador = await req(BASE, "POST", `/characters/${ids.charJogador}/vitalidade`, {
      cookie: cookieJogador, body: { nivel: 3 },
    });
    t("jogador dono (edicaoPor=mestre) → 403", rJogador.status === 403, `status=${rJogador.status}`);
    const rMestre = await req(BASE, "POST", `/characters/${ids.charJogador}/vitalidade`, {
      cookie: cookieMestre, body: { nivel: 1, motivo: "Pelo mestre" },
    });
    t("mestre → 200", rMestre.status === 200, `status=${rMestre.status}`);
    const vit = await vitalidadeDe(ids.charJogador, cookieJogador);
    t("jogador lê histórico do próprio personagem", vit?.historico?.length === 1 && vit.historico[0].motivo === "Pelo mestre", JSON.stringify(vit?.historico).slice(0, 150));
    // nível inválido
    const rInv = await req(BASE, "POST", `/characters/${ids.charId}/vitalidade`, {
      cookie: cookieMestre, body: { nivel: 99 },
    });
    t("nível fora da escala → 400", rInv.status === 400, `status=${rInv.status}`);
  }

  // ===== 6. Persistência após reinício =====
  sec("Persistência após reinício do servidor");
  {
    await encerrarServidor(proc);
    proc = subirServidor(porta, { banco: BANCO, arquivos: ARQ, backups: BKS });
    await esperarSaudavel(BASE, proc);
    const vit = await vitalidadeDe(ids.charId);
    t("nível 4 mantido após restart", vit?.nivel === 4, `nivel=${vit?.nivel}`);
    t("histórico mantido após restart (2)", vit?.historico?.length === 2, `n=${vit?.historico?.length}`);
    t("evento mais recente por último na resposta", vit?.historico?.[1]?.nivelNovo === 4);
  }
} finally {
  await encerrarServidor(proc);
  limparDir(DIR);
}

console.log(`\n==== ${pass} ok, ${fail} falhas ====`);
process.exit(fail ? 1 : 0);
