/**
 * Estacao3D
 * ------------------------------------------------------------------
 * Controle UI5 da estação de carregamento em 3D: pórtico com os silos
 * (bocas), o fluxo de grão e a composição (locomotiva + vagões).
 *
 * Este arquivo é só a "casca" UI5 (propriedades, eventos e ciclo de
 * vida). O desenho fica em control/estacao3d/:
 *   - Cena3D.js   monta e atualiza a cena;
 *   - Camera3D.js gira, aproxima e troca de vista;
 *   - Dom.js      funções utilitárias de DOM.
 *
 * Uso na view:
 *   <vg:Estacao3D
 *       cena="{/estacao}"
 *       bocas="{/bocas}"
 *       nivelMinimoPct="{/composicao/nivelMinimoSiloPct}"
 *       rotuloAcessivel="{i18n>cardEstacao}"
 *       selecionarVagao=".onSelecionarVagao"
 *       selecionarBoca=".onSelecionarBoca"
 *       seguirCarga=".onSeguirCarga"/>
 *
 * Por que os setters não invalidam o controle: a cada 500 ms chegam
 * dados novos. Se o UI5 redesenhasse o controle, as animações (grão
 * caindo, trem andando) reiniciariam e a câmera voltaria ao início.
 * Por isso as propriedades são gravadas sem invalidar e a cena é
 * atualizada no lugar, uma única vez por rodada de mudanças.
 */
sap.ui.define([
	"sap/ui/core/Control",
	"./estacao3d/Cena3D"
], function (Control, Cena3D) {
	"use strict";

	/** Propriedades que redesenham a cena quando mudam. */
	var PROPRIEDADES_DA_CENA = ["cena", "bocas", "nivelMinimoPct"];

	var Estacao3D = Control.extend("vagoes.dashboard.control.Estacao3D", {
		metadata: {
			properties: {
				/**
				 * Dados da cena, montados em model/ModeloTela.js (_montarEstacao):
				 * { vagoes, quantidadeVagoes, indiceSobOPortico, indiceSelecionado, fluindo, textos }
				 */
				cena: { type: "object", defaultValue: null },
				/** Lista de bocas do modelo de tela (ModeloTela._montarBocas). */
				bocas: { type: "object", defaultValue: null },
				/** Altura (%) da linha de nível mínimo desenhada nos silos. */
				nivelMinimoPct: { type: "float", defaultValue: 15 },
				/** Texto lido por leitores de tela para a região. */
				rotuloAcessivel: { type: "string", defaultValue: "" }
			},
			events: {
				/** O usuário escolheu um vagão (clique na cena ou setas ‹ ›). */
				selecionarVagao: {
					parameters: {
						/** Posição do vagão na composição (0 = primeiro). */
						indice: { type: "int" },
						/** Elemento clicado; null quando veio das setas. */
						elemento: { type: "object" }
					}
				},
				/** O usuário escolheu um silo/boca. */
				selecionarBoca: {
					parameters: {
						indice: { type: "int" },
						/** Elemento usado para ancorar o popover da boca. */
						elemento: { type: "object" }
					}
				},
				/** O usuário pediu para voltar a acompanhar o vagão em carga. */
				seguirCarga: {}
			}
		},

		renderer: {
			apiVersion: 2,

			/** Desenha só o elemento hospedeiro; a cena entra em onAfterRendering. */
			render: function (oRm, oControle) {
				oRm.openStart("div", oControle);
				oRm.class("vgE3");
				oRm.attr("role", "region");
				if (oControle.getRotuloAcessivel()) {
					oRm.attr("aria-label", oControle.getRotuloAcessivel());
				}
				oRm.openEnd();
				oRm.close("div");
			}
		},

		init: function () {
			this._oCena = null;
			this._bAtualizacaoAgendada = false;
		},

		/** Antes de o UI5 redesenhar o hospedeiro, a cena é guardada (não é destruída). */
		onBeforeRendering: function () {
			if (this._oCena) {
				this._oCena.desanexar();
			}
		},

		/** Cria a cena na primeira vez; nas seguintes, só a recoloca no hospedeiro. */
		onAfterRendering: function () {
			var oHospedeiro = this.getDomRef();
			if (!oHospedeiro) {
				return;
			}
			if (this._oCena) {
				this._oCena.anexar(oHospedeiro);
			} else {
				this._oCena = new Cena3D(oHospedeiro, {
					aoSelecionarVagao: function (iIndice, oElemento) {
						this.fireSelecionarVagao({ indice: iIndice, elemento: oElemento });
					}.bind(this),
					aoSelecionarBoca: function (iIndice, oElemento) {
						this.fireSelecionarBoca({ indice: iIndice, elemento: oElemento });
					}.bind(this),
					aoSeguirCarga: this.fireSeguirCarga.bind(this)
				});
			}
			this._atualizarCena();
		},

		/** Libera ouvintes de evento e temporizadores da cena. */
		exit: function () {
			if (this._oCena) {
				this._oCena.destruir();
				this._oCena = null;
			}
		},

		/** Entrega os dados atuais para a cena (só quando ela já está na tela). */
		_atualizarCena: function () {
			var oCena = this.getCena();
			var aBocas = this.getBocas();
			if (!this._oCena || !this.getDomRef() || !oCena || !aBocas) {
				return;
			}
			this._oCena.atualizar({
				vagoes: oCena.vagoes || [],
				quantidadeVagoes: oCena.quantidadeVagoes || 0,
				indiceSobOPortico: oCena.indiceSobOPortico || 0,
				indiceSelecionado: oCena.indiceSelecionado || 0,
				fluindo: !!oCena.fluindo,
				textos: oCena.textos || {},
				bocas: aBocas,
				nivelMinimoPct: this.getNivelMinimoPct()
			});
		},

		/**
		 * Junta várias mudanças de propriedade em uma única atualização: o
		 * modelo troca "cena" e "bocas" na mesma rodada, e a cena só precisa
		 * ser redesenhada uma vez (microtarefa = logo após o código atual).
		 */
		_agendarAtualizacao: function () {
			if (this._bAtualizacaoAgendada) {
				return;
			}
			this._bAtualizacaoAgendada = true;
			Promise.resolve().then(function () {
				this._bAtualizacaoAgendada = false;
				this._atualizarCena();
			}.bind(this));
		}
	});

	// Setters sem invalidação: gravam o valor e agendam a atualização da cena.
	PROPRIEDADES_DA_CENA.forEach(function (sPropriedade) {
		var sSetter = "set" + sPropriedade.charAt(0).toUpperCase() + sPropriedade.slice(1);
		Estacao3D.prototype[sSetter] = function (vValor) {
			this.setProperty(sPropriedade, vValor, true);
			this._agendarAtualizacao();
			return this;
		};
	});

	return Estacao3D;
});
