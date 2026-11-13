/**
 * CarregamentoAutomatico
 * ------------------------------------------------------------------
 * MODO AUTOMÁTICO de enchimento: gera eventos no MESMO formato da API
 * real, sem precisar do servidor. Serve para demonstração, treinamento
 * e testes de tela.
 *
 * Tem a mesma interface do CarregamentoStream (iniciar, parar,
 * zerarContadores, getStatus, getUrl). Por isso o controller troca de
 * fonte sem mudar mais nada: os eventos passam pela mesma validação
 * (EventoCarregamento) e pelas mesmas regras (model/Carregamento.js).
 *
 * Como funciona:
 *  1. A cada intervalo, soma ao vagão atual o peso que a estação entrega
 *     naquele tempo. A vazão vem das bocas (ligadas x abertura), informada
 *     pelo controller na função fnObterVazaoTh.
 *  2. Envia {"VagaoId","PesoAtualKg","Status":"Carregando","DataHora"}.
 *  3. Quando o vagão chega a 100% da capacidade, envia "Carregado" e passa
 *     para o próximo VagaoId (HTC-0001, HTC-0002...). Não há fim: continua
 *     criando vagões enquanto estiver ligado.
 *  4. Parar/Iniciar: o gerador para de mandar eventos e depois continua
 *     do ponto em que estava.
 *
 * Relógio acelerado: com "aceleracao" 4, um minuto de tela equivale a
 * quatro minutos de operação. A DataHora dos eventos anda nesse relógio,
 * para a vazão calculada pela tela continuar sendo a vazão real (t/h).
 */
sap.ui.define([
	"./EventoCarregamento",
	"./CarregamentoStream"
], function (EventoCarregamento, CarregamentoStream) {
	"use strict";

	var STATUS = CarregamentoStream.STATUS;

	/** Valores padrão. Podem ser sobrescritos em manifest.json > carregamentoStream > automatico. */
	var CONFIGURACAO_PADRAO = {
		intervaloMs: 500,
		aceleracao: 4,
		prefixoVagao: "HTC-",
		variacaoVazaoPct: 5
	};

	/**
	 * Maior aceleração aceita. Acima disso o intervalo entre dois eventos, no
	 * relógio acelerado, fica longo demais para a tela calcular a vazão
	 * (ver INTERVALO_MAXIMO_VAZAO_S em model/Carregamento.js).
	 */
	var ACELERACAO_MAXIMA = 40;

	/**
	 * @param {object} oConfiguracao { intervaloMs, aceleracao, prefixoVagao, variacaoVazaoPct, capacidadeVagaoKg }
	 * @param {object} oCallbacks mesmos callbacks do CarregamentoStream
	 * @param {function(): number} fnObterVazaoTh devolve a vazão atual da estação (t/h)
	 */
	function CarregamentoAutomatico(oConfiguracao, oCallbacks, fnObterVazaoTh) {
		this._oConfiguracao = Object.assign({}, CONFIGURACAO_PADRAO, oConfiguracao || {});
		this._oConfiguracao.aceleracao = CarregamentoAutomatico.limitarAceleracao(this._oConfiguracao.aceleracao);
		this._oCallbacks = oCallbacks || {};
		this._fnObterVazaoTh = fnObterVazaoTh;
		this._iTimer = null;
		this._sStatus = STATUS.PARADO;
		this.zerarContadores();
	}

	/**
	 * Mantém a aceleração entre 1 (tempo real) e ACELERACAO_MAXIMA.
	 * O controller usa a mesma função para guardar no estado o valor realmente usado.
	 * @param {number} fAceleracao valor pedido na configuração
	 * @returns {number}
	 */
	CarregamentoAutomatico.limitarAceleracao = function (fAceleracao) {
		return Math.max(1, Math.min(ACELERACAO_MAXIMA, Number(fAceleracao) || 1));
	};

	/** Liga o gerador (botão "Iniciar"). Continua do vagão e do peso em que parou. */
	CarregamentoAutomatico.prototype.iniciar = function () {
		clearInterval(this._iTimer);
		this._iTimer = setInterval(this._gerarEvento.bind(this), this._oConfiguracao.intervaloMs);
		this._definirStatus(STATUS.AUTOMATICO);
	};

	/** Desliga o gerador (botão "Parar"). Os contadores são mantidos. */
	CarregamentoAutomatico.prototype.parar = function () {
		clearInterval(this._iTimer);
		this._iTimer = null;
		this._definirStatus(STATUS.PARADO);
	};

	/** Volta ao primeiro vagão, com peso zero (botão "Reiniciar"). */
	CarregamentoAutomatico.prototype.zerarContadores = function () {
		this._iNumeroDoVagao = 1;
		this._fPesoAtualKg = 0;
		this._iRelogioSimuladoMs = Date.now();
	};

	CarregamentoAutomatico.prototype.getStatus = function () {
		return this._sStatus;
	};

	CarregamentoAutomatico.prototype.getUrl = function () {
		return "";
	};

	/**
	 * Cadastro simulado dos vagões criados pelo modo automático (placa e vistoria).
	 * A cada 7 vagões um vem com a vistoria reprovada, para demonstrar o bloqueio
	 * da fatura. TODO integração: no stream real isso vem da API de cadastro/vistoria.
	 * @param {string} sVagaoId ex.: "HTC-0012"
	 * @returns {object|null} { placa, vistoriado, checklist } ou null se o id não for do gerador
	 */
	CarregamentoAutomatico.prototype.buscarCadastro = function (sVagaoId) {
		var sPrefixo = this._oConfiguracao.prefixoVagao;
		var iNumero = Number(String(sVagaoId).slice(sPrefixo.length));
		if (String(sVagaoId).indexOf(sPrefixo) !== 0 || !Number.isInteger(iNumero) || iNumero < 1) {
			return null;
		}
		var bReprovado = iNumero % 7 === 4;
		var iSerie = 718000 + ((iNumero * 7919) % 2900);
		return {
			placa: "HFE " + iSerie + "-" + (iNumero % 10),
			vistoriado: !bReprovado,
			checklist: { limpeza: true, escotilhas: !bReprovado, comportas: true, rodeiros: true }
		};
	};

	/* ------------------------------------------------------------------ */
	/* Internos                                                            */
	/* ------------------------------------------------------------------ */

	/** Identificador do vagão atual, ex.: "HTC-0003". */
	CarregamentoAutomatico.prototype._idDoVagaoAtual = function () {
		return this._oConfiguracao.prefixoVagao + String(this._iNumeroDoVagao).padStart(4, "0");
	};

	/** Um passo do gerador: calcula o novo peso e envia o evento. */
	CarregamentoAutomatico.prototype._gerarEvento = function () {
		var oCfg = this._oConfiguracao;
		var fVazaoTh = Math.max(0, this._fnObterVazaoTh ? this._fnObterVazaoTh() : 0);
		if (fVazaoTh <= 0) {
			return; // nenhuma boca descarregando: não há evento (e nenhum vagão novo é criado)
		}

		// tempo de operação que este passo representa (relógio acelerado)
		var iTempoSimuladoMs = oCfg.intervaloMs * oCfg.aceleracao;
		this._iRelogioSimuladoMs += iTempoSimuladoMs;

		// oscilação natural do grão: +/- variacaoVazaoPct
		var fOscilacao = 1 + (Math.random() - 0.5) * 2 * oCfg.variacaoVazaoPct / 100;
		var fIncrementoKg = fVazaoTh * 1000 / 3600 * (iTempoSimuladoMs / 1000) * fOscilacao;

		var fNovoPesoKg = Math.round((this._fPesoAtualKg + fIncrementoKg) * 10) / 10;
		var sVagaoId = this._idDoVagaoAtual();

		if (fNovoPesoKg >= oCfg.capacidadeVagaoKg) {
			// encheu: fecha em 100% e o próximo evento já é do vagão seguinte
			this._emitir(sVagaoId, oCfg.capacidadeVagaoKg, "Carregado");
			this._iNumeroDoVagao++;
			this._fPesoAtualKg = 0;
		} else {
			this._fPesoAtualKg = fNovoPesoKg;
			this._emitir(sVagaoId, fNovoPesoKg, "Carregando");
		}
	};

	/** Monta o texto JSON igual ao da API e passa pela mesma validação do stream real. */
	CarregamentoAutomatico.prototype._emitir = function (sVagaoId, fPesoKg, sStatus) {
		var sMensagem = JSON.stringify({
			VagaoId: sVagaoId,
			PesoAtualKg: fPesoKg,
			Status: sStatus,
			DataHora: new Date(this._iRelogioSimuladoMs).toISOString()
		});
		var oEvento = EventoCarregamento.interpretarMensagem(sMensagem);
		if (oEvento && this._oCallbacks.aoReceberEvento) {
			this._oCallbacks.aoReceberEvento(oEvento);
		}
	};

	CarregamentoAutomatico.prototype._definirStatus = function (sNovoStatus) {
		if (this._sStatus === sNovoStatus) {
			return;
		}
		this._sStatus = sNovoStatus;
		if (this._oCallbacks.aoMudarStatusConexao) {
			this._oCallbacks.aoMudarStatusConexao(sNovoStatus);
		}
	};

	return CarregamentoAutomatico;
});
