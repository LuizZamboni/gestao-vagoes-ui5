/**
 * Cena3D
 * ------------------------------------------------------------------
 * Desenha a estação de carregamento em 3D usando apenas HTML e CSS
 * (transformações 3D). Não usa bibliotecas externas nem WebGL: funciona
 * dentro do Fiori Launchpad sem dependências e respeita o tema.
 *
 * O que aparece na cena:
 *  - o pórtico com os silos (bocas): nível de grão, funil e bico;
 *  - o fluxo de grão caindo do bico até o vagão que está sob o pórtico;
 *  - a composição: locomotiva e vagões transparentes, enchendo até 100%;
 *  - etiquetas que ficam sempre viradas para quem olha;
 *  - uma barra com vistas (3D, Frente, Topo), navegação entre vagões,
 *    "seguir carga" e o giro automático.
 *
 * Como o trem anda: o pórtico é fixo. Quando o carregamento passa para o
 * vagão seguinte, o TREM desliza para a esquerda e o novo vagão para sob
 * as bocas. Ao selecionar outro vagão, é a CÂMERA que se desloca até ele.
 *
 * Desempenho: a cena é montada uma vez. Depois, cada atualização só troca
 * textos, classes e transformações que mudaram (as animações não
 * reiniciam). Só existem elementos para os vagões próximos do pórtico e
 * do vagão selecionado, mesmo que a composição tenha centenas de vagões.
 *
 * Uso:
 *   var oCena = new Cena3D(oElementoHospedeiro, {
 *       aoSelecionarVagao: function (iIndice, oElemento) {},
 *       aoSelecionarBoca:  function (iIndice, oElemento) {},
 *       aoSeguirCarga:     function () {}
 *   });
 *   oCena.atualizar({ bocas, vagoes, quantidadeVagoes, indiceSobOPortico,
 *                     indiceSelecionado, fluindo, nivelMinimoPct, textos });
 */
sap.ui.define([
	"./Dom",
	"./Camera3D"
], function (Dom, Camera3D) {
	"use strict";

	/* ------------------------------------------------------------------ */
	/* Geometria da cena (em px "do mundo"; a cena inteira é escalada)     */
	/* Eixos: X ao longo do trilho, Y altura (negativo = para cima), Z     */
	/* profundidade (positivo = para a frente). O chão fica em Y = 0.      */
	/* ------------------------------------------------------------------ */
	var G = {
		passoVagao: 430,          // distância entre o centro de dois vagões
		comprimentoVagao: 384,
		alturaVagao: 116,
		profundidadeVagao: 118,
		alturaRodas: 30,
		alturaChassi: 8,
		larguraSilo: 50,
		profundidadeSilo: 86,
		alturaSilo: 128,
		alturaFunil: 44,
		larguraBico: 14,
		alturaBico: 10,
		folgaBicoVagao: 30,       // vão entre o bico e o topo do vagão
		larguraEnquadrada: 1000,  // área do mundo que deve caber na tela
		alturaEnquadrada: 540
	};
	G.yBaseVagao = -(G.alturaRodas + G.alturaChassi);
	G.yTopoVagao = G.yBaseVagao - G.alturaVagao;
	G.yFundoGrao = G.yBaseVagao - 4;
	G.alturaMaximaGrao = G.alturaVagao - 10;
	G.yBico = G.yTopoVagao - G.folgaBicoVagao;
	G.yBaseFunil = G.yBico - G.alturaBico;
	G.yBaseSilo = G.yBaseFunil - G.alturaFunil;
	G.yTopoSilo = G.yBaseSilo - G.alturaSilo;
	G.zTrilho = G.profundidadeVagao / 2 - 14;
	G.centroVertical = Math.round(-(G.yTopoSilo - 40) / 2);

	/**
	 * Transformação das etiquetas: desfaz o giro da câmera para o texto ficar
	 * sempre de frente para quem olha, e ancora a etiqueta pelo centro da base.
	 * As variáveis --e3-guinada e --e3-inclinacao são escritas pela Camera3D.
	 */
	var VIRADA_PARA_A_CAMERA =
		"rotateY(calc(var(--e3-guinada) * -1)) rotateX(var(--e3-inclinacao)) translate(-50%, -100%)";

	/** Caixas opacas: sem as faces que a câmera nunca vê. */
	var SO_FACES_VISIVEIS = { semTras: true, semBase: true };

	/** Abaixo desta largura (px) a estação usa os comandos compactos. */
	var LARGURA_ESTREITA_PX = 520;

	/** Tempo (ms) em que as rodas giram depois que o trem começa a andar. */
	var TEMPO_DO_TREM_ANDANDO_MS = 1500;

	/* ------------------------------------------------------------------ */
	/* Construção                                                          */
	/* ------------------------------------------------------------------ */

	/**
	 * @param {HTMLElement} oHospedeiro elemento do controle UI5 onde a cena é colocada
	 * @param {object} mCallbacks { aoSelecionarVagao, aoSelecionarBoca, aoSeguirCarga }
	 */
	function Cena3D(oHospedeiro, mCallbacks) {
		this._mCallbacks = mCallbacks || {};
		this._oHospedeiro = null;
		this._mVagoes = {};            // índice do vagão -> elementos do vagão
		this._aSilos = [];
		this._iSobOPortico = null;
		this._iTimerAndando = null;
		this._oUltimosDados = null;

		this._montarEstrutura();

		this._fnAoClicar = this._aoClicar.bind(this);
		this._fnAoTeclar = this._aoTeclar.bind(this);
		this._fnAjustarEscala = this._ajustarEscala.bind(this);
		this._oConteudo.addEventListener("click", this._fnAoClicar);
		this._oConteudo.addEventListener("keydown", this._fnAoTeclar);

		this._oCamera = new Camera3D(this._oConteudo, this._oPalco, {
			aoMudarVista: this._marcarVistaAtiva.bind(this),
			aoMudarGiro: this._marcarGiro.bind(this)
		});
		this._marcarVistaAtiva(this._oCamera.obterVista());

		this._oObservadorDeTamanho = typeof ResizeObserver !== "undefined" ? new ResizeObserver(this._fnAjustarEscala) : null;
		if (!this._oObservadorDeTamanho) {
			window.addEventListener("resize", this._fnAjustarEscala);
		}
		this.anexar(oHospedeiro);
	}

	Cena3D.GEOMETRIA = G;

	/** Coloca a cena dentro do elemento do controle (também após um re-render do UI5). */
	Cena3D.prototype.anexar = function (oHospedeiro) {
		if (this._oHospedeiro !== oHospedeiro) {
			if (this._oObservadorDeTamanho && this._oHospedeiro) {
				this._oObservadorDeTamanho.unobserve(this._oHospedeiro);
			}
			this._oHospedeiro = oHospedeiro;
			if (this._oObservadorDeTamanho) {
				this._oObservadorDeTamanho.observe(oHospedeiro);
			}
		}
		if (this._oConteudo.parentNode !== oHospedeiro) {
			oHospedeiro.appendChild(this._oConteudo);
		}
		this._ajustarEscala();
	};

	/** Retira a cena do DOM sem destruí-la (antes de um re-render do UI5). */
	Cena3D.prototype.desanexar = function () {
		if (this._oConteudo.parentNode) {
			this._oConteudo.parentNode.removeChild(this._oConteudo);
		}
	};

	/** Libera ouvintes e temporizadores (chamar no exit do controle). */
	Cena3D.prototype.destruir = function () {
		this.desanexar();
		clearTimeout(this._iTimerAndando);
		this._oCamera.destruir();
		this._oConteudo.removeEventListener("click", this._fnAoClicar);
		this._oConteudo.removeEventListener("keydown", this._fnAoTeclar);
		if (this._oObservadorDeTamanho) {
			this._oObservadorDeTamanho.disconnect();
		} else {
			window.removeEventListener("resize", this._fnAjustarEscala);
		}
		this._oHospedeiro = null;
	};

	/**
	 * Atualiza a cena com os dados do modelo de tela (ModeloTela._montarEstacao).
	 * @param {object} oDados { bocas, vagoes, quantidadeVagoes, indiceSobOPortico,
	 *                          indiceSelecionado, fluindo, nivelMinimoPct, textos }
	 */
	Cena3D.prototype.atualizar = function (oDados) {
		if (!oDados || !oDados.bocas || !oDados.vagoes) {
			return;
		}
		this._oUltimosDados = oDados;
		this._atualizarTextosFixos(oDados.textos || {});
		this._atualizarSilos(oDados);
		this._atualizarTrem(oDados);
		this._atualizarFluxos(oDados);
		this._atualizarBarra(oDados);
	};

	/* ------------------------------------------------------------------ */
	/* Montagem da estrutura fixa (executa uma vez)                        */
	/* ------------------------------------------------------------------ */

	Cena3D.prototype._montarEstrutura = function () {
		// conteudo > palco (perspectiva) > camera > balanco > [chao, mundo > (portico, trem)]
		this._oConteudo = Dom.criar("div", "vgE3__conteudo");
		this._oConteudo.tabIndex = 0;
		this._oPalco = Dom.criar("div", "vgE3__palco");
		var oCamera = Dom.criar("div", "vgE3__camera");
		var oBalanco = Dom.criar("div", "vgE3__balanco");
		this._oChao = this._montarChao();
		this._oMundo = Dom.criar("div", "vgE3__mundo");
		this._oPortico = Dom.criar("div", "vgE3__portico");
		this._oTrem = Dom.criar("div", "vgE3__trem");
		this._oLocomotiva = this._montarLocomotiva();
		this._oVazio = Dom.criar("div", "vgE3__vazio");

		Dom.anexar(this._oTrem, [this._oLocomotiva.elemento]);
		Dom.anexar(this._oMundo, [this._oPortico, this._oTrem]);
		Dom.anexar(oBalanco, [this._oChao, this._oMundo]);
		oCamera.appendChild(oBalanco);
		this._oPalco.appendChild(oCamera);

		this._oBarra = this._montarBarra();
		Dom.anexar(this._oConteudo, [this._oPalco, this._oVazio].concat(this._oBarra.grupos));

		Dom.definirVariavel(this._oConteudo, "--e3-centro-y", G.centroVertical + "px");
	};

	/**
	 * Chão, dormentes e trilhos. Ficam parados: quem anda é o trem. Quando a
	 * câmera vai até outro vagão, só a textura dos dormentes desliza (CSS).
	 */
	Cena3D.prototype._montarChao = function () {
		var oChao = Dom.criar("div", "vgE3__chao");
		var oDormentes = Dom.criar("div", "vgE3__dormentes");
		var oTrilhoFrente = Dom.criar("div", "vgE3__trilho");
		var oTrilhoFundo = Dom.criar("div", "vgE3__trilho");
		Dom.posicionar(oTrilhoFrente, 0, -3, G.zTrilho, "rotateX(90deg)");
		Dom.posicionar(oTrilhoFundo, 0, -3, -G.zTrilho, "rotateX(90deg)");
		var oGrupo = Dom.criar("div", "vgE3__grupoChao");
		return Dom.anexar(oGrupo, [oChao, oDormentes, oTrilhoFrente, oTrilhoFundo]);
	};

	/**
	 * Comandos da cena, em três grupos sobre o desenho:
	 *  - canto superior esquerdo: vistas (3D, Frente, Topo) e a dica de uso;
	 *  - canto superior direito: giro automático;
	 *  - embaixo, ao centro: vagão anterior/próximo e "seguir carga".
	 */
	Cena3D.prototype._montarBarra = function () {
		function botao(sAcao, sValor, sClasseExtra) {
			var oBotao = Dom.criar("button", "vgE3Botao" + (sClasseExtra ? " " + sClasseExtra : ""));
			oBotao.type = "button";
			oBotao.setAttribute("data-e3-acao", sAcao);
			if (sValor) { oBotao.setAttribute("data-e3-valor", sValor); }
			return oBotao;
		}
		var oBarra = {
			ajuda: Dom.criar("div", "vgE3__ajuda"),
			vista3d: botao("vista", "3d"),
			vistaFrente: botao("vista", "frente"),
			vistaTopo: botao("vista", "topo"),
			anterior: botao("navegar", "-1", "vgE3Botao--seta"),
			contador: Dom.criar("span", "vgE3__contador"),
			proximo: botao("navegar", "1", "vgE3Botao--seta"),
			seguir: botao("seguir"),
			girar: botao("girar")
		};
		oBarra.anterior.textContent = "‹";
		oBarra.proximo.textContent = "›";
		oBarra.contador.setAttribute("aria-live", "polite");

		function grupo(sPosicao, aItens) {
			return Dom.anexar(Dom.criar("div", "vgE3__grupo vgE3__grupo--" + sPosicao), aItens);
		}
		oBarra.grupos = [
			Dom.anexar(Dom.criar("div", "vgE3__canto"), [
				grupo("vistas", [oBarra.vista3d, oBarra.vistaFrente, oBarra.vistaTopo]),
				oBarra.ajuda
			]),
			grupo("giro", [oBarra.girar]),
			grupo("navegacao", [oBarra.anterior, oBarra.contador, oBarra.proximo, oBarra.seguir])
		];
		return oBarra;
	};

	/** Locomotiva: ocupa a posição anterior ao primeiro vagão. */
	Cena3D.prototype._montarLocomotiva = function () {
		var oGrupo = Dom.criar("div", "vgE3Loco");
		var oCorpo = Dom.criarCaixa(250, 84, 104, "vgE3Loco__corpo", SO_FACES_VISIVEIS);
		var oCabine = Dom.criarCaixa(108, 132, 108, "vgE3Loco__cabine", SO_FACES_VISIVEIS);
		var oChassi = Dom.criarCaixa(372, G.alturaChassi, 96, "vgE3Chassi", SO_FACES_VISIVEIS);
		var oFarol = Dom.criar("span", "vgE3Loco__farol");
		var oNome = Dom.criar("span", "vgE3Loco__nome");

		Dom.posicionar(oCorpo.elemento, -60, G.yBaseVagao, 0);
		Dom.posicionar(oCabine.elemento, 126, G.yBaseVagao, 0);
		Dom.posicionar(oChassi.elemento, 0, -G.alturaRodas + 2, 0);
		oCorpo.faces.esquerda.appendChild(oFarol);
		oCorpo.faces.frente.appendChild(oNome);
		oCabine.faces.frente.appendChild(Dom.criar("span", "vgE3Loco__janela"));

		Dom.anexar(oGrupo, [oChassi.elemento, oCorpo.elemento, oCabine.elemento].concat(this._montarRodas(372)));
		Dom.posicionar(oGrupo, -G.passoVagao, 0, 0);
		return { elemento: oGrupo, nome: oNome };
	};

	/** Quatro rodas na lateral da frente (dois truques). */
	Cena3D.prototype._montarRodas = function (fComprimento) {
		var fMetade = fComprimento / 2;
		return [-fMetade + 46, -fMetade + 92, fMetade - 92, fMetade - 46].map(function (fX) {
			var oRoda = Dom.criar("span", "vgE3Roda");
			oRoda.appendChild(Dom.criar("span", "vgE3Roda__disco"));
			Dom.posicionar(oRoda, fX, 0, G.zTrilho);
			return oRoda;
		});
	};

	/* ------------------------------------------------------------------ */
	/* Silos (bocas)                                                       */
	/* ------------------------------------------------------------------ */

	/** Posição X do centro de cada silo, distribuídos sobre o comprimento do vagão. */
	Cena3D.prototype._posicaoDoSilo = function (iIndice, iQuantidade) {
		var fEspaco = (G.comprimentoVagao - 24) / iQuantidade;
		return Math.round((iIndice - (iQuantidade - 1) / 2) * fEspaco);
	};

	/** Monta o pórtico: vigas, pilares e um silo por boca. Refeito só se a quantidade de bocas mudar. */
	Cena3D.prototype._montarPortico = function (iQuantidadeBocas) {
		while (this._oPortico.firstChild) {
			this._oPortico.removeChild(this._oPortico.firstChild);
		}
		var fMeiaLargura = G.comprimentoVagao / 2 + 14;
		var fMeiaProfundidade = G.profundidadeSilo / 2 + 6;
		var that = this;

		// pilares e vigas
		[[-fMeiaLargura, fMeiaProfundidade], [fMeiaLargura, fMeiaProfundidade],
			[-fMeiaLargura, -fMeiaProfundidade], [fMeiaLargura, -fMeiaProfundidade]].forEach(function (aPosicao) {
			var oPilar = Dom.criarCaixa(9, -G.yBaseSilo, 9, "vgE3Aco", SO_FACES_VISIVEIS);
			Dom.posicionar(oPilar.elemento, aPosicao[0], 0, aPosicao[1]);
			that._oPortico.appendChild(oPilar.elemento);
		});
		[fMeiaProfundidade, -fMeiaProfundidade].forEach(function (fZ) {
			var oViga = Dom.criarCaixa(fMeiaLargura * 2 + 9, 8, 9, "vgE3Aco", SO_FACES_VISIVEIS);
			Dom.posicionar(oViga.elemento, 0, G.yBaseSilo + 8, fZ);
			that._oPortico.appendChild(oViga.elemento);
		});

		this._aSilos = [];
		for (var i = 0; i < iQuantidadeBocas; i++) {
			var oSilo = this._montarSilo(i, this._posicaoDoSilo(i, iQuantidadeBocas));
			this._oPortico.appendChild(oSilo.elemento);
			this._aSilos.push(oSilo);
		}
	};

	/** Um silo: corpo transparente com grão, funil, bico, fluxo e etiqueta. */
	Cena3D.prototype._montarSilo = function (iIndice, fX) {
		var oGrupo = Dom.criar("div", "vgE3Silo");
		oGrupo.setAttribute("role", "button");
		oGrupo.tabIndex = 0;
		oGrupo.setAttribute("data-e3-boca", String(iIndice));

		var oCorpo = Dom.criarCaixa(G.larguraSilo, G.alturaSilo, G.profundidadeSilo, "vgE3Silo__corpo", { semBase: true });
		var oGrao = Dom.criarCaixa(G.larguraSilo - 6, G.alturaSilo - 6, G.profundidadeSilo - 6, "vgE3Grao", SO_FACES_VISIVEIS);
		var oBico = Dom.criarCaixa(G.larguraBico, G.alturaBico, G.larguraBico, "vgE3Aco", SO_FACES_VISIVEIS);
		var oPercentual = Dom.criar("span", "vgE3Silo__pct");
		var oMinimo = Dom.criar("span", "vgE3Silo__minimo");
		var oEtiqueta = Dom.criar("div", "vgE3Etiqueta vgE3Silo__etiqueta");
		var oNome = Dom.criar("span", "vgE3Silo__nome");
		var oVazao = Dom.criar("span", "vgE3Silo__vazao");
		var oFluxo = Dom.criar("div", "vgE3Fluxo");

		Dom.anexar(oCorpo.faces.frente, [oMinimo, oPercentual]);
		Dom.anexar(oEtiqueta, [Dom.anexar(Dom.criar("span", "vgE3Silo__linha"), [Dom.criar("span", "vgE3Silo__ponto"), oNome]), oVazao]);
		// dois planos cruzados: o fluxo tem "volume" de qualquer ângulo
		Dom.anexar(oFluxo, [Dom.criar("span", "vgE3Fluxo__plano"), Dom.criar("span", "vgE3Fluxo__plano is-lateral")]);

		Dom.posicionar(oCorpo.elemento, fX, G.yBaseSilo, 0);
		Dom.posicionar(oBico.elemento, fX, G.yBico, 0);
		Dom.posicionar(oEtiqueta, fX, G.yTopoSilo - 14, 0, VIRADA_PARA_A_CAMERA);

		Dom.anexar(oGrupo, [oGrao.elemento, oCorpo.elemento].concat(this._montarFunil(fX), [oBico.elemento, oFluxo, oEtiqueta]));
		return {
			elemento: oGrupo, x: fX, ancora: oCorpo.faces.frente, grao: oGrao.elemento,
			percentual: oPercentual, minimo: oMinimo, nome: oNome, vazao: oVazao, fluxo: oFluxo
		};
	};

	/**
	 * Funil (tronco de pirâmide invertido) entre o silo e o bico: quatro
	 * trapézios inclinados. Os ângulos saem da geometria: cada face desce
	 * "alturaFunil" enquanto se aproxima do centro.
	 */
	Cena3D.prototype._montarFunil = function (fX) {
		var fRecuoZ = (G.profundidadeSilo - G.larguraBico) / 2;
		var fRecuoX = (G.larguraSilo - G.larguraBico) / 2;
		var fAnguloFrente = Math.atan(fRecuoZ / G.alturaFunil) * 180 / Math.PI;
		var fAnguloLado = Math.atan(fRecuoX / G.alturaFunil) * 180 / Math.PI;
		var fComprimentoFrente = Math.sqrt(G.alturaFunil * G.alturaFunil + fRecuoZ * fRecuoZ);
		var fComprimentoLado = Math.sqrt(G.alturaFunil * G.alturaFunil + fRecuoX * fRecuoX);

		function face(fLargura, fComprimento, sClasse, sTransformacao) {
			var oFace = Dom.criar("div", "vgE3Funil " + sClasse);
			oFace.style.width = fLargura + "px";
			oFace.style.height = fComprimento + "px";
			oFace.style.marginLeft = (-fLargura / 2) + "px";
			oFace.style.transform = sTransformacao;
			return oFace;
		}
		var sBase = "translate3d(" + fX + "px," + G.yBaseSilo + "px,";
		return [
			face(G.larguraSilo, fComprimentoFrente, "is-frente", sBase + (G.profundidadeSilo / 2) + "px) rotateX(" + (-fAnguloFrente) + "deg)"),
			face(G.larguraSilo, fComprimentoFrente, "is-frente", sBase + (-G.profundidadeSilo / 2) + "px) rotateX(" + fAnguloFrente + "deg)"),
			face(G.profundidadeSilo, fComprimentoLado, "is-lado",
				"translate3d(" + (fX + G.larguraSilo / 2) + "px," + G.yBaseSilo + "px,0) rotateY(90deg) rotateX(" + (-fAnguloLado) + "deg)"),
			face(G.profundidadeSilo, fComprimentoLado, "is-lado",
				"translate3d(" + (fX - G.larguraSilo / 2) + "px," + G.yBaseSilo + "px,0) rotateY(-90deg) rotateX(" + (-fAnguloLado) + "deg)")
		];
	};

	Cena3D.prototype._atualizarSilos = function (oDados) {
		if (this._aSilos.length !== oDados.bocas.length) {
			this._montarPortico(oDados.bocas.length);
		}
		oDados.bocas.forEach(function (oBoca, iIndice) {
			var oSilo = this._aSilos[iIndice];
			Dom.definirClasses(oSilo.elemento, "vgE3Silo", [
				"is-" + oBoca.statusChave,
				oBoca.fluindo && "is-fluindo",
				oBoca.nivelBaixo && "is-baixo",
				oBoca.reabastecendo && "is-reabastecendo",
				oBoca.produtoDivergente && "is-divergente",
				oBoca.nivelPct <= 0 && "is-vazio"
			]);
			Dom.posicionar(oSilo.grao, oSilo.x, G.yBaseSilo, 0, "scaleY(" + Math.max(0.001, oBoca.nivelPct / 100).toFixed(3) + ")");
			Dom.definirTexto(oSilo.percentual, oBoca.nivelPct + "%");
			Dom.definirEstilo(oSilo.minimo, "bottom", (oDados.nivelMinimoPct || 0) + "%");
			Dom.definirTexto(oSilo.nome, oBoca.nome);
			Dom.definirTexto(oSilo.vazao, oBoca.fluindo ? oBoca.vazaoTexto + " t/h" : "—");
			Dom.definirAtributo(oSilo.elemento, "aria-label",
				[oBoca.titulo, oBoca.statusTexto, oBoca.produto, oBoca.nivelTexto, oBoca.temAlerta ? oBoca.alertaTexto : ""]
					.filter(Boolean).join(". "));
		}, this);
	};

	/** Fluxo de grão: cai do bico até a superfície do grão no vagão sob o pórtico. */
	Cena3D.prototype._atualizarFluxos = function (oDados) {
		var oVagaoSobOPortico = oDados.vagoes.filter(function (oVagao) { return oVagao.indice === oDados.indiceSobOPortico; })[0];
		var fPercentual = oVagaoSobOPortico ? oVagaoSobOPortico.percentual : 0;
		var fAlturaDoFluxo = Math.round((G.yFundoGrao - G.yBico) - G.alturaMaximaGrao * fPercentual / 100);

		oDados.bocas.forEach(function (oBoca, iIndice) {
			var oSilo = this._aSilos[iIndice];
			Dom.definirEstilo(oSilo.fluxo, "height", fAlturaDoFluxo + "px");
			Dom.posicionar(oSilo.fluxo, oSilo.x, G.yBico, 0);
			Dom.definirClasses(oSilo.fluxo, "vgE3Fluxo", [oDados.fluindo && oBoca.fluindo && "is-ligado"]);
		}, this);
	};

	/* ------------------------------------------------------------------ */
	/* Trem (vagões)                                                       */
	/* ------------------------------------------------------------------ */

	/** Cria os elementos de um vagão (casco transparente, grão, chassi, rodas e textos). */
	Cena3D.prototype._montarVagao = function (iIndice) {
		var oGrupo = Dom.criar("div", "vgE3Vagao");
		oGrupo.setAttribute("role", "button");
		oGrupo.tabIndex = 0;
		oGrupo.setAttribute("data-e3-vagao", String(iIndice));

		var oBase = Dom.criar("span", "vgE3Vagao__base");
		var oChassi = Dom.criarCaixa(G.comprimentoVagao, G.alturaChassi, G.profundidadeVagao - 22, "vgE3Chassi", SO_FACES_VISIVEIS);
		var oGrao = Dom.criarCaixa(G.comprimentoVagao - 12, G.alturaMaximaGrao, G.profundidadeVagao - 12, "vgE3Grao", SO_FACES_VISIVEIS);
		var oCasco = Dom.criarCaixa(G.comprimentoVagao, G.alturaVagao, G.profundidadeVagao, "vgE3Vagao__casco", { semTopo: true });
		Dom.posicionar(oBase, 0, -2, 0, "rotateX(90deg)");
		Dom.posicionar(oChassi.elemento, 0, -G.alturaRodas + 2, 0);
		Dom.posicionar(oCasco.elemento, 0, G.yBaseVagao, 0);

		// textos na lateral da frente
		var oPlaca = Dom.criar("span", "vgE3Vagao__placa");
		var oPercentual = Dom.criar("span", "vgE3Vagao__pct");
		var oStatus = Dom.criar("span", "vgE3Vagao__status");
		Dom.anexar(oCasco.faces.frente, [oPlaca, oPercentual, oStatus]);

		// etiqueta "de plataforma": fica em pé à frente do vagão, sempre virada para a câmera
		var oEtiqueta = Dom.criar("div", "vgE3Etiqueta vgE3Vagao__etiqueta");
		var oEtiquetaSigla = Dom.criar("span", "vgE3Vagao__etiquetaSigla");
		var oEtiquetaPercentual = Dom.criar("span", "vgE3Vagao__etiquetaPct");
		var oEtiquetaFatura = Dom.criar("span", "vgE3Vagao__etiquetaFatura");
		Dom.anexar(oEtiqueta, [oEtiquetaSigla, oEtiquetaPercentual, oEtiquetaFatura]);
		Dom.posicionar(oEtiqueta, 0, -4, G.profundidadeVagao / 2 + 34, VIRADA_PARA_A_CAMERA);

		Dom.anexar(oGrupo, [oBase, oChassi.elemento, oGrao.elemento, oCasco.elemento].concat(
			this._montarRodas(G.comprimentoVagao),
			[oEtiqueta]
		));
		Dom.posicionar(oGrupo, iIndice * G.passoVagao, 0, 0);

		return {
			elemento: oGrupo, ancora: oCasco.faces.frente, grao: oGrao.elemento,
			placa: oPlaca, percentual: oPercentual, status: oStatus,
			etiquetaSigla: oEtiquetaSigla, etiquetaPercentual: oEtiquetaPercentual, etiquetaFatura: oEtiquetaFatura
		};
	};

	Cena3D.prototype._atualizarVagao = function (oNo, oVagao, oDados) {
		var oTextos = oDados.textos || {};
		var bSelecionado = oVagao.indice === oDados.indiceSelecionado;
		Dom.definirClasses(oNo.elemento, "vgE3Vagao", [
			"st-" + oVagao.statusChave,
			"fat-" + oVagao.faturaSituacao,
			bSelecionado && "is-selecionado",
			oVagao.vistoriaReprovada && "is-reprovado",
			oVagao.semAtualizacao && "is-sem-leitura"
		]);
		Dom.definirAtributo(oNo.elemento, "aria-pressed", bSelecionado ? "true" : "false");
		Dom.definirAtributo(oNo.elemento, "aria-label",
			[oVagao.titulo, oVagao.statusTexto, oVagao.percentualTexto, oVagao.cargaComUnidade, oVagao.faturaTexto].join(". "));

		Dom.definirTexto(oNo.placa, oVagao.placa);
		Dom.definirTexto(oNo.percentual, oVagao.percentualTexto);
		Dom.definirTexto(oNo.status, oVagao.semAtualizacao ? oTextos.semAtualizacao : oVagao.statusTexto + " · " + oVagao.cargaComUnidade);
		Dom.definirTexto(oNo.etiquetaSigla, oVagao.sigla);
		Dom.definirTexto(oNo.etiquetaPercentual, oVagao.percentualTexto); // só aparece na vista de cima (CSS)
		Dom.definirTexto(oNo.etiquetaFatura, oVagao.faturaSituacao === "aguardando" ? "" : oVagao.faturaTexto);

		// o grão é uma caixa que cresce de baixo para cima conforme o percentual
		Dom.posicionar(oNo.grao, 0, G.yFundoGrao, 0, "scaleY(" + Math.max(0.001, oVagao.percentual / 100).toFixed(3) + ")");
		Dom.definirEstilo(oNo.grao, "visibility", oVagao.percentual > 0 ? "visible" : "hidden");
	};

	/** Cria, atualiza e remove os vagões da janela; desliza o trem e desloca a câmera. */
	Cena3D.prototype._atualizarTrem = function (oDados) {
		var mPresentes = {};
		oDados.vagoes.forEach(function (oVagao) {
			var oNo = this._mVagoes[oVagao.indice];
			if (!oNo) {
				oNo = this._mVagoes[oVagao.indice] = this._montarVagao(oVagao.indice);
				this._oTrem.appendChild(oNo.elemento);
			}
			mPresentes[oVagao.indice] = true;
			this._atualizarVagao(oNo, oVagao, oDados);
		}, this);

		// vagões que saíram da janela deixam de existir no DOM
		Object.keys(this._mVagoes).forEach(function (sIndice) {
			if (!mPresentes[sIndice]) {
				this._oTrem.removeChild(this._mVagoes[sIndice].elemento);
				delete this._mVagoes[sIndice];
			}
		}, this);

		// o trem desliza para deixar o vagão em carga sob o pórtico
		var iSobOPortico = oDados.indiceSobOPortico || 0;
		if (iSobOPortico !== this._iSobOPortico) {
			// primeira vez ou salto grande (ex.: Reiniciar): reposiciona sem animar
			var bSemAnimar = this._iSobOPortico === null || Math.abs(iSobOPortico - this._iSobOPortico) > 2;
			this._oTrem.classList.toggle("is-sem-transicao", bSemAnimar);
			Dom.posicionar(this._oTrem, -iSobOPortico * G.passoVagao, 0, 0);
			if (!bSemAnimar) {
				this._oTrem.classList.add("is-andando");
				clearTimeout(this._iTimerAndando);
				this._iTimerAndando = setTimeout(function () {
					this._oTrem.classList.remove("is-andando");
				}.bind(this), TEMPO_DO_TREM_ANDANDO_MS);
			}
			this._iSobOPortico = iSobOPortico;
		}

		// a câmera se desloca até o vagão selecionado (0 = olhando para o pórtico)
		var fDeslocamento = oDados.quantidadeVagoes ? ((oDados.indiceSelecionado || 0) - iSobOPortico) * G.passoVagao : 0;
		Dom.definirVariavel(this._oConteudo, "--e3-pan", String(fDeslocamento));

		// aviso "aguardando eventos" enquanto não há nenhum vagão
		Dom.definirClasses(this._oVazio, "vgE3__vazio", [oDados.quantidadeVagoes === 0 && "is-visivel"]);
	};

	/* ------------------------------------------------------------------ */
	/* Barra de comandos e textos                                          */
	/* ------------------------------------------------------------------ */

	Cena3D.prototype._atualizarTextosFixos = function (oTextos) {
		var oBarra = this._oBarra;
		Dom.definirTexto(oBarra.vista3d, oTextos.vista3d);
		Dom.definirTexto(oBarra.vistaFrente, oTextos.vistaFrente);
		Dom.definirTexto(oBarra.vistaTopo, oTextos.vistaTopo);
		Dom.definirTexto(oBarra.seguir, oTextos.seguirCarga);
		Dom.definirTexto(oBarra.girar, oTextos.girar);
		Dom.definirAtributo(oBarra.anterior, "aria-label", oTextos.anterior || "");
		Dom.definirAtributo(oBarra.proximo, "aria-label", oTextos.proximo || "");
		Dom.definirAtributo(oBarra.anterior, "title", oTextos.anterior || "");
		Dom.definirAtributo(oBarra.proximo, "title", oTextos.proximo || "");
		Dom.definirTexto(oBarra.ajuda, oTextos.ajuda);
		Dom.definirTexto(this._oVazio, oTextos.semVagoes);
		Dom.definirTexto(this._oLocomotiva.nome, oTextos.locomotiva);
	};

	Cena3D.prototype._atualizarBarra = function (oDados) {
		var oBarra = this._oBarra;
		var iQuantidade = oDados.quantidadeVagoes;
		var iSelecionado = oDados.indiceSelecionado || 0;
		var sPadrao = (oDados.textos && oDados.textos.vagaoDe) || "{0} / {1}";
		Dom.definirTexto(oBarra.contador, iQuantidade
			? sPadrao.replace("{0}", String(iSelecionado + 1)).replace("{1}", String(iQuantidade))
			: "—");
		oBarra.anterior.disabled = !iQuantidade || iSelecionado <= 0;
		oBarra.proximo.disabled = !iQuantidade || iSelecionado >= iQuantidade - 1;
		oBarra.seguir.disabled = !iQuantidade || iSelecionado === oDados.indiceSobOPortico;
	};

	Cena3D.prototype._marcarVistaAtiva = function (sVista) {
		var oBarra = this._oBarra;
		[["3d", oBarra.vista3d], ["frente", oBarra.vistaFrente], ["topo", oBarra.vistaTopo]].forEach(function (aPar) {
			aPar[1].setAttribute("aria-pressed", aPar[0] === sVista ? "true" : "false");
		});
	};

	Cena3D.prototype._marcarGiro = function (bGirando) {
		this._oBarra.girar.setAttribute("aria-pressed", bGirando ? "true" : "false");
	};

	/* ------------------------------------------------------------------ */
	/* Eventos                                                             */
	/* ------------------------------------------------------------------ */

	/** Um único ouvinte de clique para a cena inteira (delegação de eventos). */
	Cena3D.prototype._aoClicar = function (oEvento) {
		var oAlvo = oEvento.target.closest ? oEvento.target.closest("[data-e3-acao],[data-e3-vagao],[data-e3-boca]") : null;
		if (!oAlvo) {
			return;
		}
		if (oAlvo.hasAttribute("data-e3-acao")) {
			this._executarAcaoDaBarra(oAlvo.getAttribute("data-e3-acao"), oAlvo.getAttribute("data-e3-valor"));
		} else if (oAlvo.hasAttribute("data-e3-vagao")) {
			var iVagao = Number(oAlvo.getAttribute("data-e3-vagao"));
			if (this._mCallbacks.aoSelecionarVagao) {
				this._mCallbacks.aoSelecionarVagao(iVagao, this._mVagoes[iVagao] ? this._mVagoes[iVagao].ancora : oAlvo);
			}
		} else if (this._mCallbacks.aoSelecionarBoca) {
			var iBoca = Number(oAlvo.getAttribute("data-e3-boca"));
			this._mCallbacks.aoSelecionarBoca(iBoca, this._aSilos[iBoca] ? this._aSilos[iBoca].ancora : oAlvo);
		}
	};

	/** Enter ou Espaço em um vagão/silo com foco equivale a clicar. */
	Cena3D.prototype._aoTeclar = function (oEvento) {
		var bAtivar = oEvento.key === "Enter" || oEvento.key === " ";
		if (bAtivar && oEvento.target.matches && oEvento.target.matches("[data-e3-vagao],[data-e3-boca]")) {
			oEvento.preventDefault();
			oEvento.target.click();
		}
	};

	Cena3D.prototype._executarAcaoDaBarra = function (sAcao, sValor) {
		var oDados = this._oUltimosDados;
		if (sAcao === "vista") {
			this._oCamera.definirVista(sValor);
		} else if (sAcao === "girar") {
			this._oCamera.alternarGiro();
		} else if (sAcao === "seguir") {
			if (this._mCallbacks.aoSeguirCarga) { this._mCallbacks.aoSeguirCarga(); }
		} else if (sAcao === "navegar" && oDados && oDados.quantidadeVagoes) {
			var iNovo = Math.max(0, Math.min(oDados.quantidadeVagoes - 1, (oDados.indiceSelecionado || 0) + Number(sValor)));
			if (this._mCallbacks.aoSelecionarVagao) { this._mCallbacks.aoSelecionarVagao(iNovo, null); }
		}
	};

	/**
	 * Escala a cena para caber no espaço do controle. Sem altura definida
	 * (alguns navegadores de celular), escala pela largura e reserva a altura.
	 */
	Cena3D.prototype._ajustarEscala = function () {
		if (!this._oHospedeiro) {
			return;
		}
		var fLargura = this._oHospedeiro.clientWidth;
		var fAltura = this._oHospedeiro.clientHeight;
		if (!fLargura) {
			return;
		}
		if (fAltura < 2) {
			fAltura = Math.ceil(fLargura * G.alturaEnquadrada / G.larguraEnquadrada);
			Dom.definirEstilo(this._oHospedeiro, "minHeight", fAltura + "px");
		}
		var fEscala = Math.min(fLargura / G.larguraEnquadrada, fAltura / G.alturaEnquadrada);
		Dom.definirVariavel(this._oConteudo, "--e3-escala", fEscala.toFixed(4));
		// em estações estreitas (celular) o CSS usa comandos menores
		this._oConteudo.classList.toggle("is-estreita", fLargura < LARGURA_ESTREITA_PX);
	};

	return Cena3D;
});
