// Testes HTTP — preferências visuais da conta (Issue #132, etapa 2.1).
// Cobre PATCH /api/auth/preferences com a chave `visual`: autenticação,
// isolamento entre usuários, validação strict do contrato, merge que
// preserva dados/temaMesa e concorrência real de sessões.
// Banco temporário + migrations reais; sem navegador.
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  req, sessao, abrirDb, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (n, c, extra = "") => { if (c) { pass++; console.log("  ok", n); } else { fail++; console.log("  FALHOU", n, extra); } };
const sec = (n) => console.log("\n== " + n + " ==");

const DIR = dirTeste("preferencias-visual");
const BANCO = `${DIR}/mestre-rpg-teste.db`;
await prepararBanco(BANCO);

const PORTA = await portaLivre();
const BASE = `http://localhost:${PORTA}`;
let proc;

const VISUAL_OK = {
  intensidade: "imersiva",
  corDestaque: "ambar",
  superficies: "elevado",
  textura: "intensa",
  animacoes: "reduzido",
  densidade: "compacta",
};
const VISUAL_PADRAO = {
  intensidade: "equilibrada",
  corDestaque: "vinho",
  superficies: "padrao",
  textura: "sutil",
  animacoes: "normal",
  densidade: "padrao",
};

const idDe = (username) => {
  const db = abrirDb(BANCO);
  const u = db.prepare("select id from users where username=?").get(username);
  db.close();
  return u?.id;
};

try {
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
  await esperarSaudavel(BASE, proc);

  sec("Setup — contas A e B");
  const setup = await req(BASE, "POST", "/auth/setup", { body: { username: "root", password: "senha-forte-123", email: "root@local.dev" } });
  t("setup cria admin", setup.status === 201, JSON.stringify(setup.json));
  const cookieRoot = sessao(BANCO, idDe("root"));
  for (const u of ["alice", "bob"]) {
    const c = await req(BASE, "POST", "/admin/users", { cookie: cookieRoot, body: { username: u, password: "senha-forte-123" } });
    t(`cria ${u}`, c.status === 201, JSON.stringify(c.json));
  }
  const cookieA = sessao(BANCO, idDe("alice"));
  const cookieA2 = sessao(BANCO, idDe("alice")); // segunda sessão da mesma conta
  const cookieB = sessao(BANCO, idDe("bob"));

  sec("Autenticação e isolamento");
  const semAuth = await req(BASE, "PATCH", "/auth/preferences", { body: { visual: VISUAL_OK } });
  t("PATCH sem autenticação → 401", semAuth.status === 401, `status=${semAuth.status}`);

  const salvaA = await req(BASE, "PATCH", "/auth/preferences", { cookie: cookieA, body: { visual: VISUAL_OK } });
  t("A salva visual válido → 200", salvaA.status === 200, `status=${salvaA.status} ${JSON.stringify(salvaA.json).slice(0, 200)}`);
  t("resposta ecoa visual salvo", salvaA.json?.preferences?.visual?.intensidade === "imersiva"
    && salvaA.json?.preferences?.visual?.corDestaque === "ambar", JSON.stringify(salvaA.json?.preferences?.visual));

  const meA = await req(BASE, "GET", "/auth/me", { cookie: cookieA });
  t("GET /me de A retorna visual persistido", meA.status === 200
    && meA.json?.usuario?.preferences?.visual?.densidade === "compacta", JSON.stringify(meA.json?.usuario?.preferences?.visual));

  const meB = await req(BASE, "GET", "/auth/me", { cookie: cookieB });
  t("B não recebe visual de A", meB.status === 200
    && meB.json?.usuario?.preferences?.visual === undefined, JSON.stringify(meB.json?.usuario?.preferences));

  sec("Validação strict do contrato visual");
  const casosInvalidos = [
    ["intensidade fora do enum", { ...VISUAL_OK, intensidade: "máxima" }],
    ["cor fora da paleta", { ...VISUAL_OK, corDestaque: "dourado" }],
    ["cor CSS arbitrária", { ...VISUAL_OK, corDestaque: "#ff0000" }],
    ["propriedade extra em visual", { ...VISUAL_OK, hack: true }],
    ["campo obrigatório ausente", { intensidade: "discreta", corDestaque: "vinho" }],
    ["animacoes inválido", { ...VISUAL_OK, animacoes: "turbo" }],
    ["densidade inválida", { ...VISUAL_OK, densidade: "gigante" }],
    ["superficies inválido", { ...VISUAL_OK, superficies: "holograma" }],
    ["textura inválida", { ...VISUAL_OK, textura: "neon" }],
  ];
  for (const [nome, visual] of casosInvalidos) {
    const r = await req(BASE, "PATCH", "/auth/preferences", { cookie: cookieA, body: { visual } });
    t(`rejeita ${nome} → 400`, r.status === 400, `status=${r.status}`);
  }
  const topoExtra = await req(BASE, "PATCH", "/auth/preferences", { cookie: cookieA, body: { hacker: true } });
  t("chave desconhecida no nível superior → 400", topoExtra.status === 400, `status=${topoExtra.status}`);
  const visualNull = await req(BASE, "PATCH", "/auth/preferences", { cookie: cookieA, body: { visual: null } });
  t("visual:null rejeitado (schema não aceita null)", visualNull.status === 400, `status=${visualNull.status}`);

  const meAposInvalidos = await req(BASE, "GET", "/auth/me", { cookie: cookieA });
  t("rejeições não alteraram visual persistido", meAposInvalidos.json?.usuario?.preferences?.visual?.intensidade === "imersiva"
    && meAposInvalidos.json?.usuario?.preferences?.visual?.corDestaque === "ambar",
    JSON.stringify(meAposInvalidos.json?.usuario?.preferences?.visual));

  sec("Merge — visual convive com dados e temaMesa");
  const salvaDados = await req(BASE, "PATCH", "/auth/preferences", { cookie: cookieA, body: { dados: { corExterna: "#112233", corInterna: "#ffcc00" } } });
  t("salva dados → 200", salvaDados.status === 200, `status=${salvaDados.status}`);
  t("dados persistiu E visual intacto", salvaDados.json?.preferences?.dados?.corExterna === "#112233"
    && salvaDados.json?.preferences?.visual?.intensidade === "imersiva",
    JSON.stringify(salvaDados.json?.preferences).slice(0, 300));

  const salvaTema = await req(BASE, "PATCH", "/auth/preferences", { cookie: cookieA, body: { temaMesa: "vinho" } });
  t("salva temaMesa → 200", salvaTema.status === 200, `status=${salvaTema.status}`);
  t("temaMesa persistiu E visual/dados intactos", salvaTema.json?.preferences?.temaMesa === "vinho"
    && salvaTema.json?.preferences?.visual?.corDestaque === "ambar"
    && salvaTema.json?.preferences?.dados?.corInterna === "#ffcc00",
    JSON.stringify(salvaTema.json?.preferences).slice(0, 300));

  const visual2 = { ...VISUAL_OK, intensidade: "discreta", animacoes: "completo", densidade: "ampla" };
  const salvaVisual2 = await req(BASE, "PATCH", "/auth/preferences", { cookie: cookieA, body: { visual: visual2 } });
  t("atualiza visual → substitui objeto inteiro", salvaVisual2.status === 200
    && salvaVisual2.json?.preferences?.visual?.intensidade === "discreta"
    && salvaVisual2.json?.preferences?.visual?.animacoes === "completo"
    && salvaVisual2.json?.preferences?.dados?.corExterna === "#112233"
    && salvaVisual2.json?.preferences?.temaMesa === "vinho",
    JSON.stringify(salvaVisual2.json?.preferences).slice(0, 300));

  const restaura = await req(BASE, "PATCH", "/auth/preferences", { cookie: cookieA, body: { visual: VISUAL_PADRAO } });
  t("restaurar padrões (VISUAL_PADRAO) → 200", restaura.status === 200, `status=${restaura.status}`);
  t("visual virou padrão E dados/temaMesa preservados", restaura.json?.preferences?.visual?.intensidade === "equilibrada"
    && restaura.json?.preferences?.visual?.corDestaque === "vinho"
    && restaura.json?.preferences?.dados?.corExterna === "#112233"
    && restaura.json?.preferences?.temaMesa === "vinho",
    JSON.stringify(restaura.json?.preferences).slice(0, 300));

  const salvaVisualFinal = await req(BASE, "PATCH", "/auth/preferences", { cookie: cookieA, body: { visual: VISUAL_OK } });
  t("visual final restaurado para cenários seguintes", salvaVisualFinal.status === 200);

  sec("Concorrência — chaves diferentes, mesmo usuário");
  // Três PATCH simultâneos de chaves distintas a partir de sessões
  // diferentes da MESMA conta: leitura+merge+gravação devem ser atômicos,
  // senão a última escrita sobrescreveria as anteriores com JSON velho.
  const dadosConc = { corExterna: "#abcdef", corInterna: "#123456" };
  const visualConc = { ...VISUAL_PADRAO, intensidade: "imersiva", corDestaque: "violeta", densidade: "compacta" };
  const [r1, r2, r3] = await Promise.all([
    req(BASE, "PATCH", "/auth/preferences", { cookie: cookieA, body: { dados: dadosConc } }),
    req(BASE, "PATCH", "/auth/preferences", { cookie: cookieA2, body: { visual: visualConc } }),
    req(BASE, "PATCH", "/auth/preferences", { cookie: cookieA, body: { temaMesa: "madeira" } }),
  ]);
  t("três PATCH concorrentes → todos 200", r1.status === 200 && r2.status === 200 && r3.status === 200,
    `${r1.status}/${r2.status}/${r3.status}`);

  const meFinal = await req(BASE, "GET", "/auth/me", { cookie: cookieA });
  const prefsF = meFinal.json?.usuario?.preferences ?? {};
  t("concorrência: dados presente com valor final", prefsF.dados?.corExterna === "#abcdef" && prefsF.dados?.corInterna === "#123456",
    JSON.stringify(prefsF.dados));
  t("concorrência: visual presente com valor final", prefsF.visual?.intensidade === "imersiva"
    && prefsF.visual?.corDestaque === "violeta" && prefsF.visual?.densidade === "compacta",
    JSON.stringify(prefsF.visual));
  t("concorrência: temaMesa presente com valor final", prefsF.temaMesa === "madeira", JSON.stringify(prefsF.temaMesa));

  // Repetição com mais disparos para aumentar a chance de interleaving
  const rajada = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    req(BASE, "PATCH", "/auth/preferences", { cookie: i % 2 ? cookieA : cookieA2, body: { visual: { ...visualConc, intensidade: i % 2 ? "discreta" : "imersiva" } } })
  ));
  t("rajada de 8 PATCH visual → todos 200", rajada.every((r) => r.status === 200), rajada.map((r) => r.status).join(","));
  const meRajada = await req(BASE, "GET", "/auth/me", { cookie: cookieA });
  const visRajada = meRajada.json?.usuario?.preferences?.visual;
  t("rajada: visual íntegro (objeto completo válido)", visRajada?.corDestaque === "violeta" && visRajada?.densidade === "compacta"
    && ["discreta", "imersiva"].includes(visRajada?.intensidade), JSON.stringify(visRajada));

  sec("Isolamento — B permanece intacto");
  const meBFim = await req(BASE, "GET", "/auth/me", { cookie: cookieB });
  t("B continua sem nenhuma preferência visual/dados/tema", meBFim.json?.usuario?.preferences?.visual === undefined
    && meBFim.json?.usuario?.preferences?.dados === undefined
    && meBFim.json?.usuario?.preferences?.temaMesa === undefined,
    JSON.stringify(meBFim.json?.usuario?.preferences));

  console.log(`\n${pass} ok / ${fail} falhas`);
  if (fail > 0) process.exitCode = 1;
} finally {
  if (proc) await encerrarServidor(proc);
  limparDir(DIR);
}
