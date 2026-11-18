# Sahibinden Araç Asistanı

Sahibinden'de gezdiğin araç ilanlarını kaydeder, kendi filtrelerine göre eler ve puanlar. Yanında piyasa analizi ve yerel AI ile fotoğraf ve açıklama analizi yapar. Sonuçları Claude'a yapıştırılacak kısa bir özet olarak da verebilir.

- Her şey kendi tarayıcında çalışır. Veriler, sadece sen [GitHub paylaşımını](#5-ortak-veri-bilgisayarların-ve-arkadaşların-arasında) açarsan, senin özel veri repona gider.
- Yerel AI (Ollama) ücretsizdir ve token harcamaz. İstersen hiç kurmadan da kullanabilirsin.

## 1. Kurulum (5 dakika)

1. Tarayıcına **Tampermonkey** eklentisini kur (Chrome, Edge, Firefox). Safari'de ücretsiz **Userscripts** uygulamasını kullanabilirsin.
2. **Sadece Chrome/Edge'de:** `chrome://extensions` sayfasını aç, Tampermonkey'de **Ayrıntılar**'a tıkla ve **"Kullanıcı komut dosyalarına izin ver"** seçeneğini aç.
3. Script'i yükle: **[sahibinden-asistan.user.js](https://raw.githubusercontent.com/registerkayitey-sudo/sahibinden-asistan/main/sahibinden-asistan.user.js)** linkine tıkla, Tampermonkey kurulum ekranı açılır, **Yükle**'ye bas. Bu linkten kurarsan yeni sürümler kendiliğinden gelir.

   Dosyadan kurmak istersen: Tampermonkey paneli → **Yardımcı Araçlar → Dosyadan içe aktar** → `sahibinden-asistan.user.js`. Bu şekilde kurulan script kendiliğinden güncellenmez.
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
   Windows'ta komut istemine şunu yaz, sonra Ollama'yı sistem tepsisinden kapatıp yeniden aç:
   ```bat
   setx OLLAMA_ORIGINS "chrome-extension://*,moz-extension://*"
   ```

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

Puan dökümündeki kriterleri de aynı şekilde elle işaretleyebilirsin. Senin kararın metin ve fotoğraf analizinin önüne geçer, yerel AI elle karara bağladığın kriterlere bir daha bakmaz. Kararlar ilanla birlikte saklanır, ayar değiştirince silinmez. GitHub paylaşımı açıksa diğer bilgisayarlarına da gider.

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

## 5. Ortak veri: bilgisayarların ve arkadaşların arasında

İlanları, AI analizlerini ve Var/Yok kararlarını GitHub'daki **özel** bir veri reposunda tutar. Böylece bir bilgisayarda gezdiğin ve analiz ettiğin ilanları öbür bilgisayarda tekrar gezmen ve analiz etmen gerekmez.

**Nasıl çalışır**

- Veri reposunda herkesin klasörü ayrı: `ilanlar/<kullanıcı adı>/<ilan no>.json`. Script sadece senin klasörüne yazar.
- Kendi bilgisayarlarının hepsine **aynı kullanıcı adını** girersen hepsi aynı veriyi görür. Aynı ilan iki bilgisayarda farklıysa birleştirilir: en son görülen ilan bilgisi, birleşik fiyat geçmişi, en yeni analiz ve en yeni karar kalır.
- **Paylaşım** sekmesinde, veri reposunda klasörü olan diğer kişileri tek tek **dahil edebilirsin**. Varsayılan olarak kimse dahil değildir, sadece kendi verini görürsün.
- Dahil ettiğin birinin ilanı listende "kaynak: ali" gibi görünür, onun AI analizleri ve kararları da adıyla işaretlenir. Senin kopyan varsa esas o alınır, eksikleri onunkinden tamamlanır.
- Başkasının ilanında bir şeyi değiştirirsen (Var/Yok ya da AI analizi) onun dosyasına dokunulmaz: ilan **senin klasörüne kopyalanır** ve değişiklik orada yapılır. Yani aynı ilanın iki kopyası olur.
- Eşitleme otomatiktir: ilan kaydedince, karar verince, AI analizi bitince ve paneli açınca. Sağ üstteki ☁ yazısına tıklayarak elle de eşitleyebilirsin.

**Kurulum (repo sahibi bir kez yapar)**

1. GitHub'da [yeni bir fine-grained token](https://github.com/settings/personal-access-tokens/new) oluştur:
   - **Token name:** `sahibinden-asistan-veri`
   - **Expiration:** istediğin süre (dolunca yenisini oluşturup herkese yeniden vermen gerekir)
   - **Repository access:** *Only select repositories* → `sahibinden-asistan-veri`
   - **Permissions → Repository permissions → Contents:** *Read and write* (Metadata kendiliğinden *Read-only* olur)
   - **Generate token** → çıkan `github_pat_…` değerini kopyala. Bu değer bir daha gösterilmez.
2. Her bilgisayarda: **🚗 Asistan → Paylaşım** → kullanıcı adını yaz (ör. `efe`) → token'ı yapıştır → **Kaydet ve eşitle**.
3. İlk eşitlemede Tampermonkey `api.github.com` adresine erişim için izin isterse **Her zaman izin ver** de.

**Arkadaşlar için**

Arkadaşın script'i yukarıdaki linkten kurar. Paylaşım sekmesine kendine ait farklı bir kullanıcı adı (ör. `ali`) ve senin verdiğin token'ı girer. GitHub hesabı olması gerekmez.

Token'ı paylaşmanın bedeli şu: token'ı olan herkes veri reposunun tamamını okuyabilir ve teknik olarak her klasöre yazabilir. Script başkasının klasörüne yazmaz, git geçmişi de her sürümü sakladığı için bir şey bozulursa geri alınabilir. Birini çıkarmak istersen eski token'ı GitHub'dan sil, yenisini oluşturup sadece kalanlara ver.

**Bilmen gerekenler**

- Token sadece o tarayıcıda saklanır. Ayar dosyasına, veri dışa aktarımına ve Claude için kopyalanan metne girmez.
- Ayarlar (filtreler, puanlar) eşitlenmez, herkes kendi kriterleriyle sıralar. Aynı ayarları kullanmak için **Ayarlar → Dosyaya indir / Dosyadan yükle**.
- **Veri → Tüm ilanları sil** sadece o tarayıcıdaki kopyayı siler. GitHub'daki dosyalar durur, otomatik eşitleme açıksa bir sonraki eşitlemede geri gelir.
- İlan açıklamalarında satıcı adı ya da telefonu geçebildiği için veri reposu **özel** kalmalı.

## Bilinen sınırlar

- **Sayfa yapısı** Kasım 2026 itibarıyla gerçek bir ilanla doğrulandı. Sahibinden sayfa tasarımını değiştirirse veri okuma bozulabilir; ilan kaydedilince çıkan bildirimde puan veya boya bilgisi tuhaf görünürse haber ver.
- **Tramer** açıklamadan metin olarak okunur. "Tramer 2 parça 30 bin" gibi ifadeleri yakalar ama alışılmadık yazımlar kaçabilir; tramer sütununda `?` görürsen ilanı kendin oku.
- **Fotoğraf analizi kesin değildir**, özellikle 554M jant gibi ince ayrımlarda. Puanı fotoğraftan gelen kriterler ayrıntılarda "fotoğraf (x evet / y hayır)" olarak işaretlenir; son 10'dakilere kendin de bak.
- **Piyasa modeli** sadece yıl ve km'ye bakar, donanım ve hasar farkını hesaba katmaz.
- Asistan sadece senin açtığın sayfaları okur; otomatik gezinme yapmaz. Sahibinden'in bot kontrolüne takılırsan kontrolü kendin geç ve devam et.
