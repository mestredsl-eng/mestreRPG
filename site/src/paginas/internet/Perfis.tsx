// Internet pública 1.1.2 (#365 — fatia W9/W10): perfis públicos na
// camada Explorar. SOMENTE o que o servidor autoriza:
//   - "Seu perfil": estado do perfil do personagem atual — não ativado
//     mostra CTA com aviso inequívoco de irreversibilidade (D10); ativado
//     mostra edição livre (nome público/descrição/avatar — DP-7) e
//     nenhum controle de ocultar/desativar/excluir (a regra proíbe).
//   - Busca por HANDLE (D12 — displayName/nome público não indexam).
//   - Perfil público alheio: somente leitura; 404 do servidor vira
//     "indisponível" sem distinguir inexistente/não-ativado (anti-
//     enumeração). Avatar servido pela rota dedicada do perfil.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError } from "../../api";
import type { AdaptadorInternetPublica } from "./adaptador-publica";
import type { PerfilProprio, PerfilPublico, PerfilResumoBusca } from "./tipos-publica";
import { Carregando, ErroRetry, Vazio } from "./estados";

interface Props {
  adaptador: AdaptadorInternetPublica;
  campaignId: string;
  /** characterId do personagem atual — sem ele o card "Seu perfil"
   *  não renderiza (contexto sem personagem). */
  characterId?: string;
  aoAbrirPerfil: (handle: string) => void;
}

export default function Perfis({ adaptador, campaignId, characterId, aoAbrirPerfil }: Props) {
  return (
    <div className="internet-perfis">
      {characterId && <SeuPerfil adaptador={adaptador} campaignId={campaignId} characterId={characterId} aoAbrirPerfil={aoAbrirPerfil} />}
      <BuscaPerfis adaptador={adaptador} aoAbrirPerfil={aoAbrirPerfil} />
    </div>
  );
}

/** Card do próprio perfil — ativação irreversível + edição. */
function SeuPerfil({ adaptador, campaignId, characterId, aoAbrirPerfil }: {
  adaptador: AdaptadorInternetPublica; campaignId: string; characterId: string;
  aoAbrirPerfil: (handle: string) => void;
}) {
  const [perfil, setPerfil] = useState<PerfilProprio | null | undefined>(undefined);
  const [falecido, setFalecido] = useState(false);
  const [erro, setErro] = useState(false);
  const [tentativa, setTentativa] = useState(0);
  const [avisoAberto, setAvisoAberto] = useState(false);
  const [nomePublico, setNomePublico] = useState("");
  const [descricao, setDescricao] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    setErro(false);
    try {
      const p = await adaptador.obterMeuPerfil(characterId);
      setPerfil(p);
      setFalecido(p?.falecido ?? false);
      if (p) { setNomePublico(p.nomePublico ?? ""); setDescricao(p.descricao ?? ""); }
    } catch {
      setErro(true);
    }
  }, [adaptador, characterId]);

  useEffect(() => { void carregar(); }, [carregar, tentativa]);

  if (erro) return <ErroRetry mensagem="Não foi possível carregar seu perfil." aoTentar={() => setTentativa((n) => n + 1)} />;
  if (perfil === undefined) return <Carregando rotulo="Carregando perfil…" />;

  // não ativado — CTA com aviso irrevogável (W10)
  if (perfil === null) {
    return (
      <section className="cartao" aria-label="Seu perfil público">
        <h3>Seu perfil público</h3>
        <Vazio
          titulo="Perfil público não ativado"
          dica="O restante da Internet funciona normalmente sem perfil."
        />
        {!avisoAberto ? (
          <button type="button" className="secundario" onClick={() => setAvisoAberto(true)}>
            Ativar perfil público
          </button>
        ) : (
          <div className="internet-perfil-aviso" role="alert">
            <p><strong>Atenção:</strong> ativado, o perfil fica <strong>permanentemente público</strong> — não pode ser ocultado, desativado ou apagado. Esta ação é irreversível.</p>
            <div className="linha-entre">
              <button type="button" className="secundario" onClick={() => setAvisoAberto(false)}>Cancelar</button>
              <button
                type="button"
                disabled={salvando}
                onClick={async () => {
                  setSalvando(true); setMsg(null);
                  try {
                    const p = await adaptador.ativarPerfil(characterId);
                    setPerfil(p); setFalecido(p.falecido);
                  } catch (e) {
                    setMsg(e instanceof ApiError ? e.message : "Falha ao ativar o perfil.");
                  } finally { setSalvando(false); }
                }}
              >
                {salvando ? "Ativando…" : "Confirmar ativação irreversível"}
              </button>
            </div>
            {msg && <p className="internet-erro" role="alert">{msg}</p>}
          </div>
        )}
      </section>
    );
  }

  // ativado — edição livre; sem controles de ocultar/desativar/excluir
  const salvar = async (e: FormEvent) => {
    e.preventDefault();
    setSalvando(true); setMsg(null);
    try {
      const p = await adaptador.editarPerfil(characterId, {
        nomePublico: nomePublico.trim() || null,
        descricao: descricao.trim() || null,
      });
      setPerfil(p);
      setMsg("Perfil atualizado.");
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : "Falha ao salvar.");
    } finally { setSalvando(false); }
  };

  return (
    <section className="cartao" aria-label="Seu perfil público">
      <h3>Seu perfil público</h3>
      {perfil.handle && <p className="meta">@{perfil.handle} — visível para quem acessa a Internet da campanha.</p>}
      {falecido && <p className="meta">Personagem falecido — perfil em somente-leitura.</p>}
      <form onSubmit={salvar} className="internet-perfil-form">
        <label>
          Nome público
          <input
            type="text" maxLength={80} value={nomePublico}
            onChange={(e) => setNomePublico(e.target.value)}
            placeholder="Vazio = nome do personagem"
            disabled={falecido || salvando}
          />
        </label>
        <label>
          Descrição
          <textarea
            maxLength={2000} rows={4} value={descricao}
            onChange={(e) => setDescricao(e.target.value)}
            disabled={falecido || salvando}
          />
        </label>
        <div className="linha-entre">
          <button type="submit" disabled={falecido || salvando}>{salvando ? "Salvando…" : "Salvar"}</button>
          {perfil.handle && (
            <button type="button" className="secundario" onClick={() => aoAbrirPerfil(perfil.handle!)}>
              Ver perfil público
            </button>
          )}
        </div>
        {msg && <p className="meta" role="status">{msg}</p>}
      </form>
      <AvatarEditor adaptador={adaptador} campaignId={campaignId} characterId={characterId} perfil={perfil} aoAtualizar={setPerfil} desabilitado={falecido} />
    </section>
  );
}

/** Seletor de avatar: lista imagens aprovadas da biblioteca da
 *  campanha (GET /arquivos) e define via POST /perfil/avatar (DP-7 —
 *  pipeline arquivos existente; só 'aprovado' é aceito pelo servidor). */
function AvatarEditor({ adaptador, campaignId, characterId, perfil, aoAtualizar, desabilitado }: {
  adaptador: AdaptadorInternetPublica;
  campaignId: string;
  characterId: string;
  perfil: PerfilProprio;
  aoAtualizar: (p: PerfilProprio) => void;
  desabilitado: boolean;
}) {
  const [imagens, setImagens] = useState<{ id: string; nome: string }[] | null>(null);
  const [aberto, setAberto] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const carregarImagens = async () => {
    setErro(null);
    try {
      const r = await fetch(`/api/campaigns/${campaignId}/arquivos`, { credentials: "same-origin" });
      const corpo = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error("falha");
      const lista = (corpo.arquivos ?? corpo.items ?? []) as { id: string; fileName?: string; displayName?: string; mimeType?: string; status?: string }[];
      setImagens(lista
        .filter((f) => f.status === "aprovado" && (f.mimeType ?? "").startsWith("image/"))
        .map((f) => ({ id: f.id, nome: f.displayName ?? f.fileName ?? f.id })));
    } catch {
      setErro("Não foi possível listar imagens da biblioteca.");
      setImagens([]);
    }
  };

  const escolher = async (arquivoId: string) => {
    setErro(null);
    try {
      // reusa PATCH /perfil com avatarFileId — mesmo endpoint do POST /avatar
      const p = await adaptador.editarPerfil(characterId, { avatarFileId: arquivoId });
      aoAtualizar(p);
      setAberto(false);
    } catch (e) {
      setErro(e instanceof ApiError ? e.message : "Falha ao definir avatar.");
    }
  };

  return (
    <div className="internet-perfil-avatar">
      {perfil.avatarFileId && (
        <img
          src={`/api/campaigns/${campaignId}/arquivos/${perfil.avatarFileId}`}
          alt="Avatar do perfil"
          className="internet-perfil-avatar-img"
        />
      )}
      {!desabilitado && (
        <button
          type="button" className="secundario"
          onClick={() => { setAberto((v) => !v); if (!imagens) void carregarImagens(); }}
        >
          {perfil.avatarFileId ? "Trocar avatar" : "Definir avatar"}
        </button>
      )}
      {aberto && (
        <div className="internet-perfil-avatar-lista">
          {imagens === null ? <Carregando rotulo="Carregando imagens…" /> : imagens.length === 0 ? (
            <p className="meta">Nenhuma imagem aprovada na biblioteca. Envie uma imagem na aba Arquivos e peça aprovação do mestre.</p>
          ) : (
            <ul>
              {imagens.map((img) => (
                <li key={img.id}>
                  <button type="button" className="secundario" onClick={() => void escolher(img.id)}>
                    {img.nome}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {erro && <p className="internet-erro" role="alert">{erro}</p>}
    </div>
  );
}

/** Busca de perfis por handle (D12) + ativação da visão pública. */
function BuscaPerfis({ adaptador, aoAbrirPerfil }: { adaptador: AdaptadorInternetPublica; aoAbrirPerfil: (handle: string) => void }) {
  const [q, setQ] = useState("");
  const [resultados, setResultados] = useState<PerfilResumoBusca[] | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [erro, setErro] = useState(false);

  const buscar = async (e: FormEvent) => {
    e.preventDefault();
    const termo = q.trim();
    if (!termo) return;
    setBuscando(true); setErro(false);
    try {
      setResultados(await adaptador.buscarPerfis(termo));
    } catch {
      setErro(true); setResultados(null);
    } finally { setBuscando(false); }
  };

  return (
    <section className="cartao" aria-label="Buscar perfis">
      <h3>Buscar perfis</h3>
      <form onSubmit={buscar} className="internet-busca-form">
        <input
          type="search" value={q} maxLength={80}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Handle do perfil (ex.: nome.personagem)"
          aria-label="Buscar perfil por handle"
        />
        <button type="submit" disabled={buscando}>{buscando ? "Buscando…" : "Buscar"}</button>
      </form>
      {erro && <ErroRetry mensagem="Não foi possível buscar." aoTentar={() => { const e = { preventDefault: () => undefined } as FormEvent; void buscar(e); }} />}
      {resultados !== null && (
        resultados.length === 0 ? (
          <Vazio titulo="Nenhum perfil encontrado" dica="Perfis são localizados por handle — nome de exibição não é pesquisável." />
        ) : (
          <ul className="internet-perfis-resultados">
            {resultados.map((p) => (
              <li key={p.handle}>
                <button type="button" className="secundario" onClick={() => aoAbrirPerfil(p.handle)}>
                  <strong>@{p.handle}</strong> <span className="meta">{p.nomePublico}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      )}
    </section>
  );
}

/** Visão pública de um perfil (handle) — somente leitura. */
export function PerfilPublicoView({ adaptador, campaignId, handle, aoVoltar }: {
  adaptador: AdaptadorInternetPublica;
  campaignId: string;
  handle: string;
  aoVoltar: () => void;
}) {
  const [perfil, setPerfil] = useState<PerfilPublico | null>(null);
  const [fase, setFase] = useState<"carregando" | "ok" | "erro" | "indisponivel">("carregando");
  const [tentativa, setTentativa] = useState(0);
  const [seguindo, setSeguindo] = useState<boolean | null>(null);
  const [totalSeguidores, setTotalSeguidores] = useState(0);
  const [msgFollow, setMsgFollow] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    setFase("carregando");
    adaptador.obterPerfil(handle)
      .then((p) => {
        if (!vivo) return;
        setPerfil(p); setFase("ok");
        setSeguindo(!!p.seguindoVoce); setTotalSeguidores(p.seguidores ?? 0);
      })
      .catch((e) => { if (vivo) setFase(e instanceof ApiError && e.status === 404 ? "indisponivel" : "erro"); });
    return () => { vivo = false; };
  }, [adaptador, handle, tentativa]);

  return (
    <div className="internet-perfil-publico">
      {fase === "carregando" && <Carregando rotulo="Carregando perfil…" />}
      {fase === "erro" && <ErroRetry mensagem="Não foi possível carregar o perfil." aoTentar={() => setTentativa((n) => n + 1)} />}
      {fase === "indisponivel" && <Vazio titulo="Perfil indisponível" dica="Este perfil não existe ou não está acessível." />}
      {fase === "ok" && perfil && (
        <section className="cartao" aria-label={`Perfil de @${perfil.handle}`}>
          <div className="internet-perfil-cab">
            {perfil.avatar && (
              <img
                src={`/api/campaigns/${campaignId}/internet/perfis/${encodeURIComponent(perfil.handle)}/avatar`}
                alt={`Avatar de @${perfil.handle}`}
                className="internet-perfil-avatar-img internet-perfil-avatar-grande"
              />
            )}
            <div>
              <h2>{perfil.nomePublico}</h2>
              <p className="meta">@{perfil.handle}</p>
            </div>
          </div>
          {perfil.personagemFalecido && <p className="meta"><em>Personagem falecido</em></p>}
          {perfil.descricao && <p className="internet-perfil-descricao">{perfil.descricao}</p>}
          <p className="meta">
            {totalSeguidores} {totalSeguidores === 1 ? "seguidor" : "seguidores"}
            {" · "}
            <button
              type="button"
              className="secundario"
              onClick={async () => {
                setMsgFollow(null);
                try {
                  const r = seguindo
                    ? await adaptador.deixarDeSeguirConta(perfil.handle)
                    : await adaptador.seguirConta(perfil.handle);
                  setSeguindo(!seguindo);
                  setTotalSeguidores(r.seguidores);
                } catch (e) {
                  setMsgFollow(e instanceof ApiError ? e.message : "Não foi possível atualizar.");
                }
              }}
            >{seguindo ? "Deixar de seguir" : "Seguir"}</button>
            {msgFollow && <span className="meta"> {msgFollow}</span>}
          </p>
          <h3>Publicações</h3>
          {perfil.publicacoes.length === 0 ? (
            <p className="meta">Nenhuma publicação visível.</p>
          ) : (
            <ul className="internet-perfil-publicacoes">
              {perfil.publicacoes.map((p) => (
                <li key={p.id} className="cartao">
                  <strong>{p.titulo}</strong>
                  {p.anonima && <span className="badge">anônima</span>}
                  {p.pseudoNome && <span className="badge">{p.pseudoNome}</span>}
                  <p>{p.corpo}</p>
                  {p.publicadoEm && <p className="meta">{new Date(p.publicadoEm).toLocaleString("pt-BR")}</p>}
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="secundario" onClick={aoVoltar}>← Voltar</button>
        </section>
      )}
    </div>
  );
}
