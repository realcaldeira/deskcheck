# Formato do `plan.json`

```json
{
  "workItem": 10042,
  "title": "Status filter on partner list",
  "baseUrl": "http://localhost:3000",
  "viewport": { "width": 1440, "height": 900 },
  "beforeEach": [{ "do": "goto", "url": "/partners?role=reviewer" }],
  "scenarios": [
    {
      "id": "S1",
      "title": "Lista abre em All Status",
      "tc": [10201],
      "ac": ["AC-1"],
      "expected": "O filtro de status abre em All Status e lista todos os itens.",
      "steps": [
        { "do": "expectText", "text": "Pending for final review" },
        { "do": "expectValue", "label": "Filter by status", "value": "All Status" },
        { "do": "screenshot", "label": "Lista inicial" }
      ]
    }
  ]
}
```

- `baseUrl`: usado pelos `goto` relativos. `--url` no `run` tem precedência sobre ele.
- `viewport`: o padrão é 1440×900. Pode ser definido por cenário, e `--width/--height` tem precedência.
- `beforeEach`: passos rodados antes de cada cenário. Cada cenário abre numa aba nova do mesmo Chrome, então cookies e localStorage do domínio continuam.
- Cenário:
  - campos obrigatórios: `id` (único) e `title`;
  - campos opcionais: `ac`, `tc`, `expected`, `note`, `viewport`, `reference` e `finalShot: false` (sem o print automático, que só sai quando o cenário não tira nenhum).
  - `reference`: imagem de referência (ex.: frame do Figma) mostrada lado a lado com o print da tela no relatório. Aceita um caminho (relativo ao plan.json), `{ "file": "figma.png", "label": "Figma: lista" }` ou uma lista deles.
- `notTestable` (no topo do plano): `[{ "ref": "AC-3", "reason": "Cadastro no CMS, fora do escopo" }, { "ref": "TC 10209", "reason": "..." }]`. Na matriz de cobertura do relatório, o critério ou TC aparece como "Não testável", com o motivo.

## Como achar um elemento (`click`, `fill`, `hover`, `expect*` …)

Use uma destas formas. Elas podem ser combinadas com `index` (a n-ésima ocorrência visível, começando em 0), `exact: true` e `within` (seletor CSS do contêiner):

| Campo | Exemplo | Acha |
|---|---|---|
| `role` + `name` | `{ "role": "button", "name": "Apply" }` | Papel ARIA (explícito ou implícito: button, link, textbox, checkbox, radio, combobox, tab, option, heading, row, cell, dialog…) e nome acessível (aria-label, aria-labelledby, label, texto). |
| `label` | `{ "label": "Filter by status" }` | Campo pelo rótulo, aria-label ou placeholder. |
| `text` | `{ "text": "Pending my actions" }` | O elemento mais interno com esse texto visível. No `click`, sobe até o elemento clicável. |
| `placeholder` | `{ "placeholder": "Search partner" }` | Campo pelo placeholder. |
| `selector` | `{ "selector": "[data-testid=row]", "text": "Alpha" }` | Seletor CSS (só estável), com filtro de texto opcional. |

Só elementos visíveis contam. O texto não diferencia maiúsculas de minúsculas e ignora espaços extras. Sem `exact`, basta conter o texto.

## Ações (`"do"`)

| Ação | Campos | O que faz |
|---|---|---|
| `goto` | `url` | Abre a URL (relativa ao `baseUrl`) e espera a rede e o DOM assentarem. |
| `reload` | — | Recarrega. |
| `viewport` | `width`, `height`, `mobile?` | Muda o tamanho da tela. |
| `click` / `dblclick` | localizador | Clica com o mouse de verdade no centro do elemento. Falha se o elemento estiver coberto (modal, overlay). |
| `hover` | localizador | Passa o mouse. |
| `fill` | localizador, `value`, `enter?` | Foca, seleciona o conteúdo e digita (`value: ""` apaga). |
| `select` | localizador, `value` (texto ou value da opção) | Só para `<select>` nativo. |
| `check` | localizador, `value` (true/false) | Marca ou desmarca o checkbox ou radio. |
| `press` | `key` | `Enter`, `Tab`, `Escape`, `ArrowDown`, `Space`, `Backspace`… (vários separados por espaço). |
| `scroll` | localizador ou `x`/`y` | Rola até o elemento ou até a posição. |
| `wait` | `ms`, ou localizador, ou `gone: "texto"` | Espera um tempo, um elemento aparecer ou um texto sumir (`timeout` padrão de 15 s). |
| `eval` | `expr` ou `script`, `save?` | Roda JS na página (preparar estado, localStorage). Não é asserção. Com `save: "tela.json"`, grava o valor inteiro na pasta do relatório (bom para explorar a tela antes de escrever o plano). |
| `upload` | localizador (opcional), `file` ou `files` | Envia um ou mais arquivos para `<input type="file">` (mesmo se estiver oculto atrás de um label/botão). Caminhos relativos ao `plan.json`. |
| `dialog` | `action` (`accept` ou `dismiss`), `promptText?` | Define como responder ao próximo `alert`, `confirm` ou `prompt` nativo (sem este passo, diálogos são aceitos automaticamente para não travar a execução). |
| `screenshot` | `label`, `fullPage?` | Print de evidência. |
| `expectText` | `text`, `within?`, `exact?` | O texto aparece. |
| `expectNoText` | `text`, `within?` | O texto não aparece (espera 1,5 s). |
| `expectVisible` / `expectHidden` | localizador | O elemento está ou não está visível. |
| `expectUrl` | `contains` ou `match` (regex) | Confere o endereço atual. |
| `expectCount` | localizador, `count` ou `min`/`max` | Quantidade de elementos visíveis. |
| `expectValue` | localizador, `value` | O valor do campo (ou o texto do elemento). |
| `expectEval` | `expr` ou `script` | Passa quando devolve `true` ou `{ ok: true }`. Devolva `{ ok: false, message }` para explicar a falha. |
| `expectRequest` | `method?`, `urlContains?` ou `urlMatch?`, `status?` (`200`, `2xx`, `ok`), `minCount?` | Confirma que a tela disparou a requisição XHR/Fetch esperada (contrato front↔back). |

Campos que valem em qualquer passo:
- `timeout` em ms: o padrão é 6 s para `expect*` e 8 s para ações.
- `optional: true`: se falhar, vira ressalva e o cenário segue.
- `shot: "rótulo"`: tira um print depois do passo.
- `desc`: texto do passo no relatório e no Defect. Escreva em inglês se o passo for virar Defect.
- `settle` em ms: espera máxima pela rede depois de cliques e preenchimentos.

Na primeira falha, o cenário para, tira um print `…-falha-…` e marca os passos seguintes como não executados.

## Resultado (`results.json`)

Por cenário, o arquivo guarda:
- `status` automático e `verdict` (o seu, depois de revisar os prints; `null` mantém o automático);
- `note`;
- `steps` (cada um com `status`, `error` e `shot`);
- `shots`;
- `console` (exceções e `console.error`);
- `network` (4xx/5xx e falhas);
- `defects` (preenchido pelo `apply` do Defect).

Para registrar veredito e observação, use `deskcheck verdict <cenário> --status pass|warn|fail|blocked|auto --note "..."`: o relatório é regerado na hora. Também dá para editar o arquivo e rodar `deskcheck report`.
