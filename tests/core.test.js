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
const q = (id) => A.visionKey(cfg.scoring.criteria.find((c) => c.id === id)); // soru + örnek fotoğraf
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
// Takip: durum ve not
const st = (v, at) => ({ v, at });
eq('trackOf boş', A.trackOf({}), { status: null, note: '', by: null });
eq('trackOf bilinmeyen durum yok sayılır', A.trackOf({ track: { status: st('xyz', 1) } }).status, null);
const macCopy = { ...base, lastSeen: 10, track: { status: st('arandi', 100), note: st('mac notu', 50) } };
const winCopy = { ...base, lastSeen: 20, track: { status: st('takip', 90), note: st('windows notu', 60) } };
const merged = A.mergeSame(macCopy, winCopy);
eq('mergeSame durum: en yeni kazanır', A.trackOf(merged).status, 'arandi');
eq('mergeSame not: en yeni kazanır', A.trackOf(merged).note, 'windows notu');
eq('mergeSame simetrik', A.stableStringify(A.mergeSame(winCopy, macCopy)), A.stableStringify(merged));
const cleared = A.mergeSame(macCopy, { ...base, lastSeen: 5, track: { status: st(null, 200) } });
eq('temizlenen durum geri gelmez', A.trackOf(cleared).status, null);

const friend = { ...base, track: { status: st('vazgecti', 100), note: st('ali notu', 100) } };
const fromAli = A.combineOther(null, friend, 'ali');
eq('arkadaşın durumu by ile işaretlenir', A.trackOf(fromAli), { status: 'vazgecti', note: 'ali notu', by: 'ali' });
const mineWithFriend = A.combineOther({ ...base, track: { status: st('teklif', 1) } }, friend, 'ali');
eq('benim durumum varsa arkadaşınki alınmaz', A.trackOf(mineWithFriend), { status: 'teklif', note: '', by: null });
eq('_trackBy saklanmaz', A.stableStringify(fromAli).includes('_trackBy'), false);

const T = {
  a: { ...base, id: 'a', track: { status: st('vazgecti', 1) } },
  b: { ...base, id: 'b', track: { status: st('teklif', 1) } },
  c: { ...base, id: 'c', track: { status: st('takip', 1) } },
  d: { ...base, id: 'd' },
  e: A.combineOther(null, { ...base, id: 'e', track: { status: st('satildi', 1) } }, 'ali'),
};
const trk = A.computeRows(T, cfg);
eq('kapanan ilan sıralamada yok', trk.passed.map((r) => r.l.id).sort(), ['b', 'c', 'd', 'e']);
eq('kapananlar', trk.closed.map((r) => r.l.id), ['a']);
eq('takip listesi: ilerlemiş önce, arkadaşınki yok', trk.tracked.map((r) => r.l.id), ['b', 'c']);
eq('kapananlar Claude metnine girmez', A.claudePrompt(trk, cfg).includes('vazgec'), false);
const cp = A.comparePrompt([trk.passed.find((r) => r.l.id === 'b')], cfg);
eq('karşılaştırma metninde durum var', cp.includes('Benim takibim: Teklif verildi'), true);

// Fotoğraf oylaması
const vTodo = cfg.scoring.criteria.filter((c) => c.vision);
const freshVotes = () => Object.fromEntries(vTodo.map((c) => [c.id, { yes: 0, no: 0 }]));
let vv = freshVotes();
const yesAll = { kirmizi: { visible: true, answer: true }, jant: { visible: true, answer: true }, izgara: { visible: true, answer: true } };
eq('dış fotoğraf koltuk oyu vermez', [A.countPhotoAnswer(vv, { view: 'exterior_side', ...yesAll }, vTodo), vv.kirmizi.yes, vv.jant.yes, vv.izgara.yes], ['exterior_side', 0, 1, 0]);
vv = freshVotes();
eq('iç mekân sadece koltuk', [A.countPhotoAnswer(vv, { view: 'interior', ...yesAll }, vTodo), vv.kirmizi.yes, vv.jant.yes], ['interior', 1, 0]);
vv = freshVotes();
eq('tür anlaşılmazsa eskisi gibi sayılır', [A.countPhotoAnswer(vv, { view: 'uzay gemisi', ...yesAll }, vTodo), vv.kirmizi.yes, vv.jant.yes, vv.izgara.yes], [null, 1, 1, 1]);
vv = freshVotes();
A.countPhotoAnswer(vv, { view: 'interior', kirmizi: { visible: false, answer: true } }, vTodo);
eq('görünmüyorsa oy yok', vv.kirmizi, { yes: 0, no: 0 });
eq('karar: 2 evet', A.voteDecided({ yes: 2, no: 0 }), true);
eq('karar: 2 evet 1 hayır yetmez', A.voteDecided({ yes: 2, no: 1 }), false);
eq('karar: 3 hayır yetmez', A.voteDecided({ yes: 0, no: 3 }), false);
eq('karar: 5 hayır', A.voteDecided({ yes: 0, no: 5 }), true);
eq('sonuç: en az 1 evet ve %25', [A.voteResult({ yes: 0, no: 0 }), A.voteResult({ yes: 1, no: 1 }), A.voteResult({ yes: 1, no: 3 }), A.voteResult({ yes: 1, no: 4 }), A.voteResult({ yes: 0, no: 2 })], [null, true, true, false, false]);
eq('dağınık sıra n=0..2', [A.spreadOrder(0), A.spreadOrder(1), A.spreadOrder(2)], [[], [0], [0, 1]]);
eq('dağınık sıra n=8', A.spreadOrder(8), [0, 4, 2, 6, 1, 3, 5, 7]);
eq('dağınık sıra her indeks bir kez', A.spreadOrder(23).slice().sort((a, b) => a - b), Array.from({ length: 23 }, (_, i) => i));

// AI isabeti: Var/Yok kararlarıyla karşılaştırma
const vis = (id, result, yes, no, question = q(id)) => ({ [id]: { question, yes, no, result } });
const accL = {
  a: { ...base, id: 'a', manual: { 'crit:kirmizi': { v: true, at: 1 } }, ai: { vision: vis('kirmizi', true, 2, 0) } },
  b: { ...base, id: 'b', manual: { 'crit:kirmizi': { v: false, at: 1 } }, ai: { vision: vis('kirmizi', true, 1, 0) } },
  c: { ...base, id: 'c', manual: { 'crit:kirmizi': { v: true, at: 1 } }, ai: { vision: vis('kirmizi', null, 0, 0) } },
  d: { ...base, id: 'd', manual: { 'crit:kirmizi': { v: false, at: 1 } }, ai: { vision: vis('kirmizi', true, 3, 0, 'eski soru') } },
  e: { ...base, id: 'e', _owner: 'ali', manual: { 'crit:kirmizi': { v: false, at: 1 } }, ai: { vision: vis('kirmizi', true, 3, 0) } },
  f: { ...base, id: 'f', manual: { 'crit:jant': { v: true, at: 1 } }, ai: { vision: vis('jant', false, 0, 2) } },
};
const acc = A.visionAccuracy(accL, cfg);
eq('isabet koltuk', [acc.kirmizi.n, acc.kirmizi.agree, acc.kirmizi.wrongYes.map((w) => w.id), acc.kirmizi.noAnswer], [2, 1, ['b'], 1]);
eq('isabet jant', [acc.jant.n, acc.jant.wrongNo.map((w) => w.id)], [1, ['f']]);
eq('isabet ızgara boş', acc.izgara.n, 0);

// Arama listesi rozeti
const bPass = A.listBadge({ ...base, priceHistory: [{ price: 2400000, at: 1 }, { price: 2300000, at: 2 }] }, cfg);
eq('rozet: geçti + fiyat düşüşü', [bPass.tone, bPass.text.startsWith('✓ '), bPass.dim, bPass.delta], ['good', true, false, -100000]);
const bFail = A.listBadge({ ...base, km: 130000, parts: { ...base.parts, 'Motor Kaputu': 'boyalı' } }, cfg);
eq('rozet: elendi, ilk neden + sayı', [bFail.tone, bFail.text, bFail.dim], ['bad', '✗ KM 130.000 +1', true]);
const bUnsure = A.listBadge({ ...base, features: [], description: '' }, cfg);
eq('rozet: doğrulanamadı', [bUnsure.tone, bUnsure.title.startsWith('Doğrulanamayan')], ['warn', true]);
const bTrack = A.listBadge({ ...base, track: { status: { v: 'teklif', at: 1 }, note: { v: 'son teklif 2.25', at: 1 } } }, cfg);
eq('rozet: durum ve not', [bTrack.text.endsWith(' · Teklif verildi'), bTrack.title.includes('Not: son teklif 2.25')], [true, true]);
const bClosed = A.listBadge({ ...base, track: { status: { v: 'satildi', at: 1 } } }, cfg);
eq('rozet: kapanmış', [bClosed.tone, bClosed.text, bClosed.dim], ['muted', 'Satılmış', true]);

// Arkadaşın ilanını kendine kopyalamak: onun kararları, analizi, durumu ve notu seninmiş gibi geçmez
const aliRec = { ...base, id: 'z', manual: { 'crit:kirmizi': { v: true, at: 1 } }, ai: { vision: vis('kirmizi', true, 2, 0), text: { ozet: 'ali özeti', artilar: [], eksiler: [], uyarilar: [], at: 1 } }, track: { status: { v: 'satildi', at: 1 }, note: { v: 'ali notu', at: 1 } } };
const aliView = A.combineOther(null, aliRec, 'ali');
const mine2 = A.ownCopyOf(aliView);
eq('kopya: kaynak işaretli', mine2.copiedFrom, 'ali');
eq('kopya: onun kararı/analizi/durumu yok', [mine2.manual, mine2.ai, mine2.track], [undefined, undefined, undefined]);
const reView = A.combineOther(mine2, aliRec, 'ali');
eq('kopya + ali: kararı adıyla geri gelir', [A.manualOf(reView)['crit:kirmizi'], reView._manualBy['crit:kirmizi'], A.trackOf(reView).by], [true, 'ali', 'ali']);
eq('kopya kapanmış sayılmaz', A.computeRows({ z: reView }, cfg).closed.length, 0);
eq('kopya isabete katılmaz', A.visionAccuracy({ z: reView }, cfg).kirmizi.n, 0);

// Örnek fotoğraf değişince eski fotoğraf sonuçları geçersiz olur
const jc = cfg.scoring.criteria.find((c) => c.id === 'jant');
const jRef = { ...jc, referenceImages: ['https://i0.shbdn.com/photos/1/2/3/x5_1234567890ab.jpg'] };
eq('visionKey örneksiz = soru', A.visionKey({ vision: 'Q?' }), 'Q?');
eq('varsayılan jant örneksiz (düz soru daha isabetli çıktı)', (jc.referenceImages || []).length, 0);
eq('visionKey örnekle farklı', A.visionKey(jRef) !== A.visionKey(jc), true);
const cfgRef = JSON.parse(JSON.stringify(cfg)); cfgRef.scoring.criteria = cfgRef.scoring.criteria.map((c) => (c.id === 'jant' ? jRef : c));
const oldJant = { ...base, ai: { vision: vis('jant', true, 3, 0) } };
eq('örnek eklenince jant yeniden bekler', A.evalCriteria(oldJant, cfgRef).jant.pending, true);
eq('örneksiz ayarda eski sonuç geçerli', A.evalCriteria(oldJant, cfg).jant.met, true);

// Tersten puanlama: gizli bir tercihe göre sıralanmış ilanlardan o tercihi geri bulmalı
let sd = 7; const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
const CL = {};
for (let i = 0; i < 25; i++) {
  const ms = rnd() < 0.6, red = rnd() < 0.3, tr = rnd() < 0.4 ? 'Tramer yok.' : `Tramer ${Math.round(rnd() * 250)} bin.`;
  CL['c' + i] = { ...base, id: 'c' + i, title: `BMW 320i ${ms ? 'M Sport' : 'Sport Line'}`, km: Math.round(15000 + rnd() * 100000),
    price: Math.round(1800000 + rnd() * 600000), year: 2020 + Math.floor(rnd() * 4), description: `${tr} ${red ? 'Kırmızı deri koltuk.' : ''}` };
}
const hidden = JSON.parse(JSON.stringify(cfg));
hidden.scoring.price = { points: 60, best: 1800000, worst: 2400000 };
hidden.scoring.km.points = 30;
hidden.scoring.tramer = { noRecordPoints: 10, tiers: [{ below: 100000, points: 6 }, { below: 300000, points: 3 }] };
hidden.scoring.criteria.find((c) => c.id === 'kirmizi').points = 10;
const corder = Object.values(CL).sort((a, b) => A.scoreListing(b, hidden).total - A.scoreListing(a, hidden).total).map((l) => l.id);
const cal = A.calibrate(CL, corder, cfg);
const cs = cal.suggested.scoring;
eq('kalibrasyon: uyum artar ve yüksek', [cal.after > cal.before, cal.after >= 0.9], [true, true]);
eq('kalibrasyon: fiyatın önemini bulur', cs.price.points >= 25, true);
eq('kalibrasyon: kırmızı koltuğu düşürür', cs.criteria.find((c) => c.id === 'kirmizi').points < 20, true);
const tot = cs.km.points + cs.tramer.noRecordPoints + cs.price.points + cs.year.points + cs.criteria.reduce((a, c) => a + c.points, 0);
eq('kalibrasyon: toplam puan korunur (±2)', Math.abs(tot - 150) <= 2, true);
eq('kalibrasyon: tramer basamak sırası', cs.tramer.noRecordPoints >= cs.tramer.tiers[0].points && cs.tramer.tiers[0].points >= cs.tramer.tiers[1].points, true);
eq('kalibrasyon: negatif puan yok', JSON.stringify(cs).includes('"points":-'), false);
eq('kalibrasyon: sıralamada fark yaratmayan bileşen sabit (hiçbirinde Shadow/jant yok)', ['shadow', 'jant', 'izgara'].map((id) => cs.criteria.find((c) => c.id === id).points), ['shadow', 'jant', 'izgara'].map((id) => cfg.scoring.criteria.find((c) => c.id === id).points));
eq('kalibrasyon: ayar doğrulamasından geçer', !!(cs.km && cs.tramer && Array.isArray(cs.criteria)), true);
eq('kalibrasyon: 3 ilandan azsa yok', A.calibrate(CL, corder.slice(0, 2), cfg), null);
eq('kalibrasyon: bilinmeyen id atlanır', A.calibrate(CL, ['yok1', 'yok2', ...corder.slice(0, 2)], cfg), null);
// Renk tercihi: siyahı seven gizli kullanıcı; tek bir mavi ilan öğrenilmemeli
eq('ana renk', ['Gri (Gümüş)', 'gri metalik', 'SİYAH', 'Beyaz'].map((v) => A.colorOf({ info: { Renk: v } }).key), ['gri', 'gri', 'siyah', 'beyaz']);
eq('renk adı', A.colorOf({ info: { Renk: 'kırmızı (metalik)' } }).name, 'Kırmızı');
eq('renk yoksa', A.colorOf({ info: {} }), null);
const COL = {};
const palette = ['Siyah', 'Beyaz', 'Gri'];
for (let i = 0; i < 18; i++) {
  COL['k' + i] = { ...CL['c' + i], id: 'k' + i, info: { Renk: i === 17 ? 'Mavi' : palette[i % 3] } };
}
const hiddenC = JSON.parse(JSON.stringify(cfg));
hiddenC.scoring.colors = [{ name: 'Siyah', points: 40 }, { name: 'Gri', points: 15 }];
const korder = Object.values(COL).sort((a, b) => A.scoreListing(b, hiddenC).total - A.scoreListing(a, hiddenC).total).map((l) => l.id);
const kc = A.calibrate(COL, korder, cfg);
const cp2 = Object.fromEntries((kc.suggested.scoring.colors || []).map((c) => [c.name, c.points]));
eq('renk: siyah > gri > beyaz öğrenilir', cp2.Siyah > cp2.Gri && cp2.Gri >= cp2.Beyaz, true);
eq('renk: tek geçen mavi öğrenilmez', cp2.Mavi, 0);
eq('renk: uyum artar', kc.after > kc.before, true);
eq('renk puanı dökümde', A.scoreListing(COL.k0, hiddenC).lines.find((x) => x.name === 'Renk').points, 40);

eq('ikili uyum', A.pairAgreement([{ s: 3 }, { s: 2 }, { s: 2 }], (x) => x.s), (1 + 1 + 0.5) / 3);
eq('rangeScore yönden bağımsız', [A.rangeScore(2100000, { points: 10, best: 1800000, worst: 2400000 }), A.rangeScore(2022, { points: 10, best: 2024, worst: 2020 })], [5, 5]);

// Arama ve özellik filtresi
const FL = (id, desc, km, extra = {}) => ({
  id, url: 'https://www.sahibinden.com/ilan/' + id, title: 'BMW 218i Gran Coupe ' + id, price: 2000000, year: 2021, km,
  info: { Renk: 'Siyah' }, features: [], description: 'Hayalet gösterge. Tramer yok. ' + desc,
  parts: { 'Tavan': 'orijinal', 'Motor Kaputu': 'orijinal' }, images: [], ...extra,
});
const FLS = {
  a: FL('a', 'Kırmızı deri koltuk, Shadow paket, first edition', 40000),
  b: FL('b', 'Kırmızı deri koltuk', 60000),
  c: FL('c', 'Shadow paket', 30000, { info: { Renk: 'Beyaz' } }),
  d: FL('d', '', 20000), // kırmızı koltuk fotoğraf analizi bekliyor
  e: FL('e', 'Kırmızı deri koltuk', 45000, { price: 2600000 }), // fiyat filtresine takılır: elendi
  f: FL('f', 'Kırmızı deri koltuk', 50000, { manual: { 'crit:kirmizi': { v: false, at: 1 } } }), // metinde var ama sen "yok" dedin
};
const fr = A.computeRows(FLS, cfg);
const fids = (f) => A.applyFilter(fr, { ...A.EMPTY_FILTER, ...f }).map((r) => r.l.id).sort();
eq('filtre: boş filtre etkin değil', A.filterActive(A.EMPTY_FILTER), false);
eq('filtre: kırmızı koltuk', fids({ has: { 'crit:kirmizi': true } }), ['a', 'b']);
eq('filtre: kırmızı + shadow + 50 bin km altı', fids({ has: { 'crit:kirmizi': true, 'crit:shadow': true }, kmMax: 50000 }), ['a']);
eq('filtre: kırmızı olmasın (bilinmeyen kalır)', fids({ has: { 'crit:kirmizi': false } }), ['c', 'd', 'f']);
eq('filtre: analiz bekleyen "var" sayılmaz', A.rowHas(fr.all.find((r) => r.l.id === 'd'), 'crit:kirmizi'), null);
eq('filtre: elle "yok" metni ezer', A.rowHas(fr.all.find((r) => r.l.id === 'f'), 'crit:kirmizi'), false);
eq('filtre: elenenler dahil', fids({ has: { 'crit:kirmizi': true }, withRejected: true }), ['a', 'b', 'e']);
eq('filtre: metin, Türkçe harf ve büyük harf fark etmez', fids({ q: 'FIRST edıtıon' }), ['a']);
eq('filtre: metinde her kelime geçmeli', fids({ q: 'shadow kırmızı' }), ['a']);
eq('filtre: renk', fids({ color: 'beyaz' }), ['c']);
eq('filtre: km ve yıl', fids({ kmMax: 40000, yearMin: 2021 }), ['a', 'c', 'd']);
eq('filtre: fiyat', fids({ priceMax: 1999999 }), []);
eq('filtre: HUD var', fids({ has: { 'feat:Hayalet gösterge (HUD)': true } }), ['a', 'b', 'c', 'd', 'f']);
const fc = A.facetCounts(fr, { ...A.EMPTY_FILTER, kmMax: 50000 }, cfg);
eq('filtre: düğme sayıları diğer seçimlerle', [fc['crit:kirmizi'], fc['crit:shadow']], [1, 2]);
eq('filtre: sıra puana göre', A.applyFilter(fr, { ...A.EMPTY_FILTER, kmMax: 60000 }).map((r) => Math.round(r.score.total)).every((s, i, a) => i === 0 || a[i - 1] >= s), true);

// Benim sıralamam: "önemli" bileşenler (varsayılan model yılı) en az %10 pay alır
// Gerçek bir sıralamaya benzer: üstte 2020-2021 Shadow'lar, Shadow'suzlarda 2022 > 2020, en yeni (2023) tramerli olduğu için en altta.
// Yıl tek başına sıralamayı açıklamıyor; işaretlenmezse kalibrasyon yıla neredeyse puan vermiyordu.
const CB = (id, year, km, desc, extra = {}) => ({
  id, url: 'https://www.sahibinden.com/ilan/' + id, title: 'BMW 218i ' + id, price: 2200000, year, km,
  info: { Renk: 'Beyaz' }, features: [], description: 'Hayalet gösterge. M Sport. ' + desc,
  parts: { 'Tavan': 'orijinal', 'Motor Kaputu': 'orijinal' }, images: [], ...extra,
});
const YL = {
  y1: CB('y1', 2021, 84000, 'Shadow paket. Tramer kaydı yoktur.'),
  y2: CB('y2', 2021, 110000, 'Shadow paket. Tramer kaydı yoktur.'),
  y3: CB('y3', 2020, 98000, 'Shadow paket. Tramer kaydı yoktur.'),
  y4: CB('y4', 2022, 72000, 'Tramer kaydı yoktur.'),
  y5: CB('y5', 2022, 67000, 'Tramer kaydı yoktur.'),
  y6: CB('y6', 2020, 73000, 'Tramer kaydı yoktur.'),
  y7: CB('y7', 2020, 73000, 'Tramer kaydı yoktur.', { price: 2380000 }),
  y8: CB('y8', 2023, 64000, 'Tramer 20 bin TL.'),
};
const yorder = ['y1', 'y2', 'y3', 'y4', 'y5', 'y6', 'y7', 'y8'];
eq('önemli: varsayılan model yılı', A.importantOf(cfg), ['year']);
eq('önemli: ayardaki liste geçerli', A.importantOf({ calibration: { order: [], important: [] } }), []);
const yFree = A.calibrate(YL, yorder, cfg, { important: [] });
const yImp = A.calibrate(YL, yorder, cfg);
eq('önemli: işaretsiz yıl az puan alıyor', yFree.suggested.scoring.year.points < yImp.floor, true);
eq('önemli: işaretli yıl en az %10 (15 puan)', [yImp.floor, yImp.suggested.scoring.year.points >= yImp.floor], [15, true]);
eq('önemli: yıl aralığı sıralanan ilanlardan', [yImp.suggested.scoring.year.worst, yImp.suggested.scoring.year.best], [2020, 2023]);
eq('önemli: Shadowsuzlarda 2022 > 2020', A.scoreListing(YL.y4, yImp.suggested).total > A.scoreListing(YL.y6, yImp.suggested).total, true);
eq('önemli: toplam puan korunur', Math.abs(A.scoreListing(YL.y1, yImp.suggested).max - A.scoreListing(YL.y1, cfg).max) <= 2, true);
eq('önemli: öğrenildi bilgisi', yImp.important.map((x) => [x.key, x.learned]), [['year', true]]);
eq('önemli: uyum yine artar', yImp.after > yImp.before, true);
const sameYear = Object.fromEntries(Object.entries(YL).map(([k, l]) => [k, { ...l, year: 2021 }]));
eq('önemli: hepsi aynı yılsa öğrenilemez', A.calibrate(sameYear, yorder, cfg).important.map((x) => x.learned), [false]);
const two = A.calibrate(YL, yorder, cfg, { important: ['year', 'km'] });
eq('önemli: iki bileşen ikisi de alt sınırda', [two.suggested.scoring.year.points >= two.floor, two.suggested.scoring.km.points >= two.floor], [true, true]);

// ayarlar-bmw.json, script'teki varsayılan ayarların birebir kopyası olmalı
const fileCfg = JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'ayarlar-bmw.json'), 'utf8'));
eq('ayarlar-bmw.json = DEFAULT_CONFIG', require('util').isDeepStrictEqual(fileCfg, A.DEFAULT_CONFIG), true);
process.exit(fails ? 1 : 0);
