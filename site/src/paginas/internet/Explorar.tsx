// Internet pública 1.1.2 (#365 — fatia W1/W3): "Explorar" dentro da
// camada diegética (aba Rede → InternetDiegetica). SOMENTE LEITURA:
//   W1 — diretório de sites da campanha com busca por prefixo
//        (GET /internet/sites?q=&cursor=), paginação keyset "Carregar
//        mais" e estado vazio honesto;
//   W3 — detalhe do site (menu derivado das páginas PUBLICADAS) e
//        leitura da página com "voltar" preservando a origem.
// Fronteiras do servidor: site/página de outra campanha, arquivado ou
// não publicado respondem 404 idêntico a inexistente — a UI mostra
// "indisponível" sem distinguir (anti-enumeração). Gate de leitor
// (conta Internet autorizada ou mestre) é 403 do servidor — exibido
// como erro honesto, nunca contornado no cliente.
//
// Fora de escopo nesta fatia (contrato #366): notícias, classificados,
// perfil público, pesquisa multi-escopo, criação/edição de sites.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError } from "../../api";
import { criarAdaptadorInternetPublica, type AdaptadorInternetPublica } from "./adaptador-publica";
import Publicacoes from "./Publicacoes";
import Perfis, { PerfilPublicoView } from "./Perfis";
import type { LiveResumo, PaginaPublica, PaginaPublicaResumo, SitePublico, SitePublicoResumo } from "./tipos-publica";
import { Carregando, ErroRetry, Vazio } from "./estados";

type Visao =
  | { tipo: "inicio" }
  | { tipo: "site"; slug: string }
  | { tipo: "pagina"; siteSlug: string; pageSlug: string }
  | { tipo: "perfil"; handle: string };

interface Props {
  campaignId: string;
  adaptador?: AdaptadorInternetPublica;
  /** characterId do personagem atual — habilita o card "Seu perfil"
   *  (W9/W10) na sub-aba Perfis. Sem ele só busca/leitura pública. */
  characterId?: string;
}

const ROTULO_DATA = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" });

export default function Explorar({ campaignId, adaptador, characterId }: Props) {
  const adapt = adaptador ?? criarAdaptadorInternetPublica({ campaignId });
  // Pilha de navegação: o último elemento é a visão atual; "voltar"
  // desempilha preservando o contexto (diretório → site → página).
  const [pilha, setPilha] = useState<Visao[]>([{ tipo: "inicio" }]);
  const visao = pilha[pilha.length - 1];

  const irPara = (v: Visao) => setPilha((p) => [...p, v]);
  const irParaPerfil = (handle: string) => irPara({ tipo: "perfil", handle });
  const voltar = () => setPilha((p) => (p.length > 1 ? p.slice(0, -1) : p));
  const irParaSite = (slug: string) => irPara({ tipo: "site", slug });
  const irParaPagina = (siteSlug: string, p: PaginaPublicaResumo) =>
    irPara({ tipo: "pagina", siteSlug, pageSlug: p.slug });

  return (
    <div className="internet-explorar">
      {visao.tipo !== "inicio" && (
        <div className="internet-thread-cab">
          <button type="button" className="secundario internet-thread-voltar" onClick={voltar}>
            ← Voltar
          </button>
        </div>
      )}
      {visao.tipo === "inicio" && (
        <InicioPublico adaptador={adapt} campaignId={campaignId} characterId={characterId} aoAbrirSite={irParaSite} aoAbrirPerfil={irParaPerfil} />
      )}
      {visao.tipo === "perfil" && (
        <PerfilPublicoView
          key={visao.handle}
          adaptador={adapt}
          campaignId={campaignId}
          handle={visao.handle}
          aoVoltar={voltar}
        />
      )}
      {visao.tipo === "site" && (
        <SitePublicoView
          key={visao.slug}
          adaptador={adapt}
          slug={visao.slug}
          aoAbrirPagina={(p) => irParaPagina(visao.slug, p)}
        />
      )}
      {visao.tipo === "pagina" && (
        <PaginaPublicaView
          key={`${visao.siteSlug}/${visao.pageSlug}`}
          adaptador={adapt}
          siteSlug={visao.siteSlug}
          pageSlug={visao.pageSlug}
          aoAbrirSite={() => setPilha((p) => {
            const i = p.findIndex((v) => v.tipo === "site" && v.slug === visao.siteSlug);
            return i >= 0 ? p.slice(0, i + 1) : [...p.filter((v) => v.tipo !== "pagina"), { tipo: "site" as const, slug: visao.siteSlug }];
          })}
          aoAbrirPaginaIrma={(p) => irParaPagina(visao.siteSlug, p)}
        />
      )}
    </div>
  );
}

/** W1 — diretório de sites + barra de pesquisa global (prefixo, ?q=).
 *  W4/W5/W8-subset (#365): sub-abas "Sites" e "Publicações" — a
 *  segunda hospeda o feed/matéria/publicar/minhas com navegação
 *  interna própria (Publicacoes.tsx). */
function InicioPublico({ adaptador, campaignId, characterId, aoAbrirSite, aoAbrirPerfil }: {
  adaptador: AdaptadorInternetPublica;
  campaignId: string;
  characterId?: string;
  aoAbrirSite: (slug: string) => void;
  aoAbrirPerfil: (handle: string) => void;
}) {
  const [secao, setSecao] = useState<"sites" | "publicacoes" | "perfis" | "ao-vivo">("sites");
  const [busca, setBusca] = useState("");
  const [qAplicada, setQAplicada] = useState("");
  const [sites, setSites] = useState<SitePublicoResumo[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [carregandoMais, setCarregandoMais] = useState(false);
  const [fase, setFase] = useState<"carregando" | "ok" | "erro" | "sem-acesso">("carregando");
  const [tentativa, setTentativa] = useState(0);

  const carregar = useCallback(async (cursorInicial: string | null) => {
    try {
      const r = await adaptador.listarSites(qAplicada || undefined, cursorInicial);
      setSites((atual) => (cursorInicial ? [...(atual ?? []), ...r.itens] : r.itens));
      setCursor(r.proximoCursor);
      setFase("ok");
    } catch (e) {
      setFase(e instanceof ApiError && e.status === 403 ? "sem-acesso" : "erro");
    }
  }, [adaptador, qAplicada]);

  useEffect(() => {
    setFase("carregando");
    setSites(null);
    setCursor(null);
    void carregar(null);
  }, [carregar, tentativa]);

  const submeter = (e: FormEvent) => {
    e.preventDefault();
    setQAplicada(busca.trim());
    setTentativa((n) => n + 1);
  };

  const carregarMais = async () => {
    if (!cursor) return;
    setCarregandoMais(true);
    await carregar(cursor);
    setCarregandoMais(false);
  };

  return (
    <div className="internet-explorar-inicio">
      <div className="internet-contatos-subabas" role="tablist" aria-label="Seções do Explorar">
        <button
          type="button"
          role="tab"
          aria-selected={secao === "sites"}
          className={secao === "sites" ? "secundario ativo" : "secundario"}
          onClick={() => setSecao("sites")}
        >Sites</button>
        <button
          type="button"
          role="tab"
          aria-selected={secao === "publicacoes"}
          className={secao === "publicacoes" ? "secundario ativo" : "secundario"}
          onClick={() => setSecao("publicacoes")}
        >Publicações</button>
        <button
          type="button"
          role="tab"
          aria-selected={secao === "perfis"}
          className={secao === "perfis" ? "secundario ativo" : "secundario"}
          onClick={() => setSecao("perfis")}
        >Perfis</button>
        <button
          type="button"
          role="tab"
          aria-selected={secao === "ao-vivo"}
          className={secao === "ao-vivo" ? "secundario ativo" : "secundario"}
          onClick={() => setSecao("ao-vivo")}
        >Ao vivo</button>
      </div>
      {secao === "perfis" ? (
        <Perfis adaptador={adaptador} campaignId={campaignId} characterId={characterId} aoAbrirPerfil={aoAbrirPerfil} />
      ) : secao === "ao-vivo" ? (
        <AosVivo adaptador={adaptador} characterId={characterId} />
      ) : secao === "publicacoes" ? (
        <Publicacoes adaptador={adaptador} />
      ) : (
      <>
      <form className="internet-rede-form" role="search" onSubmit={submeter}>
        <label className="internet-sr-only" htmlFor="internet-busca">Buscar sites da campanha</label>
        <input
          id="internet-busca"
          type="search"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar sites…"
          autoComplete="off"
        />
        <button type="submit" className="secundario">Buscar</button>
      </form>

      {fase === "carregando" && <Carregando rotulo="Explorando a rede…" />}

      {fase === "sem-acesso" && (
        <ErroRetry
          mensagem="Sem acesso à camada pública da Internet — é preciso uma conta de Internet autorizada (ou ser o mestre da campanha)."
          aoTentar={() => setTentativa((n) => n + 1)}
        />
      )}

      {fase === "erro" && (
        <ErroRetry
          mensagem="Não foi possível carregar os sites agora."
          aoTentar={() => setTentativa((n) => n + 1)}
        />
      )}

      {fase === "ok" && sites !== null && sites.length === 0 && (
        <Vazio
          titulo={qAplicada ? "Nenhum site encontrado" : "Sua campanha ainda não tem sites"}
          dica={qAplicada ? "Tente outro termo de busca." : "Quando houver páginas publicadas, elas aparecem aqui."}
        />
      )}

      {fase === "ok" && sites !== null && sites.length > 0 && (
        <ul className="internet-inbox" aria-label="Sites da campanha">
          {sites.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className="internet-conversa-item internet-site-item"
                onClick={() => aoAbrirSite(s.slug)}
              >
                <span className="crescer">
                  <span className="internet-conversa-nome">{s.nome}</span>
                  {s.descricao && <span className="internet-conversa-preview">{s.descricao}</span>}
                  <span className="internet-conversa-meta">
                    {s.owner ? `@${s.owner.handle}` : "autor desconhecido"}
                    {" · "}{s.paginasPublicadas} página{s.paginasPublicadas === 1 ? "" : "s"}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {fase === "ok" && cursor && (
        <button type="button" className="secundario" disabled={carregandoMais} onClick={carregarMais}>
          {carregandoMais ? "Carregando…" : "Carregar mais sites"}
        </button>
      )}
      </>
      )}
    </div>
  );
}

/** W3 — detalhe do site: menu derivado das páginas publicadas (D13-a). */
function SitePublicoView({ adaptador, slug, aoAbrirPagina }: {
  adaptador: AdaptadorInternetPublica;
  slug: string;
  aoAbrirPagina: (p: PaginaPublicaResumo) => void;
}) {
  const [site, setSite] = useState<SitePublico | null>(null);
  const [fase, setFase] = useState<"carregando" | "ok" | "erro" | "indisponivel">("carregando");
  const [tentativa, setTentativa] = useState(0);

  useEffect(() => {
    let vivo = true;
    setFase("carregando");
    adaptador.obterSite(slug)
      .then((s) => { if (vivo) { setSite(s); setFase("ok"); } })
      .catch((e) => {
        if (!vivo) return;
        setFase(e instanceof ApiError && e.status === 404 ? "indisponivel" : "erro");
      });
    return () => { vivo = false; };
  }, [adaptador, slug, tentativa]);

  if (fase === "carregando") return <Carregando rotulo="Abrindo o site…" />;
  if (fase === "indisponivel") {
    return (
      <Vazio
        titulo="Site indisponível"
        dica="O endereço não existe ou o conteúdo foi retirado."
      />
    );
  }
  if (fase === "erro" || !site) {
    return <ErroRetry mensagem="Não foi possível abrir o site agora." aoTentar={() => setTentativa((n) => n + 1)} />;
  }

  return (
    <article className="internet-site" aria-label={`Site ${site.nome}`}>
      <header className="internet-site-cab">
        <h4 className="internet-site-nome">{site.nome}</h4>
        {site.owner && <p className="meta">por @{site.owner.handle} · {ROTULO_DATA.format(new Date(site.criadoEm))}</p>}
        {site.descricao && <p className="internet-site-desc">{site.descricao}</p>}
      </header>
      {site.paginas.length === 0 ? (
        <Vazio titulo="Este site ainda não tem páginas publicadas" dica="Volte mais tarde." />
      ) : (
        <nav aria-label={`Páginas de ${site.nome}`}>
          <ul className="internet-site-menu">
            {site.paginas.map((p) => (
              <li key={p.slug}>
                <button type="button" className="internet-site-link" onClick={() => aoAbrirPagina(p)}>
                  {p.titulo}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </article>
  );
}

/** W3 — leitura da página publicada. Somente `publicado` é servido
 *  pelo servidor; o resto responde 404 e cai no estado indisponível. */
function PaginaPublicaView({ adaptador, siteSlug, pageSlug, aoAbrirSite, aoAbrirPaginaIrma }: {
  adaptador: AdaptadorInternetPublica;
  siteSlug: string;
  pageSlug: string;
  aoAbrirSite: () => void;
  aoAbrirPaginaIrma: (p: PaginaPublicaResumo) => void;
}) {
  const [dados, setDados] = useState<{ pagina: PaginaPublica; site: { slug: string; nome: string } } | null>(null);
  const [irmaos, setIrmaos] = useState<PaginaPublicaResumo[]>([]);
  const [fase, setFase] = useState<"carregando" | "ok" | "erro" | "indisponivel">("carregando");
  const [tentativa, setTentativa] = useState(0);

  useEffect(() => {
    let vivo = true;
    setFase("carregando");
    setDados(null);
    Promise.all([
      adaptador.obterPagina(siteSlug, pageSlug),
      // menu de irmãs para navegação interna — falha aqui não derruba a página
      adaptador.obterSite(siteSlug).then((s) => s.paginas).catch(() => [] as PaginaPublicaResumo[]),
    ])
      .then(([pg, paginas]) => {
        if (!vivo) return;
        setDados(pg);
        setIrmaos(paginas.filter((p) => p.slug !== pg.pagina.slug));
        setFase("ok");
      })
      .catch((e) => {
        if (!vivo) return;
        setFase(e instanceof ApiError && e.status === 404 ? "indisponivel" : "erro");
      });
    return () => { vivo = false; };
  }, [adaptador, siteSlug, pageSlug, tentativa]);

  if (fase === "carregando") return <Carregando rotulo="Lendo a página…" />;
  if (fase === "indisponivel") {
    return (
      <Vazio
        titulo="Página indisponível"
        dica="O endereço não existe, foi retirado ou ainda não foi publicado."
      />
    );
  }
  if (fase === "erro" || !dados) {
    return <ErroRetry mensagem="Não foi possível ler a página agora." aoTentar={() => setTentativa((n) => n + 1)} />;
  }

  const { pagina, site } = dados;
  return (
    <article className="internet-pagina" aria-label={`Página ${pagina.titulo}`}>
      <p className="meta">
        <button type="button" className="internet-pagina-site" onClick={aoAbrirSite}>
          {site.nome}
        </button>
        {" · "}
        {pagina.autor ? `por @${pagina.autor.handle}` : "autor desconhecido"}
        {pagina.publicadoEm != null && ` · ${ROTULO_DATA.format(new Date(pagina.publicadoEm))}`}
      </p>
      <h4 className="internet-pagina-titulo">{pagina.titulo}</h4>
      <div className="internet-pagina-corpo">
        {pagina.corpo.split(/\n{2,}/).map((paragrafo, i) => (
          <p key={i}>{paragrafo}</p>
        ))}
      </div>
      {irmaos.length > 0 && (
        <nav aria-label="Outras páginas do site" className="internet-pagina-irmaos">
          <p className="meta">Neste site:</p>
          <ul>
            {irmaos.map((p) => (
              <li key={p.slug}>
                <button type="button" className="internet-site-link" onClick={() => aoAbrirPaginaIrma(p)}>
                  {p.titulo}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </article>
  );
}

/** Ao vivo (ordem 7232090197 item 3 — Streamer simulado): diretório de
 *  lives vigentes + entrada pelo personagem atual. O gate
 *  pericia/profissão streamer e a titularidade são do servidor — a UI
 *  apenas reflete o 403/409 honestos. */
function AosVivo({ adaptador, characterId }: {
  adaptador: AdaptadorInternetPublica;
  characterId?: string;
}) {
  const [lives, setLives] = useState<LiveResumo[] | null>(null);
  const [fase, setFase] = useState<"carregando" | "ok" | "erro" | "sem-acesso">("carregando");
  const [tentativa, setTentativa] = useState(0);
  const [titulo, setTitulo] = useState("");
  const [descricao, setDescricao] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [entrando, setEntrando] = useState(false);

  const carregar = useCallback(async () => {
    try {
      setLives(await adaptador.listarLives());
      setFase("ok");
    } catch (e) {
      setFase(e instanceof ApiError && e.status === 403 ? "sem-acesso" : "erro");
    }
  }, [adaptador]);

  useEffect(() => { void carregar(); }, [carregar, tentativa]);

  const entrar = async (e: FormEvent) => {
    e.preventDefault();
    if (!characterId || !titulo.trim()) return;
    setEntrando(true); setMsg(null);
    try {
      await adaptador.entrarAoVivo(characterId, titulo.trim(), descricao.trim() || undefined);
      setTitulo(""); setDescricao("");
      await carregar();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : "Não foi possível entrar ao vivo.");
    } finally {
      setEntrando(false);
    }
  };

  const sair = async (id: string) => {
    try {
      await adaptador.sairAoVivo(id);
      await carregar();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : "Não foi possível sair.");
    }
  };

  return (
    <div className="internet-ao-vivo">
      {characterId && (
        <form className="internet-rede-form" onSubmit={entrar}>
          <label className="internet-sr-only" htmlFor="live-titulo">Título da live</label>
          <input
            id="live-titulo"
            type="text"
            value={titulo}
            onChange={(e) => setTitulo(e.target.value)}
            placeholder="Entrar ao vivo — título…"
            maxLength={120}
            autoComplete="off"
          />
          <button type="submit" className="secundario" disabled={entrando || !titulo.trim()}>
            {entrando ? "Entrando…" : "Entrar ao vivo"}
          </button>
        </form>
      )}
      {msg && <p className="meta" role="alert">{msg}</p>}
      {fase === "carregando" && <Carregando rotulo="Carregando lives…" />}
      {fase === "sem-acesso" && (
        <ErroRetry
          mensagem="Sem acesso à camada pública da Internet — é preciso uma conta de Internet autorizada (ou ser o mestre da campanha)."
          aoTentar={() => setTentativa((n) => n + 1)}
        />
      )}
      {fase === "erro" && (
        <ErroRetry mensagem="Não foi possível carregar as lives agora." aoTentar={() => setTentativa((n) => n + 1)} />
      )}
      {fase === "ok" && lives !== null && lives.length === 0 && (
        <Vazio titulo="Nenhuma live agora" dica="Streamers com a profissão/períciaStreamer podem transmitir aqui." />
      )}
      {fase === "ok" && lives !== null && lives.length > 0 && (
        <ul className="internet-inbox" aria-label="Lives ao vivo">
          {lives.map((l) => (
            <li key={l.id} className="cartao">
              <strong>{l.titulo}</strong>
              <span className="badge">ao vivo</span>
              {l.descricao && <p>{l.descricao}</p>}
              <p className="meta">
                {l.nomePublico ?? l.handle ?? "desconhecido"}
                {l.handle ? ` · @${l.handle}` : ""}
                {l.minha ? " · sua live" : ""}
                {" · até "}{new Date(l.expiraEm).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
              </p>
              {l.minha && (
                <button type="button" className="secundario" onClick={() => void sair(l.id)}>
                  Encerrar live
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
