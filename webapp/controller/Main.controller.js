sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageToast",
	"sap/m/MessageBox",
	"../model/Regras",
	"../model/Simulador"
], function (Controller, JSONModel, MessageToast, MessageBox, Regras, Simulador) {
	"use strict";

	/** Intervalo da simulação. Em produção: polling/WebSocket do backend. */
	var INTERVALO_MS = 1000;

	/** Depois de uma seleção manual, volta a seguir o vagão em carga após este tempo. */
	var MANUAL_MS = 20000;

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

			var oComponent = this.getOwnerComponent();
			var oMock = oComponent.getModel("mock");
			var pBundle = Promise.resolve(oComponent.getModel("i18n").getResourceBundle());

			Promise.all([pBundle, oMock.dataLoaded()]).then(function (aRes) {
				var oBundle = aRes[0];
				this._t = function (sKey, aArgs) { return oBundle.getText(sKey, aArgs); };
				this._state = Simulador.estadoInicial(oMock.getData());
				this._publicar();
				this._iTimer = setInterval(this._tick.bind(this), INTERVALO_MS);
			}.bind(this));
		},

		onExit: function () {
			clearInterval(this._iTimer);
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
			this._publicar();
		},

		_vm: function (sPath) {
			return this._oModel.getProperty(sPath);
		},

		/* =========================================================== */
		/* Cabeçalho                                                   */
		/* =========================================================== */

		onToggleSim: function () {
			this._executar(Simulador.alternarSimulacao);
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

		onConcluirVistoria: function () {
			var sLabel = this._vm("/sel/label");
			this._executar(Simulador.concluirVistoria, this._ui.sel);
			MessageToast.show(this._t("msgVistoriaOk", [sLabel]));
		},

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
		},

		/* =========================================================== */
		/* Fatura                                                      */
		/* =========================================================== */

		onEmitirFatura: function () {
			var oFat = this._vm("/fatura");
			if (!oFat || !oFat.podeEmitir) {
				return;
			}
			var sTexto = this._t("fat.confirmTexto", [this._vm("/composicao/codigo"), this._vm("/kpi/totalTxt"), oFat.nCarregados]);
			MessageBox.confirm(sTexto, {
				title: this._t("fat.confirmTitulo"),
				emphasizedAction: MessageBox.Action.OK,
				onClose: function (sAcao) {
					if (sAcao !== MessageBox.Action.OK) {
						return;
					}
					var d = new Date();
					var sHora = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
					this._executar(Simulador.emitirFatura, sHora);
					MessageToast.show(this._t("fat.ok", [this._vm("/fatura/numeroTxt")]));
				}.bind(this)
			});
		}
	});
});
