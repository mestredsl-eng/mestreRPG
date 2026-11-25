# Política de segurança

A segurança do Mestre RPG inclui autenticação, sessões, autorização por campanha, privacidade dos personagens, dados persistidos, arquivos enviados, backups, atualizações e integrações de rede.

## Versões e escopo

A política se aplica à versão publicada mais recente e ao código mantido neste repositório. Versões antigas podem não receber correções; mantenha a instalação atualizada somente depois de conferir os avisos e seguir o procedimento de backup/restauração documentado no README.

Considere especialmente relevantes falhas que permitam:

- acesso a campanhas, personagens, mensagens ou arquivos sem autorização;
- elevação de privilégios ou contorno de permissões;
- exposição de sessões, credenciais, segredos ou dados pessoais;
- execução de código, injeção, traversal ou gravação/leitura indevida de arquivos;
- corrupção, perda ou adulteração de banco, ledger, exportações ou backups;
- abuso de endpoints, Socket.IO ou processos de atualização/restauração.

## Como reportar uma vulnerabilidade

**Não publique vulnerabilidades, provas de conceito exploráveis, tokens, dados de campanha ou detalhes de exploração em Issues, Discussions ou Pull Requests públicas.**

Use o recurso privado de reporte de vulnerabilidade do GitHub, quando disponível, pela área [Security do repositório](https://github.com/mestredsl-eng/mestreRPG/security). A opção de reporte privado precisa estar habilitada nas configurações do repositório.

Se a opção não estiver disponível, contate o mantenedor em caráter privado pelo canal disponibilizado no perfil [mestredsl-eng](https://github.com/mestredsl-eng). Não publique detalhes técnicos até que exista um canal seguro para tratá-los.

Inclua, quando possível:

- versão/commit afetado e ambiente utilizado;
- impacto observado e pré-condições necessárias;
- passos mínimos para reproduzir, sem atingir dados de terceiros;
- logs ou capturas previamente sanitizados;
- uma sugestão de mitigação, se houver.

Remova senhas, cookies, tokens, endereços privados, nomes de jogadores e conteúdo de campanhas das evidências. Não teste vulnerabilidades contra instalações de terceiros sem autorização.

## Tratamento

Os mantenedores avaliarão a reprodução, o impacto e a abrangência do problema. A correção pode envolver mitigação temporária, patch, atualização de documentação ou orientação de upgrade.

Não há SLA ou prazo fixo de resposta. O mantenedor poderá solicitar informações adicionais por canal privado. A divulgação pública deve ocorrer de forma coordenada, após existir uma correção ou orientação adequada, sempre que isso for possível.

## Divulgação responsável

Agradecemos relatos feitos de boa-fé. Não tente acessar, alterar, excluir ou copiar dados que não sejam seus para demonstrar uma falha. Interrompa o teste assim que o impacto estiver comprovado e preserve a confidencialidade das informações envolvidas.
