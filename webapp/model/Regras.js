/**
 * Regras de negócio e montagem do modelo de visualização (view model).
 *
 * Módulo puro (sem dependências de controles UI5): recebe o estado bruto
 * (vindo hoje do mockData.json e, no futuro, do backend/OData) e devolve um
 * objeto pronto para binding na view. Todos os textos vêm do i18n pela função
 * t(chave, [args]) recebida como parâmetro.
 *
 * Para a implementação definitiva, mova as regras de validação/fatura para o
 * backend e mantenha aqui apenas a preparação dos dados de tela.
 */
sap.ui.define([], function () {
	"use strict";

	var NF1 = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
	var NF0 = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });

	var CHECKLIST = ["limpeza", "escotilhas", "comportas", "rodeiros"];

	/** Seções do vagão onde a boca descarrega (ordem de exibição). */
	var SECOES = ["esquerda", "centro", "direita"];

	/** Status do vagão -> sap.ui.core.ValueState */
	var ESTADO_VAGAO = {
		bloqueado: "Error",
		excesso: "Error",
		carregando: "Information",
		carregado: "Success",
		parcial: "Warning",
		aguardando: "None"
	};

	/** Status da boca -> ValueState e ícone */
	var ESTADO_BOCA = {
		ativa: "Success",
		parada: "None",
		aguardandoVagao: "Information",
		siloVazio: "Error"
	};
	var ICONE_BOCA = {
		ativa: "sap-icon://media-play",
		parada: "sap-icon://media-pause",
		aguardandoVagao: "sap-icon://pending",
		siloVazio: "sap-icon://error"
	};

	function f1(v) { return NF1.format(v || 0); }
	function f0(v) { return NF0.format(v || 0); }
	function pad(n) { return String(n).padStart(2, "0"); }

	/** minutos -> "mm:ss" ou "1h05" */
	function duracao(min) {
		if (!isFinite(min) || min <= 0) {
			return "—";
		}
		var s = Math.round(min * 60);
		var h = Math.floor(s / 3600);
		var m = Math.floor((s % 3600) / 60);
		var ss = s % 60;
		return h ? h + "h" + pad(m) : pad(m) + ":" + pad(ss);
	}

	function hora(d) {
		return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
	}

	var Regras = {

		formatar: { f1: f1, f0: f0, pad: pad, duracao: duracao },

		SECOES: SECOES,

		/**
		 * Receita de descarga do material: vazão da boca (t/h) e quanto dela vai
		 * para cada seção do vagão (% esquerda / centro / direita).
		 */
		receita: function (s, sMaterial) {
			return (s.receitas || []).filter(function (r) { return r.material === sMaterial; })[0] || null;
		},

		/** Seções formatadas para exibição (com meta por vagão, se informada). */
		secoesReceita: function (oReceita, t, nMetaVagao) {
			return SECOES.map(function (k) {
				var nPct = oReceita ? oReceita.distribuicao[k] : 0;
				return {
					key: k,
					label: t("sec." + k),
					sigla: t("sec." + k + ".sigla"),
					pct: nPct,
					pctTxt: nPct + "%",
					pctCss: nPct + "%",
					metaTxt: nMetaVagao ? f1(nMetaVagao * nPct / 100) + " t" : ""
				};
			});
		},

		/** Carga-alvo de um vagão (limite menos margem de segurança). */
		alvo: function (oComposicao) {
			return Math.round((oComposicao.limiteVagao - oComposicao.margemAlvo) * 10) / 10;
		},

		/** Vagão pode receber grão? (vistoriado e abaixo da carga-alvo) */
		disponivel: function (oVagao, oComposicao) {
			return !!oVagao && oVagao.vistoriado && oVagao.carga < Regras.alvo(oComposicao) - 0.05;
		},

		/** Próximo vagão disponível depois da posição informada (circular). */
		proximoVagao: function (oState, iAposPos) {
			var c = oState.composicao;
			var aDisp = oState.vagoes.filter(function (w) { return Regras.disponivel(w, c); });
			return aDisp.filter(function (w) { return w.pos > iAposPos; })[0] || aDisp[0] || null;
		},

		statusVagao: function (oVagao, oComposicao, mDestinosAtivos) {
			if (!oVagao.vistoriado) { return "bloqueado"; }
			if (oVagao.carga > oComposicao.limiteVagao) { return "excesso"; }
			if (mDestinosAtivos[oVagao.pos]) { return "carregando"; }
			if (oVagao.carga >= oComposicao.limiteVagao * 0.94) { return "carregado"; }
			if (oVagao.carga > 0) { return "parcial"; }
			return "aguardando";
		},

		/**
		 * Monta o view model completo.
		 * @param {object} s  estado bruto
		 * @param {object} ui estado de tela { sel: índice do vagão, bocaSel: índice da boca }
		 * @param {function} t função de textos i18n: t(chave, aArgs)
		 */
		montarViewModel: function (s, ui, t) {
			var c = s.composicao;
			var LIM = c.limiteVagao;
			var ALVO = Regras.alvo(c);
			var bEmitida = !!s.fatura.emitida;
			var bRodando = !!s.simulacao.rodando && !bEmitida;

			var oRecComp = Regras.receita(s, c.produto);
			var aAtivas = s.bocas.filter(function (b) { return b.status === "ativa" && b.destino != null; });
			var mDestinos = {};
			var mVazaoPorVagao = {};
			aAtivas.forEach(function (b) {
				(mDestinos[b.destino] = mDestinos[b.destino] || []).push(b.n);
				mVazaoPorVagao[b.destino] = (mVazaoPorVagao[b.destino] || 0) + b.vazao;
			});

			/* ---------------- Vagões ---------------- */
			var aVagoes = s.vagoes.map(function (w, i) {
				var sSt = Regras.statusVagao(w, c, mDestinos);
				var iPct = Math.round(w.carga / LIM * 100);
				var sLabel = pad(w.pos);
				var nVazao = mVazaoPorVagao[w.pos] || 0;
				var aSec = SECOES.map(function (k, ix) {
					var nMeta = LIM * (oRecComp ? oRecComp.distribuicao[k] : 100 / 3) / 100;
					var nCarga = w.secoes ? w.secoes[k] : 0;
					var nFill = nMeta ? Math.round(nCarga / nMeta * 100) : 0;
					return {
						key: k,
						sigla: t("sec." + k + ".sigla"),
						label: t("sec." + k),
						carga: nCarga,
						fillPct: Math.max(0, Math.min(100, nFill)),
						fillCss: Math.max(0, Math.min(100, nFill)) + "%",
						cargaTxt: f1(nCarga),
						metaTxt: f1(nMeta) + " t",
						txt: f1(nCarga) + " / " + f1(nMeta) + " t",
						state: nCarga > nMeta + 0.05 ? "Error" : (nFill >= 94 ? "Success" : "None")
					};
				});
				return {
					index: i,
					pos: w.pos,
					label: sLabel,
					id: w.id,
					titulo: t("vagaoN", [sLabel]) + " · " + w.id,
					tituloCurto: t("vagaoN", [sLabel]),
					vistoriado: w.vistoriado,
					vistText: t(w.vistoriado ? "vistoriado" : "naoVistoriado"),
					vistState: w.vistoriado ? "Success" : "Error",
					vistIcon: w.vistoriado ? "sap-icon://shield" : "sap-icon://locked",
					carga: w.carga,
					cargaTxt: f1(w.carga),
					cargaState: w.carga > LIM ? "Error" : "None",
					limiteTxt: f1(LIM) + " t",
					taraTxt: f1(c.taraVagao) + " t",
					brutoTxt: f1(w.carga + c.taraVagao) + " t",
					pct: Math.max(0, Math.min(100, iPct)),
					pctCss: Math.max(0, Math.min(100, iPct)) + "%",
					limiteBarTxt: "/ " + f1(LIM) + " t",
					pctTxt: iPct + "%",
					statusKey: sSt,
					statusText: t("st." + sSt),
					statusState: ESTADO_VAGAO[sSt],
					carregando: sSt === "carregando",
					excesso: w.carga > LIM,
					bocasHist: w.bocas.slice(),
					bocasAtivas: mDestinos[w.pos] || [],
					cargaUnTxt: f1(w.carga) + " t",
					secoes: aSec,
					bocasTxt: w.bocas.length ? w.bocas.map(function (n) { return "B" + n; }).join(" · ") : "—",
					etaTxt: nVazao > 0 ? duracao(Math.max(0, ALVO - w.carga) / nVazao * 60) : "—",
					checks: CHECKLIST.map(function (k) {
						var bOk = !!w.checklist[k];
						return {
							key: k,
							label: t("check." + k),
							ok: bOk,
							text: t(bOk ? "checkOk" : "checkReprovado"),
							state: bOk ? "Success" : "Error",
							icon: bOk ? "sap-icon://sys-enter-2" : "sap-icon://error",
							iconColor: bOk ? "Positive" : "Negative"
						};
					}),
					podeRetirar: w.carga > LIM && !bEmitida,
					retirarTxt: t("acaoRetirarExcesso", [f1(Math.max(0, w.carga - LIM))])
				};
			});

			/* ---------------- Bocas (cones de descarga) ---------------- */
			var aBocas = s.bocas.map(function (b, j) {
				var nNivel = b.capacidade ? b.estoque / b.capacidade * 100 : 0;
				var iNivel = Math.max(0, Math.min(100, Math.round(nNivel)));
				var bAtiva = b.status === "ativa" && b.destino != null;
				var oDest = null;
				var iDestIndex = -1;
				s.vagoes.forEach(function (w, i) { if (w.pos === b.destino) { oDest = w; iDestIndex = i; } });
				var nVzDest = oDest ? (mVazaoPorVagao[oDest.pos] || 0) : 0;
				var sEta = bAtiva && nVzDest > 0 ? duracao(Math.max(0, ALVO - oDest.carga) / nVzDest * 60) : "—";
				var bBaixo = nNivel < c.nivelMinimoSiloPct && b.estoque > 0;
				var oRec = Regras.receita(s, b.produto);
				var bDivergente = bAtiva && b.produto !== c.produto;
				var sNome = "B" + b.n;

				var sAlerta = "";
				var sAlertaTipo = "None";
				if (bDivergente) { sAlerta = t("val.produto.d", [sNome, b.produto, c.produto]); sAlertaTipo = "Error"; }
				else if (b.status === "siloVazio") { sAlerta = t("pop.alerta.siloVazio"); sAlertaTipo = "Error"; }
				else if (b.status === "aguardandoVagao") { sAlerta = t("pop.alerta.aguardando"); sAlertaTipo = "Information"; }
				else if (bBaixo) { sAlerta = t("val.siloBaixo.d", [b.silo, f0(b.estoque) + " t", iNivel]); sAlertaTipo = "Warning"; }

				var bLigada = bAtiva || b.status === "aguardandoVagao";
				return {
					index: j,
					n: b.n,
					nome: sNome,
					silo: b.silo,
					produto: b.produto,
					titulo: t("pop.titulo", [sNome, b.silo]),
					status: b.status,
					statusText: t("boca." + b.status),
					statusState: ESTADO_BOCA[b.status],
					statusIcon: ICONE_BOCA[b.status],
					ativa: bAtiva,
					vazao: bAtiva ? b.vazao : 0,
					vazaoTxt: f0(bAtiva ? b.vazao : 0),
					nominalTxt: oRec ? f0(oRec.vazao) + " t/h" : "—",
					receitaCodigo: oRec ? oRec.codigo : t("rec.semReceita"),
					receitaSecoes: Regras.secoesReceita(oRec, t),
					receitaDistTxt: oRec ? SECOES.map(function (k) { return t("sec." + k + ".sigla") + " " + oRec.distribuicao[k]; }).join(" · ") : "",
					abertura: b.abertura,
					aberturaTxt: b.abertura + "%",
					aberturaLabel: t("pop.comporta", [b.abertura]),
					estoqueTxt: f0(b.estoque) + " t",
					capacidadeTxt: f0(b.capacidade) + " t",
					nivelPct: iNivel,
					nivelTxt: iNivel + "% · " + f0(b.estoque) + " t",
					nivelState: bBaixo || b.estoque <= 0 ? "Error" : (nNivel < 35 ? "Warning" : "Success"),
					nivelBaixo: bBaixo,
					umidadeTxt: t("umidadeTxt", [f1(b.umidade)]),
					destino: bAtiva ? b.destino : null,
					destinoIndex: bAtiva ? iDestIndex : -1,
					destinoKey: b.destino != null ? String(b.destino) : "",
					destinoLabel: bAtiva ? "V" + pad(b.destino) : "—",
					destinoTxt: bAtiva ? t("destinoTxt", [pad(b.destino)]) : t("semDestino"),
					etaTxt: sEta,
					turnoTxt: f1(b.descarregadoTurno),
					produtoDivergente: bDivergente,
					temAlerta: !!sAlerta,
					alertaTxt: sAlerta,
					alertaTipo: sAlertaTipo,
					os: b.os || "",
					podeOperar: b.status !== "siloVazio" && !!oRec && !bEmitida,
					ligada: bLigada,
					acaoTexto: t(bLigada ? "pop.parar" : "pop.iniciar"),
					acaoTipo: bLigada ? "Reject" : "Accept",
					acaoIcone: bLigada ? "sap-icon://stop" : "sap-icon://media-play"
				};
			});

			var nTurnoMax = aBocas.reduce(function (a, b) { return Math.max(a, s.bocas[b.index].descarregadoTurno); }, 0);
			var nTurnoTotal = s.bocas.reduce(function (a, b) { return a + b.descarregadoTurno; }, 0);
			aBocas.forEach(function (b) {
				b.turnoPctCss = (nTurnoMax ? Math.round(s.bocas[b.index].descarregadoTurno / nTurnoMax * 100) : 0) + "%";
				b.turnoUnTxt = b.turnoTxt + " t";
			});

			/* ---------------- Validações ---------------- */
			var aVal = [];
			function add(sType, sTitle, sDesc, iVagao, iBoca) {
				aVal.push({
					type: sType,
					state: sType,
					title: sTitle,
					description: sDesc,
					subtitle: sDesc,
					infoText: t(sType === "Error" ? "sevErro" : "sevAviso"),
					icon: sType === "Error" ? "sap-icon://error" : "sap-icon://alert",
					vagaoIndex: iVagao,
					bocaIndex: iBoca,
					navegavel: iVagao >= 0 || iBoca >= 0
				});
			}
			s.vagoes.forEach(function (w, i) {
				if (!w.vistoriado) {
					add("Error", t("val.semVistoria.t", [pad(w.pos)]), t("val.semVistoria.d", [w.id]), i, -1);
				}
				if (w.carga > LIM) {
					add("Error", t("val.excesso.t", [pad(w.pos)]),
						t("val.excesso.d", [f1(w.carga), f1(LIM), f1(w.carga - LIM)]), i, -1);
				}
			});
			aBocas.forEach(function (b) {
				if (b.produtoDivergente) {
					add("Error", t("val.produto.t", [b.nome]), t("val.produto.d", [b.nome, b.produto, c.produto]), -1, b.index);
				}
			});
			var nErros = aVal.length;
			aBocas.forEach(function (b) {
				if (b.status === "siloVazio") {
					add("Warning", t("val.siloVazio.t", [b.nome]), t("val.siloVazio.d", [b.silo]), -1, b.index);
				} else if (b.nivelBaixo) {
					add("Warning", t("val.siloBaixo.t", [b.nome]), t("val.siloBaixo.d", [b.silo, b.estoqueTxt, b.nivelPct]), -1, b.index);
				}
			});
			var nAguardando = s.vagoes.filter(function (w) {
				return w.vistoriado && w.carga === 0 && !mDestinos[w.pos];
			}).length;
			if (nAguardando > 0) {
				add("Warning", nAguardando === 1 ? t("val.aguardando1.t") : t("val.aguardandoN.t", [nAguardando]),
					t("val.aguardando.d"), -1, -1);
			}
			var nAvisos = aVal.length - nErros;

			/* ---------------- Totais / KPIs ---------------- */
			var nTotal = s.vagoes.reduce(function (a, w) { return a + w.carga; }, 0);
			var nCap = s.vagoes.length * LIM;
			var iTotalPct = Math.round(nTotal / nCap * 100);
			var nCarregados = s.vagoes.filter(function (w) { return w.carga > 0; }).length;
			var nVist = s.vagoes.filter(function (w) { return w.vistoriado; }).length;
			var nVazaoTotal = aAtivas.reduce(function (a, b) { return a + b.vazao; }, 0);
			var nRestante = s.vagoes.reduce(function (a, w) {
				return a + (w.vistoriado ? Math.max(0, ALVO - w.carga) : 0);
			}, 0);
			var sResumoVal = t("resumoVal", [nErros, nAvisos]);

			/* ---------------- Fatura ---------------- */
			var bPodeEmitir = nErros === 0 && nTotal > 0 && !bEmitida;
			var sBotao;
			if (bEmitida) { sBotao = t("fat.botaoEmitida"); }
			else if (bPodeEmitir) { sBotao = t("acaoEmitirFatura"); }
			else { sBotao = nErros === 1 ? t("fat.resolva1") : t("fat.resolvaN", [nErros]); }

			var iSel = Math.max(0, Math.min(aVagoes.length - 1, ui.sel || 0));
			var iBocaSel = Math.max(0, Math.min(aBocas.length - 1, ui.bocaSel || 0));

			return {
				composicao: {
					codigo: c.codigo,
					titulo: t("composicao", [c.codigo]),
					subtitulo: c.patio,
					linhaInfo: [c.produto, c.estacao, c.patio].join("  ·  "),
					produto: c.produto,
					estacaoTitulo: t("cardEstacao") + " · " + c.estacao,
					estacaoSub: t("cardEstacaoSub", [c.produto]),
					nivelMinimoSiloPct: c.nivelMinimoSiloPct
				},
				receita: {
					material: c.produto,
					codigo: oRecComp ? oRecComp.codigo : t("rec.semReceita"),
					vazaoTxt: oRecComp ? f0(oRecComp.vazao) : "—",
					bocasTxt: t("rec.bocasMaterial", [s.bocas.filter(function (b) { return b.produto === c.produto; }).length]),
					secoes: Regras.secoesReceita(oRecComp, t, ALVO)
				},
				estacaoTextos: {
					comporta: t("st.txt.comporta"),
					vazao: t("st.txt.vazao"),
					eta: t("st.txt.eta"),
					bocas: t("st.txt.bocas"),
					locomotiva: t("st.txt.locomotiva"),
					tracao: t("st.txt.tracao"),
					locoMov: t("st.txt.locoMov"),
					locoParada: t("st.txt.locoParada"),
					minimo: t("st.txt.minimo"),
					legVist: t("st.txt.legVist"),
					legNaoVist: t("st.txt.legNaoVist"),
					legCarregando: t("st.txt.legCarregando"),
					legFluxo: t("st.txt.legFluxo"),
					legSel: t("st.txt.legSel"),
					legMin: t("st.txt.legMin"),
					anteriores: t("st.txt.anteriores"),
					proximos: t("st.txt.proximos")
				},
				view: {
					sel: iSel,
					bocaSel: iBocaSel,
					running: bRodando,
					rodandoFlag: !!s.simulacao.rodando,
					focoLabel: t(ui.auto ? "focoAuto" : "focoManual"),
					focoKey: ui.auto ? "auto" : "manual",
					liveKey: bEmitida ? "done" : (bRodando ? "live" : "paused"),
					hora: hora(new Date(s.simulacao.ultimaAtualizacao)),
					liveText: bEmitida ? t("statusFaturada") : (s.simulacao.rodando ? t("statusAoVivo") : t("statusPausado")),
					liveState: bEmitida ? "Success" : (bRodando ? "Information" : "None"),
					liveIcon: bEmitida ? "sap-icon://accept" : (bRodando ? "sap-icon://status-in-process" : "sap-icon://media-pause"),
					simTexto: s.simulacao.rodando ? t("acaoPausar") : t("acaoRetomar"),
					simIcone: s.simulacao.rodando ? "sap-icon://media-pause" : "sap-icon://media-play",
					nErros: nErros,
					nAvisos: nAvisos,
					nMsgsTxt: String(aVal.length),
					temMsgs: aVal.length > 0,
					temErros: nErros > 0,
					semPendencias: aVal.length === 0,
					resumoValidacoes: sResumoVal,
					ultimaAtualizacao: t("ultimaAtualizacao", [hora(new Date(s.simulacao.ultimaAtualizacao))])
				},
				kpi: {
					vazaoTxt: f0(nVazaoTotal),
					totalTxt: f1(nTotal),
					totalPct: Math.min(100, iTotalPct),
					capTxt: "/ " + f0(nCap) + " t",
					turnoTxt: f1(nTurnoTotal),
					carregadosTxt: t("carregadosDe", [nCarregados, s.vagoes.length]),
					bocasAtivasTxt: t("bocasAtivas", [aAtivas.length, s.bocas.length]),
					totalPctCss: Math.min(100, iTotalPct) + "%",
					mediaUnTxt: f1(nCarregados ? nTotal / nCarregados : 0) + " t",
					totalPctTxt: t("pctCapacidade", [iTotalPct, f1(nCap)]),
					vistTxt: nVist + "/" + s.vagoes.length,
					vistState: nVist === s.vagoes.length ? "Success" : "Error",
					etaTxt: nVazaoTotal > 0 ? duracao(nRestante / nVazaoTotal * 60) : "—",
					mediaTxt: f1(nCarregados ? nTotal / nCarregados : 0),
					pendTxt: sResumoVal,
					pendState: nErros ? "Error" : (nAvisos ? "Warning" : "Success"),
					resumoCurto: t("resumoCurto", [f1(nTotal), f0(nVazaoTotal), sResumoVal])
				},
				vagoes: aVagoes,
				bocas: aBocas,
				sel: aVagoes[iSel],
				bocaSel: aBocas[iBocaSel],
				destinos: s.vagoes.filter(function (w) { return Regras.disponivel(w, c); }).map(function (w) {
					return { key: String(w.pos), text: t("vagaoN", [pad(w.pos)]) + " · " + f1(w.carga) + " t" };
				}),
				validacoes: aVal,
				fatura: {
					emitida: bEmitida,
					podeEmitir: bPodeEmitir,
					numeroTxt: bEmitida ? s.fatura.numero : t("fat.pendente"),
					statusText: bEmitida ? t("fat.emitida", [s.fatura.hora]) : (bPodeEmitir ? t("fat.pronta") : t("fat.bloqueada")),
					statusState: bEmitida ? "Success" : (bPodeEmitir ? "Information" : "Error"),
					vagoesTxt: t("fat.vagoesTxt", [nCarregados, s.vagoes.length]),
					pesoTxt: f1(nTotal) + " t",
					botaoTexto: sBotao,
					botaoIcone: bEmitida ? "sap-icon://accept" : "sap-icon://paper-plane",
					nCarregados: nCarregados
				}
			};
		}
	};

	return Regras;
});
