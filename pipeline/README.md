# Esteira de Desk Check

App local para fazer o desk check do trabalho de um colega: cola o link do card do Azure DevOps, escolhe o agente e a esteira testa o PR dele em cima dos Test Cases que o QA ligou no **Tested By**, apontando os defeitos.

Só leitura: nada é corrigido, commitado ou gravado no Azure nem no GitHub. Os defeitos saem no relatório, com botão de copiar.

## Rodar

```sh
yarn dev                                  # front e back em http://localhost:4310 (abre o navegador)
yarn dev:simulate                         # mesma tela, sem Azure, GitHub, Chrome nem agente
yarn pipeline 10042 --agent <id>        # pelo terminal ou pelo chat de qualquer agente
yarn pipeline --agents                    # quais agentes estão instalados
yarn test:pipeline                        # trava, adaptadores e API em simulação
```

Sem dependências de npm: o back é Node 22 puro e o React do front está em `web/vendor/`.

O código é todo em inglês e sem comentários; só o texto que aparece na tela, no terminal e no relatório fica em português.

## Agentes, sem chave de API

A esteira chama, em modo não interativo, um agente de linha de comando já logado na máquina. Os agentes são declarados em `agents[]` no `pipeline.config.json`:

| Chave | O que é |
|---|---|
| `id`, `name` | Identificador usado em `--agent` e nome exibido na tela |
| `bin`, `fallbacks` | Comando a executar e caminhos alternativos |
| `install` | Texto mostrado quando o comando não está instalado |
| `output` | `text`, `stream-json` ou `events-json`, conforme o formato que o comando emite |
| `args` | Argumentos, com `{prompt}`, `{cwd}`, `{lastMessage}`, `{dirsCsv}` e `{dirs:--flag}` (repete a flag para cada pasta liberada) |

O agente recebe o roteiro `harness/desk-check.md`.

## Trava de somente leitura

Durante o desk check, `harness/guard` vai na frente do PATH do agente: `git commit/push/reset/merge/rebase…`, `gh api` e `gh pr create/comment/review/merge…`, `az … create/update/delete/invoke…` e `deskcheck defect/evidence/mark/apply` saem com código 87. No fim, a esteira confere se algum arquivo do código do colega mudou.

## Estrutura

| Caminho | O que é |
|---|---|
| `server/index.mjs` | Back: fluxo, API (`/api/runs`, `/api/agents`, `/api/events` em SSE), relatórios em `/report/<id>/` e o front |
| `server/agents.mjs` | Adaptadores das IAs |
| `bin/pipeline.mjs` | Comando `yarn pipeline` |
| `web/index.html` | Front em React sem build |
| `harness/` | Roteiro do agente, CLI do desk check (`deskcheck/`), trava (`guard/`) e como subir os MFEs (`mfe-local.md`) |
| `test/` | Testes com `node --test` |
| `.deskcheck/` | Saída de cada desk check (card, plano, prints, relatório, `run.json`). Fora do git |

## Requisitos

- Node 22+, Google Chrome e `gh` logado numa conta que acesse a organização configurada.
- `pipeline.config.json` preenchido (veja **Configuração**). Porta: `PORT` (4310). Agente padrão: `AGENT`.

## Configuração

Tudo o que é específico do seu time fica em `pipeline.config.json`, que não é versionado:

```sh
cp pipeline/pipeline.config.example.json pipeline/pipeline.config.json
```

| Chave | O que é |
|---|---|
| `azure.org`, `azure.project` | Organização e projeto do Azure DevOps onde estão os cards |
| `github.org`, `github.user` | Organização dos repositórios e, opcionalmente, a conta do `gh` a usar |
| `reposDir` | Pasta onde os repositórios ficam (são clonados sozinhos no primeiro desk check) |
| `repos[]` | Repositórios onde procurar o PR: `name`, `app`, `port` e, se houver, `kit` local |
| `repoPrefix` | Prefixo comum dos nomes, escondido na tela |
| `envs[]` | Ambientes de teste: `id`, `label`, `base` e as telas de usuários (`adminUsers`, `appUsers`) |
| `localGuide` | Caminho de um guia seu, fora do versionamento, de como subir a tela localmente |
| `zoneRole` | Papel que exige o campo de zonas na API de usuários, se houver |
| `agents[]` | Agentes de linha de comando que a esteira pode chamar (veja **Agentes**) |
| `allowInstallScripts` | `true` libera os scripts de instalação (`postinstall` etc.) do código do PR; por padrão ficam desligados |
| `translate` | `true` traduz para o português os textos do card que estiverem em inglês. **Envia esses textos a um serviço público de tradução**; por padrão fica desligado |
| `markFields[]` | Campos que o time preenche ao marcar o Desk Check no card (`label`, `ref`, `value`) |

## Em outra máquina

Não há instalação: o projeto é Node puro, sem dependências de npm.

1. Tenha Node 22+, Google Chrome, `gh` logado e pelo menos um agente de linha de comando instalado.
2. Copie o seu `pipeline.config.json` para `~/.config/deskcheck/` (vale para qualquer clone) ou para a pasta `pipeline/`, e rode `yarn` na raiz: ele confere o ambiente e diz o que falta.
3. Conecte a VPN, se os ambientes exigirem.
4. `yarn dev` (abre `http://localhost:4310`) ou `yarn start` (só sobe).

Ao subir, a esteira confere o ambiente e mostra no terminal e no topo da tela o que estiver faltando. Os repositórios são clonados sozinhos no primeiro desk check. O login do Azure DevOps e da aplicação é feito uma vez pelo botão **Login no Chrome**. Para conferir tudo, inclusive a sessão do Azure: `yarn doctor`.
