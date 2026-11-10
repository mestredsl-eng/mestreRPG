# Primeira partida — do zero à mesa em grupo

Roteiro para o responsável colocar o grupo para jogar. Não é preciso
conhecimento técnico: tudo acontece pelo navegador. Detalhes de backup,
restauração e variáveis ficam em `docs/GUIA-OPERACAO.md`.

## 1. Subir o servidor (Windows)

1. Abra a pasta do projeto no Explorador de Arquivos.
2. Duplo clique em **`iniciar-mestre-rpg.bat`**.
   - Na primeira vez o script instala as dependências e compila o projeto
     sozinho (pode demorar alguns minutos).
   - Em execuções seguintes sobe direto.
3. Aguarde a mensagem `[OK] Servidor iniciado` e abra:
   **http://localhost:3001**
4. Deixe essa janela aberta durante toda a sessão — fechá-la encerra o
   servidor com segurança.

> Para acesso de outros aparelhos na mesma rede, use o IP do PC
> (`ipconfig` → IPv4) no lugar de `localhost`, ex.:
> `http://192.168.0.10:3001`. O Windows pode perguntar sobre o Firewall
> na primeira vez — aceite a rede **Privada**.

## 2. Conta do mestre

1. Na tela de login, crie a conta de administrador (primeiro acesso).
2. Depois é só entrar com usuário e senha.

## 3. Criar a campanha

1. No painel, clique em **Nova campanha**.
2. Dê um nome (ex.: "Crônicas de Eldoria") e salve.
3. Dentro da campanha, a aba **Regras** permite ajustar HP, vitalidade,
   moedas e pontos — ou carregar um livro do **Acervo** (biblioteca de
   regras pronta). Para a primeira partida, os padrões já funcionam.

## 4. Convidar os jogadores

1. Na aba **Convites** da campanha, clique em **Gerar convite**.
2. Copie o link/código gerado e envie aos jogadores (WhatsApp, Discord…).
3. Cada jogador abre o link no navegador, cria a conta e entra como
   **Jogador** automaticamente vinculado à campanha.

## 5. Fichas dos jogadores

1. Cada jogador abre a aba **Fichas**, clica em **Novo personagem**,
   preenche nome e atributos e envia.
2. O mestre revisa na mesma aba e clica em **Aprovar** (ou devolve com
   observação).
3. Opcional: em **Modelos de ficha** o mestre pode montar um modelo com
   os campos que a campanha usa.

## 6. Patrimônio e equipamentos

1. Na aba **Patrimônio**, cada personagem recebe itens, ouro/moedas e
   equipamentos (arma, armadura) conforme as regras da campanha.
2. Jogadores podem gerenciar o próprio patrimônio se as permissões da
   campanha permitirem — ajuste em **Participantes** se necessário.

## 7. Mesa — sessão ao vivo

1. O mestre abre a aba **Mesa** e clica em **Iniciar sessão**.
2. Os jogadores entram na mesa — a **presença** mostra quem está online.
3. **Chat**: mensagens públicas aparecem para todos; o mestre pode enviar
   **privada** (escolhendo o destinatário) ou **secreta** (só mestres veem).
   Espectadores só falam se o mestre liberar em **Participantes**.
4. **Rolagens**: use o campo de rolagem para D4, D6, D8, D10 e D20.
5. **Testes de habilidade**: o mestre pede um teste D10 para um
   personagem; o dono rola e o servidor calcula sucessos/falhas.
6. **Turnos e ampulheta**: o mestre define a ordem dos participantes,
   avança turnos e liga o timer — todos veem o tick em tempo real.

## 8. Persistência — testar antes de começar

1. Jogue um pouco, anote nomes de itens e valores de HP.
2. Encerre a sessão de mesa (botão **Encerrar sessão**).
3. Feche a janela do servidor (ou Ctrl+C) e rode
   **`iniciar-mestre-rpg.bat`** de novo.
4. Reabra a campanha: personagens, inventário, finanças, histórico de
   chat e rolagens devem estar exatamente como estavam.

## 9. Backup antes de jogar de verdade

Antes da primeira sessão real, faça um backup completo — ver
`docs/GUIA-OPERACAO.md`, seção "Backup e restauração". Em resumo:

- O backup copia `banco/mestre-rpg.db` + `arquivos/campanhas/` para
  `backups/<data>_<tipo>/` com manifesto e hashes.
- Para restaurar: admin → backup → restaurar → **parar o servidor** →
  reiniciar (o script aplica a restauração antes de subir).
- **Nunca apague** `banco/`, `arquivos/`, `backups/`, `configuracao/`
  nem `servidor/migrations/` em atualizações.

## 10. Se o servidor fechar inesperadamente

1. Simplesmente rode `iniciar-mestre-rpg.bat` novamente — os dados ficam
   salvos no banco e nos arquivos a cada alteração.
2. Se algo parecer corrompido, restaure o backup da seção 9.
3. Erros ficam em `logs/servidor.log`.

## O que ainda depende de teste humano

- Fluxo completo de convite + cadastro pela interface (coberto por API,
  mas vale um teste real com os jogadores).
- Leitura dos livros do Acervo em tela pequena (celular).
- Experiência geral do mestre conduzindo a primeira sessão — ritmo,
  clareza das mensagens e se algum passo travou.
