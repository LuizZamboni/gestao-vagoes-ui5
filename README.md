# Gestão de Vagões: protótipo SAPUI5 / Fiori

Protótipo **somente front-end**, com dados mock, de um dashboard para gerenciar o carregamento de uma composição ferroviária. A tela mostra:

- a vistoria dos vagões;
- as bocas de descarga (silos e cones) e para qual vagão cada uma está descarregando;
- a carga de cada vagão e o total da composição;
- as validações pendentes e a liberação da fatura (NF).

- **Framework:** SAPUI5/OpenUI5 1.120+ (MVC, XML Views, componente com `manifest.json`)
- **Bibliotecas:** `sap.m`, `sap.f`, `sap.ui.layout`, `sap.ui.core` (todas disponíveis no OpenUI5)
- **Tema:** `sap_horizon_dark`, com alternância para `sap_horizon` pelo botão de paleta
- **Idioma:** pt-BR (`i18n/i18n.properties`)

## Stream de carregamento (dados reais)

A tela consome `GET {servidor}/GestaoCooperado/stream` (`Accept: text/event-stream`). Cada evento traz:

```json
{"VagaoId":"HTC-0002","PesoAtualKg":500.5,"Status":"Carregando","DataHora":"2026-11-12T13:20:42.6379277Z"}
```

**Onde colocar o servidor:** `webapp/manifest.json` → `sap.ui5` → `config` → `carregamentoStream` → `"servidor"`.

- Ex.: `"https://meuservidor:5001"`. Sem protocolo, assume `https://`.
- **Deixe vazio no S/4/BTP** e exponha `/GestaoCooperado/*` na mesma origem do Launchpad (destino/rota no approuter ou Web Dispatcher). Assim não há CORS e vale a autenticação do SAP.

| Campo | Uso |
|---|---|
| `servidor` | Só o endereço do servidor (vazio = mesma origem) |
| `caminho` | `/GestaoCooperado/stream` |
| `nomeEvento` | `message` (padrão SSE). Troque se o backend usar `event: nome` |
| `enviarCredenciais` | `true` só para outro domínio com cookie (exige CORS com origem explícita) |
| `modoDemonstracao` | `true` = simulação local, sem servidor (o `index-cdn.html`/Netlify já liga isso por meta tag) |
| `intervaloAtualizacaoTelaMs` | Frequência de atualização da tela (500 ms) |
| `segundosSemDadosParaAlerta` | Aviso de "sem atualização da balança" (15 s) |

**Como os dados entram:**

- `VagaoId` → vagão (campo `id` no `mockData.json`). Vagão desconhecido é incluído com aviso.
- `PesoAtualKg` → carga em t, repartida nas seções E/C/D pela receita.
- `Status` → status do vagão. O texto original fica disponível.
- `DataHora` → ordem dos eventos e vazão medida.
- `BocaId` *(opcional)* → liga a boca exata ao vagão. Sem ele, as bocas ligadas vão para o vagão em carga.

**Checklist do servidor/proxy:**

- `Content-Type: text/event-stream`, `Cache-Control: no-cache`.
- Sem buffering/compressão no proxy (nginx: `X-Accel-Buffering: no`).
- `: ping` a cada 15–30 s.
- Se for outro domínio, incluir em `connect-src` na CSP do Launchpad.

**Teste local:** `node test/servidor-sse-teste.js` e `"servidor": "http://localhost:8787"`.

**Segurança e performance:**

- Cada mensagem é validada (≤ 4 KB, `VagaoId` por regex, faixa de peso, texto saneado) e só são aceitas mensagens da origem configurada.
- URL só `http(s)`, sem usuário/senha. O servidor não pode ser trocado por parâmetro de URL.
- Limites: no máximo 60 vagões e 2.000 eventos no buffer.
- Eventos aplicados em lote a cada 500 ms; nada é processado com a aba oculta; a conexão fecha ao sair do app.
- Reconexão automática com espera crescente.

## Como rodar

```bash
npm install
npm start            # ui5 serve, abre http://localhost:8080/index.html
```

Para rodar sem o UI5 Tooling, sirva a pasta `webapp` com qualquer servidor estático e abra `index-cdn.html`, que carrega o UI5 do CDN público da SAP:

```bash
npx http-server webapp -p 8080
# http://localhost:8080/index-cdn.html
```

O arquivo `preview/gestao-vagoes-preview.html` é uma **prévia visual em HTML puro**, que abre com duplo clique. Ela reaproveita os mesmos módulos de regra, simulação, desenho da estação, CSS e i18n do projeto, mas **não** é o runtime UI5. Serve só para validar o layout com o time.

## Estrutura

```
webapp/
├── index.html / index-cdn.html     bootstrap (local / CDN)
├── manifest.json                   app descriptor, modelos i18n e mock
├── Component.js
├── view/
│   ├── Main.view.xml               DynamicPage: título, KPIs, estação, cards, validações, rodapé
│   └── BocaPopover.fragment.xml    operação da boca (comporta, destino, iniciar/parar)
├── controller/Main.controller.js   eventos de tela e orquestração
├── control/
│   ├── LoadingStation.js           controle UI5 custom: silos, cones, fluxo e composição
│   └── StationDom.js               desenho/atualização incremental do DOM da estação
├── model/
│   ├── mockData.json               dados de exemplo (substituir pelo backend)
│   ├── Regras.js                   regras de negócio + montagem do view model
│   └── Simulador.js                simulação da descarga + ações (substituir por OData)
├── i18n/i18n.properties
└── css/style.css                   estilos da estação (usa os parâmetros do tema SAP)
```

## Componentes da tela

| Área | Controles UI5 |
|---|---|
| Título e ações | `sap.f.DynamicPageTitle`, `ObjectStatus` (Ao vivo / Pausado / Faturada), `Button` |
| KPIs | `sap.f.DynamicPageHeader`, `ObjectNumber`, `ObjectStatus` |
| Estação de carregamento | `sap.f.Card` + `IconTabBar` com o controle custom `LoadingStation` (visual) e `sap.m.Table` (tabela de bocas) |
| Vistoria | `sap.f.Card`, `ObjectStatus` invertido, `core:Icon` por item do checklist |
| Detalhe do vagão | `SimpleForm` (ColumnLayout), `ProgressIndicator`, botões Concluir vistoria / Retirar excesso |
| Totais e fatura | `ObjectNumber`, `ProgressIndicator`, `SimpleForm`, botão Emitir fatura com `MessageBox.confirm` |
| Validações | `sap.m.List` com `StandardListItem` (highlight Error/Warning), `MessagePopover` no rodapé |
| Operação da boca | `ResponsivePopover` com `MessageStrip`, `ProgressIndicator`, `Slider` (comporta) e `Select` (destino) |

### Estação de carregamento (`control/LoadingStation.js`)

Cada **boca** aparece como um silo com cone de descarga, mostrando:

- nível do silo (% e toneladas) e a linha de nível mínimo;
- produto e umidade;
- abertura da comporta (%) e vazão atual (t/h);
- status (Ativa / Parada / Manutenção / Aguardando vagão / Silo vazio);
- vagão de destino e ETA para completar o vagão;
- alerta quando há manutenção, silo baixo ou produto divergente.

Uma **linha de fluxo animada** liga o cone ao vagão de destino. Quando a boca alimenta o vagão selecionado, a linha fica destacada; com produto divergente, ela fica vermelha.

Os **vagões** mostram carga/limite, % em formato de tremonha, vistoria (verde/vermelho), status e quais bocas descarregaram neles.

O controle **não se invalida** a cada atualização do modelo. O `StationDom` atualiza o DOM no lugar, para as animações não reiniciarem. Ele respeita `prefers-reduced-motion` e congela as animações quando a simulação é pausada.

Eventos: `wagonPress(index)` e `bocaPress(index, domRef)`.

## Regras implementadas (model/Regras.js)

- Vagão **não vistoriado** fica **Bloqueado** e nunca recebe carga.
- Status do vagão:
  - **Excesso** se a carga passa do limite (96 t);
  - **Carregando** se é destino de uma boca ativa;
  - **Carregado** a partir de 94% do limite;
  - **Parcial** se tem carga;
  - **Aguardando** nos demais casos.
- A carga-alvo é o limite menos a margem (0,4 t). Ao atingir a carga-alvo, as bocas seguem para o próximo vagão vistoriado e disponível. Sem vagão disponível, ficam em **Aguardando vagão**.
- Silo abaixo do nível mínimo (15%) gera aviso. Silo vazio para a boca.
- Validações:
  - **ERRO:** vagão sem vistoria, vagão acima do limite, boca com produto diferente do produto da composição.
  - **AVISO:** boca em manutenção, silo baixo/vazio, vagões aguardando carga.
- **Fatura** só é liberada com 0 erros e carga total maior que 0. Ao emitir, a NF é registrada, as bocas param e a simulação para.

## Para o desenvolvimento definitivo

1. **Dados:** trocar `mockData.json` por um `ODataModel` V4. Entidades sugeridas: `Composicao`, `Vagao` (com `Checklist`), `Boca`/`Silo` e `Fatura`. Mantenha `Regras.montarViewModel` (ou um JSONModel de tela) para preparar os campos derivados.
2. **Tempo real:** trocar o `setInterval` do controller por polling do backend ou por WebSocket (`sap/ui/core/ws/WebSocket`). Remover `Simulador.passo`.
3. **Ações:** cada função de `Simulador` (iniciar/parar boca, abertura da comporta, destino, concluir vistoria, retirar excesso, emitir fatura) vira uma *action* OData, com validação no backend.
4. **Regras de validação e fatura** devem ser autoritativas no backend. No front ficam só como feedback imediato.
5. **Textos de status** já vêm do i18n. Novos idiomas: `i18n_en.properties` etc. e ajustar `supportedLocales`.
6. **Fiori Launchpad:** a app já tem `sap.app.id` e `manifest.json` prontos. Falta configurar `crossNavigation`/inbound e o deploy (`ui5 build` + deploy para ABAP/BTP).

> Todos os números, IDs de vagões (HFE …), OS e NF são dados fictícios de exemplo.
