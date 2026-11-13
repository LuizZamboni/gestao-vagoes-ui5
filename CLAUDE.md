# CLAUDE.md: Gestão de Vagões (SAPUI5)

Dashboard **front-end** para acompanhar o carregamento e o **faturamento por vagão** de uma composição ferroviária. Foi pensado para ficar **numa TV**: uma única tela, sem rolagem. O destino final é o **SAP Fiori Launchpad no S/4** (aplicação BSP). Também roda no Netlify, para demonstração.

A estação de carregamento é **3D e interativa** (CSS 3D, sem bibliotecas externas).

## Comandos

```bash
npm install
npm start                      # ui5 serve → http://localhost:8080/index.html
npm test                       # testes das regras em Node (sem UI5)
npm run build                  # build em dist/
npm run deploy                 # build + deploy BSP no S/4 (ui5-deploy.yaml)
node test/servidor-sse-teste.js   # servidor SSE de teste (porta 8787)
```

- Node 24 e `@ui5/cli` v4 (`specVersion: "4.0"`). Framework **SAPUI5 1.120.0** (`ui5.yaml`).
- `npm test` cobre só as regras (model/). A tela precisa ser conferida no navegador (1920×1080, 1366×768 e celular).

## Ambientes

| Ambiente | Entrada | UI5 | Fonte de eventos ao abrir |
|---|---|---|---|
| Local | `webapp/index.html` | `ui5 serve` | `fonteInicial` do manifest (stream) |
| Netlify | `webapp/index-cdn.html` | CDN `https://ui5.sap.com/1.120.50/` | **automático** (meta tag `vagoes-modo-demonstracao`) |
| Fiori Launchpad (S/4) | `Component.js` + `manifest.json` | runtime do Launchpad | `fonteInicial` do manifest |

- **Netlify** (`netlify.toml`): publica a pasta `webapp`, sem build; `/` redireciona para `/index-cdn.html` com `force = true`. Cada push na `main` publica sozinho.
- **Git:** `https://github.com/LuizZamboni/gestao-vagoes-ui5`, branch `main`. Commits com `user.email=zambonioficial@gmail.com`. O usuário pediu que **toda alteração pedida já seja commitada e enviada** para a `main` (pode dar push sem perguntar).
- **Deploy no S/4** (`ui5-deploy.yaml`): valores ainda de exemplo. Nunca grave senha no arquivo.
- **Launchpad:** `sap.ui.fullWidth = true`, inbound `Vagao-display`; o `Component.js` esconde a barra do shell. O CSS **não pode** alterar `html`/`body`.

## Estrutura

```
webapp/
├── manifest.json                 configuração (carregamentoStream), modelos, CSS
├── view/Main.view.xml            layout de TV; só mostra o modelo de tela
├── view/BocaPopover.fragment.xml popover da boca (ligar/desligar, comporta)
├── controller/Main.controller.js fonte de eventos → estado → modelo de tela; handlers on...
├── control/Estacao3D.js          controle UI5 (casca): propriedades e eventos
├── control/estacao3d/Cena3D.js   monta e atualiza a cena 3D
├── control/estacao3d/Camera3D.js girar, zoom, vistas (3D/Frente/Topo), giro automático
├── control/estacao3d/Dom.js      utilitários de DOM (sem innerHTML) e caixas 3D
├── model/Regras.js               regras puras (cheio, status, situação da fatura...)
├── model/Carregamento.js         estado + aplicar eventos (transbordo, vazão, silos)
├── model/Faturamento.js          faturar vagão / faturar liberados
├── model/ModeloTela.js           estado → textos e valores da view (puro)
├── model/Formatador.js           números, horas e durações em pt-BR
├── model/stream/EventoCarregamento.js      valida e normaliza cada mensagem
├── model/stream/CarregamentoStream.js      cliente SSE (EventSource + reconexão)
├── model/stream/CarregamentoAutomatico.js  gerador local (modo automático)
├── model/mockData.json           composição, receita, cadastro de vagões, bocas
├── i18n/i18n.properties          textos pt-BR
└── css/style.css, css/estacao3d.css
test/  regras.test.js (npm test), carregar.js, servidor-sse-teste.js
```

## Fluxo de dados

`fonte de eventos → fila → Carregamento.aplicarEventos → ModeloTela.montar → JSONModel (OneWay) → view`

1. **Fonte** (uma por vez, mesma interface `iniciar/parar` e mesmos callbacks):
   - **Automático** (`CarregamentoAutomatico`): gera eventos no formato da API, um vagão por vez, fechando em exatamente 100% e abrindo o próximo. A vazão segue as bocas ligadas e a abertura das comportas.
   - **Stream** (`CarregamentoStream`): `GET {servidor}/GestaoCooperado/stream`, `Accept: text/event-stream`. Evento: `{"VagaoId":"HTC-0002","PesoAtualKg":500.5,"Status":"Carregando","DataHora":"...Z"}` (`BocaId` opcional).
2. O controller põe os eventos numa **fila** e a aplica a cada `intervaloAtualizacaoTelaMs`. Com a aba oculta a fila espera (e é compactada).
3. O estado é **imutável**: cada função devolve um estado novo.
4. A view **não calcula nada**; toda ação do usuário passa por um handler `on...` do controller.

### Configuração (único lugar): `manifest.json` > `sap.ui5/config/carregamentoStream`

| Chave | Padrão | Para quê |
|---|---|---|
| `servidor` | `""` | host do stream; vazio = mesma origem (recomendado no S/4/BTP) |
| `caminho`, `nomeEvento`, `enviarCredenciais` | | detalhes da conexão SSE |
| `fonteInicial` | `"stream"` | `"stream"` ou `"automatico"` |
| `transbordoAutomatico` | `true` | peso acima da capacidade passa para o próximo vagão (ver regras) |
| `limiteVagoes` | `2000` | proteção de memória |
| `intervaloAtualizacaoTelaMs` | `500` | frequência de atualização da tela |
| `segundosSemDadosParaAlerta` | `15` | alerta "sem leitura" |
| `automatico.aceleracao` | `4` | velocidade do modo automático (1 = tempo real, máx. 40) |
| `automatico.intervaloMs` | `500` | intervalo entre eventos gerados |

## Regras de negócio

- **Vagão enche até 100%** da capacidade (`composicao.capacidadeVagaoKg`, 96 t). O percentual só mostra 100 quando está cheio de fato.
- **Novos vagões** são criados pelos eventos e só param de surgir quando os eventos param:
  - `VagaoId` novo → vagão novo;
  - **transbordo automático** (ligado): o emissor de teste manda um único `VagaoId` com peso crescente; o que passa da capacidade vai para vagões criados em sequência (`HTC-0002`, `HTC-0002 #2`, ...). Desligado (produção com um id por vagão): o excesso vira erro "excesso" e bloqueia a fatura;
  - peso caindo para menos da metade = balança reiniciou → novo ciclo, novo vagão;
  - eventos fora de ordem são ignorados; vagão faturado não muda mais.
- **Faturamento é por vagão** (`Regras.situacaoFaturamento`):
  - `aguardando` até encher; `liberado` quando cheio (ou status do sistema Carregado/Finalizado);
  - `bloqueado` por vistoria reprovada ou excesso de peso; vistoria **não informada** não bloqueia (vira aviso);
  - `faturado` após "Faturar" (por vagão ou "Faturar os N liberados"). A NF é sequencial (`faturamento` no mock). Pontos de integração marcados com `TODO integração`.
- **Iniciar / Parar / Reiniciar** (cabeçalho): Parar interrompe a fonte e mantém a tela; Iniciar retoma de onde parou; Reiniciar zera a composição. Trocar Automático ↔ Stream também zera.
- **Receita** (`receitas` no mock): vazão total da estação e distribuição E/C/D. Vazão nominal por boca = vazão ÷ bocas com o material.
- **Bocas:** ligar/desligar e abertura da comporta (popover). Status: descarregando, aguardando vagão, comporta fechada, desligada, silo vazio. **Não existe "manutenção"**.
- **Silos:** o nível só é consumido/reabastecido no modo automático (no stream a API não informa estoque).
- **Vazão medida** = Δpeso/Δtempo dos eventos (média móvel).

## Tela (layout de TV)

Grade em `.vgTv`: cabeçalho, receita + indicadores, e três colunas.

- **Cabeçalho:** título, seletor **Automático | Stream**, **Iniciar/Parar**, **Reiniciar**, tema, pílula de situação, relógio.
- **Indicadores:** vazão medida, total carregado, vagões cheios, vagão atual enche em.
- **Esquerda:** vagão em foco (placa, carga, seções E/C/D, vistoria, fatura) e a composição (últimos 6 vagões).
- **Centro:** `Estacao3D`.
- **Direita:** faturamento por vagão (situação do vagão em foco, botão Faturar, totais, fila) e pendências.
- **Foco automático:** segue o vagão em carga; após seleção manual volta a seguir em 20 s (ou pelo botão "Seguir carga").
- O modelo de tela tem tamanho limitado (lista 6, fila 5, estação só os vagões vizinhos), mesmo com centenas de vagões.

### Estação 3D (`control/estacao3d/`)

- HTML + **CSS 3D** (transform), sem WebGL nem biblioteca: funciona no Launchpad sem dependências e com CSP.
- Interação: arrastar gira, roda/pinça aproxima, vistas 3D/Frente/Topo, "Girar" (balanço automático), clique em vagão seleciona, clique em silo abre o popover, setas ‹ › navegam.
- O pórtico é fixo; o **trem desliza** quando a carga passa para o vagão seguinte. A câmera se desloca até o vagão selecionado.
- Atualiza o DOM **no lugar** (sem re-render do UI5): os setters do controle usam `setProperty(..., true)` e juntam as mudanças numa microtarefa.
- **Regra do CSS 3D:** elementos de grupo (`transform-style: preserve-3d`) não podem ter `opacity`, `filter`, `overflow`, `clip-path` nem `mask`: isso achata o 3D. Esses efeitos só nas faces.
- Não transforme `.vgE3` em container query: `--vg-r` usa `cqw/cqh` e mudaria de valor lá dentro.
- Textos vindos de eventos entram por `textContent` (nunca `innerHTML`).

## CSS e responsividade

- **`class` não aceita binding** no XML: use `CustomData` com `writeToDom` (`data-st="..."`) e trate no CSS.
- Variáveis do tema SAP sempre **com valor de reserva** (`var(--sapX, #fallback)`).
- **Escala:** `.vgApp` é *size container*; a unidade `--vg-r` vem do tamanho do app. Use `calc(X * var(--vg-r))`, não `rem`.
- **Botões:** `sap.m.Button` com a classe `vgBtn` (tamanho segue `--vg-r`).
- **Telas estreitas/retrato:** `@container vgapp (max-width: 1099px) or (orientation: portrait)` → coluna única com rolagem. `.vgCenter` usa `aspect-ratio` e a estação fica em `position: absolute` (no Safari do iPhone, `height: 100%` ali vira 0).
- **Tema:** escuro por padrão; o botão alterna para `sap_horizon` e salva em `localStorage` (`vagoes.dashboard.tema`). O tema claro usa **cinza suave** fixo (o usuário achou o branco forte demais).

## Padrões de código

- Nomes em português, descritivos, com o prefixo UI5: `o` objeto, `a` array, `s` string, `i` inteiro, `f` decimal, `b` booleano, `fn` função, `p` Promise, `m` mapa.
- Toda função tem comentário explicando o que faz. Handlers de evento começam com `on`.
- Regras em módulos **puros** (sem controles UI5), testáveis com `npm test`.
- Textos só no `i18n`.

## Preferências do usuário

- Escreve em pt-BR informal; responda em pt-BR.
- Visual para TV: minimalista, legível de longe, nada fora da tela, sem rolagem.
- Gosta das animações das bocas e do fluxo de grão; mantenha.
- Uma tentativa de trocar os painéis por controles Fiori padrão (`sap.f.Card`, microcharts) **foi revertida a pedido**. Não refaça sem pedido.
