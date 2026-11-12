/**
 * CarregamentoStream
 * ------------------------------------------------------------------
 * Cliente do stream SSE (Server-Sent Events) de carregamento de vagões.
 *
 * Equivale a:
 *   curl --location '{servidor}/GestaoCooperado/stream' --header 'Accept: text/event-stream'
 *
 * Usa a API nativa EventSource do navegador, que:
 *   - envia "Accept: text/event-stream" automaticamente;
 *   - reconecta sozinha quando a conexão cai durante o envio.
 * Quando o servidor responde com erro (ex.: 401/404/500), o EventSource
 * desiste. Nesse caso esta classe agenda uma nova tentativa com espera
 * crescente (2 s, 4 s, 8 s ... até o máximo configurado).
 *
 * Uso:
 *   var oStream = new CarregamentoStream(oConfiguracao, {
 *       aoReceberEvento:      function (oEvento) {},   // evento já validado (EventoCarregamento)
 *       aoMudarStatusConexao: function (sStatus) {},   // ver CarregamentoStream.STATUS
 *       aoDescartarMensagem:  function () {}           // mensagem inválida descartada
 *   });
 *   oStream.iniciar();  ...  oStream.parar();
 */
sap.ui.define([
	"sap/base/Log",
	"./EventoCarregamento"
], function (Log, EventoCarregamento) {
	"use strict";

	var NOME_COMPONENTE_LOG = "vagoes.dashboard.CarregamentoStream";

	/** Estados possíveis da conexão (também usados pela tela). */
	var STATUS = {
		CONECTANDO: "conectando",
		CONECTADO: "conectado",
		RECONECTANDO: "reconectando",
		DESCONECTADO: "desconectado",
		INDISPONIVEL: "indisponivel"
	};

	/** Valores padrão. Podem ser sobrescritos em manifest.json > sap.ui5 > config > carregamentoStream. */
	var CONFIGURACAO_PADRAO = {
		servidor: "",
		caminho: "/GestaoCooperado/stream",
		nomeEvento: "message",
		enviarCredenciais: false,
		esperaReconexaoInicialMs: 2000,
		esperaReconexaoMaximaMs: 30000
	};

	/**
	 * Monta a URL final do stream a partir do servidor e do caminho.
	 *  - servidor vazio  -> URL relativa ("/GestaoCooperado/stream"): mesma origem do app,
	 *                       que é o recomendado no SAP (destino/proxy, sem CORS).
	 *  - servidor "host:porta" sem protocolo -> assume https://
	 * Lança erro se a URL for inválida ou usar protocolo diferente de http/https.
	 * @returns {string}
	 */
	function montarUrlStream(sServidor, sCaminho) {
		var sCaminhoLimpo = "/" + String(sCaminho || "").replace(/^\/+/, "");
		var sServidorLimpo = String(sServidor || "").trim().replace(/\/+$/, "");

		if (!sServidorLimpo) {
			return sCaminhoLimpo;
		}
		if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(sServidorLimpo)) {
			sServidorLimpo = "https://" + sServidorLimpo;
		}

		var oUrl = new URL(sServidorLimpo + sCaminhoLimpo);
		if (oUrl.protocol !== "https:" && oUrl.protocol !== "http:") {
			throw new Error("Protocolo não permitido para o stream: " + oUrl.protocol);
		}
		if (oUrl.username || oUrl.password) {
			throw new Error("Não coloque usuário/senha na URL do stream. Use destino SAP ou cookie de sessão.");
		}
		if (oUrl.protocol === "http:" && window.location.protocol === "https:") {
			Log.warning("Stream em http:// a partir de uma página https:// será bloqueado pelo navegador (mixed content).", oUrl.origin, NOME_COMPONENTE_LOG);
		}
		return oUrl.href;
	}

	function CarregamentoStream(oConfiguracao, oCallbacks) {
		this._oConfiguracao = Object.assign({}, CONFIGURACAO_PADRAO, oConfiguracao || {});
		this._oCallbacks = oCallbacks || {};
		this._oEventSource = null;
		this._iTentativasReconexao = 0;
		this._iTimerReconexao = null;
		this._sStatus = STATUS.DESCONECTADO;
		this._sUrl = "";
		this._sOrigemEsperada = "";

		// guardadas para poder remover os listeners no parar()
		this._fnAoAbrir = this._aoAbrirConexao.bind(this);
		this._fnAoReceber = this._aoReceberMensagem.bind(this);
		this._fnAoFalhar = this._aoFalharConexao.bind(this);
	}

	CarregamentoStream.STATUS = STATUS;
	CarregamentoStream.montarUrlStream = montarUrlStream;

	/** Abre a conexão com o stream. */
	CarregamentoStream.prototype.iniciar = function () {
		this._fecharEventSource();

		if (typeof window.EventSource === "undefined") {
			Log.error("Navegador sem suporte a EventSource (Server-Sent Events).", "", NOME_COMPONENTE_LOG);
			this._definirStatus(STATUS.INDISPONIVEL);
			return;
		}

		try {
			this._sUrl = montarUrlStream(this._oConfiguracao.servidor, this._oConfiguracao.caminho);
			this._sOrigemEsperada = new URL(this._sUrl, window.location.href).origin;
		} catch (oErro) {
			Log.error("URL do stream inválida. Verifique manifest.json > carregamentoStream.servidor", oErro.message, NOME_COMPONENTE_LOG);
			this._definirStatus(STATUS.INDISPONIVEL);
			return;
		}

		this._definirStatus(this._iTentativasReconexao > 0 ? STATUS.RECONECTANDO : STATUS.CONECTANDO);

		this._oEventSource = new window.EventSource(this._sUrl, {
			withCredentials: !!this._oConfiguracao.enviarCredenciais
		});
		this._oEventSource.addEventListener("open", this._fnAoAbrir);
		this._oEventSource.addEventListener(this._oConfiguracao.nomeEvento || "message", this._fnAoReceber);
		this._oEventSource.addEventListener("error", this._fnAoFalhar);
	};

	/** Fecha a conexão e cancela reconexões pendentes. Chamar sempre ao sair da tela. */
	CarregamentoStream.prototype.parar = function () {
		this._fecharEventSource();
		this._iTentativasReconexao = 0;
		this._definirStatus(STATUS.DESCONECTADO);
	};

	/** Força uma nova conexão imediatamente (botão "Reconectar"). */
	CarregamentoStream.prototype.reconectar = function () {
		this._iTentativasReconexao = 0;
		this.iniciar();
	};

	CarregamentoStream.prototype.getStatus = function () {
		return this._sStatus;
	};

	CarregamentoStream.prototype.getUrl = function () {
		return this._sUrl;
	};

	/* ------------------------------------------------------------------ */
	/* Internos                                                            */
	/* ------------------------------------------------------------------ */

	CarregamentoStream.prototype._aoAbrirConexao = function () {
		this._iTentativasReconexao = 0;
		this._definirStatus(STATUS.CONECTADO);
	};

	CarregamentoStream.prototype._aoReceberMensagem = function (oMessageEvent) {
		// Segurança: só aceita mensagens vindas da origem configurada.
		if (oMessageEvent.origin && this._sOrigemEsperada && oMessageEvent.origin !== this._sOrigemEsperada) {
			this._notificarDescarte();
			return;
		}
		var oEvento = EventoCarregamento.interpretarMensagem(oMessageEvent.data);
		if (!oEvento) {
			this._notificarDescarte();
			return;
		}
		if (this._sStatus !== STATUS.CONECTADO) {
			this._definirStatus(STATUS.CONECTADO);
		}
		if (this._oCallbacks.aoReceberEvento) {
			this._oCallbacks.aoReceberEvento(oEvento);
		}
	};

	CarregamentoStream.prototype._aoFalharConexao = function () {
		if (!this._oEventSource) {
			return;
		}
		if (this._oEventSource.readyState === window.EventSource.CONNECTING) {
			// Queda durante o envio: o próprio navegador já está reconectando.
			this._definirStatus(STATUS.RECONECTANDO);
			return;
		}
		// CLOSED: o servidor recusou (HTTP de erro, tipo de conteúdo errado, CORS...).
		this._fecharEventSource();
		this._agendarReconexao();
	};

	CarregamentoStream.prototype._agendarReconexao = function () {
		var oCfg = this._oConfiguracao;
		var iEspera = Math.min(
			oCfg.esperaReconexaoMaximaMs,
			oCfg.esperaReconexaoInicialMs * Math.pow(2, this._iTentativasReconexao)
		);
		// pequena variação aleatória para várias telas não reconectarem ao mesmo tempo
		iEspera += Math.round(Math.random() * 500);
		this._iTentativasReconexao++;
		this._definirStatus(STATUS.RECONECTANDO);
		Log.warning("Stream indisponível. Nova tentativa em " + iEspera + " ms.", this._sUrl, NOME_COMPONENTE_LOG);
		this._iTimerReconexao = setTimeout(this.iniciar.bind(this), iEspera);
	};

	CarregamentoStream.prototype._fecharEventSource = function () {
		clearTimeout(this._iTimerReconexao);
		this._iTimerReconexao = null;
		if (this._oEventSource) {
			this._oEventSource.removeEventListener("open", this._fnAoAbrir);
			this._oEventSource.removeEventListener(this._oConfiguracao.nomeEvento || "message", this._fnAoReceber);
			this._oEventSource.removeEventListener("error", this._fnAoFalhar);
			this._oEventSource.close();
			this._oEventSource = null;
		}
	};

	CarregamentoStream.prototype._definirStatus = function (sNovoStatus) {
		if (this._sStatus === sNovoStatus) {
			return;
		}
		this._sStatus = sNovoStatus;
		if (this._oCallbacks.aoMudarStatusConexao) {
			this._oCallbacks.aoMudarStatusConexao(sNovoStatus);
		}
	};

	CarregamentoStream.prototype._notificarDescarte = function () {
		if (this._oCallbacks.aoDescartarMensagem) {
			this._oCallbacks.aoDescartarMensagem();
		}
	};

	return CarregamentoStream;
});
