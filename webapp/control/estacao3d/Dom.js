/**
 * Dom
 * ------------------------------------------------------------------
 * Pequenas funções para criar e atualizar elementos da estação 3D.
 *
 * Duas regras valem para todas:
 *  1. Nada de innerHTML: os elementos são criados com createElement e os
 *     textos entram por textContent. Um texto vindo do stream nunca é
 *     interpretado como HTML (sem risco de XSS; compatível com CSP).
 *  2. As funções "definir..." só mexem no DOM quando o valor mudou. Assim
 *     as animações CSS não reiniciam e a atualização custa pouco.
 */
sap.ui.define([], function () {
	"use strict";

	/**
	 * Último valor escrito em cada elemento (estilos e variáveis CSS).
	 * O navegador reescreve o texto do estilo ("0px" vira "0px, ..."), então
	 * comparar com o próprio DOM não funciona: guardamos o que foi escrito.
	 * WeakMap: quando o elemento sai da tela, a anotação é descartada junto.
	 */
	var mUltimosValores = new WeakMap();

	/**
	 * @returns {boolean} true se o valor é diferente do último escrito (e já anota o novo)
	 */
	function valorMudou(oElemento, sChave, sValor) {
		var mValores = mUltimosValores.get(oElemento);
		if (!mValores) {
			mValores = {};
			mUltimosValores.set(oElemento, mValores);
		}
		if (mValores[sChave] === sValor) {
			return false;
		}
		mValores[sChave] = sValor;
		return true;
	}

	var Dom = {

		/**
		 * Cria um elemento HTML.
		 * @param {string} sTag ex.: "div"
		 * @param {string} [sClasse] classes CSS
		 * @param {string} [sTexto] texto (textContent)
		 * @returns {HTMLElement}
		 */
		criar: function (sTag, sClasse, sTexto) {
			var oElemento = document.createElement(sTag);
			if (sClasse) { oElemento.className = sClasse; }
			if (sTexto) { oElemento.textContent = sTexto; }
			return oElemento;
		},

		/**
		 * Coloca vários filhos em um elemento (ignora nulos).
		 * @returns {HTMLElement} o próprio pai, para encadear
		 */
		anexar: function (oPai, aFilhos) {
			aFilhos.forEach(function (oFilho) {
				if (oFilho) { oPai.appendChild(oFilho); }
			});
			return oPai;
		},

		/** Atualiza o texto só se mudou. */
		definirTexto: function (oElemento, vValor) {
			var sValor = vValor === null || vValor === undefined ? "" : String(vValor);
			if (oElemento && oElemento.textContent !== sValor) { oElemento.textContent = sValor; }
		},

		/** Atualiza uma propriedade de estilo só se mudou. */
		definirEstilo: function (oElemento, sPropriedade, sValor) {
			if (oElemento && valorMudou(oElemento, sPropriedade, sValor)) { oElemento.style[sPropriedade] = sValor; }
		},

		/** Atualiza uma variável CSS (--nome) só se mudou. */
		definirVariavel: function (oElemento, sNome, sValor) {
			if (oElemento && valorMudou(oElemento, sNome, sValor)) { oElemento.style.setProperty(sNome, sValor); }
		},

		/**
		 * Define as classes: a classe base mais os modificadores verdadeiros.
		 * Ex.: definirClasses(el, "vgE3Vagao", [bSel && "is-sel", "st-" + sStatus])
		 */
		definirClasses: function (oElemento, sClasseBase, aModificadores) {
			if (!oElemento) { return; }
			var sClasses = [sClasseBase].concat(aModificadores.filter(Boolean)).join(" ");
			if (oElemento.className !== sClasses) { oElemento.className = sClasses; }
		},

		/** Atualiza um atributo só se mudou. */
		definirAtributo: function (oElemento, sNome, sValor) {
			if (oElemento && oElemento.getAttribute(sNome) !== sValor) { oElemento.setAttribute(sNome, sValor); }
		},

		/**
		 * Posiciona um elemento no espaço 3D da cena.
		 * Eixos: X = ao longo do trilho, Y = altura (negativo é para cima),
		 * Z = profundidade (positivo vem para a frente).
		 * @param {string} [sExtra] transformações extras, ex.: "scaleY(.5)"
		 */
		posicionar: function (oElemento, fX, fY, fZ, sExtra) {
			Dom.definirEstilo(oElemento, "transform",
				"translate3d(" + fX + "px," + fY + "px," + fZ + "px)" + (sExtra ? " " + sExtra : ""));
		},

		/**
		 * Cria uma CAIXA 3D (paralelepípedo) feita de faces planas.
		 *
		 * O ponto de referência da caixa é o centro da base: ao posicionar em
		 * (x, y, z), a base fica apoiada em y e centralizada em x e z.
		 *
		 * @param {number} fLargura tamanho em X
		 * @param {number} fAltura tamanho em Y
		 * @param {number} fProfundidade tamanho em Z
		 * @param {string} sClasse classe da caixa (cada face recebe sClasse + "__face")
		 * @param {object} [mOpcoes] { semTopo, semBase, semTras: true } para omitir faces.
		 *        A câmera nunca vai para trás nem para baixo da cena, então caixas
		 *        opacas dispensam "tras" e "base" (menos elementos = tela mais leve).
		 * @returns {{elemento: HTMLElement, faces: object}} faces: frente, tras, esquerda, direita, topo, base
		 */
		criarCaixa: function (fLargura, fAltura, fProfundidade, sClasse, mOpcoes) {
			var mOpc = mOpcoes || {};
			var oCaixa = Dom.criar("div", "vgE3Caixa " + sClasse);
			oCaixa.style.width = fLargura + "px";
			oCaixa.style.height = fAltura + "px";
			oCaixa.style.marginLeft = (-fLargura / 2) + "px";
			oCaixa.style.marginTop = (-fAltura) + "px";

			var mFaces = {};
			function criarFace(sNome, fLarguraFace, fAlturaFace, sTransformacao) {
				var oFace = Dom.criar("div", "vgE3Caixa__face " + sClasse + "__face is-" + sNome);
				oFace.style.width = fLarguraFace + "px";
				oFace.style.height = fAlturaFace + "px";
				oFace.style.left = ((fLargura - fLarguraFace) / 2) + "px";
				oFace.style.top = ((fAltura - fAlturaFace) / 2) + "px";
				oFace.style.transform = sTransformacao;
				oCaixa.appendChild(oFace);
				mFaces[sNome] = oFace;
			}

			if (!mOpc.semTras) {
				criarFace("tras", fLargura, fAltura, "rotateY(180deg) translateZ(" + (fProfundidade / 2) + "px)");
			}
			criarFace("esquerda", fProfundidade, fAltura, "rotateY(-90deg) translateZ(" + (fLargura / 2) + "px)");
			criarFace("direita", fProfundidade, fAltura, "rotateY(90deg) translateZ(" + (fLargura / 2) + "px)");
			if (!mOpc.semBase) {
				criarFace("base", fLargura, fProfundidade, "rotateX(-90deg) translateZ(" + (fAltura / 2) + "px)");
			}
			if (!mOpc.semTopo) {
				criarFace("topo", fLargura, fProfundidade, "rotateX(90deg) translateZ(" + (fAltura / 2) + "px)");
			}
			criarFace("frente", fLargura, fAltura, "translateZ(" + (fProfundidade / 2) + "px)");

			return { elemento: oCaixa, faces: mFaces };
		}
	};

	return Dom;
});
