# Sahibinden Araç Asistanı

Sahibinden.com araç ilanlarını kaydeden, filtreleyip puanlayan, yerel AI (Ollama) ile fotoğraf ve açıklama analizi yapan tek dosyalık bir Tampermonkey userscript'i. Proje iki bilgisayardan (Mac ve Windows 11) geliştiriliyor; kullanıcı arayüzü, yorumlar ve commit mesajları Türkçe.

## Dosyalar

- `sahibinden-asistan.user.js`: script'in tamamı.
- `ayarlar-bmw.json`: varsayılan ayarlar. `DEFAULT_CONFIG` ile birebir aynı olmalı (test kontrol ediyor).
- `tests/core.test.js`: saf mantığın testleri. Çalıştırma: `node tests/core.test.js` (bağımlılık yok).
- `README.md`: kullanıcı belgesi. Davranış değişirse güncelle.

## Kod yapısı

- Dosyanın üst kısmı saf mantık: filtreler, puanlama, tramer okuma, piyasa modeli, Claude metni, eşitleme birleştirme fonksiyonları. `module` tanımlıysa bunlar `module.exports` ile dışa verilir ve dosya orada döner; node testleri bu kancayı kullanır.
- Kancanın altı tarayıcıya özel: depolama (`GM_*`), sayfa okuma, Ollama, GitHub eşitlemesi, arayüz (shadow DOM). Bu kısım node'da test edilemez. Değiştirdiysen, `GM_*` ve `GM_xmlhttpRequest` taklitleri olan yerel bir test sayfasında tarayıcıda dene.
- Her ilan ayrı anahtarda: `ilan:<id>`. Aynı anda açık sekmeler birbirinin kaydını ezmesin diye tek bir büyük anahtara geri dönme.

## Kurallar

- Push edilen her değişiklikte `// @version` artır. Tampermonkey güncellemeleri `@updateURL` (bu reponun `main` dalı) üzerinden sürüme bakarak alır.
- `DEFAULT_CONFIG` değişirse `ayarlar-bmw.json`'ı da güncelle.
- Push'tan önce `node --check sahibinden-asistan.user.js` ve `node tests/core.test.js` geçmeli. Windows'ta Node `C:\Program Files\nodejs\node.exe` (açık kalan eski kabuklarda PATH'te olmayabilir).
- Script'i panoya kopyalarken macOS'ta kodlamayı belirt, yoksa Türkçe karakterler bozulur: `LANG=en_US.UTF-8 pbcopy < sahibinden-asistan.user.js`.
- Sahibinden.com sayfalarına otomatik istek atma, tarama yapma, bot kontrolünü aşmaya çalışma. Script sadece kullanıcının açtığı sayfaları okur; fotoğraflar sadece kullanıcı AI analizini başlatınca `i0.shbdn.com`'dan indirilir.

## Katkı kuralları: "Benim sıralamam"ı bozma

Proje sahibi (efe) ve arkadaşı geliştiriyor. `main`'e giren her şey Tampermonkey `@updateURL` ile herkese kendiliğinden gider; sahibinin elle sıralaması (`config.calibration`) ve ondan öğrenilmiş puanlar korunmalı:

- `config.calibration` (`order`, `important`), ilanlardaki `manual` ve `track`, `scoring` alanlarının biçimi ve anlamı değişmez. Gerekirse `loadConfig`'te geriye uyumlu geçiş yaz; eski kayıtlı ayarlar okunabilmeli.
- Kullanıcının ayarını asla toptan sıfırlama ya da ezme. Varsayılan değişirse sadece hiç değiştirilmemiş eski varsayılanı çevir (`OLD_VISION`, `OLD_KEYWORDS`).
- Puanlamaya yeni bileşen: varsayılan 0 puan, `calibComponents` / `calibFeatures`'a da ekle, `scoreListing` ile tutarlı olsun.
- `tests/core.test.js`'teki "Benim sıralamam" ve "kalibrasyon" testlerini gevşetme; kırılıyorsa kodu düzelt.
- Sahibinin veri reposuna yazma token'ıyla eşitleme denemesi yapma; kendi verinle, ayrı tarayıcı profilinde, gerekirse **Sadece oku** ile dene.
- Arkadaş fork + pull request ile çalışır; testler (GitHub Actions, `.github/workflows/test.yml`) geçmeden birleştirilmez.

## Sahibinden sayfa yapısı (Kasım 2026'da gerçek ilanla doğrulandı)

- Bilgiler: `.classifiedInfoList .classifiedInfoItem` içinde `dt` / `dd`.
- Fiyat: `.classifiedInfo h3`. Başlık: `.classifiedDetailTitle h1`. Açıklama: `#classifiedDescription`. Donanım: `#classifiedProperties li.selected`.
- Boya/değişen: `.car-parts > div`. Sınıflar parçayı (`front-hood`, `roof`…) ve durumu (`original-new`, `local-painted-new`, `painted-new`, `changed-new`) veriyor.
- Fotoğraflar: `https://i0.shbdn.com/photos/…/<önek>_<ilanNo><kod>.jpg`. Önekler `thmb_`, `x5_`, `x16_`; analizde 528 px'lik `x5_` kullanılıyor.
- Arama sonuçları (rozetler, `searchRows`): **gerçek sayfayla henüz doğrulanmadı.** Beklenen: `tr.searchResultsItem[data-id]`, başlık `a.classifiedTitle`, fiyat `.searchResultsPriceValue`. Yedek olarak ilan numarası linkten, fiyat "… TL" yazan hücreden okunuyor.
- Tramer ayrı bir alan değil, açıklamada metin olarak geçiyor (ör. "595.000TL TRAMER KAYDI VARDIR").

## Yerel AI

- Model `gemma4:12b-it-qat` (GGUF, llama.cpp). Etiketsiz `gemma4:12b` Mac'te MLX ile açılıyor, 16 GB'lık Mac'te 16 GB bellek tuttu ve takasa düşürdü; QAT 9,4 GB, fotoğraf başına ~0,6 sn, jantta da daha isabetli. İstekler `think: false` ile gidiyor; düşünme modu cevabı yaklaşık 5 kat yavaşlatıyor. Flash attention'ı açma (Gemma 4'te Apple Silicon'da takılma hatası bildirilmiş). Mac'te LaunchAgent `OLLAMA_KEEP_ALIVE=1m` da ayarlıyor.
- Fotoğraf başına tek çağrı: model hem fotoğrafın türünü (`view`) hem soruların cevabını verir. Kriterin `views` listesi varsa oy sadece o türlerden sayılır (`countPhotoAnswer`). Fotoğraflar `spreadOrder` ile galeriye yayılarak seçilir; sorular netleşince (`voteDecided`) erken durur. İsabet, Var/Yok kararlarıyla ölçülür (`visionAccuracy`); soru değiştirirken önce bu tabloya bak. Kriterde `referenceImages` varsa o kriter ayrı bir çağrıda örnek fotoğrafla karşılaştırılır (`referencePrompt`, iki görsel: önce örnek, sonra ilan fotoğrafı); örnek GM'de `ornek:<url>` anahtarıyla saklanır. Sonuçlar `visionKey(c)` (soru + örnek) ile eşleşir; soru ya da örnek değişince eski sonuçlar sayılmaz.
- Gerçek veriyle ölçüm (Kasım 2026; işaretlenmiş ilanların fotoğrafları yerelde, `exp.py` ile):
  - Eski jant sorusu ("554M mi?") + MLX modeli: 36 ilanın 32'sine "evet", işaretlenen 17 ilanda %53. Neden: kullanıcı **tamamen siyah** 554M istiyor; çift renkli (parlak yüzlü) aynı tasarım "yok". Soru artık rengi açıkça söylüyor.
  - QAT modeliyle, script'teki haliyle (fotoğraf türü aynı çağrıda, "en az 1 evet ve %25" kuralı): **renk dahil yeni düz soru %88 (15/17)**, örnek fotoğrafla karşılaştırma %76 (13/17, 3 yanlış "var"). Bu yüzden varsayılan örneksiz; örnek fotoğraf isteğe bağlı (📷 örnek yap). Çoğunluk kuralı gerçek pozitifleri kaçırıyordu: özellik birkaç fotoğrafta seçilebiliyor, diğerleri "hayır" diyor. Örneklem küçük (17 ilan); isabet tablosuyla izlemeye devam et.
  - Siyah ızgara Shadow kararlarıyla 8/8 tutarlı.
  - HUD fotoğraftan tespit edilemiyor (18 ilanda 0 "evet"; ilan fotoğraflarında torpidonun üstü görünmüyor) ve ilan metninde neredeyse hiç geçmiyor. Güçlü ipucu: işaretlenen ilanlarda First Edition olmayan 218i Gran Coupe M Sport'ların hepsinde (8/8) HUD var, First Edition'larda 3/10.
- Tarayıcı eklentisinin Ollama'ya erişmesi için `OLLAMA_ORIGINS="chrome-extension://*,moz-extension://*,safari-web-extension://*"` gerekli. Mac'te bir LaunchAgent bunu her açılışta ayarlıyor.
- Mac: Apple M5, 16 GB RAM. Windows: AMD RX 6800 (16 GB VRAM).

## Arama ve özellik filtresi

- Saf mantık: `matchFilter`, `applyFilter`, `facetCounts`, `rowHas` (testli). Filtre `{ q, has, kmMax, priceMax, yearMin, color, withRejected }`; `has` anahtarları `crit:<id>` ve `feat:<ad>`, değer `true` (var olsun) ya da `false` (olmasın).
- "Var" sadece kesin olandır (`met` ya da donanımda `ok === true`); fotoğraf analizi bekleyen `null` sayılır, "var olsun"a girmez, "olmasın"dan çıkmaz.
- Filtre GM'de `filter` anahtarında, bilgisayara özel; eşitlenmez. Filtre açıkken sıralama tek tablo olur ve Claude metni sadece filtredekileri alır.
- Yazarken liste ve düğmeler yeniden çizilir (`refreshFiltered`), giriş kutuları çizilmez ki odak kaybolmasın.

## Var/Yok

- Her kriterde Var/Yok her zaman seçilebilir; metinde birebir geçse bile (ilan metni yanıltabilir). `evalCriteria`'da elle karar metinden ve fotoğraftan önce gelir.
- Eski varsayılan anahtar kelime listeleri `OLD_KEYWORDS`'te; kullanıcı hiç değiştirmediyse `loadConfig` yenisine çevirir ("kırmızı iç" → "kırmızı iç döşeme": tek başına iç aydınlatma ya da dikiş de olabiliyor).

## Satılan ve geri eklenen ilanlar

- `isSold`: kullanıcının kendi `track.status = 'satildi'`'si. `computeRows` satılanları `sold`'a, vazgeçilenleri `closed`'a ayırır; arayüzde Satılanlar Elenen'in hemen altında.
- `relist` ({ at, sameId, soldAt } ya da { at, of, oldTitle, oldUrl, oldPrice, reasons }): aynı numara arama sonuçlarında ya da ilan sayfasında yayında görülünce (`decorateSearch`, `saveCurrentListing`; satıldı işareti kalkar) ya da ilk kez açılan ilan `findRelist`/`sameCar` ile satılan bir araca eşleşince. `sameCar`: marka/seri/model/renk ve yıl aynı, km makul, ve (açıklama Jaccard ≥ 0,5 ya da en az bir boyalı/değişen parça ile boya/değişen + tramer tutarı aynı). İlan sayfası "yayından kaldırılmış" gibi bir metin gösteriyorsa (`isRemovedPage`, gerçek sayfayla doğrulanmadı) yayında sayılmaz.

## Elle eleme

- `manual.reject` ({ v, at }): Var/Yok ile aynı mekanizma (eşitleme, geri alma, `data-manual` tıklaması). `isRejectedByMe`: sadece kullanıcının kendi kararı eler (`evalHard` ilk neden "Elle elendi"); dahil edilen birinin elemesi `ruleFlags`'te "ali bu ilanı eledi" uyarısıdır, `ownCopyOf` ile kopyaya geçmez. Düğme `rejectBtn`: not alanının yanında (ayrıntılar, ilan sayfası kartı, karşılaştırma), Benim sıralamam satırında ve Elenen listesinde.

## Benim sıralamam (tersten puanlama)

- Kullanıcının elle sıraladığı ilan id'leri `config.calibration.order`'da (ayarlarla eşitlenir).
- `calibrate(listings, order, cfg)`: puan = Σ ağırlık × özellik (0..1, `calibFeatures`). Sıralamadaki her ikili bir kısıt; lojistik sıralama kaybı + şimdiki ağırlıklara zayıf çekim, izdüşümlü gradyan inişi (`fitWeights`, `projectWeights`): ağırlık ≥ 0, toplam puan sabit, tramer basamakları monoton. KM sınırları küçük bir ızgarada aranır. Sıralanan ilanlarda hiç değişmeyen bileşenler sabit tutulur; yoksa toplam puanı korurken boşalan puanı bilgisiz bileşenler kapıyordu (test var).
- Fiyat da varsayılan önemli: aynı kullanıcının 10 ilanlık sıralamasında ham fiyat tek başına 0,50, piyasaya göre fiyat (`market.diff`) 0,47 uyum verdi; kalibrasyon fiyata 4–5 puan veriyordu. Fiyatı önemli saymak uyumu düşürmedi (35/45, işaretsizle aynı).
- Önemli bileşenler (`config.calibration.important`, yoksa `['year', 'price']`; `importantOf`): her biri toplam puanın en az `IMPORTANT_SHARE` (%10) payını alır (`projectWeights`'teki `floors`; hepsi birden serbest bütçenin %60'ını geçmez). Sadece KM, fiyat, yıl ve kriterler işaretlenebilir (`floorable`); tramer basamakları ve "renklerden en yükseği" kuralı alt sınırla karışır. Neden: gerçek bir 8 ilanlık sıralamada (üstte 2020–2021 Shadow'lar, en altta tramerli 2023) yıl tek başına sıralamayı açıklamıyordu (ikili uyum 0,45); işaretsiz kalibrasyon yıla 6 puan verip renge (Turkuaz, Shadow'larla karışık) 6 puan veriyordu. Yıl ≥ 15 puan zorlamanın maliyeti kaba kuvvet aramasında 1 ikiliydi. `calibrate(..., { important: [] })` işaretsiz hesap; arayüz farkı gösteriyor. Fiyat ve yıl puanı 0 iken aralıkları sıralanan ilanlardan alınır.
- Bilinen: kalibrasyonun gradyan inişi en iyi ikili uyuma her zaman ulaşmıyor (aynı veride kaba kuvvet 27/28, kalibrasyon 26/28). Tramer bilgisi okunamayan ilan "kayıt yok" puanını alamıyor; kullanıcı o ilanı üste koyduysa ters ikili kalıyor.
- Renk (`scoring.colors`, `colorOf`): ilanın "Renk" alanının ana rengi; renk başına puan, toplam puana sadece en yükseği sayılır (`maxTotal`). Kalibrasyon sıralanan ilanlarda en az 2 kez geçen renkleri öğrenir.
- `calibrate` ağır: arayüzde sadece "Puanları hesapla" düğmesiyle çalışır (`rank-calc`), sonuç `state.calib`'te `calibKey` (sıralama + önemli işaretleri + puan ayarları + sıralanan ilanların içeriği) ile saklanır; anahtar değişince öneri eskir, Uygula kapanır. Her çizimde çağırma: sürükle-bırak ve eşitleme sırasında eklentiyi kasıyordu.
- Ölçüt: ikili uyum (`pairAgreement`). Sentetik testte gizli tercih (fiyat ağırlıklı) 25 ilandan %97 uyumla geri bulunuyor; 6 ilanla gürültülü, arayüz 8'den azında uyarıyor.

## GitHub eşitlemesi

- Veri ayrı ve **özel** bir repoda: `registerkayitey-sudo/sahibinden-asistan-veri`. Klasörler `ilanlar/<kişi>/<ilan>.json` ve `ayarlar/<kişi>.json`.
- Kullanıcı adı `kişi-bilgisayar` biçiminde (`efe-mac`, `efe-windows`). Tireden önceki kısım kişidir; aynı kişinin bilgisayarları tek klasörü ve tek ayarı paylaşır.
- Script her eşitlemede veri reposunun özel olduğunu kontrol eder; herkese açıksa hiçbir şey göndermez.
- Ayarların `ollama` bölümü bilgisayara özeldir, eşitlemeyle değişmez. Gelen ayar `validateConfig`'ten geçmezse alınmaz.
- Paylaşımı kaydederken bu tarayıcıda yeni bir kişi adı seçildiyse ve veri reposunda o kişinin ilanları ya da ayarları varsa onay istenir (`personUsage`): arkadaş yanlışlıkla "efe…" adını seçip kullanıcının ayarlarının ve elle sıralamasının üstüne yazmasın.
- "Sadece oku" (`share.readOnly`): eşitleme okur ama hiçbir şey göndermez (ilan, ayar, eski klasör temizliği yok). Salt okunur token'la (Contents: Read-only) arkadaşa verilir; değiştirme GitHub izniyle engellenir.
- Token sadece tarayıcıda (`GM` anahtarı `ghToken`) durur. Repoya, ayar dosyasına, veri yedeğine ya da Claude metnine asla girmemeli.

## Git

- Repo sahibi (efe) bu repoda sadece kişisel hesabını (`registerkayitey-sudo`) kullanır, şirket hesabını (`efe-yucel`, `@moment.gs` e-postası) asla. Katkıda bulunan arkadaş kendi GitHub hesabıyla fork + pull request açar.
- Efe'nin Mac'inde ayarlar sadece bu repoya özel: HTTPS remote, `gh auth git-credential` kimlik yardımcısı, kişisel noreply e-postası. Bilgisayarın genel git ayarlarına dokunma.
- İki bilgisayardan çalışıldığı için işe başlamadan önce `git pull --ff-only` yap.
- Commit mesajı biçimi: `v0.6.1: kısa özet`.

## Bilinen açık konular (henüz düzeltilmedi)

- Token arkadaşlarla paylaşılınca herkes veri reposunun tamamını okuyup her klasöre yazabilir; "dahil et" listesi sadece görüntüyü filtreler.
- Kullanıcı adı çakışması: `ali` adlı biri, `ali-laptop` adlı başka birinin eski klasörünü kendi klasörüne birleştirip silebilir (git geçmişinden geri alınabilir).
- Eşitleme her şeyi tek commit'te gönderiyor; çok büyük ilk eşitlemede GitHub'ın boyut sınırına takılabilir.
- "Başlangıca dön" sayfa oturumundaki ilk kaydırmaya döner, panelin açıldığı ana değil.
- Veri dosyası içe aktarma kayıtları doğrulamıyor. (Arkadaştan gelen `url` ve `images` ekranda ve AI indirmesinde `safeUrl` / `safeImg` ile süzülüyor: link sadece sahibinden.com, fotoğraf sadece shbdn.com.)
- `render()` her AI adımında her şeyi yeniden hesaplıyor; çok ilanda yavaşlayabilir.
