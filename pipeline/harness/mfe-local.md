# Subir a tela localmente

Este é o guia padrão. Se o seu projeto tem uma receita própria (micro frontends, host simulado, variáveis de ambiente, kits locais), escreva-a num arquivo fora do versionamento e aponte `localGuide` em `pipeline.config.json` para ele: o roteiro do desk check passa a mandar o agente seguir o seu guia.

## Como montar

- Siga o README do repositório do PR e use os mocks que o próprio repositório já tem.
- Se a tela só roda montada por um host, crie uma página de teste em `.local-harness/` dentro da worktree (a pasta já está em `.git/info/exclude` e nunca vai para o repositório) que monte o componente com serviços e autenticação simulados.
- Suba o servidor em segundo plano, confirme que a tela responde antes de testar e derrube ao terminar.

## Dados reais e dados mockados

- **Dados reais (padrão):** aponte a tela para as APIs do ambiente de teste escolhido. Se pedir login, abra o Chrome com `deskcheck login --url <url>` e deixe o usuário entrar.
- **Dados mockados:** só quando o usuário escolher. Use os mocks do repositório.

## Limites

- O que depende de um back-end que não roda localmente vai em `notTestable`, com o motivo.
- Problema de ambiente não é defeito: se a tela não subir, diga o que falhou.
