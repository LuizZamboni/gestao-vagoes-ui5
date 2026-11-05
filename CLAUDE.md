# CLAUDE.md: Gestão de Vagões (SAPUI5)

Dashboard **somente front-end, com dados mock** para acompanhar o carregamento e o faturamento de uma composição ferroviária. Foi pensado para ficar **numa TV**: uma única tela, sem rolagem, com tudo visível ao abrir. O destino final é o **SAP Fiori Launchpad no S/4**, publicado como aplicação BSP. Hoje também roda no Netlify, para demonstração.

> O `README.md` está **desatualizado** (fala de DynamicPage, abas, tabela de bocas, botão de tema e vistoria). Para saber como o projeto está hoje, vale este arquivo.

## Comandos

```bash
npm install
npm start                      # ui5 serve → http://localhost:8080/index.html
npx ui5 serve --port 8080      # mesmo servidor, sem abrir o navegador
npm run build                  # build em dist/ (use para checar se não há erro)
npm run deploy                 # build + deploy BSP no S/4 (ui5-deploy.yaml)
npm run undeploy
```

- Node 24 e `@ui5/cli` v4 (`specVersion: "4.0"`). Framework **SAPUI5 1.120.0**, definido no `ui5.yaml`.
- Depois de mudar bibliotecas ou framework no `ui5.yaml`, **reinicie o `ui5 serve`**.
- Não há testes automatizados. Para validar, rode o build e tire prints headless:
  ```bash
  "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --disable-gpu \
    --hide-scrollbars --window-size=1920,1080 --virtual-time-budget=8000 \
    --screenshot="<scratchpad>/tela.png" "http://localhost:8080/index.html"
  ```
  O headless tem largura mínima de cerca de 492px, então prints mais estreitos saem cortados. Confira 1920×1080, 1366×768 e o modo empilhado (por exemplo, 600×1600).

## Ambientes

| Ambiente | Entrada | Como o UI5 é carregado |
|---|---|---|
| Local | `webapp/index.html` | `resources/` do `ui5 serve` |
| Netlify | `webapp/index-cdn.html` | CDN `https://ui5.sap.com/1.120.50/` (a 1.120.0 não tem mais os temas no CDN) |
| Fiori Launchpad (S/4) | `Component.js` + `manifest.json` (o `index.html` é ignorado) | runtime do Launchpad |

- **Netlify** (`netlify.toml`): publica a pasta `webapp`, sem build. Redireciona `/` e `/index.html` para `/index-cdn.html` com `force = true`; sem o `force`, o Netlify serve o `index.html` local e a tela fica em branco. Cada push na `main` publica sozinho.
- **Git:** `https://github.com/LuizZamboni/gestao-vagoes-ui5` (privado), branch `main`. Commits com `user.email=zambonioficial@gmail.com`. O usuário pede explicitamente quando quer enviar para o git; **não faça push sem pedido**.
- **Deploy no S/4** (`ui5-deploy.yaml`): os valores ainda são de exemplo (`SEU-S4-HOST`, `ZPACOTE`, `DEVK900000`; BSP `ZGESTAO_VAGOES`). Nunca grave senha no arquivo.
- **Launchpad:**
  - o `manifest.json` tem `sap.ui.fullWidth = true` e o inbound `Vagao-display`;
  - o `Component.js` esconde a barra do shell enquanto o app está aberto (`setHeaderVisibility(false, true, ["app"])`). Se não funcionar, a alternativa é a URL com `?sap-ushell-config=headerless`;
  - o CSS **não pode** alterar `html`/`body`, para não afetar o shell.
- Os dois `index*.html` usam `data-sap-ui-compat-version="edge"` (necessário para expression binding), `data-height="100%"` no container e tema `sap_horizon_dark`.

## Estrutura

```
webapp/
├── index.html / index-cdn.html   bootstrap local / CDN
├── manifest.json                 descriptor, i18n, modelo "mock", inbound Vagao-display, fullWidth
├── Component.js                  esconde a barra do Launchpad
├── view/Main.view.xml            layout de TV (grid CSS com FlexBox renderType="Bare")
├── view/BocaPopover.fragment.xml operar a boca (comporta, destino, iniciar/parar)
├── controller/Main.controller.js tick da simulação, foco automático, seleção, popover
├── control/LoadingStation.js     controle UI5 custom (wrapper; setters sem invalidar)
├── control/StationDom.js         desenho da estação em DOM puro (silos, fluxo, trem)
├── model/mockData.json           composição, receitas, vagões (placa), 3 bocas, fatura
├── model/Regras.js               regras de negócio + montagem do view model (puro)
├── model/Simulador.js            simulação da descarga e ações (estado imutável)
├── i18n/i18n.properties          textos pt-BR
└── css/style.css                 todo o visual
preview/gestao-vagoes-preview.html  prévia antiga em HTML puro (desatualizada)
```

## Arquitetura e fluxo de dados

1. O `Main.controller` carrega `mockData.json` (modelo `mock`) e cria o estado com `Simulador.estadoInicial`.
2. A cada `INTERVALO_MS` (1 s), roda `Simulador.passo(state)`, que devolve um novo estado, e depois `_publicar()`.
3. O `_publicar()` chama `_seguirCarregamento()` (foco automático) e `Regras.montarViewModel(state, ui, t)`, e o resultado entra num `JSONModel` em modo **OneWay** (`setData`).
4. As ações da tela passam por `_executar(Simulador.acao, ...)`. A view nunca escreve direto no modelo.
5. Na implementação definitiva, `passo()` vira polling/WebSocket do backend, as ações viram chamadas OData, e as regras de validação e fatura vão para o backend.

`Regras.js` é **puro** (sem dependência de controles UI5), e todos os textos vêm de `t(chave, args)`, ligado ao i18n.

## Regras de negócio (resumo)

- **Receita por material** (`receitas` no mock): define a `vazao` da boca em t/h e a `distribuicao` em % para `esquerda`, `centro` e `direita` do vagão. A composição atual é de **Farelo de soja** (`REC-FS-01`: 600 t/h, 30/40/30).
- **Vazão da boca** = vazão da receita do material × `abertura`/100, com um ruído de ±30 na simulação.
- **Vagão:**
  - guarda `carga` (total) e `secoes {esquerda, centro, direita}`; cada descarga é repartida pela receita da boca;
  - **meta por seção** = limite × % da receita;
  - limite de 96 t e alvo = limite − `margemAlvo`.
- **Status do vagão:** `bloqueado` (não vistoriado), `excesso`, `carregando`, `carregado` (≥ 94% do limite), `parcial`, `aguardando`.
- **Status da boca:** `ativa`, `parada`, `aguardandoVagao`, `siloVazio`. **Não existe "manutenção"**: o usuário pediu para remover.
- **Vistoria:** o dashboard só **mostra** o resultado. A conclusão da vistoria foi removida de propósito.
- **Validações:**
  - **erros** (bloqueiam a fatura): vagão sem vistoria, vagão acima do limite, produto divergente;
  - **avisos**: silo baixo, silo vazio, vagões aguardando carga.
- **Fatura:** pode ser emitida quando não há erros e já existe carga. **Não há botão de emitir nem de pausar** na tela (foram removidos); o painel só mostra o status.
- **Velocidade da simulação:** `FATOR` em `Simulador.js`, onde toneladas por tick = vazão/FATOR. **3600 = tempo real**; está em **1800**.

## Tela (layout de TV)

A grade CSS fica em `.vgTv`: cabeçalho, linha de receita + indicadores, e a linha principal com 3 colunas.

- **Cabeçalho:** título da composição, linha de informações, pílula "Ao vivo" e relógio. Sem botões.
- **Receita** (destaque à esquerda): material, código, vazão por boca e barra E/C/D com a meta por vagão.
- **Indicadores** num **único painel com divisórias**: vazão total, carregado, vagões vistoriados e previsão de término.
- **Lateral esquerda (vagões):**
  - "Vagão em foco": placa grande, carga com barra, 3 mini-tanques E/C/D (carga/meta), término, bocas, vistoria e checklist;
  - "Composição": os 8 vagões com ponto de status, placa, barra e carga. Clicar seleciona o vagão.
- **Centro:** estação (`LoadingStation`).
- **Lateral direita (faturamento):**
  - painel de **fatura em destaque**, que muda de cor por status (`data-st`: bloqueada, pronta ou emitida) e mostra motivo, peso a faturar e vagões faturados;
  - "Pendências" logo abaixo.
- **Foco automático:** o painel segue o vagão em carga. Depois de uma seleção manual, volta a seguir após `MANUAL_MS` (20 s), no controller.
- **Placas:** campo `placa` em cada vagão (por exemplo, "HFE 719155-1"), com visual de placa metálica (`.vgPlate`, `.vgWag__plate`).

### Estação (`StationDom.js`)

- Tem geometria fixa em px (objeto `G`) e é **escalada para caber** no espaço (`_fit`, com `ResizeObserver`), sempre centralizada.
- Mostra **3 bocas**: silos com nível, cone, comporta, vazão e linhas de fluxo SVG animadas até o vagão de destino.
- **Janela do trem:** mostra `SLOTS = 5` posições (a locomotiva é a posição 0), centradas no vagão selecionado, com animação de deslize. As setas ‹ › mostram quantos vagões estão escondidos; há um mini-mapa clicável. A navegação manual expira em `NAV_MS` (20 s).
- O vagão desenha o funil com **3 seções** (E/C/D) e a placa.
- Atualiza o DOM **no lugar**, sem re-renderizar, para que as animações não reiniciem. O `LoadingStation` sobrescreve os setters com `setProperty(..., true)` e agrupa as atualizações num microtask.

## CSS e responsividade (importante)

- **`class` não aceita binding** no XML do UI5. Para estilo por estado use `<customData><core:CustomData key="st" value="{...}" writeToDom="true"/></customData>`, que gera `data-st="..."`, e no CSS `[data-st="Error"]` etc.
- As **variáveis CSS do tema SAP** (`--sapBrandColor`, `--sapTextColor`, ...) **nem sempre são publicadas** na 1.120. Use sempre **com valor de reserva** (`var(--sapX, #fallback)`); sem isso, bordas e barras somem.
- **Escala:**
  - a view raiz tem `class="vgApp"`, que é um *size container* (`container: vgapp / size`);
  - a unidade `--vg-r` vem do tamanho do **app** (`cqw`/`cqh`), não da janela, e todo o CSS do layout usa `calc(X * var(--vg-r))` no lugar de `rem`;
  - isso mantém a mesma composição em 720p, 1080p e 4K, sem mexer em `html`/`body`.
- **Quebras de layout** via `@container vgapp (max-width: 1099px) or (orientation: portrait)`: coluna única com rolagem (tablet e celular).
- `FlexBox renderType="Bare"` é usado para montar o grid sem wrappers.
- O tema claro (`sap_horizon`) tem ajustes em `.sapUiTheme-sap_horizon ...`.

## Preferências do usuário

- Escreve em pt-BR informal; responda em pt-BR.
- Visual para TV: minimalista, informação legível de longe, nada fora da tela, sem rolagem.
- Gostou da animação das bocas e do fluxo de grão; mantenha-a.
- Não gostou do painel "No turno" (removido).
- Uma tentativa de trocar os painéis por controles Fiori padrão (`sap.f.Card`, `NumericContent`, microcharts) **foi revertida a pedido**. Não refaça sem pedido.
- Ver os resultados no navegador: subir `ui5 serve` e abrir `http://localhost:8080/index.html`.
