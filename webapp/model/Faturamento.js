/**
 * Faturamento
 * ------------------------------------------------------------------
 * Faturamento POR VAGÃO. Cada vagão tem a sua própria nota.
 *
 * A fatura de um vagão só é liberada depois que ele enche (regra em
 * Regras.situacaoFaturamento). Aqui ficam apenas as AÇÕES que mudam o
 * estado: faturar um vagão e faturar todos os que estão liberados.
 *
 * Protótipo: a nota é gerada localmente, com número sequencial.
 * TODO integração: trocar por chamada à API de faturamento e usar o
 * número de nota devolvido pelo backend.
 */
sap.ui.define([
	"./Regras",
	"./Formatador"
], function (Regras, Formatador) {
	"use strict";

	var LIBERADO = Regras.SITUACAO_FATURA.LIBERADO;

	/**
	 * Monta os dados da nota de um vagão.
	 * @param {object} oEstado estado do carregamento (usa série e próximo número)
	 * @param {object} oVagao vagão que será faturado
	 * @param {number} iNumeroNota número sequencial da nota
	 * @param {number} iAgoraMs hora da emissão (ms)
	 */
	function criarFatura(oEstado, oVagao, iNumeroNota, iAgoraMs) {
		return {
			numero: Formatador.notaFiscal(oEstado.faturamento.serie, iNumeroNota),
			emitidaEmMs: iAgoraMs,
			pesoKg: oVagao.pesoKg
		};
	}

	var Faturamento = {

		/**
		 * Fatura UM vagão. Só faz algo se a fatura dele estiver liberada.
		 * @param {object} oEstado estado atual
		 * @param {number} iIndiceVagao posição em oEstado.vagoes
		 * @param {number} iAgoraMs hora da emissão (ms)
		 * @returns {object} novo estado (ou o mesmo, se não puder faturar)
		 */
		faturarVagao: function (oEstado, iIndiceVagao, iAgoraMs) {
			var oVagao = oEstado.vagoes[iIndiceVagao];
			if (!oVagao || Regras.situacaoFaturamento(oVagao, oEstado.composicao).situacao !== LIBERADO) {
				return oEstado;
			}
			var iNumeroNota = oEstado.faturamento.proximoNumero;
			var aVagoes = oEstado.vagoes.slice();
			aVagoes[iIndiceVagao] = Object.assign({}, oVagao, {
				fatura: criarFatura(oEstado, oVagao, iNumeroNota, iAgoraMs)
			});
			return Object.assign({}, oEstado, {
				vagoes: aVagoes,
				faturamento: Object.assign({}, oEstado.faturamento, { proximoNumero: iNumeroNota + 1 })
			});
		},

		/**
		 * Fatura todos os vagões que estão com a fatura liberada, na ordem da composição.
		 * @param {object} oEstado estado atual
		 * @param {number} iAgoraMs hora da emissão (ms)
		 * @returns {object} novo estado
		 */
		faturarLiberados: function (oEstado, iAgoraMs) {
			var iNumeroNota = oEstado.faturamento.proximoNumero;
			var bAlgumFaturado = false;
			var aVagoes = oEstado.vagoes.map(function (oVagao) {
				if (Regras.situacaoFaturamento(oVagao, oEstado.composicao).situacao !== LIBERADO) {
					return oVagao;
				}
				bAlgumFaturado = true;
				return Object.assign({}, oVagao, { fatura: criarFatura(oEstado, oVagao, iNumeroNota++, iAgoraMs) });
			});
			if (!bAlgumFaturado) {
				return oEstado;
			}
			return Object.assign({}, oEstado, {
				vagoes: aVagoes,
				faturamento: Object.assign({}, oEstado.faturamento, { proximoNumero: iNumeroNota })
			});
		},

		/**
		 * Conta quantos vagões estão com a fatura liberada.
		 * @param {object} oEstado estado atual
		 * @returns {number}
		 */
		quantidadeLiberados: function (oEstado) {
			return oEstado.vagoes.filter(function (oVagao) {
				return Regras.situacaoFaturamento(oVagao, oEstado.composicao).situacao === LIBERADO;
			}).length;
		}
	};

	return Faturamento;
});
