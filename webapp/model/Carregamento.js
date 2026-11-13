/**
 * Carregamento
 * ------------------------------------------------------------------
 * Guarda o ESTADO do carregamento e as funções que o alteram.
 *
 * Regra de ouro: toda função recebe o estado atual e devolve um NOVO
 * estado. Nada é alterado no lugar e só é copiado o que mudou (cópia
 * rasa), o que mantém as atualizações baratas mesmo com muitos eventos.
 *
 * Como os eventos viram vagões (ver aplicarEventos):
 *
 *  1. Cada evento traz um VagaoId e o peso atual (kg).
 *  2. VagaoId novo -> um vagão novo entra no fim da composição.
 *     Não há limite de negócio: os vagões continuam sendo criados
 *     enquanto os eventos chegarem e param quando os eventos param.
 *  3. O vagão enche até 100% da capacidade. Com o TRANSBORDO AUTOMÁTICO
 *     ligado, o peso que passar da capacidade segue para o próximo vagão,
 *     criado na hora ("HTC-0002", "HTC-0002 #2", "HTC-0002 #3"...). É o
 *     que permite testar com um emissor que só incrementa o peso.
 *     Com o transbordo desligado, o peso acima da capacidade fica no
 *     próprio vagão e vira o alerta "excesso" (comportamento de produção).
 *  4. Se o peso de um VagaoId despenca (a balança zerou), começa um novo
 *     ciclo: os vagões anteriores ficam como estão e um vagão novo é criado.
 *  5. Vagão já faturado não muda mais.
 *
 * Estrutura do estado:
 *   composicao   dados fixos (produto, capacidadeVagaoKg...)
 *   receitas     receitas de descarga por material
 *   bocas[]      silos/bocas: ligada, aberturaPct, estoqueT...
 *   vagoes[]     vagões na ordem em que entraram (indice = posição)
 *   cadeias{}    controle por VagaoId: quais vagões ele já ocupou
 *   fonte        de onde vêm os eventos: tipo, ativa, status, aceleracao
 *   leitura      contadores: último evento, mensagens descartadas...
 *   faturamento  série e próximo número de nota
 *   opcoes       transbordoAutomatico, limiteVagoes
 */
sap.ui.define([
	"./Regras"
], function (Regras) {
	"use strict";

	/** Peso da média móvel da vazão (0..1). Maior = reage mais rápido, oscila mais. */
	var SUAVIZACAO_VAZAO = 0.4;

	/** Intervalo máximo (s) entre dois eventos para entrar no cálculo da vazão. */
	var INTERVALO_MAXIMO_VAZAO_S = 30;

	/** O peso caiu para menos desta fração do anterior: a balança zerou (novo ciclo). */
	var FRACAO_REINICIO = 0.5;

	/** Só considera reinício se o peso anterior já era relevante (kg). */
	var PESO_MINIMO_REINICIO_KG = 2000;

	/** Modo automático: o silo volta a encher quando chega no mínimo, até este nível (%). */
	var NIVEL_REABASTECIDO_PCT = 95;

	/** Modo automático: quanto o silo recupera por atualização durante o reabastecimento (%). */
	var PASSO_REABASTECIMENTO_PCT = 2;

	/* ------------------------------------------------------------------ */
	/* Funções auxiliares (privadas do módulo)                             */
	/* ------------------------------------------------------------------ */

	/**
	 * Normaliza o identificador para comparar VagaoIds sem diferença de
	 * maiúsculas ou espaços ("htc-0002 " = "HTC-0002").
	 */
	function chaveDoVagao(sVagaoId) {
		return String(sVagaoId || "").replace(/\s+/g, "").toUpperCase();
	}

	/** Traduz o campo "vistoriado" do cadastro para a situação da vistoria. */
	function situacaoDaVistoria(oCadastro) {
		if (!oCadastro || typeof oCadastro.vistoriado !== "boolean") {
			return "naoInformada";
		}
		return oCadastro.vistoriado ? "aprovada" : "reprovada";
	}

	/**
	 * Cria a estrutura de um vagão novo.
	 * @param {number} iIndice posição na composição (0 = primeiro)
	 * @param {string} sId identificador (VagaoId, com sufixo no transbordo)
	 * @param {object|null} oCadastro dados de cadastro/vistoria, se existirem
	 * @param {string} sOrigem "evento" (VagaoId novo) ou "transbordo"
	 */
	function criarVagao(iIndice, sId, oCadastro, sOrigem) {
		return {
			indice: iIndice,
			id: sId,
			placa: (oCadastro && oCadastro.placa) || sId,
			origem: sOrigem,
			vistoria: situacaoDaVistoria(oCadastro),
			checklist: (oCadastro && oCadastro.checklist) || null,
			// dados vindos dos eventos
			pesoKg: 0,
			secoesKg: { esquerda: 0, centro: 0, direita: 0 },
			statusSistema: "",
			statusChave: "",
			dataHoraMs: null,
			recebidoEmMs: null,
			vazaoKgPorSegundo: 0,
			bocaNumero: null,
			bocasQueCarregaram: [],
			cheioEmMs: null,
			// faturamento (preenchido por model/Faturamento.js)
			fatura: null
		};
	}

	/**
	 * Reparte o peso do vagão entre as seções (esquerda/centro/direita)
	 * conforme a receita do material. Sem receita, divide em partes iguais.
	 */
	function repartirNasSecoes(fPesoKg, oReceita) {
		var oSecoes = {};
		Regras.SECOES.forEach(function (sSecao) {
			var fPercentual = oReceita ? oReceita.distribuicao[sSecao] : 100 / Regras.SECOES.length;
			oSecoes[sSecao] = fPesoKg * fPercentual / 100;
		});
		return oSecoes;
	}

	/** Junta duas listas de números de boca, sem repetir e em ordem crescente. */
	function unirBocas(aAtuais, aNovas) {
		var aFaltando = aNovas.filter(function (iNumero) { return aAtuais.indexOf(iNumero) < 0; });
		if (!aFaltando.length) {
			return aAtuais;
		}
		return aAtuais.concat(aFaltando).sort(function (iA, iB) { return iA - iB; });
	}

	/**
	 * Modo automático: desconta dos silos o que foi carregado e simula o
	 * reabastecimento (o silo volta a encher quando chega no nível mínimo).
	 * No modo stream os níveis de silo não mudam: não há API para eles.
	 */
	function consumirEstoqueDosSilos(aBocas, fCarregadoT, fNivelMinimoPct) {
		var aDescarregando = aBocas.filter(Regras.bocaPodeDescarregar);
		var fSomaAberturas = aDescarregando.reduce(function (fSoma, oBoca) { return fSoma + oBoca.aberturaPct; }, 0);

		return aBocas.map(function (oBoca) {
			var fEstoqueT = oBoca.estoqueT;
			var bReabastecendo = !!oBoca.reabastecendo;

			if (fSomaAberturas > 0 && Regras.bocaPodeDescarregar(oBoca)) {
				fEstoqueT = Math.max(0, fEstoqueT - fCarregadoT * oBoca.aberturaPct / fSomaAberturas);
			}
			var fNivelPct = fEstoqueT / oBoca.capacidadeT * 100;
			if (fNivelPct <= fNivelMinimoPct) {
				bReabastecendo = true;
			}
			if (bReabastecendo) {
				fEstoqueT = Math.min(oBoca.capacidadeT, fEstoqueT + oBoca.capacidadeT * PASSO_REABASTECIMENTO_PCT / 100);
				if (fEstoqueT / oBoca.capacidadeT * 100 >= NIVEL_REABASTECIDO_PCT) {
					bReabastecendo = false;
				}
			}
			if (fEstoqueT === oBoca.estoqueT && bReabastecendo === !!oBoca.reabastecendo) {
				return oBoca;
			}
			return Object.assign({}, oBoca, { estoqueT: fEstoqueT, reabastecendo: bReabastecendo });
		});
	}

	/* ------------------------------------------------------------------ */
	/* API do módulo                                                       */
	/* ------------------------------------------------------------------ */

	var Carregamento = {

		chaveDoVagao: chaveDoVagao,

		/**
		 * Cria o estado inicial: composição vazia, pronta para receber eventos.
		 * @param {object} oCadastro conteúdo do mockData.json (no futuro: API de cadastro)
		 * @param {object} oOpcoes { fonte: "automatico"|"stream", aceleracao, transbordoAutomatico, limiteVagoes }
		 * @returns {object} estado
		 */
		criarEstadoInicial: function (oCadastro, oOpcoes) {
			var bAutomatico = oOpcoes.fonte === "automatico";
			return {
				composicao: Object.assign({}, oCadastro.composicao),
				receitas: oCadastro.receitas.slice(),
				bocas: oCadastro.bocas.map(function (oBoca) { return Object.assign({ reabastecendo: false }, oBoca); }),
				vagoes: [],
				cadeias: {},
				fonte: {
					tipo: bAutomatico ? "automatico" : "stream",
					ativa: false,
					status: "parado",
					// só o modo automático acelera o relógio; no stream é sempre tempo real
					aceleracao: bAutomatico ? Math.max(1, oOpcoes.aceleracao || 1) : 1
				},
				leitura: {
					ultimoEventoMs: null,
					eventosAplicados: 0,
					mensagensDescartadas: 0,
					vagoesNaoCriados: 0
				},
				faturamento: Object.assign({}, oCadastro.faturamento),
				opcoes: {
					transbordoAutomatico: oOpcoes.transbordoAutomatico !== false,
					limiteVagoes: oOpcoes.limiteVagoes || 2000
				}
			};
		},

		/**
		 * Aplica uma lista de eventos (em ordem de chegada) e devolve o novo estado.
		 * As regras estão descritas no cabeçalho deste arquivo.
		 *
		 * @param {object} oEstado estado atual
		 * @param {Array<object>} aEventos eventos já validados (stream/EventoCarregamento)
		 * @param {function(string): (object|null)} fnBuscarCadastro devolve o cadastro
		 *        (placa, vistoria, checklist) de um VagaoId, ou null se não existir
		 * @returns {object} novo estado
		 */
		aplicarEventos: function (oEstado, aEventos, fnBuscarCadastro) {
			if (!aEventos.length) {
				return oEstado;
			}
			var oComposicao = oEstado.composicao;
			var fCapacidadeKg = oComposicao.capacidadeVagaoKg;
			var bTransbordo = oEstado.opcoes.transbordoAutomatico;
			var oReceita = Regras.receitaDoMaterial(oEstado.receitas, oComposicao.produto);
			var aBocasDescarregando = oEstado.bocas.filter(Regras.bocaPodeDescarregar)
				.map(function (oBoca) { return oBoca.numero; });

			var aVagoes = oEstado.vagoes.slice();
			var mCadeias = Object.assign({}, oEstado.cadeias);
			var mCadeiasCopiadas = {};
			var oLeitura = Object.assign({}, oEstado.leitura);
			var fTotalCarregadoKg = 0;

			aEventos.forEach(function (oEvento) {
				var sChave = chaveDoVagao(oEvento.vagaoId);

				// cadeia = histórico deste VagaoId (copiada uma vez por lote antes de alterar)
				if (!mCadeiasCopiadas[sChave]) {
					var oOriginal = mCadeias[sChave];
					mCadeias[sChave] = oOriginal
						? Object.assign({}, oOriginal, { indicesDosVagoes: oOriginal.indicesDosVagoes.slice() })
						: { indicesDosVagoes: [], inicioDoCiclo: 0, ultimoPesoKg: null, dataHoraMs: null, vazaoKgPorSegundo: 0 };
					mCadeiasCopiadas[sChave] = true;
				}
				var oCadeia = mCadeias[sChave];

				// evento mais antigo que o último recebido deste vagão: chegou fora de ordem
				if (oCadeia.dataHoraMs !== null && oEvento.dataHoraMs < oCadeia.dataHoraMs) {
					return;
				}

				// a balança zerou? começa um ciclo novo, em um vagão novo
				var bReinicio = oCadeia.ultimoPesoKg !== null &&
					oCadeia.ultimoPesoKg >= PESO_MINIMO_REINICIO_KG &&
					oEvento.pesoAtualKg < oCadeia.ultimoPesoKg * FRACAO_REINICIO;
				if (bReinicio) {
					oCadeia.inicioDoCiclo = oCadeia.indicesDosVagoes.length;
					oCadeia.vazaoKgPorSegundo = 0;
				}

				// vazão medida = variação de peso / variação de tempo (média móvel)
				var fVazaoKgS = 0;
				if (oEvento.statusChave === "carregando" && oCadeia.ultimoPesoKg !== null && !bReinicio) {
					var fSegundos = (oEvento.dataHoraMs - oCadeia.dataHoraMs) / 1000;
					var fVariacaoKg = oEvento.pesoAtualKg - oCadeia.ultimoPesoKg;
					if (fSegundos > 0 && fSegundos <= INTERVALO_MAXIMO_VAZAO_S && fVariacaoKg >= 0) {
						var fInstantanea = fVariacaoKg / fSegundos;
						fVazaoKgS = oCadeia.vazaoKgPorSegundo > 0
							? oCadeia.vazaoKgPorSegundo * (1 - SUAVIZACAO_VAZAO) + fInstantanea * SUAVIZACAO_VAZAO
							: fInstantanea;
					} else if (fSegundos === 0) {
						fVazaoKgS = oCadeia.vazaoKgPorSegundo;
					}
				}

				// quantos vagões este peso ocupa (com transbordo, o excedente segue para o próximo)
				var iVagoesOcupados = bTransbordo
					? Math.max(1, Math.ceil((oEvento.pesoAtualKg - Regras.TOLERANCIA_CHEIO_KG) / fCapacidadeKg))
					: 1;

				for (var iPasso = 0; iPasso < iVagoesOcupados; iPasso++) {
					var iPosicaoNaCadeia = oCadeia.inicioDoCiclo + iPasso;
					var iIndiceVagao = oCadeia.indicesDosVagoes[iPosicaoNaCadeia];

					if (iIndiceVagao === undefined) {
						if (aVagoes.length >= oEstado.opcoes.limiteVagoes) {
							oLeitura.vagoesNaoCriados++; // proteção de memória (ver opcoes.limiteVagoes)
							break;
						}
						var bPrimeiroDoId = iPosicaoNaCadeia === 0;
						var sIdVagao = bPrimeiroDoId ? oEvento.vagaoId : oEvento.vagaoId + " #" + (iPosicaoNaCadeia + 1);
						var oCadastro = bPrimeiroDoId && fnBuscarCadastro ? fnBuscarCadastro(oEvento.vagaoId) : null;
						iIndiceVagao = aVagoes.length;
						aVagoes.push(criarVagao(iIndiceVagao, sIdVagao, oCadastro, bPrimeiroDoId ? "evento" : "transbordo"));
						oCadeia.indicesDosVagoes[iPosicaoNaCadeia] = iIndiceVagao;
					}

					var oAnterior = aVagoes[iIndiceVagao];
					if (oAnterior.fatura) {
						continue; // vagão faturado não muda mais
					}

					var bRecebendoAgora = iPasso === iVagoesOcupados - 1;
					var fPesoKg = bTransbordo
						? Math.min(fCapacidadeKg, Math.max(0, oEvento.pesoAtualKg - iPasso * fCapacidadeKg))
						: oEvento.pesoAtualKg;
					var bCheio = fPesoKg >= fCapacidadeKg - Regras.TOLERANCIA_CHEIO_KG;

					// vagões anteriores da cadeia já encheram: nada a atualizar
					if (!bRecebendoAgora && oAnterior.pesoKg === fPesoKg && oAnterior.statusChave === "carregado") {
						continue;
					}

					fTotalCarregadoKg += Math.max(0, fPesoKg - oAnterior.pesoKg);
					aVagoes[iIndiceVagao] = Object.assign({}, oAnterior, {
						pesoKg: fPesoKg,
						secoesKg: repartirNasSecoes(fPesoKg, oReceita),
						statusSistema: bRecebendoAgora ? oEvento.statusSistema : oAnterior.statusSistema,
						statusChave: bRecebendoAgora ? oEvento.statusChave : "carregado",
						dataHoraMs: oEvento.dataHoraMs,
						recebidoEmMs: oEvento.recebidoEmMs,
						vazaoKgPorSegundo: bRecebendoAgora && !bCheio ? fVazaoKgS : 0,
						bocaNumero: oEvento.bocaNumero,
						bocasQueCarregaram: oEvento.statusChave === "carregando"
							? unirBocas(oAnterior.bocasQueCarregaram, oEvento.bocaNumero ? [oEvento.bocaNumero] : aBocasDescarregando)
							: oAnterior.bocasQueCarregaram,
						cheioEmMs: bCheio ? (oAnterior.cheioEmMs || oEvento.recebidoEmMs) : null
					});
				}

				oCadeia.ultimoPesoKg = oEvento.pesoAtualKg;
				oCadeia.dataHoraMs = oEvento.dataHoraMs;
				oCadeia.vazaoKgPorSegundo = fVazaoKgS;
				oLeitura.ultimoEventoMs = oEvento.recebidoEmMs;
				oLeitura.eventosAplicados++;
			});

			// só o modo automático simula o consumo dos silos
			var aBocas = oEstado.fonte.tipo === "automatico" && fTotalCarregadoKg > 0
				? consumirEstoqueDosSilos(oEstado.bocas, fTotalCarregadoKg / 1000, oComposicao.nivelMinimoSiloPct)
				: oEstado.bocas;

			return Object.assign({}, oEstado, { vagoes: aVagoes, cadeias: mCadeias, leitura: oLeitura, bocas: aBocas });
		},

		/* =========================================================== */
		/* Fonte dos eventos (stream ou automático)                    */
		/* =========================================================== */

		/**
		 * Registra o status informado pela fonte (ver CarregamentoStream.STATUS).
		 * @param {string} sStatus "conectando", "conectado", "automatico", "parado"...
		 */
		definirStatusDaFonte: function (oEstado, sStatus) {
			if (oEstado.fonte.status === sStatus) {
				return oEstado;
			}
			return Object.assign({}, oEstado, { fonte: Object.assign({}, oEstado.fonte, { status: sStatus }) });
		},

		/**
		 * Marca se o usuário deixou a fonte ligada (Iniciar) ou desligada (Parar).
		 * @param {boolean} bAtiva true = ligada
		 */
		definirFonteAtiva: function (oEstado, bAtiva) {
			return Object.assign({}, oEstado, { fonte: Object.assign({}, oEstado.fonte, { ativa: !!bAtiva }) });
		},

		/** Conta uma mensagem recebida fora do formato esperado (foi descartada). */
		registrarMensagemDescartada: function (oEstado) {
			var oLeitura = Object.assign({}, oEstado.leitura);
			oLeitura.mensagensDescartadas++;
			return Object.assign({}, oEstado, { leitura: oLeitura });
		},

		/* =========================================================== */
		/* Operação das bocas                                          */
		/* =========================================================== */

		/**
		 * Liga ou desliga uma boca (ação do operador).
		 * TODO integração: chamar a API de operação das bocas.
		 * @param {number} iIndiceBoca posição em oEstado.bocas
		 */
		alternarBoca: function (oEstado, iIndiceBoca) {
			var oBoca = oEstado.bocas[iIndiceBoca];
			if (!oBoca) {
				return oEstado;
			}
			var aBocas = oEstado.bocas.slice();
			aBocas[iIndiceBoca] = Object.assign({}, oBoca, { ligada: !oBoca.ligada });
			return Object.assign({}, oEstado, { bocas: aBocas });
		},

		/**
		 * Define a abertura da comporta de uma boca (ação do operador).
		 * TODO integração: chamar a API de operação das bocas.
		 * @param {number} iIndiceBoca posição em oEstado.bocas
		 * @param {number} fAberturaPct de 0 a 100
		 */
		definirAberturaDaBoca: function (oEstado, iIndiceBoca, fAberturaPct) {
			var oBoca = oEstado.bocas[iIndiceBoca];
			if (!oBoca) {
				return oEstado;
			}
			var aBocas = oEstado.bocas.slice();
			aBocas[iIndiceBoca] = Object.assign({}, oBoca, {
				aberturaPct: Math.max(0, Math.min(100, Math.round(fAberturaPct)))
			});
			return Object.assign({}, oEstado, { bocas: aBocas });
		}
	};

	return Carregamento;
});
