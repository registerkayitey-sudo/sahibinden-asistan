# Sahibinden Araç Asistanı

Sahibinden'de gezdiğin araç ilanlarını kaydeder, kendi filtrelerine göre eler ve puanlar. Yanında piyasa analizi ve yerel AI ile fotoğraf ve açıklama analizi yapar. Sonuçları Claude'a yapıştırılacak kısa bir özet olarak da verebilir.

- Her şey kendi tarayıcında çalışır. Veriler hiçbir sunucuya gitmez.
- Yerel AI (Ollama) ücretsizdir ve token harcamaz. İstersen hiç kurmadan da kullanabilirsin.

## 1. Kurulum (5 dakika)

1. Tarayıcına **Tampermonkey** eklentisini kur (Chrome, Edge, Firefox). Safari'de ücretsiz **Userscripts** uygulamasını kullanabilirsin.
2. **Sadece Chrome/Edge'de:** `chrome://extensions` sayfasını aç, Tampermonkey'de **Ayrıntılar**'a tıkla ve **"Kullanıcı komut dosyalarına izin ver"** seçeneğini aç.
3. Script'i yükle:
   - Link paylaşıldıysa linke tıkla, Tampermonkey kurulum ekranı açılır, **Yükle**'ye bas.
   - Dosya paylaşıldıysa Tampermonkey panelini aç, **Yardımcı Araçlar → Dosyadan içe aktar** ile `sahibinden-asistan.user.js` dosyasını seç.
4. Sahibinden'i aç. Sağ altta **🚗 Asistan** düğmesini görmelisin.

## 2. Yerel AI (isteğe bağlı, önerilir)

Fotoğraflardan kırmızı koltuk, jant tipi ve ızgara rengini tespit eder, ilan açıklamalarını da özetler.

1. https://ollama.com adresinden Ollama'yı indir ve aç.
2. Terminalde modeli indir (yaklaşık 7,7 GB, bir kerelik):
   ```bash
   ollama pull gemma4:12b
   ```
   8 GB RAM'li bir bilgisayarda `gemma3:4b` kullan ve Ayarlar'da `"model": "gemma3:4b"` yap.
3. "Ollama isteği reddetti (403)" hatası alırsan şu komutu çalıştırıp Ollama'yı kapatıp yeniden aç:
   ```bash
   launchctl setenv OLLAMA_ORIGINS "chrome-extension://*,moz-extension://*,safari-web-extension://*"
   ```
   Windows'ta aynı değeri `OLLAMA_ORIGINS` ortam değişkeni olarak ekle.

Fotoğraf analizi Apple Silicon Mac'lerde ve ekran kartı olan PC'lerde fotoğraf başına birkaç saniye sürer. Ekran kartı olmayan eski bir bilgisayarda çok yavaş olabilir. O durumda Ayarlar'da `"enabled": false` yap; görsel kriterler "fotoğraf analizi bekliyor" olarak kalır, onlara kendin bakarsın.

## 3. Kullanım

1. Sahibinden'de aramanı yap (model, yıl, km ve fiyat filtrelerini sitenin kendi filtrelerinden ver; ne kadar daraltırsan o kadar az gezersin).
2. Arama sonuçlarında **"Sayfadaki N ilanı kuyruğa ekle"** düğmesine bas. Birden fazla sayfa varsa her sayfada tekrarla.
3. İlk ilanı aç. Asistan ilanı otomatik kaydeder ve puanını gösterir. **"Sonraki ilan →"** ile sıradakine geç.
4. Bitince **🚗 Asistan** düğmesiyle paneli aç:
   - **Sıralama:** En iyi 10, doğrulanamayan ama puanı yüksek ilanlar ve elenenler. Her satırın "ayrıntılar" kısmında puan dökümü, boya bilgisi ve uyarılar var.
   - **Yerel AI analizini çalıştır:** Filtreyi geçen ve doğrulanamayan ilanların fotoğraflarına ve açıklamalarına bakar. Sekme açık kalmalı; durdurursan veya sekme kapanırsa kaldığı yerden devam eder.
   - **Claude için kopyala:** İlk 10 ilanın kısa özetini panoya kopyalar. claude.ai'da yeni bir sohbete yapıştır, karşılaştırmalı yorum, satıcıya sorulacak sorular ve ekspertiz önerileri al (yaklaşık 10–25 bin token).
   - **Piyasa analizi:** Gezdiğin tüm ilanlardan (elenenler dahil) bir fiyat modeli kurar: her ilanın piyasaya göre yüzde kaç ucuz veya pahalı olduğu, km başına ve model yılı başına fiyat etkisi, fiyat/km grafiği. En az 8 ilan gerekir.

Fiyatı değişen ilanları tekrar açarsan asistan eski ve yeni fiyatı uyarı olarak gösterir.

### Kendin doğrulama

"Kontrol edilecekler" listesinde, ilandan doğrulanamayan her şartın yanında **Var / Yok** düğmeleri çıkar (ör. "Hayalet gösterge (HUD) ilanda geçmiyor"). İlana bakıp işaretlersin: **Var** dersen ilan o şartı sağlamış sayılır ve sıralamaya girer, **Yok** dersen elenir. Yanlış bastıysan **geri al** ile kaldırırsın; elenenler listesindeki ilanlarda da bu düğme durur.

Puan dökümündeki kriterleri de aynı şekilde elle işaretleyebilirsin. Senin kararın metin ve fotoğraf analizinin önüne geçer, yerel AI elle karara bağladığın kriterlere bir daha bakmaz. Kararlar ilanla birlikte saklanır; **Veri → dışa aktar** ile başka bilgisayara taşınır, ayar değiştirince silinmez.

## 4. Ayarlar

Panelde **Ayarlar** sekmesinden JSON olarak düzenlenir. Değişiklikler tüm kayıtlı ilanlara anında uygulanır.

- `hardFilters`: Mutlak filtreler. `maxKm` bu değerin altı, `minYear` en az, `maxPrice` en fazla. `originalParts` orijinal olması gereken parçalar. `requiredFeatures` ilan metninde geçmesi gereken donanımlar.
- `scoring.km`: `bestKm` ve altı tam puan, `worstKm` ve üstü 0, arası doğrusal.
- `scoring.tramer`: Kayıt yoksa `noRecordPoints`, yoksa `tiers` içindeki ilk uyan basamak (`below` altı), hiçbiri uymazsa 0. Tramer bilinmiyorsa 0.
- `scoring.criteria`: Her kriter için:
  - `keywords`: ilan başlığı, bilgileri, donanım listesi ve açıklamasında aranır (Türkçe karakter ve büyük/küçük harf fark etmez).
  - `vision`: metinde bulunamazsa fotoğraflara sorulacak soru (İngilizce yazmak küçük modellerde daha iyi sonuç verir).
  - `allOf`: listelenen kriterlerin hepsi sağlanınca bu kriter de sağlanmış sayılır (ör. Shadow paket = 554M jant + siyah ızgara).

`ayarlar-bmw.json` varsayılan ayarlardır. Arkadaşlarına kendi ayarlarını göndermek için **Ayarlar → Dosyaya indir**, yüklemek için **Dosyadan yükle**.

## 5. Arkadaşlarla paylaşma

En kolayı script'i bir GitHub Gist'e koymak:

1. https://gist.github.com adresinde `sahibinden-asistan.user.js` adıyla yeni bir gist oluştur ve dosyanın içeriğini yapıştır.
2. Gist'in **Raw** linkini kopyala, linkteki commit kimliğini sil (`.../raw/<uzun-kod>/sahibinden-asistan.user.js` → `.../raw/sahibinden-asistan.user.js`).
3. Script'in en üstündeki `// @version` satırının altına şunları ekle:
   ```
   // @updateURL    <raw link>
   // @downloadURL  <raw link>
   ```
4. Arkadaşlarına raw linki gönder. Script'i güncelleyip `@version` numarasını artırdığında Tampermonkey herkeste otomatik günceller.

## Bilinen sınırlar

- **Sayfa yapısı** Kasım 2026 itibarıyla gerçek bir ilanla doğrulandı. Sahibinden sayfa tasarımını değiştirirse veri okuma bozulabilir; ilan kaydedilince çıkan bildirimde puan veya boya bilgisi tuhaf görünürse haber ver.
- **Tramer** açıklamadan metin olarak okunur. "Tramer 2 parça 30 bin" gibi ifadeleri yakalar ama alışılmadık yazımlar kaçabilir; tramer sütununda `?` görürsen ilanı kendin oku.
- **Fotoğraf analizi kesin değildir**, özellikle 554M jant gibi ince ayrımlarda. Puanı fotoğraftan gelen kriterler ayrıntılarda "fotoğraf (x evet / y hayır)" olarak işaretlenir; son 10'dakilere kendin de bak.
- **Piyasa modeli** sadece yıl ve km'ye bakar, donanım ve hasar farkını hesaba katmaz.
- Asistan sadece senin açtığın sayfaları okur; otomatik gezinme yapmaz. Sahibinden'in bot kontrolüne takılırsan kontrolü kendin geç ve devam et.
