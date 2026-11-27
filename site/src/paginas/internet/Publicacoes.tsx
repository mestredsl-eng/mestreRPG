// Internet pública 1.1.2 (#365 — fatia W4/W5 + W8-subset): feed de
// publicações, matéria completa, publicar/editar e "minhas".
// Consome o adaptador REST (adaptador-publica.ts) — o gate do servidor
// decide o que é visível; a UI nunca presume acesso.
//
// Regras refletidas na UI (contrato CONTRATO-W4W5):
//   - feed só mostra publicado+visível; rascunho é 404 idêntico a
//     inexistente para terceiros (estado "indisponível" honesto);
//   - pseudônimo exibe pseudoNome e NUNCA handle real;
//   - origem='sistema' (notícia de morte) é somente-leitura — selo
//     "automática" e sem ações de edição;
//   - criação sempre nasce rascunho; publicar é transição posterior
//     com expectedVersion (concorrência → 409 com retry orientado);
//   - denúncia por motivo (ilegal = grave, remoção automática DP-3);
//   - visibilidade 'contatos' é declarada no formulário (W8) e o
//     servidor revalida aresta na leitura — a UI não filtra sozinha.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError } from "../../api";
import type { AdaptadorInternetPublica } from "./adaptador-publica";
import type {
  MinhaPublicacao, PublicacaoDetalhe, PublicacaoNova, PublicacaoResumo,
  TipoPublicacao, VisibilidadePublicacao,
} from "./tipos-publica";
import { Carregando, ErroRetry, Vazio } from "./estados";

const ROTULO_DATA = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" });
const ROTULO_HORA = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });
const MOTIVOS_DENUNCIA = [
  { v: "spam", r: "Spam" },
  { v: "ofensa", r: "Ofensa" },
  { v: "ilegal", r: "Conteúdo ilegal" },
  { v: "outro", r: "Outro motivo" },
] as const;

type VisaoPub =
  | { tipo: "feed" }
  | { tipo: "materia"; id: string }
  | { tipo: "publicar"; editando?: MinhaPublicacao }
  | { tipo: "minhas" };

function nomeAutor(p: { autor: PublicacaoResumo["autor"] }): string {
  if (!p.autor) return "fonte da campanha";
  if (p.autor.modo === "pseudonimo") return p.autor.nome;
  return `@${p.autor.handle}`;
}

export default function Publicacoes({ adaptador }: { adaptador: AdaptadorInternetPublica }) {
  const [pilha, setPilha] = useState<VisaoPub[]>([{ tipo: "feed" }]);
  const visao = pilha[pilha.length - 1];
  const irPara = (v: VisaoPub) => setPilha((p) => [...p, v]);
  const voltar = () => setPilha((p) => (p.length > 1 ? p.slice(0, -1) : p));

  return (
    <div className="internet-publicacoes">
      {visao.tipo !== "feed" && (
        <div className="internet-thread-cab">
          <button type="button" className="secundario internet-thread-voltar" onClick={voltar}>
            ← Voltar
          </button>
        </div>
      )}
      {visao.tipo === "feed" && (
        <FeedPublicacoes
          adaptador={adaptador}
          aoAbrir={(id) => irPara({ tipo: "materia", id })}
          aoPublicar={() => irPara({ tipo: "publicar" })}
          aoMinhas={() => irPara({ tipo: "minhas" })}
        />
      )}
      {visao.tipo === "materia" && (
        <MateriaView
          key={visao.id}
          adaptador={adaptador}
          id={visao.id}
          aoEditar={(m) => irPara({ tipo: "publicar", editando: m })}
        />
      )}
      {visao.tipo === "publicar" && (
        <FormPublicacao
          key={visao.editando?.id ?? "novo"}
          adaptador={adaptador}
          editando={visao.editando}
          aoConcluir={() => setPilha((p) => {
            // volta ao feed (ou a "minhas" se a edição veio de lá)
            const i = p.map((v) => v.tipo).lastIndexOf("minhas");
            return i >= 0 ? p.slice(0, i + 1) : [{ tipo: "feed" as const }];
          })}
        />
      )}
      {visao.tipo === "minhas" && (
        <MinhasView
          adaptador={adaptador}
          aoEditar={(m) => irPara({ tipo: "publicar", editando: m })}
          aoAbrir={(id) => irPara({ tipo: "materia", id })}
        />
      )}
    </div>
  );
}

// ---------- W4: feed ----------

function FeedPublicacoes({ adaptador, aoAbrir, aoPublicar, aoMinhas }: {
  adaptador: AdaptadorInternetPublica;
  aoAbrir: (id: string) => void;
  aoPublicar: () => void;
  aoMinhas: () => void;
}) {
  const [tipo, setTipo] = useState<"" | TipoPublicacao>("");
  const [itens, setItens] = useState<PublicacaoResumo[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [fase, setFase] = useState<"carregando" | "ok" | "erro" | "sem-acesso">("carregando");
  const [carregandoMais, setCarregandoMais] = useState(false);
  const [tentativa, setTentativa] = useState(0);

  const carregar = useCallback(async (cursorInicial: string | null) => {
    try {
      const r = await adaptador.listarPublicacoes({ tipo: tipo || undefined, cursor: cursorInicial });
      setItens((atual) => (cursorInicial ? [...(atual ?? []), ...r.itens] : r.itens));
      setCursor(r.proximoCursor);
      setFase("ok");
    } catch (e) {
      setFase(e instanceof ApiError && e.status === 403 ? "sem-acesso" : "erro");
    }
  }, [adaptador, tipo]);

  useEffect(() => {
    setFase("carregando");
    setItens(null);
    setCursor(null);
    void carregar(null);
  }, [carregar, tentativa]);

  const carregarMais = async () => {
    if (!cursor) return;
    setCarregandoMais(true);
    await carregar(cursor);
    setCarregandoMais(false);
  };

  return (
    <section aria-label="Publicações da campanha" className="internet-feed">
      <div className="internet-feed-acoes">
        <div className="internet-feed-filtros" role="group" aria-label="Filtrar por tipo">
          {([["", "Todas"], ["noticia", "Notícias"], ["post_perfil", "Perfis"]] as const).map(([v, r]) => (
            <button
              key={v || "todas"}
              type="button"
              className={tipo === v ? "secundario ativo" : "secundario"}
              aria-pressed={tipo === v}
              onClick={() => setTipo(v)}
            >{r}</button>
          ))}
        </div>
        <div className="internet-feed-botoes">
          <button type="button" className="secundario" onClick={aoMinhas}>Minhas</button>
          <button type="button" className="primario" onClick={aoPublicar}>Publicar</button>
        </div>
      </div>

      {fase === "carregando" && <Carregando rotulo="Carregando publicações…" />}
      {fase === "sem-acesso" && (
        <ErroRetry
          mensagem="Sem acesso ao feed público — é preciso uma conta de Internet autorizada (ou ser o mestre)."
          aoTentar={() => setTentativa((n) => n + 1)}
        />
      )}
      {fase === "erro" && (
        <ErroRetry mensagem="Não foi possível carregar as publicações." aoTentar={() => setTentativa((n) => n + 1)} />
      )}
      {fase === "ok" && itens !== null && itens.length === 0 && (
        <Vazio titulo="Nenhuma publicação por aqui ainda" dica="Seja a primeira pessoa a publicar." />
      )}
      {fase === "ok" && itens !== null && itens.length > 0 && (
        <ul className="internet-inbox" aria-label="Publicações">
          {itens.map((p) => (
            <li key={p.id}>
              <button type="button" className="internet-conversa-item" onClick={() => aoAbrir(p.id)}>
                <span className="crescer">
                  <span className="internet-conversa-nome">
                    {p.titulo}
                    {p.origem === "sistema" && <span className="internet-selo-sistema"> automática</span>}
                  </span>
                  <span className="internet-conversa-meta">
                    {nomeAutor(p)}
                    {" · "}{ROTULO_DATA.format(new Date(p.publicadoEm ?? p.atualizadoEm))}
                    {p.visibilidade === "contatos" && " · só contatos"}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {fase === "ok" && cursor && (
        <button type="button" className="secundario" disabled={carregandoMais} onClick={carregarMais}>
          {carregandoMais ? "Carregando…" : "Carregar mais"}
        </button>
      )}
    </section>
  );
}

// ---------- W5: matéria ----------

function MateriaView({ adaptador, id, aoEditar }: {
  adaptador: AdaptadorInternetPublica;
  id: string;
  aoEditar: (m: MinhaPublicacao) => void;
}) {
  const [pub, setPub] = useState<PublicacaoDetalhe | null>(null);
  const [fase, setFase] = useState<"carregando" | "ok" | "erro" | "indisponivel">("carregando");
  const [tentativa, setTentativa] = useState(0);
  const [motivo, setMotivo] = useState<string>("spam");
  const [denunciando, setDenunciando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    setFase("carregando");
    setPub(null);
    adaptador.obterPublicacao(id)
      .then((p) => { if (vivo) { setPub(p); setFase("ok"); } })
      .catch((e) => {
        if (!vivo) return;
        setFase(e instanceof ApiError && e.status === 404 ? "indisponivel" : "erro");
      });
    return () => { vivo = false; };
  }, [adaptador, id, tentativa]);

  const denunciar = async () => {
    setDenunciando(true);
    setAviso(null);
    try {
      const r = await adaptador.denunciarPublicacao(id, motivo, motivo === "ilegal");
      setAviso(r.removida
        ? "Denúncia registrada — a publicação foi removida automaticamente."
        : "Denúncia registrada. Obrigado por sinalizar.");
      setTentativa((n) => n + 1);
    } catch (e) {
      setAviso(e instanceof ApiError && e.status === 409
        ? "Você já denunciou esta publicação."
        : "Não foi possível registrar a denúncia agora.");
    } finally {
      setDenunciando(false);
    }
  };

  if (fase === "carregando") return <Carregando rotulo="Abrindo a publicação…" />;
  if (fase === "indisponivel") {
    return <Vazio titulo="Publicação indisponível" dica="O endereço não existe ou o conteúdo foi retirado." />;
  }
  if (fase === "erro" || !pub) {
    return <ErroRetry mensagem="Não foi possível abrir a publicação." aoTentar={() => setTentativa((n) => n + 1)} />;
  }

  const ehMinha = pub.version !== undefined && pub.autorContaId !== undefined;
  const sistema = pub.origem === "sistema";
  return (
    <article className="internet-pagina" aria-label={`Publicação ${pub.titulo}`}>
      <p className="meta">
        {pub.tipo === "noticia" ? "Notícia" : "Perfil"}
        {" · "}{nomeAutor(pub)}
        {" · "}{ROTULO_HORA.format(new Date(pub.publicadoEm ?? pub.criadoEm))}
        {pub.visibilidade === "contatos" && " · visível só para contatos"}
        {sistema && " · notícia automática"}
      </p>
      <h4 className="internet-pagina-titulo">{pub.titulo}</h4>
      <div className="internet-pagina-corpo">
        {pub.corpo.split(/\n{2,}/).map((paragrafo, i) => <p key={i}>{paragrafo}</p>)}
      </div>

      {!sistema && pub.status === "publicado" && (
        <div className="internet-feed-acoes">
          <label className="internet-sr-only" htmlFor="motivo-denuncia">Motivo da denúncia</label>
          <select id="motivo-denuncia" value={motivo} onChange={(e) => setMotivo(e.target.value)}>
            {MOTIVOS_DENUNCIA.map((m) => <option key={m.v} value={m.v}>{m.r}</option>)}
          </select>
          <button type="button" className="secundario" disabled={denunciando} onClick={denunciar}>
            {denunciando ? "Enviando…" : "Denunciar"}
          </button>
        </div>
      )}
      {aviso && <p className="meta" role="status">{aviso}</p>}

      {ehMinha && pub.version !== undefined && !sistema && pub.status !== "removido" && (
        <div className="internet-feed-acoes">
          <button
            type="button"
            className="secundario"
            onClick={() => aoEditar({
              id: pub.id, tipo: pub.tipo, titulo: pub.titulo,
              status: pub.status, visibilidade: pub.visibilidade,
              autorModo: pub.autorModo, pseudoNome: pub.pseudoNome,
              origem: pub.origem, publicadoEm: pub.publicadoEm,
              version: pub.version!, criadoEm: pub.criadoEm, atualizadoEm: pub.atualizadoEm,
            })}
          >Editar</button>
          {pub.status === "publicado" && (
            <button
              type="button"
              className="secundario"
              onClick={async () => {
                try {
                  await adaptador.atualizarPublicacao(pub.id, { status: "rascunho", expectedVersion: pub.version! });
                  setTentativa((n) => n + 1);
                } catch { setAviso("Não foi possível alterar agora."); }
              }}
            >Despublicar</button>
          )}
        </div>
      )}
      {pub.status === "removido" && (
        <p className="meta">Esta publicação foi removida pela moderação.</p>
      )}
    </article>
  );
}

// ---------- W8-subset: publicar / editar ----------

function FormPublicacao({ adaptador, editando, aoConcluir }: {
  adaptador: AdaptadorInternetPublica;
  editando?: MinhaPublicacao;
  aoConcluir: () => void;
}) {
  const [tipo, setTipo] = useState<TipoPublicacao>(editando?.tipo ?? "noticia");
  const [titulo, setTitulo] = useState(editando?.titulo ?? "");
  const [corpo, setCorpo] = useState("");
  const [visibilidade, setVisibilidade] = useState<VisibilidadePublicacao>(editando?.visibilidade ?? "campanha");
  const [autorModo, setAutorModo] = useState<"identificado" | "pseudonimo">(
    editando?.autorModo === "pseudonimo" ? "pseudonimo" : "identificado");
  const [pseudoNome, setPseudoNome] = useState(editando?.pseudoNome ?? "");
  const [statusAlvo, setStatusAlvo] = useState<"rascunho" | "publicado">(
    editando?.status === "publicado" ? "publicado" : "rascunho");
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [conflito, setConflito] = useState(false);

  // Edição carrega o corpo completo via detalhe privilegiado.
  const [carregandoCorpo, setCarregandoCorpo] = useState(!!editando);
  useEffect(() => {
    if (!editando) return;
    let vivo = true;
    adaptador.obterPublicacao(editando.id)
      .then((p) => { if (vivo) setCorpo(p.corpo); })
      .catch(() => { if (vivo) setErro("Não foi possível carregar o conteúdo para edição."); })
      .finally(() => { if (vivo) setCarregandoCorpo(false); });
    return () => { vivo = false; };
  }, [adaptador, editando]);

  const erroAmigavel = (e: unknown): string => {
    if (e instanceof ApiError) {
      if (e.status === 409) return "Conflito de versão — recarregue e tente de novo.";
      if (e.status === 403 && String((e.detalhes as { erro?: string } | undefined)?.erro ?? "").includes("jornalista")) {
        return "Publicar notícia exige a profissão de jornalista na ficha.";
      }
      if (e.status === 403) return "Sem permissão para esta ação.";
      if (e.status === 400) return "Dados inválidos — revise os campos.";
    }
    return "Falha ao salvar. Tente novamente.";
  };

  const submeter = async (e: FormEvent) => {
    e.preventDefault();
    if (enviando || carregandoCorpo) return;
    setEnviando(true);
    setErro(null);
    setConflito(false);
    try {
      if (editando) {
        await adaptador.atualizarPublicacao(editando.id, {
          titulo, corpo, visibilidade, autorModo,
          pseudoNome: autorModo === "pseudonimo" ? pseudoNome : null,
          status: statusAlvo,
          expectedVersion: editando.version,
        });
      } else {
        const nova: PublicacaoNova = {
          tipo, titulo, corpo, visibilidade, autorModo,
          ...(autorModo === "pseudonimo" ? { pseudoNome } : {}),
        };
        const criada = await adaptador.criarPublicacao(nova);
        // Nasce rascunho — publicar é uma segunda chamada com versão.
        if (statusAlvo === "publicado") {
          await adaptador.atualizarPublicacao(criada.id, { status: "publicado", expectedVersion: criada.version ?? 1 });
        }
      }
      aoConcluir();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setConflito(true);
      setErro(erroAmigavel(err));
    } finally {
      setEnviando(false);
    }
  };

  return (
    <form className="internet-publicar" onSubmit={submeter} aria-label={editando ? "Editar publicação" : "Nova publicação"}>
      <h4 className="internet-site-nome">{editando ? "Editar publicação" : "Nova publicação"}</h4>
      {!editando && (
        <fieldset className="internet-form-grupo">
          <legend>Tipo</legend>
          <label><input type="radio" name="pub-tipo" checked={tipo === "noticia"} onChange={() => setTipo("noticia")} /> Notícia</label>
          <label><input type="radio" name="pub-tipo" checked={tipo === "post_perfil"} onChange={() => setTipo("post_perfil")} /> Post de perfil</label>
        </fieldset>
      )}
      <label>
        Título
        <input type="text" value={titulo} onChange={(e) => setTitulo(e.target.value)} maxLength={200} required />
      </label>
      <label>
        Corpo
        <textarea value={corpo} onChange={(e) => setCorpo(e.target.value)} rows={8} maxLength={50000} required disabled={carregandoCorpo} />
      </label>
      <fieldset className="internet-form-grupo">
        <legend>Quem pode ver</legend>
        <label><input type="radio" name="pub-vis" checked={visibilidade === "campanha"} onChange={() => setVisibilidade("campanha")} /> Toda a campanha</label>
        <label><input type="radio" name="pub-vis" checked={visibilidade === "contatos"} onChange={() => setVisibilidade("contatos")} /> Só meus contatos</label>
      </fieldset>
      <fieldset className="internet-form-grupo">
        <legend>Autoria</legend>
        <label><input type="radio" name="pub-modo" checked={autorModo === "identificado"} onChange={() => setAutorModo("identificado")} /> Identificado</label>
        <label>
          <input type="radio" name="pub-modo" checked={autorModo === "pseudonimo"} onChange={() => setAutorModo("pseudonimo")} /> Pseudônimo
        </label>
        {autorModo === "pseudonimo" && (
          <label>
            Nome público
            <input type="text" value={pseudoNome} onChange={(e) => setPseudoNome(e.target.value)} minLength={2} maxLength={60} required />
          </label>
        )}
      </fieldset>
      <fieldset className="internet-form-grupo">
        <legend>Publicação</legend>
        <label><input type="radio" name="pub-status" checked={statusAlvo === "rascunho"} onChange={() => setStatusAlvo("rascunho")} /> Salvar rascunho</label>
        <label><input type="radio" name="pub-status" checked={statusAlvo === "publicado"} onChange={() => setStatusAlvo("publicado")} /> Publicar agora</label>
      </fieldset>
      {tipo === "noticia" && (
        <p className="meta">Publicar notícias exige a profissão de jornalista na sua ficha (regra do mundo).</p>
      )}
      {erro && <p className="internet-form-erro" role="alert">{erro}</p>}
      {conflito && <p className="meta">Alguém alterou esta publicação — feche e reabra para recarregar a versão.</p>}
      <div className="internet-feed-acoes">
        <button type="submit" className="primario" disabled={enviando || carregandoCorpo}>
          {enviando ? "Salvando…" : editando ? "Salvar" : "Criar"}
        </button>
        <button type="button" className="secundario" onClick={aoConcluir} disabled={enviando}>Cancelar</button>
      </div>
    </form>
  );
}

// ---------- Minhas publicações ----------

function MinhasView({ adaptador, aoEditar, aoAbrir }: {
  adaptador: AdaptadorInternetPublica;
  aoEditar: (m: MinhaPublicacao) => void;
  aoAbrir: (id: string) => void;
}) {
  const [itens, setItens] = useState<MinhaPublicacao[] | null>(null);
  const [fase, setFase] = useState<"carregando" | "ok" | "erro">("carregando");
  const [tentativa, setTentativa] = useState(0);
  const [acao, setAcao] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    setFase("carregando");
    adaptador.minhasPublicacoes()
      .then((r) => { if (vivo) { setItens(r); setFase("ok"); } })
      .catch(() => { if (vivo) setFase("erro"); });
    return () => { vivo = false; };
  }, [adaptador, tentativa]);

  const transitar = async (m: MinhaPublicacao, status: "rascunho" | "publicado") => {
    setAcao(m.id);
    try {
      await adaptador.atualizarPublicacao(m.id, { status, expectedVersion: m.version });
      setTentativa((n) => n + 1);
    } catch { /* mantido — próxima tentativa manual */ }
    finally { setAcao(null); }
  };

  if (fase === "carregando") return <Carregando rotulo="Carregando suas publicações…" />;
  if (fase === "erro") return <ErroRetry mensagem="Não foi possível carregar suas publicações." aoTentar={() => setTentativa((n) => n + 1)} />;
  if (itens !== null && itens.length === 0) {
    return <Vazio titulo="Você ainda não publicou nada" dica="Use “Publicar” para criar sua primeira notícia ou post de perfil." />;
  }
  const ROTULO_STATUS: Record<string, string> = { rascunho: "rascunho", publicado: "publicado", removido: "removido" };
  return (
    <ul className="internet-inbox" aria-label="Minhas publicações">
      {(itens ?? []).map((m) => (
        <li key={m.id} className="internet-minha-item">
          <button type="button" className="internet-conversa-item" onClick={() => aoAbrir(m.id)}>
            <span className="crescer">
              <span className="internet-conversa-nome">{m.titulo}</span>
              <span className="internet-conversa-meta">
                {m.tipo === "noticia" ? "Notícia" : "Post de perfil"}
                {" · "}{ROTULO_STATUS[m.status] ?? m.status}
                {" · "}{m.visibilidade === "contatos" ? "só contatos" : "campanha"}
                {m.origem === "sistema" && " · automática"}
              </span>
            </span>
          </button>
          {m.origem === "usuario" && m.status !== "removido" && (
            <span className="internet-minha-acoes">
              <button type="button" className="secundario" disabled={acao === m.id} onClick={() => aoEditar(m)}>Editar</button>
              {m.status === "rascunho" && (
                <button type="button" className="secundario" disabled={acao === m.id} onClick={() => transitar(m, "publicado")}>Publicar</button>
              )}
              {m.status === "publicado" && (
                <button type="button" className="secundario" disabled={acao === m.id} onClick={() => transitar(m, "rascunho")}>Despublicar</button>
              )}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
