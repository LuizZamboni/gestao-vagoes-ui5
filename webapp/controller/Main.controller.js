/**
 * Main.controller
 * ------------------------------------------------------------------
 * Duas fontes de dados, escolhidas na inicialização:
 *
 *  1. STREAM (produção): eventos SSE de GET {servidor}/GestaoCooperado/stream.
 *     Configuração em manifest.json > sap.ui5 > config > carregamentoStream.
 *     Os eventos entram num buffer; a cada "intervaloAtualizacaoTelaMs" o buffer
 *     é aplicado ao estado (model/Carregamento.js) e a tela é atualizada.
 *
 *  2. DEMONSTRAÇÃO: a simulação local (model/Simulador.js), sem servidor.
 *     Ativada por "modoDemonstracao": true no manifest ou pela meta tag
 *     "vagoes-modo-demonstracao" (usada no index-cdn.html / Netlify).
 *
 * Nos dois casos a tela é montada pelo mesmo Regras.montarViewModel.
 */
sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageToast",
	"sap/ui/core/Theming",
	"sap/base/Log",
	"../model/Regras",
	"../model/Simulador",
	"../model/Carregamento",
	"../model/stream/CarregamentoStream"
], function (Controller, JSONModel, MessageToast, Theming, Log, Regras, Simulador, Carregamento, CarregamentoStream) {
	"use strict";

	/** Intervalo da simulação (modo demonstração). */
	var INTERVALO_MS = 1000;

	/** Máximo de eventos guardados com a aba oculta (proteção de memória). */
	var LIMITE_EVENTOS_NO_BUFFER = 2000;

	/** No modo stream, a tela é recalculada ao menos a cada X ms (relógio e alerta "sem atualização"). */
	var INTERVALO_VERIFICACAO_MS = 1000;

	/** Depois de uma seleção manual, volta a seguir o vagão em carga após este tempo. */
	var MANUAL_MS = 20000;

	/** Temas do modo escuro / claro e chave onde a escolha fica salva no navegador. */
	var TEMA_ESCURO = "sap_horizon_dark";
	var TEMA_CLARO = "sap_horizon";
	var TEMA_KEY = "vagoes.dashboard.tema";

	return Controller.extend("vagoes.dashboard.controller.Main", {

		/* =========================================================== */
		/* Ciclo de vida                                               */
		/* =========================================================== */

		onInit: function () {
			this._ui = { sel: 3, bocaSel: 0, auto: true, manualAt: 0 };
			this._state = null;

			// modelo de tela (somente leitura: as ações passam pelo controller)
			this._oModel = new JSONModel();
			this._oModel.setDefaultBindingMode("OneWay");
			this._oModel.setSizeLimit(500);
			this.getView().setModel(this._oModel);

			// tema (escuro/claro): modelo "ui" só para o botão do cabeçalho
			this._oUi = new JSONModel({ claro: false });
			this.getView().setModel(this._oUi, "ui");
			this._iniciarTema();

			var oComponent = this.getOwnerComponent();
			var oMock = oComponent.getModel("mock");
			var pBundle = Promise.resolve(oComponent.getModel("i18n").getResourceBundle());

			this._oConfigStream = Object.assign({}, oComponent.getManifestEntry("/sap.ui5/config/carregamentoStream"));
			this._ui.limiteSemDadosMs = (this._oConfigStream.segundosSemDadosParaAlerta || 15) * 1000;
			this._aEventosPendentes = [];

			Promise.all([pBundle, oMock.dataLoaded()]).then(function (aRes) {
				var oBundle = aRes[0];
				this._t = function (sKey, aArgs) { return oBundle.getText(sKey, aArgs); };
				var oEstadoInicial = Simulador.estadoInicial(oMock.getData());
				if (this._modoDemonstracao()) {
					this._state = oEstadoInicial;
					this._publicar();
					this._iTimer = setInterval(this._tick.bind(this), INTERVALO_MS);
				} else {
					this._iniciarStream(oEstadoInicial);
				}
			}.bind(this)).catch(function (oErro) {
				Log.error("Falha ao carregar dados iniciais", oErro && oErro.message, "vagoes.dashboard");
			});
		},

		onExit: function () {
			// fecha a conexão e os timers ao sair do app (navegação no Launchpad)
			clearInterval(this._iTimer);
			if (this._oStream) {
				this._oStream.parar();
			}
			if (this._fnAoMudarVisibilidade) {
				document.removeEventListener("visibilitychange", this._fnAoMudarVisibilidade);
			}
		},

		/* =========================================================== */
		/* Stream de carregamento (SSE)                                */
		/* =========================================================== */

		_modoDemonstracao: function () {
			return !!this._oConfigStream.modoDemonstracao ||
				!!document.querySelector("meta[name='vagoes-modo-demonstracao'][content='true']");
		},

		_iniciarStream: function (oEstadoInicial) {
			this._state = Carregamento.prepararEstado(oEstadoInicial);
			this._iUltimaPublicacaoMs = 0;
			this._bPrecisaPublicar = true;

			this._oStream = new CarregamentoStream(this._oConfigStream, {
				aoReceberEvento: function (oEvento) {
					this._aEventosPendentes.push(oEvento);
					if (this._aEventosPendentes.length > LIMITE_EVENTOS_NO_BUFFER) {
						this._compactarBuffer();
					}
				}.bind(this),
				aoMudarStatusConexao: function (sStatus) {
					this._state = Carregamento.definirStatusConexao(this._state, sStatus);
					this._bPrecisaPublicar = true;
				}.bind(this),
				aoDescartarMensagem: function () {
					this._state = Carregamento.registrarMensagemDescartada(this._state);
					this._bPrecisaPublicar = true;
				}.bind(this)
			});

			this._publicar();
			this._oStream.iniciar();

			var iIntervalo = Math.max(200, this._oConfigStream.intervaloAtualizacaoTelaMs || 500);
			this._iTimer = setInterval(this._aplicarEventosPendentes.bind(this), iIntervalo);

			this._fnAoMudarVisibilidade = function () {
				if (!document.hidden) { this._aplicarEventosPendentes(); }
			}.bind(this);
			document.addEventListener("visibilitychange", this._fnAoMudarVisibilidade);
		},

		/** Aplica o buffer de eventos e atualiza a tela (no máximo 1x por intervalo). */
		_aplicarEventosPendentes: function () {
			if (!this._state || document.hidden) {
				return; // aba oculta: os eventos ficam no buffer até voltar
			}
			var iAgoraMs = Date.now();
			var bTemEventos = this._aEventosPendentes.length > 0;
			if (!bTemEventos && !this._bPrecisaPublicar && iAgoraMs - this._iUltimaPublicacaoMs < INTERVALO_VERIFICACAO_MS) {
				return;
			}
			if (bTemEventos) {
				var aEventos = this._aEventosPendentes;
				this._aEventosPendentes = [];
				this._state = Carregamento.aplicarEventos(this._state, aEventos);
			}
			this._state = Carregamento.sincronizarBocas(this._state, iAgoraMs, this._ui.limiteSemDadosMs);
			this._publicar();
			this._bPrecisaPublicar = false;
			this._iUltimaPublicacaoMs = iAgoraMs;
		},

		/** Mantém só os 2 últimos eventos de cada vagão (suficiente para peso e vazão). */
		_compactarBuffer: function () {
			var mPorVagao = {};
			this._aEventosPendentes.forEach(function (oEvento) {
				var aLista = mPorVagao[oEvento.vagaoId] = mPorVagao[oEvento.vagaoId] || [];
				aLista.push(oEvento);
				if (aLista.length > 2) { aLista.shift(); }
			});
			this._aEventosPendentes = Object.keys(mPorVagao)
				.reduce(function (aTodos, sId) { return aTodos.concat(mPorVagao[sId]); }, [])
				.sort(function (oA, oB) { return oA.recebidoEmMs - oB.recebidoEmMs; });
		},

		/* =========================================================== */
		/* Tema (modo escuro / claro)                                  */
		/* =========================================================== */

		_iniciarTema: function () {
			var sSalvo = null;
			try { sSalvo = window.localStorage.getItem(TEMA_KEY); } catch (e) { /* sem storage */ }
			if (sSalvo === TEMA_CLARO || sSalvo === TEMA_ESCURO) {
				this._aplicarTema(sSalvo);
			} else {
				this._oUi.setProperty("/claro", Theming.getTheme() === TEMA_CLARO);
			}
		},

		_aplicarTema: function (sTema) {
			if (Theming.getTheme() !== sTema) {
				Theming.setTheme(sTema);
			}
			this._oUi.setProperty("/claro", sTema === TEMA_CLARO);
		},

		onAlternarTema: function () {
			var sTema = this._oUi.getProperty("/claro") ? TEMA_ESCURO : TEMA_CLARO;
			this._aplicarTema(sTema);
			try { window.localStorage.setItem(TEMA_KEY, sTema); } catch (e) { /* sem storage */ }
		},

		/* =========================================================== */
		/* Estado                                                      */
		/* =========================================================== */

		_tick: function () {
			this._state = Simulador.passo(this._state);
			this._publicar();
		},

		_publicar: function () {
			if (!this._state) {
				return;
			}
			this._seguirCarregamento();
			this._oModel.setData(Regras.montarViewModel(this._state, this._ui, this._t));
		},

		/** Mantém em foco o vagão que está carregando (salvo seleção manual recente). */
		_seguirCarregamento: function () {
			var s = this._state;
			if (this._ui.manualAt && Date.now() - this._ui.manualAt < MANUAL_MS) {
				this._ui.auto = false;
				return;
			}
			this._ui.manualAt = 0;
			var iCarregando = this._indiceCarregando();
			this._ui.auto = iCarregando >= 0;
			if (iCarregando >= 0) {
				this._ui.sel = iCarregando;
			}
		},

		_indiceCarregando: function () {
			var s = this._state;
			var oBoca = s.bocas.filter(function (b) { return b.status === "ativa" && b.destino != null; })[0];
			if (!oBoca) {
				// modo stream com todas as bocas paradas: usa o status informado pela balança
				for (var j = 0; j < s.vagoes.length; j++) {
					if (s.vagoes[j].statusChave === "carregando") {
						return j;
					}
				}
				return -1;
			}
			for (var i = 0; i < s.vagoes.length; i++) {
				if (s.vagoes[i].pos === oBoca.destino) {
					return i;
				}
			}
			return -1;
		},

		_selecionar: function (iVagao) {
			this._ui.sel = iVagao;
			this._ui.manualAt = iVagao === this._indiceCarregando() ? 0 : Date.now();
			this._publicar();
		},

		_executar: function (fnAcao) {
			if (!this._state) {
				return;
			}
			var aArgs = Array.prototype.slice.call(arguments, 1);
			this._state = fnAcao.apply(Simulador, [this._state].concat(aArgs));
			if (this._oStream) {
				// modo stream: religa as bocas ao vagão em carga logo após a ação do operador
				this._state = Carregamento.sincronizarBocas(this._state, Date.now(), this._ui.limiteSemDadosMs);
			}
			this._publicar();
		},

		_vm: function (sPath) {
			return this._oModel.getProperty(sPath);
		},

		/* =========================================================== */
		/* Estação: vagões e bocas                                     */
		/* =========================================================== */

		onWagonPress: function (oEvent) {
			this._selecionar(oEvent.getParameter("index"));
		},

		onVagaoListPress: function (oEvent) {
			this._selecionar(oEvent.getSource().getBindingContext().getProperty("index"));
		},

		onBocaPress: function (oEvent) {
			this._abrirBoca(oEvent.getParameter("index"), oEvent.getParameter("domRef"));
		},

		_abrirBoca: function (iBoca, vOpener) {
			this._ui.bocaSel = iBoca;
			this._publicar();
			if (!this._pPopover) {
				this._pPopover = this.loadFragment({ name: "vagoes.dashboard.view.BocaPopover" });
			}
			this._pPopover.then(function (oPopover) {
				oPopover.openBy(vOpener);
			});
		},

		onFecharPopover: function () {
			this.byId("bocaPopover").close();
		},

		onAberturaChange: function (oEvent) {
			this._executar(Simulador.definirAbertura, this._ui.bocaSel, oEvent.getParameter("value"));
		},

		onDestinoChange: function (oEvent) {
			var oItem = oEvent.getParameter("selectedItem");
			if (oItem) {
				this._executar(Simulador.definirDestino, this._ui.bocaSel, Number(oItem.getKey()));
			}
		},

		onBocaAcao: function () {
			var oBoca = this._vm("/bocaSel");
			if (oBoca.ligada) {
				this._executar(Simulador.pararBoca, this._ui.bocaSel);
			} else {
				this._executar(Simulador.iniciarBoca, this._ui.bocaSel);
			}
		},

		/* =========================================================== */
		/* Vagão selecionado                                           */
		/* =========================================================== */

		onRetirarExcesso: function () {
			var sLabel = this._vm("/sel/label");
			this._executar(Simulador.retirarExcesso, this._ui.sel);
			MessageToast.show(this._t("msgExcessoOk", [sLabel]));
		},

		/* =========================================================== */
		/* Validações                                                  */
		/* =========================================================== */

		onValidacaoPress: function (oEvent) {
			var oLink = oEvent.getSource();
			var oVal = oLink.getBindingContext().getObject();
			if (oVal.vagaoIndex >= 0) {
				this._selecionar(oVal.vagaoIndex);
			} else if (oVal.bocaIndex >= 0) {
				this._abrirBoca(oVal.bocaIndex, oLink);
			}
		}
	});
});
