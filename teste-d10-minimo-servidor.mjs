#!/usr/bin/env node
// Regression test: a free D10 roll must use the campaign's server-side
// threshold, never the minimo value supplied by an untrusted Socket.IO client.
import { io as ioClient } from "socket.io-client";
import {
  dirTeste, prepararBanco, portaLivre, subirServidor, esperarSaudavel,
  criarCenario, req, encerrarServidor, limparDir,
} from "./teste-base.mjs";

let pass = 0, fail = 0;
const t = (name, condition, extra = "") => {
  if (condition) { pass++; console.log("  ok", name); }
  else { fail++; console.log("  FALHOU", name, extra); }
};

const DIR = dirTeste("d10-minimo-servidor");
const BANCO = `${DIR}/banco/mestre-rpg.db`;
const ARQ = `${DIR}/arquivos/campanhas`;
const BKS = `${DIR}/backups`;
const PORTA = await portaLivre();
const BASE = `http://127.0.0.1:${PORTA}`;
let proc;
let socket;

try {
  await prepararBanco(BANCO);
  proc = subirServidor(PORTA, { banco: BANCO, arquivos: ARQ, backups: BKS });
  proc.stderr.on("data", (d) => process.stderr.write(d));
  await esperarSaudavel(BASE, proc);

  const c = await criarCenario(BASE, BANCO, {
    campanha: "Campanha D10 mínimo servidor",
    jogadores: { jogador1: "jogador_d10_minimo" },
    ficha: false,
  });

  const cfg8 = await req(BASE, "PUT", `/campaigns/${c.campId}/regras/config`, {
    cookie: c.cookieMestre,
    body: { dados: { d10SucessoMinimo: 8 } },
  });
  t("configuração de campanha aceita meta 8", cfg8.status === 200, `status=${cfg8.status}`);

  const criarSessao = await req(BASE, "POST", `/campaigns/${c.campId}/sessoes`, {
    cookie: c.cookieMestre,
    body: { name: "Sessão D10 mínimo servidor" },
  });
  const sessionId = criarSessao.json?.sessao?.id;
  t("sessão criada para testar rolagem livre", criarSessao.status === 201 && !!sessionId);

  socket = ioClient(BASE, {
    transports: ["websocket", "polling"],
    extraHeaders: { cookie: c.jogadores.jogador1.cookie },
    reconnection: false,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout conectando socket D10")), 10000);
    socket.once("connect", () => { clearTimeout(timer); resolve(); });
    socket.once("connect_error", (e) => { clearTimeout(timer); reject(e); });
  });

  const emitir = (payload) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout em mesa:rolar D10")), 10000);
    socket.emit("mesa:rolar", payload, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
  });

  const rolar = (minimoCliente) => emitir({
    sessionId,
    dados: [{ sides: 10, count: 5 }],
    motivo: "teste de mínimo autoritativo",
    d10: { positivos: 5, negativos: 0, ...(minimoCliente === undefined ? {} : { minimo: minimoCliente }) },
    requestId: crypto.randomUUID(),
  });

  // O cliente tenta facilitar o teste: 2 em vez da regra 8.
  const forjadoFacil = await rolar(2);
  const facesFacil = forjadoFacil?.grupos?.[0]?.resultados ?? [];
  const sucessosFacil = facesFacil.filter((v) => v >= 8).length;
  t("rolagem aceita usando meta autoritativa da campanha (8), não payload (2)",
    forjadoFacil?.ok === true && forjadoFacil?.d10?.minimo === 8,
    JSON.stringify(forjadoFacil?.d10));
  t("sucessos calculados com o limiar 8 do servidor",
    forjadoFacil?.d10?.sucessos === sucessosFacil
      && forjadoFacil?.d10?.falhas === facesFacil.length - sucessosFacil,
    `servidor=${forjadoFacil?.d10?.sucessos}/${forjadoFacil?.d10?.falhas}; esperado=${sucessosFacil}/${facesFacil.length - sucessosFacil}`);

  // Também deve ignorar valores fora da faixa: não rejeitar uma rolagem
  // legítima por um campo não confiável, nem usar 15 como dificuldade.
  const forjadoInvalido = await rolar(15);
  const facesInvalidas = forjadoInvalido?.grupos?.[0]?.resultados ?? [];
  t("minimo forjado fora da faixa é ignorado, não substitui a regra",
    forjadoInvalido?.ok === true && forjadoInvalido?.d10?.minimo === 8,
    JSON.stringify(forjadoInvalido?.d10));
  t("contagem da segunda rolagem continua usando o limiar 8",
    forjadoInvalido?.d10?.sucessos === facesInvalidas.filter((v) => v >= 8).length);

  // O cliente nem precisa enviar o campo minimo. Se a regra mudar, a
  // próxima rolagem deve usar a configuração atual relida no servidor.
  const cfg9 = await req(BASE, "PUT", `/campaigns/${c.campId}/regras/config`, {
    cookie: c.cookieMestre,
    body: { dados: { d10SucessoMinimo: 9 } },
  });
  t("mestre atualiza meta da campanha para 9", cfg9.status === 200, `status=${cfg9.status}`);
  const semMinimoCliente = await rolar(undefined);
  const faces9 = semMinimoCliente?.grupos?.[0]?.resultados ?? [];
  t("rolagem sem minimo no payload usa a regra atual 9",
    semMinimoCliente?.ok === true && semMinimoCliente?.d10?.minimo === 9,
    JSON.stringify(semMinimoCliente?.d10));
  t("contagem da terceira rolagem acompanha a meta 9",
    semMinimoCliente?.d10?.sucessos === faces9.filter((v) => v >= 9).length);

} catch (e) {
  fail++;
  console.error("FALHA INESPERADA:", e);
} finally {
  try { socket?.disconnect(); } catch {}
  try { await encerrarServidor(proc); } catch (e) { console.error(e); fail++; }
  limparDir(DIR);
}

console.log(`\n${pass} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
