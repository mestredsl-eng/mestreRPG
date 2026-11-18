# Identidade visual — Terror & Mistério

## Princípio de marca

O Mestre RPG tem uma direção artística permanente: **terror e mistério**. A interface deve sugerir investigação, suspense, segredos, fenômenos inexplicáveis e o desconhecido. Ela não deve parecer um painel corporativo genérico nem depender de clichês visuais exagerados.

A atmosfera é um apoio à narrativa, nunca um obstáculo para jogar. Leitura, orientação, contraste e resposta rápida têm prioridade sobre decoração.

## Linguagem visual

- **Sombria e elegante:** fundos carvão, preto-violeta e superfícies profundas.
- **Vinho:** cor de ação, perigo narrativo e destaque. Usar em doses controladas.
- **Âmbar envelhecido:** metadados, detalhes editoriais e acabamento de arquivo.
- **Cinzas frios e malvas:** texto secundário, bordas e hierarquia discreta.
- **Luz contextual:** brilhos e gradientes suaves, sem grandes áreas saturadas.
- **Textura:** grão sutil e vinheta; evitar imagens pesadas ou vídeo de fundo.

## Tokens iniciais

| Token CSS | Valor inicial | Uso |
|---|---:|---|
| `--horror-noite` | `#0b0a0f` | Fundo mais profundo |
| `--horror-carvao` | `#131118` | Fundo estrutural |
| `--horror-superficie` | `#1b1720` | Cartões e painéis |
| `--horror-superficie-elevada` | `#211b26` | Superfície elevada |
| `--horror-vinho` | `#8d3d4b` | Acento principal |
| `--horror-vinho-claro` | `#b85c69` | Foco e realce |
| `--horror-ambar` | `#b99a62` | Detalhe secundário |
| `--horror-texto` | `#eee7e8` | Texto principal |
| `--horror-texto-suave` | `#b4a9b1` | Texto secundário |

Os tokens são a base da personalização futura. Novas atmosferas devem sobrescrevê-los, em vez de espalhar cores literais por componentes.

## Tipografia e superfícies

A tipografia funcional continua usando a pilha de sistema (Segoe UI/system-ui). Georgia/serif fica reservada para o nome da marca e títulos selecionados, criando contraste editorial sem sacrificar legibilidade.

Cartões mantêm sua geometria e comportamento atuais. A camada de identidade adiciona profundidade, bordas discretas, uma linha de luz no topo e feedback de interação. Não esconder conteúdo em texturas nem comprometer áreas clicáveis.

## Ícones

Ícones funcionais são SVGs locais, com traço consistente, `currentColor`, dimensão baseada em viewBox 24×24 e significado reconhecível. Devem acompanhar rótulo textual quando a ação não for universalmente óbvia. Emojis ficam reservados a conteúdo escrito pelos usuários, não à navegação ou aos controles essenciais.

Evitar ícones remotos, dependência de CDN e elementos que dependam apenas da cor para comunicar estado.

## Movimento e efeitos

Transições curtas (aproximadamente 160–180 ms) podem dar resposta a hover, foco, seleção e abertura de superfícies. Movimento não deve atrasar ações nem competir com a leitura. Efeitos intensos ficam reservados a eventos narrativos explícitos da mesa.

Toda implementação precisa respeitar `prefers-reduced-motion: reduce`. Preferências próprias de movimento devem poder reduzir ainda mais os efeitos.

## Acessibilidade e desempenho

- Contraste de texto e foco visível são requisitos, não opções de tema.
- Navegação por teclado e rótulos acessíveis devem continuar funcionais.
- O layout deve continuar responsivo em desktop, tablet e celular.
- Preferir CSS e recursos locais leves; não usar vídeo de fundo nem partículas contínuas como decoração permanente.
- Nenhum preset pode reduzir legibilidade, apagar estado de foco ou esconder feedback de erro/sucesso.

## Atmosferas planejadas para personalização

As opções seguintes são direções de composição, não temas fora da identidade da marca:

- **Investigação Noturna:** carvão, vinho discreto e luz fria.
- **Arquivo Oculto:** tons de papel envelhecido e âmbar controlado sobre superfícies escuras.
- **Ocultismo:** violeta profundo, símbolos geométricos e brilho pontual.
- **Terror Psicológico:** contraste frio, pouca ornamentação e tensão silenciosa.
- **Mistério Sobrenatural:** verde espectral muito contido e sombras profundas.

A intensidade (discreta, equilibrada ou imersiva), a textura e o movimento devem ser preferências independentes do preset.

## Aprendizagem de preferências

O sistema poderá aprender padrões a partir de escolhas explícitas do próprio usuário e sugerir presets/ajustes com prévia. Sugestões nunca aplicam alterações sem consentimento. Preferências são individuais, resetáveis e não podem ser compartilhadas acidentalmente com outros membros da campanha. A implementação deve reutilizar `users.preferences` e a API autenticada existente, com schema fechado e validação no servidor.
