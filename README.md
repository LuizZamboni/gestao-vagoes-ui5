# Gestão de Vagões (SAPUI5 / Fiori)

Dashboard de TV para acompanhar o carregamento e o **faturamento por vagão** de uma composição ferroviária, com a estação de carregamento em **3D interativo**.

- **Demonstração:** publicada pelo Netlify a cada push na `main` (abre no modo automático).
- **Destino:** SAP Fiori Launchpad no S/4 (aplicação BSP).

## Rodar

```bash
npm install
npm start     # http://localhost:8080/index.html
npm test      # testes das regras (Node, sem UI5)
```

## Fontes de eventos

| Fonte | O que faz |
|---|---|
| **Automático** | a própria tela gera o enchimento (teste e demonstração, sem servidor) |
| **Stream** | recebe `GET {servidor}/GestaoCooperado/stream` (`Accept: text/event-stream`) |

O servidor é informado em um único lugar: `webapp/manifest.json` > `sap.ui5` > `config` > `carregamentoStream` > `servidor` (vazio = mesma origem). No mesmo bloco ficam `fonteInicial`, `transbordoAutomatico`, `limiteVagoes` e a velocidade do modo automático.

Formato do evento:

```json
{"VagaoId":"HTC-0002","PesoAtualKg":500.5,"Status":"Carregando","DataHora":"2026-11-12T13:20:42.6379277Z"}
```

Para testar o stream sem o servidor real: `node test/servidor-sse-teste.js` e `"servidor": "http://localhost:8787"`.

## Regras principais

- Cada vagão enche até **100%** da capacidade; ao encher, o próximo é criado. Os vagões só param de surgir quando os eventos param.
- **Faturamento por vagão:** libera quando o vagão enche; vistoria reprovada ou excesso de peso bloqueiam.
- **Parar / Iniciar / Reiniciar** no cabeçalho.

Arquitetura, regras completas e padrões de código: veja [`CLAUDE.md`](CLAUDE.md).
