sap.ui.define([
	"sap/ui/core/UIComponent"
], function (UIComponent) {
	"use strict";

	return UIComponent.extend("vagoes.dashboard.Component", {
		metadata: {
			manifest: "json",
			interfaces: ["sap.ui.core.IAsyncContentCreation"]
		},

		init: function () {
			UIComponent.prototype.init.apply(this, arguments);
			this._ocultarBarraLaunchpad();
		},

		/**
		 * Modo TV no Fiori Launchpad: esconde a barra do shell só enquanto este
		 * app está aberto (o Launchpad restaura ao navegar para outro app).
		 * Fora do Launchpad (index.html, Netlify) não faz nada.
		 * Alternativa sem código: abrir a URL com ?sap-ushell-config=headerless
		 */
		_ocultarBarraLaunchpad: function () {
			var oContainer = sap.ui.require("sap/ushell/Container") ||
				(window.sap && window.sap.ushell && window.sap.ushell.Container);
			if (!oContainer) {
				return;
			}
			function ocultar(oRenderer) {
				if (oRenderer && typeof oRenderer.setHeaderVisibility === "function") {
					// (visível, só no estado atual = este app, estados)
					oRenderer.setHeaderVisibility(false, true, ["app"]);
				}
			}
			try {
				var vRenderer = oContainer.getRendererInternal ? oContainer.getRendererInternal("fiori2")
					: oContainer.getRenderer && oContainer.getRenderer("fiori2");
				if (vRenderer && typeof vRenderer.then === "function") {
					vRenderer.then(ocultar, function () {});
				} else {
					ocultar(vRenderer);
				}
			} catch (e) {
				// versão do Launchpad sem essa API: a barra continua visível
			}
		}
	});
});
