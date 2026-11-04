/**
 * Controle UI5: estação de carregamento com silos, cones de descarga,
 * linhas de fluxo de grão e a composição (locomotiva + vagões).
 *
 * Uso na view:
 *   <vg:LoadingStation bocas="{/bocas}" vagoes="{/vagoes}" selectedIndex="{/view/sel}"
 *       running="{/view/running}" textos="{/estacaoTextos}" nivelMinimoPct="{/composicao/nivelMinimoSiloPct}"
 *       wagonPress=".onWagonPress" bocaPress=".onBocaPress"/>
 *
 * Os setters não invalidam o controle: o DOM é atualizado no lugar pelo
 * StationDom, para que as animações (fluxo, grãos, rodas) não reiniciem a
 * cada atualização do modelo.
 */
sap.ui.define([
	"sap/ui/core/Control",
	"./StationDom"
], function (Control, StationDom) {
	"use strict";

	var aProps = ["bocas", "vagoes", "selectedIndex", "running", "textos", "nivelMinimoPct"];

	var LoadingStation = Control.extend("vagoes.dashboard.control.LoadingStation", {
		metadata: {
			properties: {
				/** Lista de bocas (view model, ver model/Regras.js) */
				bocas: { type: "object", defaultValue: null },
				/** Lista de vagões (view model) */
				vagoes: { type: "object", defaultValue: null },
				/** Índice do vagão selecionado */
				selectedIndex: { type: "int", defaultValue: 0 },
				/** Liga/desliga as animações de fluxo */
				running: { type: "boolean", defaultValue: false },
				/** Textos i18n usados no desenho */
				textos: { type: "object", defaultValue: null },
				/** Linha de nível mínimo dos silos (%) */
				nivelMinimoPct: { type: "float", defaultValue: 15 },
				/** Rótulo acessível da região */
				ariaLabel: { type: "string", defaultValue: "" }
			},
			events: {
				wagonPress: {
					parameters: {
						index: { type: "int" },
						domRef: { type: "object" }
					}
				},
				bocaPress: {
					parameters: {
						index: { type: "int" },
						domRef: { type: "object" }
					}
				}
			}
		},

		renderer: {
			apiVersion: 2,
			render: function (oRm, oControl) {
				oRm.openStart("div", oControl);
				oRm.class("vgSt");
				oRm.style("height", "100%");
				oRm.attr("role", "region");
				if (oControl.getAriaLabel()) {
					oRm.attr("aria-label", oControl.getAriaLabel());
				}
				oRm.openEnd();
				oRm.close("div");
			}
		},

		init: function () {
			this._oDom = null;
			this._bPending = false;
		},

		onBeforeRendering: function () {
			if (this._oDom) {
				this._oDom.detach();
			}
		},

		onAfterRendering: function () {
			var oRoot = this.getDomRef();
			if (!oRoot) {
				return;
			}
			if (!this._oDom) {
				this._oDom = new StationDom(oRoot, {
					onWagonPress: function (i, el) { this.fireWagonPress({ index: i, domRef: el }); }.bind(this),
					onBocaPress: function (i, el) { this.fireBocaPress({ index: i, domRef: el }); }.bind(this)
				});
			} else {
				this._oDom.attach(oRoot);
			}
			this._atualizar();
		},

		exit: function () {
			if (this._oDom) {
				this._oDom.destroy();
				this._oDom = null;
			}
		},

		_dados: function () {
			return {
				bocas: this.getBocas(),
				vagoes: this.getVagoes(),
				selectedIndex: this.getSelectedIndex(),
				running: this.getRunning(),
				textos: this.getTextos() || {},
				nivelMinimoPct: this.getNivelMinimoPct()
			};
		},

		_atualizar: function () {
			if (this._oDom && this.getDomRef()) {
				this._oDom.update(this._dados());
			}
		},

		/** agrupa várias mudanças de propriedade num único redesenho */
		_agendar: function () {
			if (this._bPending) {
				return;
			}
			this._bPending = true;
			Promise.resolve().then(function () {
				this._bPending = false;
				this._atualizar();
			}.bind(this));
		}
	});

	// setters sem invalidação (atualização incremental do DOM)
	aProps.forEach(function (sProp) {
		var sSetter = "set" + sProp.charAt(0).toUpperCase() + sProp.slice(1);
		LoadingStation.prototype[sSetter] = function (vValue) {
			this.setProperty(sProp, vValue, true);
			this._agendar();
			return this;
		};
	});

	return LoadingStation;
});
