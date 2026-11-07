import type { TipoRegra } from "./regras.js";

/**
 * Biblioteca inicial para RPG contemporâneo (Caçadores & Caçados) — spec §4.
 * É apenas uma base: o mestre pode editar, desativar ou remover tudo.
 * `key` é estável e usada para vincular campos da ficha (campo.regra / regraKind).
 */

export interface ItemSeed {
  kind: TipoRegra;
  key: string;
  name: string;
  category: string;
  def?: Record<string, unknown>;
}

const E = (kind: TipoRegra, key: string, name: string, category: string, def: Record<string, unknown> = {}): ItemSeed => ({
  kind, key, name, category, def,
});

const conhecimento = (key: string, name: string, category: string, def: Record<string, unknown> = {}) =>
  E("conhecimento", key, name, category, def);
const profissao = (key: string, name: string, def: Record<string, unknown> = {}) =>
  E("profissao", key, name, "Profissões e atividades", def);

export const SEED_BIBLIOTECA: ItemSeed[] = [
  // ===== Atributos principais (Caçadores & Caçados — spec §5.1) =====
  E("atributo", "forca", "Força", "Atributos principais", { custoPontos: 7, minimo: 1, maximo: 6 }),
  E("atributo", "destreza", "Destreza", "Atributos principais", { custoPontos: 7, minimo: 1, maximo: 6 }),
  E("atributo", "vitalidade", "Vitalidade", "Atributos principais", { custoPontos: 7, minimo: 1, maximo: 6 }),
  E("atributo", "inteligencia", "Inteligência", "Atributos principais", { custoPontos: 7, minimo: 1, maximo: 6 }),
  E("atributo", "percepcao", "Percepção", "Atributos principais", { custoPontos: 7, minimo: 1, maximo: 6 }),
  E("atributo", "presenca", "Presença", "Atributos principais", { custoPontos: 7, minimo: 1, maximo: 6 }),

  // ===== Tecnologia e computação =====
  conhecimento("informatica", "Informática", "Tecnologia e computação"),
  conhecimento("computacao", "Computação", "Tecnologia e computação"),
  conhecimento("programacao", "Programação", "Tecnologia e computação"),
  conhecimento("dev_software", "Desenvolvimento de software", "Tecnologia e computação"),
  conhecimento("redes", "Redes de computadores", "Tecnologia e computação"),
  conhecimento("seguranca_digital", "Segurança digital", "Tecnologia e computação"),
  conhecimento("hardware", "Hardware", "Tecnologia e computação"),
  conhecimento("sistemas_operacionais", "Sistemas operacionais", "Tecnologia e computação"),
  conhecimento("ia", "Inteligência artificial", "Tecnologia e computação"),
  conhecimento("banco_dados", "Banco de dados", "Tecnologia e computação"),
  conhecimento("eletronica", "Eletrônica", "Tecnologia e computação"),
  conhecimento("telecom", "Telecomunicações", "Tecnologia e computação"),

  // ===== Mecânica e engenharia =====
  conhecimento("mecanica_auto", "Mecânica automotiva", "Mecânica e engenharia"),
  conhecimento("mecanica_moto", "Mecânica de motocicletas", "Mecânica e engenharia"),
  conhecimento("mecanica_aero", "Mecânica aeronáutica", "Mecânica e engenharia"),
  conhecimento("eng_mecanica", "Engenharia mecânica", "Mecânica e engenharia"),
  conhecimento("eng_eletrica", "Engenharia elétrica", "Mecânica e engenharia"),
  conhecimento("eng_civil", "Engenharia civil", "Mecânica e engenharia"),
  conhecimento("automacao", "Automação", "Mecânica e engenharia"),
  conhecimento("robotica", "Robótica", "Mecânica e engenharia"),
  conhecimento("manut_industrial", "Manutenção industrial", "Mecânica e engenharia"),
  conhecimento("construcao", "Construção", "Mecânica e engenharia"),
  conhecimento("reparo_equip", "Reparo de equipamentos", "Mecânica e engenharia"),

  // ===== Ciências =====
  conhecimento("geologia", "Geologia", "Ciências"),
  conhecimento("quimica", "Química", "Ciências"),
  conhecimento("fisica", "Física", "Ciências"),
  conhecimento("biologia", "Biologia", "Ciências"),
  conhecimento("medicina", "Medicina", "Ciências"),
  conhecimento("anatomia", "Anatomia", "Ciências"),
  conhecimento("farmacologia", "Farmacologia", "Ciências"),
  conhecimento("psicologia", "Psicologia", "Ciências"),
  conhecimento("astronomia", "Astronomia", "Ciências"),
  conhecimento("matematica", "Matemática", "Ciências"),
  conhecimento("estatistica", "Estatística", "Ciências"),
  conhecimento("ecologia", "Ecologia", "Ciências"),

  // ===== Arte e criatividade =====
  conhecimento("pintura", "Pintura", "Arte e criatividade"),
  conhecimento("desenho", "Desenho", "Arte e criatividade"),
  conhecimento("escultura", "Escultura", "Arte e criatividade"),
  conhecimento("musica", "Música", "Arte e criatividade"),
  conhecimento("fotografia", "Fotografia", "Arte e criatividade"),
  conhecimento("cinema", "Cinema", "Arte e criatividade"),
  conhecimento("teatro", "Teatro", "Arte e criatividade"),
  conhecimento("danca", "Dança", "Arte e criatividade"),
  conhecimento("design", "Design", "Arte e criatividade"),
  conhecimento("artesanato", "Artesanato", "Arte e criatividade"),
  conhecimento("escrita", "Escrita", "Arte e criatividade"),
  conhecimento("producao_artistica", "Produção artística", "Arte e criatividade"),

  // ===== Profissões e atividades =====
  profissao("advogado", "Advogado"),
  profissao("medico", "Médico"),
  profissao("engenheiro", "Engenheiro"),
  profissao("jornalista", "Jornalista"),
  profissao("investigador", "Investigador"),
  profissao("policial", "Policial"),
  profissao("professor", "Professor"),
  profissao("arquiteto", "Arquiteto"),
  profissao("empresario", "Empresário"),
  profissao("contador", "Contador"),
  profissao("administrador", "Administrador"),
  profissao("mecanico", "Mecânico"),
  profissao("programador", "Programador"),
  profissao("cientista", "Cientista"),
  profissao("artista", "Artista"),
  profissao("comerciante", "Comerciante"),
  profissao("cozinheiro", "Cozinheiro"),
  profissao("motorista", "Motorista"),

  // ===== Conhecimentos práticos =====
  conhecimento("primeiros_socos", "Primeiros socorros", "Conhecimentos práticos"),
  conhecimento("sobrevivencia", "Sobrevivência", "Conhecimentos práticos"),
  conhecimento("direcao", "Direção", "Conhecimentos práticos"),
  conhecimento("navegacao", "Navegação", "Conhecimentos práticos"),
  conhecimento("idiomas", "Idiomas", "Conhecimentos práticos"),
  conhecimento("negociacao", "Negociação", "Conhecimentos práticos"),
  conhecimento("investigacao", "Investigação", "Conhecimentos práticos"),
  conhecimento("rastreamento", "Rastreamento", "Conhecimentos práticos"),
  conhecimento("oratoria", "Oratória", "Conhecimentos práticos"),
  conhecimento("lideranca", "Liderança", "Conhecimentos práticos"),
  conhecimento("diplomacia", "Diplomacia", "Conhecimentos práticos"),
  conhecimento("culinaria", "Culinária", "Conhecimentos práticos"),

  // ===== Talentos (spec §5.2 — custo progressivo padrão) =====
  ...(["atletismo", "reflexos", "furtividade", "percepcao_agucada", "memoria", "concentracao", "sorte", "coragem"] as const).map((k) =>
    E("talento", k, k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), "Talentos", {
      custoProgressivo: [1, 2, 3, 4, 5],
      minimo: 0,
      maximo: 5,
    })
  ),

  // ===== Defeitos (spec §7 — reserva própria) =====
  E("defeito", "gagueira", "Gagueira", "Defeitos", { reservaPontos: "defeitos", custoPontos: -1 }),
  E("defeito", "cegueira", "Cegueira", "Defeitos", { reservaPontos: "defeitos", custoPontos: -2 }),
  E("defeito", "surdez", "Surdez", "Defeitos", { reservaPontos: "defeitos", custoPontos: -2 }),
  E("defeito", "mudez", "Mudez", "Defeitos", { reservaPontos: "defeitos", custoPontos: -2 }),
  E("defeito", "mobilidade_reduzida", "Mobilidade reduzida", "Defeitos", { reservaPontos: "defeitos", custoPontos: -1 }),
  E("defeito", "fobia_social", "Fobia social", "Defeitos", { reservaPontos: "defeitos", custoPontos: -1 }),

  // ===== Vantagens (spec §7 — reserva própria) =====
  E("vantagem", "memoria_excepcional", "Memória excepcional", "Vantagens", { reservaPontos: "vantagens", custoPontos: 1 }),
  E("vantagem", "reflexos_treinados", "Reflexos treinados", "Vantagens", { reservaPontos: "vantagens", custoPontos: 2 }),
  E("vantagem", "contatos_influentes", "Contatos influentes", "Vantagens", { reservaPontos: "vantagens", custoPontos: 2 }),
  E("vantagem", "formacao_especializada", "Formação especializada", "Vantagens", { reservaPontos: "vantagens", custoPontos: 1 }),
  E("vantagem", "patrimonio", "Patrimônio", "Vantagens", { reservaPontos: "vantagens", custoPontos: 3 }),

  // ===== Poderes (spec §6) =====
  E("poder", "magia", "Magia", "Poderes", {
    custoPontos: 3,
    grupoExclusividade: "poderes_ocultos",
    obrigatorios: ["defeito:preco_oculto"],
  }),
  E("poder", "feiticos", "Feitiços", "Poderes", {
    custoPontos: 2,
    grupoExclusividade: "poderes_ocultos",
    obrigatorios: ["defeito:preco_oculto"],
  }),
  E("poder", "teleporte", "Teleporte", "Poderes", { custoPontos: 4, grupoExclusividade: "poderes_ocultos", obrigatorios: ["defeito:preco_oculto"] }),
  E("poder", "telepatia", "Telepatia", "Poderes", { custoPontos: 3, grupoExclusividade: "poderes_ocultos", obrigatorios: ["defeito:preco_oculto"] }),
  E("poder", "controle_mental", "Controle mental", "Poderes", { custoPontos: 5, grupoExclusividade: "poderes_ocultos", obrigatorios: ["defeito:preco_oculto"] }),
  E("poder", "transformacao", "Transformação", "Poderes", { custoPontos: 4, grupoExclusividade: "poderes_ocultos", obrigatorios: ["defeito:preco_oculto"] }),
  E("poder", "sorte", "Sorte sobrenatural", "Poderes", { custoPontos: 2, grupoExclusividade: "poderes_ocultos" }),
  E("defeito", "preco_oculto", "Preço oculto", "Defeitos", {
    descricao: "Defeito metafórico exigido por poderes sobrenaturais (spec §6)",
    custoPontos: 0,
  }),
];
