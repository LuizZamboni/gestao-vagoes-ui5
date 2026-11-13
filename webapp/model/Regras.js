/**
 * Regras
 * ------------------------------------------------------------------
 * Regras de negócio do carregamento e do faturamento por vagão.
 *
 * Módulo PURO: só recebe dados e devolve respostas. Não altera o estado,
 * não conhece a tela e não depende de controles UI5. Por isso pode ser
 * testado sozinho e reaproveitado no backend.
 *
 * Resumo das regras:
 *  - Um vagão está CHEIO quando o peso chega a 100% da capacidade.
 *  - O faturamento é POR VAGÃO e só é LIBERADO depois que ele enche
 *    (ou quando o sistema de origem informa que o carregamento terminou).
 *  - Vistoria reprovada ou peso acima da capacidade BLOQUEIAM a fatura
 *    daquele vagão. Vistoria não informada não bloqueia (só avisa).
 *  - A vazão da estação vem da receita do material e é dividida entre as
 *    bocas ligadas, proporcionalmente à abertura de cada comporta.
 *
 * Importante: no front estas regras servem para feedback imediato. A
 * decisão final (principalmente liberar fatura) deve ser repetida no backend.
 */
sap.ui.define([], function () {
	"use strict";

	/** Seções do vagão, na ordem em que aparecem na tela. */
	var SECOES = ["esquerda", "centro", "direita"];

	/** Itens do checklist de vistoria. */
	var ITENS_CHECKLIST = ["limpeza", "escotilhas", "comportas", "rodeiros"];

	/** Tolerância (kg) para considerar o vagão cheio, por causa de arredondamento da balança. */
	var TOLERANCIA_CHEIO_KG = 0.5;

	/** Situações possíveis do faturamento de um vagão. */
	var SITUACAO_FATURA = {
		AGUARDANDO: "aguardando",
		LIBERADO: "liberado",
		BLOQUEADO: "bloqueado",
		FATURADO: "faturado"
	};

	/** Motivos de bloqueio da fatura de um vagão. */
	var MOTIVO_BLOQUEIO = {
		VISTORIA: "vistoriaReprovada",
		EXCESSO: "excessoDePeso"
	};

	var Regras = {

		SECOES: SECOES,
		ITENS_CHECKLIST: ITENS_CHECKLIST,
		TOLERANCIA_CHEIO_KG: TOLERANCIA_CHEIO_KG,
		SITUACAO_FATURA: SITUACAO_FATURA,
		MOTIVO_BLOQUEIO: MOTIVO_BLOQUEIO,

		/* =========================================================== */
		/* Receita e bocas                                             */
		/* =========================================================== */

		/**
		 * Procura a receita de descarga de um material.
		 * @param {Array<object>} aReceitas lista de receitas do cadastro
		 * @param {string} sMaterial nome do material, ex.: "Farelo de soja"
		 * @returns {object|null} receita ({codigo, vazaoTh, distribuicao}) ou null
		 */
		receitaDoMaterial: function (aReceitas, sMaterial) {
			return (aReceitas || []).filter(function (oReceita) {
				return oReceita.material === sMaterial;
			})[0] || null;
		},

		/**
		 * Vazão nominal de UMA boca (t/h): a vazão da receita é o total da
		 * estação para o material, dividido igualmente entre as bocas que
		 * trabalham com ele.
		 * @param {object} oEstado estado do carregamento
		 * @param {string} sMaterial material da boca
		 * @returns {number} t/h (0 se não houver receita)
		 */
		vazaoNominalPorBocaTh: function (oEstado, sMaterial) {
			var oReceita = Regras.receitaDoMaterial(oEstado.receitas, sMaterial);
			var iBocasDoMaterial = oEstado.bocas.filter(function (oBoca) { return oBoca.produto === sMaterial; }).length;
			return oReceita && iBocasDoMaterial ? oReceita.vazaoTh / iBocasDoMaterial : 0;
		},

		/**
		 * A boca pode descarregar? Precisa estar ligada, com a comporta aberta
		 * e com grão no silo.
		 * @param {object} oBoca boca do estado
		 * @returns {boolean}
		 */
		bocaPodeDescarregar: function (oBoca) {
			return !!oBoca.ligada && oBoca.aberturaPct > 0 && oBoca.estoqueT > 0;
		},

		/**
		 * Vazão que a estação entrega com as bocas como estão agora (t/h):
		 * soma de (vazão nominal x abertura) das bocas que podem descarregar.
		 * É a vazão usada pelo modo automático.
		 * @param {object} oEstado estado do carregamento
		 * @returns {number} t/h
		 */
		vazaoConfiguradaTh: function (oEstado) {
			return oEstado.bocas.reduce(function (fSoma, oBoca) {
				if (!Regras.bocaPodeDescarregar(oBoca)) {
					return fSoma;
				}
				return fSoma + Regras.vazaoNominalPorBocaTh(oEstado, oBoca.produto) * oBoca.aberturaPct / 100;
			}, 0);
		},

		/**
		 * Em qual seção do vagão a boca descarrega. As bocas ficam em fila
		 * sobre o vagão: o primeiro terço cai na esquerda, o do meio no
		 * centro e o último na direita.
		 * @param {number} iIndiceBoca posição da boca (0 = primeira)
		 * @param {number} iQuantidadeBocas total de bocas
		 * @returns {number} índice da seção em SECOES (0, 1 ou 2)
		 */
		secaoDaBoca: function (iIndiceBoca, iQuantidadeBocas) {
			return Math.min(SECOES.length - 1, Math.floor(iIndiceBoca * SECOES.length / Math.max(1, iQuantidadeBocas)));
		},

		/* =========================================================== */
		/* Vagão                                                       */
		/* =========================================================== */

		/**
		 * O vagão está cheio (100% da capacidade)?
		 * @param {object} oVagao vagão do estado
		 * @param {object} oComposicao dados da composição (capacidadeVagaoKg)
		 * @returns {boolean}
		 */
		vagaoCheio: function (oVagao, oComposicao) {
			return oVagao.pesoKg >= oComposicao.capacidadeVagaoKg - TOLERANCIA_CHEIO_KG;
		},

		/**
		 * O vagão passou da capacidade? Só acontece com o transbordo
		 * automático desligado (ver model/Carregamento.js).
		 * @returns {boolean}
		 */
		vagaoComExcesso: function (oVagao, oComposicao) {
			return oVagao.pesoKg > oComposicao.capacidadeVagaoKg + TOLERANCIA_CHEIO_KG;
		},

		/**
		 * Percentual de enchimento, de 0 a 100. Só devolve 100 quando o vagão
		 * está realmente cheio (99,9% aparece como 99, nunca como 100).
		 * @returns {number} inteiro de 0 a 100
		 */
		percentualVagao: function (oVagao, oComposicao) {
			if (Regras.vagaoCheio(oVagao, oComposicao)) {
				return 100;
			}
			return Math.max(0, Math.min(99, Math.floor(oVagao.pesoKg / oComposicao.capacidadeVagaoKg * 100)));
		},

		/**
		 * O carregamento do vagão terminou? Termina quando enche ou quando o
		 * sistema de origem manda o status "Carregado/Finalizado".
		 * @returns {boolean}
		 */
		carregamentoConcluido: function (oVagao, oComposicao) {
			return Regras.vagaoCheio(oVagao, oComposicao) || oVagao.statusChave === "carregado";
		},

		/**
		 * Status do vagão mostrado na tela. Ordem de prioridade:
		 *   excesso > carregado (100%) > finalizado pelo sistema > carregando > parcial > aguardando
		 * @returns {string} "excesso" | "carregado" | "finalizado" | "carregando" | "parcial" | "aguardando"
		 */
		statusVagao: function (oVagao, oComposicao) {
			if (Regras.vagaoComExcesso(oVagao, oComposicao)) { return "excesso"; }
			if (Regras.vagaoCheio(oVagao, oComposicao)) { return "carregado"; }
			if (oVagao.statusChave === "carregado") { return "finalizado"; }
			if (oVagao.statusChave === "carregando") { return "carregando"; }
			if (oVagao.pesoKg > 0) { return "parcial"; }
			return "aguardando";
		},

		/**
		 * A balança parou de mandar leituras de um vagão que está carregando?
		 * @param {object} oVagao vagão do estado
		 * @param {number} iAgoraMs hora atual (ms)
		 * @param {number} iLimiteSemDadosMs tempo máximo aceito sem leitura (ms)
		 * @returns {boolean}
		 */
		vagaoSemAtualizacao: function (oVagao, iAgoraMs, iLimiteSemDadosMs) {
			return oVagao.statusChave === "carregando" && !!oVagao.recebidoEmMs &&
				iAgoraMs - oVagao.recebidoEmMs > iLimiteSemDadosMs;
		},

		/**
		 * Índice do vagão que está recebendo carga agora: o que tem status
		 * "carregando", ainda não encheu e recebeu a leitura mais recente.
		 * @param {object} oEstado estado do carregamento
		 * @returns {number} índice em oEstado.vagoes ou -1 se nenhum
		 */
		indiceVagaoEmCarga: function (oEstado) {
			var iEncontrado = -1;
			var iMaisRecenteMs = -1;
			oEstado.vagoes.forEach(function (oVagao, iIndice) {
				var bCarregando = oVagao.statusChave === "carregando" && !Regras.vagaoCheio(oVagao, oEstado.composicao);
				if (bCarregando && (oVagao.recebidoEmMs || 0) >= iMaisRecenteMs) {
					iMaisRecenteMs = oVagao.recebidoEmMs || 0;
					iEncontrado = iIndice;
				}
			});
			return iEncontrado;
		},

		/* =========================================================== */
		/* Faturamento por vagão                                       */
		/* =========================================================== */

		/**
		 * Situação do faturamento de UM vagão.
		 *
		 *  faturado   -> a nota já foi emitida;
		 *  aguardando -> ainda não terminou de carregar;
		 *  bloqueado  -> terminou, mas tem vistoria reprovada ou excesso de peso;
		 *  liberado   -> terminou e não tem bloqueio: pode faturar.
		 *
		 * @param {object} oVagao vagão do estado
		 * @param {object} oComposicao dados da composição
		 * @returns {{situacao: string, motivo: (string|null)}}
		 */
		situacaoFaturamento: function (oVagao, oComposicao) {
			if (oVagao.fatura) {
				return { situacao: SITUACAO_FATURA.FATURADO, motivo: null };
			}
			if (!Regras.carregamentoConcluido(oVagao, oComposicao)) {
				return { situacao: SITUACAO_FATURA.AGUARDANDO, motivo: null };
			}
			if (oVagao.vistoria === "reprovada") {
				return { situacao: SITUACAO_FATURA.BLOQUEADO, motivo: MOTIVO_BLOQUEIO.VISTORIA };
			}
			if (Regras.vagaoComExcesso(oVagao, oComposicao)) {
				return { situacao: SITUACAO_FATURA.BLOQUEADO, motivo: MOTIVO_BLOQUEIO.EXCESSO };
			}
			return { situacao: SITUACAO_FATURA.LIBERADO, motivo: null };
		}
	};

	return Regras;
});
