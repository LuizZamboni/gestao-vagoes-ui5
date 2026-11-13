/**
 * ModeloTela
 * ------------------------------------------------------------------
 * Transforma o ESTADO do carregamento no MODELO DE TELA (view model):
 * um objeto pronto para binding na view, com textos já formatados,
 * cores no padrão sap.ui.core.ValueState e listas no tamanho que a tela
 * mostra.
 *
 * Por que separar do estado?
 *  - a view fica só com bindings simples (sem lógica no XML);
 *  - as regras ficam em Regras.js e os textos no i18n;
 *  - o tamanho do modelo é LIMITADO: mesmo com centenas de vagões, só
 *    entram no modelo os que aparecem (últimos da lista, fila de fatura,
 *    janela da estação 3D). Isso mantém a atualização rápida.
 *
 * Módulo puro: não depende de controles UI5. Os textos vêm da função
 * fnTexto(chave, [parâmetros]), ligada ao i18n pelo controller.
 */
sap.ui.define([
	"./Regras",
	"./Formatador"
], function (Regras, Formatador) {
	"use strict";

	/** Quantos vagões aparecem na lista "Composição" (os mais recentes). */
	var VAGOES_NA_LISTA = 6;

	/** Quantas linhas aparecem na fila de faturamento. */
	var LINHAS_NA_FILA_DE_FATURA = 5;

	/** Quantas pendências de vagão aparecem uma a uma (as demais viram um resumo). */
	var PENDENCIAS_DE_VAGAO_NA_LISTA = 4;

	/** Quantos vagões a estação 3D recebe antes e depois do vagão em carga / selecionado. */
	var VIZINHOS_NA_ESTACAO = 2;

	var SITUACAO = Regras.SITUACAO_FATURA;

	/** Status do vagão -> cor (sap.ui.core.ValueState). */
	var COR_STATUS_VAGAO = {
		excesso: "Error",
		carregado: "Success",
		finalizado: "Success",
		carregando: "Information",
		parcial: "Warning",
		aguardando: "None"
	};

	/** Situação da fatura -> cor e ícone. */
	var COR_FATURA = { aguardando: "None", liberado: "Information", bloqueado: "Error", faturado: "Success" };
	var ICONE_FATURA = {
		aguardando: "sap-icon://pending",
		liberado: "sap-icon://paper-plane",
		bloqueado: "sap-icon://locked",
		faturado: "sap-icon://accept"
	};

	/** Valores mostrados no painel "vagão em foco" enquanto não existe nenhum vagão. */
	var VAGAO_EM_FOCO_VAZIO = {
		indice: -1, tituloCurto: "", placa: "", statusTexto: "", statusEstado: "None",
		cargaTexto: "0,0", cargaEstado: "None", capacidadeTexto: "", percentualTexto: "0%", larguraCss: "0%",
		previsaoTexto: "—", vazaoTexto: "—", leituraTexto: "—", bocasTexto: "—",
		vistoriaTexto: "—", vistoriaEstado: "None", faturaTexto: "—", faturaEstado: "None",
		secoes: [], checklist: []
	};

	/** Status da boca -> cor e ícone. */
	var COR_BOCA = {
		descarregando: "Success",
		aguardandoVagao: "Information",
		comportaFechada: "Warning",
		parada: "None",
		siloVazio: "Error"
	};
	var ICONE_BOCA = {
		descarregando: "sap-icon://media-play",
		aguardandoVagao: "sap-icon://pending",
		comportaFechada: "sap-icon://decline",
		parada: "sap-icon://media-pause",
		siloVazio: "sap-icon://error"
	};

	/** Status da fonte de eventos -> chave de cor da pílula do cabeçalho. */
	var CHAVE_DA_PILULA = {
		conectado: "live",
		automatico: "live",
		conectando: "wait",
		reconectando: "wait",
		parado: "paused",
		desconectado: "off",
		indisponivel: "off"
	};

	/** Limita um número ao intervalo [fMinimo, fMaximo]. */
	function limitar(fValor, fMinimo, fMaximo) {
		return Math.max(fMinimo, Math.min(fMaximo, fValor));
	}

	var ModeloTela = {

		/**
		 * Monta o modelo de tela completo.
		 *
		 * @param {object} oEstado estado do carregamento (ver model/Carregamento.js)
		 * @param {object} oTela estado da tela:
		 *        { indiceVagaoSelecionado, indiceBocaSelecionada, seguindoCarga }
		 * @param {function(string, Array=): string} fnTexto textos do i18n
		 * @param {object} oOpcoes { agoraMs, limiteSemDadosMs }
		 * @returns {object} modelo para o JSONModel da view
		 */
		montar: function (oEstado, oTela, fnTexto, oOpcoes) {
			var oContexto = ModeloTela._criarContexto(oEstado, oTela, fnTexto, oOpcoes);
			var aBocas = ModeloTela._montarBocas(oContexto);
			var oVagaoEmFoco = oContexto.temVagoes
				? ModeloTela._montarVagao(oContexto, oEstado.vagoes[oContexto.indiceSelecionado])
				: null;
			var aValidacoes = ModeloTela._montarValidacoes(oContexto, aBocas);
			var iErros = aValidacoes.filter(function (oValidacao) { return oValidacao.tipo === "Error"; }).length;

			return {
				temVagoes: oContexto.temVagoes,
				semVagoes: !oContexto.temVagoes,
				composicao: ModeloTela._montarComposicao(oContexto),
				controle: ModeloTela._montarControle(oContexto),
				receita: ModeloTela._montarReceita(oContexto),
				indicadores: ModeloTela._montarIndicadores(oContexto),
				// sem vagões a view esconde o painel, mas os bindings continuam ativos:
				// um objeto com textos vazios evita valores indefinidos no HTML
				vagaoEmFoco: oVagaoEmFoco || VAGAO_EM_FOCO_VAZIO,
				foco: {
					chave: oTela.seguindoCarga ? "auto" : "manual",
					texto: fnTexto(oTela.seguindoCarga ? "focoAuto" : "focoManual")
				},
				lista: ModeloTela._montarListaDeVagoes(oContexto),
				estacao: ModeloTela._montarEstacao(oContexto),
				bocas: aBocas,
				bocaSelecionada: aBocas[limitar(oTela.indiceBocaSelecionada || 0, 0, aBocas.length - 1)] || null,
				faturamento: ModeloTela._montarFaturamento(oContexto, oVagaoEmFoco),
				validacoes: aValidacoes,
				resumoValidacoes: {
					texto: fnTexto("resumoVal", [iErros, aValidacoes.length - iErros]),
					estado: iErros ? "Error" : (aValidacoes.length ? "Warning" : "Success"),
					semPendencias: aValidacoes.length === 0
				}
			};
		},

		/* =========================================================== */
		/* Contexto: valores calculados uma vez e usados por todos     */
		/* =========================================================== */

		/**
		 * Reúne o que várias partes do modelo precisam: índices importantes,
		 * totais e a situação de fatura de cada vagão. Percorre a lista de
		 * vagões UMA vez.
		 */
		_criarContexto: function (oEstado, oTela, fnTexto, oOpcoes) {
			var oComposicao = oEstado.composicao;
			var iAgoraMs = oOpcoes.agoraMs || Date.now();
			var iLimiteSemDadosMs = oOpcoes.limiteSemDadosMs || 15000;
			var iQuantidade = oEstado.vagoes.length;
			var iEmCarga = Regras.indiceVagaoEmCarga(oEstado);

			var oTotais = {
				pesoKg: 0, cheios: 0,
				liberados: 0, liberadosKg: 0,
				faturados: 0, faturadosKg: 0,
				bloqueados: 0, bloqueadosKg: 0,
				semVistoriaInformada: 0
			};
			var aSituacoes = oEstado.vagoes.map(function (oVagao) {
				var oSituacao = Regras.situacaoFaturamento(oVagao, oComposicao);
				oTotais.pesoKg += oVagao.pesoKg;
				if (Regras.vagaoCheio(oVagao, oComposicao)) { oTotais.cheios++; }
				if (oVagao.vistoria === "naoInformada") { oTotais.semVistoriaInformada++; }
				if (oSituacao.situacao === SITUACAO.LIBERADO) { oTotais.liberados++; oTotais.liberadosKg += oVagao.pesoKg; }
				if (oSituacao.situacao === SITUACAO.FATURADO) { oTotais.faturados++; oTotais.faturadosKg += oVagao.fatura.pesoKg; }
				if (oSituacao.situacao === SITUACAO.BLOQUEADO) { oTotais.bloqueados++; oTotais.bloqueadosKg += oVagao.pesoKg; }
				return oSituacao;
			});

			// o pórtico fica sobre o vagão em carga; sem carga, sobre o último vagão
			var iSobOPortico = iEmCarga >= 0 ? iEmCarga : Math.max(0, iQuantidade - 1);

			return {
				estado: oEstado,
				tela: oTela,
				texto: fnTexto,
				composicao: oComposicao,
				receita: Regras.receitaDoMaterial(oEstado.receitas, oComposicao.produto),
				agoraMs: iAgoraMs,
				limiteSemDadosMs: iLimiteSemDadosMs,
				quantidadeVagoes: iQuantidade,
				temVagoes: iQuantidade > 0,
				indiceEmCarga: iEmCarga,
				indiceSobOPortico: iSobOPortico,
				indiceSelecionado: limitar(oTela.indiceVagaoSelecionado || 0, 0, Math.max(0, iQuantidade - 1)),
				situacoes: aSituacoes,
				totais: oTotais,
				fonteAtiva: !!oEstado.fonte.ativa,
				aceleracao: oEstado.fonte.aceleracao || 1
			};
		},

		/**
		 * Vazão que vale para os cálculos (kg/s). Se o vagão está "Carregando"
		 * mas a balança parou de mandar leituras, a vazão é zero: a previsão
		 * não fica mostrando um valor antigo como se fosse atual.
		 */
		_vazaoEfetivaKgPorSegundo: function (oContexto, oVagao) {
			var bSemAtualizacao = Regras.vagaoSemAtualizacao(oVagao, oContexto.agoraMs, oContexto.limiteSemDadosMs);
			var bCarregando = oVagao.statusChave === "carregando" && !Regras.vagaoCheio(oVagao, oContexto.composicao);
			return bCarregando && !bSemAtualizacao && oContexto.fonteAtiva ? oVagao.vazaoKgPorSegundo : 0;
		},

		/* =========================================================== */
		/* Cabeçalho, receita e indicadores                            */
		/* =========================================================== */

		_montarComposicao: function (oContexto) {
			var oComposicao = oContexto.composicao;
			var fnTexto = oContexto.texto;
			return {
				codigo: oComposicao.codigo,
				titulo: fnTexto("composicao", [oComposicao.codigo]),
				linhaInfo: [oComposicao.produto, oComposicao.estacao, oComposicao.patio].join("  ·  "),
				estacaoTitulo: fnTexto("cardEstacao") + " · " + oComposicao.estacao,
				nivelMinimoSiloPct: oComposicao.nivelMinimoSiloPct
			};
		},

		/**
		 * Controles do cabeçalho: fonte dos eventos (automático/stream),
		 * botão Iniciar/Parar, pílula de situação e relógio.
		 */
		_montarControle: function (oContexto) {
			var oFonte = oContexto.estado.fonte;
			var oLeitura = oContexto.estado.leitura;
			var fnTexto = oContexto.texto;
			return {
				fonte: oFonte.tipo,
				automaticoSelecionado: oFonte.tipo === "automatico" ? "sim" : "nao",
				streamSelecionado: oFonte.tipo === "stream" ? "sim" : "nao",
				ativa: oFonte.ativa,
				textoIniciarParar: fnTexto(oFonte.ativa ? "acaoParar" : "acaoIniciar"),
				iconeIniciarParar: oFonte.ativa ? "sap-icon://stop" : "sap-icon://media-play",
				chaveIniciarParar: oFonte.ativa ? "parar" : "iniciar",
				situacaoChave: CHAVE_DA_PILULA[oFonte.status] || "paused",
				situacaoTexto: fnTexto("fonte.status." + oFonte.status),
				hora: Formatador.hora(oContexto.agoraMs),
				ultimoEventoTexto: oLeitura.ultimoEventoMs
					? fnTexto("ultimoEvento", [Formatador.hora(oLeitura.ultimoEventoMs)])
					: fnTexto("nenhumEvento")
			};
		},

		/** Painel da receita: material, cálculo da vazão por boca e metas por seção. */
		_montarReceita: function (oContexto) {
			var oEstado = oContexto.estado;
			var oComposicao = oContexto.composicao;
			var oReceita = oContexto.receita;
			var fnTexto = oContexto.texto;
			var iBocasDoMaterial = oEstado.bocas.filter(function (oBoca) { return oBoca.produto === oComposicao.produto; }).length;
			return {
				material: oComposicao.produto,
				codigo: oReceita ? oReceita.codigo : fnTexto("rec.semReceita"),
				calculoTexto: oReceita
					? fnTexto("rec.calculo", [
						Formatador.inteiro(oReceita.vazaoTh), iBocasDoMaterial,
						Formatador.inteiro(Regras.vazaoNominalPorBocaTh(oEstado, oComposicao.produto))
					])
					: fnTexto("rec.semReceita"),
				secoes: Regras.SECOES.map(function (sSecao) {
					var fPercentual = oReceita ? oReceita.distribuicao[sSecao] : 0;
					return {
						chave: sSecao,
						rotulo: fnTexto("sec." + sSecao),
						percentualTexto: fPercentual + "%",
						larguraCss: fPercentual + "%",
						metaTexto: Formatador.toneladas(oComposicao.capacidadeVagaoKg * fPercentual / 100) + " t"
					};
				})
			};
		},

		/** Indicadores do topo: vazão, total carregado, vagões cheios e previsão. */
		_montarIndicadores: function (oContexto) {
			var fnTexto = oContexto.texto;
			var oEstado = oContexto.estado;
			var oTotais = oContexto.totais;
			var oEmCarga = oContexto.indiceEmCarga >= 0 ? oEstado.vagoes[oContexto.indiceEmCarga] : null;
			var fVazaoKgS = oEmCarga ? ModeloTela._vazaoEfetivaKgPorSegundo(oContexto, oEmCarga) : 0;
			var fRestanteKg = oEmCarga ? Math.max(0, oContexto.composicao.capacidadeVagaoKg - oEmCarga.pesoKg) : 0;

			return {
				vazaoTexto: Formatador.inteiro(fVazaoKgS * 3.6),
				totalTexto: Formatador.toneladas(oTotais.pesoKg),
				totalSubTexto: fnTexto(oContexto.quantidadeVagoes === 1 ? "emUmVagao" : "emNVagoes", [oContexto.quantidadeVagoes]),
				cheiosTexto: String(oTotais.cheios),
				cheiosSubTexto: fnTexto("deNVagoes", [oContexto.quantidadeVagoes]),
				cheiosEstado: oTotais.cheios > 0 ? "Success" : "None",
				// tempo real de tela: no modo automático o relógio da operação anda acelerado
				previsaoTexto: fVazaoKgS > 0 ? Formatador.duracao(fRestanteKg / fVazaoKgS / oContexto.aceleracao) : "—",
				previsaoSubTexto: oEmCarga
					? fnTexto("vagaoNPercentual", [Formatador.doisDigitos(oEmCarga.indice + 1), Regras.percentualVagao(oEmCarga, oContexto.composicao)])
					: fnTexto("semVagaoEmCarga")
			};
		},

		/* =========================================================== */
		/* Vagões                                                      */
		/* =========================================================== */

		/**
		 * Dados básicos de um vagão, usados em todas as listas.
		 * @param {object} oContexto contexto de montagem
		 * @param {object} oVagao vagão do estado
		 */
		_montarResumoDoVagao: function (oContexto, oVagao) {
			var fnTexto = oContexto.texto;
			var oComposicao = oContexto.composicao;
			var sStatus = Regras.statusVagao(oVagao, oComposicao);
			var iPercentual = Regras.percentualVagao(oVagao, oComposicao);
			var sRotulo = Formatador.doisDigitos(oVagao.indice + 1);
			var oSituacao = oContexto.situacoes[oVagao.indice];
			var bSemAtualizacao = oContexto.fonteAtiva &&
				Regras.vagaoSemAtualizacao(oVagao, oContexto.agoraMs, oContexto.limiteSemDadosMs);

			return {
				indice: oVagao.indice,
				rotulo: sRotulo,
				sigla: "V" + sRotulo,
				id: oVagao.id,
				placa: oVagao.placa,
				titulo: fnTexto("vagaoN", [sRotulo]) + " · " + oVagao.placa,
				tituloCurto: fnTexto("vagaoN", [sRotulo]),
				percentual: iPercentual,
				percentualTexto: iPercentual + "%",
				larguraCss: iPercentual + "%",
				cargaTexto: Formatador.toneladas(oVagao.pesoKg),
				cargaComUnidade: Formatador.toneladas(oVagao.pesoKg) + " t",
				statusChave: sStatus,
				statusTexto: fnTexto("st." + sStatus),
				statusEstado: COR_STATUS_VAGAO[sStatus],
				carregando: sStatus === "carregando",
				semAtualizacao: bSemAtualizacao,
				vistoriaReprovada: oVagao.vistoria === "reprovada",
				faturaSituacao: oSituacao.situacao,
				faturaTexto: oVagao.fatura ? fnTexto("fat.nfCurta", [oVagao.fatura.numero]) : fnTexto("fat.sit." + oSituacao.situacao),
				faturaEstado: COR_FATURA[oSituacao.situacao],
				podeFaturar: oSituacao.situacao === SITUACAO.LIBERADO,
				selecionado: oVagao.indice === oContexto.indiceSelecionado ? "sim" : "nao"
			};
		},

		/**
		 * Modelo completo do vagão em foco (painel da esquerda): resumo +
		 * seções E/C/D, vistoria, leitura, previsão e fatura.
		 */
		_montarVagao: function (oContexto, oVagao) {
			var fnTexto = oContexto.texto;
			var oComposicao = oContexto.composicao;
			var oReceita = oContexto.receita;
			var oModelo = ModeloTela._montarResumoDoVagao(oContexto, oVagao);
			var fVazaoKgS = ModeloTela._vazaoEfetivaKgPorSegundo(oContexto, oVagao);
			var fRestanteKg = Math.max(0, oComposicao.capacidadeVagaoKg - oVagao.pesoKg);
			var oSituacao = oContexto.situacoes[oVagao.indice];

			oModelo.cargaEstado = Regras.vagaoComExcesso(oVagao, oComposicao) ? "Error" : "None";
			oModelo.capacidadeTexto = "/ " + Formatador.toneladas(oComposicao.capacidadeVagaoKg) + " t";
			oModelo.vazaoTexto = fVazaoKgS > 0 ? Formatador.inteiro(fVazaoKgS * 3.6) + " t/h" : "—";
			oModelo.previsaoTexto = fVazaoKgS > 0 ? Formatador.duracao(fRestanteKg / fVazaoKgS / oContexto.aceleracao) : "—";
			oModelo.leituraTexto = oVagao.recebidoEmMs ? Formatador.hora(oVagao.recebidoEmMs) : fnTexto("semLeitura");
			oModelo.statusSistemaTexto = oVagao.statusSistema || "—";
			oModelo.bocasTexto = oVagao.bocasQueCarregaram.length
				? oVagao.bocasQueCarregaram.map(function (iNumero) { return "B" + iNumero; }).join(" · ")
				: "—";

			oModelo.vistoriaTexto = fnTexto("vistoria." + oVagao.vistoria);
			oModelo.vistoriaEstado = { aprovada: "Success", reprovada: "Error", naoInformada: "None" }[oVagao.vistoria];
			oModelo.checklist = oVagao.checklist ? Regras.ITENS_CHECKLIST.map(function (sItem) {
				var bAprovado = !!oVagao.checklist[sItem];
				return {
					rotulo: fnTexto("check." + sItem),
					estado: bAprovado ? "Success" : "Error",
					icone: bAprovado ? "sap-icon://sys-enter-2" : "sap-icon://error"
				};
			}) : [];

			oModelo.secoes = Regras.SECOES.map(function (sSecao) {
				var fMetaKg = oComposicao.capacidadeVagaoKg * (oReceita ? oReceita.distribuicao[sSecao] : 100 / 3) / 100;
				var fCargaKg = oVagao.secoesKg[sSecao] || 0;
				var iPercentual = fMetaKg ? limitar(Math.round(fCargaKg / fMetaKg * 100), 0, 100) : 0;
				return {
					chave: sSecao,
					rotulo: fnTexto("sec." + sSecao),
					cargaTexto: Formatador.toneladas(fCargaKg),
					metaTexto: "/ " + Formatador.toneladas(fMetaKg) + " t",
					alturaCss: iPercentual + "%",
					estado: fCargaKg > fMetaKg + 1 ? "Error" : (iPercentual >= 100 ? "Success" : "None")
				};
			});

			oModelo.faturaMotivoTexto = ModeloTela._motivoDaFatura(oContexto, oVagao, oSituacao, oModelo.percentual);
			return oModelo;
		},

		/**
		 * Frase que explica a situação da fatura de um vagão.
		 * Ex.: "62% carregado · libera ao chegar em 100%".
		 */
		_motivoDaFatura: function (oContexto, oVagao, oSituacao, iPercentual) {
			var fnTexto = oContexto.texto;
			switch (oSituacao.situacao) {
				case SITUACAO.FATURADO:
					return fnTexto("fat.motivo.faturado", [oVagao.fatura.numero, Formatador.horaMinuto(oVagao.fatura.emitidaEmMs)]);
				case SITUACAO.LIBERADO:
					return fnTexto("fat.motivo.liberado");
				case SITUACAO.BLOQUEADO:
					return fnTexto("fat.motivo." + oSituacao.motivo);
				default:
					return fnTexto("fat.motivo.aguardando", [iPercentual]);
			}
		},

		/**
		 * Lista "Composição": os vagões mais recentes, em ordem, mais o
		 * resumo de quantos ficaram de fora.
		 */
		_montarListaDeVagoes: function (oContexto) {
			var fnTexto = oContexto.texto;
			var aVagoes = oContexto.estado.vagoes;
			var iInicio = Math.max(0, aVagoes.length - VAGOES_NA_LISTA);
			var iAnteriores = iInicio;
			return {
				vagoes: aVagoes.slice(iInicio).map(function (oVagao) {
					return ModeloTela._montarResumoDoVagao(oContexto, oVagao);
				}),
				resumoTexto: fnTexto("cheiosDe", [oContexto.totais.cheios, aVagoes.length]),
				temAnteriores: iAnteriores > 0,
				anterioresTexto: fnTexto(iAnteriores === 1 ? "maisUmAnterior" : "maisNAnteriores", [iAnteriores])
			};
		},

		/**
		 * Dados da estação 3D. Só vão os vagões perto do pórtico e do vagão
		 * selecionado: é o que a cena desenha.
		 */
		_montarEstacao: function (oContexto) {
			var fnTexto = oContexto.texto;
			var aVagoes = oContexto.estado.vagoes;
			var mIncluidos = {};
			[oContexto.indiceSobOPortico, oContexto.indiceSelecionado].forEach(function (iCentro) {
				for (var i = iCentro - VIZINHOS_NA_ESTACAO; i <= iCentro + VIZINHOS_NA_ESTACAO; i++) {
					if (i >= 0 && i < aVagoes.length) { mIncluidos[i] = true; }
				}
			});
			var oEmCarga = oContexto.indiceEmCarga >= 0 ? aVagoes[oContexto.indiceEmCarga] : null;
			var bFluindo = !!oEmCarga && ModeloTela._vazaoEfetivaKgPorSegundo(oContexto, oEmCarga) > 0;

			return {
				vagoes: Object.keys(mIncluidos).map(Number).sort(function (iA, iB) { return iA - iB; }).map(function (iIndice) {
					return ModeloTela._montarResumoDoVagao(oContexto, aVagoes[iIndice]);
				}),
				quantidadeVagoes: aVagoes.length,
				indiceSobOPortico: oContexto.indiceSobOPortico,
				indiceSelecionado: oContexto.indiceSelecionado,
				fluindo: bFluindo,
				textos: {
					semVagoes: fnTexto("st.txt.semVagoes"),
					locomotiva: fnTexto("st.txt.locomotiva"),
					vista3d: fnTexto("st.txt.vista3d"),
					vistaFrente: fnTexto("st.txt.vistaFrente"),
					vistaTopo: fnTexto("st.txt.vistaTopo"),
					girar: fnTexto("st.txt.girar"),
					anterior: fnTexto("st.txt.anterior"),
					proximo: fnTexto("st.txt.proximo"),
					seguirCarga: fnTexto("st.txt.seguirCarga"),
					// o controle troca {0} e {1} pela posição e pelo total; os marcadores seguem como estão
					vagaoDe: fnTexto("st.txt.vagaoDe", ["{0}", "{1}"]),
					ajuda: fnTexto("st.txt.ajuda"),
					semAtualizacao: fnTexto("st.txt.semAtualizacao")
				}
			};
		},

		/* =========================================================== */
		/* Bocas (silos)                                               */
		/* =========================================================== */

		/**
		 * Modelo das bocas. A vazão de cada boca é a parte dela na vazão
		 * medida do vagão em carga, proporcional à abertura da comporta.
		 */
		_montarBocas: function (oContexto) {
			var fnTexto = oContexto.texto;
			var oEstado = oContexto.estado;
			var oComposicao = oContexto.composicao;
			var oEmCarga = oContexto.indiceEmCarga >= 0 ? oEstado.vagoes[oContexto.indiceEmCarga] : null;
			var fVazaoVagaoTh = oEmCarga ? ModeloTela._vazaoEfetivaKgPorSegundo(oContexto, oEmCarga) * 3.6 : 0;

			// com "BocaId" no evento, só aquela boca descarrega no vagão; sem ele, todas as ligadas
			function alimentaOVagao(oBoca) {
				return !!oEmCarga && Regras.bocaPodeDescarregar(oBoca) &&
					(!oEmCarga.bocaNumero || oEmCarga.bocaNumero === oBoca.numero);
			}
			var fSomaAberturas = oEstado.bocas.filter(alimentaOVagao)
				.reduce(function (fSoma, oBoca) { return fSoma + oBoca.aberturaPct; }, 0);

			return oEstado.bocas.map(function (oBoca, iIndice) {
				var sNome = "B" + oBoca.numero;
				var oReceita = Regras.receitaDoMaterial(oEstado.receitas, oBoca.produto);
				var fNivelPct = oBoca.capacidadeT ? oBoca.estoqueT / oBoca.capacidadeT * 100 : 0;
				var iNivelPct = limitar(Math.round(fNivelPct), 0, 100);
				var bNivelBaixo = fNivelPct < oComposicao.nivelMinimoSiloPct && oBoca.estoqueT > 0;
				var bDescarregando = alimentaOVagao(oBoca) && oContexto.fonteAtiva;
				var bProdutoDivergente = !!oBoca.ligada && oBoca.produto !== oComposicao.produto;
				var fVazaoTh = bDescarregando && fSomaAberturas > 0 ? fVazaoVagaoTh * oBoca.aberturaPct / fSomaAberturas : 0;

				var sStatus;
				if (oBoca.estoqueT <= 0) { sStatus = "siloVazio"; }
				else if (!oBoca.ligada) { sStatus = "parada"; }
				else if (oBoca.aberturaPct <= 0) { sStatus = "comportaFechada"; }
				else if (bDescarregando) { sStatus = "descarregando"; }
				else { sStatus = "aguardandoVagao"; }

				var sAlerta = "";
				var sTipoAlerta = "None";
				if (bProdutoDivergente) {
					sAlerta = fnTexto("val.produto.d", [sNome, oBoca.produto, oComposicao.produto]);
					sTipoAlerta = "Error";
				} else if (sStatus === "siloVazio") {
					sAlerta = fnTexto("pop.alerta.siloVazio");
					sTipoAlerta = "Error";
				} else if (oBoca.reabastecendo) {
					sAlerta = fnTexto("pop.alerta.reabastecendo");
					sTipoAlerta = "Information";
				} else if (bNivelBaixo) {
					sAlerta = fnTexto("val.siloBaixo.d", [oBoca.silo, Formatador.inteiro(oBoca.estoqueT) + " t", iNivelPct]);
					sTipoAlerta = "Warning";
				}

				return {
					indice: iIndice,
					numero: oBoca.numero,
					nome: sNome,
					silo: oBoca.silo,
					produto: oBoca.produto,
					titulo: fnTexto("pop.titulo", [sNome, oBoca.silo]),
					secao: Regras.secaoDaBoca(iIndice, oEstado.bocas.length),
					ligada: !!oBoca.ligada,
					statusChave: sStatus,
					statusTexto: fnTexto("boca." + sStatus),
					statusEstado: COR_BOCA[sStatus],
					statusIcone: ICONE_BOCA[sStatus],
					descarregando: bDescarregando,
					fluindo: bDescarregando && fVazaoVagaoTh > 0,
					vazaoTexto: Formatador.inteiro(fVazaoTh),
					vazaoNominalTexto: oReceita
						? Formatador.inteiro(Regras.vazaoNominalPorBocaTh(oEstado, oBoca.produto)) + " t/h"
						: "—",
					receitaCodigo: oReceita ? oReceita.codigo : fnTexto("rec.semReceita"),
					aberturaPct: oBoca.aberturaPct,
					aberturaTexto: oBoca.aberturaPct + "%",
					aberturaRotulo: fnTexto("pop.comporta", [oBoca.aberturaPct]),
					nivelPct: iNivelPct,
					nivelTexto: iNivelPct + "% · " + Formatador.inteiro(oBoca.estoqueT) + " t",
					nivelEstado: bNivelBaixo || oBoca.estoqueT <= 0 ? "Error" : (fNivelPct < 35 ? "Warning" : "Success"),
					nivelBaixo: bNivelBaixo,
					reabastecendo: !!oBoca.reabastecendo,
					umidadeTexto: Formatador.umaCasa(oBoca.umidadePct) + "%",
					destinoTexto: bDescarregando ? fnTexto("vagaoN", [Formatador.doisDigitos(oEmCarga.indice + 1)]) : fnTexto("semDestino"),
					produtoDivergente: bProdutoDivergente,
					temAlerta: !!sAlerta,
					alertaTexto: sAlerta,
					alertaTipo: sTipoAlerta,
					textoAcao: fnTexto(oBoca.ligada ? "pop.desligar" : "pop.ligar"),
					tipoAcao: oBoca.ligada ? "Reject" : "Accept",
					iconeAcao: oBoca.ligada ? "sap-icon://stop" : "sap-icon://media-play"
				};
			});
		},

		/* =========================================================== */
		/* Faturamento por vagão                                       */
		/* =========================================================== */

		/**
		 * Painel de faturamento: situação do vagão em foco, totais e a fila
		 * (vagões que já terminaram de carregar: pendentes primeiro, depois
		 * os faturados; sempre os mais recentes).
		 */
		_montarFaturamento: function (oContexto, oVagaoEmFoco) {
			var fnTexto = oContexto.texto;
			var oTotais = oContexto.totais;
			var aVagoes = oContexto.estado.vagoes;
			var aSituacoes = oContexto.situacoes;

			var aPendentes = [];
			var aFaturados = [];
			for (var i = aVagoes.length - 1; i >= 0 && aPendentes.length + aFaturados.length < LINHAS_NA_FILA_DE_FATURA * 2; i--) {
				var sSituacao = aSituacoes[i].situacao;
				if (sSituacao === SITUACAO.LIBERADO || sSituacao === SITUACAO.BLOQUEADO) {
					aPendentes.push(aVagoes[i]);
				} else if (sSituacao === SITUACAO.FATURADO) {
					aFaturados.push(aVagoes[i]);
				}
			}
			var aFila = aPendentes.concat(aFaturados).slice(0, LINHAS_NA_FILA_DE_FATURA).map(function (oVagao) {
				return ModeloTela._montarResumoDoVagao(oContexto, oVagao);
			});

			function resumo(iQuantidade, fPesoKg) {
				return fnTexto(iQuantidade === 1 ? "fat.resumo1" : "fat.resumoN", [iQuantidade, Formatador.toneladas(fPesoKg)]);
			}
			var sSituacaoFoco = oVagaoEmFoco ? oVagaoEmFoco.faturaSituacao : SITUACAO.AGUARDANDO;

			return {
				chave: sSituacaoFoco,
				icone: ICONE_FATURA[sSituacaoFoco],
				tituloTexto: oVagaoEmFoco ? oVagaoEmFoco.tituloCurto : "",
				estadoTexto: fnTexto("fat.estado." + sSituacaoFoco),
				motivoTexto: oVagaoEmFoco ? oVagaoEmFoco.faturaMotivoTexto : fnTexto("fat.motivo.semVagao"),
				pesoTexto: oVagaoEmFoco ? oVagaoEmFoco.cargaTexto : "0,0",
				podeFaturarEmFoco: !!oVagaoEmFoco && oVagaoEmFoco.podeFaturar,
				textoBotaoEmFoco: oVagaoEmFoco ? fnTexto("fat.acaoFaturarVagao", [oVagaoEmFoco.rotulo]) : "",
				liberadosTexto: resumo(oTotais.liberados, oTotais.liberadosKg),
				liberadosEstado: oTotais.liberados > 0 ? "Information" : "None",
				faturadosTexto: resumo(oTotais.faturados, oTotais.faturadosKg),
				faturadosEstado: oTotais.faturados > 0 ? "Success" : "None",
				bloqueadosTexto: resumo(oTotais.bloqueados, oTotais.bloqueadosKg),
				temBloqueados: oTotais.bloqueados > 0,
				podeFaturarTodos: oTotais.liberados > 0,
				textoBotaoTodos: oTotais.liberados > 1
					? fnTexto("fat.acaoFaturarTodos", [oTotais.liberados])
					: fnTexto(oTotais.liberados === 1 ? "fat.acaoFaturarTodos1" : "fat.acaoFaturarTodos0"),
				etiquetaTexto: fnTexto(oTotais.liberados === 1 ? "fat.etiqueta1" : "fat.etiquetaN", [oTotais.liberados]),
				etiquetaEstado: oTotais.liberados > 0 ? "Information" : "None",
				fila: aFila,
				filaVazia: aFila.length === 0
			};
		},

		/* =========================================================== */
		/* Pendências (validações)                                     */
		/* =========================================================== */

		/**
		 * Lista de pendências. Erros primeiro (bloqueiam a fatura do vagão
		 * ou indicam falha), depois avisos.
		 * @param {object} oContexto contexto de montagem
		 * @param {Array<object>} aBocas modelo das bocas (de _montarBocas)
		 */
		_montarValidacoes: function (oContexto, aBocas) {
			var fnTexto = oContexto.texto;
			var oEstado = oContexto.estado;
			var oComposicao = oContexto.composicao;
			var oFonte = oEstado.fonte;
			var oLeitura = oEstado.leitura;
			var oTotais = oContexto.totais;
			var aErros = [];
			var aAvisos = [];

			function adicionar(aLista, sTipo, sTitulo, sDescricao, iIndiceVagao, iIndiceBoca) {
				aLista.push({
					tipo: sTipo,
					titulo: sTitulo,
					descricao: sDescricao,
					icone: sTipo === "Error" ? "sap-icon://error" : "sap-icon://alert",
					indiceVagao: iIndiceVagao,
					indiceBoca: iIndiceBoca,
					navegavel: iIndiceVagao >= 0 || iIndiceBoca >= 0
				});
			}

			// --- fonte dos eventos ---
			if (oFonte.ativa && (oFonte.status === "desconectado" || oFonte.status === "indisponivel")) {
				adicionar(aErros, "Error", fnTexto("val.semConexao.t"), fnTexto("val.semConexao.d"), -1, -1);
			}
			if (oFonte.ativa && oFonte.status === "reconectando") {
				adicionar(aAvisos, "Warning", fnTexto("val.reconectando.t"), fnTexto("val.reconectando.d"), -1, -1);
			}

			// --- vagões (do mais recente para o mais antigo) ---
			// A composição não tem fim, então só as pendências mais recentes aparecem
			// uma a uma; as demais entram num resumo, para a lista não crescer sem limite.
			var aErrosDeVagao = [];
			for (var i = oEstado.vagoes.length - 1; i >= 0; i--) {
				var oVagao = oEstado.vagoes[i];
				var sRotulo = Formatador.doisDigitos(oVagao.indice + 1);
				if (oVagao.fatura) {
					continue; // vagão faturado não gera pendência
				}
				if (oVagao.vistoria === "reprovada" && oVagao.pesoKg > 0) {
					adicionar(aErrosDeVagao, "Error", fnTexto("val.vistoria.t", [sRotulo]),
						fnTexto("val.vistoria.d", [oVagao.placa]), oVagao.indice, -1);
				}
				if (Regras.vagaoComExcesso(oVagao, oComposicao)) {
					adicionar(aErrosDeVagao, "Error", fnTexto("val.excesso.t", [sRotulo]), fnTexto("val.excesso.d", [
						Formatador.toneladas(oVagao.pesoKg),
						Formatador.toneladas(oComposicao.capacidadeVagaoKg),
						Formatador.toneladas(oVagao.pesoKg - oComposicao.capacidadeVagaoKg)
					]), oVagao.indice, -1);
				}
				if (oContexto.fonteAtiva && Regras.vagaoSemAtualizacao(oVagao, oContexto.agoraMs, oContexto.limiteSemDadosMs)) {
					adicionar(aAvisos, "Warning", fnTexto("val.semAtualizacao.t", [sRotulo]),
						fnTexto("val.semAtualizacao.d", [oVagao.placa, Formatador.hora(oVagao.recebidoEmMs)]), oVagao.indice, -1);
				}
			}
			var iErrosOcultos = Math.max(0, aErrosDeVagao.length - PENDENCIAS_DE_VAGAO_NA_LISTA);
			aErros = aErros.concat(aErrosDeVagao.slice(0, PENDENCIAS_DE_VAGAO_NA_LISTA));
			if (iErrosOcultos > 0) {
				adicionar(aErros, "Error",
					fnTexto(iErrosOcultos === 1 ? "val.maisPendencias1.t" : "val.maisPendenciasN.t", [iErrosOcultos]),
					fnTexto("val.maisPendencias.d"), -1, -1);
			}

			// --- bocas ---
			aBocas.forEach(function (oBoca) {
				if (oBoca.produtoDivergente) {
					adicionar(aErros, "Error", fnTexto("val.produto.t", [oBoca.nome]),
						fnTexto("val.produto.d", [oBoca.nome, oBoca.produto, oComposicao.produto]), -1, oBoca.indice);
				}
				if (oBoca.statusChave === "siloVazio") {
					adicionar(aAvisos, "Warning", fnTexto("val.siloVazio.t", [oBoca.nome]), fnTexto("val.siloVazio.d", [oBoca.silo]), -1, oBoca.indice);
				} else if (oBoca.reabastecendo) {
					adicionar(aAvisos, "Warning", fnTexto("val.reabastecendo.t", [oBoca.nome]),
						fnTexto("val.reabastecendo.d", [oBoca.silo, oBoca.nivelPct]), -1, oBoca.indice);
				} else if (oBoca.nivelBaixo) {
					adicionar(aAvisos, "Warning", fnTexto("val.siloBaixo.t", [oBoca.nome]),
						fnTexto("val.siloBaixo.d", [oBoca.silo, Formatador.inteiro(oEstado.bocas[oBoca.indice].estoqueT) + " t", oBoca.nivelPct]),
						-1, oBoca.indice);
				}
			});

			// --- avisos gerais ---
			if (oTotais.liberados > 0) {
				adicionar(aAvisos, "Warning",
					fnTexto(oTotais.liberados === 1 ? "val.liberados1.t" : "val.liberadosN.t", [oTotais.liberados]),
					fnTexto("val.liberados.d", [Formatador.toneladas(oTotais.liberadosKg)]), -1, -1);
			}
			if (oFonte.tipo === "stream" && oTotais.semVistoriaInformada > 0) {
				adicionar(aAvisos, "Warning",
					fnTexto(oTotais.semVistoriaInformada === 1 ? "val.semCadastro1.t" : "val.semCadastroN.t", [oTotais.semVistoriaInformada]),
					fnTexto("val.semCadastro.d"), -1, -1);
			}
			if (oLeitura.mensagensDescartadas > 0) {
				adicionar(aAvisos, "Warning", fnTexto("val.descartadas.t", [oLeitura.mensagensDescartadas]), fnTexto("val.descartadas.d"), -1, -1);
			}
			if (oLeitura.vagoesNaoCriados > 0) {
				adicionar(aAvisos, "Warning", fnTexto("val.limiteVagoes.t", [oEstado.opcoes.limiteVagoes]), fnTexto("val.limiteVagoes.d"), -1, -1);
			}

			return aErros.concat(aAvisos);
		}
	};

	return ModeloTela;
});
