/**
 * Carregamento
 * ------------------------------------------------------------------
 * Aplica os eventos do stream de carregamento (GET /GestaoCooperado/stream)
 * ao estado da tela. É o equivalente "real" do Simulador.passo().
 *
 * Evento (já validado por stream/EventoCarregamento):
 *   { vagaoId, pesoAtualKg, statusSistema, statusChave, dataHoraMs, recebidoEmMs, bocaNumero }
 *
 * O que o stream informa: peso e status de cada vagão.
 * O que é derivado aqui:
 *   - carga em toneladas e divisão por seção (E/C/D) pela receita do material;
 *   - vazão medida (t/h) = variação de peso / variação de tempo, com média móvel;
 *   - ligação boca -> vagão: com "BocaId" no evento, usa a boca informada;
 *     sem ele, as bocas ligadas vão para o vagão em carga mais recente,
 *     e a vazão medida é dividida entre elas proporcionalmente à abertura.
 *
 * Mesma regra do Simulador: recebe o estado e devolve um NOVO estado.
 * Só os objetos que mudam são copiados (cópia rasa).
 */
sap.ui.define([
	"./Regras"
], function (Regras) {
	"use strict";

	/** Limite de vagões criados automaticamente pelo stream (proteção contra dados inesperados). */
	var MAXIMO_VAGOES = 60;

	/** Peso da média móvel da vazão (0..1). Maior = reage mais rápido, oscila mais. */
	var SUAVIZACAO_VAZAO = 0.4;

	/** Intervalo máximo entre dois eventos para entrar no cálculo da vazão. */
	var INTERVALO_MAXIMO_VAZAO_S = 30;

	/** Status de boca que o stream pode controlar (as demais são definidas pelo operador). */
	var BOCA_LIGADA = { ativa: true, aguardandoVagao: true };

	function arredondar1(fValor) { return Math.round(fValor * 10) / 10; }

	/** Identificador do vagão para comparar com o VagaoId (sem diferença de maiúsculas/espaços). */
	function chaveVagao(sTexto) {
		return String(sTexto || "").replace(/\s+/g, "").toUpperCase();
	}

	/** Reparte a variação de carga entre as seções E/C/D conforme a receita da composição. */
	function atualizarSecoes(oVagao, fNovaCargaT, oReceita) {
		var oSecoes = Object.assign({ esquerda: 0, centro: 0, direita: 0 }, oVagao.secoes);
		var fVariacao = fNovaCargaT - oVagao.carga;
		if (fVariacao >= 0 && oReceita) {
			Regras.SECOES.forEach(function (sSecao) {
				oSecoes[sSecao] += fVariacao * oReceita.distribuicao[sSecao] / 100;
			});
		} else {
			// peso diminuiu (correção da balança, descarga): mantém a proporção atual
			var fFator = oVagao.carga > 0 ? fNovaCargaT / oVagao.carga : 0;
			Regras.SECOES.forEach(function (sSecao) { oSecoes[sSecao] *= fFator; });
		}
		Regras.SECOES.forEach(function (sSecao) { oSecoes[sSecao] = Math.round(oSecoes[sSecao] * 100) / 100; });
		return oSecoes;
	}

	var Carregamento = {

		MAXIMO_VAGOES: MAXIMO_VAGOES,

		/**
		 * Prepara o estado inicial para o modo stream: a balança é a fonte da verdade,
		 * então carga, seções e histórico de bocas do mock são zerados até chegar leitura.
		 */
		prepararEstado: function (oEstado) {
			return Object.assign({}, oEstado, {
				vagoes: oEstado.vagoes.map(function (oVagao) {
					return Object.assign({}, oVagao, {
						id: oVagao.id || oVagao.placa,
						carga: 0,
						secoes: { esquerda: 0, centro: 0, direita: 0 },
						bocas: [],
						statusSistema: "",
						statusChave: "",
						dataHoraMs: null,
						recebidoEmMs: null,
						vazaoMedidaTh: 0,
						bocaNumero: null
					});
				}),
				conexao: { status: "conectando", ultimoEventoMs: null, mensagensDescartadas: 0, vagoesIgnorados: 0 }
			});
		},

		/**
		 * Aplica os eventos na ordem em que chegaram.
		 * - Vagão desconhecido: incluído no fim da composição, sem vistoria (gera validação).
		 * - Evento mais antigo que a última leitura do vagão: ignorado (fora de ordem).
		 */
		aplicarEventos: function (oEstado, aEventos) {
			if (!aEventos.length) {
				return oEstado;
			}
			var oReceita = Regras.receita(oEstado, oEstado.composicao.produto);
			var aVagoes = oEstado.vagoes.slice();
			var oConexao = Object.assign({}, oEstado.conexao);
			var mIndicePorChave = {};
			aVagoes.forEach(function (oVagao, iIndice) { mIndicePorChave[chaveVagao(oVagao.id)] = iIndice; });

			aEventos.forEach(function (oEvento) {
				var sChave = chaveVagao(oEvento.vagaoId);
				var iIndice = mIndicePorChave[sChave];

				if (iIndice === undefined) {
					if (aVagoes.length >= MAXIMO_VAGOES) {
						oConexao.vagoesIgnorados++;
						return;
					}
					var iProximaPosicao = aVagoes.reduce(function (iMaior, oVagao) { return Math.max(iMaior, oVagao.pos); }, 0) + 1;
					aVagoes.push({
						pos: iProximaPosicao,
						id: oEvento.vagaoId,
						placa: oEvento.vagaoId,
						vistoriado: false,
						checklist: { limpeza: false, escotilhas: false, comportas: false, rodeiros: false },
						carga: 0,
						secoes: { esquerda: 0, centro: 0, direita: 0 },
						bocas: [],
						incluidoPeloStream: true,
						statusSistema: "",
						statusChave: "",
						dataHoraMs: null,
						recebidoEmMs: null,
						vazaoMedidaTh: 0,
						bocaNumero: null
					});
					iIndice = aVagoes.length - 1;
					mIndicePorChave[sChave] = iIndice;
				}

				var oAnterior = aVagoes[iIndice];
				if (oAnterior.dataHoraMs !== null && oEvento.dataHoraMs < oAnterior.dataHoraMs) {
					return;
				}

				var fNovaCargaT = arredondar1(oEvento.pesoAtualKg / 1000);

				// vazão medida (t/h)
				var fVazaoTh = 0;
				if (oEvento.statusChave === "carregando" && oAnterior.dataHoraMs !== null) {
					var fSegundos = (oEvento.dataHoraMs - oAnterior.dataHoraMs) / 1000;
					var fVariacaoT = oEvento.pesoAtualKg / 1000 - (oAnterior.pesoExatoKg !== undefined ? oAnterior.pesoExatoKg / 1000 : oAnterior.carga);
					if (fSegundos > 0 && fSegundos <= INTERVALO_MAXIMO_VAZAO_S && fVariacaoT >= 0) {
						var fInstantanea = fVariacaoT / fSegundos * 3600;
						fVazaoTh = oAnterior.vazaoMedidaTh > 0
							? oAnterior.vazaoMedidaTh * (1 - SUAVIZACAO_VAZAO) + fInstantanea * SUAVIZACAO_VAZAO
							: fInstantanea;
					} else if (fSegundos === 0) {
						fVazaoTh = oAnterior.vazaoMedidaTh;
					}
				}

				aVagoes[iIndice] = Object.assign({}, oAnterior, {
					carga: fNovaCargaT,
					pesoExatoKg: oEvento.pesoAtualKg,
					secoes: atualizarSecoes(oAnterior, fNovaCargaT, oReceita),
					statusSistema: oEvento.statusSistema,
					statusChave: oEvento.statusChave,
					dataHoraMs: oEvento.dataHoraMs,
					recebidoEmMs: oEvento.recebidoEmMs,
					vazaoMedidaTh: fVazaoTh,
					bocaNumero: oEvento.bocaNumero
				});
				oConexao.ultimoEventoMs = oEvento.recebidoEmMs;
			});

			return Object.assign({}, oEstado, { vagoes: aVagoes, conexao: oConexao });
		},

		/**
		 * Liga as bocas ao vagão em carga e reparte a vazão medida.
		 * Bocas "parada" e "siloVazio" (decisão do operador / cadastro) não são alteradas.
		 * @param {number} iLimiteSemDadosMs vagão sem leitura há mais que isso tem a vazão zerada
		 */
		sincronizarBocas: function (oEstado, iAgoraMs, iLimiteSemDadosMs) {
			function atualizado(oVagao) {
				return !!oVagao.recebidoEmMs && iAgoraMs - oVagao.recebidoEmMs <= iLimiteSemDadosMs;
			}
			var aEmCarga = oEstado.vagoes
				.filter(function (oVagao) { return oVagao.statusChave === "carregando"; })
				.sort(function (oA, oB) { return (oB.recebidoEmMs || 0) - (oA.recebidoEmMs || 0); });

			function destinoDaBoca(oBoca) {
				var oInformado = aEmCarga.filter(function (oVagao) { return oVagao.bocaNumero === oBoca.n; })[0];
				return oInformado || aEmCarga.filter(function (oVagao) { return !oVagao.bocaNumero; })[0] || null;
			}

			// 1) destino de cada boca ligada
			var aBocas = oEstado.bocas.map(function (oBoca) {
				if (!BOCA_LIGADA[oBoca.status]) {
					return oBoca;
				}
				var oDestino = destinoDaBoca(oBoca);
				return Object.assign({}, oBoca, {
					status: oDestino ? "ativa" : "aguardandoVagao",
					destino: oDestino ? oDestino.pos : null,
					vazao: 0
				});
			});

			// 2) vazão medida de cada vagão repartida entre as bocas que o alimentam
			var mBocasPorVagao = {};
			aBocas.forEach(function (oBoca, iIndice) {
				if (oBoca.status === "ativa" && oBoca.destino != null) {
					(mBocasPorVagao[oBoca.destino] = mBocasPorVagao[oBoca.destino] || []).push(iIndice);
				}
			});
			var aVagoes = oEstado.vagoes;
			var bVagoesAlterados = false;
			Object.keys(mBocasPorVagao).forEach(function (sPos) {
				var iPos = Number(sPos);
				var iIndiceVagao = aVagoes.findIndex(function (oVagao) { return oVagao.pos === iPos; });
				var oVagao = aVagoes[iIndiceVagao];
				var aIndicesBocas = mBocasPorVagao[sPos];
				var fVazaoTh = atualizado(oVagao) ? oVagao.vazaoMedidaTh : 0;
				var fSomaPesos = aIndicesBocas.reduce(function (fSoma, i) { return fSoma + Math.max(1, aBocas[i].abertura); }, 0);
				aIndicesBocas.forEach(function (i) {
					aBocas[i].vazao = Math.round(fVazaoTh * Math.max(1, aBocas[i].abertura) / fSomaPesos);
				});
				// histórico de bocas que descarregaram no vagão
				var aNumeros = aIndicesBocas.map(function (i) { return aBocas[i].n; });
				var aNovas = aNumeros.filter(function (iNumero) { return oVagao.bocas.indexOf(iNumero) < 0; });
				if (aNovas.length) {
					if (!bVagoesAlterados) { aVagoes = aVagoes.slice(); bVagoesAlterados = true; }
					aVagoes[iIndiceVagao] = Object.assign({}, oVagao, {
						bocas: oVagao.bocas.concat(aNovas).sort(function (a, b) { return a - b; })
					});
				}
			});

			return Object.assign({}, oEstado, {
				bocas: aBocas,
				vagoes: aVagoes,
				simulacao: Object.assign({}, oEstado.simulacao, { ultimaAtualizacao: new Date(iAgoraMs).toISOString() })
			});
		},

		definirStatusConexao: function (oEstado, sStatus) {
			if (oEstado.conexao.status === sStatus) {
				return oEstado;
			}
			return Object.assign({}, oEstado, { conexao: Object.assign({}, oEstado.conexao, { status: sStatus }) });
		},

		registrarMensagemDescartada: function (oEstado) {
			var oConexao = Object.assign({}, oEstado.conexao);
			oConexao.mensagensDescartadas++;
			return Object.assign({}, oEstado, { conexao: oConexao });
		}
	};

	return Carregamento;
});
