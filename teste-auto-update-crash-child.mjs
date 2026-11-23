// Processo-filho de teste: simula encerramento abrupto imediatamente após
// o fast-forward, antes de verificar HEAD/registrar a próxima fase.
import { verificarAtualizacao, executarReal } from "./scripts/auto-update.mjs";
import { writeSync } from "node:fs";
import { gravarEstado, JOURNAL_UPDATE } from "./scripts/estado-externo.mjs";

const repoDir = process.env.MESTRE_TEST_REPO;
const urlOficial = process.env.MESTRE_TEST_URL_OFICIAL;
if (!repoDir || !urlOficial) process.exit(90);

await verificarAtualizacao({
  cwd: repoDir,
  urlOficial,
  executar(cmd, args, opcoes) {
    const r = executarReal(cmd, args, opcoes);
    if (cmd === "git" && args[0] === "merge" && args[1] === "--ff-only" && r.code === 0) {
      // Crash deliberado após o fast-forward: process.abort() termina o
      // processo sem executar finally/cleanup em POSIX e Windows. O marcador
      // síncrono permite ao pai provar que o crash ocorreu após o merge.
      writeSync(1, "MESTRE_TEST_CRASH_AFTER_FAST_FORWARD\\n");
      process.abort();
    }
    return r;
  },
  registrarPullAntes(dados) {
    gravarEstado(repoDir, JOURNAL_UPDATE, dados, process.env);
    return true;
  },
});
process.exit(91); // Se chegar aqui, a interrupção não ocorreu.
