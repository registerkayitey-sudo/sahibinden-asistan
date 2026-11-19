const path = require('path');
const A = require(process.argv[2] || path.join(__dirname, '..', 'sahibinden-asistan.user.js'));
const cfg = JSON.parse(JSON.stringify(A.DEFAULT_CONFIG));
let fails = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fails++; console.log((ok ? 'ok  ' : 'FAIL'), name, ok ? '' : `got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); };
const tr = (d, info = {}) => A.parseTramer({ title: '', description: d, info }).amount;
eq('tramer 85 bin', tr('Aracın tramer kaydı 85 bin TL'), 85000);
eq('tramer 85.000', tr('TRAMER: 85.000 TL'), 85000);
eq('12.500 tl tramer', tr('sadece 12.500 TL tramer var'), 12500);
eq('tramersiz', tr('Hatasız boyasız TRAMERSİZ'), 0);
eq('tramer yok', tr('tramer kaydı yok, bakımlı'), 0);
eq('hasar kaydı yok', tr('Hasar kaydı yoktur.'), 0);
eq('tramer yok 2021 model', tr('tramer yok 2021 model'), 0);
eq('tramer 45 (bin varsayımı)', tr('tramer 45'), 45000);
eq('2 parça tramer', tr('tramer 2 parça toplam 30 bin'), 30000);
eq('max of two', tr('tramer 10 bin, sonra tramer 20 bin'), 20000);
eq('bitişik TL', tr('ARACIMIZDA  595.000TL TRAMER KAYDI VARDIR'), 595000);
eq('85bin', tr('tramer 85bin'), 85000);
eq('85k tl', tr('tramer: 85k tl'), 85000);
eq('unknown', tr('çok temiz araç'), null);
eq('info field', tr('', { 'Tramer Tutarı': '120.000 TL' }), 120000);
eq('km 20k', A.kmScore(15000, cfg.scoring.km), 40);
eq('km 125k', A.kmScore(125000, cfg.scoring.km), 0);
eq('km 72.5k', A.kmScore(72500, cfg.scoring.km), 20);
eq('tramer tiers', [0, 50000, 100000, 299999, 300000, null].map((a) => A.tramerScore(a, cfg.scoring.tramer)), [20, 15, 8, 8, 0, 0]);
eq('kw boundary', A.findKeyword(A.fold('DEĞİŞENSİZ BOYASIZ'), ['değişen']), null);
eq('kw fold', A.findKeyword(A.fold('KIRMIZI DERİ koltuklar'), ['kırmızı deri']), 'kırmızı deri');
eq('hud no false', A.findKeyword(A.fold('hudut'), ['hud']), null);

const base = {
  id: '1', url: 'u', title: 'BMW 320i First Edition M Sport', price: 2300000, year: 2021, km: 60000,
  info: { 'Yıl': '2021', 'KM': '60.000' }, features: ['Head-Up Display'], description: 'Hatasız, tramer 50 bin. Kırmızı deri koltuk.',
  parts: { 'Tavan': 'orijinal', 'Motor Kaputu': 'orijinal', 'Sağ Ön Çamurluk': 'boyalı' }, images: [],
};
const h = A.evalHard(base, cfg);
eq('hard pass', h.status, 'gecti');
const s = A.scoreListing(base, cfg);
console.log('  score', Math.round(s.total), '/', s.max, s.lines.map((l) => `${l.name}:${Math.round(l.points)}${l.pending ? '⏳' : ''}`).join(' | '));
eq('max 150', s.max, 150);
eq('hard fail kaput', A.evalHard({ ...base, parts: { ...base.parts, 'Motor Kaputu': 'lokal boyalı' } }, cfg).fails, ['Motor Kaputu: lokal boyalı']);
eq('hard unsure hud', A.evalHard({ ...base, features: [] }, cfg).status, 'belirsiz');
eq('hard unsure parts', A.evalHard({ ...base, parts: {} }, cfg).unknowns.map((u) => u.key), ['parts']);
eq('km 125000 fails', A.evalHard({ ...base, km: 125000 }, cfg).status, 'elendi');
const q = (id) => cfg.scoring.criteria.find((c) => c.id === id).vision;
const withVision = { ...base, ai: { vision: { jant: { question: q('jant'), yes: 2, no: 0, result: true }, izgara: { question: q('izgara'), yes: 1, no: 1, result: true } } } };
eq('shadow+jant via vision', Math.round(A.scoreListing(withVision, cfg).total - s.total), 30);
eq('flags inconsist', A.ruleFlags({ ...base, description: 'kaputta lokal boya var' }, cfg, h), ['Açıklamada lokal boya geçiyor', 'Motor Kaputu: boya listesi "orijinal" diyor ama açıklama çelişiyor']);
eq('flags clean', A.ruleFlags({ ...base, description: 'boyasız değişensiz, değişen yok, ağır hasar kaydı yok' }, cfg, h), []);

const L = {};
for (let i = 0; i < 20; i++) {
  const y = 2020 + (i % 4), km = 20000 + i * 5000;
  L[i] = { ...base, id: String(i), year: y, km, price: 2000000 + (y - 2020) * 150000 - km * 2 };
}
const m = A.marketModel(Object.values(L));
eq('model per10k', Math.round(m.per10kKm), -20000);
eq('model perYear', Math.round(m.perYear), 150000);
const r = A.computeRows(L, cfg);
console.log('  rows passed/unsure/rejected', r.passed.length, r.unsure.length, r.rejected.length);
const p = A.claudePrompt(r, cfg);
console.log('  claude prompt chars', p.length, '≈tokens', Math.round(p.length / 3.5));
// ayarlar-bmw.json, script'teki varsayılan ayarların birebir kopyası olmalı
const fileCfg = JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'ayarlar-bmw.json'), 'utf8'));
eq('ayarlar-bmw.json = DEFAULT_CONFIG', require('util').isDeepStrictEqual(fileCfg, A.DEFAULT_CONFIG), true);
process.exit(fails ? 1 : 0);
