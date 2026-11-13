// Carrega os módulos sap.ui.define do projeto em Node (sem UI5), para testes de regra.
const fs = require('fs'), path = require('path');
module.exports = function (W, lista) {
  const mods = { Log: { warning() {}, error() {}, info() {} } }; let atual;
  global.window = global.window || { location: { protocol: 'https:', href: 'https://x/' } };
  global.sap = { ui: { define: (deps, fn) => { mods[atual] = fn.apply(null, deps.map(d => { const n = d.split('/').pop(); if (!(n in mods)) throw new Error('dep ausente ' + d + ' em ' + atual); return mods[n]; })); } } };
  for (const m of lista) { atual = m.split('/').pop(); (0, eval)(fs.readFileSync(path.join(W, m + '.js'), 'utf8')); }
  const dict = {}; fs.readFileSync(path.join(W, 'i18n/i18n.properties'), 'utf8').split(/\n/).forEach(l => { l = l.trim(); if (!l || l[0] === '#') return; const i = l.indexOf('='); dict[l.slice(0, i)] = l.slice(i + 1); });
  const faltando = new Set();
  const t = (k, a) => k in dict ? dict[k].replace(/\{(\d+)\}/g, (_, n) => a && a[n] != null ? a[n] : '') : (faltando.add(k), '??' + k);
  return { mods, t, dict, faltando, cadastro: JSON.parse(fs.readFileSync(path.join(W, 'model/mockData.json'), 'utf8')) };
};
