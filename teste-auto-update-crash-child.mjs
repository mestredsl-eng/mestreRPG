// Processo-filho de teste: encerra abruptamente imediatamente após
// o fast-forward e antes da próxima etapa do protocolo de atualização.
import { verificarAtualizacao, executarReal } from "./scripts/auto-update.mjs";
import { writeSync } from "node:fs";
import { gravarEstado, JOURNAL_UPDATE } from "./scripts/estado-externo.mjs";

const repoDir = process.env.MESTRE_TEST_REPO;
const urlOficial = process.env.MESTRE_TEST_URL_OFICIAL;
if (!repoDir || !urlOficial) process.exit(90);

const trace = [];
const resultado = await verificarAtualizacao({
  cwd: repoDir,
  urlOficial,
  log(mensagem) {
    writeSync(1, `MESTRE_TEST_LOG:${String(mensagem)}\\n`);
  },
  executar(cmd, args, opcoes) {
    const r = executarReal(cmd, args, opcoes);
    if (cmd === "git") {
      trace.push({ args, code: r.code, stdout: String(r.stdout ?? "").trim(), stderr: String(r.stderr ?? "").trim() });
    }
    if (cmd === "git" && args[0] === "merge" && args[1] === "--ff-only" && r.code === 0) {
      // Marcador síncrono: o pai só aceita o cenário se o fast-forward foi
      // aplicado e o processo abortou antes de qualquer cleanup/finalização.
      writeSync(1, "MESTRE_TEST_CRASH_AFTER_FAST_FORWARD\\n");
      process.abort();
    }
    return r;
  },
  registrarPullAntes(dados) {
    gravarEstado(repoDir, JOURNAL_UPDATE, dados, process.env);
    writeSync(1, `MESTRE_TEST_JOURNAL_WRITTEN:${JSON.stringify(dados)}\\n`);
    return true;
  },
});
writeSync(1, `MESTRE_TEST_UPDATE_RESULT:${JSON.stringify(resultado)}\\n`);
writeSync(1, `MESTRE_TEST_GIT_TRACE:${JSON.stringify(trace)}\\n`);
process.exit(91); // Sentinela: chegou ao fim sem executar o crash esperado.
