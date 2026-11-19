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
- Push'tan önce `node --check sahibinden-asistan.user.js` ve `node tests/core.test.js` geçmeli.
- Script'i panoya kopyalarken macOS'ta kodlamayı belirt, yoksa Türkçe karakterler bozulur: `LANG=en_US.UTF-8 pbcopy < sahibinden-asistan.user.js`.
- Sahibinden.com sayfalarına otomatik istek atma, tarama yapma, bot kontrolünü aşmaya çalışma. Script sadece kullanıcının açtığı sayfaları okur; fotoğraflar sadece kullanıcı AI analizini başlatınca `i0.shbdn.com`'dan indirilir.

## Sahibinden sayfa yapısı (Kasım 2026'da gerçek ilanla doğrulandı)

- Bilgiler: `.classifiedInfoList .classifiedInfoItem` içinde `dt` / `dd`.
- Fiyat: `.classifiedInfo h3`. Başlık: `.classifiedDetailTitle h1`. Açıklama: `#classifiedDescription`. Donanım: `#classifiedProperties li.selected`.
- Boya/değişen: `.car-parts > div`. Sınıflar parçayı (`front-hood`, `roof`…) ve durumu (`original-new`, `local-painted-new`, `painted-new`, `changed-new`) veriyor.
- Fotoğraflar: `https://i0.shbdn.com/photos/…/<önek>_<ilanNo><kod>.jpg`. Önekler `thmb_`, `x5_`, `x16_`; analizde 528 px'lik `x5_` kullanılıyor.
- Tramer ayrı bir alan değil, açıklamada metin olarak geçiyor (ör. "595.000TL TRAMER KAYDI VARDIR").

## Yerel AI

- Model `gemma4:12b`. İstekler `think: false` ile gidiyor; düşünme modu cevabı yaklaşık 5 kat yavaşlatıyor.
- Tarayıcı eklentisinin Ollama'ya erişmesi için `OLLAMA_ORIGINS="chrome-extension://*,moz-extension://*,safari-web-extension://*"` gerekli. Mac'te bir LaunchAgent bunu her açılışta ayarlıyor.
- Mac: Apple M5, 16 GB RAM. Windows: AMD RX 6800 (16 GB VRAM).

## GitHub eşitlemesi

- Veri ayrı ve **özel** bir repoda: `registerkayitey-sudo/sahibinden-asistan-veri`. Klasörler `ilanlar/<kişi>/<ilan>.json` ve `ayarlar/<kişi>.json`.
- Kullanıcı adı `kişi-bilgisayar` biçiminde (`efe-mac`, `efe-windows`). Tireden önceki kısım kişidir; aynı kişinin bilgisayarları tek klasörü ve tek ayarı paylaşır.
- Script her eşitlemede veri reposunun özel olduğunu kontrol eder; herkese açıksa hiçbir şey göndermez.
- Ayarların `ollama` bölümü bilgisayara özeldir, eşitlemeyle değişmez. Gelen ayar `validateConfig`'ten geçmezse alınmaz.
- Token sadece tarayıcıda (`GM` anahtarı `ghToken`) durur. Repoya, ayar dosyasına, veri yedeğine ya da Claude metnine asla girmemeli.

## Git

- Bu repo sadece kişisel hesapla (`registerkayitey-sudo`) kullanılır. Şirket hesabını (`efe-yucel`, `@moment.gs` e-postası) bu repoda kullanma.
- Mac'te ayarlar sadece bu repoya özel: HTTPS remote, `gh auth git-credential` kimlik yardımcısı, kişisel noreply e-postası. Bilgisayarın genel git ayarlarına dokunma.
- İki bilgisayardan çalışıldığı için işe başlamadan önce `git pull --ff-only` yap.
- Commit mesajı biçimi: `v0.6.1: kısa özet`.

## Bilinen açık konular (henüz düzeltilmedi)

- Token arkadaşlarla paylaşılınca herkes veri reposunun tamamını okuyup her klasöre yazabilir; "dahil et" listesi sadece görüntüyü filtreler.
- `ownCopyOf`: başkasının ilanı kopyalanınca onun AI ve Var/Yok kararları senin kararın gibi görünür.
- Kullanıcı adı çakışması: `ali` adlı biri, `ali-laptop` adlı başka birinin eski klasörünü kendi klasörüne birleştirip silebilir (git geçmişinden geri alınabilir).
- Eşitleme her şeyi tek commit'te gönderiyor; çok büyük ilk eşitlemede GitHub'ın boyut sınırına takılabilir.
- "Başlangıca dön" sayfa oturumundaki ilk kaydırmaya döner, panelin açıldığı ana değil.
- Arkadaştan gelen `url` ve `images` doğrulanmıyor (link şeması, adres kontrolü yok). Veri dosyası içe aktarma da kayıtları doğrulamıyor.
- `render()` her AI adımında her şeyi yeniden hesaplıyor; çok ilanda yavaşlayabilir.
