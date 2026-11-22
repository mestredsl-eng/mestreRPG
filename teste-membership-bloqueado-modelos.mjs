// Regressão de autorização: membership bloqueada não deve ler modelos/rascunhos.
// Membership pendente pode consultar apenas modelos publicados, nunca estrutura não publicada.
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  encerrarServidor, limparDir, req, criarCenario,
} from "./teste-base.mjs";

const DIR = dirTeste("membership-bloqueado-modelos");
const BANCO = `${DIR}/mestre-rpg-teste.db`;

let pass = 0;
let fail = 0;
const t = (nome, ok, extra = "") => {
  if (ok) { pass++; console.log("  ok", nome); }
  else { fail++; console.log("  FALHOU", nome, extra); }
};

let proc = null;
try {
  await prepararBanco(BANCO);
  const porta = await portaLivre();
  const base = `http://127.0.0.1:${porta}`;
  proc = subirServidor(porta, { banco: BANCO, arquivos: `${DIR}/arq`, backups: `${DIR}/bks` });
  await esperarSaudavel(base, proc);

  const C = await criarCenario(base, BANCO, {
    jogadores: { jogador1: "bloqueado_modelo" },
  });
  const { campId, cookieMestre, jogadores } = C;
  const jogador = jogadores.jogador1;
  const prefixo = `/campaigns/${campId}/sheet-templates`;

  // O mestre cria um modelo ativo com versão ainda não publicada.
  const criado = await req(base, "POST", prefixo, {
    cookie: cookieMestre,
    body: { name: "Modelo confidencial" },
  });
  const templateId = criado.json?.modelo?.id;
  t("mestre cria modelo com rascunho", criado.status === 201 && !!templateId, JSON.stringify(criado.json));

  // Concede mestre ao participante para provar primeiro o acesso legítimo.
  const promove = await req(base, "PATCH", `/campaigns/${campId}/members/${jogador.membershipId}`, {
    cookie: cookieMestre,
    body: { role: "mestre" },
  });
  t("jogador promovido a mestre ativo", promove.status === 200, JSON.stringify(promove.json));

  const detalheAtivo = await req(base, "GET", `${prefixo}/${templateId}`, { cookie: jogador.cookie });
  const versaoRascunhoAtiva = detalheAtivo.json?.versoes?.find(v => v.rascunho === true);
  t("mestre ativo lê estrutura do próprio rascunho (controle positivo)",
    detalheAtivo.status === 200 && !!versaoRascunhoAtiva?.estrutura,
    `status=${detalheAtivo.status}`);

  // Pendente ainda vê somente modelos publicados — não o rascunho de mestre.
  const pendente = await req(base, "PATCH", `/campaigns/${campId}/members/${jogador.membershipId}`, {
    cookie: cookieMestre,
    body: { status: "pendente" },
  });
  t("mestre passa a pendente", pendente.status === 200, JSON.stringify(pendente.json));
  const listaPendente = await req(base, "GET", prefixo, { cookie: jogador.cookie });
  t("membership pendente não lista modelo cujo currentVersion é rascunho",
    listaPendente.status === 200 && !(listaPendente.json?.modelos ?? []).some(m => m.id === templateId),
    `status=${listaPendente.status}`);
  const detalhePendente = await req(base, "GET", `${prefixo}/${templateId}`, { cookie: jogador.cookie });
  const rascunhoPendente = detalhePendente.json?.versoes?.find(v => v.rascunho === true);
  t("membership pendente não recebe estrutura do rascunho",
    detalhePendente.status === 200 && !!rascunhoPendente && !("estrutura" in rascunhoPendente),
    `status=${detalhePendente.status}`);

  // O status bloqueado deve cortar também as leituras de modelos, inclusive
  // quando o papel histórico ainda é mestre.
  const bloqueia = await req(base, "PATCH", `/campaigns/${campId}/members/${jogador.membershipId}`, {
    cookie: cookieMestre,
    body: { status: "bloqueado" },
  });
  t("membership mestre bloqueada", bloqueia.status === 200, JSON.stringify(bloqueia.json));
  const listaBloqueada = await req(base, "GET", prefixo, { cookie: jogador.cookie });
  t("membership bloqueada não lista modelos (403)",
    listaBloqueada.status === 403, `status=${listaBloqueada.status}`);
  const detalheBloqueado = await req(base, "GET", `${prefixo}/${templateId}`, { cookie: jogador.cookie });
  t("membership bloqueada não lê detalhe/versões (403)",
    detalheBloqueado.status === 403, `status=${detalheBloqueado.status}`);

  // Restaurar o fixture antes do teardown deixa a semântica do teste isolada.
  await req(base, "PATCH", `/campaigns/${campId}/members/${jogador.membershipId}`, {
    cookie: cookieMestre,
    body: { role: "jogador", status: "ativo" },
  });
} catch (e) {
  fail++;
  console.log("FALHOU exceção não tratada:", e?.stack ?? e);
} finally {
  try { await encerrarServidor(proc); }
  catch (e) { fail++; console.error("[teardown] servidor:", e?.message ?? e); }
  try { if (!limparDir(DIR)) fail++; }
  catch (e) { fail++; console.error("[teardown] fixture:", e?.message ?? e); }
}
console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
