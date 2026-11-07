import { useCallback, useEffect, useState } from "react";
import { api, type BackupServidor, type ConfigServidor, type LogServidor, type StatusServidor } from "../api";

function fmtBytes(b: number) {
  if (b > 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`;
  if (b > 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(b / 1024)} KB`;
}
function fmtUptime(s: number) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}min` : `${m}min`;
}

export default function Servidor() {
  const [status, setStatus] = useState<StatusServidor | null>(null);
  const [config, setConfig] = useState<ConfigServidor | null>(null);
  const [backups, setBackups] = useState<BackupServidor[]>([]);
  const [logs, setLogs] = useState<LogServidor[]>([]);
  const [aba, setAba] = useState<"status" | "backups" | "logs" | "config">("status");
  const [erro, setErro] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      const [s, c, b, l] = await Promise.all([api.statusServidor(), api.configServidor(), api.listarBackupsServidor(), api.logsServidor(150)]);
      setStatus(s); setConfig(c); setBackups(b.backups); setLogs(l.logs); setErro(null);
    } catch (e) { setErro(e instanceof Error ? e.message : "Erro ao carregar"); }
  }, []);
  useEffect(() => { void carregar(); const t = setInterval(() => void carregar(), 30000); return () => clearInterval(t); }, [carregar]);

  const backupAgora = async () => {
    try {
      const r = await api.criarBackupServidor();
      setMsg(r.sucesso ? "Backup criado com sucesso." : `Backup falhou: ${r.erros.join(", ")}`);
      await carregar();
    } catch (e) { setErro(e instanceof Error ? e.message : "Erro"); }
    setTimeout(() => setMsg(null), 5000);
  };
  const verificar = async (id: string) => {
    try {
      const r = await api.verificarBackupServidor(id);
      setMsg(r.ok ? "Backup íntegro." : `Problemas: ${r.detalhes.join("; ")}`);
    } catch (e) { setErro(e instanceof Error ? e.message : "Erro"); }
    setTimeout(() => setMsg(null), 6000);
  };
  const restaurar = async (id: string) => {
    if (!confirm("Restaurar este backup? Um backup de segurança do estado atual será criado antes. O servidor precisará ser reiniciado depois.")) return;
    try {
      const r = await api.restaurarBackupServidor(id, "preparar");
      setMsg(`Restauração preparada. ${r.proximoPasso ?? ""}`);
      await carregar();
    } catch (e) { setErro(e instanceof Error ? e.message : "Erro"); }
    setTimeout(() => setMsg(null), 8000);
  };
  const salvarConfig = async () => {
    if (!config) return;
    try {
      await api.salvarConfigServidor(config);
      setMsg("Configuração salva."); setTimeout(() => setMsg(null), 3000);
    } catch (e) { setErro(e instanceof Error ? e.message : "Erro"); }
  };

  const alertaLabel: Record<string, string> = {
    banco_inacessivel: "Banco de dados inacessível",
    diretorio_arquivos_indisponivel: "Diretório de arquivos indisponível",
    pouco_espaco_disco: "Pouco espaço em disco (<10%)",
    ultimo_backup_falhou: "Último backup falhou",
    nenhum_backup: "Nenhum backup registrado",
  };

  return (
    <section className="cartao">
      <div className="abas">
        <button className={aba === "status" ? "ativo" : "secundario"} onClick={() => setAba("status")}>Status</button>
        <button className={aba === "backups" ? "ativo" : "secundario"} onClick={() => setAba("backups")}>Backups</button>
        <button className={aba === "logs" ? "ativo" : "secundario"} onClick={() => setAba("logs")}>Logs</button>
        <button className={aba === "config" ? "ativo" : "secundario"} onClick={() => setAba("config")}>Configuração</button>
      </div>
      {erro && <p className="erro">{erro}</p>}
      {msg && <p className="sucesso">{msg}</p>}

      {aba === "status" && status && (
        <>
          <div className={`timer-display ${status.servidor.status === "ok" ? "rodando" : ""}`}>
            {status.servidor.status === "ok" ? "Operacional" : status.servidor.status === "avisos" ? "Operacional com avisos" : "Indisponível"}
          </div>
          {status.alertas.length > 0 && (
            <ul>{status.alertas.map((a) => <li key={a} className="erro">⚠ {alertaLabel[a] ?? a}</li>)}</ul>
          )}
          <div className="grade-form">
            <p><strong>Versão:</strong> {status.servidor.versao} · Node {status.servidor.node}</p>
            <p><strong>Uptime:</strong> {fmtUptime(status.servidor.uptimeSegundos)}</p>
            <p><strong>Banco:</strong> {status.banco.acessivel ? "acessível" : "INDISPONÍVEL"}</p>
            <p><strong>Arquivos:</strong> {fmtBytes(status.arquivos.tamanhoBytes)} · {status.arquivos.diretorioOk ? "ok" : "indisponível"}</p>
            <p><strong>Disco livre:</strong> {fmtBytes(status.disco.livreBytes)} de {fmtBytes(status.disco.totalBytes)}</p>
            <p><strong>Campanhas:</strong> {status.contagens.campanhas} · <strong>Usuários:</strong> {status.contagens.usuarios} · <strong>Sessões de mesa:</strong> {status.contagens.sessoesMesa}</p>
            <p><strong>Último backup:</strong> {status.backup ? `${new Date(status.backup.criadoEm).toLocaleString("pt-BR")} (${status.backup.sucesso === false ? "falhou" : "ok"})` : "nenhum"}</p>
          </div>
        </>
      )}

      {aba === "backups" && (
        <>
          <button onClick={backupAgora}>Fazer backup agora</button>
          <ul className="lista-anotacoes">
            {backups.map((b) => (
              <li key={b.id}>
                <div className="linha">
                  <strong>{new Date(b.createdAt).toLocaleString("pt-BR")}</strong>
                  <span className="dica">{b.kind} · {b.sizeBytes ? fmtBytes(b.sizeBytes) : "—"}{b.sucesso === false ? " · FALHOU" : ""}</span>
                  <button className="secundario" onClick={() => verificar(b.id)}>Verificar</button>
                  <button className="secundario" onClick={() => restaurar(b.id)}>Restaurar</button>
                </div>
                {b.note && <p className="dica">{b.note}</p>}
              </li>
            ))}
            {!backups.length && <li className="dica">Nenhum backup ainda. Use "Fazer backup agora".</li>}
          </ul>
        </>
      )}

      {aba === "logs" && (
        <ul className="lista-anotacoes">
          {logs.map((l, i) => (
            <li key={i}>
              <span className="dica">{l.ts ? new Date(l.ts).toLocaleString("pt-BR") : ""}</span>{" "}
              <strong>[{l.nivel}]</strong> {l.msg}
            </li>
          ))}
          {!logs.length && <li className="dica">Sem registros.</li>}
        </ul>
      )}

      {aba === "config" && config && (
        <div className="formulario">
          <label>Nome da instalação<input value={config.nomeInstalacao} onChange={(e) => setConfig({ ...config, nomeInstalacao: e.target.value })} /></label>
          <h4>Backup automático</h4>
          <div className="linha">
            <select value={config.backup.agenda} onChange={(e) => setConfig({ ...config, backup: { ...config.backup, agenda: e.target.value } })}>
              <option value="diario">Diário</option><option value="semanal">Semanal</option>
              <option value="ambos">Diário + semanal</option><option value="manual">Somente manual</option>
            </select>
            <label>Horário<input type="time" value={config.backup.hora} onChange={(e) => setConfig({ ...config, backup: { ...config.backup, hora: e.target.value } })} /></label>
            <label>Reter diários<input type="number" min={1} value={config.backup.retencaoDiarios} onChange={(e) => setConfig({ ...config, backup: { ...config.backup, retencaoDiarios: Number(e.target.value) } })} /></label>
            <label>Reter semanais<input type="number" min={1} value={config.backup.retencaoSemanais} onChange={(e) => setConfig({ ...config, backup: { ...config.backup, retencaoSemanais: Number(e.target.value) } })} /></label>
          </div>
          <label>Pasta de backups<input value={config.backup.pasta} onChange={(e) => setConfig({ ...config, backup: { ...config.backup, pasta: e.target.value } })} /></label>
          <h4>Acesso externo (HTTPS/túnel)</h4>
          <label>Domínio público<input placeholder="ex.: rpg.seudominio.com" value={config.acesso.dominioPublico} onChange={(e) => setConfig({ ...config, acesso: { ...config.acesso, dominioPublico: e.target.value } })} /></label>
          <label>Hops de proxy<input type="number" min={0} max={10} value={config.acesso.proxyHops} onChange={(e) => setConfig({ ...config, acesso: { ...config.acesso, proxyHops: Number(e.target.value) } })} /></label>
          <label className="check"><input type="checkbox" checked={config.acesso.https} onChange={(e) => setConfig({ ...config, acesso: { ...config.acesso, https: e.target.checked } })} /> Acesso via HTTPS</label>
          <h4>Uploads</h4>
          <label>Tamanho máximo (MB)<input type="number" min={1} value={config.arquivos.tamanhoMaxMb} onChange={(e) => setConfig({ ...config, arquivos: { tamanhoMaxMb: Number(e.target.value) } })} /></label>
          <button onClick={salvarConfig}>Salvar configuração</button>
        </div>
      )}
    </section>
  );
}
