/**
 * Formatador
 * ------------------------------------------------------------------
 * Formatação de números, pesos, horas e durações no padrão pt-BR.
 *
 * Módulo puro (sem dependência de controles UI5). Os objetos
 * Intl.NumberFormat são criados uma única vez: criar a cada chamada é
 * caro e a tela formata muitos valores por segundo.
 */
sap.ui.define([], function () {
	"use strict";

	var FORMATO_UMA_CASA = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
	var FORMATO_INTEIRO = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });

	/**
	 * Completa com zero à esquerda até dois dígitos.
	 * @param {number} iNumero ex.: 4
	 * @returns {string} ex.: "04"
	 */
	function doisDigitos(iNumero) {
		return String(iNumero).padStart(2, "0");
	}

	var Formatador = {

		doisDigitos: doisDigitos,

		/**
		 * Converte quilos em toneladas com uma casa decimal.
		 * @param {number} fPesoKg ex.: 61300
		 * @returns {string} ex.: "61,3"
		 */
		toneladas: function (fPesoKg) {
			return FORMATO_UMA_CASA.format((fPesoKg || 0) / 1000);
		},

		/**
		 * Número com uma casa decimal.
		 * @param {number} fValor ex.: 12.44
		 * @returns {string} ex.: "12,4"
		 */
		umaCasa: function (fValor) {
			return FORMATO_UMA_CASA.format(fValor || 0);
		},

		/**
		 * Número inteiro com separador de milhar.
		 * @param {number} fValor ex.: 1604.2
		 * @returns {string} ex.: "1.604"
		 */
		inteiro: function (fValor) {
			return FORMATO_INTEIRO.format(fValor || 0);
		},

		/**
		 * Hora local com segundos.
		 * @param {number} iTimestampMs data/hora em milissegundos
		 * @returns {string} ex.: "10:20:44" ("—" quando não há data)
		 */
		hora: function (iTimestampMs) {
			if (!iTimestampMs) {
				return "—";
			}
			var oData = new Date(iTimestampMs);
			return doisDigitos(oData.getHours()) + ":" + doisDigitos(oData.getMinutes()) + ":" + doisDigitos(oData.getSeconds());
		},

		/**
		 * Hora local sem segundos.
		 * @param {number} iTimestampMs data/hora em milissegundos
		 * @returns {string} ex.: "10:20"
		 */
		horaMinuto: function (iTimestampMs) {
			var oData = new Date(iTimestampMs);
			return doisDigitos(oData.getHours()) + ":" + doisDigitos(oData.getMinutes());
		},

		/**
		 * Duração legível. Usa unidades (min, s) para não ser confundida com
		 * horário do relógio.
		 * @param {number} fSegundos duração em segundos
		 * @returns {string} "1 h 05 min", "9 min 19 s", "45 s" ou "—" sem previsão
		 */
		duracao: function (fSegundos) {
			if (!isFinite(fSegundos) || fSegundos <= 0) {
				return "—";
			}
			var iTotal = Math.max(1, Math.round(fSegundos));
			var iHoras = Math.floor(iTotal / 3600);
			var iMinutos = Math.floor((iTotal % 3600) / 60);
			var iSegundos = iTotal % 60;
			if (iHoras) {
				return iHoras + " h " + doisDigitos(iMinutos) + " min";
			}
			return iMinutos ? iMinutos + " min " + doisDigitos(iSegundos) + " s" : iSegundos + " s";
		},

		/**
		 * Número de nota fiscal no formato "000.482".
		 * @param {string} sSerie série, ex.: "000"
		 * @param {number} iNumero sequencial, ex.: 482
		 * @returns {string}
		 */
		notaFiscal: function (sSerie, iNumero) {
			return sSerie + "." + String(iNumero).padStart(3, "0");
		}
	};

	return Formatador;
});
