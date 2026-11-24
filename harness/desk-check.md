# Roteiro do desk check (vale para qualquer agente)

A esteira preenche os campos `{{...}}` e manda este texto para o agente escolhido. Quem fizer o desk check direto pelo chat segue o mesmo roteiro, trocando os campos pelos valores do card.

Faça o DESK CHECK do card {{id}} lendo `{{harness}}/deskcheck/SKILL.md` (seções 2 a 5) e `{{harness}}/deskcheck/references/plan-format.md`. Para subir a tela, siga `{{localGuide}}`.

## Contexto

- Card: {{type}} {{id}} · {{title}} · responsável {{assignee}}.
- Já lido: `{{dir}}/card.md` e `card.json` (critérios de aceite e Test Cases do Tested By).
- Código a testar: PR #{{pr}} ({{repo}}, branch {{branch}}, de {{author}}), já na worktree `{{worktree}}`.
- Modo de dados escolhido pelo usuário: **{{dataMode}}**. {{dataInstructions}}
- Ambiente alvo: **{{env}}** (`{{envBase}}`) · Usuários (administração geral): `{{adminUsersUrl}}` · Usuários do app: `{{appUsersUrl}}`.
- O PR pode cobrir mais de um card: teste só o que os Test Cases deste card pedem.
- CLI do desk check: `{{harness}}/bin/deskcheck` (sempre com `--root {{root}}`).
- Node: `export PATH={{node}}:$PATH` antes de node/npm/yarn.

## O que fazer

1. Instale as dependências na worktree **sem rodar scripts de instalação do pacote** (`yarn install --ignore-scripts` ou `npm ci --ignore-scripts`; a esteira já define isso no ambiente) e suba a tela respeitando o modo de dados escolhido (**dados reais** por padrão; **dados mockados** só quando o usuário selecionar essa opção). Se precisar de uma página de teste (harness), crie em `{{worktree}}/.local-harness/`, que já está fora do versionamento. Rode o servidor em segundo plano e derrube ao terminar.
2. **Se pedir login:** abra o Chrome visível para o usuário interagir rodando `{{harness}}/bin/deskcheck login --url <url>` (o CLI abre o navegador, espera o usuário fazer SSO/MFA e fechar a janela, salvando a sessão no perfil do deskcheck). Nunca peça senha ou token no chat e não use `--headless` quando houver chance de login.
3. **Troca automática de papéis/permissões em DEV e STG (quando os Test Cases exigirem papéis diferentes):**
   - Permitido **somente em DEV e STG** (`{{adminUsersUrl}}` e `{{appUsersUrl}}`), usando `--allow-writes` no `deskcheck run` apenas para esses ambientes. O motor barra na rede qualquer escrita que não vá para `localhost` ou para host de teste (`dev`, `stg`, `uat`...), então PRD nunca é alterado.
   - **Somente o usuário logado:** nunca altere cadastro de outro usuário.
   - **Use só os comandos do CLI, nunca a tela nem chamadas manuais à API** (Usuários do app: `{{appUsersUrl}}`):
     - trocar: `{{harness}}/bin/deskcheck role set {{id}} --url {{appUsersUrl}} --roles <papel> --root {{root}}` (faz o backup em `{{dir}}/user-original.json` sozinho na primeira troca e confere pela API que a troca valeu);
     - restaurar ao terminar: `{{harness}}/bin/deskcheck role restore {{id}} --root {{root}}` (confere que voltou idêntico ao backup);
     - conferir: `{{harness}}/bin/deskcheck role status {{id}} --root {{root}}`.
   - Depois de trocar o papel, rode os cenários daquele papel e só então troque para o próximo. Se você esquecer de restaurar ou a execução cair, a esteira restaura sozinha ao final.
   - A tela de administração geral (`{{adminUsersUrl}}`) ainda não tem troca automática: o que depender dela vai em `notTested`, com o motivo.
4. Escreva `{{dir}}/plan.json` com UM cenário por Test Case do Tested By (campo `"tc": [id]`), usando os passos Given/When/Then do TC. Não crie cenários para critérios sem TC: liste-os em `acWithoutTc` no resumo final. O que o TC pede e não dá para testar no ambiente vai em `notTestable`, com o motivo.
5. Rode: `{{harness}}/bin/deskcheck run --plan {{dir}}/plan.json --url <tela> --no-open --root {{root}}`
6. Olhe os prints em `{{dir}}/shots/` e registre o que viu com `{{harness}}/bin/deskcheck verdict ... --dir {{dir}}`.
7. **Mostre na imagem onde está o erro.** Para cada cenário com falha ou ressalva e para cada defeito, acrescente ao cenário um passo `{"do": "screenshot", "label": "...", "mark": [{"text": "...", "note": "..."}]}` apontando o elemento exato do problema (com `text`, `role`+`name`, `label` ou `selector`) e uma `note` curta **em inglês** dizendo o que está errado (o print pode virar evidência no Azure). Rode de novo só esses cenários com `--only S2,S5`: o print sai com uma caixa vermelha numerada e a explicação ao lado. Confira a imagem e informe o arquivo em `shot`, no cenário e no defeito. Quando uma verificação falha num elemento que existe, o print da falha já vem marcado sozinho.

## Regras absolutas

- Tudo o que pode ir para o Azure é em inglês: `title`, `steps`, `expected` e `actual` dos defeitos e as notas das marcações nos prints. `summary` e `notes` dos cenários aparecem só na tela e ficam em português.
- Quando o card for `[FRONT]` ou o escopo for somente frontend, ignore duplicidades ou inconsistências de dados vindas do backend/API: avalie comportamento visual, layout, permissões, estados e interações da tela.

- Você só APONTA defeitos do trabalho do colega. NÃO corrija nada: não edite nenhum arquivo do código (src, testes, configs, package.json). Só pode escrever em `{{dir}}/` e em `{{worktree}}/.local-harness/`.
- NÃO faça commit, push, PR nem comentário em PR.
- NÃO grave nada no Azure: nada de Defect, evidência, comentário, estado ou Desk Check. Os comandos `defect`, `evidence`, `mark` e `apply` do CLI estão bloqueados.
- `git`, `gh` e `az` passam por uma trava que recusa escrita (código 87). Não tente contornar.
- Se a tela não subir, diga o que falhou; não marque cenário como falho por problema de ambiente.

## Resposta final

Termine com um único bloco ```json. `verdict`: `approved` (aprovado), `approved-with-notes` (aprovado com ressalvas), `rejected` (reprovado) ou `incomplete` (incompleto).

```json
{"screen": "<url usada>", "verdict": "approved|approved-with-notes|rejected|incomplete",
 "summary": "<2 frases em português>",
 "scenarios": [{"id": "S1", "tc": 123, "status": "pass|fail|warn|blocked", "notes": "<o que viu, em português>", "shot": "<print marcado, se houver falha ou ressalva>"}],
 "defects": [{"title": "[FRONT] <título em inglês>", "scenario": "S2", "tc": 123, "steps": "<passos em inglês>", "expected": "<em inglês>", "actual": "<em inglês>", "shot": "S2-03-<print marcado>.png"}],
 "acWithoutTc": ["AC-3 ..."], "notTested": [{"ref": "TC 123", "reason": "<motivo, em português>"}]}
```
