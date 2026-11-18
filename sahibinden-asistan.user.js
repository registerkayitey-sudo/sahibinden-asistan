// ==UserScript==
// @name         Sahibinden Araç Asistanı
// @namespace    sahibinden-asistan
// @version      0.4.0
// @description  Gezdiğin ilanları toplar, filtreler, puanlar; yerel AI (Ollama) ile görsel ve metin analizi yapar, piyasa analizi çıkarır.
// @match        https://www.sahibinden.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      localhost
// @connect      127.0.0.1
// @connect      shbdn.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Varsayılan ayarlar (panelde "Ayarlar" sekmesinden değiştirilebilir)
  // ---------------------------------------------------------------------------
  const DEFAULT_CONFIG = {
    ollama: {
      enabled: true,
      url: 'http://localhost:11434',
      model: 'gemma4:12b',
      maxImages: 10,
    },
    hardFilters: {
      maxKm: 125000, // bu değerin altı
      minYear: 2020, // en az
      maxPrice: 2400000, // en fazla
      originalParts: ['Tavan', 'Motor Kaputu'],
      requiredFeatures: [
        { name: 'Hayalet gösterge (HUD)', keywords: ['hayalet', 'head-up', 'head up', 'headup', 'hud', '6u3', 'executive paket', 'executive package'] },
      ],
    },
    scoring: {
      km: { points: 40, bestKm: 20000, worstKm: 125000 },
      tramer: {
        noRecordPoints: 20,
        tiers: [
          { below: 100000, points: 15 },
          { below: 300000, points: 8 },
        ],
      },
      criteria: [
        { id: 'msport', name: 'M Sport / First Edition', points: 30, keywords: ['m sport', 'msport', 'm-sport', 'm sport paket', 'first edition'] },
        {
          id: 'kirmizi', name: 'Kırmızı koltuk', points: 30,
          keywords: ['kırmızı koltuk', 'kırmızı deri', 'kırmızı döşeme', 'kırmızı iç', 'fiona red', 'tacora red', 'mugello red', 'coral red'],
          vision: 'Are the car seats red (red leather or red upholstery)?',
        },
        {
          id: 'shadow', name: 'Shadow paket', points: 20,
          keywords: ['shadow paket', 'shadow edition', 'shadow package'],
          allOf: ['jant', 'izgara'],
        },
        {
          id: 'jant', name: '554M Y-Spoke jant', points: 10,
          keywords: ['554m', '554 m', 'y-spoke', 'y spoke', 'y kollu'],
          vision: 'Are the wheels BMW Y-spoke style 554M (thin double spokes forming Y shapes, usually dark/black)?',
        },
        {
          id: 'izgara', name: 'Siyah ızgara (7M9)', points: 0,
          keywords: ['7m9', 'siyah ızgara', 'siyah böbrek', 'parlak siyah ızgara', 'shadow line'],
          vision: 'Is the BMW kidney grille frame black (not chrome)?',
        },
      ],
    },
  };

  const MAX_TOP = 10;

  // ---------------------------------------------------------------------------
  // Metin yardımcıları
  // ---------------------------------------------------------------------------
  const TR_MAP = { 'ı': 'i', 'İ': 'i', 'ş': 's', 'Ş': 's', 'ç': 'c', 'Ç': 'c', 'ğ': 'g', 'Ğ': 'g', 'ö': 'o', 'Ö': 'o', 'ü': 'u', 'Ü': 'u' };

  function fold(s) {
    return String(s || '').replace(/[ıİşŞçÇğĞöÖüÜ]/g, (c) => TR_MAP[c]).toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function findKeyword(foldedText, keywords) {
    for (const kw of keywords || []) {
      const k = fold(kw);
      if (!k) continue;
      if (new RegExp('(^|[^a-z0-9])' + escapeRe(k) + '($|[^a-z0-9])').test(foldedText)) return kw;
    }
    return null;
  }

  function parseNumber(s) {
    const d = String(s || '').replace(/[^\d]/g, '');
    return d ? Number(d) : null;
  }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const fmtNum = (n) => (n == null ? '–' : Math.round(n).toLocaleString('tr-TR'));
  const fmtTL = (n) => (n == null ? '–' : fmtNum(n) + ' TL');

  function corpusOf(l) {
    return fold([l.title, Object.values(l.info || {}).join(' . '), (l.features || []).join(' . '), l.description].join(' . '));
  }

  // ---------------------------------------------------------------------------
  // Tramer
  // ---------------------------------------------------------------------------
  function parseAmount(raw, mult) {
    let n = /^\d{1,3}([.,]\d{3})+$/.test(raw) ? Number(raw.replace(/[.,]/g, '')) : Number(raw.replace(',', '.'));
    if (!isFinite(n)) return null;
    if (mult) n *= 1000;
    return Math.round(n);
  }

  const NUM = '(\\d{1,3}(?:[.,]\\d{3})+|\\d+(?:[.,]\\d+)?)';
  const MULT = '(?!\\d)\\s*(bin(?![a-z])|k(?![a-z]))?'; // "595.000TL" gibi bitişik yazımları da yakalar
  const NOT_COUNT = '(?!\\s*(?:parca|adet|kalem|kez|defa|kere|yil|km|model))';

  function parseTramer(l) {
    // 1) Yapısal alan varsa ona güven
    for (const [label, value] of Object.entries(l.info || {})) {
      const fl = fold(label);
      if (fl.includes('tramer') || fl === 'hasar kaydi') {
        const fv = fold(value);
        const m = fv.match(new RegExp(NUM + MULT));
        if (m) {
          const a = parseAmount(m[1], m[2]);
          if (a != null) return { amount: a, source: 'ilan alanı' };
        }
        if (/yok|hayir|bulunmuyor/.test(fv)) return { amount: 0, source: 'ilan alanı' };
      }
    }

    // 2) Açıklamadan çıkar
    const t = fold((l.title || '') + ' . ' + (l.description || ''));
    const amounts = [];
    let guessed = false;
    const after = new RegExp('tramer(?:i|\\s*kaydi|\\s*tutari)?([^\\n]{0,30}?)' + NUM + MULT + NOT_COUNT, 'g');
    const before = new RegExp(NUM + MULT + '\\s*(?:tl|₺)?\\s*(?:lik|luk)?\\s*tramer', 'g');
    let m;
    while ((m = after.exec(t))) {
      if (/yok|degil|model|yil/.test(m[1])) continue;
      push(m[2], m[3]);
    }
    while ((m = before.exec(t))) push(m[1], m[2]);

    function push(raw, mult) {
      let a = parseAmount(raw, mult);
      if (a == null) return;
      if (!mult && a >= 1990 && a <= 2035 && !/[.,]/.test(raw)) return; // muhtemelen yıl
      if (!mult && a > 0 && a < 1000) { a *= 1000; guessed = true; } // "tramer 45" → 45 bin
      amounts.push(a);
    }

    if (amounts.length) {
      const notes = [];
      if (amounts.length > 1) notes.push('birden fazla tutar geçiyor, en yükseği alındı');
      if (guessed) notes.push('"bin" yazılmamış, bin TL varsayıldı');
      return { amount: Math.max(...amounts), source: 'açıklama', note: notes.join('; ') };
    }
    if (/tramersiz|tramer(?:i)?(?: kaydi)? (?:yok|bulunmamaktadir|yoktur|sifir)|(?:sifir|0) tramer|hasar kaydi (?:yok|bulunmamaktadir|yoktur)/.test(t)) {
      return { amount: 0, source: 'açıklama' };
    }
    return { amount: null, source: null };
  }

  // ---------------------------------------------------------------------------
  // Filtreler, kriterler, puan
  // ---------------------------------------------------------------------------
  function findPart(parts, name) {
    const f = fold(name);
    const entries = Object.entries(parts || {});
    const exact = entries.find(([k]) => fold(k) === f);
    if (exact) return exact[1];
    const partial = entries.find(([k]) => fold(k).includes(f));
    return partial ? partial[1] : null;
  }

  // Kullanıcının elle verdiği kararlar: { 'feat:Hayalet gösterge (HUD)': true, 'part:Tavan': false, ... }
  const manualOf = (l) => (l && l.manual) || {};

  function evalHard(l, cfg) {
    const h = cfg.hardFilters;
    const man = manualOf(l);
    const fails = [];
    const unknowns = [];
    const decided = [];
    // İlandan doğrulanamayan bir şart: kullanıcı karar verdiyse onu uygula, vermediyse sor.
    const ask = (key, label, yes, no, failLabel) => {
      const d = man[key];
      if (d === true) decided.push({ key, label, yes, no, ok: true });
      else if (d === false) { decided.push({ key, label, yes, no, ok: false }); fails.push(`${failLabel} (senin kontrolün)`); }
      else unknowns.push({ key, label, yes, no });
    };

    if (l.km == null) ask('km', 'KM okunamadı', 'Uygun', 'Uygun değil', 'KM filtreye uymuyor');
    else if (l.km >= h.maxKm) fails.push(`KM ${fmtNum(l.km)}`);
    if (l.year == null) ask('year', 'Yıl okunamadı', 'Uygun', 'Uygun değil', 'Yıl filtreye uymuyor');
    else if (l.year < h.minYear) fails.push(`Yıl ${l.year}`);
    if (l.price == null) ask('price', 'Fiyat okunamadı', 'Uygun', 'Uygun değil', 'Fiyat filtreye uymuyor');
    else if (l.price > h.maxPrice) fails.push(`Fiyat ${fmtTL(l.price)}`);

    const hasParts = l.parts && Object.keys(l.parts).length > 0;
    if (!hasParts) {
      if ((h.originalParts || []).length) ask('parts', 'Boya/değişen bilgisi yok', 'Hepsi orijinal', 'Orijinal değil', 'Boya/değişen: orijinal değil');
    } else {
      for (const p of h.originalParts || []) {
        const st = findPart(l.parts, p);
        if (!st || st === 'belirtilmemiş') ask(`part:${p}`, `${p}: bilgi yok`, 'Orijinal', 'Değil', `${p}: orijinal değil`);
        else if (st !== 'orijinal') fails.push(`${p}: ${st}`);
      }
    }

    const corpus = corpusOf(l);
    for (const f of h.requiredFeatures || []) {
      if (!findKeyword(corpus, f.keywords)) ask(`feat:${f.name}`, `${f.name} ilanda geçmiyor`, 'Var', 'Yok', `${f.name}: yok`);
    }
    const status = fails.length ? 'elendi' : unknowns.length ? 'belirsiz' : 'gecti';
    return { status, fails, unknowns, decided };
  }

  function evalCriteria(l, cfg) {
    const corpus = corpusOf(l);
    const crit = cfg.scoring.criteria || [];
    const vision = (l.ai && l.ai.vision) || {};
    const man = manualOf(l);
    const res = {};
    // Senin kararın her şeyin önünde gelir: metne de fotoğraf analizine de bakmaz.
    const override = (id) => {
      const m = man['crit:' + id];
      if (m === true) return { met: true, manual: true, via: 'senin kontrolün: var' };
      if (m === false) return { met: false, manual: true, via: 'senin kontrolün: yok' };
      return null;
    };
    for (const c of crit.filter((c) => !c.allOf)) {
      const o = override(c.id);
      if (o) { res[c.id] = o; continue; }
      const kw = findKeyword(corpus, c.keywords);
      const v = vision[c.id];
      if (kw) res[c.id] = { met: true, via: `metin: "${kw}"` };
      else if (v && v.result === true) res[c.id] = { met: true, via: `fotoğraf (${v.yes} evet / ${v.no} hayır)` };
      else if (c.vision && !(v && v.question === c.vision)) res[c.id] = { met: false, pending: true, via: 'fotoğraf analizi bekliyor' };
      else res[c.id] = { met: false, via: v ? `fotoğraf (${v.yes} evet / ${v.no} hayır)` : null };
    }
    for (const c of crit.filter((c) => c.allOf)) {
      const o = override(c.id);
      if (o) { res[c.id] = o; continue; }
      const kw = findKeyword(corpus, c.keywords);
      const subs = c.allOf.map((id) => res[id]).filter(Boolean);
      const all = subs.length === c.allOf.length && subs.every((r) => r.met);
      const names = c.allOf.map((id) => (crit.find((x) => x.id === id) || { name: id }).name).join(' + ');
      res[c.id] = {
        met: !!kw || all,
        pending: !kw && !all && subs.some((r) => r.pending),
        via: kw ? `metin: "${kw}"` : all ? names : null,
      };
    }
    return res;
  }

  function kmScore(km, c) {
    if (km == null) return 0;
    if (km <= c.bestKm) return c.points;
    if (km >= c.worstKm) return 0;
    return (c.points * (c.worstKm - km)) / (c.worstKm - c.bestKm);
  }

  function tramerScore(amount, c) {
    if (amount == null) return 0;
    if (amount === 0) return c.noRecordPoints;
    for (const t of c.tiers || []) if (amount < t.below) return t.points;
    return 0;
  }

  function scoreListing(l, cfg) {
    const s = cfg.scoring;
    const crit = evalCriteria(l, cfg);
    const tramer = parseTramer(l);
    const lines = [
      { name: 'KM', points: kmScore(l.km, s.km), max: s.km.points, via: l.km == null ? 'okunamadı' : `${fmtNum(l.km)} km` },
      {
        name: 'Tramer', points: tramerScore(tramer.amount, s.tramer), max: s.tramer.noRecordPoints,
        via: tramer.amount == null ? 'bilinmiyor' : (tramer.amount === 0 ? 'kayıt yok' : fmtTL(tramer.amount)) + ` (${tramer.source}${tramer.note ? '; ' + tramer.note : ''})`,
      },
      ...(s.criteria || []).filter((c) => c.points > 0).map((c) => ({
        name: c.name, points: crit[c.id].met ? c.points : 0, max: c.points, via: crit[c.id].via, pending: crit[c.id].pending,
        // Metinde birebir geçen kriterde sorulacak bir şey yok; gerisini elle doğrulayabilirsin.
        key: `crit:${c.id}`, met: crit[c.id].met, manual: crit[c.id].manual,
        askable: !String(crit[c.id].via || '').startsWith('metin:'),
      })),
    ];
    const total = lines.reduce((a, x) => a + x.points, 0);
    const max = lines.reduce((a, x) => a + x.max, 0);
    return { total, max, lines, crit, tramer };
  }

  // ---------------------------------------------------------------------------
  // Kural tabanlı uyarılar
  // ---------------------------------------------------------------------------
  const FLAG_RULES = [
    [/(^|[^a-z])acil([^a-z]|$)/, 'Acil satış ifadesi'],
    [/pazarlik (?:payi )?yok|son fiyat/, 'Pazarlık yok / son fiyat'],
    [/ekspertiz(?:e)? (?:yok|yapilmaz|verilmez|izin verilmez|gerek yok|yaptirilmaz)/, 'Ekspertize kapalı görünüyor'],
    [/lokal boya(?!siz)(?!si yok)(?! yok)/, 'Açıklamada lokal boya geçiyor'],
    [/(^|[^a-z])degisen(?! (?:parca )?yok)(?!siz)([^a-z]|$)/, 'Açıklamada "değişen" geçiyor'],
    [/(^|[^a-z])pert([^a-z]|$)/, 'Pert ifadesi geçiyor'],
    [/airbag/, 'Airbag ifadesi geçiyor (kontrol et)'],
    [/(^|[^a-z])sasi([^a-z]|$)/, 'Şasi ifadesi geçiyor (kontrol et)'],
    [/agir hasar(?! kaydi yok)(?! yok)(?!siz)/, 'Ağır hasar ifadesi geçiyor'],
  ];

  function ruleFlags(l, cfg, hard) {
    const t = fold((l.title || '') + ' . ' + (l.description || ''));
    const flags = FLAG_RULES.filter(([re]) => re.test(t)).map(([, msg]) => msg);
    for (const [label, value] of Object.entries(l.info || {})) {
      if (fold(label).includes('agir hasar') && fold(value).startsWith('evet')) flags.push('AĞIR HASAR KAYITLI');
    }
    // Boya listesi "orijinal" diyor ama açıklama başka bir şey söylüyor mu?
    if (hard.status !== 'elendi' && l.parts && Object.keys(l.parts).length) {
      for (const p of cfg.hardFilters.originalParts || []) {
        const key = fold(p).split(' ').pop().replace(/u$/, ''); // "motor kaputu" → "kaput"
        const re = new RegExp(escapeRe(key) + '[a-z]*\\s[^.\\n]{0,25}?(boyali|boya var|lokal|degis(?!ensiz))');
        if (findPart(l.parts, p) === 'orijinal' && re.test(t)) flags.push(`${p}: boya listesi "orijinal" diyor ama açıklama çelişiyor`);
      }
    }
    if (l.priceHistory && l.priceHistory.length > 1) {
      const first = l.priceHistory[0].price;
      if (first && l.price && l.price !== first) flags.push(`Fiyat değişti: ${fmtTL(first)} → ${fmtTL(l.price)}`);
    }
    return flags;
  }

  // ---------------------------------------------------------------------------
  // Piyasa modeli: fiyat ≈ b0 + b1·(yıl-2020) + b2·(km/10.000)
  // ---------------------------------------------------------------------------
  function solve(A, b) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-9) return null;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((row, i) => row[n] / row[i]);
  }

  function fitLinear(rows, featureFns) {
    const k = featureFns.length + 1;
    const A = Array.from({ length: k }, () => Array(k).fill(0));
    const b = Array(k).fill(0);
    for (const r of rows) {
      const x = [1, ...featureFns.map((f) => f(r))];
      for (let i = 0; i < k; i++) {
        b[i] += x[i] * r.price;
        for (let j = 0; j < k; j++) A[i][j] += x[i] * x[j];
      }
    }
    return solve(A, b);
  }

  function marketModel(listings) {
    const pts = listings.filter((l) => l.price && l.year && l.km != null);
    if (pts.length < 8) return null;
    const fYear = (l) => l.year - 2020;
    const fKm = (l) => l.km / 10000;
    let coef = fitLinear(pts, [fYear, fKm]);
    let predict;
    let perYear = null;
    if (coef) {
      perYear = coef[1];
      predict = (l) => coef[0] + coef[1] * fYear(l) + coef[2] * fKm(l);
    } else {
      coef = fitLinear(pts, [fKm]); // tüm ilanlar aynı yılsa
      if (!coef) return null;
      predict = (l) => coef[0] + coef[1] * fKm(l);
    }
    const per10kKm = coef[coef.length - 1];
    return { n: pts.length, predict, perYear, per10kKm };
  }

  // ---------------------------------------------------------------------------
  // Tüm ilanları değerlendir
  // ---------------------------------------------------------------------------
  function computeRows(listings, cfg) {
    const all = Object.values(listings);
    const model = marketModel(all);
    const rows = all.map((l) => {
      const hard = evalHard(l, cfg);
      const score = scoreListing(l, cfg);
      let market = null;
      if (model && l.price && l.year && l.km != null) {
        const pred = model.predict(l);
        if (pred > 0) market = { pred, diff: (l.price - pred) / pred };
      }
      return { l, hard, score, market, flags: ruleFlags(l, cfg, hard) };
    });
    const byScore = (a, b) => b.score.total - a.score.total || (a.market?.diff ?? 0) - (b.market?.diff ?? 0);
    return {
      model,
      passed: rows.filter((r) => r.hard.status === 'gecti').sort(byScore),
      unsure: rows.filter((r) => r.hard.status === 'belirsiz').sort(byScore),
      rejected: rows.filter((r) => r.hard.status === 'elendi'),
      all: rows,
    };
  }

  // ---------------------------------------------------------------------------
  // Claude için özet
  // ---------------------------------------------------------------------------
  function configSummary(cfg) {
    const h = cfg.hardFilters;
    const s = cfg.scoring;
    const lines = [
      `Mutlak filtreler: ${fmtNum(h.maxKm)} km altı, en az ${h.minYear} model, en fazla ${fmtTL(h.maxPrice)}, orijinal olması gereken parçalar: ${h.originalParts.join(', ')}; olması gereken donanım: ${h.requiredFeatures.map((f) => f.name).join(', ')}.`,
      `Puanlama: KM ${s.km.points} puan (${fmtNum(s.km.bestKm)} km ve altı tam puan, ${fmtNum(s.km.worstKm)} km'de 0); tramer ${s.tramer.noRecordPoints} puan (kayıt yok tam puan${s.tramer.tiers.map((t) => `, ${fmtNum(t.below)} TL altı ${t.points}`).join('')}, üstü 0)`,
    ];
    for (const c of s.criteria.filter((c) => c.points > 0)) lines.push(`${c.name}: ${c.points} puan`);
    return lines.join('\n');
  }

  function rowSummary(r, i) {
    const l = r.l;
    const out = [
      `### ${i + 1}. ${l.title}`,
      `Link: ${l.url}`,
      `Fiyat: ${fmtTL(l.price)} | Yıl: ${l.year ?? '–'} | KM: ${fmtNum(l.km)}`,
      `Puan: ${Math.round(r.score.total)}/${r.score.max} → ` + r.score.lines.map((x) => `${x.name} ${Math.round(x.points)}/${x.max}${x.via ? ` (${x.via})` : ''}`).join('; '),
    ];
    if (r.market) out.push(`Piyasa modeli: tahmini ${fmtTL(r.market.pred)}, ilan ${r.market.diff >= 0 ? '+' : ''}${(r.market.diff * 100).toFixed(1)}%`);
    if (l.parts && Object.keys(l.parts).length) {
      const nonOrig = Object.entries(l.parts).filter(([, st]) => st !== 'orijinal').map(([p, st]) => `${p}: ${st}`);
      out.push(`Boya/değişen: ${nonOrig.length ? nonOrig.join(', ') : 'tüm parçalar orijinal'}`);
    }
    if (r.hard.unknowns.length) out.push(`Doğrulanamayanlar: ${r.hard.unknowns.map((u) => u.label).join('; ')}`);
    if (r.hard.decided.length) out.push(`Elle kontrol ettiklerim: ${r.hard.decided.map((d) => `${d.label} → ${d.ok ? 'var/uygun' : 'yok/uygun değil'}`).join('; ')}`);
    if (r.flags.length) out.push(`Uyarılar: ${r.flags.join('; ')}`);
    const t = l.ai && l.ai.text;
    if (t && !t.error) {
      if (t.ozet) out.push(`Yerel AI özeti: ${t.ozet}`);
      if (t.uyarilar && t.uyarilar.length) out.push(`Yerel AI uyarıları: ${t.uyarilar.join('; ')}`);
    }
    const info = Object.entries(l.info || {}).filter(([k]) => !/ilan (no|tarihi)/.test(fold(k))).map(([k, v]) => `${k}: ${v}`).join(', ');
    if (info) out.push(`İlan bilgileri: ${info}`);
    if (l.description) out.push(`Açıklama (kısaltılmış): ${l.description.replace(/\s+/g, ' ').slice(0, 700)}`);
    return out.join('\n');
  }

  function claudePrompt(result, cfg) {
    const top = result.passed.slice(0, MAX_TOP);
    const unsure = result.unsure.slice(0, Math.max(0, MAX_TOP - top.length));
    const parts = [
      "Sahibinden.com'da ikinci el araç arıyorum. Aşağıda kendi kriterlerime göre filtreleyip puanladığım ilanlar var.",
      '',
      'KRİTERLERİM',
      configSummary(cfg),
      '',
      'Senden istediğim:',
      "1. Bu araçları karşılaştır ve en iyi 3'ü gerekçesiyle seç. Puanı körü körüne takip etme; fiyat, risk ve uyarıları da tart.",
      '2. Her biri için satıcıya sormam gereken somut soruları yaz.',
      '3. Ekspertizde özellikle baktırmam gereken noktaları yaz.',
      '4. Verilerde çelişki veya şüpheli bir şey görürsen belirt. Bilmediğin bir şeyi kesinmiş gibi yazma.',
      '',
      `KRİTERLERİ GEÇEN İLANLAR (${top.length})`,
      ...top.map((r, i) => rowSummary(r, i) + '\n'),
    ];
    if (unsure.length) {
      parts.push(`BAZI KRİTERLERİ DOĞRULANAMAYAN AMA PUANI YÜKSEK İLANLAR (${unsure.length})`);
      parts.push(...unsure.map((r, i) => rowSummary(r, top.length + i) + '\n'));
    }
    return parts.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Buradan sonrası tarayıcıya özel
  // ---------------------------------------------------------------------------
  const CORE = { DEFAULT_CONFIG, fold, findKeyword, parseTramer, evalHard, evalCriteria, kmScore, tramerScore, scoreListing, ruleFlags, marketModel, computeRows, claudePrompt };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CORE;
    return;
  }

  // ----- Depolama -----
  // Her ilan ayrı anahtarda: aynı anda açılan sekmeler birbirinin kaydını ezmesin
  const PREFIX = 'ilan:';
  const listingKeys = () => GM_listValues().filter((k) => k.startsWith(PREFIX));
  const getListing = (id) => GM_getValue(PREFIX + id, null);
  const putListing = (l) => GM_setValue(PREFIX + l.id, l);
  const countListings = () => listingKeys().length;
  function loadListings() {
    const out = {};
    for (const k of listingKeys()) {
      const l = GM_getValue(k, null);
      if (l) out[l.id] = l;
    }
    return out;
  }
  function clearListings() {
    for (const k of listingKeys()) GM_deleteValue(k);
  }
  function migrateStorage() {
    const old = GM_getValue('listings', null); // 0.1.0 tüm ilanları tek anahtarda tutuyordu
    if (!old) return;
    for (const l of Object.values(old)) if (!getListing(l.id)) putListing(l);
    GM_deleteValue('listings');
  }
  const loadQueue = () => GM_getValue('queue', []);
  const saveQueue = (x) => GM_setValue('queue', x);
  function loadConfig() {
    const c = GM_getValue('config', null);
    return c ? c : JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
  const saveConfig = (c) => GM_setValue('config', c);

  // ----- Sayfa okuma -----
  const isDetailPage = () => /^\/ilan\//.test(location.pathname);
  const isBotCheck = () => /tloading|captcha/i.test(location.pathname) || /Tarayıcınızı kontrol/i.test(document.body?.innerText?.slice(0, 300) || '');

  const PART_STATUS = { 'orijinal': 'orijinal', 'lokal boyali': 'lokal boyalı', 'boyali': 'boyalı', 'degismis': 'değişmiş', 'degisen': 'değişmiş', 'belirtilmemis': 'belirtilmemiş' };

  function statusOf(line) {
    const f = fold(line).replace(/[:()0-9]/g, '').replace(/ parcalar$/, '').trim();
    return PART_STATUS[f] || null;
  }

  function parsePartsText(text) {
    const parts = {};
    let current = null;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const st = statusOf(line);
      if (st) { current = st; continue; }
      if (current && line.length >= 3 && line.length <= 40 && !/\d{3,}/.test(line) && !(line in parts)) parts[line] = current;
    }
    return parts;
  }

  // Araç şemasındaki her parça bir div; sınıfı parçayı ve durumunu veriyor (ör. "front-hood painted-new")
  const PART_CLASSES = {
    'front-bumper': 'Ön Tampon', 'front-hood': 'Motor Kaputu', 'roof': 'Tavan',
    'front-right-mudguard': 'Sağ Ön Çamurluk', 'front-right-door': 'Sağ Ön Kapı', 'rear-right-door': 'Sağ Arka Kapı', 'rear-right-mudguard': 'Sağ Arka Çamurluk',
    'front-left-mudguard': 'Sol Ön Çamurluk', 'front-left-door': 'Sol Ön Kapı', 'rear-left-door': 'Sol Arka Kapı', 'rear-left-mudguard': 'Sol Arka Çamurluk',
    'rear-hood': 'Bagaj Kapağı', 'rear-bumper': 'Arka Tampon',
  };
  const STATUS_CLASSES = { 'original': 'orijinal', 'local-painted': 'lokal boyalı', 'painted': 'boyalı', 'changed': 'değişmiş' };

  function extractPartsFromDiagram() {
    const parts = {};
    document.querySelectorAll('.car-parts > div').forEach((el) => {
      const cls = [...el.classList];
      const part = cls.find((c) => PART_CLASSES[c]);
      if (!part) return;
      const st = cls.map((c) => c.replace(/-new$/, '')).find((c) => STATUS_CLASSES[c]);
      parts[PART_CLASSES[part]] = st ? STATUS_CLASSES[st] : 'belirtilmemiş';
    });
    return parts;
  }

  function extractParts() {
    const fromDiagram = extractPartsFromDiagram();
    if (Object.keys(fromDiagram).length) return fromDiagram;
    // Yedek: "Orijinal / Boyalı / Değişmiş" başlıkları altındaki parça adlarını metinden toplar
    let best = {};
    document.querySelectorAll('div, section, ul, dl').forEach((el) => {
      const tc = el.textContent || '';
      if (tc.length > 6000 || !/Orijinal/.test(tc) || !/Boyal/.test(tc) || !/(Değişmiş|Değişen)/.test(tc)) return;
      const parts = parsePartsText(el.innerText || '');
      if (Object.keys(parts).length > Object.keys(best).length) best = parts;
    });
    return best;
  }

  // Her fotoğraf birkaç boyutta (thmb_, x5_, x16_…) geçiyor; hepsini 528px'lik x5_ sürümüne indirger
  function collectImages(id) {
    const urls = new Set();
    document.querySelectorAll('.classifiedDetailPhotos img, .classifiedDetailPhotos [data-source], img[data-src*="shbdn.com/photos/"]').forEach((el) => {
      for (const a of ['data-source', 'data-src', 'src']) {
        const m = (el.getAttribute(a) || '').match(/^(https:\/\/[a-z0-9]+\.shbdn\.com\/photos\/(?:\d+\/)+)(?:[a-z0-9]+_)?(\d[\w]*\.(?:jpe?g|png|webp))$/i);
        if (m && (!id || m[2].startsWith(id))) urls.add(m[1] + 'x5_' + m[2]);
      }
    });
    return [...urls];
  }

  function extractListing() {
    const txt = (el) => (el ? el.innerText.trim() : '');
    const info = {};
    document.querySelectorAll('.classifiedInfoList .classifiedInfoItem, .classifiedInfoList li').forEach((item) => {
      const k = txt(item.querySelector('dt, strong')).replace(/:$/, '');
      const v = txt(item.querySelector('dd, span'));
      if (k) info[k] = v;
    });
    const getInfo = (label) => {
      const key = Object.keys(info).find((k) => fold(k) === label);
      return key ? info[key] : null;
    };
    const priceText = txt(document.querySelector('.classifiedInfo h3')) || txt(document.querySelector('.classified-price-wrapper'));
    const priceMatch = priceText.match(/([\d.]+)\s*TL/);
    const id = String(parseNumber(getInfo('ilan no')) || (location.pathname.match(/(\d{7,})/) || [])[1] || '') || null;
    return {
      id: id || location.pathname,
      url: location.origin + location.pathname,
      title: txt(document.querySelector('.classifiedDetailTitle h1')) || document.title,
      price: priceMatch ? parseNumber(priceMatch[1]) : null,
      year: parseNumber(getInfo('yil')),
      km: parseNumber(getInfo('km')),
      info,
      description: txt(document.querySelector('#classifiedDescription')),
      features: [...document.querySelectorAll('#classifiedProperties li.selected')].map((li) => li.innerText.trim()),
      images: collectImages(id),
      parts: extractParts(),
    };
  }

  function saveCurrentListing() {
    const l = extractListing();
    if (!l.title || (!l.price && !l.km)) return null;
    const prev = getListing(l.id);
    const now = Date.now();
    const history = prev && prev.priceHistory ? prev.priceHistory.slice() : [];
    if (l.price && (!history.length || history[history.length - 1].price !== l.price)) history.push({ price: l.price, at: now });
    const rec = { ...l, firstSeen: prev ? prev.firstSeen : now, lastSeen: now, priceHistory: history, ai: prev ? prev.ai : undefined, manual: prev ? prev.manual : undefined };
    putListing(rec);
    saveQueue(loadQueue().filter((u) => u !== l.url));
    return rec;
  }

  function collectSearchLinks() {
    let links = [...document.querySelectorAll('a.classifiedTitle')].map((a) => a.href);
    if (!links.length) links = [...document.querySelectorAll('a[href*="/ilan/"]')].map((a) => a.href);
    return [...new Set(links.map((u) => u.split('?')[0].split('#')[0]))];
  }

  // ----- Ollama -----
  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        ...opts,
        onload: resolve,
        onerror: () => reject(new Error('Bağlantı kurulamadı: ' + opts.url)),
        ontimeout: () => reject(new Error('Zaman aşımı: ' + opts.url)),
      });
    });
  }

  function abToB64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  const BLOCK_STOP_AFTER = 3; // art arda bu kadar fotoğraf engellenirse/hata verirse analiz durur

  // Sonuç: { b64 } ya da { fail: 'missing' | 'blocked' | 'error', detail }
  // 'missing' (404/410) ilan kaldırılmış demektir ve durdurma sayacını artırmaz.
  async function fetchImage(url) {
    let r;
    try {
      r = await gmRequest({ method: 'GET', url, responseType: 'arraybuffer', timeout: 30000 });
    } catch (e) {
      return { fail: 'error', detail: 'bağlantı hatası' };
    }
    if (r.status === 404 || r.status === 410) return { fail: 'missing', detail: `HTTP ${r.status}` };
    if (r.status === 403 || r.status === 429) return { fail: 'blocked', detail: `HTTP ${r.status}` };
    if (r.status !== 200) return { fail: 'error', detail: `HTTP ${r.status}` };
    // Bot kontrolü 200 ile bir HTML sayfası da dönebilir: gerçekten görsel mi, dosya imzasından bak
    const b = new Uint8Array(r.response || new ArrayBuffer(0));
    const isImage = (b[0] === 0xff && b[1] === 0xd8) || (b[0] === 0x89 && b[1] === 0x50) || (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45);
    if (!isImage) return { fail: 'blocked', detail: 'görsel yerine başka bir içerik döndü' };
    return { b64: abToB64(r.response) };
  }

  async function ollamaJSON(cfg, prompt, images) {
    const send = (extra) => gmRequest({
      method: 'POST',
      url: cfg.ollama.url.replace(/\/$/, '') + '/api/generate',
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ model: cfg.ollama.model, prompt, images, stream: false, format: 'json', options: { temperature: 0 }, ...extra }),
      timeout: 300000,
    });
    // Düşünme modu cevabı ~5 kat yavaşlatıyor, kaliteyi artırmıyor; desteklemeyen modellerde parametresiz tekrar dene
    let r = await send({ think: false });
    if (r.status === 400 && /think/i.test(r.responseText || '')) r = await send({});
    if (r.status === 403) throw new Error('Ollama isteği reddetti (403). README\'deki OLLAMA_ORIGINS adımını uygula.');
    if (r.status !== 200) throw new Error(`Ollama hata ${r.status}: ${(r.responseText || '').slice(0, 200)}`);
    return JSON.parse(JSON.parse(r.responseText).response);
  }

  async function checkOllama(cfg) {
    let r;
    try {
      r = await gmRequest({ method: 'GET', url: cfg.ollama.url.replace(/\/$/, '') + '/api/tags', timeout: 5000 });
    } catch (e) {
      throw new Error('Ollama çalışmıyor gibi görünüyor. Ollama uygulamasını aç ve tekrar dene.');
    }
    if (r.status === 403) throw new Error('Ollama isteği reddetti (403). README\'deki OLLAMA_ORIGINS adımını uygula.');
    const models = (JSON.parse(r.responseText).models || []).map((m) => m.name);
    const want = cfg.ollama.model;
    if (!models.some((m) => m === want || m === want + ':latest')) {
      throw new Error(`"${want}" modeli yüklü değil. Terminalde: ollama pull ${want}`);
    }
  }

  function sample(arr, k) {
    if (arr.length <= k) return arr.slice();
    if (k <= 1) return [arr[0]];
    return Array.from({ length: k }, (_, i) => arr[Math.round((i * (arr.length - 1)) / (k - 1))]);
  }

  async function analyzeVision(l, cfg, todo, run, onStep) {
    const prompt = [
      'You are checking ONE photo from a used car listing.',
      'For each key below, return {"visible": true|false, "answer": true|false}.',
      '"visible" is true only if the relevant part of the car is clearly visible in THIS photo. If it is not visible, set "answer" to false.',
      '',
      ...todo.map((c) => `- "${c.id}": ${c.vision}`),
      '',
      `Reply with JSON only, with exactly these keys: ${todo.map((c) => c.id).join(', ')}.`,
    ].join('\n');
    const votes = Object.fromEntries(todo.map((c) => [c.id, { question: c.vision, yes: 0, no: 0 }]));
    const imgs = sample(l.images || [], cfg.ollama.maxImages);
    const photos = { tried: 0, ok: 0, missing: 0, failed: 0, lastError: null };
    for (let i = 0; i < imgs.length; i++) {
      if (run.cancel) break;
      if (photos.missing >= 2 && photos.ok === 0) break; // fotoğraflar silinmiş, ilan muhtemelen kaldırılmış
      onStep(`fotoğraf ${i + 1}/${imgs.length}` + (photos.failed + photos.missing ? ` · ${photos.failed + photos.missing} indirilemedi` : ''));
      photos.tried++;
      const img = await fetchImage(imgs[i]);
      if (img.fail === 'missing') {
        photos.missing++;
        continue;
      }
      if (img.fail) {
        photos.failed++;
        photos.lastError = img.detail;
        run.consecutiveFails++;
        if (run.consecutiveFails >= BLOCK_STOP_AFTER) {
          const err = new Error(`Fotoğraf sunucusu art arda ${run.consecutiveFails} isteğe cevap vermedi (${img.detail}). Engellenmiş olabilirsin; analiz durduruldu. Bir süre sonra tekrar dene.`);
          err.stopRun = true;
          throw err;
        }
        continue;
      }
      run.consecutiveFails = 0;
      const ans = await ollamaJSON(cfg, prompt, [img.b64]); // Ollama hatası tüm analizi durdurur
      photos.ok++;
      for (const c of todo) {
        const a = ans && ans[c.id];
        if (a && typeof a === 'object') {
          if (a.visible !== true) continue;
          if (a.answer === true) votes[c.id].yes++;
          else if (a.answer === false) votes[c.id].no++;
        }
      }
    }
    for (const v of Object.values(votes)) v.result = v.yes + v.no === 0 ? null : v.yes >= 1 && v.yes >= v.no;
    return { votes, photos };
  }

  async function analyzeText(l) {
    const facts = { baslik: l.title, fiyat: l.price, yil: l.year, km: l.km, bilgiler: l.info, boya_degisen: l.parts, donanim: (l.features || []).slice(0, 80) };
    const prompt = [
      'Sen ikinci el araç alımında yardımcı olan dikkatli bir uzmansın. Aşağıdaki sahibinden.com ilanını incele.',
      'Sadece ilandaki bilgilere dayan, bilgi uydurma.',
      '',
      'YAPISAL BİLGİ:',
      JSON.stringify(facts),
      '',
      'AÇIKLAMA:',
      (l.description || '(açıklama yok)').slice(0, 3000),
      '',
      'Şu JSON\'u Türkçe doldur:',
      '{"ozet": "en fazla 2 cümle", "artilar": ["..."], "eksiler": ["..."], "uyarilar": ["şüpheli veya çelişkili noktalar, satıcıya sorulması gerekenler"]}',
    ].join('\n');
    const cfg = loadConfig();
    const r = await ollamaJSON(cfg, prompt, []);
    return {
      ozet: String(r.ozet || ''),
      artilar: [].concat(r.artilar || []).map(String),
      eksiler: [].concat(r.eksiler || []).map(String),
      uyarilar: [].concat(r.uyarilar || []).map(String),
    };
  }

  // Analiz edilmesi gereken görsel kriterler: metinden zaten doğrulananlar ve aynı soruyla daha önce bakılanlar hariç
  function visionTodo(l, cfg) {
    const corpus = corpusOf(l);
    const done = (l.ai && l.ai.vision) || {};
    const man = manualOf(l);
    // Elle karara bağladığın kriterlere AI'ın tekrar bakması gereksiz
    return (cfg.scoring.criteria || []).filter(
      (c) => c.vision && man['crit:' + c.id] === undefined && !findKeyword(corpus, c.keywords) && !(done[c.id] && done[c.id].question === c.vision)
    );
  }

  let aiRunning = false;
  let aiRun = null; // { cancel, consecutiveFails, failed, missing }

  async function runAI(setStatus) {
    const cfg = loadConfig();
    if (!cfg.ollama.enabled) return setStatus('Yerel AI ayarlardan kapalı.');
    try {
      await checkOllama(cfg);
    } catch (e) {
      return setStatus('⚠ ' + e.message);
    }
    const result = computeRows(loadListings(), cfg);
    const targets = [...result.passed, ...result.unsure].map((r) => r.l.id);
    aiRunning = true;
    const run = (aiRun = { cancel: false, consecutiveFails: 0, failed: 0, missing: 0 });
    let n = 0;
    try {
      for (const id of targets) {
        if (run.cancel) break;
        n++;
        const l = getListing(id);
        if (!l) continue;
        const ai = l.ai || {};
        const todo = visionTodo(l, cfg);
        const label = `(${n}/${targets.length}) ${l.title.slice(0, 40)}`;
        if (todo.length && (l.images || []).length) {
          const { votes, photos } = await analyzeVision(l, cfg, todo, run, (s) => setStatus(`${label}: ${s}`));
          if (run.cancel) break; // yarım kalan ilanın sonucunu kaydetme
          run.failed += photos.failed;
          run.missing += photos.missing;
          ai.photos = { ...photos, at: Date.now() };
          // Hiç fotoğraf incelenemediyse sonucu kaydetme ki sonraki çalıştırmada tekrar denensin;
          // fotoğraflar silinmişse (ilan kaldırılmış) tekrar denemenin anlamı yok.
          if (photos.ok > 0 || (photos.missing > 0 && photos.failed === 0)) ai.vision = { ...(ai.vision || {}), ...votes };
        }
        if (!ai.text || ai.text.error) {
          setStatus(`${label}: açıklama inceleniyor`);
          try {
            ai.text = await analyzeText(l);
          } catch (e) {
            if (/Ollama/.test(e.message)) throw e;
            ai.text = { error: e.message };
          }
        }
        const fresh = getListing(id); // analiz sürerken ilan başka sekmede güncellenmiş olabilir
        if (fresh) putListing({ ...fresh, ai });
        render();
      }
      const photoNote = [run.failed ? `${run.failed} fotoğraf indirilemedi` : '', run.missing ? `${run.missing} fotoğraf silinmiş` : ''].filter(Boolean).join(', ');
      setStatus((run.cancel ? 'Durduruldu. Tekrar başlatınca kaldığı yerden devam eder.' : `Yerel AI analizi bitti (${n} ilan).`) + (photoNote ? ` · ${photoNote}` : ''));
    } catch (e) {
      setStatus('⚠ ' + e.message);
    } finally {
      aiRunning = false;
      render();
    }
  }

  // ---------------------------------------------------------------------------
  // Arayüz
  // ---------------------------------------------------------------------------
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .wrap {
      --bg: #ffffff; --bg2: #f5f6f8; --fg: #1d2330; --muted: #6b7280; --line: #e3e6eb;
      --accent: #2563eb; --good: #15803d; --warn: #b45309; --bad: #b91c1c; --dot: #9ca3af;
      color: var(--fg); font-size: 13px; line-height: 1.45;
    }
    @media (prefers-color-scheme: dark) {
      .wrap { --bg: #171a21; --bg2: #20242d; --fg: #e8eaee; --muted: #9aa3b2; --line: #2e3440;
        --accent: #60a5fa; --good: #4ade80; --warn: #fbbf24; --bad: #f87171; --dot: #6b7280; }
    }
    .fab { position: fixed; right: 16px; bottom: 16px; z-index: 2147483646; display: flex; gap: 8px; align-items: center; }
    button { cursor: pointer; border: 1px solid var(--line); background: var(--bg); color: var(--fg); border-radius: 8px; padding: 7px 12px; font-size: 13px; }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    button:disabled { opacity: .5; cursor: default; }
    .fab button { box-shadow: 0 2px 10px rgba(0,0,0,.18); }
    .toast { position: fixed; right: 16px; bottom: 64px; z-index: 2147483646; background: var(--bg); border: 1px solid var(--line);
      border-radius: 8px; padding: 8px 12px; box-shadow: 0 2px 10px rgba(0,0,0,.18); max-width: 360px; }
    .panel { position: fixed; inset: 4vh 2vw; z-index: 2147483647; background: var(--bg); border: 1px solid var(--line); border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0,0,0,.3); display: flex; flex-direction: column; overflow: hidden; max-width: 1100px; margin: 0 auto; }
    .head { display: flex; align-items: center; gap: 6px; padding: 10px 14px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
    .head h1 { font-size: 15px; margin: 0 12px 0 0; }
    .tab { border: none; background: none; padding: 6px 10px; border-radius: 6px; }
    .tab.on { background: var(--bg2); font-weight: 600; }
    .spacer { flex: 1; }
    .body { overflow: auto; padding: 14px; flex: 1; }
    .bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 12px; }
    .muted { color: var(--muted); }
    h2 { font-size: 14px; margin: 18px 0 8px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { font-weight: 600; color: var(--muted); font-size: 12px; }
    td.num, th.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
    a { color: var(--accent); text-decoration: none; }
    .score { font-weight: 700; }
    .good { color: var(--good); } .warn { color: var(--warn); } .bad { color: var(--bad); }
    details > summary { cursor: pointer; color: var(--muted); font-size: 12px; margin-top: 4px; }
    .detail { background: var(--bg2); border-radius: 8px; padding: 8px 10px; margin-top: 6px; }
    .detail ul { margin: 4px 0; padding-left: 18px; }
    .mbtns { display: inline-flex; gap: 4px; margin-left: 6px; vertical-align: middle; }
    .mini { padding: 1px 8px; font-size: 12px; border-radius: 6px; line-height: 1.5; }
    .mini.on.yes { background: var(--good); border-color: var(--good); color: #fff; }
    .mini.on.no { background: var(--bad); border-color: var(--bad); color: #fff; }
    .ask { margin-top: 5px; display: flex; flex-direction: column; gap: 4px; }
    .ask > div { display: flex; align-items: center; gap: 2px; flex-wrap: wrap; font-size: 12px; }
    textarea { width: 100%; min-height: 55vh; font-family: ui-monospace, Menlo, monospace; font-size: 12px; background: var(--bg2);
      color: var(--fg); border: 1px solid var(--line); border-radius: 8px; padding: 10px; }
    .chart text { fill: var(--muted); font-size: 11px; }
    .chart .axis { stroke: var(--line); }
    .chart .dot { fill: var(--dot); opacity: .6; }
    .chart .dot.pass { fill: var(--good); opacity: .8; }
    .chart .dot.top { fill: var(--accent); opacity: 1; }
    .legend span { display: inline-flex; align-items: center; gap: 4px; margin-right: 14px; }
    .legend i { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; margin-bottom: 14px; }
    .stat { background: var(--bg2); border-radius: 8px; padding: 10px; }
    .stat b { display: block; font-size: 16px; }
  `;

  let host;
  let root;
  let state = { open: false, tab: 'sira', status: '', openRows: new Set() };

  function mount() {
    host = document.createElement('div');
    host.id = 'sahibinden-asistan';
    document.documentElement.appendChild(host);
    root = host.attachShadow({ mode: 'open' });
    root.addEventListener('click', onClick);
    render();
  }

  function setStatus(s) {
    state.status = s;
    const el = root.querySelector('[data-status]');
    if (el) el.textContent = s;
  }

  function scoreClass(r) {
    const p = r.score.total / (r.score.max || 1);
    return p >= 0.66 ? 'good' : p >= 0.4 ? 'warn' : 'bad';
  }

  function marketCell(r) {
    if (!r.market) return '<span class="muted">–</span>';
    const pct = r.market.diff * 100;
    const cls = pct <= -3 ? 'good' : pct >= 3 ? 'bad' : '';
    return `<span class="${cls}" title="Tahmini piyasa fiyatı: ${fmtTL(r.market.pred)}">${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%</span>`;
  }

  // "Var / Yok" düğme çifti; cur: true, false ya da undefined (henüz karar yok)
  function manualBtns(id, key, yes, no, cur) {
    const b = (v, txt, cls) =>
      `<button class="mini${cur === v ? ' on ' + cls : ''}" data-manual="${esc(id)}" data-key="${esc(key)}" data-val="${v ? '1' : '0'}">${esc(txt)}</button>`;
    const undo = cur === undefined ? '' : `<button class="mini" data-manual="${esc(id)}" data-key="${esc(key)}" data-val="">geri al</button>`;
    return `<span class="mbtns">${b(true, yes, 'yes')}${b(false, no, 'no')}${undo}</span>`;
  }

  // Doğrulanamayan şartlar: ilan satırının altında, ayrıntıları açmadan cevaplanabilsin
  function askBlock(r) {
    if (!r.hard.unknowns.length) return '';
    return `<div class="ask">${r.hard.unknowns
      .map((u) => `<div><span class="warn">${esc(u.label)}</span>${manualBtns(r.l.id, u.key, u.yes, u.no, undefined)}</div>`)
      .join('')}</div>`;
  }

  function detailBlock(r) {
    const l = r.l;
    const t = l.ai && l.ai.text;
    const man = manualOf(l);
    const lines = r.score.lines
      .map((x) => {
        const btns = x.key && x.askable ? manualBtns(l.id, x.key, 'Var', 'Yok', man[x.key]) : '';
        return `<li>${esc(x.name)}: <b>${Math.round(x.points)}/${x.max}</b> <span class="muted">${esc(x.via || '')}${x.pending ? ' ⏳' : ''}</span>${btns}</li>`;
      })
      .join('');
    const nonOrig = l.parts ? Object.entries(l.parts).filter(([, st]) => st !== 'orijinal') : [];
    let html = `<div class="detail"><b>Puan dökümü</b><ul>${lines}</ul>`;
    if (r.hard.decided.length) {
      html += `<b>Senin kontrollerin</b><ul>${r.hard.decided
        .map((d) => `<li class="${d.ok ? 'good' : 'bad'}">${esc(d.label)} → <b>${esc(d.ok ? d.yes : d.no)}</b>${manualBtns(l.id, d.key, d.yes, d.no, d.ok)}</li>`)
        .join('')}</ul>`;
    }
    // Cevaplanmamış sorular ilan satırının altında duruyor (askBlock), burada tekrar edilmiyor.
    if (r.hard.fails.length) html += `<b>Elenme nedeni</b><ul>${r.hard.fails.map((u) => `<li class="bad">${esc(u)}</li>`).join('')}</ul>`;
    html += `<b>Boya/değişen</b> <span class="muted">${l.parts && Object.keys(l.parts).length ? (nonOrig.length ? esc(nonOrig.map(([p, st]) => `${p}: ${st}`).join(', ')) : 'tüm parçalar orijinal') : 'okunamadı'}</span>`;
    const ph = l.ai && l.ai.photos;
    if (ph) {
      const parts = [`${ph.ok}/${ph.tried} incelendi`];
      if (ph.failed) parts.push(`${ph.failed} indirilemedi${ph.lastError ? ` (${ph.lastError})` : ''}`);
      if (ph.missing) parts.push(`${ph.missing} silinmiş, ilan kaldırılmış olabilir`);
      html += `<div style="margin-top:6px"><b>Fotoğraflar</b> <span class="${ph.failed || ph.missing ? 'warn' : 'muted'}">${esc(parts.join(' · '))}</span></div>`;
    }
    if (r.flags.length) html += `<b style="display:block;margin-top:6px">Uyarılar</b><ul>${r.flags.map((f) => `<li class="warn">${esc(f)}</li>`).join('')}</ul>`;
    if (t && !t.error) {
      html += `<b style="display:block;margin-top:6px">Yerel AI</b><div>${esc(t.ozet)}</div>`;
      if (t.artilar.length) html += `<div class="good">+ ${t.artilar.map(esc).join(' · ')}</div>`;
      if (t.eksiler.length) html += `<div class="bad">− ${t.eksiler.map(esc).join(' · ')}</div>`;
      if (t.uyarilar.length) html += `<ul>${t.uyarilar.map((u) => `<li class="warn">${esc(u)}</li>`).join('')}</ul>`;
    } else if (t && t.error) {
      html += `<div class="muted">Yerel AI hatası: ${esc(t.error)}</div>`;
    }
    return html + '</div>';
  }

  function table(rows, startIdx) {
    if (!rows.length) return '<p class="muted">Henüz ilan yok.</p>';
    return `<table><thead><tr><th>#</th><th>İlan</th><th class="num">Fiyat</th><th class="num">Yıl</th><th class="num">KM</th><th class="num">Tramer</th><th class="num">Piyasa</th><th class="num">Puan</th></tr></thead><tbody>${rows
      .map((r, i) => {
        const tr = r.score.tramer.amount;
        return `<tr>
          <td class="num">${startIdx + i + 1}</td>
          <td><a href="${esc(r.l.url)}" target="_blank">${esc(r.l.title)}</a>${r.flags.length ? ` <span class="warn" title="${esc(r.flags.join('\n'))}">⚠ ${r.flags.length}</span>` : ''}
            ${askBlock(r)}
            <details ${state.openRows.has(r.l.id) ? 'open' : ''}><summary data-row="${esc(r.l.id)}">ayrıntılar</summary>${detailBlock(r)}</details></td>
          <td class="num">${fmtTL(r.l.price)}</td>
          <td class="num">${r.l.year ?? '–'}</td>
          <td class="num">${fmtNum(r.l.km)}</td>
          <td class="num">${tr == null ? '<span class="muted">?</span>' : tr === 0 ? 'yok' : fmtNum(tr)}</td>
          <td class="num">${marketCell(r)}</td>
          <td class="num score ${scoreClass(r)}">${Math.round(r.score.total)}<span class="muted">/${r.score.max}</span></td>
        </tr>`;
      })
      .join('')}</tbody></table>`;
  }

  function renderRanking(result) {
    const count = countListings();
    let html = `<div class="bar">
      <button class="primary" data-action="ai" ${aiRunning ? 'disabled' : ''}>Yerel AI analizini çalıştır</button>
      ${aiRunning ? '<button data-action="ai-stop">Durdur</button>' : ''}
      <button data-action="claude" ${result.passed.length + result.unsure.length ? '' : 'disabled'}>Claude için kopyala</button>
      <span class="muted" data-status>${esc(state.status)}</span></div>`;
    html += `<p class="muted">${count} ilan kayıtlı · ${result.passed.length} geçti · ${result.unsure.length} doğrulanamadı · ${result.rejected.length} elendi</p>`;
    html += `<h2>En iyi ${MAX_TOP}</h2>` + table(result.passed.slice(0, MAX_TOP), 0);
    if (result.unsure.length) {
      html += `<h2>Kontrol edilecekler <span class="muted">(ilandan doğrulanamayan şartlar — ilana bakıp kendin işaretle)</span></h2>` + table(result.unsure.slice(0, MAX_TOP), 0);
    }
    if (result.rejected.length) {
      html += `<details><summary>Elenen ${result.rejected.length} ilan</summary><ul>${result.rejected
        .map((r) => `<li><a href="${esc(r.l.url)}" target="_blank">${esc(r.l.title)}</a> <span class="bad">${esc(r.hard.fails.join(', '))}</span>${r.hard.decided
          .filter((d) => !d.ok)
          .map((d) => manualBtns(r.l.id, d.key, d.yes, d.no, false))
          .join('')}</li>`)
        .join('')}</ul></details>`;
    }
    return html;
  }

  function renderChart(result) {
    const topIds = new Set(result.passed.slice(0, MAX_TOP).map((r) => r.l.id));
    const passIds = new Set(result.passed.map((r) => r.l.id));
    const pts = result.all.filter((r) => r.l.price && r.l.km != null);
    if (pts.length < 2) return '<p class="muted">Grafik için en az 2 ilan gerekli.</p>';
    const W = 860, H = 380, m = { l: 80, r: 16, t: 14, b: 40 };
    const xs = pts.map((r) => r.l.km), ys = pts.map((r) => r.l.price);
    const x1 = Math.max(...xs) * 1.05 || 1;
    let y0 = Math.min(...ys) * 0.95, y1 = Math.max(...ys) * 1.05;
    if (y1 - y0 < 1) y1 = y0 + 1;
    const X = (v) => m.l + (v / x1) * (W - m.l - m.r);
    const Y = (v) => H - m.b - ((v - y0) / (y1 - y0)) * (H - m.t - m.b);
    let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Fiyat ve kilometre dağılımı">`;
    for (let i = 0; i <= 5; i++) {
      const xv = (x1 * i) / 5, yv = y0 + ((y1 - y0) * i) / 5;
      svg += `<line class="axis" x1="${X(xv)}" y1="${m.t}" x2="${X(xv)}" y2="${H - m.b}"/><text x="${X(xv)}" y="${H - m.b + 16}" text-anchor="middle">${fmtNum(xv / 1000)}k</text>`;
      svg += `<line class="axis" x1="${m.l}" y1="${Y(yv)}" x2="${W - m.r}" y2="${Y(yv)}"/><text x="${m.l - 6}" y="${Y(yv) + 4}" text-anchor="end">${(yv / 1e6).toFixed(2)}M</text>`;
    }
    svg += `<text x="${(W + m.l) / 2}" y="${H - 6}" text-anchor="middle">Kilometre</text>`;
    const ordered = [...pts].sort((a, b) => (topIds.has(a.l.id) ? 1 : passIds.has(a.l.id) ? 0.5 : 0) - (topIds.has(b.l.id) ? 1 : passIds.has(b.l.id) ? 0.5 : 0));
    for (const r of ordered) {
      const cls = topIds.has(r.l.id) ? 'top' : passIds.has(r.l.id) ? 'pass' : '';
      svg += `<a href="${esc(r.l.url)}" target="_blank"><circle class="dot ${cls}" cx="${X(r.l.km)}" cy="${Y(r.l.price)}" r="${cls === 'top' ? 6 : 4.5}"><title>${esc(r.l.title)}\n${fmtTL(r.l.price)} · ${fmtNum(r.l.km)} km · ${r.l.year ?? ''}</title></circle></a>`;
    }
    return svg + '</svg>';
  }

  function renderAnalysis(result) {
    const prices = result.all.map((r) => r.l.price).filter(Boolean).sort((a, b) => a - b);
    const median = prices.length ? prices[Math.floor(prices.length / 2)] : null;
    const md = result.model;
    const cheap = result.passed.filter((r) => r.market).sort((a, b) => a.market.diff - b.market.diff).slice(0, 5);
    let html = '<div class="stats">';
    html += `<div class="stat"><span class="muted">Kayıtlı ilan</span><b>${result.all.length}</b></div>`;
    html += `<div class="stat"><span class="muted">Medyan fiyat</span><b>${fmtTL(median)}</b></div>`;
    html += `<div class="stat"><span class="muted">Her 10.000 km</span><b>${md ? fmtTL(md.per10kKm) : '–'}</b></div>`;
    html += `<div class="stat"><span class="muted">Her model yılı</span><b>${md && md.perYear != null ? (md.perYear >= 0 ? '+' : '') + fmtTL(md.perYear) : '–'}</b></div>`;
    html += '</div>';
    if (!md) html += '<p class="muted">Piyasa modeli için fiyatı, yılı ve kilometresi okunmuş en az 8 ilan gerekli. Mutlak filtreleri geçmeyen ilanlar da modele katkı sağlar; aramada gezdiğin her ilan işe yarar.</p>';
    else html += `<p class="muted">Model ${md.n} ilandan kuruldu: fiyat ≈ sabit + yıl etkisi + kilometre etkisi. Donanım farkını hesaba katmaz; "Piyasa" sütunu bu tahmine göre ilanın ne kadar ucuz (−) veya pahalı (+) olduğunu gösterir.</p>`;
    html += `<div class="legend muted"><span><i style="background:var(--accent)"></i>En iyi ${MAX_TOP}</span><span><i style="background:var(--good)"></i>Filtreleri geçen</span><span><i style="background:var(--dot)"></i>Diğer</span></div>`;
    html += renderChart(result);
    if (cheap.length) {
      html += '<h2>Kriterleri geçenler içinde piyasaya göre en uygunlar</h2><ul>';
      html += cheap.map((r) => `<li><a href="${esc(r.l.url)}" target="_blank">${esc(r.l.title)}</a> · ${fmtTL(r.l.price)} · ${marketCell(r)}</li>`).join('');
      html += '</ul>';
    }
    return html;
  }

  function renderSettings() {
    return `<p class="muted">Ayarları JSON olarak düzenle. Puanlar ve filtreler kaydettiğin anda tüm ilanlara yeniden uygulanır, sayfaları tekrar gezmen gerekmez.
      <br>Kriterlerde <code>keywords</code> ilan metninde aranır; <code>vision</code> varsa metinde bulunamadığında fotoğraflar yerel AI'a sorulur; <code>allOf</code> diğer kriterlerin hepsi sağlanınca geçerli olur.</p>
      <textarea data-config spellcheck="false">${esc(JSON.stringify(loadConfig(), null, 2))}</textarea>
      <div class="bar" style="margin-top:8px">
        <button class="primary" data-action="cfg-save">Kaydet</button>
        <button data-action="cfg-export">Dosyaya indir</button>
        <button data-action="cfg-import">Dosyadan yükle</button>
        <button data-action="cfg-reset">Varsayılana dön</button>
        <span class="muted" data-status>${esc(state.status)}</span>
      </div>`;
  }

  function renderData() {
    const count = countListings();
    const q = loadQueue().length;
    return `<p>${count} ilan kayıtlı. Kuyrukta ${q} ilan var.</p>
      <div class="bar">
        <button data-action="data-export">Verileri indir (JSON)</button>
        <button data-action="data-import">Veri dosyası yükle (birleştirir)</button>
        <button data-action="queue-clear">Kuyruğu temizle</button>
        <button data-action="data-clear">Tüm ilanları sil</button>
        <span class="muted" data-status>${esc(state.status)}</span>
      </div>
      <p class="muted">Veriler yalnızca bu tarayıcıda, Tampermonkey'in deposunda durur. Hiçbir sunucuya gönderilmez; yerel AI açıksa sadece kendi bilgisayarındaki Ollama'ya gider.</p>`;
  }

  function render() {
    if (!root) return;
    const queue = loadQueue();
    const count = countListings();
    let fab = '<div class="fab">';
    if (!state.open && isDetailPage() && queue.length) fab += `<button class="primary" data-action="next">Sonraki ilan → (${queue.length})</button>`;
    if (!state.open && !isDetailPage()) {
      const links = collectSearchLinks();
      if (links.length) fab += `<button data-action="enqueue">Sayfadaki ${links.length} ilanı kuyruğa ekle</button>`;
    }
    fab += `<button data-action="toggle">🚗 Asistan (${count})</button></div>`;

    let panel = '';
    if (state.open) {
      const cfg = loadConfig();
      const result = computeRows(loadListings(), cfg);
      const tabs = [['sira', 'Sıralama'], ['analiz', 'Piyasa analizi'], ['ayar', 'Ayarlar'], ['veri', 'Veri']];
      const body = state.tab === 'sira' ? renderRanking(result) : state.tab === 'analiz' ? renderAnalysis(result) : state.tab === 'ayar' ? renderSettings() : renderData();
      panel = `<div class="panel"><div class="head"><h1>Araç Asistanı</h1>${tabs
        .map(([k, n]) => `<button class="tab ${state.tab === k ? 'on' : ''}" data-tab="${k}">${n}</button>`)
        .join('')}<span class="spacer"></span><button data-action="toggle">Kapat</button></div><div class="body">${body}</div></div>`;
    }
    const scroll = root.querySelector('.body')?.scrollTop || 0;
    root.innerHTML = `<style>${CSS}</style><div class="wrap">${panel}${fab}</div>`;
    const b = root.querySelector('.body');
    if (b) b.scrollTop = scroll;
  }

  function toast(msg, ms = 3500) {
    const wrap = root.querySelector('.wrap');
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    wrap.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function pickFile() {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.json,application/json';
      inp.onchange = () => (inp.files[0] ? inp.files[0].text().then(resolve) : resolve(null));
      inp.click();
    });
  }

  function validateConfig(c) {
    const h = c && c.hardFilters, s = c && c.scoring;
    if (!h || !s || !c.ollama) throw new Error('"ollama", "hardFilters" ve "scoring" bölümleri gerekli.');
    for (const k of ['maxKm', 'minYear', 'maxPrice']) if (typeof h[k] !== 'number') throw new Error(`hardFilters.${k} sayı olmalı.`);
    if (!s.km || !s.tramer || !Array.isArray(s.criteria)) throw new Error('scoring içinde km, tramer ve criteria gerekli.');
    const ids = new Set();
    for (const cr of s.criteria) {
      if (!cr.id || !cr.name || typeof cr.points !== 'number') throw new Error('Her kriterde id, name ve points olmalı.');
      if (ids.has(cr.id)) throw new Error(`Kriter id'si tekrar ediyor: ${cr.id}`);
      ids.add(cr.id);
    }
    for (const cr of s.criteria) for (const id of cr.allOf || []) if (!ids.has(id)) throw new Error(`${cr.id}.allOf içinde bilinmeyen kriter: ${id}`);
    return c;
  }

  async function onClick(e) {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn) {
      state.tab = tabBtn.dataset.tab;
      state.status = '';
      return render();
    }
    // Ayrıntılar açık/kapalı durumu render sonrası korunsun (açma işini tarayıcı yapar)
    const sum = e.target.closest('summary[data-row]');
    if (sum) {
      const rowId = sum.dataset.row;
      if (state.openRows.has(rowId)) state.openRows.delete(rowId);
      else state.openRows.add(rowId);
      return;
    }

    // Elle doğrulama: Var / Yok / geri al
    const mBtn = e.target.closest('[data-manual]');
    if (mBtn) {
      const l = getListing(mBtn.dataset.manual);
      if (!l) return;
      const key = mBtn.dataset.key;
      const raw = mBtn.dataset.val;
      const man = { ...manualOf(l) };
      if (raw === '') delete man[key];
      else man[key] = raw === '1';
      l.manual = man;
      putListing(l);
      render();
      if (raw === '') return toast('Kontrol geri alındı.');
      const hard = evalHard(l, loadConfig());
      const where = hard.status === 'gecti' ? '✓ artık filtreleri geçiyor' : hard.status === 'belirsiz' ? '? başka doğrulanamayan şart var' : '✗ elendi';
      return toast(`Kaydedildi · ${where}`);
    }

    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'toggle') {
      state.open = !state.open;
      return render();
    }
    if (action === 'enqueue') {
      const saved = loadListings();
      const savedUrls = new Set(Object.values(saved).map((l) => l.url));
      const q = loadQueue();
      const add = collectSearchLinks().filter((u) => !savedUrls.has(u) && !q.includes(u));
      saveQueue([...q, ...add]);
      render();
      return toast(`${add.length} yeni ilan kuyruğa eklendi. İlk ilanı açıp "Sonraki ilan" ile ilerleyebilirsin.`);
    }
    if (action === 'next') {
      const q = loadQueue();
      if (q.length) location.href = q[0];
      return;
    }
    if (action === 'ai') {
      runAI(setStatus);
      return render();
    }
    if (action === 'ai-stop') {
      if (aiRun) aiRun.cancel = true;
      return setStatus('Durduruluyor, mevcut fotoğraf bitince duracak…');
    }
    if (action === 'claude') {
      const text = claudePrompt(computeRows(loadListings(), loadConfig()), loadConfig());
      GM_setClipboard(text, 'text');
      return setStatus(`Kopyalandı (~${Math.round(text.length / 3.5 / 1000)}k token). claude.ai'da yeni bir sohbete yapıştır.`);
    }
    if (action === 'cfg-save') {
      try {
        saveConfig(validateConfig(JSON.parse(root.querySelector('[data-config]').value)));
        state.status = 'Kaydedildi ✓';
        render();
      } catch (err) {
        setStatus('⚠ ' + err.message);
      }
      return;
    }
    if (action === 'cfg-reset') {
      if (!confirm('Ayarlar varsayılana dönsün mü?')) return;
      saveConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
      state.status = 'Varsayılan ayarlar yüklendi.';
      return render();
    }
    if (action === 'cfg-export') return download('asistan-ayarlar.json', JSON.stringify(loadConfig(), null, 2));
    if (action === 'cfg-import') {
      const text = await pickFile();
      if (!text) return;
      try {
        saveConfig(validateConfig(JSON.parse(text)));
        state.status = 'Ayarlar yüklendi ✓';
        render();
      } catch (err) {
        setStatus('⚠ ' + err.message);
      }
      return;
    }
    if (action === 'data-export') return download(`asistan-ilanlar-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(loadListings()));
    if (action === 'data-import') {
      const text = await pickFile();
      if (!text) return;
      try {
        const incoming = JSON.parse(text);
        for (const l of Object.values(incoming)) if (l && l.id && !getListing(l.id)) putListing(l);
        state.status = `${Object.keys(incoming).length} ilan birleştirildi ✓`;
        render();
      } catch (err) {
        setStatus('⚠ Dosya okunamadı: ' + err.message);
      }
      return;
    }
    if (action === 'queue-clear') {
      saveQueue([]);
      return render();
    }
    if (action === 'data-clear') {
      if (!confirm('Kayıtlı tüm ilanlar ve AI sonuçları silinsin mi? Bu geri alınamaz.')) return;
      clearListings();
      return render();
    }
  }


  // ---------------------------------------------------------------------------
  // Başlat
  // ---------------------------------------------------------------------------
  function init() {
    if (window.top !== window.self || isBotCheck()) return;
    migrateStorage();
    mount();
    if (isDetailPage()) {
      const l = saveCurrentListing();
      if (l) {
        const cfg = loadConfig();
        const hard = evalHard(l, cfg);
        const sc = scoreListing(l, cfg);
        const label = hard.status === 'gecti' ? '✓ filtreleri geçti' : hard.status === 'belirsiz' ? '? doğrulanamadı' : '✗ elendi: ' + hard.fails.join(', ');
        render();
        toast(`Kaydedildi · ${Math.round(sc.total)}/${sc.max} puan · ${label}`);
      } else {
        toast('İlan bilgileri okunamadı. Sayfa yapısı beklenenden farklı olabilir.');
      }
    }
  }

  init();
})();
