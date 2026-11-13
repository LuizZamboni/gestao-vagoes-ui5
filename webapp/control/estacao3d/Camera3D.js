/**
 * Camera3D
 * ------------------------------------------------------------------
 * Câmera da estação 3D: guarda o ângulo de visão e o zoom e trata os
 * gestos do usuário.
 *
 *  - arrastar (mouse ou dedo): gira a cena;
 *  - roda do mouse ou pinça com dois dedos: aproxima e afasta;
 *  - setas do teclado: giram; "+" e "-": zoom; "0": volta à vista 3D;
 *  - vistas prontas: 3D, Frente e Topo (definirVista);
 *  - "girar": um balanço lento e contínuo, bom para TV (ninguém toca na tela).
 *
 * A câmera não desenha nada: só escreve variáveis CSS no elemento raiz
 * (--e3-guinada, --e3-inclinacao, --e3-zoom). O CSS usa essas variáveis
 * para girar a cena e para manter as etiquetas viradas para quem olha.
 *
 * Classes que a câmera liga e desliga no elemento raiz:
 *   is-camera-suave   a próxima mudança de ângulo é animada (vistas prontas);
 *   is-girando        balanço automático ligado;
 *   is-arrastando     o usuário está arrastando a cena;
 *   is-vista-de-cima  a cena está sendo vista do alto.
 */
sap.ui.define([
	"./Dom"
], function (Dom) {
	"use strict";

	/** Vistas prontas: guinada (giro lateral) e inclinação (olhar de cima), em graus. */
	var VISTAS = {
		"3d": { guinada: -24, inclinacao: 15, zoom: 1 },
		"frente": { guinada: 0, inclinacao: 4, zoom: 1 },
		"topo": { guinada: 0, inclinacao: 62, zoom: 0.95 }
	};

	var LIMITES = {
		guinadaMin: -75, guinadaMax: 75,
		inclinacaoMin: 2, inclinacaoMax: 82,
		zoomMin: 0.6, zoomMax: 2
	};

	/** A partir desta inclinação a cena é vista "de cima" (as etiquetas mostram mais dados). */
	var INCLINACAO_VISTA_DE_CIMA = 45;

	/** Graus girados por pixel arrastado. */
	var SENSIBILIDADE_GUINADA = 0.3;
	var SENSIBILIDADE_INCLINACAO = 0.22;

	/** Movimento mínimo (px) para considerar que o usuário está arrastando (e não clicando). */
	var DISTANCIA_PARA_ARRASTAR = 5;

	function limitar(fValor, fMinimo, fMaximo) {
		return Math.max(fMinimo, Math.min(fMaximo, fValor));
	}

	/**
	 * @param {HTMLElement} oRaiz elemento raiz da estação (recebe as variáveis CSS)
	 * @param {HTMLElement} oPalco área onde o usuário arrasta
	 * @param {object} mCallbacks { aoMudarVista: fn(sVista|null), aoMudarGiro: fn(bGirando) }
	 */
	function Camera3D(oRaiz, oPalco, mCallbacks) {
		this._oRaiz = oRaiz;
		this._oPalco = oPalco;
		this._mCallbacks = mCallbacks || {};
		this._sVista = "3d";
		this._fGuinada = VISTAS["3d"].guinada;
		this._fInclinacao = VISTAS["3d"].inclinacao;
		this._fZoom = 1;
		this._bGirando = !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
		this._mPonteiros = {};
		this._bArrastou = false;
		this._fDistanciaPinca = 0;

		this._fnAoPressionar = this._aoPressionar.bind(this);
		this._fnAoMover = this._aoMover.bind(this);
		this._fnAoSoltar = this._aoSoltar.bind(this);
		this._fnAoRolar = this._aoRolar.bind(this);
		this._fnAoTeclar = this._aoTeclar.bind(this);
		this._fnAoClicar = this._aoClicar.bind(this);

		oPalco.addEventListener("pointerdown", this._fnAoPressionar);
		oPalco.addEventListener("pointermove", this._fnAoMover);
		oPalco.addEventListener("pointerup", this._fnAoSoltar);
		oPalco.addEventListener("pointercancel", this._fnAoSoltar);
		oPalco.addEventListener("wheel", this._fnAoRolar, { passive: false });
		oPalco.addEventListener("click", this._fnAoClicar, true);
		oRaiz.addEventListener("keydown", this._fnAoTeclar);

		this._aplicar();
		this._aplicarGiro();
	}

	Camera3D.VISTAS = VISTAS;

	/** Remove os ouvintes de evento (chamar ao destruir o controle). */
	Camera3D.prototype.destruir = function () {
		var oPalco = this._oPalco;
		oPalco.removeEventListener("pointerdown", this._fnAoPressionar);
		oPalco.removeEventListener("pointermove", this._fnAoMover);
		oPalco.removeEventListener("pointerup", this._fnAoSoltar);
		oPalco.removeEventListener("pointercancel", this._fnAoSoltar);
		oPalco.removeEventListener("wheel", this._fnAoRolar);
		oPalco.removeEventListener("click", this._fnAoClicar, true);
		this._oRaiz.removeEventListener("keydown", this._fnAoTeclar);
	};

	/**
	 * Vai para uma vista pronta, com transição suave.
	 * @param {string} sVista "3d", "frente" ou "topo"
	 */
	Camera3D.prototype.definirVista = function (sVista) {
		var oVista = VISTAS[sVista];
		if (!oVista) {
			return;
		}
		this._sVista = sVista;
		this._fGuinada = oVista.guinada;
		this._fInclinacao = oVista.inclinacao;
		this._fZoom = oVista.zoom;
		this._aplicar(true);
		this._notificarVista();
	};

	/** Liga ou desliga o balanço automático. */
	Camera3D.prototype.alternarGiro = function () {
		this._bGirando = !this._bGirando;
		this._aplicarGiro();
	};

	Camera3D.prototype.estaGirando = function () {
		return this._bGirando;
	};

	Camera3D.prototype.obterVista = function () {
		return this._sVista;
	};

	/**
	 * O último gesto foi um arrasto? A cena usa isto para não tratar o fim
	 * de um arrasto como clique em vagão.
	 */
	Camera3D.prototype.acabouDeArrastar = function () {
		return this._bArrastou;
	};

	/* ------------------------------------------------------------------ */
	/* Internos                                                            */
	/* ------------------------------------------------------------------ */

	/** Escreve as variáveis CSS da câmera. bSuave = com transição (vistas prontas). */
	Camera3D.prototype._aplicar = function (bSuave) {
		this._oRaiz.classList.toggle("is-camera-suave", !!bSuave);
		this._oRaiz.classList.toggle("is-vista-de-cima", this._fInclinacao >= INCLINACAO_VISTA_DE_CIMA);
		Dom.definirVariavel(this._oRaiz, "--e3-guinada", this._fGuinada.toFixed(2) + "deg");
		Dom.definirVariavel(this._oRaiz, "--e3-inclinacao", this._fInclinacao.toFixed(2) + "deg");
		Dom.definirVariavel(this._oRaiz, "--e3-zoom", this._fZoom.toFixed(3));
	};

	Camera3D.prototype._aplicarGiro = function () {
		this._oRaiz.classList.toggle("is-girando", this._bGirando);
		if (this._mCallbacks.aoMudarGiro) {
			this._mCallbacks.aoMudarGiro(this._bGirando);
		}
	};

	Camera3D.prototype._notificarVista = function () {
		if (this._mCallbacks.aoMudarVista) {
			this._mCallbacks.aoMudarVista(this._sVista);
		}
	};

	/** Gira a cena por um deslocamento em pixels (arrasto) ou em graus (teclado). */
	Camera3D.prototype._girar = function (fGrausGuinada, fGrausInclinacao) {
		this._fGuinada = limitar(this._fGuinada + fGrausGuinada, LIMITES.guinadaMin, LIMITES.guinadaMax);
		this._fInclinacao = limitar(this._fInclinacao + fGrausInclinacao, LIMITES.inclinacaoMin, LIMITES.inclinacaoMax);
		if (this._sVista !== null) {
			this._sVista = null; // saiu da vista pronta
			this._notificarVista();
		}
		this._aplicar(false);
	};

	Camera3D.prototype._ampliar = function (fFator) {
		this._fZoom = limitar(this._fZoom * fFator, LIMITES.zoomMin, LIMITES.zoomMax);
		this._aplicar(false);
	};

	Camera3D.prototype._aoPressionar = function (oEvento) {
		if (oEvento.button > 0) {
			return;
		}
		this._mPonteiros[oEvento.pointerId] = { x: oEvento.clientX, y: oEvento.clientY };
		this._bArrastou = false;
		this._fDistanciaPinca = this._distanciaEntrePonteiros();
	};

	Camera3D.prototype._aoMover = function (oEvento) {
		var oPonteiro = this._mPonteiros[oEvento.pointerId];
		if (!oPonteiro) {
			return;
		}
		var fDx = oEvento.clientX - oPonteiro.x;
		var fDy = oEvento.clientY - oPonteiro.y;
		var aIds = Object.keys(this._mPonteiros);

		// dois dedos: pinça = zoom
		if (aIds.length >= 2) {
			oPonteiro.x = oEvento.clientX;
			oPonteiro.y = oEvento.clientY;
			var fDistancia = this._distanciaEntrePonteiros();
			if (this._fDistanciaPinca > 0 && fDistancia > 0) {
				this._ampliar(fDistancia / this._fDistanciaPinca);
			}
			this._fDistanciaPinca = fDistancia;
			this._bArrastou = true;
			return;
		}

		if (!this._bArrastou && Math.abs(fDx) + Math.abs(fDy) < DISTANCIA_PARA_ARRASTAR) {
			return;
		}
		if (!this._bArrastou) {
			this._bArrastou = true;
			this._oRaiz.classList.add("is-arrastando");
			if (this._oPalco.setPointerCapture) {
				try { this._oPalco.setPointerCapture(oEvento.pointerId); } catch (oErro) { /* ponteiro já liberado */ }
			}
		}
		oPonteiro.x = oEvento.clientX;
		oPonteiro.y = oEvento.clientY;
		this._girar(fDx * SENSIBILIDADE_GUINADA, fDy * SENSIBILIDADE_INCLINACAO);
	};

	Camera3D.prototype._aoSoltar = function (oEvento) {
		delete this._mPonteiros[oEvento.pointerId];
		this._fDistanciaPinca = 0;
		this._oRaiz.classList.remove("is-arrastando");
	};

	/** Depois de arrastar, o navegador ainda dispara "click": é descartado aqui. */
	Camera3D.prototype._aoClicar = function (oEvento) {
		if (this._bArrastou) {
			oEvento.stopPropagation();
			oEvento.preventDefault();
			this._bArrastou = false;
		}
	};

	/**
	 * Roda do mouse = zoom. Se a página tiver rolagem (celular/tablet em
	 * coluna), a roda continua rolando a página e o zoom exige Ctrl.
	 */
	Camera3D.prototype._aoRolar = function (oEvento) {
		if (!oEvento.ctrlKey && this._paginaTemRolagem()) {
			return;
		}
		oEvento.preventDefault();
		this._ampliar(Math.exp(-oEvento.deltaY * 0.0012));
	};

	Camera3D.prototype._aoTeclar = function (oEvento) {
		if (oEvento.target !== this._oRaiz) {
			return; // teclas em vagões e botões seguem o comportamento normal
		}
		switch (oEvento.key) {
			case "ArrowLeft": this._girar(-6, 0); break;
			case "ArrowRight": this._girar(6, 0); break;
			case "ArrowUp": this._girar(0, 5); break;
			case "ArrowDown": this._girar(0, -5); break;
			case "+": case "=": this._ampliar(1.12); break;
			case "-": this._ampliar(1 / 1.12); break;
			case "0": this.definirVista("3d"); break;
			default: return;
		}
		oEvento.preventDefault();
	};

	Camera3D.prototype._distanciaEntrePonteiros = function () {
		var aIds = Object.keys(this._mPonteiros);
		if (aIds.length < 2) {
			return 0;
		}
		var oA = this._mPonteiros[aIds[0]];
		var oB = this._mPonteiros[aIds[1]];
		return Math.hypot(oA.x - oB.x, oA.y - oB.y);
	};

	/** Algum elemento acima da estação tem barra de rolagem vertical ativa? */
	Camera3D.prototype._paginaTemRolagem = function () {
		var oElemento = this._oRaiz.parentElement;
		while (oElemento && oElemento !== document.body) {
			var sOverflow = window.getComputedStyle(oElemento).overflowY;
			if ((sOverflow === "auto" || sOverflow === "scroll") && oElemento.scrollHeight > oElemento.clientHeight + 1) {
				return true;
			}
			oElemento = oElemento.parentElement;
		}
		return false;
	};

	return Camera3D;
});
