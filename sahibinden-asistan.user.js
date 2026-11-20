// ==UserScript==
// @name         Sahibinden Araç Asistanı
// @namespace    sahibinden-asistan
// @version      0.11.0
// @description  Gezdiğin ilanları toplar, filtreler, puanlar; yerel AI (Ollama) ile görsel ve metin analizi yapar, piyasa analizi çıkarır. İstersen verileri GitHub üzerinden kendi bilgisayarların ve arkadaşlarınla paylaşır.
// @homepageURL  https://github.com/registerkayitey-sudo/sahibinden-asistan
// @updateURL    https://raw.githubusercontent.com/registerkayitey-sudo/sahibinden-asistan/main/sahibinden-asistan.user.js
// @downloadURL  https://raw.githubusercontent.com/registerkayitey-sudo/sahibinden-asistan/main/sahibinden-asistan.user.js
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
// @connect      api.github.com
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
      model: 'gemma4:12b-it-qat', // GGUF; MLX sürümü (gemma4:12b) 16 GB'lık Mac'te belleğin tamamını kullanıyordu
      maxImages: 10,
    },
    hardFilters: {
      maxKm: 125000, // bu değerin altı
      minYear: 2020, // en az
      maxPrice: 2400000, // en fazla
      originalParts: ['Tavan', 'Motor Kaputu'],
      requiredFeatures: [
        {
          name: 'Hayalet gösterge (HUD)',
          keywords: ['hayalet', 'head-up', 'head up', 'headup', 'hud', '6u3', 'executive paket', 'executive package'],
          // Satıcıların HUD dışındaki şeyler (ör. dijital gösterge paneli) için de kullandığı ifadeler:
          // ilanda sadece bunlar geçiyorsa "var" sayılmaz, sana sorulur.
          unsureKeywords: ['yarı hayalet', 'hayalet kadran', 'dijital hayalet'],
        },
      ],
    },
    scoring: {
      km: { points: 40, bestKm: 20000, worstKm: 125000 },
      // Fiyat ve model yılı: best değerde tam puan, worst değerde 0. Varsayılan 0 puan; "Benim sıralamam" önerebilir.
      price: { points: 0, best: 1800000, worst: 2400000 },
      year: { points: 0, best: 2024, worst: 2020 },
      // Renk başına puan: [{ name: 'Siyah', points: 10 }, …]. Boş: renk puanlamaya girmez; Benim sıralamam öğrenir.
      colors: [],
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
          views: ['interior'],
        },
        {
          id: 'shadow', name: 'Shadow paket', points: 20,
          keywords: ['shadow paket', 'shadow edition', 'shadow package'],
          allOf: ['jant', 'izgara'],
        },
        {
          id: 'jant', name: '554M Y-Spoke jant', points: 10,
          keywords: ['554m', '554 m', 'y-spoke', 'y spoke', 'y kollu'],
          vision: 'Are the wheels BMW 554M Y-spoke alloy wheels in a fully black finish (not bicolor or polished, not silver)?',
          views: ['wheel', 'exterior_side', 'exterior_front', 'exterior_rear'],
        },
        {
          id: 'izgara', name: 'Siyah ızgara (7M9)', points: 0,
          keywords: ['7m9', 'siyah ızgara', 'siyah böbrek', 'parlak siyah ızgara', 'shadow line'],
          vision: 'Is the BMW kidney grille frame black (not chrome)?',
          views: ['exterior_front'],
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

  // Elle verilen kararlar ilanda { anahtar: { v: true | false | null, at } } olarak durur
  // (ör. 'feat:Hayalet gösterge (HUD)', 'part:Tavan', 'crit:kirmizi').
  // v: null "geri alındı" demek; silinmez ki başka bilgisayarla eşitlenirken eski karar geri gelmesin.
  // 0.4.0 düz true/false tutuyordu, o da okunur. manualOf geçerli kararları true/false olarak verir.
  const manualEntry = (x) => (typeof x === 'boolean' ? { v: x, at: 0 } : x && typeof x === 'object' ? x : null);
  function manualOf(l) {
    const out = {};
    for (const [k, x] of Object.entries((l && l.manual) || {})) {
      const e = manualEntry(x);
      if (e && typeof e.v === 'boolean') out[k] = e.v;
    }
    return out;
  }
  // Karar dahil ettiğin başka bir kişiden geliyorsa onun adı, seninse null
  const manualBy = (l, key) => (l && l._manualBy && l._manualBy[key]) || null;

  // ---------------------------------------------------------------------------
  // Takip: ilana senin verdiğin durum ve not
  // ---------------------------------------------------------------------------
  // İlanda track: { status: { v, at }, note: { v, at } } olarak durur. Elle kararlar gibi alan başına
  // en yeni kazanır; v: null "temizlendi" demek, silinmez ki eşitlemede eski değer geri gelmesin.
  // Kapanmış durumlar (closed) ilanı sıralamadan ve AI analizinden çıkarır, piyasa modelinde kalır.
  const STATUSES = [
    { id: 'takip', label: 'Takipte' },
    { id: 'arandi', label: 'Arandı' },
    { id: 'ekspertiz', label: 'Ekspertiz' },
    { id: 'teklif', label: 'Teklif verildi' },
    { id: 'vazgecti', label: 'Vazgeçildi', closed: true },
    { id: 'satildi', label: 'Satılmış', closed: true },
  ];
  const statusInfo = (id) => STATUSES.find((x) => x.id === id) || null;

  // by: durum/not dahil ettiğin başka bir kişiden geliyorsa onun adı. Onun durumu seninkinin yerine geçmez,
  // sadece bilgi olarak gösterilir (ali "vazgeçti" dedi diye ilan senin listenden düşmez).
  function trackOf(l) {
    const t = (l && l.track) || {};
    const status = t.status && statusInfo(t.status.v) ? t.status.v : null;
    const note = t.note && typeof t.note.v === 'string' ? t.note.v : '';
    return { status, note, by: (l && l._trackBy) || null };
  }
  const isClosed = (l) => {
    const t = trackOf(l);
    return !t.by && !!(statusInfo(t.status) || {}).closed;
  };

  function evalHard(l, cfg) {
    const h = cfg.hardFilters;
    const man = manualOf(l);
    const fails = [];
    const unknowns = [];
    const decided = [];
    // İlandan doğrulanamayan bir şart: kullanıcı karar verdiyse onu uygula, vermediyse sor.
    const ask = (key, label, yes, no, failLabel) => {
      const d = man[key];
      const by = manualBy(l, key);
      if (d === true) decided.push({ key, label, yes, no, ok: true, by });
      else if (d === false) { decided.push({ key, label, yes, no, ok: false, by }); fails.push(`${failLabel} (${by ? by + ' kontrol etti' : 'senin kontrolün'})`); }
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

    // Olması gereken donanımlar: senin kararın > metinde kesin geçmesi > sor.
    // feats puan dökümünde gösterilir; metinden "var" denmiş olsa da Var/Yok ile değiştirebilirsin.
    const corpus = corpusOf(l);
    const feats = [];
    for (const f of h.requiredFeatures || []) {
      const key = `feat:${f.name}`;
      const hit = findFeature(corpus, f);
      const label = hit.kw ? `${f.name} (metinde "${hit.kw}" geçiyor)` : hit.unsure ? `${f.name}: metinde sadece "${hit.unsure}" geçiyor` : `${f.name} ilanda geçmiyor`;
      const d = man[key];
      if (typeof d === 'boolean') {
        const by = manualBy(l, key);
        feats.push({ key, name: f.name, ok: d, by, via: `${by ? by + ' kontrol etti' : 'senin kontrolün'}: ${d ? 'var' : 'yok'}` });
        ask(key, label, 'Var', 'Yok', `${f.name}: yok`);
      } else if (hit.kw) {
        feats.push({ key, name: f.name, ok: true, via: `metin: "${hit.kw}"` });
      } else {
        feats.push({ key, name: f.name, ok: null, via: hit.unsure ? `metinde sadece "${hit.unsure}" geçiyor, emin değilim` : 'ilanda geçmiyor' });
        ask(key, label, 'Var', 'Yok', `${f.name}: yok`);
      }
    }
    const status = fails.length ? 'elendi' : unknowns.length ? 'belirsiz' : 'gecti';
    return { status, fails, unknowns, decided, feats };
  }

  // Donanım metinde geçiyor mu? { kw } kesin, { unsure } sadece belirsiz bir ifadenin içinde (ör. "yarı hayalet"), {} yok
  function findFeature(corpus, f) {
    let clean = corpus;
    for (const u of (f.unsureKeywords || []).map(fold).filter(Boolean)) {
      clean = clean.replace(new RegExp('(^|[^a-z0-9])' + escapeRe(u) + '(?=$|[^a-z0-9])', 'g'), '$1 ');
    }
    const kw = findKeyword(clean, f.keywords);
    if (kw) return { kw };
    const unsure = findKeyword(corpus, f.unsureKeywords);
    return unsure && findKeyword(corpus, f.keywords) ? { unsure } : {};
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
      if (typeof m !== 'boolean') return null;
      const by = manualBy(l, 'crit:' + id);
      return { met: m, manual: true, by, via: `${by ? by + ' kontrol etti' : 'senin kontrolün'}: ${m ? 'var' : 'yok'}` };
    };
    const visionBy = (l._aiBy && l._aiBy.vision) || {};
    for (const c of crit.filter((c) => !c.allOf)) {
      const o = override(c.id);
      if (o) { res[c.id] = o; continue; }
      const kw = findKeyword(corpus, c.keywords);
      // Soru ya da örnek fotoğraf değiştiyse eski sonuç sayılmaz, yeniden analiz bekler
      const v = vision[c.id] && vision[c.id].question === visionKey(c) ? vision[c.id] : null;
      const vTxt = v ? (v.result == null ? 'fotoğraflarda görülemedi, kendin bak' : `fotoğraf (${v.yes} evet / ${v.no} hayır)`) + (visionBy[c.id] ? ' · ' + visionBy[c.id] : '') : null;
      if (kw) res[c.id] = { met: true, via: `metin: "${kw}"` };
      else if (v && v.result === true) res[c.id] = { met: true, via: vTxt };
      else if (c.vision && !v) res[c.id] = { met: false, pending: true, via: 'fotoğraf analizi bekliyor' };
      else res[c.id] = { met: false, via: vTxt };
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

  // Ana renk: "Gri (Gümüş)", "gri metalik" → "gri" (karşılaştırma anahtarı) ve "Gri" (görünen ad)
  function colorOf(l) {
    const key = Object.keys((l && l.info) || {}).find((k) => fold(k) === 'renk');
    const raw = key ? String(l.info[key]).replace(/\(.*?\)/g, ' ').trim().split(/\s+/)[0] || '' : '';
    return raw ? { key: fold(raw), name: raw.charAt(0).toLocaleUpperCase('tr') + raw.slice(1).toLocaleLowerCase('tr') } : null;
  }
  const colorPoints = (cfg, key) => ((cfg.scoring.colors || []).find((c) => fold(c.name) === key) || {}).points || 0;

  // best değerde tam puan, worst değerde 0, arası doğrusal (km ve fiyatta düşük, yılda yüksek iyidir; yön fark etmez)
  function rangeScore(v, c) {
    if (v == null || !c || !c.points || c.best === c.worst) return 0;
    return c.points * Math.max(0, Math.min(1, (v - c.worst) / (c.best - c.worst)));
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
      ...(s.price && s.price.points > 0
        ? [{ name: 'Fiyat', points: rangeScore(l.price, s.price), max: s.price.points, via: l.price == null ? 'okunamadı' : `${fmtTL(l.price)} (${fmtTL(s.price.best)} ve altı tam puan, ${fmtTL(s.price.worst)} ve üstü 0)` }]
        : []),
      ...(s.year && s.year.points > 0
        ? [{ name: 'Model yılı', points: rangeScore(l.year, s.year), max: s.year.points, via: l.year == null ? 'okunamadı' : `${l.year} (${s.year.best} ve sonrası tam puan, ${s.year.worst} ve öncesi 0)` }]
        : []),
      ...((s.colors || []).some((c) => c.points > 0)
        ? (() => {
          const col = colorOf(l);
          return [{ name: 'Renk', points: col ? colorPoints(cfg, col.key) : 0, max: Math.max(...s.colors.map((c) => c.points || 0)), via: col ? col.name : 'okunamadı' }];
        })()
        : []),
      ...(s.criteria || []).filter((c) => c.points > 0).map((c) => ({
        name: c.name, points: crit[c.id].met ? c.points : 0, max: c.points, via: crit[c.id].via, pending: crit[c.id].pending,
        // Metinde birebir geçen kriterde sorulacak bir şey yok; gerisini elle doğrulayabilirsin.
        key: `crit:${c.id}`, met: crit[c.id].met, manual: crit[c.id].manual, manualBy: crit[c.id].by || null,
        askable: !String(crit[c.id].via || '').startsWith('metin:'),
      })),
    ];
    const total = lines.reduce((a, x) => a + x.points, 0);
    const max = lines.reduce((a, x) => a + x.max, 0);
    return { total, max, lines, crit, tramer };
  }

  // ---------------------------------------------------------------------------
  // Ortak veri: aynı ilanın kopyalarını birleştirme
  // ---------------------------------------------------------------------------
  // Anahtar sırası sabit JSON: iki bilgisayar aynı ilanı aynı metne çevirsin ki gereksiz yere gönderilmesin.
  // '_' ile başlayan alanlar sadece ekranda gösterim içindir, saklanmaz.
  function stableStringify(x) {
    const norm = (v) => {
      if (Array.isArray(v)) return v.map(norm);
      if (v && typeof v === 'object') {
        const o = {};
        for (const k of Object.keys(v).sort()) if (v[k] !== undefined && !k.startsWith('_')) o[k] = norm(v[k]);
        return o;
      }
      return v;
    };
    return JSON.stringify(norm(x), null, 1) + '\n';
  }

  // İki sürümden puanı yüksek olanı seç; eşitlikte içeriğe göre sabit seçim yap
  // (yoksa iki bilgisayar her eşitlemede birbirinin sürümünü ezip durur).
  function better(u, v, score) {
    if (!u) return v;
    if (!v) return u;
    const su = score(u), sv = score(v);
    if (su !== sv) return sv > su ? v : u;
    return stableStringify(v) > stableStringify(u) ? v : u;
  }

  function mergeManual(a, b) {
    const out = {};
    for (const src of [a || {}, b || {}]) {
      for (const [k, x] of Object.entries(src)) out[k] = better(manualEntry(out[k]), manualEntry(x), (e) => e.at || 0);
    }
    return Object.keys(out).length ? out : undefined;
  }

  function mergeAI(a, b) {
    if (!a || !b) return a || b;
    const vision = {};
    for (const src of [a.vision || {}, b.vision || {}]) {
      for (const [id, v] of Object.entries(src)) vision[id] = better(vision[id], v, (x) => (x.at || 0) * 1000 + (x.yes || 0) + (x.no || 0));
    }
    const out = { ...a, ...b };
    out.vision = Object.keys(vision).length ? vision : undefined;
    out.text = better(a.text, b.text, (t) => (t.error ? 0 : 1e15) + (t.at || 0));
    out.photos = better(a.photos, b.photos, (p) => p.at || 0);
    return out;
  }

  // Aynı kişinin iki bilgisayarındaki kopyası: en son görülen ilan bilgisi, birleşik fiyat geçmişi,
  // kriter başına en yeni analiz ve en yeni elle karar.
  function mergeSame(a, b) {
    if (!a || !b) return a || b;
    const newer = better(a, b, (x) => x.lastSeen || 0);
    const older = newer === a ? b : a;
    const hist = [...(a.priceHistory || []), ...(b.priceHistory || [])].sort((x, y) => (x.at || 0) - (y.at || 0) || x.price - y.price);
    const firsts = [a.firstSeen, b.firstSeen].filter((x) => x != null);
    return {
      ...older,
      ...newer,
      firstSeen: firsts.length ? Math.min(...firsts) : undefined,
      lastSeen: Math.max(a.lastSeen || 0, b.lastSeen || 0) || undefined,
      priceHistory: hist.filter((p, i) => i === 0 || p.price !== hist[i - 1].price),
      ai: mergeAI(a.ai, b.ai),
      manual: mergeManual(a.manual, b.manual),
      track: mergeManual(a.track, b.track), // aynı { v, at } biçimi: alan başına en yeni
    };
  }

  function aiOwners(ai, user) {
    const by = { vision: {} };
    if (!ai) return by;
    for (const id of Object.keys(ai.vision || {})) by.vision[id] = user;
    if (ai.text) by.text = user;
    if (ai.photos) by.photos = user;
    return by;
  }

  // Başka bir kişinin kopyasını ekrandaki görünüme kat. Senin kopyan (base) varsa o esastır,
  // sende olmayan elle kararlar ve analizler onunkinden tamamlanır ve kimden geldiği işaretlenir.
  function combineOther(base, o, user) {
    if (!base) {
      const c = JSON.parse(JSON.stringify(o));
      c._owner = user;
      c._manualBy = {};
      for (const [k, x] of Object.entries(c.manual || {})) {
        const e = manualEntry(x);
        if (e && typeof e.v === 'boolean') c._manualBy[k] = user;
      }
      c._aiBy = aiOwners(c.ai, user);
      const t = trackOf(c);
      if (t.status || t.note) c._trackBy = user;
      return c;
    }
    const by = base._aiBy || {};
    const c = { ...base, _manualBy: { ...(base._manualBy || {}) }, _aiBy: { ...by, vision: { ...(by.vision || {}) } } };
    const man = { ...(base.manual || {}) };
    for (const [k, x] of Object.entries(o.manual || {})) {
      const e = manualEntry(x), cur = manualEntry(man[k]);
      if (!e || typeof e.v !== 'boolean' || (cur && typeof cur.v === 'boolean')) continue;
      man[k] = e;
      c._manualBy[k] = user;
    }
    c.manual = man;
    const ai = { ...(base.ai || {}) };
    const oa = o.ai || {};
    for (const [id, v] of Object.entries(oa.vision || {})) {
      if (ai.vision && ai.vision[id]) continue;
      ai.vision = { ...(ai.vision || {}), [id]: v };
      c._aiBy.vision[id] = user;
    }
    if ((!ai.text || ai.text.error) && oa.text && !oa.text.error) { ai.text = oa.text; c._aiBy.text = user; }
    if (!ai.photos && oa.photos) { ai.photos = oa.photos; c._aiBy.photos = user; }
    c.ai = ai;
    const mine = trackOf(base), theirs = trackOf(o);
    if (!mine.status && !mine.note && !base._trackBy && (theirs.status || theirs.note)) {
      c.track = o.track;
      c._trackBy = user;
    }
    return c;
  }

  // Başkasının ilanında bir şeyi değiştirdiğinde onunkine dokunulmaz: ilan bilgisi senin kopyan olur.
  // Onun kararları, analizleri, durumu ve notu kopyaya seninmiş gibi geçmez; combineOther onları
  // bir sonraki görünümde adıyla yine ekler (onu dahil ettiğin sürece).
  function ownCopyOf(view) {
    const c = JSON.parse(stableStringify(view));
    if (view._owner) c.copiedFrom = view._owner;
    for (const k of Object.keys(view._manualBy || {})) if (c.manual) delete c.manual[k];
    if (c.manual && !Object.keys(c.manual).length) delete c.manual;
    if (view._trackBy) delete c.track;
    const aiBy = view._aiBy || {};
    if (c.ai) {
      for (const id of Object.keys(aiBy.vision || {})) if (c.ai.vision) delete c.ai.vision[id];
      if (c.ai.vision && !Object.keys(c.ai.vision).length) delete c.ai.vision;
      if (aiBy.text) delete c.ai.text;
      if (aiBy.photos) delete c.ai.photos;
      if (!Object.keys(c.ai).length) delete c.ai;
    }
    return c;
  }

  // ---------------------------------------------------------------------------
  // Fotoğraf analizi: oylama ve doğruluk
  // ---------------------------------------------------------------------------
  // Model her fotoğrafın türünü de söyler. Kriterin views listesi varsa oy sadece o türdeki
  // fotoğraflardan sayılır: kırmızı bir aracın dış fotoğrafı "kırmızı koltuk" oyu veremez.
  const VIEWS = ['exterior_front', 'exterior_rear', 'exterior_side', 'interior', 'wheel', 'other'];
  const VIEW_LABELS = { exterior_front: 'ön', exterior_rear: 'arka', exterior_side: 'yan', interior: 'iç mekân', wheel: 'jant', other: 'diğer' };

  // Bir fotoğrafın cevabını oylara ekler, fotoğrafın türünü döner (anlaşılmadıysa null)
  function countPhotoAnswer(votes, ans, todo) {
    const view = ans && VIEWS.includes(ans.view) ? ans.view : null;
    for (const c of todo) {
      const a = ans && ans[c.id];
      if (!a || typeof a !== 'object' || a.visible !== true) continue;
      if (view && Array.isArray(c.views) && c.views.length && !c.views.includes(view)) continue;
      if (a.answer === true) votes[c.id].yes++;
      else if (a.answer === false) votes[c.id].no++;
    }
    return view;
  }

  // Görsel kriterin "sorusu": soru metni + örnek fotoğraflar. Biri değişirse eski fotoğraf sonuçları geçersiz olur.
  const visionKey = (c) => String(c.vision || '') + ((c.referenceImages || []).length ? ` [örnek: ${c.referenceImages.join(' ')}]` : '');

  // Sonuç: en az bir "evet" ve oyların en az %25'i. İnce ayrımlarda (jant) özellik sadece birkaç fotoğrafta
  // seçilebiliyor, diğerleri "hayır" diyor; çoğunluk kuralı gerçek pozitifleri kaçırıyordu (gerçek veriyle ölçüldü).
  const voteResult = (v) => (v.yes + v.no === 0 ? null : v.yes >= 1 && v.yes * 3 >= v.no);
  // Yeterince net mi? Öyleyse kalan fotoğraflara bakmaya gerek yok. "Hayır" için daha çok kanıt gerekir.
  const voteDecided = (v) => (v.yes >= 2 && v.yes > 2 * v.no) || (v.no >= 5 && v.yes === 0);

  // Fotoğraf sırası: galerinin başı, ortası, çeyrekleri… İlk birkaç fotoğraf hep aynı açıdan
  // (genelde ön) olduğu için sırayla gitmek yerine galeriyi baştan yayarak örnekler.
  function spreadOrder(n) {
    if (n <= 0) return [];
    const out = [0];
    const seen = new Set(out);
    let segs = [[0, n]];
    while (segs.length) {
      const next = [];
      for (const [a, b] of segs) {
        const m = Math.floor((a + b) / 2);
        if (!seen.has(m)) { seen.add(m); out.push(m); }
        if (m - a > 1) next.push([a, m]);
        if (b - m > 1) next.push([m, b]);
      }
      segs = next;
    }
    for (let i = 0; i < n; i++) if (!seen.has(i)) out.push(i);
    return out;
  }

  // Yerel AI'ın isabeti: Var/Yok ile elle verdiğin kararları gerçek cevap sayar, aynı soruya
  // fotoğraf analizinin verdiği cevapla karşılaştırır. Sadece senin kararların ve güncel soru sayılır.
  function visionAccuracy(listings, cfg) {
    const out = {};
    for (const c of (cfg.scoring.criteria || []).filter((x) => x.vision)) out[c.id] = { id: c.id, name: c.name, n: 0, agree: 0, wrongYes: [], wrongNo: [], noAnswer: 0 };
    for (const l of Object.values(listings)) {
      if (!l || l._owner) continue;
      const man = manualOf(l);
      const vis = (l.ai && l.ai.vision) || {};
      for (const c of (cfg.scoring.criteria || []).filter((x) => x.vision)) {
        const m = man['crit:' + c.id];
        const v = vis[c.id];
        if (typeof m !== 'boolean' || manualBy(l, 'crit:' + c.id) || !v || v.question !== visionKey(c)) continue;
        const o = out[c.id];
        if (v.result == null) { o.noAnswer++; continue; }
        o.n++;
        if (v.result === m) o.agree++;
        else (v.result ? o.wrongYes : o.wrongNo).push({ id: l.id, title: l.title, url: l.url, yes: v.yes, no: v.no });
      }
    }
    return out;
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
    const open = rows.filter((r) => !isClosed(r.l));
    // Takip listesi: ilerlemiş olan (teklif > ekspertiz > arandı > takipte) önce
    const stage = (r) => STATUSES.findIndex((x) => x.id === trackOf(r.l).status);
    return {
      model,
      passed: open.filter((r) => r.hard.status === 'gecti').sort(byScore),
      unsure: open.filter((r) => r.hard.status === 'belirsiz').sort(byScore),
      rejected: open.filter((r) => r.hard.status === 'elendi'),
      tracked: open.filter((r) => trackOf(r.l).status && !trackOf(r.l).by).sort((a, b) => stage(b) - stage(a) || byScore(a, b)),
      closed: rows.filter((r) => isClosed(r.l)),
      all: rows,
    };
  }

  // ---------------------------------------------------------------------------
  // Arama ve özellik filtresi: "kırmızı koltuk + Shadow + 50.000 km altı" gibi
  // ---------------------------------------------------------------------------
  // filter: { q, has: { 'crit:kirmizi': true, 'feat:Hayalet gösterge (HUD)': false, ... }, kmMax, priceMax, yearMin, color, withRejected }
  // has: true "var olsun" (metinden, fotoğraftan ya da senin kararınla kesin var), false "olmasın" (kesin var olanları çıkar).
  // Fotoğraf analizi bekleyen ya da doğrulanamayan özellik "var" sayılmaz.
  const EMPTY_FILTER = { q: '', has: {}, kmMax: null, priceMax: null, yearMin: null, color: '', withRejected: false };

  // Filtrelenebilecek özellikler: olması gereken donanımlar (HUD) ve bütün kriterler (puanı 0 olanlar dahil)
  function filterFacets(cfg) {
    return [
      ...(cfg.hardFilters.requiredFeatures || []).map((f) => ({ key: `feat:${f.name}`, name: f.name })),
      ...(cfg.scoring.criteria || []).map((c) => ({ key: `crit:${c.id}`, name: c.name })),
    ];
  }

  // Satırda özellik var mı: true, false ya da null (bilinmiyor / analiz bekliyor)
  function rowHas(r, key) {
    if (key.startsWith('crit:')) {
      const c = r.score.crit[key.slice(5)];
      if (!c) return null;
      return c.met ? true : c.pending ? null : false;
    }
    if (key.startsWith('feat:')) {
      const f = (r.hard.feats || []).find((x) => x.key === key);
      return f ? f.ok : null;
    }
    return null;
  }

  const filterActive = (f) =>
    !!f && (!!String(f.q || '').trim() || Object.keys(f.has || {}).length > 0 || f.kmMax != null || f.priceMax != null || f.yearMin != null || !!f.color);

  function matchFilter(r, f) {
    const l = r.l;
    const words = fold(f.q || '').split(' ').filter(Boolean);
    if (words.length) {
      const text = corpusOf(l) + ' . ' + fold(trackOf(l).note);
      if (!words.every((w) => text.includes(w))) return false;
    }
    for (const [key, want] of Object.entries(f.has || {})) {
      const v = rowHas(r, key);
      if (want === true && v !== true) return false;
      if (want === false && v === true) return false;
    }
    if (f.kmMax != null && !(l.km != null && l.km <= f.kmMax)) return false;
    if (f.priceMax != null && !(l.price != null && l.price <= f.priceMax)) return false;
    if (f.yearMin != null && !(l.year != null && l.year >= f.yearMin)) return false;
    if (f.color && (colorOf(l) || {}).key !== f.color) return false;
    return true;
  }

  // Filtrenin bakacağı ilanlar: açık olanlar (geçen + doğrulanamayan, istenirse elenenler), puana göre
  function filterBase(result, f) {
    const byScore = (a, b) => b.score.total - a.score.total;
    return [...result.passed, ...result.unsure, ...(f && f.withRejected ? result.rejected : [])].sort(byScore);
  }

  const applyFilter = (result, f) => filterBase(result, f).filter((r) => matchFilter(r, f));

  // Her özellik düğmesinde: o özellik de "var olsun" denirse kaç ilan kalır (diğer seçimler aynen)
  function facetCounts(result, f, cfg) {
    const base = filterBase(result, f);
    const out = {};
    for (const x of filterFacets(cfg)) {
      const g = { ...f, has: { ...(f.has || {}), [x.key]: true } };
      out[x.key] = base.filter((r) => matchFilter(r, g)).length;
    }
    return out;
  }

  // Arama listesindeki rozet: kayıtlı ilanın durumu tek bakışta. dim: satır soluk gösterilsin (elenmiş ya da kapanmış).
  // delta: ilk görüldüğü fiyattan bu yana değişim (TL, düşüş negatif).
  function listBadge(l, cfg) {
    const t = trackOf(l);
    const hist = l.priceHistory || [];
    const first = hist.length ? hist[0].price : null;
    const delta = first && l.price && first !== l.price ? l.price - first : 0;
    const priceNote = delta ? `Fiyat: ${fmtTL(first)} → ${fmtTL(l.price)}` : '';
    const note = t.note ? `${t.by ? t.by + ' notu' : 'Not'}: ${t.note}` : '';
    if (isClosed(l)) return { tone: 'muted', text: statusInfo(t.status).label, dim: true, delta, title: [note, priceNote].filter(Boolean).join('\n') };
    const hard = evalHard(l, cfg);
    const sc = scoreListing(l, cfg);
    const pts = `${Math.round(sc.total)}/${sc.max}`;
    const st = t.status && !t.by ? ` · ${statusInfo(t.status).label}` : '';
    let b;
    if (hard.status === 'gecti') b = { tone: 'good', text: `✓ ${pts}`, why: '' };
    else if (hard.status === 'belirsiz') b = { tone: 'warn', text: `? ${pts}`, why: 'Doğrulanamayan: ' + hard.unknowns.map((u) => u.label).join(', ') };
    else b = { tone: 'bad', text: `✗ ${hard.fails[0]}${hard.fails.length > 1 ? ` +${hard.fails.length - 1}` : ''}`, why: 'Elendi: ' + hard.fails.join(', '), dim: true };
    return { tone: b.tone, text: b.text + st, dim: !!b.dim, delta, title: [b.why, note, priceNote].filter(Boolean).join('\n') };
  }

  // ---------------------------------------------------------------------------
  // Tersten puanlama: senin sıralamanı en iyi açıklayan puanlar
  // ---------------------------------------------------------------------------
  // Puan, bileşen puanlarının toplamı: Σ ağırlık × özellik (0..1). Senin sıralamandaki her ikili (üstteki > alttaki)
  // bir kısıt; ağırlıklar bu ikililere en çok uyacak şekilde bulunur. Ağırlıklar negatif olmaz, toplam puan aynı kalır,
  // tramer basamaklarında az tramer hiçbir zaman daha az puan almaz. Sıraladığın ilanlarda fark yaratmayan bir
  // bileşen (ör. hepsi M Sport) şimdiki değerine yakın kalır.
  const getIn = (o, p) => p.reduce((x, k) => (x == null ? x : x[k]), o);
  function setIn(o, p, v) {
    const parent = getIn(o, p.slice(0, -1));
    if (parent) parent[p[p.length - 1]] = v;
  }
  const clone = (x) => JSON.parse(JSON.stringify(x));

  function calibComponents(cfg) {
    const s = cfg.scoring;
    const comps = [
      { key: 'km', label: 'KM', path: ['scoring', 'km', 'points'] },
      { key: 'tramer0', label: 'Tramer kaydı yok', path: ['scoring', 'tramer', 'noRecordPoints'] },
    ];
    (s.tramer.tiers || []).forEach((t, i) => comps.push({ key: 'tier' + i, label: `Tramer ${fmtNum(t.below)} TL altı`, path: ['scoring', 'tramer', 'tiers', i, 'points'], tier: i }));
    comps.push({ key: 'price', label: 'Fiyat', path: ['scoring', 'price', 'points'] });
    comps.push({ key: 'year', label: 'Model yılı', path: ['scoring', 'year', 'points'] });
    (s.colors || []).forEach((c, i) => comps.push({ key: 'color:' + fold(c.name), label: `Renk: ${c.name}`, path: ['scoring', 'colors', i, 'points'], color: fold(c.name) }));
    (s.criteria || []).forEach((c, i) => comps.push({ key: 'crit:' + c.id, label: c.name, path: ['scoring', 'criteria', i, 'points'], crit: c.id }));
    return comps;
  }

  // İlanın her bileşende aldığı pay (0..1): puan = Σ ağırlık × pay
  function calibFeatures(l, cfg, comps) {
    const s = cfg.scoring;
    const crit = evalCriteria(l, cfg);
    const tr = parseTramer(l).amount;
    const tierIdx = tr == null || tr === 0 ? -1 : (s.tramer.tiers || []).findIndex((t) => tr < t.below);
    return comps.map((c) => {
      if (c.key === 'km') return kmScore(l.km, { ...s.km, points: 1 });
      if (c.key === 'tramer0') return tr === 0 ? 1 : 0;
      if (c.tier !== undefined) return tierIdx === c.tier ? 1 : 0;
      if (c.key === 'price') return rangeScore(l.price, { ...s.price, points: 1 });
      if (c.key === 'year') return rangeScore(l.year, { ...s.year, points: 1 });
      if (c.color) return (colorOf(l) || {}).key === c.color ? 1 : 0;
      if (c.crit) return crit[c.crit] && crit[c.crit].met ? 1 : 0;
      return 0;
    });
  }

  // Toplam puan: tramer basamakları "kayıt yok"tan fazla olamaz, sayılmaz; bir aracın tek rengi olduğu için
  // renklerden sadece en yükseği sayılır
  function maxTotal(w, comps) {
    let t = 0, col = 0;
    w.forEach((v, i) => {
      if (comps[i].tier !== undefined) return;
      if (comps[i].color) col = Math.max(col, v);
      else t += v;
    });
    return t + col;
  }

  // "Önemli" işaretlediğin bileşenler (varsayılan: model yılı ve fiyat) toplam puanın en az bu payını alır; kalan puan
  // sıralamandan öğrenilir. Az ilanla sıralama, yılın ya da fiyatın ne kadar önemli olduğunu tek başına söyleyemeyebiliyor
  // (ör. en yeni araç tramer yüzünden en altta; fiyat yıl, km ve donanımla iç içe): o belirsizlikte bileşen eski değerine
  // (0) yakın kalıyordu. Gerçek 10 ilanlık bir sıralamada ham fiyat da piyasaya göre fiyat da tek başına ~0,5 uyum
  // verdi; fiyatı önemli saymak uyumu düşürmedi (35/45 her iki durumda).
  const IMPORTANT_DEFAULT = ['year', 'price'];
  const IMPORTANT_SHARE = 0.1;
  const importantOf = (cfg) => (cfg.calibration && Array.isArray(cfg.calibration.important) ? cfg.calibration.important : IMPORTANT_DEFAULT);
  // Tramer ve renkler işaretlenemez: tramer basamakları ve "renklerden sadece en yükseği" kuralı alt sınırla karışır
  const floorable = (c) => c.key === 'km' || c.key === 'price' || c.key === 'year' || !!c.crit;

  // floors: bileşen başına alt sınır (puan). Alt sınırın üstündeki kısım ≥ 0, tramer basamakları monoton,
  // toplam puan S'de sabit.
  function projectWeights(w, comps, S, floors) {
    const f = (i) => (floors && floors[i]) || 0;
    const out = w.map((v, i) => Math.max(0, v - f(i)));
    const t0 = comps.findIndex((c) => c.key === 'tramer0');
    let prev = t0 >= 0 ? out[t0] : Infinity;
    comps.forEach((c, i) => {
      if (c.tier === undefined) return;
      out[i] = Math.min(out[i], prev);
      prev = out[i];
    });
    const room = Math.max(0, S - maxTotal(comps.map((c, i) => f(i)), comps));
    const tot = maxTotal(out, comps);
    return out.map((v, i) => (tot > 0 ? (v * room) / tot : v) + f(i));
  }

  // Sıralama için lojistik kayıp + şimdiki ağırlıklara hafif çekim, izdüşümlü gradyan inişi
  function fitWeights(X, w0, comps, S, iters = 400, floors = null) {
    const D = [];
    for (let i = 0; i < X.length; i++) for (let j = i + 1; j < X.length; j++) D.push(X[i].map((v, t) => v - X[j][t]));
    const wPrior = projectWeights(w0, comps, S, floors);
    if (!D.length) return wPrior;
    const k = w0.length;
    const kappa = 20 / S;
    const lambda = 0.05 / (S * S); // sadece sıralamanın bir şey söylemediği yönlerde hissedilir
    let w = wPrior.slice();
    let lr = S * 0.3;
    for (let it = 0; it < iters; it++) {
      const g = new Array(k).fill(0);
      for (const d of D) {
        let m = 0;
        for (let t = 0; t < k; t++) m += w[t] * d[t];
        const sg = 1 / (1 + Math.exp(Math.min(50, kappa * m)));
        for (let t = 0; t < k; t++) g[t] -= (kappa * sg * d[t]) / D.length;
      }
      for (let t = 0; t < k; t++) g[t] += 2 * lambda * (w[t] - wPrior[t]);
      w = projectWeights(w.map((v, t) => v - lr * g[t]), comps, S, floors);
      lr *= 0.993;
    }
    return w;
  }

  // Sıralamadaki ikililerin kaçında puan da aynı sırayı veriyor (eşitlik yarım sayılır)
  function pairAgreement(ranked, scoreOf) {
    const sc = ranked.map(scoreOf);
    let ok = 0, n = 0;
    for (let i = 0; i < sc.length; i++) {
      for (let j = i + 1; j < sc.length; j++) {
        n++;
        ok += sc[i] > sc[j] + 1e-9 ? 1 : Math.abs(sc[i] - sc[j]) <= 1e-9 ? 0.5 : 0;
      }
    }
    return n ? ok / n : null;
  }

  // listings: { id: ilan }, order: senin sıraladığın ilan id'leri (en iyi önce)
  // opts.important: "önemli" bileşen anahtarları (verilmezse ayardaki liste, o da yoksa model yılı)
  function calibrate(listings, order, cfg, opts = {}) {
    const ranked = (order || []).map((id) => listings[id]).filter(Boolean);
    if (ranked.length < 3) return null;
    const base = clone(cfg);
    const s = base.scoring;
    const important = opts.important || importantOf(cfg);
    // Fiyat ve yıl henüz puan almıyorsa aralığı sıraladığın ilanlardan al (en ucuz/en yeni tam puan, en pahalı/en eski 0):
    // varsayılan 2020–2024 aralığında 2020–2023 ilanlar arasındaki fark puana küçük yansıyordu
    const range = (f, lowIsBest) => {
      const v = ranked.map(f).filter((x) => typeof x === 'number' && isFinite(x));
      if (!v.length) return { points: 0, best: 0, worst: 0 };
      return lowIsBest ? { points: 0, best: Math.min(...v), worst: Math.max(...v) } : { points: 0, best: Math.max(...v), worst: Math.min(...v) };
    };
    if (!s.price || !s.price.points) s.price = range((l) => l.price, true);
    if (!s.year || !s.year.points) s.year = range((l) => l.year, false);
    // Sıraladığın ilanlarda geçen renkler (henüz puanı olmayanlar 0 ile eklenir)
    s.colors = (s.colors || []).slice();
    const colorCount = {};
    for (const l of ranked) {
      const col = colorOf(l);
      if (!col) continue;
      colorCount[col.key] = (colorCount[col.key] || 0) + 1;
      if (!s.colors.some((c) => fold(c.name) === col.key)) s.colors.push({ name: col.name, points: 0 });
    }
    const comps = calibComponents(base);
    const w0 = comps.map((c) => Number(getIn(base, c.path)) || 0);
    const S = maxTotal(w0, comps) || 100;
    const agree = (c) => pairAgreement(ranked, (l) => scoreListing(l, c).total);
    const before = agree(cfg);
    const uniq = (a) => [...new Set(a)];
    let best = null;
    for (const bk of uniq([s.km.bestKm, 0, 20000, 40000])) {
      for (const wk of uniq([s.km.worstKm, 100000, 125000, 150000, 200000])) {
        if (bk >= wk) continue;
        const c2 = clone(base);
        c2.scoring.km.bestKm = bk;
        c2.scoring.km.worstKm = wk;
        const X = ranked.map((l) => calibFeatures(l, c2, comps));
        // Sıraladığın ilanlarda hiç fark yaratmayan bileşen (ör. hiçbirinde Shadow yok) hakkında sıralaman bir şey
        // söylemiyor: şimdiki değerinde kalır, toplam puan sadece bilgi çıkan bileşenler arasında yeniden dağıtılır.
        // Tramer kaydı yok ve basamakları birlikte serbest ya da birlikte sabit.
        const varies = comps.map((c, i) => X.some((x) => Math.abs(x[i] - X[0][i]) > 1e-9));
        const tramerFree = comps.some((c, i) => (c.key === 'tramer0' || c.tier !== undefined) && varies[i]);
        // Bir renk ancak sıraladığın ilanlarda en az 2 kez geçiyorsa öğrenilir (tek ilanın yeri renge yüklenmesin)
        const free = comps.map((c, i) => (c.key === 'tramer0' || c.tier !== undefined ? tramerFree : c.color ? varies[i] && (colorCount[c.color] || 0) >= 2 : varies[i]));
        const idx = comps.map((c, i) => i).filter((i) => free[i]);
        const fixedTotal = maxTotal(w0.map((v, i) => (free[i] ? 0 : v)), comps);
        // Önemli bileşenlere alt sınır; hepsi birden serbest puanın %60'ını geçmesin
        const room = S - fixedTotal;
        let fl = idx.map((i) => (important.includes(comps[i].key) && floorable(comps[i]) ? Math.round(IMPORTANT_SHARE * S) : 0));
        const flSum = fl.reduce((a, b) => a + b, 0);
        if (flSum > 0.6 * room) fl = fl.map((v) => (v * 0.6 * room) / flSum);
        const w = w0.slice();
        if (idx.length && room > 0) {
          const wf = fitWeights(X.map((x) => idx.map((i) => x[i])), idx.map((i) => w0[i]), idx.map((i) => comps[i]), room, 400, fl);
          idx.forEach((i, j) => { w[i] = wf[j]; });
        }
        comps.forEach((c, i) => setIn(c2, c.path, Math.round(w[i])));
        const a = agree(c2);
        const dist = Math.abs(bk - s.km.bestKm) + Math.abs(wk - s.km.worstKm);
        if (!best || a > best.after + 1e-9 || (Math.abs(a - best.after) <= 1e-9 && dist < best.dist)) best = { cfg: c2, after: a, dist, free };
      }
    }
    const changes = comps
      .map((c) => ({ label: c.label, from: c.color ? colorPoints(cfg, c.color) : Number(getIn(cfg, c.path)) || 0, to: getIn(best.cfg, c.path), important: important.includes(c.key) }))
      .concat([
        { label: 'KM tam puan sınırı', from: cfg.scoring.km.bestKm, to: best.cfg.scoring.km.bestKm, km: true },
        { label: 'KM sıfır puan sınırı', from: cfg.scoring.km.worstKm, to: best.cfg.scoring.km.worstKm, km: true },
      ]);
    // Önemli işaretlenen ama sıraladığın ilanlarda hiç fark yaratmayan (ör. hepsi aynı yıl) bileşen öğrenilemez
    const imp = comps
      .map((c, i) => ({ key: c.key, label: c.label, learned: !!best.free[i], points: getIn(best.cfg, c.path) }))
      .filter((x) => important.includes(x.key));
    return { suggested: best.cfg, before, after: best.after, n: ranked.length, pairs: (ranked.length * (ranked.length - 1)) / 2, changes, important: imp, floor: Math.round(IMPORTANT_SHARE * S) };
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
    if (s.price && s.price.points > 0) lines.push(`Fiyat: ${s.price.points} puan (${fmtTL(s.price.best)} ve altı tam puan, ${fmtTL(s.price.worst)} ve üstü 0)`);
    if (s.year && s.year.points > 0) lines.push(`Model yılı: ${s.year.points} puan (${s.year.best} ve sonrası tam puan, ${s.year.worst} ve öncesi 0)`);
    const cols = (s.colors || []).filter((c) => c.points > 0);
    if (cols.length) lines.push(`Renk tercihi: ${cols.map((c) => `${c.name} ${c.points}`).join(', ')} puan (diğer renkler 0)`);
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
    if (r.hard.decided.length) out.push(`Elle kontrol edilenler: ${r.hard.decided.map((d) => `${d.label} → ${d.ok ? 'var/uygun' : 'yok/uygun değil'}${d.by ? ` (${d.by} kontrol etti)` : ''}`).join('; ')}`);
    if (r.flags.length) out.push(`Uyarılar: ${r.flags.join('; ')}`);
    const tr = trackOf(l);
    if (tr.status || tr.note) {
      const who = tr.by ? `${tr.by} adlı arkadaşımın takibi` : 'Benim takibim';
      out.push(`${who}: ${[tr.status ? statusInfo(tr.status).label : '', tr.note ? `not: ${tr.note.replace(/\s+/g, ' ').slice(0, 300)}` : ''].filter(Boolean).join(' · ')}`);
    }
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

  function comparePrompt(rows, cfg) {
    return [
      "Sahibinden.com'da ikinci el araç arıyorum ve aşağıdaki ilanlar arasında karar vermeye çalışıyorum.",
      '',
      'KRİTERLERİM',
      configSummary(cfg),
      '',
      'Senden istediğim:',
      '1. Bu araçları madde madde karşılaştır: fiyat/değer, km ve yaş, hasar ve boya geçmişi, donanım, risk.',
      '2. Hangisini neden seçmem gerektiğini ve hangi koşulda fikrimin değişmesi gerektiğini yaz.',
      '3. Notlarımda yazanları da hesaba kat. Bilmediğin bir şeyi kesinmiş gibi yazma.',
      '',
      `KARŞILAŞTIRILAN İLANLAR (${rows.length})`,
      ...rows.map((r, i) => rowSummary(r, i) + '\n'),
    ].join('\n');
  }

  // ---------------------------------------------------------------------------
  // Buradan sonrası tarayıcıya özel
  // ---------------------------------------------------------------------------
  const CORE = {
    DEFAULT_CONFIG, fold, findKeyword, parseTramer, evalHard, evalCriteria, kmScore, tramerScore, scoreListing, ruleFlags, marketModel, computeRows, claudePrompt,
    stableStringify, mergeSame, combineOther, ownCopyOf, manualOf, STATUSES, trackOf, comparePrompt,
    countPhotoAnswer, voteDecided, voteResult, spreadOrder, visionAccuracy, listBadge, visionKey,
    rangeScore, calibrate, pairAgreement, colorOf, importantOf,
    EMPTY_FILTER, filterFacets, rowHas, filterActive, matchFilter, applyFilter, facetCounts,
  };
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

  // Başkalarının GitHub'dan gelen ilanları ayrı tutulur: diger:<kullanıcı>:<dosya adı>
  const OTHER = 'diger:';
  const otherKeys = (user) => GM_listValues().filter((k) => k.startsWith(OTHER + (user ? user + ':' : '')));

  // Sıralamada görünen ilanlar: kendi ilanların + dahil ettiğin kişilerinkiler.
  // Aynı ilan birden çok kişide varsa senin kopyan esas alınır, eksikleri diğerlerinden tamamlanır.
  function loadAllListings() {
    const out = loadListings();
    const s = loadShare();
    const me = personOf(s.user);
    if (!s.include.length) return out;
    for (const k of otherKeys()) {
      const person = personOf(k.slice(OTHER.length).split(':')[0]); // önbellek klasöre göre: diger:ali-laptop:123 → ali
      if (person === me || !s.include.includes(person)) continue;
      const o = GM_getValue(k, null);
      if (o && o.id) out[o.id] = combineOther(out[o.id], o, person);
    }
    return out;
  }
  function migrateStorage() {
    const old = GM_getValue('listings', null); // 0.1.0 tüm ilanları tek anahtarda tutuyordu
    if (!old) return;
    for (const l of Object.values(old)) if (!getListing(l.id)) putListing(l);
    GM_deleteValue('listings');
  }
  const loadQueue = () => GM_getValue('queue', []);
  const saveQueue = (x) => GM_setValue('queue', x);
  // Eski varsayılan görsel sorular → kriter id'si (loadConfig bunları yenisine çevirir)
  const OLD_VISION = {
    'Are the wheels BMW Y-spoke style 554M (thin double spokes forming Y shapes, usually dark/black)?': 'jant',
  };

  function loadConfig() {
    const c = GM_getValue('config', null) || JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    // 0.6.0 öncesi kaydedilmiş ayarlarda belirsiz ifade listesi yok: aynı adlı varsayılan donanımdan al
    for (const f of (c.hardFilters && c.hardFilters.requiredFeatures) || []) {
      const d = DEFAULT_CONFIG.hardFilters.requiredFeatures.find((x) => x.name === f.name);
      if (!f.unsureKeywords && d && d.unsureKeywords) f.unsureKeywords = d.unsureKeywords.slice();
    }
    // 0.7.0 öncesi ayarlarda görsel kriterlerin fotoğraf türü yok: aynı id'li varsayılan kriterden al
    for (const cr of (c.scoring && c.scoring.criteria) || []) {
      const d = DEFAULT_CONFIG.scoring.criteria.find((x) => x.id === cr.id);
      if (cr.vision && !cr.views && d && d.views) cr.views = d.views.slice();
      // Hiç değiştirilmemiş eski varsayılan soru yenisine geçer (eskisi rengi sormadığı için neredeyse her janta "evet" diyordu)
      if (d && OLD_VISION[cr.vision] === cr.id) cr.vision = d.vision;
    }
    return c;
  }
  // Ayarlar aynı kişinin bilgisayarları arasında eşitlenir: kim en son kaydettiyse o geçerli
  function saveConfig(c) {
    GM_setValue('config', c);
    GM_setValue('configAt', Date.now());
    GM_setValue('configBy', loadShare().user || '');
    scheduleSync();
  }

  // Başka bilgisayardan gelen ayar: buradaki farklıysa önce yedeklenir (Ayarlar → Önceki ayarları geri yükle).
  // Ollama bölümü (model, açık/kapalı) bilgisayara özel: gelen ayar buradakinin yerine geçmez.
  // Bozuk bir ayar paneli açılmaz hale getirebileceği için doğrulanmadan alınmaz; alınmadıysa false döner.
  function adoptConfig(rc) {
    const cur = GM_getValue('config', null);
    const ollama = (cur || DEFAULT_CONFIG).ollama || (rc.config && rc.config.ollama);
    const next = { ...rc.config, ollama: JSON.parse(JSON.stringify(ollama)) };
    try {
      validateConfig(next);
    } catch (e) {
      return false;
    }
    if (cur && stableStringify(cur) !== stableStringify(next)) GM_setValue('configBackup', { config: cur, at: Date.now(), from: rc.by || '' });
    GM_setValue('config', next);
    GM_setValue('configAt', rc.at || 0);
    GM_setValue('configBy', rc.by || '');
    return true;
  }

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
    const keep = prev ? { ai: prev.ai, manual: prev.manual, track: prev.track, copiedFrom: prev.copiedFrom } : {};
    const rec = { ...l, ...keep, firstSeen: prev ? prev.firstSeen : now, lastSeen: now, priceHistory: history };
    putListing(rec);
    saveQueue(loadQueue().filter((u) => u !== l.url));
    return rec;
  }

  // ----- Arama sonuçları: kayıtlı ilanlara rozet, fiyat değiştiyse kaydı güncelle -----
  // Sadece açık olan arama sayfasını okur; Sahibinden'e ek istek atmaz.
  function searchRows() {
    const out = [];
    const seen = new Set();
    document.querySelectorAll('tr.searchResultsItem, tr[data-id], li.searchResultsItem').forEach((row) => {
      if (seen.has(row)) return;
      seen.add(row);
      const a = row.querySelector('a.classifiedTitle') || row.querySelector('a[href*="/ilan/"]');
      if (!a) return;
      const id = String(row.dataset.id || (a.getAttribute('href') || '').match(/(\d{7,})(?:\/detay)?\/?(?:[?#]|$)/)?.[1] || '');
      if (!/^\d{7,}$/.test(id)) return;
      const cell = row.querySelector('.searchResultsPriceValue') || [...row.querySelectorAll('td, div, span')].find((x) => x.children.length === 0 && /\d[\d.]*\s*TL/.test(x.textContent));
      const m = cell && cell.textContent.match(/(\d{1,3}(?:\.\d{3})+|\d+)\s*TL/);
      out.push({ row, a, id, price: m ? parseNumber(m[1]) : null });
    });
    return out;
  }

  const BADGE_BG = { good: '#15803d', warn: '#b45309', bad: '#b91c1c', muted: '#6b7280' };
  const fmtShort = (n) => {
    const a = Math.abs(n);
    return a >= 1e6 ? (a / 1e6).toLocaleString('tr-TR', { maximumFractionDigits: 2 }) + ' mn' : a >= 1000 ? Math.round(a / 1000) + ' bin' : fmtTL(a);
  };

  function badgeEl(text, bg, title) {
    const el = document.createElement('span');
    el.className = 'sa-badge';
    el.textContent = text;
    if (title) el.title = title;
    el.style.cssText = `display:inline-block;margin:0 0 0 6px;padding:0 7px;border-radius:9px;font:600 11px/17px -apple-system,"Segoe UI",Roboto,sans-serif;color:#fff;background:${bg};vertical-align:middle;white-space:nowrap;letter-spacing:0`;
    return el;
  }

  function decorateSearch() {
    const rows = searchRows();
    if (!rows.length) return;
    // Listede görünen fiyat kayıtlı fiyattan farklıysa kendi kaydını güncelle (ilanı açmana gerek kalmadan)
    const now = Date.now();
    let changed = 0;
    for (const r of rows) {
      const own = getListing(r.id);
      if (!own || !r.price || own.price === r.price) continue;
      const hist = (own.priceHistory || []).slice();
      hist.push({ price: r.price, at: now });
      putListing({ ...own, price: r.price, priceHistory: hist, lastSeen: now });
      changed++;
    }
    if (changed) {
      scheduleSync();
      toast(`${changed} kayıtlı ilanın fiyatı değişmiş, güncellendi.`);
    }
    const cfg = loadConfig();
    const all = loadAllListings();
    for (const r of rows) {
      r.row.querySelectorAll('.sa-badge').forEach((x) => x.remove());
      const l = all[r.id];
      let b;
      try {
        b = l ? listBadge(l, cfg) : { tone: 'muted', text: 'yeni', title: 'Henüz açmadığın ilan', dim: false, delta: 0 };
      } catch (e) {
        continue; // bozuk bir kayıt (ör. içe aktarılmış) diğer satırları engellemesin
      }
      const els = [badgeEl(b.text, BADGE_BG[b.tone], b.title)];
      if (b.delta) els.push(badgeEl(`${b.delta < 0 ? '↓' : '↑'} ${fmtShort(b.delta)}`, b.delta < 0 ? BADGE_BG.good : BADGE_BG.bad, b.title));
      if (l && l._owner) els.push(badgeEl(l._owner, BADGE_BG.muted, `${l._owner} kaydetmiş`));
      r.a.after(...els);
      r.row.style.opacity = b.dim ? '0.5' : '';
    }
  }

  // Kaydedilmemiş not taslağını sessizce kaydet (değişmediyse dokunma)
  function flushNoteDraft(id) {
    const d = state.noteDrafts[id];
    if (d == null) return;
    const t = trackOf(loadAllListings()[id] || {});
    const saved = t.by ? '' : t.note;
    if (d.trim() === saved) delete state.noteDrafts[id];
    else setTrack(id, 'note', d.trim(), true);
  }

  let decorateTimer = null;
  const queueDecorate = () => {
    if (isDetailPage()) return;
    clearTimeout(decorateTimer);
    decorateTimer = setTimeout(() => {
      try {
        decorateSearch();
      } catch (e) {
        // bir sonraki değişiklikte tekrar denenir
      }
    }, 250);
  };

  // Sonuçlar sayfa yenilenmeden değişirse (sıralama, sayfa) rozetleri tazele; kendi rozetlerimizin değişimini sayma
  function watchSearch() {
    new MutationObserver((muts) => {
      const ours = muts.every((m) => [...m.addedNodes, ...m.removedNodes].every((n) => n.nodeType === 1 && n.classList.contains('sa-badge')));
      if (!ours) queueDecorate();
    }).observe(document.body, { childList: true, subtree: true });
  }

  const idFromUrl = (u) => (String(u || '').match(/(\d{7,})(?:\/detay)?\/?(?:[?#]|$)/) || [])[1] || null;

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

  // Örnek fotoğraf bir kez indirilip tarayıcıda saklanır: kaynak ilan kaldırılsa da çalışmaya devam eder
  async function loadReference(url) {
    const key = 'ornek:' + url;
    const cached = GM_getValue(key, null);
    if (cached) return cached;
    if (!safeImg(url)) return null;
    const img = await fetchImage(url);
    if (!img.b64) return null;
    GM_setValue(key, img.b64);
    return img.b64;
  }

  // İnce ayrımlarda (ör. jant modeli) "X mi?" sorusu modeli "evet" demeye itiyor; örnek fotoğrafla
  // karşılaştırınca çok daha isabetli. İlk görsel örnek, son görsel ilan fotoğrafı.
  const referencePrompt = (c) => [
    `The FIRST image is a reference photo of the wanted design. Question: ${c.vision}`,
    'The LAST image is a photo from a used car listing.',
    'Is the same part of the car clearly visible in the last image? If yes, does it look like the reference: the same design AND the same color/finish?',
    'A similar design in a different color or finish (for example bicolor, polished or silver instead of black) does NOT match.',
    'Ignore viewing angle, size, dirt and reflections.',
    'Reply with JSON only: {"visible": true|false, "same": true|false}',
  ].join('\n');

  async function analyzeVision(l, cfg, todo, run, onStep) {
    // Örnek fotoğrafı olan kriterler ayrı karşılaştırılır; örnek yüklenemezse düz soruyla sorulur
    const refs = {};
    for (const c of todo) {
      if (!(c.referenceImages || []).length) continue;
      const b64 = await loadReference(c.referenceImages[0]);
      if (b64) refs[c.id] = b64;
    }
    const plain = todo.filter((c) => !refs[c.id]);
    const withRef = todo.filter((c) => refs[c.id]);
    const prompt = [
      'You are checking ONE photo from a used car listing.',
      'First classify the photo as "view", one of: "exterior_front", "exterior_rear", "exterior_side", "interior", "wheel", "other".',
      '("interior" = seats, dashboard or cabin; "wheel" = close-up of a wheel or rim.)',
      'Then for each key below, return {"visible": true|false, "answer": true|false}.',
      '"visible" is true only if the relevant part of the car is clearly visible in THIS photo. If it is not visible, set "answer" to false.',
      '',
      ...plain.map((c) => `- "${c.id}": ${c.vision}`),
      '',
      `Reply with JSON only, with exactly these keys: view${plain.map((c) => ', ' + c.id).join('')}.`,
    ].join('\n');
    const votes = Object.fromEntries(todo.map((c) => [c.id, { question: visionKey(c), yes: 0, no: 0 }]));
    // Fotoğraf adresi arkadaştan da gelebilir: sadece Sahibinden'in görsel sunucusu (yerel ağa istek atılmasın)
    const usable = (l.images || []).filter((u) => safeImg(u));
    const imgs = spreadOrder(usable.length).slice(0, cfg.ollama.maxImages).map((i) => usable[i]);
    const photos = { tried: 0, ok: 0, missing: 0, failed: 0, lastError: null, views: {}, early: false };
    for (let i = 0; i < imgs.length; i++) {
      if (run.cancel) break;
      // Bütün sorular netleştiyse kalan fotoğraflara bakma
      if (photos.ok >= 2 && todo.every((c) => voteDecided(votes[c.id]))) {
        photos.early = true;
        break;
      }
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
      const view = countPhotoAnswer(votes, ans, plain);
      photos.views[view || 'other'] = (photos.views[view || 'other'] || 0) + 1;
      for (const c of withRef) {
        if (view && Array.isArray(c.views) && c.views.length && !c.views.includes(view)) continue;
        if (voteDecided(votes[c.id])) continue;
        const r = await ollamaJSON(cfg, referencePrompt(c), [refs[c.id], img.b64]);
        countPhotoAnswer(votes, { [c.id]: { visible: r && r.visible, answer: r && r.same } }, [c]);
      }
    }
    for (const v of Object.values(votes)) v.result = voteResult(v);
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
      (c) => c.vision && man['crit:' + c.id] === undefined && !findKeyword(corpus, c.keywords) && !(done[c.id] && done[c.id].question === visionKey(c))
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
    const all = loadAllListings();
    const result = computeRows(all, cfg);
    const targets = [...result.passed, ...result.unsure].map((r) => r.l.id);
    aiRunning = true;
    const run = (aiRun = { cancel: false, consecutiveFails: 0, failed: 0, missing: 0 });
    let n = 0;
    try {
      for (const id of targets) {
        if (run.cancel) break;
        n++;
        const view = all[id];
        if (!view) continue;
        // Sen ya da dahil ettiğin biri zaten baktıysa tekrar bakma
        const todo = (view.images || []).length ? visionTodo(view, cfg) : [];
        const needText = !view.ai || !view.ai.text || !!view.ai.text.error;
        if (!todo.length && !needText) continue;
        const label = `(${n}/${targets.length}) ${view.title.slice(0, 40)}`;
        const add = {};
        if (todo.length) {
          const { votes, photos } = await analyzeVision(view, cfg, todo, run, (s) => setStatus(`${label}: ${s}`));
          if (run.cancel) break; // yarım kalan ilanın sonucunu kaydetme
          run.failed += photos.failed;
          run.missing += photos.missing;
          const at = Date.now();
          add.photos = { ...photos, at };
          // Hiç fotoğraf incelenemediyse sonucu kaydetme ki sonraki çalıştırmada tekrar denensin;
          // fotoğraflar silinmişse (ilan kaldırılmış) tekrar denemenin anlamı yok.
          if (photos.ok > 0 || (photos.missing > 0 && photos.failed === 0)) {
            add.vision = Object.fromEntries(Object.entries(votes).map(([k, v]) => [k, { ...v, at }]));
          }
        }
        if (needText) {
          setStatus(`${label}: açıklama inceleniyor`);
          try {
            add.text = { ...(await analyzeText(view)), at: Date.now() };
          } catch (e) {
            if (/Ollama/.test(e.message)) throw e;
            add.text = { error: e.message, at: Date.now() };
          }
        }
        // Sonuç senin kopyana yazılır; ilan başkasınınsa onunkine dokunulmaz, sende kopyası oluşur.
        // getListing tekrar okunuyor: analiz sürerken ilan başka sekmede güncellenmiş olabilir.
        const base = getListing(id) || ownCopyOf(view);
        const ai = { ...(base.ai || {}) };
        if (add.photos) ai.photos = add.photos;
        if (add.vision) ai.vision = { ...(ai.vision || {}), ...add.vision };
        if (add.text) ai.text = add.text;
        putListing({ ...base, ai });
        scheduleSync(10000);
        render();
      }
      const photoNote = [run.failed ? `${run.failed} fotoğraf indirilemedi` : '', run.missing ? `${run.missing} fotoğraf silinmiş` : ''].filter(Boolean).join(', ');
      setStatus((run.cancel ? 'Durduruldu. Tekrar başlatınca kaldığı yerden devam eder.' : `Yerel AI analizi bitti (${n} ilan).`) + (photoNote ? ` · ${photoNote}` : ''));
    } catch (e) {
      setStatus('⚠ ' + e.message);
    } finally {
      aiRunning = false;
      scheduleSync(1000);
      render();
    }
  }

  // ----- GitHub ile ortak veri -----
  // Özel veri reposunda herkesin ilanları kendi klasöründe durur: ilanlar/<kullanıcı>/<dosya>.json
  // Script sadece kendi klasörüne yazar, başkalarınınkini sadece okur. Aynı kullanıcı adını giren
  // bilgisayarlar aynı klasörü paylaşır; aynı ilanın iki kopyası mergeSame ile birleştirilir.
  // Token yalnızca bu tarayıcıda (ghToken) durur; ayar dosyasına ve veri dışa aktarımına girmez.
  // readOnly: veri reposundan sadece oku, hiçbir şey gönderme. Salt okunur token'la (Contents: Read-only) birlikte
  // kullanılır: arkadaş başkalarının ilanlarını, Var/Yok kararlarını ve notlarını çeker, GitHub değiştirmesine izin vermez.
  const DEFAULT_SHARE = { repo: 'registerkayitey-sudo/sahibinden-asistan-veri', branch: 'main', user: '', include: [], auto: true, readOnly: false };
  const SYNC_DIR = 'ilanlar';
  // Kullanıcı adı "kişi" ya da "kişi-bilgisayar" (efe, efe-windows, efe-mac). Tireden önceki kısım kişidir:
  // aynı kişinin bütün bilgisayarları aynı klasörü ve aynı ayarları paylaşır, birbirinin üstüne yazabilir.
  const USER_RE = /^[a-z0-9]{2,20}(-[a-z0-9-]{1,20})?$/;
  const personOf = (u) => String(u || '').split('-')[0];
  const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
  const loadShare = () => ({ ...DEFAULT_SHARE, ...GM_getValue('share', {}) });
  const saveShare = (s) => GM_setValue('share', s);
  const getToken = () => GM_getValue('ghToken', '');
  const loadSyncMeta = () => ({ own: {}, others: {}, users: {}, at: 0, error: null, last: null, ...GM_getValue('syncMeta', {}) });
  const saveSyncMeta = (m) => GM_setValue('syncMeta', m);
  const fileId = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, '_');
  const syncReady = (s = loadShare()) => !!getToken() && USER_RE.test(s.user) && REPO_RE.test(s.repo);

  // fresh: değişebilen bir şeyi (dalın son commit'i) soruyorsak tarayıcı önbelleğini atla.
  // GitHub bu yanıtları "max-age=60" ile gönderiyor; önbellekten gelen eski commit'in üstüne
  // gönderim yapılırsa GitHub 422 (fast forward değil) ile reddediyor.
  async function gh(method, path, body, fresh = false) {
    const r = await gmRequest({
      method,
      url: 'https://api.github.com' + path + (fresh ? `${path.includes('?') ? '&' : '?'}_=${Date.now()}` : ''),
      headers: {
        Authorization: 'Bearer ' + getToken(),
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(fresh ? { 'Cache-Control': 'no-cache' } : {}),
      },
      nocache: fresh,
      data: body ? JSON.stringify(body) : undefined,
      timeout: 60000,
    });
    let j = null;
    try {
      j = r.responseText ? JSON.parse(r.responseText) : null;
    } catch (e) {
      // gövde JSON değil
    }
    if (r.status >= 200 && r.status < 300) return j;
    const msg = (j && j.message) || '';
    const e = new Error(
      r.status === 401 ? 'GitHub token geçersiz ya da süresi dolmuş. Paylaşım sekmesinden yenisini gir.'
        : r.status === 403 && /rate limit/i.test(msg) ? 'GitHub istek sınırı doldu, bir saat içinde kendiliğinden açılır.'
        : r.status === 403 ? 'Token bu repoya yazamıyor. Token ayarında "Contents: Read and write" izni olmalı; sana salt okunur bir token verildiyse Paylaşım sekmesinde "Sadece oku"yu işaretle.'
        : r.status === 404 ? 'Veri reposu bulunamadı ya da token bu repoya erişemiyor.'
        : r.status === 409 ? 'Veri reposu boş. GitHub\'da içinde en az bir dosya (README) olmalı.'
        : `GitHub hatası ${r.status}: ${msg.slice(0, 150)}`
    );
    e.status = r.status;
    throw e;
  }

  // Bu kişi adına veri reposunda zaten veri var mı? Yeni bir tarayıcıda başka birinin adı seçilmesin diye.
  async function personUsage(repo, branch, person) {
    const head = (await gh('GET', `/repos/${repo}/git/ref/heads/${branch}`, null, true)).object.sha;
    const commit = await gh('GET', `/repos/${repo}/git/commits/${head}`);
    const tree = await gh('GET', `/repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`);
    let listings = 0, settings = false;
    for (const e of tree.tree || []) {
      if (e.type !== 'blob') continue;
      const m = e.path.match(/^ilanlar\/([a-z0-9][a-z0-9-]*)\/[^/]+\.json$/);
      if (m && personOf(m[1]) === person) listings++;
      if (e.path === `ayarlar/${person}.json`) settings = true;
    }
    return { listings, settings };
  }

  async function fetchBlobJSON(repo, sha) {
    const b = await gh('GET', `/repos/${repo}/git/blobs/${sha}`);
    const bytes = Uint8Array.from(atob(b.content.replace(/\s/g, '')), (ch) => ch.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  // Git'in dosya kimliği: sha1("blob <bayt>\0<içerik>"). GitHub'daki dosyayla aynı mı, indirmeden anlarız.
  async function gitBlobSha(text) {
    const body = new TextEncoder().encode(text);
    const head = new TextEncoder().encode(`blob ${body.length}\0`);
    const all = new Uint8Array(head.length + body.length);
    all.set(head);
    all.set(body, head.length);
    const h = await crypto.subtle.digest('SHA-1', all);
    return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  // Aynı anda en fazla n istek
  async function pool(items, n, fn) {
    let i = 0;
    const worker = async () => {
      while (i < items.length) await fn(items[i++]);
    };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  }

  let syncBusy = false;
  let syncAgain = false;
  let syncTimer = null;

  function scheduleSync(ms = 4000) {
    const s = loadShare();
    if (!s.auto || !syncReady(s)) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncNow().then(afterSync, () => afterSync(null)), ms);
  }

  function syncLabel() {
    if (!syncReady()) return '';
    if (syncBusy) return '☁ eşitleniyor…';
    const m = loadSyncMeta();
    if (m.error) return '☁ ⚠ eşitlenemedi';
    if (!m.at) return '☁ henüz eşitlenmedi';
    const min = Math.round((Date.now() - m.at) / 60000);
    return '☁ ' + (min < 1 ? 'az önce' : min < 60 ? `${min} dk önce` : new Date(m.at).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })) + ' eşitlendi' + (loadShare().readOnly ? ' (sadece okuma)' : '');
  }

  function showSync(text) {
    const el = root && root.querySelector('[data-sync]');
    if (el) el.textContent = text;
  }

  function afterSync(res) {
    showSync(syncLabel());
    if (res && (res.pulledOwn || res.pulledOthers || res.pulledConfig)) queueDecorate();
    // Yeni ilan ya da ayar geldiyse listeyi tazele; ayar ve paylaşım sekmelerinde yazdıklarını silmemek için dokunma
    if (res && (res.pulledOwn || res.pulledOthers || res.pulledConfig) && state.open && ['sira', 'analiz', 'kars'].includes(state.tab)) render();
    // Bildirim yeniden çizimden sonra: render() paneli baştan kurduğu için önce gösterilen bildirim silinirdi
    if (res && res.pulledConfig) toast(`Ayarlar ${res.pulledConfig} bilgisayarından güncellendi. Öncekiler Ayarlar sekmesinde yedekte.`, 5000);
    if (res && res.badConfig) toast(`⚠ ${res.badConfig} bilgisayarından gelen ayarlar bozuk olduğu için alınmadı; buradaki ayarlar kullanılıyor. O bilgisayarda ayarları kontrol edip tekrar kaydet.`, 8000);
  }

  async function syncNow(onStep = (m) => showSync('☁ ' + m)) {
    const s = loadShare();
    if (!syncReady(s)) throw new Error('Paylaşım ayarları eksik: veri reposu, kullanıcı adı ve token gerekli.');
    if (syncBusy) {
      syncAgain = true;
      return null;
    }
    syncBusy = true;
    const me = personOf(s.user);
    let meta = loadSyncMeta();
    // 0.6.0'dan önce klasör tam kullanıcı adıydı (efe-windows) ve kayıtlar klasörsüz tutuluyordu: baştan başla
    if (meta.v !== 2 || meta.me !== me) {
      for (const k of otherKeys()) GM_deleteValue(k);
      meta = { ...meta, own: {}, others: {}, cfgSha: null, cfgAt: null, v: 2, me };
    }
    const res = { pulledOwn: 0, pulledOthers: 0, pushed: 0, pulledConfig: null, badConfig: null, pushedConfig: false };
    try {
      // İlan açıklamalarında satıcı adı ve telefonu geçebilir: veri reposu herkese açıksa hiçbir şey okuma ya da gönderme.
      // Her eşitlemede bakılır, repo sonradan herkese açık yapılırsa da yakalansın.
      onStep('veri reposu kontrol ediliyor…');
      const repoInfo = await gh('GET', `/repos/${s.repo}`);
      if (!repoInfo || repoInfo.private !== true) {
        throw new Error(`Veri reposu (${s.repo}) herkese açık. İlan açıklamalarında satıcı bilgileri olabileceği için eşitleme yapılmadı; GitHub'da repoyu Private yap.`);
      }
      for (let attempt = 1; ; attempt++) {
        onStep('liste alınıyor…');
        const head = (await gh('GET', `/repos/${s.repo}/git/ref/heads/${s.branch}`, null, true)).object.sha;
        const commit = await gh('GET', `/repos/${s.repo}/git/commits/${head}`);
        const tree = await gh('GET', `/repos/${s.repo}/git/trees/${commit.tree.sha}?recursive=1`);
        if (tree.truncated) throw new Error('Veri reposu GitHub\'ın tek seferde listeleyebileceğinden büyük.');
        const remote = {}; // klasör -> dosya -> sha
        const paths = {};
        for (const e of tree.tree || []) {
          if (e.type !== 'blob') continue;
          paths[e.path] = e.sha;
          const m = e.path.match(/^ilanlar\/([a-z0-9][a-z0-9-]*)\/([A-Za-z0-9_-]+)\.json$/);
          if (m) (remote[m[1]] = remote[m[1]] || {})[m[2]] = e.sha;
        }
        // Senin klasörün "efe"; eski sürümlerin açtığı "efe-windows" gibi klasörler de senin
        const ownFolders = Object.keys(remote).filter((d) => personOf(d) === me);
        meta.users = {};
        for (const [d, files] of Object.entries(remote)) {
          if (personOf(d) !== me) meta.users[personOf(d)] = (meta.users[personOf(d)] || 0) + Object.keys(files).length;
        }

        // 1) Senin ilanların: diğer bilgisayarlarında değişenleri al, buradakiyle birleştir
        const localFiles = new Set(Object.values(loadListings()).map((l) => fileId(l.id)));
        const toPull = [];
        for (const d of ownFolders) {
          for (const [f, sha] of Object.entries(remote[d])) if (meta.own[`${d}/${f}`] !== sha || !localFiles.has(f)) toPull.push([d, f, sha]);
        }
        let done = 0;
        await pool(toPull, 6, async ([d, f, sha]) => {
          const r = await fetchBlobJSON(s.repo, sha);
          putListing(mergeSame(getListing(r.id), r));
          meta.own[`${d}/${f}`] = sha;
          res.pulledOwn++;
          onStep(`ilanların alınıyor ${++done}/${toPull.length}`);
        });

        // 2) Ayarlar: aynı kişinin bilgisayarları arasında en son kaydedilen geçerli
        const entries = [];
        const cfgPath = `ayarlar/${me}.json`;
        const rcs = paths[cfgPath];
        if (rcs && rcs !== meta.cfgSha) {
          const rc = await fetchBlobJSON(s.repo, rcs);
          if (rc.config && (rc.at || 0) > (GM_getValue('configAt', 0) || 0)) {
            if (adoptConfig(rc)) res.pulledConfig = rc.by || '?';
            else res.badConfig = rc.by || '?';
          }
          meta.cfgSha = rcs;
          meta.cfgAt = rc.at || 0;
        }
        let pendingCfg = null;
        const localCfg = GM_getValue('config', null); // hiç kaydedilmediyse varsayılan kullanılıyor: gönderecek bir şey yok
        if (localCfg && (!rcs || (GM_getValue('configAt', 0) || 0) > (meta.cfgAt || 0))) {
          const at = GM_getValue('configAt', 0) || Date.now();
          const by = GM_getValue('configBy', '') || s.user;
          const text = stableStringify({ at, by, config: localCfg });
          const sha = await gitBlobSha(text);
          if (sha !== rcs) {
            entries.push({ path: cfgPath, mode: '100644', type: 'blob', content: text });
            pendingCfg = { sha, at, by };
          }
        }

        // 3) Senin klasörüne gidecek ilanlar: içeriği GitHub'dakinden farklı olanlar
        const mine = remote[me] || {};
        const pending = {};
        let nListings = 0;
        for (const l of Object.values(loadListings())) {
          const f = fileId(l.id);
          const text = stableStringify(l);
          const sha = await gitBlobSha(text);
          if (sha === mine[f]) {
            meta.own[`${me}/${f}`] = sha;
            continue;
          }
          entries.push({ path: `${SYNC_DIR}/${me}/${f}.json`, mode: '100644', type: 'blob', content: text });
          pending[`${me}/${f}`] = sha;
          nListings++;
        }
        // Eski bilgisayar-adlı klasörler yukarıda birleştirildi; aynı commit'te kaldırılır (git geçmişinde durur)
        const legacy = [];
        for (const d of ownFolders) {
          if (d === me) continue;
          for (const f of Object.keys(remote[d])) {
            entries.push({ path: `${SYNC_DIR}/${d}/${f}.json`, mode: '100644', type: 'blob', sha: null });
            legacy.push(`${d}/${f}`);
          }
        }

        // 4) Dahil ettiğin kişiler (ali, ali-laptop aynı kişi): sadece değişen dosyaları indir,
        //    artık dahil olmayanların önbelleğini sil
        for (const d of Object.keys(meta.others)) {
          if (remote[d] && personOf(d) !== me && s.include.includes(personOf(d))) continue;
          for (const k of otherKeys(d)) GM_deleteValue(k);
          delete meta.others[d];
        }
        for (const d of Object.keys(remote)) {
          const p = personOf(d);
          if (p === me || !s.include.includes(p)) continue;
          const known = (meta.others[d] = meta.others[d] || {});
          const need = Object.entries(remote[d]).filter(([f, sha]) => known[f] !== sha);
          done = 0;
          await pool(need, 6, async ([f, sha]) => {
            GM_setValue(`${OTHER}${d}:${f}`, await fetchBlobJSON(s.repo, sha));
            known[f] = sha;
            res.pulledOthers++;
            onStep(`${p} ilanları alınıyor ${++done}/${need.length}`);
          });
          for (const f of Object.keys(known)) {
            if (remote[d][f]) continue;
            GM_deleteValue(`${OTHER}${d}:${f}`);
            delete known[f];
          }
        }
        saveSyncMeta(meta);
        if (s.readOnly) break; // sadece oku: hiçbir şey gönderme (ilan, ayar, eski klasör temizliği)
        if (!entries.length) break;

        // 5) Hepsi tek commit. Bu arada başka bir bilgisayar gönderdiyse (422) baştan al ve tekrar dene.
        const legacyDirs = [...new Set(legacy.map((x) => x.split('/')[0]))];
        const what = [nListings ? `${nListings} ilan` : '', pendingCfg ? 'ayarlar' : '', legacyDirs.length ? `${legacyDirs.join(', ')} klasörü ${me} klasörüne taşındı` : '']
          .filter(Boolean)
          .join(', ');
        onStep(`gönderiliyor: ${what}`);
        const nt = await gh('POST', `/repos/${s.repo}/git/trees`, { base_tree: commit.tree.sha, tree: entries });
        const nc = await gh('POST', `/repos/${s.repo}/git/commits`, { message: `${s.user}: ${what}`, tree: nt.sha, parents: [head] });
        try {
          await gh('PATCH', `/repos/${s.repo}/git/refs/heads/${s.branch}`, { sha: nc.sha, force: false });
        } catch (e) {
          if (e.status !== 422) throw e;
          if (attempt < 4) {
            await new Promise((ok) => setTimeout(ok, 700 * attempt)); // başka bir bilgisayar aynı anda gönderdi
            continue;
          }
          scheduleSync(20000);
          throw new Error(s.auto
            ? 'Başka bir bilgisayar da aynı anda gönderiyor; 20 saniye sonra kendiliğinden tekrar denenecek.'
            : 'Başka bir bilgisayar da aynı anda gönderiyor; biraz sonra ☁ yazısına tıklayıp tekrar dene.');
        }
        Object.assign(meta.own, pending);
        for (const k of legacy) delete meta.own[k];
        if (pendingCfg) {
          Object.assign(meta, { cfgSha: pendingCfg.sha, cfgAt: pendingCfg.at });
          GM_setValue('configAt', pendingCfg.at);
          GM_setValue('configBy', pendingCfg.by);
        }
        res.pushed = nListings;
        res.pushedConfig = !!pendingCfg;
        break;
      }
      Object.assign(meta, { at: Date.now(), error: null, last: res });
      saveSyncMeta(meta);
      return res;
    } catch (e) {
      meta.error = e.message;
      saveSyncMeta(meta);
      throw e;
    } finally {
      syncBusy = false;
      if (syncAgain) {
        syncAgain = false;
        scheduleSync(1000);
      }
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
    .toast { position: fixed; right: 16px; bottom: 64px; z-index: 2147483647; background: var(--bg); border: 1px solid var(--line);
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
    .form { display: grid; gap: 8px; max-width: 560px; }
    .form label { display: grid; gap: 3px; font-size: 12px; color: var(--muted); }
    .form input:not([type=checkbox]) { font-size: 13px; padding: 7px 9px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); }
    label.check { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--fg); margin: 4px 0; }
    .hint { font-size: 11px; margin-top: -4px; }
    .tab.sync { color: var(--muted); font-size: 12px; }
    details.tune { background: var(--bg2); border-radius: 8px; padding: 6px 10px; margin-bottom: 10px; }
    details.tune > summary { color: var(--fg); font-size: 13px; font-weight: 600; margin: 0; }
    details.tune p { margin: 6px 0; }
    .tune-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 10px 22px; margin: 6px 0 4px; }
    .tgroup { display: grid; gap: 3px; align-content: start; }
    .trow { display: grid; grid-template-columns: minmax(0, 1fr) 120px 92px; align-items: center; gap: 8px; font-size: 12px; }
    .trow input { width: 100%; margin: 0; }
    .trow output { text-align: right; font-variant-numeric: tabular-nums; }
    .filter { display: grid; gap: 6px; margin-bottom: 10px; }
    .frow { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; }
    .frow input[type=text], .frow select { font-size: 13px; padding: 6px 9px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); }
    .frow .q { flex: 1 1 240px; min-width: 180px; }
    .frow .num-in { width: 112px; }
    .frow label { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--muted); }
    .chip { padding: 3px 10px; border-radius: 999px; font-size: 12px; }
    .chip .n { color: var(--muted); margin-left: 5px; font-variant-numeric: tabular-nums; }
    .chip.yes { background: var(--good); border-color: var(--good); color: #fff; }
    .chip.no { background: var(--bad); border-color: var(--bad); color: #fff; }
    .chip.zero { opacity: .55; }
    .calib .imp { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 10px 0 4px; }
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
    .chip { display: inline-block; font-size: 11px; padding: 0 7px; border-radius: 999px; background: var(--bg2); border: 1px solid var(--line); white-space: nowrap; }
    .chip.st-arandi, .chip.st-ekspertiz, .chip.st-teklif { background: var(--accent); border-color: var(--accent); color: #fff; }
    .chip.st-vazgecti, .chip.st-satildi { text-decoration: line-through; }
    .track { margin: 2px 0 10px; }
    .track .mbtns { flex-wrap: wrap; margin: 0; }
    .mini.st.on { background: var(--accent); border-color: var(--accent); color: #fff; }
    textarea.note { min-height: 56px; height: 56px; font-family: inherit; font-size: 13px; margin: 6px 0 4px; padding: 6px 8px; resize: vertical; }
    td.pick { width: 1%; white-space: nowrap; }
    td.pick input { margin: 0 4px 0 0; vertical-align: middle; }
    .card { position: fixed; right: 16px; bottom: 64px; z-index: 2147483646; width: 360px; max-width: calc(100vw - 32px); background: var(--bg);
      border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; box-shadow: 0 4px 18px rgba(0,0,0,.22); }
    .card h3 { font-size: 13px; margin: 0 0 6px; }
    .cmp { table-layout: fixed; }
    .cmp th:first-child { width: 150px; }
    .cmp td, .cmp th { overflow-wrap: anywhere; }
    .cmp img { width: 100%; height: 120px; object-fit: cover; border-radius: 6px; display: block; margin-bottom: 4px; background: var(--bg2); }
    .cmp .best { color: var(--good); font-weight: 700; }
    .refpick { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 2px; }
    .refpick .muted { flex-basis: 100%; font-size: 12px; }
    .refpick img { width: 116px; height: 87px; object-fit: cover; border-radius: 6px; cursor: pointer; border: 2px solid transparent; }
    .refpick img:hover { border-color: var(--line); }
    .refpick img.on { border-color: var(--accent); }
    .refs { display: flex; flex-wrap: wrap; gap: 12px; margin: 6px 0 12px; }
    .refs figure { margin: 0; font-size: 12px; }
    .myrank { list-style: none; padding: 0; margin: 6px 0 14px; }
    .myrank li { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; margin-bottom: 4px; background: var(--bg); }
    .myrank li.drop-before { box-shadow: 0 -3px 0 var(--accent); }
    .myrank li.drop-after { box-shadow: 0 3px 0 var(--accent); }
    .myrank .grip { cursor: grab; color: var(--muted); user-select: none; }
    .myrank .pos { font-weight: 700; min-width: 22px; text-align: right; }
    .myrank .t { flex: 1; min-width: 0; }
    .myrank .meta { color: var(--muted); font-size: 12px; white-space: nowrap; }
    .calib { background: var(--bg2); border-radius: 8px; padding: 10px 12px; margin: 8px 0 12px; }
    .calib .big { font-size: 18px; font-weight: 700; }
    .chg td.to { font-weight: 700; }
    .refs img { width: 140px; height: 105px; object-fit: cover; border-radius: 6px; display: block; margin-bottom: 4px; }
    .cmp .sub { font-size: 11px; }
  `;

  let host;
  let root;
  let state = { open: false, tab: 'sira', status: '', openRows: new Set(), tuneOpen: false, rejOpen: false, allCache: null, tuneCfg: null, tuneStart: null, tuneTimer: null, tuneDirty: new Map(), noteDrafts: {}, cardOpen: false, currentId: null, filter: null, filterTimer: null };

  function mount() {
    host = document.createElement('div');
    host.id = 'sahibinden-asistan';
    document.documentElement.appendChild(host);
    root = host.attachShadow({ mode: 'open' });
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    // Benim sıralamam: sürükle-bırak
    root.addEventListener('dragstart', (e) => {
      const li = e.target.closest && e.target.closest('li[data-rank-id]');
      if (!li) return;
      state.dragId = li.dataset.rankId;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', state.dragId);
    });
    const clearDrop = () => root.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
    root.addEventListener('dragover', (e) => {
      const li = e.target.closest && e.target.closest('li[data-rank-id]');
      if (!li || !state.dragId) return;
      e.preventDefault();
      const r = li.getBoundingClientRect();
      clearDrop();
      li.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
    });
    root.addEventListener('dragend', () => {
      state.dragId = null;
      clearDrop();
    });
    root.addEventListener('drop', (e) => {
      const li = e.target.closest && e.target.closest('li[data-rank-id]');
      if (!li || !state.dragId) return;
      e.preventDefault();
      const after = li.classList.contains('drop-after');
      const ids = loadOrder().filter((x) => x !== state.dragId);
      let at = ids.indexOf(li.dataset.rankId);
      if (at < 0) return;
      if (after) at++;
      ids.splice(at, 0, state.dragId);
      state.dragId = null;
      saveOrder(ids);
      render();
    });
    // Not alanından çıkınca (ör. "Sonraki ilan"a basınca) yazılan not kaybolmasın
    root.addEventListener('focusout', (e) => {
      if (e.target.matches && e.target.matches('textarea[data-note]')) flushNoteDraft(e.target.dataset.note);
    });
    window.addEventListener('pagehide', () => {
      for (const id of Object.keys(state.noteDrafts)) flushNoteDraft(id);
    });
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

  // "Var / Yok" düğme çifti; cur: true, false ya da undefined (henüz karar yok).
  // Karar başkasından geliyorsa "geri al" çıkmaz: onun kararını silemezsin, Var/Yok ile kendi kararını verirsin.
  function manualBtns(id, key, yes, no, cur, canUndo = cur !== undefined) {
    const b = (v, txt, cls) =>
      `<button class="mini${cur === v ? ' on ' + cls : ''}" data-manual="${esc(id)}" data-key="${esc(key)}" data-val="${v ? '1' : '0'}">${esc(txt)}</button>`;
    const undo = canUndo ? `<button class="mini" data-manual="${esc(id)}" data-key="${esc(key)}" data-val="">geri al</button>` : '';
    return `<span class="mbtns">${b(true, yes, 'yes')}${b(false, no, 'no')}${undo}</span>`;
  }

  const byTag = (by) => (by ? ` <span class="muted">(${esc(by)})</span>` : '');

  // Arkadaştan gelen ilan verisi de ekrana basılıyor: link sadece sahibinden'e, fotoğraf sadece shbdn'e gidebilir
  const safeUrl = (u) => (/^https:\/\/(www\.)?sahibinden\.com\//.test(String(u || '')) ? u : '#');
  const safeImg = (u) => (/^https:\/\/[a-z0-9]+\.shbdn\.com\//.test(String(u || '')) ? u : '');

  function statusChip(l) {
    const t = trackOf(l);
    const out = [];
    if (t.status) out.push(`<span class="chip st-${t.status}"${t.by ? ` title="${esc(t.by)} işaretledi"` : ''}>${esc(statusInfo(t.status).label)}${t.by ? ' · ' + esc(t.by) : ''}</span>`);
    if (t.note) out.push(`<span title="${esc((t.by ? t.by + ': ' : '') + t.note)}">📝</span>`);
    return out.length ? ' ' + out.join(' ') : '';
  }

  // Durum düğmeleri ve not alanı. Başkasından gelen durum/not sadece gösterilir; düğmeler senin kararın.
  function trackBlock(l) {
    const t = trackOf(l);
    const own = t.by ? { status: null, note: '' } : t;
    const id = esc(l.id);
    const chips = STATUSES.map((x) => `<button class="mini st${own.status === x.id ? ' on' : ''}" data-track-status="${x.id}" data-id="${id}">${esc(x.label)}</button>`).join('')
      + (own.status ? `<button class="mini" data-track-status="" data-id="${id}">temizle</button>` : '');
    const other = t.by ? `<div class="muted" style="margin-top:4px">${esc(t.by)}: ${esc([t.status ? statusInfo(t.status).label : '', t.note].filter(Boolean).join(' · '))}</div>` : '';
    const draft = state.noteDrafts[l.id];
    return `<div class="track"><span class="mbtns">${chips}</span>${other}
      <textarea class="note" data-note="${id}" placeholder="Not: satıcıyla konuştukların, ekspertiz sonucu, pazarlık…">${esc(draft != null ? draft : own.note)}</textarea>
      <button class="mini" data-note-save="${id}">Notu kaydet</button>${draft != null && draft !== own.note ? ' <span class="warn" style="font-size:12px">kaydedilmedi</span>' : ''}</div>`;
  }

  // Örnek fotoğrafı ayarlara yaz (null: kaldır). Ayarlar diğer bilgisayarlarına da gider; o kriter
  // için fotoğraf analizi bir sonraki çalıştırmada bütün ilanlarda yeniden yapılır.
  function setReference(cid, url) {
    const cfg = loadConfig();
    const c = (cfg.scoring.criteria || []).find((x) => x.id === cid);
    if (!c || (url && !safeImg(url))) return;
    if (url) c.referenceImages = [url];
    else delete c.referenceImages;
    saveConfig(cfg);
    state.refPick = null;
    render();
    toast(url
      ? `${c.name} için örnek fotoğraf kaydedildi. "Yerel AI analizini çalıştır" dediğinde bu kriter bütün ilanlarda bu örnekle yeniden kontrol edilir.`
      : `${c.name} için örnek fotoğraf kaldırıldı.`, 6000);
  }

  // "Benim sıralamam": ayarların içinde durur, aynı kişinin bilgisayarları arasında eşitlenir
  const loadOrder = () => ((loadConfig().calibration || {}).order || []).map(String);
  function saveOrder(ids) {
    const cfg = loadConfig();
    cfg.calibration = { ...(cfg.calibration || {}), order: ids };
    saveConfig(cfg);
  }

  // Karşılaştırma seçimi bu tarayıcıda durur (en fazla 4 ilan)
  const MAX_CMP = 4;
  const loadCmp = () => GM_getValue('compare', []);
  const saveCmp = (ids) => GM_setValue('compare', ids);

  // Durum ya da not değişti. İlan başkasınınsa onunkine dokunulmaz, sende kopyası oluşur (Var/Yok gibi).
  // quiet: not alanından çıkınca ya da sayfa kapanırken sessizce kaydet (yeniden çizme, araya giren tıklama kaybolmasın)
  function setTrack(id, field, v, quiet = false) {
    let l = getListing(id);
    let copied = false;
    if (!l) {
      const view = loadAllListings()[id];
      if (!view) return;
      l = ownCopyOf(view);
      copied = true;
    }
    l.track = { ...(l.track || {}), [field]: { v, at: Date.now() } };
    putListing(l);
    if (field === 'note') delete state.noteDrafts[id];
    scheduleSync();
    if (quiet) return;
    render();
    const what = field === 'note' ? (v ? 'Not kaydedildi' : 'Not silindi') : v ? `Durum: ${statusInfo(v).label}` : 'Durum temizlendi';
    const closed = field === 'status' && v && statusInfo(v).closed ? ' · ilan sıralamadan çıktı, "Kapananlar"da duruyor' : '';
    toast(what + closed + (copied ? ` · ilanın kopyası senin verine eklendi (kaynak: ${l.copiedFrom})` : ''));
  }

  // Doğrulanamayan şartlar: ilan satırının altında, ayrıntıları açmadan cevaplanabilsin
  function askBlock(r) {
    if (!r.hard.unknowns.length) return '';
    return `<div class="ask">${r.hard.unknowns
      .map((u) => `<div><span class="warn">${esc(u.label)}</span>${manualBtns(r.l.id, u.key, u.yes, u.no, undefined)}</div>`)
      .join('')}</div>`;
  }

  // Örnek fotoğraf seçici: ilanın fotoğrafları küçük olarak, tıklanınca ayarlara kaydedilir
  function refPicker(l, c) {
    const cur = new Set(c.referenceImages || []);
    return `<div class="refpick"><div class="muted">${esc(c.name)} için en net görünen fotoğrafa tıkla (ör. jantın yakından çekildiği):</div>${(l.images || [])
      .filter(safeImg)
      .map((u) => `<img src="${esc(u)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-ref-set="${esc(u)}" data-cid="${esc(c.id)}" class="${cur.has(u) ? 'on' : ''}">`)
      .join('')}</div>`;
  }

  function detailBlock(r) {
    const cfg = loadConfig();
    const l = r.l;
    const t = l.ai && l.ai.text;
    const man = manualOf(l);
    const lines = r.score.lines
      .map((x) => {
        let btns = x.key && x.askable ? manualBtns(l.id, x.key, 'Var', 'Yok', man[x.key], man[x.key] !== undefined && !x.manualBy) : '';
        const cid = x.key ? x.key.slice(5) : '';
        const vc = cid && (cfg.scoring.criteria || []).find((c) => c.id === cid && c.vision);
        if (vc && man[x.key] === true && !x.manualBy && (l.images || []).some(safeImg)) {
          const picking = state.refPick && state.refPick.id === String(l.id) && state.refPick.cid === cid;
          btns += ` <button class="mini" data-ref-pick="${esc(l.id)}" data-cid="${esc(cid)}" title="Bu ilandaki bir fotoğrafı, yerel AI'ın diğer ilanlarla karşılaştıracağı örnek yap">${picking ? 'vazgeç' : '📷 örnek yap'}</button>`;
          if (picking) btns += refPicker(l, vc);
        }
        return `<li>${esc(x.name)}: <b>${Math.round(x.points)}/${x.max}</b> <span class="muted">${esc(x.via || '')}${x.pending ? ' ⏳' : ''}</span>${btns}</li>`;
      })
      .join('');
    // Olması gereken donanımlar (HUD gibi): puanı yok ama şart; metinden "var" denmiş olsa da değiştirilebilir
    const featLines = (r.hard.feats || [])
      .map((x) => `<li class="${x.ok === true ? '' : x.ok === false ? 'bad' : 'warn'}">${esc(x.name)}: <b>şart</b> <span class="muted">${esc(x.via)}</span>${manualBtns(l.id, x.key, 'Var', 'Yok', man[x.key], man[x.key] !== undefined && !x.by)}</li>`)
      .join('');
    const nonOrig = l.parts ? Object.entries(l.parts).filter(([, st]) => st !== 'orijinal') : [];
    let html = `<div class="detail"><b>Durum ve not</b>${trackBlock(l)}<b>Puan dökümü</b><ul>${featLines}${lines}</ul>`;
    const decided = r.hard.decided.filter((d) => !d.key.startsWith('feat:')); // donanımlar yukarıda zaten var
    if (decided.length) {
      html += `<b>Elle kontroller</b><ul>${decided
        .map((d) => `<li class="${d.ok ? 'good' : 'bad'}">${esc(d.label)} → <b>${esc(d.ok ? d.yes : d.no)}</b>${byTag(d.by)}${manualBtns(l.id, d.key, d.yes, d.no, d.ok, !d.by)}</li>`)
        .join('')}</ul>`;
    }
    // Cevaplanmamış sorular ilan satırının altında duruyor (askBlock), burada tekrar edilmiyor.
    if (r.hard.fails.length) html += `<b>Elenme nedeni</b><ul>${r.hard.fails.map((u) => `<li class="bad">${esc(u)}</li>`).join('')}</ul>`;
    html += `<b>Boya/değişen</b> <span class="muted">${l.parts && Object.keys(l.parts).length ? (nonOrig.length ? esc(nonOrig.map(([p, st]) => `${p}: ${st}`).join(', ')) : 'tüm parçalar orijinal') : 'okunamadı'}</span>`;
    const ph = l.ai && l.ai.photos;
    if (ph) {
      const parts = [`${ph.ok}/${ph.tried} incelendi${ph.early ? ' (sorular netleşince erken bitti)' : ''}`];
      const vs = Object.entries(ph.views || {}).map(([k, n]) => `${n} ${VIEW_LABELS[k] || k}`);
      if (vs.length) parts.push(vs.join(', '));
      if (ph.failed) parts.push(`${ph.failed} indirilemedi${ph.lastError ? ` (${ph.lastError})` : ''}`);
      if (ph.missing) parts.push(`${ph.missing} silinmiş, ilan kaldırılmış olabilir`);
      html += `<div style="margin-top:6px"><b>Fotoğraflar</b> <span class="${ph.failed || ph.missing ? 'warn' : 'muted'}">${esc(parts.join(' · '))}</span></div>`;
    }
    if (r.flags.length) html += `<b style="display:block;margin-top:6px">Uyarılar</b><ul>${r.flags.map((f) => `<li class="warn">${esc(f)}</li>`).join('')}</ul>`;
    if (t && !t.error) {
      html += `<b style="display:block;margin-top:6px">Yerel AI</b>${byTag(l._aiBy && l._aiBy.text)}<div>${esc(t.ozet)}</div>`;
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
    const cmp = new Set(loadCmp());
    return `<table><thead><tr><th title="Karşılaştırmak için seç">#</th><th>İlan</th><th class="num">Fiyat</th><th class="num">Yıl</th><th class="num">KM</th><th class="num">Tramer</th><th class="num">Piyasa</th><th class="num">Puan</th></tr></thead><tbody>${rows
      .map((r, i) => {
        const tr = r.score.tramer.amount;
        return `<tr>
          <td class="num pick"><input type="checkbox" data-cmp="${esc(r.l.id)}" title="Karşılaştırmaya ekle" ${cmp.has(String(r.l.id)) ? 'checked' : ''}>${startIdx + i + 1}</td>
          <td><a href="${esc(safeUrl(r.l.url))}" target="_blank">${esc(r.l.title)}</a>${statusChip(r.l)}${r.flags.length ? ` <span class="warn" title="${esc(r.flags.join('\n'))}">⚠ ${r.flags.length}</span>` : ''}${
            r.l._owner ? ` <span class="muted" title="Bu ilan sende yok, dahil ettiğin kişiden geliyor. Bir şeyini değiştirirsen sende kopyası oluşur.">· kaynak: ${esc(r.l._owner)}</span>`
            : r.l.copiedFrom ? ` <span class="muted">· kopya (kaynak: ${esc(r.l.copiedFrom)})</span>` : ''}
            ${askBlock(r)}
            <details ${state.openRows.has(r.l.id) ? 'open' : ''}><summary data-row="${esc(r.l.id)}">ayrıntılar</summary>${detailBlock(r)}</details></td>
          <td class="num">${fmtTL(r.l.price)}</td>
          <td class="num">${esc(r.l.year ?? '–')}</td>
          <td class="num">${fmtNum(r.l.km)}</td>
          <td class="num">${tr == null ? '<span class="muted">?</span>' : tr === 0 ? 'yok' : fmtNum(tr)}</td>
          <td class="num">${marketCell(r)}</td>
          <td class="num score ${scoreClass(r)}">${Math.round(r.score.total)}<span class="muted">/${r.score.max}</span></td>
        </tr>`;
      })
      .join('')}</tbody></table>`;
  }

  // ----- Canlı puan ayarı: kaydırdıkça sıralama hemen yeniden hesaplanır -----
  const getPath = (o, p) => p.reduce((x, k) => (x == null ? x : x[k]), o);
  function setPath(o, p, v) {
    const parent = getPath(o, p.slice(0, -1));
    if (parent) parent[p[p.length - 1]] = v;
  }

  function tuneSpecs(cfg) {
    const year = new Date().getFullYear();
    const s = cfg.scoring;
    const out = [
      { g: 'Filtreler', label: 'En fazla KM (altı geçer)', path: ['hardFilters', 'maxKm'], min: 20000, max: 300000, step: 5000, fmt: fmtNum },
      { g: 'Filtreler', label: 'En az model yılı', path: ['hardFilters', 'minYear'], min: year - 20, max: year + 1, step: 1 },
      { g: 'Filtreler', label: 'En fazla fiyat', path: ['hardFilters', 'maxPrice'], min: 250000, max: 10000000, step: 50000, fmt: fmtTL },
      { g: 'KM', label: 'Puan', path: ['scoring', 'km', 'points'], min: 0, max: 100, step: 1 },
      { g: 'KM', label: 'Bu km ve altı tam puan', path: ['scoring', 'km', 'bestKm'], min: 0, max: 200000, step: 5000, fmt: fmtNum },
      { g: 'KM', label: 'Bu km ve üstü 0 puan', path: ['scoring', 'km', 'worstKm'], min: 10000, max: 300000, step: 5000, fmt: fmtNum },
      { g: 'Tramer', label: 'Kayıt yoksa', path: ['scoring', 'tramer', 'noRecordPoints'], min: 0, max: 100, step: 1 },
    ];
    (s.tramer.tiers || []).forEach((t, i) => out.push({ g: 'Tramer', label: `${fmtNum(t.below)} TL altı`, path: ['scoring', 'tramer', 'tiers', i, 'points'], min: 0, max: 100, step: 1 }));
    if (s.price) out.push({ g: 'Fiyat ve yıl', label: 'Fiyat puanı', path: ['scoring', 'price', 'points'], min: 0, max: 100, step: 1 });
    if (s.year) out.push({ g: 'Fiyat ve yıl', label: 'Model yılı puanı', path: ['scoring', 'year', 'points'], min: 0, max: 100, step: 1 });
    (s.colors || []).forEach((c, i) => out.push({ g: 'Renk', label: c.name, path: ['scoring', 'colors', i, 'points'], min: 0, max: 100, step: 1 }));
    (s.criteria || []).forEach((c, i) => out.push({ g: 'Kriterler', label: c.name, path: ['scoring', 'criteria', i, 'points'], min: 0, max: 100, step: 1 }));
    return out;
  }

  function renderTune() {
    const cfg = loadConfig();
    let html = '<div class="tune-grid">';
    let g = null;
    tuneSpecs(cfg).forEach((sp, i) => {
      const v = Number(getPath(cfg, sp.path)) || 0;
      if (sp.g !== g) {
        html += `${g === null ? '' : '</div>'}<div class="tgroup"><b>${esc(sp.g)}</b>`;
        g = sp.g;
      }
      html += `<label class="trow"><span>${esc(sp.label)}</span><input type="range" data-tune="${i}" min="${Math.min(sp.min, v)}" max="${Math.max(sp.max, v)}" step="${sp.step}" value="${v}"><output data-tune-out="${i}">${esc((sp.fmt || String)(v))}</output></label>`;
    });
    return html + '</div></div>';
  }

  function onInput(e) {
    if (e.target.matches && e.target.matches('textarea[data-note]')) {
      state.noteDrafts[e.target.dataset.note] = e.target.value;
      return;
    }
    const fi = e.target.closest && e.target.closest('[data-filter]');
    if (fi) {
      const f = curFilter();
      const k = fi.dataset.filter;
      if (k === 'q' || k === 'color') f[k] = fi.value;
      else if (k === 'withRejected') f[k] = fi.checked;
      else f[k] = parseNumber(fi.value);
      saveFilter(f);
      clearTimeout(state.filterTimer);
      state.filterTimer = setTimeout(refreshFiltered, k === 'q' ? 150 : 50); // yazarken her harfte değil
      return;
    }
    const t = e.target.closest && e.target.closest('[data-tune]');
    if (!t) return;
    if (!state.tuneCfg) state.tuneCfg = loadConfig();
    if (!state.tuneStart) {
      state.tuneStart = JSON.parse(JSON.stringify(state.tuneCfg)); // "Başlangıca dön" için
      const u = root.querySelector('[data-action="tune-undo"]');
      if (u) u.disabled = false;
    }
    const i = Number(t.dataset.tune);
    const sp = tuneSpecs(state.tuneCfg)[i];
    const v = Number(t.value);
    setPath(state.tuneCfg, sp.path, v);
    const key = tuneKey(state.tuneCfg, sp.path);
    state.tuneDirty.set(JSON.stringify(key), key);
    const out = root.querySelector(`[data-tune-out="${i}"]`);
    if (out) out.textContent = (sp.fmt || String)(v);
    // Sadece listeyi yeniden çiz; kaydırıcıya dokunma ki sürüklemeye devam edebilesin
    const box = root.querySelector('[data-ranking]');
    if (box) box.innerHTML = rankingBody(computeRows(state.allCache || loadAllListings(), state.tuneCfg));
    clearTimeout(state.tuneTimer);
    state.tuneTimer = setTimeout(flushTune, 700);
  }

  function flushTune() {
    clearTimeout(state.tuneTimer);
    if (!state.tuneCfg) return;
    applyTuned(state.tuneCfg);
    state.tuneCfg = null;
  }

  // Kaydırılan alanı ayardaki sıradan bağımsız tutar: kriter id'siyle, tramer basamağı sınırıyla.
  // Kaydırırken başka bilgisayardan ayar gelirse kriterlerin sırası değişmiş olabilir.
  function tuneKey(cfg, p) {
    if (p[1] === 'criteria') return ['scoring', 'criteria', { id: cfg.scoring.criteria[p[2]].id }, ...p.slice(3)];
    if (p[2] === 'tiers') return ['scoring', 'tramer', 'tiers', { below: cfg.scoring.tramer.tiers[p[3]].below }, ...p.slice(4)];
    if (p[1] === 'colors') return ['scoring', 'colors', { name: cfg.scoring.colors[p[2]].name }, ...p.slice(3)];
    return p;
  }

  function resolveTuneKey(cfg, k) {
    const i = k.findIndex((x) => x && typeof x === 'object');
    if (i < 0) return k;
    const arr = getPath(cfg, k.slice(0, i));
    const [[field, value]] = Object.entries(k[i]);
    const j = Array.isArray(arr) ? arr.findIndex((x) => x && x[field] === value) : -1;
    return j < 0 ? null : [...k.slice(0, i), j, ...k.slice(i + 1)];
  }

  // Sadece kaydırılan alanları güncel ayarın üstüne yazar; bu arada başka bilgisayardan gelen ayar kaybolmaz
  function applyTuned(src) {
    const cfg = loadConfig();
    for (const k of state.tuneDirty.values()) {
      const from = resolveTuneKey(src, k);
      const to = resolveTuneKey(cfg, k);
      if (from && to) setPath(cfg, to, getPath(src, from));
    }
    saveConfig(cfg);
  }

  // ----- Arama ve özellik filtresi (bu bilgisayara özel, eşitlenmez) -----
  const loadFilter = () => ({ ...EMPTY_FILTER, ...GM_getValue('filter', {}) });
  const saveFilter = (f) => GM_setValue('filter', f);
  const curFilter = () => state.filter || (state.filter = loadFilter());
  const claudeLabel = () => (filterActive(curFilter()) ? 'Claude için kopyala (filtreli)' : 'Claude için kopyala');

  function renderFilter(result) {
    const f = curFilter();
    const colors = new Map();
    for (const r of result.all) {
      const c = colorOf(r.l);
      if (c) colors.set(c.key, { name: c.name, n: ((colors.get(c.key) || {}).n || 0) + 1 });
    }
    const num = (k, label, ph) => `<label>${label} <input type="text" inputmode="numeric" class="num-in" data-filter="${k}" value="${f[k] == null ? '' : esc(fmtNum(f[k]))}" placeholder="${ph}"></label>`;
    return `<div class="filter">
      <div class="frow">
        <input type="text" class="q" data-filter="q" value="${esc(f.q)}" placeholder="🔍 İlanlarda ara: first edition, melbourne, sunroof…" spellcheck="false" autocomplete="off">
        ${num('kmMax', 'KM ≤', 'ör. 50.000')}
        ${num('priceMax', 'Fiyat ≤', 'ör. 2.000.000')}
        ${num('yearMin', 'Yıl ≥', 'ör. 2021')}
        <select data-filter="color"><option value="">Renk: hepsi</option>${[...colors.entries()]
          .sort((a, b) => b[1].n - a[1].n)
          .map(([k, c]) => `<option value="${esc(k)}" ${f.color === k ? 'selected' : ''}>${esc(c.name)} (${c.n})</option>`)
          .join('')}</select>
        <label title="Mutlak filtrelere takılan ilanları da ara"><input type="checkbox" data-filter="withRejected" ${f.withRejected ? 'checked' : ''}> elenenler dahil</label>
      </div>
      <div class="frow" data-facets>${facetChips(result)}</div>
    </div>`;
  }

  // Özellik düğmeleri: tıkladıkça "var olsun" → "olmasın" → "fark etmez". Sayı: bu özellik de istenirse kaç ilan kalır.
  function facetChips(result) {
    const f = curFilter();
    const cfg = state.tuneCfg || loadConfig();
    const counts = facetCounts(result, f, cfg);
    const chips = filterFacets(cfg).map((x) => {
      const v = (f.has || {})[x.key];
      const cls = v === true ? 'yes' : v === false ? 'no' : counts[x.key] ? '' : 'zero';
      const label = v === true ? `✓ ${x.name}` : v === false ? `✗ ${x.name}` : x.name;
      const tip = v === true ? 'Sadece kesin olanlar (metin, fotoğraf ya da senin kararın). Tıkla: olmasın' : v === false ? 'Bu özelliği kesin olanlar çıkarıldı. Tıkla: fark etmez' : 'Tıkla: var olsun';
      return `<button class="chip ${cls}" data-facet="${esc(x.key)}" title="${esc(tip)}">${esc(label)}${v === undefined ? `<span class="n">${counts[x.key]}</span>` : ''}</button>`;
    });
    return chips.join('') + (filterActive(f) ? '<button class="mini" data-action="filter-clear">Filtreyi temizle</button>' : '');
  }

  // Filtre değişti: sadece düğmeleri ve listeyi yeniden çiz, yazdığın kutuya dokunma
  function refreshFiltered() {
    const result = computeRows(state.allCache || loadAllListings(), state.tuneCfg || loadConfig());
    const box = root.querySelector('[data-ranking]');
    if (box) box.innerHTML = rankingBody(result);
    const fc = root.querySelector('[data-facets]');
    if (fc) fc.innerHTML = facetChips(result);
    const cb = root.querySelector('[data-action="claude"]');
    if (cb) cb.textContent = claudeLabel();
  }

  function renderRanking(result) {
    let html = `<div class="bar">
      <button class="primary" data-action="ai" ${aiRunning ? 'disabled' : ''}>Yerel AI analizini çalıştır</button>
      ${aiRunning ? '<button data-action="ai-stop">Durdur</button>' : ''}
      <button data-action="claude" ${result.passed.length + result.unsure.length ? '' : 'disabled'}>${claudeLabel()}</button>
      ${loadCmp().length ? `<button data-tab="kars">Karşılaştır (${loadCmp().length})</button>` : ''}
      <span class="muted" data-status>${esc(state.status)}</span></div>`;
    html += `<details class="tune" ${state.tuneOpen ? 'open' : ''}><summary data-tune-toggle>⚙ Puanları ve filtreleri ayarla</summary>
      <p class="muted">Kaydırdıkça sıralama hemen değişir, ayar kendiliğinden kaydedilir${syncReady() ? ' ve diğer bilgisayarlarına gider' : ''}.
      <button class="mini" data-action="tune-undo" ${state.tuneStart ? '' : 'disabled'}>Başlangıca dön</button></p>${renderTune()}</details>`;
    html += renderFilter(result);
    return html + `<div data-ranking>${rankingBody(result)}</div>`;
  }

  function rankingBody(result) {
    const fromOthers = result.all.filter((r) => r.l._owner).length;
    let html = `<p class="muted">${result.all.length} ilan${fromOthers ? ` (${fromOthers} tanesi dahil ettiğin kişilerden)` : ''} · ${result.passed.length} geçti · ${result.unsure.length} doğrulanamadı · ${result.rejected.length} elendi${result.closed.length ? ` · ${result.closed.length} kapandı` : ''}</p>`;
    // Filtre açıkken tek liste: filtreye uyanlar, puana göre
    const f = curFilter();
    if (filterActive(f)) {
      const rows = applyFilter(result, f);
      const pool = result.passed.length + result.unsure.length + (f.withRejected ? result.rejected.length : 0);
      html += `<h2>Filtreye uyan ${rows.length} ilan <span class="muted">(${pool} ${f.withRejected ? 'açık ilan' : 'geçen ve doğrulanamayan ilan'} içinde, puana göre)</span></h2>`;
      return html + (rows.length ? table(rows, 0) : '<p class="muted">Bu filtreye uyan ilan yok. Bir seçimi kaldırmayı dene; özellik düğmelerindeki sayılar o özellik de seçilirse kaç ilan kalacağını gösteriyor.</p>');
    }
    // Takip ettiklerin üstte bir kez gösterilir; alttaki tablolarda tekrar edilmez (aynı ilanın iki not alanı olmasın)
    const tracked = new Set(result.tracked.map((r) => r.l.id));
    const rest = (rows) => rows.filter((r) => !tracked.has(r.l.id));
    if (result.tracked.length) html += `<h2>Takip ettiklerin <span class="muted">(ilerlemiş olan önce)</span></h2>` + table(result.tracked, 0);
    const passed = rest(result.passed);
    const inTop = result.passed.slice(0, MAX_TOP).filter((r) => tracked.has(r.l.id)).length;
    html += `<h2>En iyi ${MAX_TOP}${inTop ? ` <span class="muted">(${inTop} tanesi yukarıda, takip ettiklerinde)</span>` : ''}</h2>` + table(passed.slice(0, MAX_TOP - inTop), 0);
    if (passed.length > MAX_TOP - inTop) {
      html += `<h2>Filtreyi geçen diğer ${passed.length - (MAX_TOP - inTop)} ilan <span class="muted">(puana göre)</span></h2>` + table(passed.slice(MAX_TOP - inTop), MAX_TOP - inTop);
    }
    const unsure = rest(result.unsure);
    if (unsure.length) {
      html += `<h2>Kontrol edilecekler <span class="muted">(ilandan doğrulanamayan şartlar — ilana bakıp kendin işaretle)</span></h2>` + table(unsure.slice(0, MAX_TOP), 0);
    }
    if (result.rejected.length) {
      html += `<details ${state.rejOpen ? 'open' : ''}><summary data-rej-toggle>Elenen ${result.rejected.length} ilan</summary><ul>${result.rejected
        .map((r) => `<li><a href="${esc(safeUrl(r.l.url))}" target="_blank">${esc(r.l.title)}</a>${statusChip(r.l)} <span class="bad">${esc(r.hard.fails.join(', '))}</span>${r.hard.decided
          .filter((d) => !d.ok)
          .map((d) => manualBtns(r.l.id, d.key, d.yes, d.no, false, !d.by))
          .join('')}</li>`)
        .join('')}</ul></details>`;
    }
    if (result.closed.length) {
      html += `<details ${state.closedOpen ? 'open' : ''}><summary data-closed-toggle>Kapananlar: ${result.closed.length} ilan <span class="muted">(vazgeçilen ya da satılan; sıralamaya ve AI analizine girmez)</span></summary><ul>${result.closed
        .map((r) => `<li><a href="${esc(safeUrl(r.l.url))}" target="_blank">${esc(r.l.title)}</a>${statusChip(r.l)} <span class="muted">${esc(trackOf(r.l).note.slice(0, 120))}</span>
          <button class="mini" data-track-status="" data-id="${esc(r.l.id)}" title="Durumu temizle, ilan sıralamaya geri dönsün">geri al</button></li>`)
        .join('')}</ul></details>`;
    }
    return html;
  }

  // ----- Benim sıralamam: elle sırala, o sıralamayı veren puanları bul, genel listeye uygula -----
  const MIN_CALIB = 8; // bundan az ilanla öneri gürültülü

  // "Önemli" düğmeleri: KM, fiyat, model yılı ve kriterler (tramer ve renkler işaretlenemez)
  function impChips(cfg) {
    const on = importantOf(cfg);
    return calibComponents(cfg)
      .filter(floorable)
      .map((c) => `<button class="chip ${on.includes(c.key) ? 'yes' : ''}" data-important="${esc(c.key)}" title="${on.includes(c.key) ? 'Önemli. Tıkla: sıralamadan öğrenilsin' : 'Tıkla: önemli say'}">${on.includes(c.key) ? '★ ' : ''}${esc(c.label)}</button>`)
      .join('');
  }
  function renderMyRank(result) {
    const all = state.allCache || loadAllListings();
    const cfg = loadConfig();
    const order = loadOrder().filter((id) => all[id]);
    const byId = new Map(result.all.map((r) => [String(r.l.id), r]));
    const generalPos = new Map();
    result.passed.forEach((r, i) => generalPos.set(String(r.l.id), i + 1));
    const cal = calibrate(all, order, cfg);
    // Önemli işaretlemenin uyuma maliyeti: işaretsiz hesapla karşılaştır
    const calFree = cal && importantOf(cfg).length ? calibrate(all, order, cfg, { important: [] }) : null;
    const sugScore = cal ? new Map(order.map((id) => [id, scoreListing(all[id], cal.suggested).total])) : null;
    const sugPos = sugScore ? new Map([...order].sort((a, b) => sugScore.get(b) - sugScore.get(a)).map((id, i) => [id, i + 1])) : null;
    const pct = (x) => (x == null ? '–' : '%' + Math.round(x * 100));

    let html = `<p class="muted">Beğendiğin ilanları kendi önceliğine göre diz: en iyisi en üstte. Hepsini sıralaman gerekmez; ${MIN_CALIB}–15 ilan yeter.
      Her değişiklikte asistan, bu sıralamayı en iyi veren puanları hesaplar. Uygun bulursan <b>Ayarları Genel Listeye Uygula</b> ile genel sıralamanın ayarı yaparsın.</p>`;
    if (cal) {
      const better = cal.after > cal.before + 1e-9;
      html += `<div class="calib"><div>Sıraladığın ${cal.n} ilanın ${cal.pairs} ikilisinde puanların seninle aynı sırayı verme oranı:</div>
        <div><span class="big">${pct(cal.before)}</span> şimdiki ayarlarla → <span class="big ${better ? 'good' : ''}">${pct(cal.after)}</span> önerilen ayarlarla</div>
        ${cal.n < MIN_CALIB ? `<div class="warn">Öneri için en az ${MIN_CALIB} ilan sıralamanı öneririm; az ilanla hesap rastlantısal farklara takılabilir.</div>` : ''}
        <div class="imp"><span>Önemli bulduğun bileşenler:</span>${impChips(cfg)}</div>
        <div class="muted">İşaretlediğin her bileşen toplam puanın en az %${Math.round(IMPORTANT_SHARE * 100)}'unu (${cal.floor} puan) alır, kalan puanlar sıralamandan öğrenilir. Az ilanla sıralama bir bileşenin ne kadar önemli olduğunu tek başına söyleyemeyebilir; burada sen söylersin.</div>
        ${calFree && calFree.after > cal.after + 1e-9 ? `<div class="muted">Önemli işaretlemeseydin uyum ${pct(calFree.after)} olurdu; aradaki fark, önemli dediğin bileşenlere ayrılan pay yüzünden sıralamanla ters düşen ikililer.</div>` : ''}
        ${cal.important.filter((x) => !x.learned).map((x) => `<div class="warn">${esc(x.label)} sıraladığın ilanlarda hep aynı, öğrenilemedi. Sıralamana farklı ${x.key === 'year' ? 'model yıllarından' : 'değerlerde'} ilan ekle.</div>`).join('')}
        <div class="bar" style="margin:8px 0 0"><button class="primary" data-action="rank-apply" ${better ? '' : 'disabled'}>Ayarları Genel Listeye Uygula</button>
        <button data-action="rank-clear">Sıralamayı temizle</button><span class="muted" data-status>${esc(state.status)}</span></div></div>`;
      const changed = cal.changes.filter((c) => c.from !== c.to);
      html += `<details ${state.calibOpen ? 'open' : ''}><summary data-calib-toggle>Önerilen puanlar (${changed.length} değişiklik)</summary>
        <table class="chg"><thead><tr><th>Bileşen</th><th class="num">Şimdi</th><th class="num">Önerilen</th></tr></thead><tbody>${cal.changes
          .map((c) => `<tr class="${c.from !== c.to ? '' : 'muted'}"><td>${esc(c.label)}${c.important ? ' <span title="Önemli işaretledin">★</span>' : ''}</td><td class="num">${c.km ? fmtNum(c.from) : c.from}</td><td class="num ${c.from !== c.to ? 'to' : ''}">${c.km ? fmtNum(c.to) : c.to}</td></tr>`)
          .join('')}</tbody></table>
        <p class="muted">Fiyat ve model yılı puanı yeni: önerilen ayarda fiyat ${fmtTL(cal.suggested.scoring.price.best)} ve altı tam puan, ${fmtTL(cal.suggested.scoring.price.worst)} ve üstü 0; model yılı ${cal.suggested.scoring.year.best} ve sonrası tam puan, ${cal.suggested.scoring.year.worst} ve öncesi 0. Mutlak filtreler değişmez.</p></details>`;
    } else if (order.length) {
      html += `<div class="calib warn">Puan önerisi için en az 3 ilan sırala.<div class="bar" style="margin:8px 0 0"><button data-action="rank-clear">Sıralamayı temizle</button></div></div>`;
    }

    html += `<h2>Senin sıralaman (${order.length})</h2>`;
    html += order.length
      ? `<ol class="myrank">${order
          .map((id, i) => {
            const r = byId.get(id);
            const l = all[id];
            const g = generalPos.get(id);
            const st = r ? r.hard.status : null;
            const where = g ? `genel listede #${g}` : st === 'elendi' ? 'elendi' : st === 'belirsiz' ? 'doğrulanamadı' : isClosed(l) ? 'kapandı' : '';
            const sp = sugPos ? sugPos.get(id) : null;
            return `<li draggable="true" data-rank-id="${esc(id)}"><span class="grip" title="Sürükle">⠿</span><span class="pos">${i + 1}</span>
              <span class="t"><a href="${esc(safeUrl(l.url))}" target="_blank">${esc(l.title)}</a>${statusChip(l)}<div class="meta">${fmtTL(l.price)} · ${fmtNum(l.km)} km · ${esc(l.year ?? '–')} · ${where}${sp ? ` · öneriyle ${sp}. sırada${sp !== i + 1 ? (sp < i + 1 ? ' ↑' : ' ↓') : ' ✓'}` : ''}</div></span>
              <span class="mbtns"><button class="mini" data-rank-move="up" data-id="${esc(id)}" ${i ? '' : 'disabled'}>↑</button><button class="mini" data-rank-move="down" data-id="${esc(id)}" ${i < order.length - 1 ? '' : 'disabled'}>↓</button><button class="mini" data-rank-remove="${esc(id)}" title="Sıralamadan çıkar">×</button></span></li>`;
          })
          .join('')}</ol>`
      : '<p class="muted">Henüz ilan sıralamadın. Aşağıdan ekle.</p>';

    const inOrder = new Set(order);
    const pool = [...result.passed, ...result.unsure, ...result.rejected].filter((r) => !inOrder.has(String(r.l.id)));
    html += `<h2>Sıralamaya ekle <span class="muted">(${pool.length} ilan, şimdiki puana göre)</span></h2>`;
    html += pool.length
      ? `<table><tbody>${pool
          .map((r) => `<tr><td class="num"><button class="mini" data-rank-add="${esc(r.l.id)}">＋ ekle</button></td><td><a href="${esc(safeUrl(r.l.url))}" target="_blank">${esc(r.l.title)}</a>${statusChip(r.l)}${r.hard.status === 'elendi' ? ' <span class="bad" style="font-size:12px">elendi</span>' : ''}</td>
            <td class="num">${fmtTL(r.l.price)}</td><td class="num">${fmtNum(r.l.km)}</td><td class="num">${esc(r.l.year ?? '–')}</td><td class="num score ${scoreClass(r)}">${Math.round(r.score.total)}<span class="muted">/${r.score.max}</span></td></tr>`)
          .join('')}</tbody></table>`
      : '<p class="muted">Bütün ilanlar sıralamanda.</p>';
    return html;
  }

  // ----- Karşılaştırma: 2–4 ilan yan yana, her satırda en iyi değer vurgulu -----
  function renderCompare(result) {
    const byId = new Map(result.all.map((r) => [String(r.l.id), r]));
    const ids = loadCmp().filter((id) => byId.has(id));
    if (ids.length !== loadCmp().length) saveCmp(ids);
    const rows = ids.map((id) => byId.get(id));
    const hint = '<p class="muted">Sıralama sekmesinde ilanların solundaki kutucuklardan en az 2, en fazla 4 ilan seç.</p>';
    if (rows.length < 2) {
      return hint + (rows.length ? `<p>Seçili: <a href="${esc(safeUrl(rows[0].l.url))}" target="_blank">${esc(rows[0].l.title)}</a> <button class="mini" data-cmp-remove="${esc(rows[0].l.id)}">çıkar</button></p>` : '');
    }
    // En iyi değer: hepsi aynıysa vurgulanmaz
    const bestOf = (vals, dir) => {
      const xs = vals.filter((v) => v != null);
      if (xs.length < 2 || xs.every((v) => v === xs[0])) return () => false;
      const b = dir === 'min' ? Math.min(...xs) : Math.max(...xs);
      return (v) => v === b;
    };
    const line = (label, cells, sub = '') => `<tr><th>${esc(label)}${sub ? `<div class="muted sub">${esc(sub)}</div>` : ''}</th>${cells.join('')}</tr>`;
    const numRow = (label, get, dir, fmt) => {
      const vals = rows.map(get);
      const isBest = bestOf(vals, dir);
      return line(label, vals.map((v) => `<td class="${isBest(v) ? 'best' : ''}">${v == null ? '<span class="muted">?</span>' : fmt(v)}</td>`));
    };
    const info = (r, k) => {
      const key = Object.keys(r.l.info || {}).find((x) => fold(x) === fold(k));
      return key ? r.l.info[key] : '';
    };
    let html = `<div class="bar"><button data-action="cmp-claude">Bu karşılaştırmayı Claude için kopyala</button><button data-action="cmp-clear">Seçimi temizle</button><span class="muted" data-status>${esc(state.status)}</span></div>`;
    html += '<table class="cmp"><thead><tr><th></th>';
    html += rows.map((r) => {
      const img = safeImg((r.l.images || [])[0]);
      return `<th>${img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}<a href="${esc(safeUrl(r.l.url))}" target="_blank">${esc(r.l.title)}</a>${statusChip(r.l)}
        <div><button class="mini" data-cmp-remove="${esc(r.l.id)}">çıkar</button></div></th>`;
    }).join('') + '</tr></thead><tbody>';
    html += numRow('Puan', (r) => Math.round(r.score.total), 'max', (v) => `<b>${v}</b><span class="muted">/${rows[0].score.max}</span>`);
    html += numRow('Fiyat', (r) => r.l.price, 'min', fmtTL);
    html += numRow('Piyasaya göre', (r) => (r.market ? Math.round(r.market.diff * 1000) / 10 : null), 'min', (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`);
    html += numRow('Yıl', (r) => r.l.year, 'max', (v) => esc(String(v)));
    html += numRow('KM', (r) => r.l.km, 'min', fmtNum);
    html += numRow('Tramer', (r) => r.score.tramer.amount, 'min', (v) => (v === 0 ? 'kayıt yok' : fmtTL(v)));
    const nonOrig = (r) => Object.entries(r.l.parts || {}).filter(([, st]) => st !== 'orijinal');
    const someDirty = rows.some((r) => nonOrig(r).length || !Object.keys(r.l.parts || {}).length);
    html += line('Boya / değişen', rows.map((r) => {
      const p = r.l.parts || {};
      if (!Object.keys(p).length) return '<td class="muted">okunamadı</td>';
      const bad = nonOrig(r);
      return `<td class="${!bad.length && someDirty ? 'best' : ''}">${bad.length ? esc(bad.map(([k, st]) => `${k}: ${st}`).join(', ')) : 'tümü orijinal'}</td>`;
    }));
    const feats = (rows[0].hard.feats || []).map((f) => f.name);
    for (const name of feats) {
      html += line(name, rows.map((r) => {
        const f = (r.hard.feats || []).find((x) => x.name === name);
        return `<td class="${f && f.ok === true ? 'good' : f && f.ok === false ? 'bad' : 'warn'}">${f ? (f.ok === true ? '✓' : f.ok === false ? '✗' : '?') : '–'} <span class="muted sub">${esc(f ? f.via : '')}</span></td>`;
      }), 'şart');
    }
    for (const name of rows[0].score.lines.map((x) => x.name).filter((n) => n !== 'KM' && n !== 'Tramer')) {
      html += line(name, rows.map((r) => {
        const x = r.score.lines.find((y) => y.name === name);
        return x ? `<td class="${x.points > 0 ? 'good' : ''}">${x.points > 0 ? '✓' : '✗'} ${Math.round(x.points)}/${x.max}${x.pending ? ' ⏳' : ''} <div class="muted sub">${esc(x.via || '')}</div></td>` : '<td>–</td>';
      }), 'puan');
    }
    for (const k of ['Renk', 'Kimden', 'Motor Gücü', 'Vites']) {
      if (rows.some((r) => info(r, k))) html += line(k, rows.map((r) => `<td>${esc(info(r, k)) || '<span class="muted">–</span>'}</td>`));
    }
    html += line('Uyarılar', rows.map((r) => `<td>${r.flags.length ? r.flags.map((f) => `<div class="warn">${esc(f)}</div>`).join('') : '<span class="muted">yok</span>'}</td>`));
    html += line('Yerel AI', rows.map((r) => {
      const t = r.l.ai && r.l.ai.text;
      return `<td>${t && !t.error ? esc(t.ozet) : '<span class="muted">analiz yok</span>'}</td>`;
    }));
    html += line('Durum ve not', rows.map((r) => `<td>${trackBlock(r.l)}</td>`));
    return html + '</tbody></table>';
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
      svg += `<a href="${esc(safeUrl(r.l.url))}" target="_blank"><circle class="dot ${cls}" cx="${X(r.l.km)}" cy="${Y(r.l.price)}" r="${cls === 'top' ? 6 : 4.5}"><title>${esc(r.l.title)}\n${fmtTL(r.l.price)} · ${fmtNum(r.l.km)} km · ${esc(r.l.year ?? '')}</title></circle></a>`;
    }
    return svg + '</svg>';
  }

  function renderAccuracy() {
    const acc = Object.values(visionAccuracy(loadListings(), loadConfig()));
    if (!acc.length) return '';
    const total = acc.reduce((a, x) => a + x.n, 0);
    let html = `<h2>Yerel AI'ın fotoğraf isabeti</h2><p class="muted">AI'ın fotoğraftan verdiği cevap, aynı kriter için <b>Var/Yok</b> ile verdiğin kararla karşılaştırılır. AI analizinden sonra ilanlara bakıp işaretledikçe dolar${total ? '' : '; henüz karşılaştırılacak ilan yok'}.</p>`;
    if (!total) return html;
    html += `<table><thead><tr><th>Kriter</th><th class="num">Karşılaştırılan</th><th class="num">İsabet</th><th class="num">Yanlış "var"</th><th class="num">Yanlış "yok"</th><th class="num">Cevap çıkmadı</th></tr></thead><tbody>${acc
      .map((x) => {
        const pct = x.n ? Math.round((x.agree / x.n) * 100) : null;
        return `<tr><td>${esc(x.name)}</td><td class="num">${x.n}</td><td class="num ${pct == null ? '' : pct >= 80 ? 'good' : pct >= 60 ? 'warn' : 'bad'}">${pct == null ? '–' : pct + '%'}</td><td class="num">${x.wrongYes.length}</td><td class="num">${x.wrongNo.length}</td><td class="num">${x.noAnswer}</td></tr>`;
      })
      .join('')}</tbody></table>`;
    const wrong = acc.flatMap((x) => [...x.wrongYes.map((w) => ({ ...w, c: x.name, said: 'var' })), ...x.wrongNo.map((w) => ({ ...w, c: x.name, said: 'yok' }))]);
    if (wrong.length) {
      html += `<details><summary>AI'ın yanıldığı ${wrong.length} durum</summary><ul>${wrong
        .map((w) => `<li>${esc(w.c)}: AI "${w.said}" dedi (${Number(w.yes) || 0} evet / ${Number(w.no) || 0} hayır) · <a href="${esc(safeUrl(w.url))}" target="_blank">${esc(w.title)}</a></li>`)
        .join('')}</ul></details>`;
    }
    return html;
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
    html += renderAccuracy();
    if (cheap.length) {
      html += '<h2>Kriterleri geçenler içinde piyasaya göre en uygunlar</h2><ul>';
      html += cheap.map((r) => `<li><a href="${esc(safeUrl(r.l.url))}" target="_blank">${esc(r.l.title)}</a> · ${fmtTL(r.l.price)} · ${marketCell(r)}</li>`).join('');
      html += '</ul>';
    }
    return html;
  }

  function renderRefs() {
    const withRef = (loadConfig().scoring.criteria || []).filter((c) => c.vision && (c.referenceImages || []).length);
    if (!withRef.length) return '';
    return `<b>Örnek fotoğraflar</b> <span class="muted">(yerel AI bu kriterlerde ilan fotoğraflarını bunlarla karşılaştırır)</span><div class="refs">${withRef
      .map((c) => `<figure><img src="${esc(safeImg(c.referenceImages[0]))}" alt="" referrerpolicy="no-referrer">${esc(c.name)} <button class="mini" data-ref-clear="${esc(c.id)}">kaldır</button></figure>`)
      .join('')}</div>`;
  }

  function renderSettings() {
    const backup = GM_getValue('configBackup', null);
    const by = GM_getValue('configBy', '');
    const at = GM_getValue('configAt', 0);
    const fmtAt = (t) => new Date(t).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    return `<p class="muted">Ayarları JSON olarak düzenle. Puanlar ve filtreler kaydettiğin anda tüm ilanlara yeniden uygulanır, sayfaları tekrar gezmen gerekmez.
      Sayıları denemek için Sıralama sekmesindeki <b>Puanları ve filtreleri ayarla</b> kaydırıcıları daha hızlı.
      <br>Kriterlerde <code>keywords</code> ilan metninde aranır; <code>vision</code> varsa metinde bulunamadığında fotoğraflar yerel AI'a sorulur; <code>allOf</code> diğer kriterlerin hepsi sağlanınca geçerli olur.
      Donanımlarda <code>unsureKeywords</code>: ilanda sadece bunlar geçiyorsa "var" sayılmaz, sana sorulur.
      ${syncReady() ? '<br>Ayarlar, kişi adın aynı olan bütün bilgisayarlarında ortak; en son kaydedilen geçerli.' : ''}
      ${at ? `<br>Son kayıt: ${esc(fmtAt(at))}${by ? ` (${esc(by)})` : ''}.` : ''}</p>
      ${renderRefs()}
      <textarea data-config spellcheck="false">${esc(JSON.stringify(loadConfig(), null, 2))}</textarea>
      <div class="bar" style="margin-top:8px">
        <button class="primary" data-action="cfg-save">Kaydet</button>
        <button data-action="cfg-export">Dosyaya indir</button>
        <button data-action="cfg-import">Dosyadan yükle</button>
        <button data-action="cfg-reset">Varsayılana dön</button>
        ${backup ? `<button data-action="cfg-restore" title="${esc(backup.from ? backup.from + ' bilgisayarından gelen ayarlar yüklenmeden önceki hali' : 'Önceki hali')}">Önceki ayarları geri yükle (${esc(fmtAt(backup.at))})</button>` : ''}
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
      <p class="muted">Veriler bu tarayıcıda, Tampermonkey'in deposunda durur. Paylaşım sekmesinde GitHub bağlantısı kurduysan kendi ilanların özel veri reposuna da kaydedilir; kurmadıysan hiçbir yere gönderilmez. Yerel AI sadece kendi bilgisayarındaki Ollama'ya gider.</p>`;
  }

  // checked: ekranda o an işaretli olanlar (liste yenilenirken kullanıcının tıkladıkları kaybolmasın)
  function includeList(checked) {
    const s = loadShare();
    const others = Object.entries(loadSyncMeta().users || {}).filter(([u]) => u !== s.user);
    const on = checked || s.include;
    return others.length
      ? others.map(([u, n]) => `<label class="check"><input type="checkbox" data-include="${esc(u)}" ${on.includes(u) ? 'checked' : ''}> ${esc(u)} <span class="muted">(${n} ilan)</span></label>`).join('')
      : `<p class="muted">${syncReady() ? 'Veri reposunda henüz senden başka kimse yok.' : 'Eşitlemeden sonra veri reposundaki diğer kullanıcılar burada listelenir.'}</p>`;
  }

  function refreshIncludes() {
    const el = root && root.querySelector('[data-includes]');
    if (!el) return;
    const checked = [...el.querySelectorAll('[data-include]')].filter((x) => x.checked).map((x) => x.dataset.include);
    el.innerHTML = includeList(el.querySelector('[data-include]') ? checked : null);
  }

  function renderShare() {
    const s = loadShare();
    const m = loadSyncMeta();
    const hasToken = !!getToken();
    const last = m.last ? `son seferde ${m.last.pushed} ilan gönderildi, ${m.last.pulledOwn + m.last.pulledOthers} ilan alındı` : '';
    const me = personOf(s.user);
    const dev = s.user.includes('-') ? s.user.slice(me.length + 1) : '';
    return `<p class="muted">İlanların, analizlerin ve ayarların GitHub'daki özel veri reposunda, kendi klasöründe saklanır.
      Kullanıcı adının tireden önceki kısmı aynı olan bütün bilgisayarlar (efe-windows, efe-mac) tek kişi sayılır: aynı ilanları, analizleri ve ayarları görür, birbirinin üstüne yazabilir.
      Başkalarının klasörüne hiç yazılmaz: onların verisini dahil edersen sende görünür, bir şeyini değiştirirsen değişiklik senin klasörüne kendi kopyan olarak kaydedilir.</p>
      <div class="form">
        <label>Veri reposu <input data-share="repo" value="${esc(s.repo)}" spellcheck="false"></label>
        <label>Kullanıcı adın <input data-share="user" value="${esc(s.user)}" placeholder="ör. efe-windows" spellcheck="false" autocomplete="off"></label>
        <span class="muted hint">${s.user ? `Kişi: <b>${esc(me)}</b>${dev ? ` · bu bilgisayar: <b>${esc(dev)}</b>` : ''}. ` : ''}Biçim: kişi-bilgisayar (efe-windows, efe-mac). Küçük harf ve rakam; arkadaşların kendi adlarıyla başlasın.</span>
        <label>GitHub token <input data-share="token" type="password" placeholder="${hasToken ? 'Kayıtlı. Değiştirmek için yenisini yapıştır.' : 'github_pat_…'}" autocomplete="off" spellcheck="false"></label>
        <label class="check"><input type="checkbox" data-share="auto" ${s.auto ? 'checked' : ''}> Otomatik eşitle (ilan kaydedince, karar verince, AI analizi bitince)</label>
        <label class="check"><input type="checkbox" data-share="readOnly" ${s.readOnly ? 'checked' : ''}> Sadece oku: veri reposuna hiçbir şey gönderme. Sana salt okunur bir token verildiyse işaretle; başkalarının ilanlarını, kararlarını ve notlarını çekersin, seninkiler bu tarayıcıda kalır.</label>
      </div>
      <h2>Kimlerin verisini dahil edeyim?</h2>
      <div data-includes>${includeList(null)}</div>
      <div class="bar" style="margin-top:12px">
        <button class="primary" data-action="share-save">Kaydet ve eşitle</button>
        ${hasToken ? '<button data-action="token-clear">Token\'ı bu tarayıcıdan sil</button>' : ''}
        <span class="muted" data-status>${esc(state.status)}</span>
      </div>
      <p class="muted">${esc(syncLabel())}${last ? ' · ' + esc(last) : ''}${m.error ? `<br><span class="bad">${esc(m.error)}</span>` : ''}</p>`;
  }

  function render() {
    if (!root) return;
    flushTune(); // kaydırıcıda kaydedilmemiş değişiklik varsa yeniden çizmeden önce kaydet
    const queue = loadQueue();
    const count = countListings();
    let fab = '<div class="fab">';
    let card = '';
    if (!state.open && isDetailPage() && state.currentId) {
      const v = loadAllListings()[state.currentId];
      if (v) {
        fab += `<button data-action="card">📝 ${trackOf(v).status && !trackOf(v).by ? esc(statusInfo(trackOf(v).status).label) : 'Not / durum'}</button>`;
        if (state.cardOpen) card = `<div class="card"><h3>${esc(v.title)}</h3>${trackBlock(v)}</div>`;
      }
    }
    if (!state.open && isDetailPage() && queue.length) fab += `<button class="primary" data-action="next">Sonraki ilan → (${queue.length})</button>`;
    if (!state.open && !isDetailPage()) {
      const saved = new Set(Object.keys(loadAllListings()));
      const key = (u) => idFromUrl(u) || u;
      const queued = new Set(queue.map(key));
      const fresh = collectSearchLinks().filter((u) => !saved.has(key(u)) && !queued.has(key(u)));
      if (fresh.length) fab += `<button data-action="enqueue">Sayfadaki ${fresh.length} yeni ilanı kuyruğa ekle</button>`;
    }
    fab += `<button data-action="toggle">🚗 Asistan (${count})</button></div>`;

    let panel = '';
    if (state.open) {
      const cfg = loadConfig();
      state.allCache = loadAllListings();
      const result = computeRows(state.allCache, cfg);
      const known = new Set(Object.keys(state.allCache || {}));
      const nCmp = loadCmp().filter((id) => known.has(id)).length;
      const tabs = [['sira', 'Sıralama'], ['benim', 'Benim sıralamam'], ['kars', `Karşılaştır${nCmp ? ` (${nCmp})` : ''}`], ['analiz', 'Piyasa analizi'], ['ayar', 'Ayarlar'], ['veri', 'Veri'], ['paylasim', 'Paylaşım']];
      const views = { sira: () => renderRanking(result), benim: () => renderMyRank(result), kars: () => renderCompare(result), analiz: () => renderAnalysis(result), ayar: renderSettings, veri: renderData, paylasim: renderShare };
      const body = (views[state.tab] || views.sira)();
      const sl = syncLabel();
      panel = `<div class="panel"><div class="head"><h1>Araç Asistanı</h1>${tabs
        .map(([k, n]) => `<button class="tab ${state.tab === k ? 'on' : ''}" data-tab="${k}">${n}</button>`)
        .join('')}<span class="spacer"></span>${sl ? `<button class="tab sync" data-action="sync-now" data-sync title="Şimdi eşitle">${esc(sl)}</button>` : ''}<button data-action="toggle">Kapat</button></div><div class="body">${body}</div></div>`;
    }
    const scroll = root.querySelector('.body')?.scrollTop || 0;
    // Not yazarken eşitleme ya da AI analizi paneli yeniden çizerse odak ve imleç yerinde kalsın
    const a = root.activeElement;
    const focus = a && a.matches && a.matches('textarea[data-note]') ? { id: a.dataset.note, s: a.selectionStart, e: a.selectionEnd, inCard: !!a.closest('.card') } : null;
    root.innerHTML = `<style>${CSS}</style><div class="wrap">${panel}${card}${fab}</div>`;
    queueDecorate(); // durum, karar ya da ayar değiştiyse arama listesindeki rozetler de değişsin
    const b = root.querySelector('.body');
    if (b) b.scrollTop = scroll;
    if (focus) {
      const ta = [...root.querySelectorAll('textarea[data-note]')].find((x) => x.dataset.note === focus.id && !!x.closest('.card') === focus.inCard);
      if (ta) {
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(focus.s, focus.e);
      }
    }
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
    if (s.colors !== undefined && (!Array.isArray(s.colors) || s.colors.some((c) => !c || typeof c.name !== 'string' || typeof c.points !== 'number'))) {
      throw new Error('scoring.colors şu biçimde olmalı: [{ "name": "Siyah", "points": 10 }, …]');
    }
    for (const k of ['price', 'year']) {
      if (s[k] !== undefined && !['points', 'best', 'worst'].every((f) => typeof s[k][f] === 'number')) throw new Error(`scoring.${k} içinde points, best ve worst sayı olmalı.`);
    }
    if (c.calibration !== undefined && !(c.calibration && Array.isArray(c.calibration.order))) throw new Error('calibration.order bir liste olmalı.');
    const imp = c.calibration && c.calibration.important;
    if (imp !== undefined && !(Array.isArray(imp) && imp.every((x) => typeof x === 'string'))) throw new Error('calibration.important bir liste olmalı.');
    const ids = new Set();
    for (const cr of s.criteria) {
      if (!cr.id || !cr.name || typeof cr.points !== 'number') throw new Error('Her kriterde id, name ve points olmalı.');
      if (ids.has(cr.id)) throw new Error(`Kriter id'si tekrar ediyor: ${cr.id}`);
      if (cr.referenceImages !== undefined && (!Array.isArray(cr.referenceImages) || cr.referenceImages.some((u) => !safeImg(u)))) {
        throw new Error(`${cr.id}.referenceImages sadece https://i0.shbdn.com/… fotoğraf adresleri içerebilir.`);
      }
      if (cr.views !== undefined && (!Array.isArray(cr.views) || cr.views.some((v) => !VIEWS.includes(v)))) {
        throw new Error(`${cr.id}.views şu türlerden oluşmalı: ${VIEWS.join(', ')}`);
      }
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
      render();
      // Paylaşım sekmesinde kişi listesi güncel olsun (yazdıklarına dokunmadan sadece liste yenilenir)
      if (state.tab === 'paylasim' && syncReady()) {
        syncNow().then(
          (r) => { refreshIncludes(); afterSync(r); },
          () => afterSync(null)
        );
      }
      return;
    }
    // Ayrıntılar açık/kapalı durumu render sonrası korunsun (açma işini tarayıcı yapar)
    // Benim sıralamam: bileşeni önemli say / sayma (ayarlarla birlikte diğer bilgisayarlarına gider)
    const impBtn = e.target.closest('[data-important]');
    if (impBtn) {
      const cfg = loadConfig();
      const k = impBtn.dataset.important;
      const cur = importantOf(cfg);
      cfg.calibration = { order: [], ...(cfg.calibration || {}), important: cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k] };
      saveConfig(cfg);
      return render();
    }
    // Özellik düğmesi: var olsun → olmasın → fark etmez
    const facet = e.target.closest('[data-facet]');
    if (facet) {
      const f = curFilter();
      const has = { ...(f.has || {}) };
      const k = facet.dataset.facet;
      if (has[k] === undefined) has[k] = true;
      else if (has[k] === true) has[k] = false;
      else delete has[k];
      f.has = has;
      saveFilter(f);
      return refreshFiltered();
    }
    if (e.target.closest('summary[data-tune-toggle]')) {
      state.tuneOpen = !state.tuneOpen;
      return;
    }
    if (e.target.closest('summary[data-rej-toggle]')) {
      state.rejOpen = !state.rejOpen;
      return;
    }
    if (e.target.closest('summary[data-closed-toggle]')) {
      state.closedOpen = !state.closedOpen;
      return;
    }

    // Durum ve not
    const stBtn = e.target.closest('[data-track-status]');
    if (stBtn) return setTrack(stBtn.dataset.id, 'status', stBtn.dataset.trackStatus || null);
    const noteBtn = e.target.closest('[data-note-save]');
    if (noteBtn) {
      const ta = noteBtn.closest('.track').querySelector('textarea[data-note]');
      return setTrack(noteBtn.dataset.noteSave, 'note', ta ? ta.value.trim() : '');
    }

    // Benim sıralamam
    if (e.target.closest('summary[data-calib-toggle]')) {
      state.calibOpen = !state.calibOpen;
      return;
    }
    const rankAdd = e.target.closest('[data-rank-add]');
    if (rankAdd) {
      saveOrder([...loadOrder().filter((x) => x !== rankAdd.dataset.rankAdd), rankAdd.dataset.rankAdd]);
      return render();
    }
    const rankMove = e.target.closest('[data-rank-move]');
    if (rankMove) {
      const ids = loadOrder();
      const i = ids.indexOf(rankMove.dataset.id);
      const j = rankMove.dataset.rankMove === 'up' ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      saveOrder(ids);
      return render();
    }
    const rankRemove = e.target.closest('[data-rank-remove]');
    if (rankRemove) {
      saveOrder(loadOrder().filter((x) => x !== rankRemove.dataset.rankRemove));
      return render();
    }

    // Örnek fotoğraf
    const pickBtn = e.target.closest('[data-ref-pick]');
    if (pickBtn) {
      const same = state.refPick && state.refPick.id === pickBtn.dataset.refPick && state.refPick.cid === pickBtn.dataset.cid;
      state.refPick = same ? null : { id: pickBtn.dataset.refPick, cid: pickBtn.dataset.cid };
      return render();
    }
    const refImg = e.target.closest('[data-ref-set]');
    if (refImg) return setReference(refImg.dataset.cid, refImg.dataset.refSet);
    const refClear = e.target.closest('[data-ref-clear]');
    if (refClear) return setReference(refClear.dataset.refClear, null);

    // Karşılaştırma seçimi
    const cmpBox = e.target.closest('input[data-cmp]');
    if (cmpBox) {
      const id = cmpBox.dataset.cmp;
      const known = loadAllListings();
      const ids = loadCmp().filter((x) => x !== id && known[x]);
      if (cmpBox.checked) {
        if (ids.length >= MAX_CMP) {
          cmpBox.checked = false;
          return toast(`En fazla ${MAX_CMP} ilan karşılaştırılabilir. Önce birini çıkar.`);
        }
        ids.push(id);
      }
      saveCmp(ids);
      return render();
    }
    const cmpRemove = e.target.closest('[data-cmp-remove]');
    if (cmpRemove) {
      saveCmp(loadCmp().filter((x) => x !== cmpRemove.dataset.cmpRemove));
      return render();
    }
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
      const id = mBtn.dataset.manual;
      let l = getListing(id);
      let copied = false;
      if (!l) {
        // Dahil ettiğin birinin ilanı: onunkine dokunmadan sende kopyası oluşur
        const view = loadAllListings()[id];
        if (!view) return;
        l = ownCopyOf(view);
        copied = true;
      }
      const key = mBtn.dataset.key;
      const raw = mBtn.dataset.val;
      l.manual = { ...(l.manual || {}), [key]: { v: raw === '' ? null : raw === '1', at: Date.now() } };
      putListing(l);
      scheduleSync();
      render();
      const note = copied ? ` · ilanın kopyası senin verine eklendi (kaynak: ${l.copiedFrom})` : '';
      if (raw === '') return toast('Kontrol geri alındı.' + note);
      const hard = evalHard(loadAllListings()[id] || l, loadConfig());
      const where = hard.status === 'gecti' ? '✓ artık filtreleri geçiyor' : hard.status === 'belirsiz' ? '? başka doğrulanamayan şart var' : '✗ elendi';
      return toast(`Kaydedildi · ${where}${note}`);
    }

    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'rank-apply') {
      const cfg = loadConfig();
      const cal = calibrate(loadAllListings(), loadOrder(), cfg);
      if (!cal || !(cal.after > cal.before)) return;
      if (!confirm(`Önerilen puanlar genel sıralamanın ayarı olsun mu? Uyum ${Math.round(cal.before * 100)}% → ${Math.round(cal.after * 100)}%. Şimdiki ayarlar yedeğe alınır (Ayarlar → Önceki ayarları geri yükle).`)) return;
      GM_setValue('configBackup', { config: cfg, at: Date.now(), from: '' });
      saveConfig(validateConfig(cal.suggested));
      state.status = 'Puanlar uygulandı; genel sıralama artık senin sıralamandan öğrenilen ayarlarla.';
      return render();
    }
    if (action === 'rank-clear') {
      if (!confirm('Elle yaptığın sıralama temizlensin mi? Puan ayarlarına dokunulmaz.')) return;
      saveOrder([]);
      return render();
    }
    if (action === 'card') {
      state.cardOpen = !state.cardOpen;
      return render();
    }
    if (action === 'cmp-clear') {
      saveCmp([]);
      return render();
    }
    if (action === 'cmp-claude') {
      const cfg = loadConfig();
      const all = computeRows(loadAllListings(), cfg).all;
      const rows = loadCmp().map((id) => all.find((r) => String(r.l.id) === id)).filter(Boolean);
      const text = comparePrompt(rows, cfg);
      GM_setClipboard(text, 'text');
      return setStatus(`Kopyalandı (~${Math.round(text.length / 3.5 / 1000)}k token). claude.ai'da yeni bir sohbete yapıştır.`);
    }
    if (action === 'toggle') {
      state.open = !state.open;
      if (state.open && Date.now() - (loadSyncMeta().at || 0) > 2 * 60000) scheduleSync(300);
      return render();
    }
    if (action === 'sync-now') {
      showSync('☁ eşitleniyor…');
      try {
        afterSync(await syncNow());
      } catch (err) {
        afterSync(null);
        toast('⚠ ' + err.message, 6000);
      }
      return;
    }
    if (action === 'share-save') {
      const field = (k) => root.querySelector(`[data-share="${k}"]`);
      const user = field('user').value.trim().toLowerCase();
      const repo = field('repo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
      if (!USER_RE.test(user)) return setStatus('⚠ Kullanıcı adı "efe" ya da "efe-mac" gibi olmalı: küçük harf ve rakam, Türkçe harf yok.');
      if (!REPO_RE.test(repo)) return setStatus('⚠ Veri reposu "hesap/repo-adı" biçiminde olmalı.');
      const prev = loadShare();
      // Sadece ekranda listelenenleri güncelle: liste henüz gelmediyse (ilk eşitlemeden önce) eski seçimler kalsın
      const boxes = [...root.querySelectorAll('[data-include]')];
      const shown = new Set(boxes.map((x) => x.dataset.include));
      const include = [...(prev.include || []).filter((u) => !shown.has(u)), ...boxes.filter((x) => x.checked).map((x) => x.dataset.include)];
      const token = field('token').value.trim();
      if (token) GM_setValue('ghToken', token);
      // Bu tarayıcıda yeni bir kişi adı: o ada ait veri varsa önce sor. Aynı kişi adı = aynı veri (ilanlar, ayarlar,
      // elle sıralama); başka birinin adını seçmek onun verisinin üstüne yazar.
      const person = personOf(user);
      if (getToken() && personOf(prev.user) !== person) {
        let used = null;
        try {
          used = await personUsage(repo, prev.branch || 'main', person);
        } catch (e) {
          // erişim hatasını aşağıdaki eşitleme gösterir
        }
        if (used && (used.listings || used.settings)) {
          const what = [used.listings ? `${used.listings} ilan` : '', used.settings ? 'ayarlar ve elle sıralama' : ''].filter(Boolean).join(', ');
          const ok = confirm(`Veri reposunda "${person}" adına zaten ${what} var.\n\n`
            + 'Bu SENİN başka bilgisayarınsa Tamam\'a bas: ikisi aynı veriyi paylaşır.\n'
            + `Başka birininse İptal'e bas ve kendi adınla başlayan farklı bir kullanıcı adı seç (ör. "ali" ya da "ali-laptop"). Aynı adı kullanmak onun ilanlarının, ayarlarının ve sıralamasının üstüne yazar.`);
          if (!ok) return setStatus(`Kaydedilmedi: "${person}" adı başkasına ait olabilir, kendi adınla başlayan bir kullanıcı adı seç.`);
        }
      }
      if (personOf(prev.user) !== personOf(user) || prev.repo !== repo) {
        // Başka klasör ya da repo: eşitleme kayıtları baştan, başkalarından gelen önbellek silinir
        for (const k of otherKeys()) GM_deleteValue(k);
        saveSyncMeta({});
      }
      saveShare({ ...prev, user, repo, include, auto: field('auto').checked, readOnly: field('readOnly').checked });
      if (!getToken()) {
        state.status = 'Kaydedildi. Eşitleme için token gerekli.';
        return render();
      }
      state.status = 'Kaydedildi, eşitleniyor…';
      render();
      try {
        const r = await syncNow((m) => setStatus(m));
        state.status = r ? `Eşitlendi ✓ ${r.pushed} ilan gönderildi, ${r.pulledOwn + r.pulledOthers} ilan alındı.` : 'Eşitleme zaten sürüyordu, bitince tekrar edilecek.';
      } catch (err) {
        state.status = '⚠ ' + err.message;
      }
      return render();
    }
    if (action === 'token-clear') {
      if (!confirm('GitHub token bu tarayıcıdan silinsin mi? Eşitleme durur, GitHub\'daki verilere dokunulmaz.')) return;
      GM_deleteValue('ghToken');
      state.status = 'Token silindi.';
      return render();
    }
    if (action === 'enqueue') {
      const saved = new Set(Object.keys(loadAllListings())); // sen ya da dahil ettiğin biri zaten gezdiyse tekrar kuyruğa alma
      const q = loadQueue();
      const key = (u) => idFromUrl(u) || u;
      const queued = new Set(q.map(key));
      const add = collectSearchLinks().filter((u) => !saved.has(key(u)) && !queued.has(key(u)));
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
    if (action === 'filter-clear') {
      state.filter = { ...EMPTY_FILTER, has: {} };
      saveFilter(state.filter);
      return render();
    }
    if (action === 'claude') {
      let result = computeRows(loadAllListings(), loadConfig());
      if (filterActive(curFilter())) {
        // Filtre açıksa ekranda gördüğün ilanlar gider
        const rows = applyFilter(result, curFilter());
        result = { ...result, passed: rows.filter((r) => r.hard.status === 'gecti'), unsure: rows.filter((r) => r.hard.status === 'belirsiz') };
      }
      const text = claudePrompt(result, loadConfig());
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
    if (action === 'tune-undo') {
      if (!state.tuneStart) return;
      clearTimeout(state.tuneTimer);
      state.tuneCfg = null;
      applyTuned(state.tuneStart);
      state.tuneStart = null;
      state.tuneDirty = new Map();
      state.status = 'Puanlar ayarlamaya başlamadan önceki haline döndü.';
      return render();
    }
    if (action === 'cfg-restore') {
      const backup = GM_getValue('configBackup', null);
      if (!backup || !confirm('Başka bilgisayardan gelen ayarlardan önceki hali geri yüklensin mi? Şimdiki ayarlar yedeğe alınır.')) return;
      GM_setValue('configBackup', { config: loadConfig(), at: Date.now(), from: '' });
      saveConfig(backup.config);
      state.status = 'Önceki ayarlar geri yüklendi.';
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
        for (const l of Object.values(incoming)) if (l && l.id) putListing(mergeSame(getListing(l.id), l));
        state.status = `${Object.keys(incoming).length} ilan birleştirildi ✓`;
        scheduleSync();
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
      const synced = syncReady();
      const msg = synced
        ? 'Bu tarayıcıdaki ilanlar ve AI sonuçları silinsin mi? GitHub\'daki kopyalara dokunulmaz; otomatik eşitleme açıksa bir sonraki eşitlemede geri gelirler.'
        : 'Kayıtlı tüm ilanlar ve AI sonuçları silinsin mi? Bu geri alınamaz.';
      if (!confirm(msg)) return;
      clearListings();
      saveCmp([]);
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
        state.currentId = l.id;
        const cfg = loadConfig();
        const view = loadAllListings()[l.id] || l; // dahil ettiğin kişilerin kararları da sayılsın
        const hard = evalHard(view, cfg);
        const sc = scoreListing(view, cfg);
        const label = hard.status === 'gecti' ? '✓ filtreleri geçti' : hard.status === 'belirsiz' ? '? doğrulanamadı' : '✗ elendi: ' + hard.fails.join(', ');
        render();
        toast(`Kaydedildi · ${Math.round(sc.total)}/${sc.max} puan · ${label}`);
        scheduleSync(3000);
      } else {
        toast('İlan bilgileri okunamadı. Sayfa yapısı beklenenden farklı olabilir.');
      }
    } else {
      try {
        decorateSearch();
      } catch (e) {
        // rozetler olmasa da asistan ve eşitleme çalışmaya devam etsin
      }
      watchSearch();
      if (Date.now() - (loadSyncMeta().at || 0) > 10 * 60000) scheduleSync(5000);
    }
  }

  init();
})();
