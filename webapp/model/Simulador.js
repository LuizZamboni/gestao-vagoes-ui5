/**
 * Simulação da operação (somente protótipo).
 *
 * Cada função recebe o estado bruto e devolve um NOVO estado (imutável).
 * Na implementação definitiva:
 *   - passo()            -> substituir por leitura periódica / WebSocket do backend
 *   - ações (iniciar, parar, abertura, destino, excesso, fatura)
 *                        -> substituir por chamadas OData (actions/functions)
 */
sap.ui.define([
	"./Regras"
], function (Regras) {
	"use strict";

	/** Fator de aceleração: toneladas por tick = vazão (t/h) / FATOR. */
	var FATOR = 480;

	function clone(o) { return JSON.parse(JSON.stringify(o)); }
	function r1(v) { return Math.round(v * 10) / 10; }
	function vagao(s, iPos) { return s.vagoes.filter(function (w) { return w.pos === iPos; })[0]; }
	/** Vazão da boca = vazão da receita do material × abertura da comporta. */
	function vazaoAlvo(s, b) {
		var r = Regras.receita(s, b.produto);
		return Math.round((r ? r.vazao : 0) * b.abertura / 100);
	}

	/** Reparte uma quantidade entre as seções do vagão conforme a receita. */
	function distribuir(w, nQtd, oReceita) {
		Regras.SECOES.forEach(function (k) {
			w.secoes[k] += nQtd * oReceita.distribuicao[k] / 100;
		});
	}

	/** Ajusta a carga total mantendo a proporção entre as seções. */
	function escalar(w, nNova) {
		var f = w.carga > 0 ? nNova / w.carga : 0;
		Regras.SECOES.forEach(function (k) { w.secoes[k] *= f; });
		w.carga = nNova;
	}

	var Simulador = {

		estadoInicial: function (oMock) {
			var s = clone(oMock);
			s.simulacao = { rodando: true, ultimaAtualizacao: new Date().toISOString() };
			// carga por seção (esquerda / centro / direita); sem histórico, usa a receita da composição
			var oRec = Regras.receita(s, s.composicao.produto);
			s.vagoes.forEach(function (w) {
				if (!w.secoes) {
					w.secoes = { esquerda: 0, centro: 0, direita: 0 };
					distribuir(w, w.carga, oRec);
				}
			});
			return s;
		},

		/** Um ciclo de descarga. */
		passo: function (state) {
			var s = clone(state);
			if (!s.simulacao.rodando || s.fatura.emitida) {
				return s;
			}
			var c = s.composicao;
			var ALVO = Regras.alvo(c);

			// bocas aguardando vagão retomam quando houver vagão disponível
			s.bocas.forEach(function (b) {
				if (b.status === "aguardandoVagao") {
					var oProx = Regras.proximoVagao(s, 0);
					if (oProx) {
						b.status = "ativa";
						b.destino = oProx.pos;
					}
				}
			});

			// descarga
			var mCarregados = {};
			s.bocas.forEach(function (b) {
				if (b.status !== "ativa" || b.destino == null) { return; }
				var w = vagao(s, b.destino);
				if (!Regras.disponivel(w, c)) {
					var oNovo = Regras.proximoVagao(s, b.destino);
					if (!oNovo) {
						b.status = "aguardandoVagao";
						b.destino = null;
						b.vazao = 0;
						return;
					}
					b.destino = oNovo.pos;
					w = oNovo;
				}
				b.vazao = b.abertura > 0 ? Math.max(0, vazaoAlvo(s, b) + Math.round(Math.random() * 60 - 30)) : 0;
				var dt = Math.min(b.estoque, b.vazao / FATOR);
				b.estoque = Math.max(0, b.estoque - dt);
				b.descarregadoTurno += dt;
				w.carga += dt;
				distribuir(w, dt, Regras.receita(s, b.produto));
				if (w.bocas.indexOf(b.n) < 0) {
					w.bocas.push(b.n);
					w.bocas.sort();
				}
				mCarregados[w.pos] = true;
				if (b.estoque <= 0.01) {
					b.estoque = 0;
					b.status = "siloVazio";
					b.vazao = 0;
					b.destino = null;
				}
			});

			// vagão atingiu a carga-alvo -> bocas seguem para o próximo vagão disponível
			Object.keys(mCarregados).forEach(function (sPos) {
				var w = vagao(s, Number(sPos));
				if (w.carga >= ALVO) {
					escalar(w, ALVO);
					var oProx = Regras.proximoVagao(s, w.pos);
					s.bocas.forEach(function (b) {
						if (b.status === "ativa" && b.destino === w.pos) {
							if (oProx) {
								b.destino = oProx.pos;
							} else {
								b.status = "aguardandoVagao";
								b.destino = null;
								b.vazao = 0;
							}
						}
					});
				}
			});

			s.vagoes.forEach(function (w) {
				w.carga = r1(w.carga);
				Regras.SECOES.forEach(function (k) { w.secoes[k] = Math.round(w.secoes[k] * 100) / 100; });
			});
			s.bocas.forEach(function (b) {
				b.estoque = r1(b.estoque);
				b.descarregadoTurno = r1(b.descarregadoTurno);
			});
			s.simulacao.ultimaAtualizacao = new Date().toISOString();
			return s;
		},

		alternarSimulacao: function (state) {
			var s = clone(state);
			s.simulacao.rodando = !s.simulacao.rodando;
			return s;
		},

		retirarExcesso: function (state, iVagao) {
			var s = clone(state);
			var w = s.vagoes[iVagao];
			escalar(w, Math.min(w.carga, s.composicao.limiteVagao));
			return s;
		},

		iniciarBoca: function (state, iBoca) {
			var s = clone(state);
			var b = s.bocas[iBoca];
			var c = s.composicao;
			if (s.fatura.emitida || b.status === "siloVazio") {
				return s;
			}
			if (!b.abertura) {
				b.abertura = 80;
			}
			// prioridade: destino escolhido > vagão já em carga > próximo disponível
			var oDest = b.destino != null && Regras.disponivel(vagao(s, b.destino), c) ? vagao(s, b.destino) : null;
			if (!oDest) {
				s.bocas.forEach(function (o) {
					if (!oDest && o !== b && o.status === "ativa" && o.destino != null && Regras.disponivel(vagao(s, o.destino), c)) {
						oDest = vagao(s, o.destino);
					}
				});
			}
			oDest = oDest || Regras.proximoVagao(s, 0);
			if (oDest) {
				b.status = "ativa";
				b.destino = oDest.pos;
				b.vazao = vazaoAlvo(s, b);
			} else {
				b.status = "aguardandoVagao";
				b.destino = null;
				b.vazao = 0;
			}
			return s;
		},

		pararBoca: function (state, iBoca) {
			var s = clone(state);
			var b = s.bocas[iBoca];
			if (b.status === "ativa" || b.status === "aguardandoVagao") {
				b.status = "parada";
				b.vazao = 0;
			}
			return s;
		},

		definirAbertura: function (state, iBoca, iAbertura) {
			var s = clone(state);
			var b = s.bocas[iBoca];
			b.abertura = Math.max(0, Math.min(100, Math.round(iAbertura)));
			if (b.status === "ativa") {
				b.vazao = vazaoAlvo(s, b);
			}
			return s;
		},

		definirDestino: function (state, iBoca, iPos) {
			var s = clone(state);
			if (Regras.disponivel(vagao(s, iPos), s.composicao)) {
				s.bocas[iBoca].destino = iPos;
			}
			return s;
		},

		emitirFatura: function (state, sHora) {
			var s = clone(state);
			s.fatura.emitida = true;
			s.fatura.numero = s.fatura.numeroPrevisto;
			s.fatura.hora = sHora;
			s.simulacao.rodando = false;
			s.bocas.forEach(function (b) {
				if (b.status === "ativa" || b.status === "aguardandoVagao") {
					b.status = "parada";
					b.vazao = 0;
				}
			});
			return s;
		}
	};

	return Simulador;
});
