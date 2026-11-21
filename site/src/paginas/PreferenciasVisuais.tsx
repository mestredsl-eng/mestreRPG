import { useEffect, useRef, useState } from "react";
import { api, type Usuario } from "../api";
import { useNotificar } from "../Notificacoes";
import {
  aplicarPreferenciasVisuais,
  atributosVisuais,
  preferenciasVisuaisDe,
  sistemaPrefereReducao,
  tokensVisuaisComoEstilo,
  type PreferenciasVisuais,
} from "../visualUsuario";
import {
  ATMOSFERAS_VISUAIS,
  ANIMACOES,
  CORES_DESTAQUE,
  DENSIDADES,
  INTENSIDADES,
  PALETA_DESTAQUE,
  SUPERFICIES,
  TEXTURAS,
  VISUAL_PADRAO,
  sugestaoVisualAprendizado,
} from "../temasVisuais";
import "../preferencias-visuais.css";

// Rótulos das dimensões — os valores vêm exclusivamente do catálogo fechado.
const ROTULOS: Record<string, Record<string, string>> = {
  intensidade: { discreta: "Discreta", equilibrada: "Equilibrada", imersiva: "Imersiva" },
  superficies: { padrao: "Padrão", flat: "Flat", elevado: "Elevado" },
  textura: { nenhuma: "Nenhuma", sutil: "Sutil", intensa: "Intensa" },
  animacoes: { reduzido: "Reduzido", normal: "Normal", completo: "Completo" },
  densidade: { compacta: "Compacta", padrao: "Padrão", ampla: "Ampla" },
};

const DICAS: Record<string, Record<string, string>> = {
  intensidade: {
    discreta: "Efeitos mínimos — leitura limpa.",
    equilibrada: "Equilíbrio entre clima e legibilidade.",
    imersiva: "Atmosfera mais intensa e cinematográfica.",
  },
  superficies: {
    padrao: "Cartões com profundidade e bordas suaves.",
    flat: "Superfícies planas, bordas discretas.",
    elevado: "Mais contraste e sombra entre camadas.",
  },
  textura: {
    nenhuma: "Sem textura de fundo.",
    sutil: "Grão discreto por cima do fundo.",
    intensa: "Textura marcada, clima denso.",
  },
  animacoes: {
    reduzido: "Movimento mínimo.",
    normal: "Animações do padrão da identidade.",
    completo: "Animações mais expressivas.",
  },
  densidade: {
    compacta: "Mais informação por tela.",
    padrao: "Densidade da identidade.",
    ampla: "Mais respiro entre os elementos.",
  },
};

const DIMENSOES: { campo: keyof PreferenciasVisuais; titulo: string; opcoes: readonly string[] }[] = [
  { campo: "intensidade", titulo: "Intensidade", opcoes: INTENSIDADES },
  { campo: "corDestaque", titulo: "Cor de destaque", opcoes: CORES_DESTAQUE },
  { campo: "superficies", titulo: "Superfícies", opcoes: SUPERFICIES },
  { campo: "textura", titulo: "Textura", opcoes: TEXTURAS },
  { campo: "animacoes", titulo: "Animações", opcoes: ANIMACOES },
  { campo: "densidade", titulo: "Densidade", opcoes: DENSIDADES },
];

function mesmoVisual(a: PreferenciasVisuais, b: PreferenciasVisuais): boolean {
  return (
    a.intensidade === b.intensidade &&
    a.corDestaque === b.corDestaque &&
    a.superficies === b.superficies &&
    a.textura === b.textura &&
    a.animacoes === b.animacoes &&
    a.densidade === b.densidade
  );
}

/** Editor de aparência da conta (Issue #132, etapa 2.2b). */
export default function PreferenciasVisuais({ usuario, recarregar }: { usuario: Usuario; recarregar: () => Promise<void> }) {
  const salvo = preferenciasVisuaisDe(usuario.preferences?.visual);
  const [rascunho, setRascunho] = useState<PreferenciasVisuais>(salvo);
  const [salvando, setSalvando] = useState(false);
  const salvandoRef = useRef(false);
  const [erro, setErro] = useState<string | null>(null);
  const { notificar } = useNotificar();
  const [sistemaReduz] = useState(sistemaPrefereReducao);

  // Recarrega o rascunho quando o usuário muda ou as preferências salvas mudam.
  useEffect(() => {
    setRascunho(preferenciasVisuaisDe(usuario.preferences?.visual));
    setErro(null);
  }, [usuario.id, usuario.preferences?.visual]);

  const sujo = !mesmoVisual(rascunho, salvo);

  const aplicar = async (alvo: PreferenciasVisuais) => {
    if (salvandoRef.current) return;
    salvandoRef.current = true;
    setSalvando(true);
    setErro(null);
    try {
      await api.atualizarPreferenciasVisuais({ ...alvo });
      aplicarPreferenciasVisuais(alvo);
      setRascunho({ ...alvo });
      notificar("Preferências visuais salvas.", "sucesso");
      await recarregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Não foi possível salvar as preferências visuais.");
    } finally {
      salvandoRef.current = false;
      setSalvando(false);
    }
  };

  const cancelar = () => {
    setRascunho(preferenciasVisuaisDe(usuario.preferences?.visual));
    setErro(null);
  };

  const restaurarPadroes = () => {
    if (salvandoRef.current) return;
    void aplicar({ ...VISUAL_PADRAO });
  };

  const tokensPreview = tokensVisuaisComoEstilo(rascunho);
  const attrsPreview = atributosVisuais(rascunho);

  // ---------- Aprendizado visual (Issue #132) ----------
  // Opt-in explícito; o histórico só cresce no servidor quando um PATCH
  // `visual` é aplicado com sucesso. Nada aqui aplica tema sozinho.
  const aprendizado = usuario.preferences?.visualAprendizado;
  const aprendizadoOptIn = aprendizado?.optIn === true;
  const historicoAprendizado = Array.isArray(aprendizado?.historico) ? aprendizado.historico : [];
  const sugestao = aprendizadoOptIn
    ? sugestaoVisualAprendizado(historicoAprendizado, salvo)
    : null;
  const [aprendizadoSalvando, setAprendizadoSalvando] = useState(false);

  const enviarAprendizado = async (parcial: { optIn?: boolean; historico?: PreferenciasVisuais[] }) => {
    if (aprendizadoSalvando) return;
    setAprendizadoSalvando(true);
    setErro(null);
    try {
      await api.atualizarPreferenciasAprendizado(parcial);
      await recarregar();
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Não foi possível atualizar o aprendizado visual.");
    } finally {
      setAprendizadoSalvando(false);
    }
  };

  const alternarOptIn = () => void enviarAprendizado({ optIn: !aprendizadoOptIn });
  const apagarHistorico = () => void enviarAprendizado({ optIn: aprendizadoOptIn, historico: [] });
  // Pré-visualizar só muda o rascunho — o painel de prévia existente já
  // reflete; nenhum PATCH é enviado e o tema global não muda.
  const preVisualizarSugestao = () => {
    if (!sugestao) return;
    setRascunho({ ...sugestao.preferencias });
    setErro(null);
  };

  return (
    <section className="cartao prefs-visuais" aria-labelledby="prefs-visuais-titulo">
      <h2 id="prefs-visuais-titulo">Aparência</h2>
      <p className="dica">
        Personalize o clima visual da sua conta. As escolhas valem apenas para você —
        os demais participantes da campanha não são afetados. A prévia mostra o
        resultado antes de salvar.
      </p>
      {sistemaReduz && (
        <p className="dica" role="note">
          O sistema operacional está configurado para movimento reduzido — essa
          preferência sempre prevalece sobre a escolha abaixo.
        </p>
      )}

      <fieldset className="prefs-atmosferas">
        <legend>Atmosferas predefinidas</legend>
        <div className="prefs-atmosferas-grade">
          {ATMOSFERAS_VISUAIS.map((a) => {
            const ativo = mesmoVisual(rascunho, a.preferencias as PreferenciasVisuais);
            return (
              <button
                key={a.id}
                type="button"
                className={`prefs-atmosfera${ativo ? " ativo" : ""}`}
                aria-pressed={ativo}
                onClick={() => { setRascunho({ ...(a.preferencias as PreferenciasVisuais) }); setErro(null); }}
                disabled={salvando}
              >
                <strong>{a.nome}</strong>
                <span>{a.descricao}</span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="prefs-grade">
        {DIMENSOES.map(({ campo, titulo, opcoes }) => (
          <fieldset key={campo} className="prefs-dimensao">
            <legend>{titulo}</legend>
            <div className="prefs-opcoes" role="radiogroup" aria-label={titulo}>
              {opcoes.map((op) => {
                const id = `pv-${campo}-${op}`;
                const infoCor = campo === "corDestaque" ? PALETA_DESTAQUE[op as keyof typeof PALETA_DESTAQUE] : null;
                return (
                  <label key={op} htmlFor={id} className={`prefs-opcao${rascunho[campo] === op ? " ativo" : ""}`}>
                    <input
                      type="radio"
                      id={id}
                      name={`pv-${campo}`}
                      value={op}
                      checked={rascunho[campo] === op}
                      disabled={salvando}
                      onChange={() => setRascunho({ ...rascunho, [campo]: op })}
                    />
                    {infoCor && (
                      <span
                        className="prefs-amostra"
                        style={{ background: infoCor.principal }}
                        aria-hidden="true"
                      />
                    )}
                    <span className="prefs-opcao-texto">
                      <strong>{campo === "corDestaque" ? infoCor!.nome : ROTULOS[campo][op]}</strong>
                      {campo === "corDestaque" && <span>{infoCor!.descricao}</span>}
                      {campo !== "corDestaque" && DICAS[campo]?.[op] && <span>{DICAS[campo][op]}</span>}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>

      <div className="prefs-previa-bloco">
        <h3>Prévia</h3>
        <p className="dica">Painel de demonstração isolado — nada aqui é aplicado até você salvar.</p>
        <div className="pv-visual" style={tokensPreview} {...attrsPreview}>
          <div className="pv-cartao">
            <h4 className="pv-titulo">Registro encontrado</h4>
            <p className="pv-texto">
              O informante relata passos no corredor do arquivo por volta da
              meia. A umidade no chão sugere que algo passou recentemente.
            </p>
            <div className="pv-acoes">
              <button type="button" className="pv-botao">Investigar</button>
              <button type="button" className="pv-botao secundario">Ignorar</button>
            </div>
            <p className="pv-nota">Dado de investigação: 1d20 + 3</p>
          </div>
        </div>
      </div>

      {erro && <p className="erro" role="alert">{erro}</p>}

      <div className="linha prefs-acoes">
        <button type="button" onClick={() => void aplicar(rascunho)} disabled={salvando || !sujo}>
          {salvando ? "Salvando…" : "Aplicar aparência"}
        </button>
        <button type="button" className="secundario" onClick={cancelar} disabled={salvando || !sujo}>
          Cancelar
        </button>
        <button type="button" className="secundario" onClick={restaurarPadroes} disabled={salvando}>
          Restaurar padrões
        </button>
      </div>
      {!sujo && !erro && <p className="dica">Nenhuma alteração pendente.</p>}

      <fieldset className="prefs-aprendizado">
        <legend>Aprendizado com minhas escolhas</legend>
        <p className="dica">
          Quando ativado, o sistema registra apenas as combinações que você
          <strong> aplica e salva</strong> — prévias e cancelamentos nunca contam.
          Nenhuma sugestão é aplicada automaticamente.
        </p>
        <div className="linha">
          <button
            type="button"
            className="secundario"
            aria-pressed={aprendizadoOptIn}
            onClick={alternarOptIn}
            disabled={aprendizadoSalvando || salvando}
          >
            {aprendizadoOptIn ? "Aprendizado ativado" : "Ativar aprendizado"}
          </button>
          {aprendizadoOptIn && historicoAprendizado.length > 0 && (
            <button
              type="button"
              className="secundario"
              onClick={apagarHistorico}
              disabled={aprendizadoSalvando || salvando}
            >
              Apagar histórico
            </button>
          )}
        </div>
        {aprendizadoOptIn && sugestao && (
          <div className="prefs-sugestao" role="status">
            <p>
              <strong>Sugestão:</strong>{" "}
              {(() => {
                const nome = ATMOSFERAS_VISUAIS.find((a) => mesmoVisual(sugestao.preferencias, a.preferencias as PreferenciasVisuais))?.nome;
                return nome ? `atmosfera "${nome}"` : "uma combinação personalizada";
              })()}{" "}
              — você aplicou esta combinação {sugestao.vezes} vezes.
            </p>
            <div className="linha">
              <button type="button" className="secundario" onClick={preVisualizarSugestao} disabled={salvando}>
                Pré-visualizar
              </button>
              <button
                type="button"
                onClick={() => void aplicar({ ...sugestao.preferencias })}
                disabled={salvando}
              >
                Aplicar sugestão
              </button>
            </div>
          </div>
        )}
        {aprendizadoOptIn && !sugestao && historicoAprendizado.length > 0 && (
          <p className="dica">Ainda não há combinação repetida o suficiente para sugerir.</p>
        )}
      </fieldset>
    </section>
  );
}
