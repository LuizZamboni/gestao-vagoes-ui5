/**
 * Desenho da estação de carregamento (silos + cones de descarga + fluxo de
 * grão + composição), em DOM puro.
 *
 * É usado pelo controle UI5 LoadingStation. Fica separado do controle para:
 *   - atualizar o DOM no lugar a cada ciclo (as animações CSS/SVG não reiniciam);
 *   - poder ser reaproveitado/testado sem o runtime do UI5.
 *
 * Modo TV:
 *   - o desenho tem geometria fixa (px) e é escalado para caber inteiro no
 *     espaço disponível, sempre centralizado;
 *   - a composição é mostrada por uma "janela" de SLOTS posições (locomotiva
 *     conta como posição 0), centralizada no vagão selecionado. As setas e o
 *     mini-mapa deslocam a janela manualmente; depois de NAV_MS sem interação
 *     ela volta a acompanhar o vagão selecionado.
 *
 * API:
 *   var st = new StationDom(oRootElement, { onWagonPress: fn(i, el), onBocaPress: fn(i, el) });
 *   st.update({ bocas, vagoes, selectedIndex, running, textos, nivelMinimoPct });
 *   st.attach(oNovoRoot) / st.detach() / st.destroy()
 */
sap.ui.define([], function () {
	"use strict";

	/* Janela do trem: 3 vagões grandes. A locomotiva (posição 0) fica fora da janela. */
	var SLOTS = 3;
	var MIN_START = 1;
	var NAV_MS = 20000;

	/* Geometria fixa em px: facilita alinhar cones, linhas de fluxo e vagões. */
	var G = { pad: 12, navW: 48, slotW: 220, gap: 12, unitW: 172, siloW: 124,
		labelH: 34, siloH: 176, coneH: 56, gateH: 10, vzH: 26, flowH: 112, wagonH: 210, bogieH: 24, railH: 10,
		viewPadT: 16, miniH: 14 };
	G.siloY = G.labelH;
	G.coneY = G.siloY + G.siloH;
	G.gateY = G.coneY + G.coneH;
	G.vzY = G.gateY + G.gateH + 4;
	G.flowY = G.gateY + G.gateH;
	G.wagonY = G.flowY + G.flowH;
	G.railY = G.wagonY + G.wagonH + 2 + G.bogieH - 8;
	G.miniY = G.railY + G.railH + 14;
	G.height = G.miniY + G.miniH + 4;
	G.step = G.slotW + G.gap;
	G.viewW = SLOTS * G.step - G.gap;

	var iUid = 0;

	function esc(v) {
		return String(v == null ? "" : v).replace(/[&<>"']/g, function (ch) {
			return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch];
		});
	}
	function txt(el, v) {
		v = v == null ? "" : String(v);
		if (el && el.textContent !== v) { el.textContent = v; }
	}
	function css(el, prop, v) {
		if (el && el.style[prop] !== v) { el.style[prop] = v; }
	}
	function cls(el, base, aMods) {
		if (!el) { return; }
		var s = [base].concat(aMods.filter(Boolean)).join(" ").trim();
		if (el.getAttribute("class") !== s) { el.setAttribute("class", s); }
	}
	function attr(el, name, v) {
		if (el && el.getAttribute(name) !== v) { el.setAttribute(name, v); }
	}
	function ref(el, r) { return el.querySelector("[data-vg-r=\"" + r + "\"]"); }
	function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

	function wheel() {
		return "<span class=\"vgWheel\"><span class=\"vgWheel__spoke\"></span><span class=\"vgWheel__spoke vgWheel__spoke--b\"></span></span>";
	}
	function bogies(w) {
		var y = G.viewPadT + G.wagonH + 2;
		return "<span class=\"vgBogie\" style=\"left:6px;top:" + y + "px\">" + wheel() + wheel() + "</span>" +
			"<span class=\"vgBogie\" style=\"left:" + (w - 6 - 46) + "px;top:" + y + "px\">" + wheel() + wheel() + "</span>";
	}

	function StationDom(oRoot, mHandlers) {
		this.h = mHandlers || {};
		this.id = "vgst" + (++iUid);
		this.wrap = null;
		this.nB = -1;
		this.nW = -1;
		this.start = -1;
		this.nav = null; // { start, at } quando o usuário desloca a janela
		this.last = null;
		this._onClick = this._onClick.bind(this);
		this._fit = this._fit.bind(this);
		this._ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(this._fit) : null;
		if (!this._ro) { window.addEventListener("resize", this._fit); }
		this.root = null;
		this.attach(oRoot);
	}

	StationDom.geometria = G;

	StationDom.prototype.attach = function (oRoot) {
		if (this.root && this.root !== oRoot) {
			this.root.removeEventListener("click", this._onClick);
			if (this._ro) { this._ro.unobserve(this.root); }
		}
		if (this.root !== oRoot) {
			this.root = oRoot;
			oRoot.addEventListener("click", this._onClick);
			if (this._ro) { this._ro.observe(oRoot); }
		}
		if (this.wrap && this.wrap.parentNode !== oRoot) {
			oRoot.appendChild(this.wrap);
			this._fit();
		}
	};

	StationDom.prototype.detach = function () {
		if (this.wrap && this.wrap.parentNode) {
			this.wrap.parentNode.removeChild(this.wrap);
		}
	};

	StationDom.prototype.destroy = function () {
		this.detach();
		if (this.root) { this.root.removeEventListener("click", this._onClick); }
		if (this._ro) { this._ro.disconnect(); } else { window.removeEventListener("resize", this._fit); }
		this.root = null;
		this.wrap = null;
	};

	StationDom.prototype._onClick = function (e) {
		var el = e.target.closest ? e.target.closest("[data-vg-wagon],[data-vg-boca],[data-vg-nav],[data-vg-jump]") : null;
		if (!el || !this.root || !this.root.contains(el)) { return; }
		if (el.hasAttribute("data-vg-nav")) {
			this._navegar(this.start + Number(el.getAttribute("data-vg-nav")));
		} else if (el.hasAttribute("data-vg-jump")) {
			this._navegar(Number(el.getAttribute("data-vg-jump")) - Math.floor(SLOTS / 2));
		} else if (el.hasAttribute("data-vg-wagon")) {
			this.nav = null;
			if (this.h.onWagonPress) { this.h.onWagonPress(Number(el.getAttribute("data-vg-wagon")), el); }
		} else if (this.h.onBocaPress) {
			this.h.onBocaPress(Number(el.getAttribute("data-vg-boca")), el);
		}
	};

	StationDom.prototype._maxStart = function () {
		return Math.max(MIN_START, this.nW + 1 - SLOTS);
	};

	StationDom.prototype._navegar = function (iStart) {
		this.nav = { start: clamp(iStart, MIN_START, this._maxStart()), at: Date.now() };
		if (this.last) { this._apply(this.last); }
	};

	/** Escala o desenho para caber inteiro (e centralizado) no espaço do controle. */
	StationDom.prototype._fit = function () {
		if (!this.root || !this.track || !this.geo) { return; }
		var W = this.root.clientWidth;
		var H = this.root.clientHeight;
		if (!W || !H) { return; }
		var w = this.geo.width;
		var h = G.height;
		var s = Math.min(W / w, H / h, 1.8);
		var x = Math.round((W - w * s) / 2);
		var y = Math.round((H - h * s) / 2);
		css(this.track, "transform", "translate(" + x + "px," + y + "px) scale(" + s.toFixed(4) + ")");
	};

	StationDom.prototype.update = function (d) {
		if (!this.root || !d || !d.bocas || !d.vagoes) { return; }
		if (!this.wrap || d.bocas.length !== this.nB || d.vagoes.length !== this.nW) {
			this._build(d);
		}
		if (this.wrap.parentNode !== this.root) {
			this.root.appendChild(this.wrap);
		}
		this.last = d;
		this._apply(d);
		this._fit();
	};

	StationDom.prototype._geo = function (nB) {
		// poucas bocas: espalha os silos sobre a largura da composição visível
		var iSilos = Math.max(nB * (G.unitW + 16), Math.min(G.viewW + 2 * (G.navW + G.gap), nB * (G.unitW + 120)));
		var iTrain = G.viewW + 2 * (G.navW + G.gap);
		var iWidth = Math.max(iSilos, iTrain) + 2 * G.pad;
		var g = { width: iWidth, siloCX: [], viewX: Math.round((iWidth - G.viewW) / 2) };
		var iSiloStart = (iWidth - iSilos) / 2;
		for (var j = 0; j < nB; j++) { g.siloCX.push(Math.round(iSiloStart + iSilos * (j + 0.5) / nB)); }
		return g;
	};

	StationDom.prototype._build = function (d) {
		var nW = d.vagoes.length;
		var nB = d.bocas.length;
		var g = this.geo = this._geo(nB);
		var id = this.id;
		var tx = d.textos || {};
		var h = [];
		var i, j, k;

		h.push("<div class=\"vgSt__track\" style=\"width:" + g.width + "px;height:" + G.height + "px\">");

		// viga do pórtico (só uma linha discreta)
		h.push("<span class=\"vgSt__beam\" style=\"left:" + G.pad + "px;width:" + (g.width - 2 * G.pad) + "px;top:" + (G.coneY - 3) + "px\"></span>");

		// trilho
		h.push("<span class=\"vgSt__rail\" style=\"left:" + (g.viewX - G.navW - G.gap) + "px;top:" + G.railY + "px;width:" + (G.viewW + 2 * (G.navW + G.gap)) + "px\"></span>");

		// linhas de fluxo (SVG)
		h.push("<svg class=\"vgSt__flows\" width=\"" + g.width + "\" height=\"" + (G.flowH + 8) + "\" style=\"top:" + (G.flowY - 4) + "px\" aria-hidden=\"true\" focusable=\"false\">");
		for (j = 0; j < nB; j++) {
			h.push("<g class=\"vgFlow\" data-vg-flow=\"" + j + "\">" +
				"<path id=\"" + id + "p" + j + "\" class=\"vgFlow__base\" d=\"M0 0\"></path>" +
				"<path class=\"vgFlow__dash\" d=\"M0 0\"></path>");
			for (k = 0; k < 4; k++) {
				h.push("<circle class=\"vgFlow__grain\" r=\"" + (k % 2 ? 2.2 : 3) + "\"><animateMotion dur=\"1.1s\" repeatCount=\"indefinite\" begin=\"-" + (k * 0.275).toFixed(3) + "s\"><mpath href=\"#" + id + "p" + j + "\"></mpath></animateMotion></circle>");
			}
			h.push("</g>");
		}
		h.push("</svg>");

		// silos + cones (bocas)
		for (j = 0; j < nB; j++) {
			var iLeft = g.siloCX[j] - G.unitW / 2;
			h.push("<button type=\"button\" class=\"vgSilo\" data-vg-boca=\"" + j + "\" style=\"left:" + iLeft + "px;width:" + G.unitW + "px;height:" + (G.vzY + G.vzH) + "px\">" +
				"<span class=\"vgSilo__label\"><span class=\"vgSilo__dot\"></span><span class=\"vgSilo__name\" data-vg-r=\"name\"></span><span class=\"vgSilo__pill\" data-vg-r=\"pill\"></span></span>" +
				"<span class=\"vgSilo__body\" style=\"top:" + G.siloY + "px;height:" + G.siloH + "px;width:" + G.siloW + "px;margin-left:" + (-G.siloW / 2) + "px\">" +
					"<span class=\"vgSilo__level\" data-vg-r=\"level\"></span>" +
					"<span class=\"vgSilo__min\" data-vg-r=\"min\"></span>" +
					"<span class=\"vgSilo__info\"><span class=\"vgSilo__pct\" data-vg-r=\"pct\"></span><span class=\"vgSilo__prod\" data-vg-r=\"prod\"></span></span>" +
					"<span class=\"vgSilo__alert\" aria-hidden=\"true\">!</span>" +
				"</span>" +
				"<span class=\"vgSilo__cone\" style=\"top:" + G.coneY + "px;height:" + G.coneH + "px;width:" + G.siloW + "px;margin-left:" + (-G.siloW / 2) + "px\"><span class=\"vgSilo__coneFill\" data-vg-r=\"coneFill\"></span><span class=\"vgSilo__coneFlow\"></span></span>" +
				"<span class=\"vgSilo__gate\" style=\"top:" + G.gateY + "px;height:" + G.gateH + "px\"><span class=\"vgSilo__gateBlade\" data-vg-r=\"gate\"></span></span>" +
				"<span class=\"vgSilo__vz\" style=\"top:" + G.vzY + "px\"><b data-vg-r=\"vz\"></b> t/h</span>" +
				"</button>");
		}

		// janela da composição (com rolagem animada)
		var iViewH = G.viewPadT + G.wagonH + 2 + G.bogieH;
		h.push("<span class=\"vgView\" style=\"left:" + g.viewX + "px;top:" + (G.wagonY - G.viewPadT) + "px;width:" + G.viewW + "px;height:" + iViewH + "px\">");
		h.push("<span class=\"vgTrain\" data-vg-r=\"train\">");

		// locomotiva (posição 0)
		h.push("<span class=\"vgCar\" style=\"left:0;width:" + G.slotW + "px\">" +
			"<span class=\"vgLoco\" style=\"top:" + (G.viewPadT + 10) + "px;width:" + G.slotW + "px;height:" + (G.wagonH - 10) + "px\">" +
				"<span class=\"vgLoco__cab\"><span class=\"vgLoco__win\"></span></span>" +
				"<span class=\"vgLoco__light\"></span>" +
				"<span class=\"vgLoco__t\">" + esc(tx.locomotiva || "") + "</span>" +
				"<span class=\"vgLoco__st\" data-vg-r=\"locoSt\"></span>" +
			"</span>" + bogies(G.slotW) + "</span>");

		// vagões (posição i + 1)
		for (i = 0; i < nW; i++) {
			h.push("<span class=\"vgCar\" style=\"left:" + ((i + 1) * G.step) + "px;width:" + G.slotW + "px\">" +
				"<button type=\"button\" class=\"vgWag\" data-vg-wagon=\"" + i + "\" style=\"top:" + G.viewPadT + "px;width:" + G.slotW + "px;height:" + G.wagonH + "px\">" +
				"<span class=\"vgWag__head\"><span class=\"vgWag__num\" data-vg-r=\"num\"></span><span class=\"vgWag__st\"><span class=\"vgWag__dot\"></span><span data-vg-r=\"st\"></span></span></span>" +
				"<span class=\"vgWag__plate\" data-vg-r=\"plate\"></span>" +
				"<span class=\"vgWag__hopper\">" +
					"<span class=\"vgWag__sec\"><span class=\"vgWag__fill\"></span></span>" +
					"<span class=\"vgWag__sec vgWag__sec--c\"><span class=\"vgWag__fill\"></span></span>" +
					"<span class=\"vgWag__sec\"><span class=\"vgWag__fill\"></span></span>" +
					"<span class=\"vgWag__pct\" data-vg-r=\"pct\"></span></span>" +
				"<span class=\"vgWag__w\"><span class=\"vgWag__carga\" data-vg-r=\"carga\"></span><span class=\"vgWag__lock\" aria-hidden=\"true\"></span></span>" +
				"</button>" + bogies(G.slotW) + "</span>");
		}
		h.push("</span></span>");

		// setas
		var iNavY = G.wagonY + G.wagonH / 2 - 32;
		h.push("<button type=\"button\" class=\"vgNav vgNav--l\" data-vg-nav=\"-1\" style=\"left:" + (g.viewX - G.gap - G.navW) + "px;top:" + iNavY + "px;width:" + G.navW + "px\" aria-label=\"" + esc(tx.anteriores) + "\">" +
			"<span class=\"vgNav__arrow\">‹</span><span class=\"vgNav__n\" data-vg-r=\"navL\"></span></button>");
		h.push("<button type=\"button\" class=\"vgNav vgNav--r\" data-vg-nav=\"1\" style=\"left:" + (g.viewX + G.viewW + G.gap) + "px;top:" + iNavY + "px;width:" + G.navW + "px\" aria-label=\"" + esc(tx.proximos) + "\">" +
			"<span class=\"vgNav__arrow\">›</span><span class=\"vgNav__n\" data-vg-r=\"navR\"></span></button>");

		// mini-mapa da composição
		var iMiniW = (nW + 1) * 22 - 4;
		h.push("<span class=\"vgMini\" style=\"left:" + Math.round((g.width - iMiniW) / 2) + "px;top:" + G.miniY + "px;width:" + iMiniW + "px;height:" + G.miniH + "px\">" +
			"<span class=\"vgMini__win\" data-vg-r=\"miniWin\" style=\"width:" + (SLOTS * 22 - 4 + 8) + "px\"></span>");
		for (i = 0; i <= nW; i++) {
			h.push("<button type=\"button\" class=\"vgMini__m" + (i === 0 ? " vgMini__m--loco" : "") + "\" data-vg-jump=\"" + i + "\" style=\"left:" + (i * 22) + "px\"></button>");
		}
		h.push("</span>");

		h.push("</div>");

		var oWrap = document.createElement("div");
		oWrap.className = "vgSt__wrap";
		oWrap.innerHTML = h.join("");
		if (this.wrap && this.wrap.parentNode) { this.wrap.parentNode.removeChild(this.wrap); }
		this.wrap = oWrap;
		this.root.appendChild(oWrap);

		this.track = oWrap.querySelector(".vgSt__track");
		this.svg = oWrap.querySelector("svg");
		this.train = ref(oWrap, "train");
		this.navL = { el: oWrap.querySelector(".vgNav--l"), n: ref(oWrap, "navL") };
		this.navR = { el: oWrap.querySelector(".vgNav--r"), n: ref(oWrap, "navR") };
		this.miniWin = ref(oWrap, "miniWin");
		this.minis = Array.prototype.slice.call(oWrap.querySelectorAll(".vgMini__m"));
		this.loco = { el: oWrap.querySelector(".vgLoco"), st: ref(oWrap, "locoSt") };
		this.silos = Array.prototype.map.call(oWrap.querySelectorAll(".vgSilo"), function (el) {
			return { el: el, name: ref(el, "name"), pill: ref(el, "pill"), level: ref(el, "level"), min: ref(el, "min"),
				prod: ref(el, "prod"), pct: ref(el, "pct"), coneFill: ref(el, "coneFill"), gate: ref(el, "gate"), vz: ref(el, "vz") };
		});
		this.flows = Array.prototype.map.call(oWrap.querySelectorAll(".vgFlow"), function (el) {
			var aP = el.querySelectorAll("path");
			return { g: el, base: aP[0], dash: aP[1], d: "" };
		});
		this.wagons = Array.prototype.map.call(oWrap.querySelectorAll(".vgWag"), function (el) {
			return { el: el, num: ref(el, "num"), st: ref(el, "st"), pct: ref(el, "pct"), carga: ref(el, "carga"), plate: ref(el, "plate"),
				fills: Array.prototype.slice.call(el.querySelectorAll(".vgWag__fill")) };
		});
		this.nB = nB;
		this.nW = nW;
		this.start = -1;
	};

	StationDom.prototype._apply = function (d) {
		var that = this;
		var g = this.geo;
		var tx = d.textos || {};
		var iSel = d.selectedIndex;
		var nW = d.vagoes.length;
		var bAlgumaAtiva = d.bocas.some(function (b) { return b.ativa; });
		var bMove = !!d.running && bAlgumaAtiva;

		cls(this.wrap, "vgSt__wrap", [!d.running && "is-paused", bMove && "is-moving"]);
		if (this.svg && this.svg.pauseAnimations) {
			if (d.running) { this.svg.unpauseAnimations(); } else { this.svg.pauseAnimations(); }
		}

		/* ---- janela visível da composição ---- */
		if (this.nav && Date.now() - this.nav.at > NAV_MS) { this.nav = null; }
		var iMax = this._maxStart();
		var iStart = this.nav ? this.nav.start : clamp(iSel + 1 - Math.floor(SLOTS / 2), MIN_START, iMax);
		if (iStart !== this.start) {
			if (this.start < 0) { css(this.train, "transition", "none"); }
			css(this.train, "transform", "translateX(" + (-iStart * G.step) + "px)");
			if (this.start < 0) { void this.train.offsetWidth; css(this.train, "transition", ""); }
			this.start = iStart;
		}
		var nOcultosL = Math.max(0, iStart - 1);
		var nOcultosR = Math.max(0, nW + 1 - (iStart + SLOTS));
		cls(this.navL.el, "vgNav vgNav--l", [iStart <= MIN_START && "is-off"]);
		cls(this.navR.el, "vgNav vgNav--r", [iStart >= iMax && "is-off"]);
		txt(this.navL.n, nOcultosL ? "+" + nOcultosL : "");
		txt(this.navR.n, nOcultosR ? "+" + nOcultosR : "");
		css(this.miniWin, "left", (iStart * 22 - 4) + "px");
		cls(this.miniWin, "vgMini__win", [this.nav && "is-manual"]);
		function visivel(i) { return i + 1 >= iStart && i + 1 < iStart + SLOTS; }
		function xVagao(i) { return g.viewX + (i + 1 - iStart) * G.step; }

		// bocas alimentando cada vagão (para espaçar as linhas na chegada)
		var mFeed = {};
		d.bocas.forEach(function (b, j) {
			if (b.ativa && b.destinoIndex >= 0) { (mFeed[b.destinoIndex] = mFeed[b.destinoIndex] || []).push(j); }
		});

		d.bocas.forEach(function (b, j) {
			var r = that.silos[j];
			var bSel = b.ativa && b.destinoIndex === iSel;
			cls(r.el, "vgSilo", ["is-" + b.status, b.ativa && "is-flowing", bSel && "is-sel",
				(b.nivelBaixo || b.status === "siloVazio") && "is-low", b.produtoDivergente && "is-div", b.temAlerta && "has-alert"]);
			txt(r.name, b.nome);
			txt(r.pill, b.ativa ? "" : b.statusText);
			css(r.level, "height", b.nivelPct + "%");
			css(r.coneFill, "opacity", b.nivelPct > 0 ? "1" : "0");
			css(r.min, "bottom", (d.nivelMinimoPct || 0) + "%");
			txt(r.prod, b.produto);
			txt(r.pct, b.nivelPct + "%");
			txt(r.vz, b.vazaoTxt);
			css(r.gate, "width", (b.ativa ? Math.max(18, b.abertura) : 0) + "%");
			attr(r.el, "aria-label", b.titulo + ". " + b.statusText + ". " + b.produto + ". " + (tx.vazao || "") + " " + b.vazaoTxt + " t/h. " +
				(tx.comporta || "") + " " + b.aberturaTxt + ". " + b.nivelTxt + ". " + b.destinoTxt + (b.temAlerta ? ". " + b.alertaTxt : ""));

			var f = that.flows[j];
			var bOn = b.ativa && b.destinoIndex >= 0 && b.destinoIndex < nW && visivel(b.destinoIndex);
			if (bOn) {
				var aF = mFeed[b.destinoIndex];
				var k = aF.indexOf(j);
				var x0 = g.siloCX[j];
				var x1 = xVagao(b.destinoIndex) + G.slotW / 2 + (k - (aF.length - 1) / 2) * 18;
				var y0 = 4;
				var y1 = G.flowH + 4;
				var sD = "M" + x0 + " " + y0 + " C" + x0 + " " + Math.round(y0 + G.flowH * 0.62) + " " + x1 + " " + Math.round(y1 - G.flowH * 0.55) + " " + x1 + " " + y1;
				if (f.d !== sD) {
					f.base.setAttribute("d", sD);
					f.dash.setAttribute("d", sD);
					f.d = sD;
				}
			}
			cls(f.g, "vgFlow", [bOn && "is-on", bSel && "is-sel", b.produtoDivergente && "is-div"]);
		});

		d.vagoes.forEach(function (w, i) {
			var r = that.wagons[i];
			cls(r.el, "vgWag", ["st-" + w.statusKey, i === iSel && "is-sel", !w.vistoriado && "is-blocked", w.excesso && "is-over"]);
			attr(r.el, "aria-pressed", i === iSel ? "true" : "false");
			attr(r.el, "tabindex", visivel(i) ? "0" : "-1");
			attr(r.el, "aria-label", w.titulo + ". " + w.statusText + ". " + w.vistText + ". " + w.cargaTxt + " t " + w.limiteTxt.replace(" t", "") + ".");
			txt(r.num, "V" + w.label);
			txt(r.plate, w.placa);
			txt(r.st, w.statusText);
			// enchimento por seção (esquerda / centro / direita), conforme a receita
			r.fills.forEach(function (oFill, k) {
				var oSec = w.secoes && w.secoes[k];
				css(oFill, "height", (oSec ? oSec.fillPct : w.pct) + "%");
			});
			txt(r.pct, w.pctTxt);
			txt(r.carga, w.cargaTxt + " t");
			var m = that.minis[i + 1];
			cls(m, "vgMini__m", ["st-" + w.statusKey, i === iSel && "is-sel"]);
			attr(m, "title", "V" + w.label + " · " + w.statusText);
		});

		cls(this.loco.el, "vgLoco", [bMove && "is-run"]);
		txt(this.loco.st, bMove ? tx.locoMov : tx.locoParada);
	};

	return StationDom;
});
