# Planejamento técnico — mesa compartilhada de dados 3D

> **Status:** proposta de arquitetura, sem implementação.
>
> Este documento prepara uma etapa futura. Não altera o lançador atual, a física individual da PR #19, os eventos Socket.IO, o banco de dados ou as regras de rolagem.

## Objetivo

Evoluir, somente depois de a física individual estar validada e integrada, para uma cena única de mesa em que vários dados ocupem o mesmo espaço, colidam entre si e com os limites visíveis da superfície.

A mesa deve parecer uma área física contínua: superfície, bordas, dados lançados juntos, colisões perceptíveis e repouso natural. A quantidade e os valores dos dados continuam vindo do resultado oficial do servidor.

## Regras que não podem mudar

1. **Servidor continua decidindo os resultados.** O cliente nunca sorteia nem altera o valor de uma face.
2. A física é apresentação. Colisão, quique ou orientação visual não podem transformar um resultado recebido em outro.
3. Preservar d4, d6, d8, d10 e d20, cores externas/internas configuráveis e indicação de sucesso/falha.
4. Preservar rolagens em grupo, total, motivo, visibilidade e identificação da rolagem.
5. Respeitar `prefers-reduced-motion`, telas pequenas e fallback quando Canvas não estiver disponível.
6. Não adicionar dependência pesada ou motor físico completo sem medição que justifique.

## Arquitetura proposta

### 1. Um único proprietário da cena

Criar um componente de alto nível (nome provisório `MesaDados3D`) responsável por:

- dimensionar a área útil da mesa;
- desenhar superfície e limites;
- receber os dados já resolvidos pelo fluxo atual;
- posicionar todos os dados da rolagem;
- manter uma única simulação/agenda de frames para a cena;
- coordenar colisões, repouso, cancelamento e limpeza.

Os dados deixam de possuir canvases independentes. Cada dado passa a ser uma entidade da mesma cena, com geometria, orientação, posição, velocidade linear e velocidade angular próprias.

### 2. Coordenadas e unidades

Usar coordenadas de mundo independentes da resolução da tela:

- **X/Y:** posição sobre a superfície;
- **Z:** altura acima da mesa;
- **limites:** retângulo interno da mesa, descontando uma margem para o tamanho de cada dado;
- **escala:** derivada do menor lado disponível, com limites mínimos/máximos para manter legibilidade.

O redimensionamento altera a projeção e os limites, não o valor do dado. A simulação precisa continuar válida em desktop e mobile.

### 3. Colisões em duas etapas

Para evitar testar todos os vértices contra todos os dados a cada frame:

- **Broad phase:** volumes envolventes simples para descartar rapidamente pares distantes.
- **Narrow phase:** teste geométrico entre poliedros convexos somente nos pares candidatos. Avaliar SAT (Separating Axis Theorem) para as geometrias existentes; se o custo ficar alto, começar com aproximação conservadora e documentar a limitação visual.

As colisões devem considerar também a superfície e as quatro bordas. A resposta física usa restituição, atrito e amortecimento limitados, evitando dados que quicam indefinidamente ou escapem da mesa.

Não introduzir colisões entre dados como alteração isolada dentro de cada canvas. Elas exigem a cena compartilhada descrita aqui.

### 4. Animação e repouso

- Distribuir posições iniciais sem sobreposição.
- Aplicar impulsos iniciais variados, sem depender deles para definir faces.
- Resolver colisões e contatos com a mesa.
- Amortecer velocidades lineares e angulares.
- Considerar o dado repousado somente após permanecer abaixo dos limites de energia por um intervalo contínuo.
- Ao repousar, alinhar visualmente a face correspondente ao valor recebido do servidor, sem mudar esse valor.
- Ter limite máximo de duração como proteção contra simulação presa; ao atingir o limite, concluir com transição visual curta e segura.

### 5. Sincronização entre jogadores

A mensagem de rolagem existente continua sendo a fonte dos valores. A cena deve consumir o mesmo identificador e os mesmos resultados que já chegam à mesa.

Decisão a tomar antes da implementação: se todos os jogadores precisam ver exatamente a mesma trajetória ou se basta que todos vejam os mesmos resultados com animações locais. Para trajetórias iguais, será necessário um identificador/semente visual estável associado à rolagem; essa semente nunca participa do sorteio nem substitui os valores do servidor. Não criar novo evento ou persistência antes de confirmar o contrato atual de Socket.IO.

## Etapas de implementação sugeridas

1. **Preparação:** concluir e integrar a física individual atual. Não misturar esta etapa com a PR #19.
2. **Cena estática:** mesa, limites visíveis, posicionamento de vários dados e renderização de todas as geometrias sem colisões.
3. **Física compartilhada:** gravidade, contato com a superfície, bordas e repouso de cada dado na cena única.
4. **Colisão dado–dado:** broad phase, narrow phase e resposta de colisão.
5. **Polimento:** distribuição inicial, pequenas variações de impulso, sombras, legibilidade, responsividade e orçamento de desempenho.
6. **Sincronização visual:** somente se o comportamento multiplayer atual e a experiência desejada exigirem trajetórias iguais entre clientes.

Cada etapa deve ter PR própria e validação antes de avançar.

## Critérios de aceite para a futura etapa

- Todos os dados de uma rolagem aparecem na mesma superfície, com bordas visíveis.
- Dois dados que se cruzariam na mesma área colidem visualmente e não atravessam um ao outro.
- Dados colidem com as bordas e permanecem dentro da mesa.
- D4, D6, D8, D10 e D20 exibem corretamente o valor recebido.
- A soma e os resultados exibidos permanecem idênticos aos retornados pelo servidor.
- Nenhuma colisão ou animação dispara uma nova rolagem.
- Testar 1, 5, 10 e 30 dados; desktop e viewport de 390 px.
- Sem erros de console, canvas em branco ou animação que não termina.
- Movimento reduzido apresenta o resultado final sem simulação.
- Medir FPS e tempo de conclusão em aparelho móvel real antes de considerar a etapa pronta.

## Fora de escopo desta proposta

- Alterar regras, probabilidades, sucessos ou dano.
- Fazer a física escolher a face sorteada.
- Adicionar dados, tipos de rolagem ou novos eventos de jogo.
- Implementar agora a mesa compartilhada ou colisões.
- Trocar Canvas por WebGL/Three.js sem evidência de necessidade.
- Alterar banco de dados ou criar tabelas.

## Próxima ação quando chegar a hora

Depois de a PR #19 ser validada e integrada, revisar este plano contra o código final e abrir uma PR pequena começando apenas pela **cena estática compartilhada**, sem colisões ainda.
