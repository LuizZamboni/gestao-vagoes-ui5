/**
 * Main.controller
 * ------------------------------------------------------------------
 * Liga as três partes da tela:
 *
 *   FONTE DE EVENTOS  ->  ESTADO  ->  MODELO DE TELA  ->  VIEW
 *
 *  1. Fonte de eventos (uma por vez, as duas com a mesma interface):
 *       - "automatico": model/stream/CarregamentoAutomatico.js gera o
 *         enchimento na própria tela (testes e demonstração, sem servidor);
 *       - "stream": model/stream/CarregamentoStream.js recebe os eventos
 *         SSE de GET {servidor}/GestaoCooperado/stream.
 *     Configuração: manifest.json > sap.ui5 > config > carregamentoStream.
 *
 *  2. Os eventos entram em uma fila. A cada "intervaloAtualizacaoTelaMs"
 *     a fila é aplicada ao estado (model/Carregamento.js). O estado nunca
 *     é alterado no lugar: cada função devolve um estado novo.
 *
 *  3. model/ModeloTela.js transforma o estado nos textos e valores que a
 *     view mostra. O JSONModel é somente leitura (OneWay).
 *
 *  4. Toda ação do usuário (iniciar, parar, faturar, ligar boca...) passa
 *     por um handler "on..." deste controller, que troca o estado e
 *     republica a tela.
 *
 * Convenção de nomes (padrão UI5): o = objeto, a = array, s = string,
 * i = inteiro, f = decimal, b = booleano, fn = função, p = Promise.
 */
sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageToast",
	"sap/ui/core/Theming",
	"sap/base/Log",
	"../model/Regras",
	"../model/Carregamento",
	"../model/Faturamento",
	"../model/ModeloTela",
	"../model/stream/CarregamentoStream",
	"../model/stream/CarregamentoAutomatico"
], function (Controller, JSONModel, MessageToast, Theming, Log, Regras, Carregamento, Faturamento, ModeloTela,
	CarregamentoStream, CarregamentoAutomatico) {
	"use strict";

	var NOME_COMPONENTE_LOG = "vagoes.dashboard.Main";

	/** Tipos de fonte de eventos. */
	var FONTE_AUTOMATICA = "automatico";
	var FONTE_STREAM = "stream";

	/** Máximo de eventos guardados com a aba oculta (proteção de memória). */
	var LIMITE_EVENTOS_NA_FILA = 2000;

	/** Sem eventos, a tela ainda é recalculada a cada X ms (relógio e alerta "sem leitura"). */
	var INTERVALO_SEM_EVENTOS_MS = 1000;

	/** Depois de uma seleção manual, a tela volta a seguir o vagão em carga após este tempo. */
	var TEMPO_DE_SELECAO_MANUAL_MS = 20000;

	/** Temas claro/escuro e a chave onde a escolha fica salva no navegador. */
	var TEMA_ESCURO = "sap_horizon_dark";
	var TEMA_CLARO = "sap_horizon";
	var CHAVE_DO_TEMA_SALVO = "vagoes.dashboard.tema";

	return Controller.extend("vagoes.dashboard.controller.Main", {

		/* =========================================================== */
		/* Ciclo de vida                                               */
		/* =========================================================== */

		/** Cria os modelos, lê a configuração e inicia a fonte de eventos. */
		onInit: function () {
			this._oEstado = null;             // estado do carregamento (model/Carregamento.js)
			this._oFonteDeEventos = null;     // CarregamentoAutomatico ou CarregamentoStream
			this._aEventosNaFila = [];        // eventos recebidos e ainda não aplicados
			this._bPrecisaPublicar = false;
			this._iUltimaPublicacaoMs = 0;
			// o que o usuário está vendo (não faz parte do estado do carregamento)
			this._oTela = {
				indiceVagaoSelecionado: 0,
				indiceBocaSelecionada: 0,
				seguindoCarga: true,
				selecaoManualEmMs: 0
			};

			// modelo de tela: somente leitura, as ações passam pelo controller
			this._oModeloDeTela = new JSONModel();
			this._oModeloDeTela.setDefaultBindingMode("OneWay");
			this.getView().setModel(this._oModeloDeTela);

			// modelo "ui": só o que é da interface (tema claro/escuro)
			this._oModeloDeInterface = new JSONModel({ temaClaro: false });
			this.getView().setModel(this._oModeloDeInterface, "ui");
			this._restaurarTemaSalvo();

			var oComponente = this.getOwnerComponent();
			var oModeloDeCadastro = oComponente.getModel("mock");
			var pTextos = Promise.resolve(oComponente.getModel("i18n").getResourceBundle());
			this._oConfiguracao = Object.assign({}, oComponente.getManifestEntry("/sap.ui5/config/carregamentoStream"));

			Promise.all([pTextos, oModeloDeCadastro.dataLoaded()]).then(function (aResultados) {
				var oTextos = aResultados[0];
				this._fnTexto = function (sChave, aParametros) { return oTextos.getText(sChave, aParametros); };
				this._oCadastro = oModeloDeCadastro.getData();
				this._usarFonte(this._fonteInicial());
				this._iniciarAtualizacaoPeriodica();
			}.bind(this)).catch(function (oErro) {
				Log.error("Falha ao carregar os dados iniciais", oErro && oErro.message, NOME_COMPONENTE_LOG);
			});
		},

		/** Ao sair do app (navegação no Launchpad): fecha a conexão e os temporizadores. */
		onExit: function () {
			clearInterval(this._iTemporizador);
			this._encerrarFonte();
			if (this._fnAoMudarVisibilidade) {
				document.removeEventListener("visibilitychange", this._fnAoMudarVisibilidade);
			}
		},

		/* =========================================================== */
		/* Fonte de eventos: automático ou stream                      */
		/* =========================================================== */

		/**
		 * Fonte usada ao abrir a tela: "fonteInicial" do manifest. A página de
		 * demonstração (index-cdn.html) força o modo automático por meta tag,
		 * porque lá não existe servidor de stream.
		 * @returns {string} "automatico" ou "stream"
		 */
		_fonteInicial: function () {
			var bPaginaDeDemonstracao = !!document.querySelector("meta[name='vagoes-modo-demonstracao'][content='true']");
			if (bPaginaDeDemonstracao || this._oConfiguracao.fonteInicial === FONTE_AUTOMATICA) {
				return FONTE_AUTOMATICA;
			}
			return FONTE_STREAM;
		},

		/**
		 * Troca a fonte de eventos: encerra a atual, zera a composição e
		 * começa a receber da nova.
		 * @param {string} sTipo "automatico" ou "stream"
		 */
		_usarFonte: function (sTipo) {
			var oConfigAutomatico = Object.assign({}, this._oConfiguracao.automatico);
			oConfigAutomatico.aceleracao = CarregamentoAutomatico.limitarAceleracao(oConfigAutomatico.aceleracao || 1);

			this._encerrarFonte();
			this._aEventosNaFila = [];
			this._oEstado = Carregamento.criarEstadoInicial(this._oCadastro, {
				fonte: sTipo,
				aceleracao: oConfigAutomatico.aceleracao,
				transbordoAutomatico: this._oConfiguracao.transbordoAutomatico !== false,
				limiteVagoes: this._oConfiguracao.limiteVagoes
			});
			this._oTela.indiceVagaoSelecionado = 0;
			this._oTela.seguindoCarga = true;
			this._oTela.selecaoManualEmMs = 0;

			// as duas fontes avisam o controller pelos mesmos callbacks
			var mCallbacks = {
				aoReceberEvento: this._aoReceberEvento.bind(this),
				aoMudarStatusConexao: this._aoMudarStatusDaFonte.bind(this),
				aoDescartarMensagem: this._aoDescartarMensagem.bind(this)
			};
			if (sTipo === FONTE_AUTOMATICA) {
				oConfigAutomatico.capacidadeVagaoKg = this._oEstado.composicao.capacidadeVagaoKg;
				this._oFonteDeEventos = new CarregamentoAutomatico(oConfigAutomatico, mCallbacks, function () {
					// a vazão do gerador acompanha as bocas ligadas e a abertura das comportas
					return Regras.vazaoConfiguradaTh(this._oEstado);
				}.bind(this));
			} else {
				this._oFonteDeEventos = new CarregamentoStream(this._oConfiguracao, mCallbacks);
			}
			this._iniciarFonte();
		},

		/** Começa (ou volta) a receber eventos. */
		_iniciarFonte: function () {
			this._oEstado = Carregamento.definirFonteAtiva(this._oEstado, true);
			this._oFonteDeEventos.iniciar();
			this._publicar();
		},

		/** Para de receber eventos. O que já foi carregado continua na tela. */
		_pararFonte: function () {
			this._oFonteDeEventos.parar();
			this._aplicarEventosDaFila();
			this._oEstado = Carregamento.definirFonteAtiva(this._oEstado, false);
			this._publicar();
		},

		/** Fecha a fonte atual (troca de fonte ou saída do app). */
		_encerrarFonte: function () {
			if (this._oFonteDeEventos) {
				this._oFonteDeEventos.parar();
				this._oFonteDeEventos = null;
			}
		},

		/** Callback das fontes: chegou um evento já validado. Só entra na fila. */
		_aoReceberEvento: function (oEvento) {
			this._aEventosNaFila.push(oEvento);
			if (this._aEventosNaFila.length > LIMITE_EVENTOS_NA_FILA) {
				this._compactarFila();
			}
		},

		/** Callback das fontes: mudou a situação (conectando, ao vivo, parado...). */
		_aoMudarStatusDaFonte: function (sStatus) {
			if (this._oEstado) {
				this._oEstado = Carregamento.definirStatusDaFonte(this._oEstado, sStatus);
				this._bPrecisaPublicar = true;
			}
		},

		/** Callback do stream: uma mensagem fora do formato foi descartada. */
		_aoDescartarMensagem: function () {
			if (this._oEstado) {
				this._oEstado = Carregamento.registrarMensagemDescartada(this._oEstado);
				this._bPrecisaPublicar = true;
			}
		},

		/**
		 * Mantém só os 2 últimos eventos de cada vagão (bastam para o peso e a
		 * vazão). Usado quando a fila cresce demais, por exemplo com a aba oculta.
		 */
		_compactarFila: function () {
			var mEventosPorVagao = {};
			this._aEventosNaFila.forEach(function (oEvento) {
				var aDoVagao = mEventosPorVagao[oEvento.vagaoId] = mEventosPorVagao[oEvento.vagaoId] || [];
				aDoVagao.push(oEvento);
				if (aDoVagao.length > 2) { aDoVagao.shift(); }
			});
			this._aEventosNaFila = Object.keys(mEventosPorVagao)
				.reduce(function (aTodos, sVagaoId) { return aTodos.concat(mEventosPorVagao[sVagaoId]); }, [])
				.sort(function (oA, oB) { return oA.recebidoEmMs - oB.recebidoEmMs; });
		},

		/* =========================================================== */
		/* Atualização da tela                                         */
		/* =========================================================== */

		/** Liga o temporizador que aplica a fila e atualiza a tela. */
		_iniciarAtualizacaoPeriodica: function () {
			var iIntervaloMs = Math.max(200, this._oConfiguracao.intervaloAtualizacaoTelaMs || 500);
			this._iTemporizador = setInterval(this._atualizarPeriodicamente.bind(this), iIntervaloMs);

			// ao voltar para a aba, atualiza na hora com o que ficou na fila
			this._fnAoMudarVisibilidade = function () {
				if (!document.hidden) { this._atualizarPeriodicamente(); }
			}.bind(this);
			document.addEventListener("visibilitychange", this._fnAoMudarVisibilidade);
		},

		/** Uma rodada do temporizador: aplica a fila e publica, se houver o que mostrar. */
		_atualizarPeriodicamente: function () {
			if (!this._oEstado || document.hidden) {
				return; // aba oculta: os eventos ficam na fila até o usuário voltar
			}
			var bTemEventos = this._aEventosNaFila.length > 0;
			var bPassouOIntervalo = Date.now() - this._iUltimaPublicacaoMs >= INTERVALO_SEM_EVENTOS_MS;
			if (!bTemEventos && !this._bPrecisaPublicar && !bPassouOIntervalo) {
				return;
			}
			this._aplicarEventosDaFila();
			this._publicar();
		},

		/** Passa os eventos da fila para o estado. */
		_aplicarEventosDaFila: function () {
			if (!this._aEventosNaFila.length) {
				return;
			}
			var aEventos = this._aEventosNaFila;
			this._aEventosNaFila = [];
			this._oEstado = Carregamento.aplicarEventos(this._oEstado, aEventos, this._buscarCadastroDoVagao.bind(this));
		},

		/**
		 * Cadastro (placa e vistoria) de um vagão que apareceu nos eventos.
		 * TODO integração: trocar por uma consulta à API de cadastro/vistoria.
		 * @param {string} sVagaoId identificador vindo do evento
		 * @returns {object|null} { placa, vistoriado, checklist } ou null se não cadastrado
		 */
		_buscarCadastroDoVagao: function (sVagaoId) {
			var aCadastrados = this._oCadastro.cadastroVagoes || [];
			for (var i = 0; i < aCadastrados.length; i++) {
				if (aCadastrados[i].id === sVagaoId) {
					return aCadastrados[i];
				}
			}
			// no modo automático os vagões são inventados: o gerador simula o cadastro
			var oFonte = this._oFonteDeEventos;
			return oFonte && oFonte.buscarCadastro ? oFonte.buscarCadastro(sVagaoId) : null;
		},

		/** Monta o modelo de tela a partir do estado e entrega para a view. */
		_publicar: function () {
			if (!this._oEstado || !this._fnTexto) {
				return;
			}
			var iAgoraMs = Date.now();
			this._atualizarVagaoEmFoco(iAgoraMs);
			this._oModeloDeTela.setData(ModeloTela.montar(this._oEstado, this._oTela, this._fnTexto, {
				agoraMs: iAgoraMs,
				limiteSemDadosMs: (this._oConfiguracao.segundosSemDadosParaAlerta || 15) * 1000
			}));
			this._bPrecisaPublicar = false;
			this._iUltimaPublicacaoMs = iAgoraMs;
		},

		/**
		 * Decide qual vagão fica em foco. Por padrão a tela segue o vagão em
		 * carga; depois de uma seleção manual, espera um tempo antes de voltar.
		 */
		_atualizarVagaoEmFoco: function (iAgoraMs) {
			var oTela = this._oTela;
			var iUltimo = Math.max(0, this._oEstado.vagoes.length - 1);
			if (!oTela.seguindoCarga && iAgoraMs - oTela.selecaoManualEmMs >= TEMPO_DE_SELECAO_MANUAL_MS) {
				oTela.seguindoCarga = true;
			}
			if (oTela.seguindoCarga) {
				var iEmCarga = Regras.indiceVagaoEmCarga(this._oEstado);
				oTela.indiceVagaoSelecionado = iEmCarga >= 0 ? iEmCarga : iUltimo;
			}
			oTela.indiceVagaoSelecionado = Math.min(oTela.indiceVagaoSelecionado, iUltimo);
		},

		/**
		 * Coloca um vagão em foco por escolha do usuário.
		 * @param {number} iIndice posição do vagão na composição
		 */
		_selecionarVagao: function (iIndice) {
			if (!this._oEstado || iIndice < 0 || iIndice >= this._oEstado.vagoes.length) {
				return;
			}
			this._oTela.indiceVagaoSelecionado = iIndice;
			this._oTela.seguindoCarga = false;
			this._oTela.selecaoManualEmMs = Date.now();
			this._publicar();
		},

		/** Lê um valor do modelo de tela, ex.: this._lerDaTela("/bocaSelecionada"). */
		_lerDaTela: function (sCaminho) {
			return this._oModeloDeTela.getProperty(sCaminho);
		},

		/* =========================================================== */
		/* Cabeçalho: fonte, iniciar/parar, reiniciar e tema           */
		/* =========================================================== */

		/** Botão "Automático": a tela gera o enchimento sozinha. */
		onUsarFonteAutomatica: function () {
			this._trocarFonte(FONTE_AUTOMATICA, "msgFonteAutomatico");
		},

		/** Botão "Stream": recebe os eventos do servidor. */
		onUsarFonteStream: function () {
			this._trocarFonte(FONTE_STREAM, "msgFonteStream");
		},

		_trocarFonte: function (sTipo, sChaveDaMensagem) {
			if (!this._oEstado || this._oEstado.fonte.tipo === sTipo) {
				return;
			}
			this._usarFonte(sTipo);
			MessageToast.show(this._fnTexto(sChaveDaMensagem));
		},

		/** Botão "Parar" / "Iniciar": interrompe e retoma de onde parou. */
		onIniciarOuParar: function () {
			if (!this._oEstado) {
				return;
			}
			if (this._oEstado.fonte.ativa) {
				this._pararFonte();
				MessageToast.show(this._fnTexto("msgParado"));
			} else {
				this._iniciarFonte();
				MessageToast.show(this._fnTexto("msgIniciado"));
			}
		},

		/** Botão "Reiniciar": zera a composição e começa de novo com a mesma fonte. */
		onReiniciar: function () {
			if (!this._oEstado) {
				return;
			}
			this._usarFonte(this._oEstado.fonte.tipo);
			MessageToast.show(this._fnTexto("msgReiniciado"));
		},

		/** Botão de tema: alterna entre escuro e claro e guarda a escolha. */
		onAlternarTema: function () {
			var sTema = this._oModeloDeInterface.getProperty("/temaClaro") ? TEMA_ESCURO : TEMA_CLARO;
			this._aplicarTema(sTema);
			try { window.localStorage.setItem(CHAVE_DO_TEMA_SALVO, sTema); } catch (oErro) { /* navegador sem armazenamento */ }
		},

		_restaurarTemaSalvo: function () {
			var sTemaSalvo = null;
			try { sTemaSalvo = window.localStorage.getItem(CHAVE_DO_TEMA_SALVO); } catch (oErro) { /* navegador sem armazenamento */ }
			if (sTemaSalvo === TEMA_CLARO || sTemaSalvo === TEMA_ESCURO) {
				this._aplicarTema(sTemaSalvo);
			} else {
				this._oModeloDeInterface.setProperty("/temaClaro", Theming.getTheme() === TEMA_CLARO);
			}
		},

		_aplicarTema: function (sTema) {
			if (Theming.getTheme() !== sTema) {
				Theming.setTheme(sTema);
			}
			this._oModeloDeInterface.setProperty("/temaClaro", sTema === TEMA_CLARO);
		},

		/* =========================================================== */
		/* Vagões: seleção                                             */
		/* =========================================================== */

		/** Clique em um vagão (ou nas setas ‹ ›) da estação 3D. */
		onSelecionarVagaoNaEstacao: function (oEvento) {
			this._selecionarVagao(oEvento.getParameter("indice"));
		},

		/** Clique na sigla de um vagão nas listas (composição e fila de faturamento). */
		onSelecionarVagaoDaLista: function (oEvento) {
			this._selecionarVagao(oEvento.getSource().getBindingContext().getProperty("indice"));
		},

		/** Botão "Seguir carga" da estação: volta a acompanhar o vagão em carregamento. */
		onSeguirCarga: function () {
			this._oTela.seguindoCarga = true;
			this._publicar();
		},

		/* =========================================================== */
		/* Faturamento por vagão                                       */
		/* =========================================================== */

		/** Botão "Faturar" do painel: fatura o vagão em foco. */
		onFaturarVagaoEmFoco: function () {
			this._faturarVagao(this._oTela.indiceVagaoSelecionado);
		},

		/** Botão "Faturar" de uma linha da fila. */
		onFaturarVagaoDaFila: function (oEvento) {
			this._faturarVagao(oEvento.getSource().getBindingContext().getProperty("indice"));
		},

		/** Botão "Faturar os N liberados": fatura todos os vagões cheios e sem bloqueio. */
		onFaturarLiberados: function () {
			if (!this._oEstado) {
				return;
			}
			var iLiberados = Faturamento.quantidadeLiberados(this._oEstado);
			if (!iLiberados) {
				return;
			}
			this._oEstado = Faturamento.faturarLiberados(this._oEstado, Date.now());
			this._publicar();
			MessageToast.show(this._fnTexto("fat.msgFaturados", [iLiberados]));
		},

		/**
		 * Fatura um vagão. A regra (só cheio e sem bloqueio) está em
		 * model/Faturamento.js: se não puder, o estado volta igual.
		 * @param {number} iIndice posição do vagão na composição
		 */
		_faturarVagao: function (iIndice) {
			if (!this._oEstado) {
				return;
			}
			var oEstadoNovo = Faturamento.faturarVagao(this._oEstado, iIndice, Date.now());
			if (oEstadoNovo === this._oEstado) {
				return; // não estava liberado
			}
			this._oEstado = oEstadoNovo;
			this._publicar();
			var oVagao = oEstadoNovo.vagoes[iIndice];
			MessageToast.show(this._fnTexto("fat.msgFaturado", [String(iIndice + 1).padStart(2, "0"), oVagao.fatura.numero]));
		},

		/* =========================================================== */
		/* Bocas: popover, ligar/desligar e comporta                   */
		/* =========================================================== */

		/** Clique em um silo da estação 3D: abre o popover da boca. */
		onSelecionarBocaNaEstacao: function (oEvento) {
			this._abrirPopoverDaBoca(oEvento.getParameter("indice"), oEvento.getParameter("elemento"));
		},

		/**
		 * @param {number} iIndiceBoca posição da boca
		 * @param {HTMLElement|sap.ui.core.Control} vAncora onde o popover aponta
		 */
		_abrirPopoverDaBoca: function (iIndiceBoca, vAncora) {
			this._oTela.indiceBocaSelecionada = iIndiceBoca;
			this._publicar();
			// o fragmento é carregado só na primeira vez
			if (!this._pPopoverDaBoca) {
				this._pPopoverDaBoca = this.loadFragment({ name: "vagoes.dashboard.view.BocaPopover" });
			}
			this._pPopoverDaBoca.then(function (oPopover) {
				oPopover.openBy(vAncora || this.byId("estacao"));
			}.bind(this));
		},

		onFecharPopover: function () {
			this.byId("bocaPopover").close();
		},

		/** Botão do popover: liga ou desliga a boca selecionada. */
		onLigarOuDesligarBoca: function () {
			var oBoca = this._lerDaTela("/bocaSelecionada");
			this._oEstado = Carregamento.alternarBoca(this._oEstado, this._oTela.indiceBocaSelecionada);
			this._publicar();
			MessageToast.show(this._fnTexto(oBoca.ligada ? "pop.msgDesligada" : "pop.msgLigada", [oBoca.numero]));
		},

		/** Slider do popover: abertura da comporta (0 a 100%). */
		onMudarAberturaDaBoca: function (oEvento) {
			this._oEstado = Carregamento.definirAberturaDaBoca(
				this._oEstado, this._oTela.indiceBocaSelecionada, oEvento.getParameter("value"));
			this._publicar();
		},

		/* =========================================================== */
		/* Pendências                                                  */
		/* =========================================================== */

		/** Clique em uma pendência: leva ao vagão ou abre a boca relacionada. */
		onAbrirPendencia: function (oEvento) {
			var oLink = oEvento.getSource();
			var oPendencia = oLink.getBindingContext().getObject();
			if (oPendencia.indiceVagao >= 0) {
				this._selecionarVagao(oPendencia.indiceVagao);
			} else if (oPendencia.indiceBoca >= 0) {
				this._abrirPopoverDaBoca(oPendencia.indiceBoca, oLink);
			}
		}
	});
});
