import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api, type CampanhaResumo, type PacoteCampanha } from "../api";
import { ModalConfirmar } from "../Modal";

const STATUS_LABEL: Record<string, string> = {
  preparacao: "Em preparação",
  andamento: "Em andamento",
  pausada: "Pausada",
  concluida: "Concluída",
  arquivada: "Arquivada",
};

export const statusLabel = (s: string) => STATUS_LABEL[s] ?? s;

export default function Campanhas({ aoAbrir }: { aoAbrir: (id: string) => void }) {
  const [campanhas, setCampanhas] = useState<CampanhaResumo[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [criando, setCriando] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", system: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const inputImport = useRef<HTMLInputElement>(null);
  const [importPendente, setImportPendente] = useState<{ pacote: PacoteCampanha; msgErro: string } | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const carregar = useCallback(async () => {
    try {
      const { campanhas } = await api.listarCampanhas();
      setCampanhas(campanhas);
      setErro(null);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao carregar campanhas");
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  const criar = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const { campanha } = await api.criarCampanha({
        name: form.name,
        description: form.description || undefined,
        system: form.system || undefined,
      });
      setCriando(false);
      setForm({ name: "", description: "", system: "" });
      aoAbrir(campanha.id);
    } catch (err) {
      setErro(err instanceof Error ? err.message : "Erro ao criar campanha");
    }
  };

  const importar = async (arquivo: File) => {
    try {
      const pacote = JSON.parse(await arquivo.text()) as PacoteCampanha;
      if (pacote?.versao !== 1 || !pacote.estado) throw new Error("Arquivo não é um pacote de campanha válido.");
      try {
        await api.importarCampanha(pacote, "nova");
        setMsg("Campanha importada.");
      } catch (e) {
        const msgErro = e instanceof Error ? e.message : "Erro ao importar";
        // identificador já existente → oferece substituição explícita (exige ser mestre da campanha)
        if (!msgErro.includes("Já existe")) throw e;
        setImportPendente({ pacote, msgErro });
        return;
      }
      void carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao importar pacote");
    }
  };

  const confirmarSubstituir = async () => {
    if (!importPendente || ocupado) return;
    setOcupado(true);
    try {
      await api.importarCampanha(importPendente.pacote, "substituir", importPendente.pacote.campanhaId);
      setImportPendente(null);
      setMsg("Campanha substituída pelo pacote importado.");
      void carregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Erro ao substituir campanha");
    } finally {
      setOcupado(false);
    }
  };

  return (
    <>
      <section className="cartao">
        <div className="linha-entre">
          <h2>Minhas campanhas</h2>
          <div className="linha">
            <input ref={inputImport} type="file" accept=".json,application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importar(f); e.target.value = ""; }} />
            <button className="secundario" onClick={() => inputImport.current?.click()}>Importar campanha</button>
            <button onClick={() => setCriando((v) => !v)}>{criando ? "Cancelar" : "Nova campanha"}</button>
          </div>
        </div>
        {erro && <p className="erro">{erro}</p>}
        {msg && <p className="sucesso">{msg}</p>}

        {criando && (
          <form className="formulario" onSubmit={criar}>
            <label>Nome da campanha<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required minLength={2} /></label>
            <label>Sistema de RPG<input placeholder="Ex.: Caçadores & Caçados, D&D, sistema próprio…" value={form.system} onChange={(e) => setForm({ ...form, system: e.target.value })} /></label>
            <label>Descrição<textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={3} /></label>
            <button type="submit">Criar campanha</button>
          </form>
        )}
      </section>

      {campanhas.length === 0 && !criando && (
        <section className="cartao"><p>Nenhuma campanha ainda. Crie a primeira!</p></section>
      )}

      {campanhas.map((c) => (
        <section key={c.id} className="cartao cartao-campanha" onClick={() => aoAbrir(c.id)}>
          <div className="linha-entre">
            <h2>{c.name}</h2>
            <span className={`badge badge-${c.status}`}>{statusLabel(c.status)}</span>
          </div>
          {c.system && <p className="sistema">Sistema: {c.system}</p>}
          {c.description && <p>{c.description}</p>}
          <p className="meta">
            Seu papel: {c.meuPapel === "mestre" ? "Mestre" : c.meuPapel === "espectador" ? "Espectador" : "Jogador"}
            {c.meuStatus === "pendente" && " — aguardando aprovação"}
            {c.meuStatus === "bloqueado" && " — participação bloqueada"}
          </p>
        </section>
      ))}

      {importPendente && (
        <ModalConfirmar
          titulo="Substituir campanha"
          mensagem={`${importPendente.msgErro}\n\nDeseja SUBSTITUIR a campanha existente por este pacote? Um ponto de recuperação do estado atual será criado antes.`}
          rotuloConfirmar="Substituir"
          perigo
          ocupado={ocupado}
          aoConfirmar={() => void confirmarSubstituir()}
          aoCancelar={() => { if (!ocupado) { setImportPendente(null); setErro("Importação cancelada."); } }}
        />
      )}
    </>
  );
}
