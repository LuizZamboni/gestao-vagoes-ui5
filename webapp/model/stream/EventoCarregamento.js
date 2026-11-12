/**
 * EventoCarregamento
 * ------------------------------------------------------------------
 * Valida e normaliza cada mensagem recebida do stream de carregamento.
 *
 * Contrato da API (GET {servidor}/GestaoCooperado/stream, Accept: text/event-stream).
 * Cada evento SSE traz no campo "data" um JSON como:
 *
 *   {
 *     "VagaoId": "HTC-0002",
 *     "PesoAtualKg": 500.5,
 *     "Status": "Carregando",
 *     "DataHora": "2026-11-12T13:20:42.6379277Z"
 *   }
 *
 * Campo opcional aceito: "BocaId" (número da boca que está descarregando).
 * Quando o backend passar a enviá-lo, a tela liga cada boca ao vagão correto.
 *
 * Por que validar? Os dados vêm da rede. Nenhuma mensagem é usada antes de
 * passar por aqui: tipos conferidos, tamanhos limitados e texto saneado.
 * Mensagens inválidas são descartadas (retorno null), e a tela não quebra.
 */
sap.ui.define([], function () {
	"use strict";

	/** Tamanho máximo aceito para o texto de uma mensagem (proteção contra payloads gigantes). */
	var TAMANHO_MAXIMO_MENSAGEM = 4096;

	/** Identificador de vagão: letras, números, espaço, ponto, hífen, barra e sublinhado; até 40 caracteres. */
	var PADRAO_ID_VAGAO = /^[A-Za-z0-9][A-Za-z0-9 ._\/-]{0,39}$/;

	/** Faixa plausível de peso (kg). Valores fora disso são considerados leitura inválida da balança. */
	var PESO_MINIMO_KG = -1000;
	var PESO_MAXIMO_KG = 250000;

	/** Tamanho máximo do texto de status exibido na tela. */
	var TAMANHO_MAXIMO_STATUS = 40;

	/**
	 * Tradução do "Status" da API para uma chave interna.
	 * Status desconhecidos não quebram a tela: viram "desconhecido" e a regra
	 * de negócio decide pelo peso.
	 */
	var MAPA_STATUS = {
		"carregando": "carregando",
		"em carregamento": "carregando",
		"carregado": "carregado",
		"finalizado": "carregado",
		"concluido": "carregado",
		"aguardando": "aguardando",
		"vazio": "aguardando",
		"parado": "parado",
		"pausado": "parado",
		"interrompido": "parado"
	};

	/** Remove acentos e espaços extras e passa para minúsculas, para comparar status. */
	function simplificarTexto(sTexto) {
		return String(sTexto).normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
	}

	/**
	 * Converte a DataHora da API em milissegundos.
	 * O backend (.NET) envia 7 casas decimais ("...42.6379277Z"). Alguns navegadores
	 * só aceitam 3, por isso as casas extras são cortadas antes do Date.parse.
	 * @returns {number|null}
	 */
	function lerDataHoraEmMs(vDataHora) {
		if (typeof vDataHora !== "string" || vDataHora.length > 40) {
			return null;
		}
		var sDataHoraNormalizada = vDataHora.trim().replace(/(\.\d{3})\d+/, "$1");
		var iMilissegundos = Date.parse(sDataHoraNormalizada);
		return isNaN(iMilissegundos) ? null : iMilissegundos;
	}

	var EventoCarregamento = {

		TAMANHO_MAXIMO_MENSAGEM: TAMANHO_MAXIMO_MENSAGEM,

		/**
		 * Interpreta o texto bruto de uma mensagem SSE (MessageEvent.data).
		 * @param {string} sTextoMensagem texto JSON recebido
		 * @returns {object|null} evento normalizado (ver normalizar) ou null se inválido
		 */
		interpretarMensagem: function (sTextoMensagem) {
			if (typeof sTextoMensagem !== "string" || sTextoMensagem.length === 0 ||
				sTextoMensagem.length > TAMANHO_MAXIMO_MENSAGEM) {
				return null;
			}
			var oConteudo;
			try {
				oConteudo = JSON.parse(sTextoMensagem);
			} catch (oErro) {
				return null;
			}
			return EventoCarregamento.normalizar(oConteudo);
		},

		/**
		 * Valida o objeto da API e devolve o formato interno usado pelo app.
		 * @param {object} oConteudo objeto já convertido de JSON
		 * @returns {{vagaoId: string, pesoAtualKg: number, statusSistema: string, statusChave: string,
		 *            dataHoraMs: number, recebidoEmMs: number, bocaNumero: (number|null)}|null}
		 */
		normalizar: function (oConteudo) {
			if (!oConteudo || typeof oConteudo !== "object" || Array.isArray(oConteudo)) {
				return null;
			}

			var sVagaoId = typeof oConteudo.VagaoId === "string" ? oConteudo.VagaoId.trim() : "";
			if (!PADRAO_ID_VAGAO.test(sVagaoId)) {
				return null;
			}

			var fPesoAtualKg = typeof oConteudo.PesoAtualKg === "number" ? oConteudo.PesoAtualKg : Number(oConteudo.PesoAtualKg);
			if (!isFinite(fPesoAtualKg) || fPesoAtualKg < PESO_MINIMO_KG || fPesoAtualKg > PESO_MAXIMO_KG) {
				return null;
			}

			var sStatusSistema = typeof oConteudo.Status === "string"
				? oConteudo.Status.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, TAMANHO_MAXIMO_STATUS)
				: "";
			var sStatusChave = MAPA_STATUS[simplificarTexto(sStatusSistema)] || "desconhecido";

			var iRecebidoEmMs = Date.now();
			var iDataHoraMs = lerDataHoraEmMs(oConteudo.DataHora);

			var iBocaNumero = Number(oConteudo.BocaId);
			var bBocaValida = Number.isInteger(iBocaNumero) && iBocaNumero > 0 && iBocaNumero < 100;

			return {
				vagaoId: sVagaoId,
				pesoAtualKg: Math.max(0, fPesoAtualKg),
				statusSistema: sStatusSistema,
				statusChave: sStatusChave,
				dataHoraMs: iDataHoraMs === null ? iRecebidoEmMs : iDataHoraMs,
				recebidoEmMs: iRecebidoEmMs,
				bocaNumero: bBocaValida ? iBocaNumero : null
			};
		}
	};

	return EventoCarregamento;
});
