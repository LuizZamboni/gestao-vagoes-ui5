/**
 * Servidor SSE de TESTE que imita GET /GestaoCooperado/stream.
 * Igual à API de teste: um único VagaoId, com o peso subindo 500,5 kg a cada 0,5 s,
 * sem parar. A tela enche o vagão até 100% e abre o próximo (transbordo automático).
 *
 * Uso:  node test/servidor-sse-teste.js              (porta 8787)
 *       node test/servidor-sse-teste.js --reiniciar  (zera o peso ao chegar em 96 t,
 *                                                     para testar a balança reiniciando)
 * No manifest.json, para testar: "servidor": "http://localhost:8787"
 * (o app precisa estar em http://localhost:8080 - CORS liberado abaixo só para teste)
 */
const http = require("http");
const bReiniciarAoEncher = process.argv.includes("--reiniciar");
let fPesoKg = 0;

http.createServer(function (oRequisicao, oResposta) {
	if (!oRequisicao.url.startsWith("/GestaoCooperado/stream")) {
		oResposta.writeHead(404);
		return oResposta.end();
	}
	oResposta.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		"Connection": "keep-alive",
		"X-Accel-Buffering": "no",
		"Access-Control-Allow-Origin": "http://localhost:8080"
	});
	oResposta.write("retry: 3000\n\n");

	const iTimerEventos = setInterval(function () {
		fPesoKg = bReiniciarAoEncher && fPesoKg >= 95600 ? 0 : Math.round((fPesoKg + 500.5) * 10) / 10;
		const oEvento = { VagaoId: "HTC-0002", PesoAtualKg: fPesoKg, Status: "Carregando", DataHora: new Date().toISOString() };
		oResposta.write("data: " + JSON.stringify(oEvento) + "\n\n");
	}, 500);
	const iTimerPing = setInterval(function () { oResposta.write(": ping\n\n"); }, 20000);

	oRequisicao.on("close", function () {
		clearInterval(iTimerEventos);
		clearInterval(iTimerPing);
	});
}).listen(8787, function () { console.log("SSE de teste em http://localhost:8787/GestaoCooperado/stream"); });
