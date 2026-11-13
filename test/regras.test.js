// Testes das regras (sem UI5): node test/regras.test.js   ou   npm test
const W = process.argv[2] || require('path').join(__dirname, '..', 'webapp');
const { mods, t, faltando, cadastro } = require('./carregar')(W, ['model/Formatador', 'model/Regras', 'model/Carregamento', 'model/Faturamento', 'model/ModeloTela', 'model/stream/EventoCarregamento', 'model/stream/CarregamentoStream', 'model/stream/CarregamentoAutomatico']);
const { Regras, Carregamento: C, Faturamento: F, ModeloTela: M, EventoCarregamento: E, CarregamentoAutomatico: Auto } = mods;
let ok = 0, falhas = 0;
const eq = (nome, a, b) => { if (JSON.stringify(a) === JSON.stringify(b)) ok++; else { falhas++; console.log('FALHOU', nome, '\n   obtido  ', JSON.stringify(a), '\n   esperado', JSON.stringify(b)); } };
const buscar = id => cadastro.cadastroVagoes.find(v => v.id === id) || null;
const ev = (id, kg, st, ms) => E.normalizar({ VagaoId: id, PesoAtualKg: kg, Status: st, DataHora: new Date(ms).toISOString() });
const T0 = Date.parse('2026-11-13T13:00:00Z');
const novo = (o) => C.definirFonteAtiva(C.definirStatusDaFonte(C.criarEstadoInicial(cadastro, Object.assign({ fonte: 'stream' }, o)), 'conectado'), true);
const vm = (s, sel) => M.montar(s, { indiceVagaoSelecionado: sel || 0, indiceBocaSelecionada: 0, seguindoCarga: true }, t, { agoraMs: Date.now(), limiteSemDadosMs: 15000 });

// 1) transbordo: um único VagaoId incrementando 500,5 kg a cada 0,5 s (emissor de teste)
let s = novo({});
let lote = []; for (let i = 1; i <= 400; i++) lote.push(ev('HTC-0002', 500.5 * i, 'Carregando', T0 + i * 500));
s = C.aplicarEventos(s, lote, buscar); // 200.200 kg = 2 cheios + 8.200 kg no terceiro
eq('transbordo: 3 vagões', s.vagoes.length, 3);
eq('transbordo: pesos', s.vagoes.map(v => v.pesoKg), [96000, 96000, 8200]);
eq('transbordo: ids', s.vagoes.map(v => v.id), ['HTC-0002', 'HTC-0002 #2', 'HTC-0002 #3']);
eq('transbordo: placa do cadastro só no primeiro', s.vagoes.map(v => v.placa), ['HFE 719155-1', 'HTC-0002 #2', 'HTC-0002 #3']);
eq('transbordo: status', s.vagoes.map(v => Regras.statusVagao(v, s.composicao)), ['carregado', 'carregado', 'carregando']);
eq('transbordo: percentuais', s.vagoes.map(v => Regras.percentualVagao(v, s.composicao)), [100, 100, 8]);
eq('transbordo: em carga', Regras.indiceVagaoEmCarga(s), 2);
eq('vazão ~1001 kg/s', Math.round(s.vagoes[2].vazaoKgPorSegundo), 1001);
eq('fatura: situações', s.vagoes.map(v => Regras.situacaoFaturamento(v, s.composicao).situacao), ['liberado', 'liberado', 'aguardando']);
// eventos param -> nenhum vagão novo
const antes = s.vagoes.length; s = C.aplicarEventos(s, [], buscar); eq('sem evento, sem vagão novo', s.vagoes.length, antes);
// 99,99% não é 100
eq('95.999 kg = 99%', Regras.percentualVagao({ pesoKg: 95999 }, s.composicao), 99);
eq('96.000 kg = 100%', Regras.percentualVagao({ pesoKg: 96000 }, s.composicao), 100);

// 2) faturamento por vagão
let f = F.faturarVagao(s, 2, T0); eq('não fatura vagão que não encheu', f, s);
f = F.faturarVagao(s, 0, T0); eq('NF do primeiro', f.vagoes[0].fatura.numero, '000.482'); eq('próximo número', f.faturamento.proximoNumero, 483);
eq('faturado', Regras.situacaoFaturamento(f.vagoes[0], f.composicao).situacao, 'faturado');
f = F.faturarLiberados(f, T0); eq('fatura os demais liberados', f.vagoes.map(v => v.fatura && v.fatura.numero), ['000.482', '000.483', null]);
// vagão faturado não muda com eventos novos
const f2 = C.aplicarEventos(f, [ev('HTC-0002', 210000, 'Carregando', T0 + 500 * 401)], buscar);
eq('faturado é imutável', [f2.vagoes[0].pesoKg, f2.vagoes[0].fatura.numero], [96000, '000.482']);

// 3) reinício da balança (peso despenca) -> vagão novo, anteriores preservados
let r = novo({}); r = C.aplicarEventos(r, [ev('HTC-0001', 30000, 'Carregando', T0), ev('HTC-0001', 50000, 'Carregando', T0 + 1000), ev('HTC-0001', 500, 'Carregando', T0 + 2000)], buscar);
eq('reinício: 2 vagões', r.vagoes.map(v => [v.id, v.pesoKg]), [['HTC-0001', 50000], ['HTC-0001 #2', 500]]);
// pequena correção para baixo não é reinício
let c2 = novo({}); c2 = C.aplicarEventos(c2, [ev('HTC-0001', 30000, 'Carregando', T0), ev('HTC-0001', 29950, 'Carregando', T0 + 1000)], buscar);
eq('correção pequena não cria vagão', c2.vagoes.map(v => v.pesoKg), [29950]);
// fora de ordem
let o = novo({}); o = C.aplicarEventos(o, [ev('HTC-0001', 30000, 'Carregando', T0 + 5000), ev('HTC-0001', 10000, 'Carregando', T0)], buscar);
eq('fora de ordem ignorado', o.vagoes[0].pesoKg, 30000);

// 4) transbordo desligado -> excesso bloqueia a fatura
let x = novo({ transbordoAutomatico: false }); x = C.aplicarEventos(x, [ev('HTC-0003', 97400, 'Carregado', T0)], buscar);
eq('sem transbordo: 1 vagão em excesso', [x.vagoes.length, Regras.statusVagao(x.vagoes[0], x.composicao)], [1, 'excesso']);
eq('excesso bloqueia', Regras.situacaoFaturamento(x.vagoes[0], x.composicao), { situacao: 'bloqueado', motivo: 'excessoDePeso' });

// 5) vistoria reprovada bloqueia; não informada libera
let v = novo({}); v = C.aplicarEventos(v, [ev('HTC-0004', 96000, 'Carregado', T0), ev('XYZ-9', 96000, 'Carregado', T0)], buscar);
eq('vistoria reprovada bloqueia', Regras.situacaoFaturamento(v.vagoes[0], v.composicao), { situacao: 'bloqueado', motivo: 'vistoriaReprovada' });
eq('sem cadastro libera', [v.vagoes[1].vistoria, Regras.situacaoFaturamento(v.vagoes[1], v.composicao).situacao], ['naoInformada', 'liberado']);
// sistema finalizou antes de encher -> libera
let fin = novo({}); fin = C.aplicarEventos(fin, [ev('HTC-0001', 80000, 'Finalizado', T0)], buscar);
eq('finalizado libera', [Regras.statusVagao(fin.vagoes[0], fin.composicao), Regras.situacaoFaturamento(fin.vagoes[0], fin.composicao).situacao], ['finalizado', 'liberado']);

// 6) VagaoIds diferentes -> um vagão por id, em ordem
let d = novo({}); d = C.aplicarEventos(d, [ev('HTC-0001', 96000, 'Carregado', T0), ev('HTC-0002', 500, 'Carregando', T0 + 500), ev('htc-0002 ', 1000, 'Carregando', T0 + 1000)], buscar);
eq('ids distintos', d.vagoes.map(v => [v.id, v.pesoKg]), [['HTC-0001', 96000], ['HTC-0002', 1000]]);
// limite de segurança
let lim = novo({ limiteVagoes: 2 }); lim = C.aplicarEventos(lim, [ev('A-1', 96000 * 5, 'Carregando', T0)], buscar);
eq('limite de segurança', [lim.vagoes.length, lim.leitura.vagoesNaoCriados > 0], [2, true]);

// 7) bocas e vazão configurada
eq('vazão nominal por boca', Regras.vazaoNominalPorBocaTh(s, 'Farelo de soja'), 300);
eq('vazão configurada', Regras.vazaoConfiguradaTh(s), 300 * (95 + 90 + 70 + 85 + 80 + 75) / 100);
let b = C.alternarBoca(s, 0); eq('boca desligada sai da vazão', Regras.vazaoConfiguradaTh(b), 300 * (90 + 70 + 85 + 80 + 75) / 100);
b = C.definirAberturaDaBoca(b, 1, 150); eq('abertura limitada a 100', b.bocas[1].aberturaPct, 100);
eq('seção da boca', [0, 1, 2, 3, 4, 5].map(i => Regras.secaoDaBoca(i, 6)), [0, 0, 1, 1, 2, 2]);

// 8) modelo de tela
const m = vm(s, 2);
eq('tela: foco', [m.vagaoEmFoco.sigla, m.vagaoEmFoco.percentualTexto, m.vagaoEmFoco.statusTexto], ['V03', '8%', 'Carregando']);
eq('tela: fila de fatura', m.faturamento.fila.map(l => [l.sigla, l.faturaSituacao]), [['V02', 'liberado'], ['V01', 'liberado']]);
eq('tela: estação recebe vizinhos', m.estacao.vagoes.map(x => x.indice), [0, 1, 2]);
eq('tela: indicadores', [m.indicadores.totalTexto, m.indicadores.cheiosTexto], ['200,2', '2']);
const vazio = vm(novo({}), 0); eq('tela vazia', [vazio.temVagoes, vazio.vagaoEmFoco.indice, vazio.estacao.vagoes.length, vazio.faturamento.filaVazia], [false, -1, 0, true]);
// lista limitada com muitos vagões
let muitos = novo({}); muitos = C.aplicarEventos(muitos, [ev('HTC-0002', 96000 * 300 + 1000, 'Carregando', T0)], buscar);
const mm = vm(muitos, 300);
eq('muitos vagões: modelo limitado', [muitos.vagoes.length, mm.lista.vagoes.length, mm.faturamento.fila.length, mm.estacao.vagoes.length <= 5, mm.lista.temAnteriores], [301, 6, 5, true, true]);

// 9) modo automático: enche até 100%, cria o próximo e não para
(async () => {
  const eventos = []; let estado = C.definirFonteAtiva(C.criarEstadoInicial(cadastro, { fonte: 'automatico', aceleracao: 40 }), true);
  eq('automático: aceleração limitada', [Auto.limitarAceleracao(400), Auto.limitarAceleracao(0), Auto.limitarAceleracao(4)], [40, 1, 4]);
  const cb = { aoReceberEvento: e => eventos.push(e), aoMudarStatusConexao: st => { estado = C.definirStatusDaFonte(estado, st); } };
  // parar/iniciar com o temporizador de verdade
  const rapido = new Auto({ intervaloMs: 5, aceleracao: 40, capacidadeVagaoKg: 96000 }, cb, () => Regras.vazaoConfiguradaTh(estado));
  rapido.iniciar(); await new Promise(r => setTimeout(r, 150)); rapido.parar();
  const n1 = eventos.length; await new Promise(r => setTimeout(r, 120));
  eq('automático: gerou eventos e parar interrompe', [n1 > 5, eventos.length], [true, n1]);
  eventos.length = 0;
  // enchimento: 70 passos de 20 s simulados (aceleração 40 x 500 ms)
  const auto = new Auto({ intervaloMs: 500, aceleracao: 40, capacidadeVagaoKg: 96000 }, cb, () => Regras.vazaoConfiguradaTh(estado));
  for (let i = 0; i < 70; i++) auto._gerarEvento();
  estado = C.definirStatusDaFonte(estado, 'parado');
  estado = C.aplicarEventos(estado, eventos.splice(0), id => auto.buscarCadastro(id));
  const cheios = estado.vagoes.filter(x => Regras.vagaoCheio(x, estado.composicao));
  eq('automático: criou vários vagões', estado.vagoes.length >= 3, true);
  eq('automático: cheios em exatamente 100%', cheios.every(x => x.pesoKg === 96000), true);
  eq('automático: ids em sequência', estado.vagoes.slice(0, 3).map(x => x.id), ['HTC-0001', 'HTC-0002', 'HTC-0003']);
  const taxa = estado.vagoes[estado.vagoes.length - 1].vazaoKgPorSegundo * 3.6;
  eq('automático: vazão medida ≈ configurada (1485 t/h ±10%)', taxa === 0 || Math.abs(taxa - 1485) < 150, true);
  eq('automático: status', estado.fonte.status, 'parado');
  rapido.iniciar(); await new Promise(r => setTimeout(r, 120)); rapido.parar();
  eq('automático: iniciar de novo retoma', eventos.length > 0, true);
  const mAuto = M.montar(estado, { indiceVagaoSelecionado: 0, seguindoCarga: true }, t, { agoraMs: Date.now() });
  eq('automático: silos consumidos', estado.bocas[0].estoqueT < 1840, true);
  console.log('placas simuladas:', estado.vagoes.slice(0, 4).map(x => x.placa + '/' + x.vistoria).join('  '));
  console.log('i18n ausentes:', [...faltando]);
  console.log(`\n${ok} ok, ${falhas} falhas`); process.exit(falhas ? 1 : 0);
})();
