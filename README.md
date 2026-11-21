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
2. Terminalde modeli indir (yaklaşık 7,2 GB, bir kerelik):
   ```bash
   ollama pull gemma4:12b-it-qat
   ```
   Çalışırken yaklaşık 9–10 GB bellek kullanır. `gemma4:12b` (etiketsiz) sürümünü kullanma: Mac'te MLX ile açılıyor ve 16 GB'lık bir Mac'in belleğinin tamamını alıyor. 8 GB RAM'li bir bilgisayarda `gemma3:4b` kullan ve Ayarlar'da `"model": "gemma3:4b"` yap.
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
2. Arama sonuçlarında her ilanın yanında bir rozet görürsün (aşağıda). **"Sayfadaki N yeni ilanı kuyruğa ekle"** düğmesi daha önce açmadığın ilanları kuyruğa alır. Birden fazla sayfa varsa her sayfada tekrarla.
3. İlk ilanı aç. Asistan ilanı otomatik kaydeder ve puanını gösterir. **"Sonraki ilan →"** ile sıradakine geç.
4. Bitince **🚗 Asistan** düğmesiyle paneli aç:
   - **Sıralama:** En iyi 10, altında filtreyi geçen diğer ilanlar (puana göre), doğrulanamayan ama puanı yüksek ilanlar ve elenenler. Her satırın "ayrıntılar" kısmında puan dökümü, boya bilgisi ve uyarılar var.
   - **Arama ve özellik filtresi:** Sıralamanın üstündeki kutuya yaz (ör. "first edition", "sunroof"; ilan başlığında, bilgilerinde, donanımında, açıklamasında ve notunda aranır, her kelime geçmeli). Yanına KM ≤, fiyat ≤, yıl ≥ ve renk koyabilirsin. Altındaki özellik düğmelerine (Kırmızı koltuk, Shadow paket, HUD…) tıkladıkça **✓ var olsun → ✗ olmasın → fark etmez** olur; düğmedeki sayı, o özelliği de seçersen kaç ilan kalacağını gösterir. Örnek: **✓ Kırmızı koltuk + ✓ Shadow paket + KM ≤ 50.000**. "Var" sadece kesin olanları sayar (metinde geçiyor, fotoğraf analizi buldu ya da sen Var dedin); fotoğraf analizi bekleyenler sayılmaz. Filtre açıkken liste tek tablo olur ve **Claude için kopyala** sadece filtredekileri kopyalar. Filtre bu bilgisayarda kalır, eşitlenmez.
   - **⚙ Puanları ve filtreleri ayarla:** Sıralamanın üstündeki kaydırıcılarla KM, tramer ve kriter puanlarını, en fazla km / en az yıl / en fazla fiyat filtrelerini değiştir. Kaydırdıkça liste hemen yeniden sıralanır, ayar kendiliğinden kaydedilir. Beğenmezsen **Başlangıca dön**.
   - **Yerel AI analizini çalıştır:** Filtreyi geçen ve doğrulanamayan ilanların fotoğraflarına ve açıklamalarına bakar. Sekme açık kalmalı; durdurursan veya sekme kapanırsa kaldığı yerden devam eder.
   - **Claude için kopyala:** İlk 10 ilanın kısa özetini panoya kopyalar. claude.ai'da yeni bir sohbete yapıştır, karşılaştırmalı yorum, satıcıya sorulacak sorular ve ekspertiz önerileri al (yaklaşık 10–25 bin token).
   - **Piyasa analizi:** Gezdiğin tüm ilanlardan (elenenler dahil) bir fiyat modeli kurar: her ilanın piyasaya göre yüzde kaç ucuz veya pahalı olduğu, km başına ve model yılı başına fiyat etkisi, fiyat/km grafiği. En az 8 ilan gerekir.

Fiyatı değişen ilanları tekrar açarsan asistan eski ve yeni fiyatı uyarı olarak gösterir.

### Durum, not ve karşılaştırma

- **Durum:** Her ilana bir durum verebilirsin: *Takipte, Arandı, Ekspertiz, Teklif verildi, Vazgeçildi, Satılmış*. Durum verdiğin ilanlar Sıralama'nın en üstünde **Takip ettiklerin** listesinde, ilerlemiş olan önce görünür. *Vazgeçildi* ve *Satılmış* ilanı sıralamadan ve AI analizinden çıkarır, en alttaki **Kapananlar**'a taşır (piyasa modeline katkısı sürer). **geri al** ile sıralamaya döner.
- **Not:** Satıcıyla konuştuklarını, ekspertiz sonucunu, pazarlığı yaz. Not ve durum ilanın "ayrıntılar" kısmında; ilan sayfasındayken sağ alttaki **📝 Not / durum** düğmesinden de açılır, satıcıyla konuşurken oradan yazabilirsin. Not alanından çıkınca (ör. **Sonraki ilan**'a basınca) not kendiliğinden kaydedilir. Notlar **Claude için kopyala** metnine de girer.
- **Elle eleme:** Beğenmediğin bir ilanı **✗ İlanı ele** ile ele: ilanın "ayrıntılar" kısmında not alanının yanında, **Benim sıralamam**'daki satırında ve ilan sayfasındaki **📝** kartında var. Nedenini nota yazabilirsin. Elenen ilan sıralamadan çıkıp **Elenen** listesine "Elle elendi" diye düşer (notunla birlikte), arama sonuçlarında "✗ Elle elendi" rozetiyle soluk görünür, AI analizine ve Claude metnine girmez. **↩ geri al** ile döner. Eleme diğer bilgisayarlarına da gider; dahil ettiğin bir arkadaşının elemesi seninkini etkilemez, sadece "ali bu ilanı eledi" uyarısı olarak görünür.
- **Karşılaştırma:** Sıralamada ilanların solundaki kutucuklardan 2–4 ilan seç, **Karşılaştır** sekmesinde yan yana gör. Her satırda en iyi değer (en düşük fiyat, en az km, en yeni yıl, en yüksek puan…) yeşil yazılır. **Bu karşılaştırmayı Claude için kopyala** sadece seçtiğin ilanları notlarınla birlikte kopyalar.
- GitHub paylaşımı açıksa durum ve notlar diğer bilgisayarlarına da gider. Dahil ettiğin bir arkadaşının durumu ve notu ilanda "(ali)" gibi adıyla görünür ama seninkinin yerine geçmez: ali "vazgeçti" dedi diye ilan senin listenden düşmez.

### Benim sıralamam: önceliklerini puanlara çevir

Puanları tek tek ayarlamak yerine ilanları kendi önceliğine göre sırala, asistan o sıralamayı veren puanları bulsun:

1. **Benim sıralamam** sekmesinde **＋ ekle** ile ilanları listene al (Sıralama sekmesinde de, listene eklemediğin her ilanın yanında "sıralamamda yok" ve tek tıkla ekleyen **＋** var; eklediklerinde "#3 sıralamamda" gibi yeri yazar), sürükleyerek ya da ↑↓ ile diz: en iyisi en üstte. Hepsini sıralaman gerekmez; 8–15 ilan yeter.
2. Sıraladıkça şimdiki ayarlarla uyum oranı canlı görünür. Bitirince **Puanları hesapla**'ya bas: asistan sıraladığın ilanları ikişer ikişer karşılaştırır ve puanların seninle aynı sırayı verme oranını gösterir: "şimdiki ayarlarla %64 → önerilen ayarlarla %91" gibi. **Önerilen puanlar** tablosunda hangi bileşenin kaç puan olması gerektiği yazar (KM, tramer, kriterler, km sınırları; yeni olarak **fiyat**, **model yılı** ve **renk**). Hesap birkaç saniye sürebileceği için her değişiklikte değil, sadece düğmeye basınca yapılır; sonra sıralamanı değiştirirsen öneri "eski" sayılır ve **Uygula** kapanır, tekrar hesaplatırsın.
3. Beğenirsen **Ayarları Genel Listeye Uygula**: önerilen puanlar genel sıralamanın ayarı olur. Önceki ayarlar yedeklenir, **Ayarlar → Önceki ayarları geri yükle** ile dönersin.

**Renk:** hangi rengi ne kadar tercih ettiğini bilmen gerekmez; sıraladıkça ortaya çıkar (ör. Siyah +24, Gri +4, Beyaz 0). Renk ilanın "Renk" alanından okunur, tonlar ana renge toplanır ("Gri (Gümüş)" → Gri). Bir renk ancak sıraladığın ilanlarda en az 2 kez geçiyorsa öğrenilir; tek ilanın yeri renge yüklenmesin diye.

**Önemli bulduğun bileşenler:** Az ilanla sıralama, bir bileşenin ne kadar önemli olduğunu tek başına söyleyemeyebilir. Örneğin en üstte 2020–2021 model Shadow'lar, en altta tramerli bir 2023 varsa sıralaman "yeni model iyidir" demiyor gibi görünür, oysa Shadow'suzlar arasında 2022'yi 2020'nin üstüne koymuşsundur. Bu durumda asistan yıla neredeyse puan vermezdi. Uyum oranının altındaki düğmelerle bileşenleri **önemli** işaretle (KM, fiyat, model yılı ve kriterler). İşaretli her bileşen toplam puanın en az %10'unu alır, kalan puanlar sıralamandan öğrenilir. **Model yılı ve fiyat varsayılan olarak işaretli.** Fiyat genelde tek başına sıralamayı açıklamaz (en ucuz araç yüksek km'si ya da tramerı yüzünden altta olabilir), bu yüzden işaretlenmezse puan almıyordu; işaretliyken sıraladığın en ucuz ilan tam puan, en pahalısı 0 alır. İşaretlemenin uyuma bir maliyeti olursa ("Önemli işaretlemeseydin uyum %93 olurdu") altında yazar. Önemli bir bileşen sıraladığın ilanlarda hep aynıysa (ör. hepsi 2021) öğrenilemez, uyarı çıkar. Fiyat ve model yılı henüz puan almıyorsa aralıkları sıraladığın ilanlardan alınır: en yeni yıl tam puan, en eski 0.

Kurallar: puanlar eksi olmaz, toplam puan aynı kalır, daha az tramer hiçbir zaman daha az puan almaz. Sıraladığın ilanlarda hiç fark yaratmayan bir bileşen (ör. hiçbirinde Shadow yoksa) olduğu gibi kalır; sıralaman onun hakkında bir şey söylemiyor. Mutlak filtreler değişmez. Sıralaman ayarların içinde saklanır ve diğer bilgisayarlarına da gider.

### Arama sonuçlarında rozetler

Arama listesinde her ilanın başlığının yanında bir rozet çıkar:

- **✓ 112/150** (yeşil): filtreleri geçti, puanı bu. Durum verdiysen yanında yazar (ör. "· Arandı").
- **? 95/150** (turuncu): bazı şartlar ilandan doğrulanamadı; üstüne gelince hangileri olduğu görünür.
- **✗ Motor Kaputu: boyalı** (kırmızı): elendi, ilk nedeni bu. Satır soluk görünür.
- **Vazgeçildi / Satılmış** (gri): kapattığın ilan, satır soluk.
- **yeni** (gri): henüz açmadığın ilan.
- **↓ 100 bin / ↑ 50 bin**: ilk gördüğünden bu yana fiyat değişimi. Listede görünen fiyat kayıtlı fiyattan farklıysa kayıt ilanı açmana gerek kalmadan güncellenir.

Rozetler sadece açık olan sayfayı okur; Sahibinden'e fazladan istek atılmaz.

### Kendin doğrulama

"Kontrol edilecekler" listesinde, ilandan doğrulanamayan her şartın yanında **Var / Yok** düğmeleri çıkar (ör. "Hayalet gösterge (HUD) ilanda geçmiyor"). İlana bakıp işaretlersin: **Var** dersen ilan o şartı sağlamış sayılır ve sıralamaya girer, **Yok** dersen elenir. Yanlış bastıysan **geri al** ile kaldırırsın; elenenler listesindeki ilanlarda da bu düğme durur.

Puan dökümündeki kriterleri de aynı şekilde elle işaretleyebilirsin; ilan metninde geçse bile (ör. "kırmızı iç aydınlatma" yazan ama koltuğu siyah bir ilanda **Yok** diyebilirsin). Senin kararın metin ve fotoğraf analizinin önüne geçer, yerel AI elle karara bağladığın kriterlere bir daha bakmaz. Kararlar ilanla birlikte saklanır, ayar değiştirince silinmez. GitHub paylaşımı açıksa diğer bilgisayarlarına da gider.

**Olması gereken donanımlar (HUD gibi)** puan dökümünün en üstünde "şart" olarak durur ve metinden "var" denmiş olsa bile **Var/Yok** ile değiştirilebilir. Satıcılar "hayalet" kelimesini HUD dışındaki şeyler için de kullanıyor (ör. "yarı hayalet ekran", "hayalet kadran", "dijital hayalet gösterge (Live Cockpit)"). İlanda sadece bu tür ifadeler geçiyorsa HUD "var" sayılmaz, "Kontrol edilecekler"e düşer. Bu liste ayarlardaki `unsureKeywords` alanında.

## 4. Ayarlar

Panelde **Ayarlar** sekmesinden JSON olarak düzenlenir. Değişiklikler tüm kayıtlı ilanlara anında uygulanır.

- `hardFilters`: Mutlak filtreler. `maxKm` bu değerin altı, `minYear` en az, `maxPrice` en fazla. `originalParts` orijinal olması gereken parçalar. `requiredFeatures` ilan metninde geçmesi gereken donanımlar: `keywords` geçerse var sayılır, sadece `unsureKeywords` içindeki bir ifadenin parçası olarak geçerse sana sorulur.
- `scoring.km`: `bestKm` ve altı tam puan, `worstKm` ve üstü 0, arası doğrusal.
- `scoring.price`, `scoring.year`: fiyat ve model yılı puanı; `best` değerde tam puan, `worst` değerde 0, arası doğrusal. Varsayılan 0 puan (Benim sıralamam önerebilir).
- `scoring.colors`: renk başına puan, ör. `[{ "name": "Siyah", "points": 12 }]`. Listede olmayan renk 0 puan alır.
- `scoring.tramer`: Kayıt yoksa `noRecordPoints`, yoksa `tiers` içindeki ilk uyan basamak (`below` altı), hiçbiri uymazsa 0. Tramer bilinmiyorsa 0.
- `scoring.criteria`: Her kriter için:
  - `keywords`: ilan başlığı, bilgileri, donanım listesi ve açıklamasında aranır (Türkçe karakter ve büyük/küçük harf fark etmez).
  - `vision`: metinde bulunamazsa fotoğraflara sorulacak soru (İngilizce yazmak küçük modellerde daha iyi sonuç verir).
  - `allOf`: listelenen kriterlerin hepsi sağlanınca bu kriter de sağlanmış sayılır (ör. Shadow paket = 554M jant + siyah ızgara).

`ayarlar-bmw.json` varsayılan ayarlardır. Arkadaşlarına kendi ayarlarını göndermek için **Ayarlar → Dosyaya indir**, yüklemek için **Dosyadan yükle**.

GitHub paylaşımı açıksa ayarlar kendi bilgisayarların arasında eşitlenir: en son kaydedilen geçerli olur. Başka bilgisayarından gelen ayar buradakinin üstüne yazılmadan önce yedeklenir, **Ayarlar → Önceki ayarları geri yükle** ile dönebilirsin. `ollama` bölümü (model, açık/kapalı) her bilgisayarda ayrı kalır, eşitlemeyle değişmez. Bozuk bir ayar dosyası gelirse alınmaz, uyarı gösterilir.

## 5. Ortak veri: bilgisayarların ve arkadaşların arasında

İlanları, AI analizlerini, Var/Yok kararlarını ve ayarları GitHub'daki **özel** bir veri reposunda tutar. Böylece bir bilgisayarda gezdiğin ve analiz ettiğin ilanları öbür bilgisayarda tekrar gezmen ve analiz etmen gerekmez.

**Nasıl çalışır**

- Kullanıcı adı **kişi-bilgisayar** biçiminde: `efe-windows`, `efe-mac`. Tireden önceki kısım (`efe`) kişidir.
- Aynı kişinin bütün bilgisayarları **tek kullanıcı** gibi çalışır: aynı klasör (`ilanlar/efe/`), aynı ayarlar (`ayarlar/efe.json`). Biri ne yaparsa öbüründe kendi işin olarak görünür, birbirinin kararlarının ve ayarlarının üstüne yazabilir. Aynı ilan iki bilgisayarda farklıysa birleştirilir: en son görülen ilan bilgisi, birleşik fiyat geçmişi, en yeni analiz ve en yeni karar kalır.
- Script sadece senin klasörüne yazar. 0.6.0'dan önceki sürümlerin bilgisayar adıyla açtığı klasörler (ör. `ilanlar/efe-windows/`) ilk eşitlemede `ilanlar/efe/` ile birleştirilip kaldırılır.
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
2. Her bilgisayarda: **🚗 Asistan → Paylaşım** → kullanıcı adını yaz (ör. `efe-windows`, `efe-mac`) → token'ı yapıştır → **Kaydet ve eşitle**.
3. İlk eşitlemede Tampermonkey `api.github.com` adresine erişim için izin isterse **Her zaman izin ver** de.

**Arkadaşlar için**

Arkadaşın script'i yukarıdaki linkten kurar. İki yol var:

- **Sadece okusun (önerilen):** Senin ilanlarını, Var/Yok kararlarını ve notlarını çekebilir ama hiçbirini değiştiremez; bunu GitHub'ın kendisi engeller, script'te hata olsa bile.
  1. GitHub'da [yeni bir fine-grained token](https://github.com/settings/personal-access-tokens/new) oluştur: **Token name** `sahibinden-asistan-okuma`, **Repository access** *Only select repositories* → `sahibinden-asistan-veri`, **Permissions → Contents: Read-only**. Bu token'ı arkadaşına ver (yazma token'ını değil).
  2. Arkadaşın **Paylaşım** sekmesine kendi adıyla başlayan bir kullanıcı adı (ör. `ali`) ve bu token'ı girer, **Sadece oku**'yu işaretler, **Kaydet ve eşitle**'ye basar. Sonra **Kimlerin verisini dahil edeyim?** altında seni (`efe`) işaretler.
  3. Senin ilanların onda "kaynak: efe", kararların "efe kontrol etti", durumun ve notun "efe" etiketiyle görünür. Senin bir ilanında Var/Yok ya da not değiştirirse ilan onun tarayıcısında kendi kopyası olur; sana hiçbir şey gitmez. Onun kendi ilanları ve kararları da sadece kendi tarayıcısında kalır, sen göremezsin.
- **İkiniz de yazsın:** Yazma token'ını paylaşırsın; o kendi klasörüne (`ilanlar/ali/`) yazar, sen de onu dahil edip ilanlarını görebilirsin. GitHub hesabı olması gerekmez. Bedeli aşağıda.

Arkadaşının kurulumu senin verine dokunmaz:

- **Senin tarayıcındaki veriler** (ilanlar, Var/Yok kararları, notlar, ayarlar, Benim sıralamam) onun bilgisayarına hiç gitmez; onun kurulumu kendi tarayıcısında sıfırdan başlar (senin varsayılan BMW ayarlarınla, değiştirebilir).
- **Veri reposunda** herkes sadece kendi adının klasörüne yazar: o `ilanlar/ali/` ve `ayarlar/ali.json`, sen `ilanlar/efe/` ve `ayarlar/efe.json`. Elle sıralaman ayarlarının içinde, yani senin dosyanda.
- **Tek risk aynı kişi adı:** kullanıcı adının tireden önceki kısmı aynı olan herkes aynı kişi sayılır (efe-mac, efe-windows). Arkadaşın yanlışlıkla "efe" ile başlayan bir ad girerse senin ayarlarının ve sıralamanın üstüne yazabilirdi. Script bunu engeller: bir tarayıcıda yeni bir kişi adıyla eşitleme kurulurken o adın veri reposunda verisi varsa uyarır ve onay ister ("Bu SENİN başka bilgisayarınsa Tamam, başka birininse İptal").
- **Onu dahil etmezsen** onun hiçbir verisi sende görünmez. Dahil edersen ilanları "kaynak: ali" diye, senin henüz karar vermediğin Var/Yok'ları "ali kontrol etti" diye görünür; durumu ve notu bilgi olarak gösterilir. Senin ayarlarına, sıralamana ve kararlarına dokunmaz.

Token'ı paylaşmanın bedeli şu: token'ı olan herkes veri reposunun tamamını okuyabilir ve teknik olarak her klasöre yazabilir. Script başkasının klasörüne yazmaz, git geçmişi de her sürümü sakladığı için bir şey bozulursa geri alınabilir. Birini çıkarmak istersen eski token'ı GitHub'dan sil, yenisini oluşturup sadece kalanlara ver.

**Bilmen gerekenler**

- Token sadece o tarayıcıda saklanır. Ayar dosyasına, veri dışa aktarımına ve Claude için kopyalanan metne girmez.
- Ayarlar (filtreler, puanlar) sadece aynı kişinin bilgisayarları arasında eşitlenir; arkadaşlarınla paylaşılmaz, herkes kendi kriterleriyle sıralar. Bir arkadaşınla aynı ayarları kullanmak için **Ayarlar → Dosyaya indir / Dosyadan yükle**.
- **Veri → Tüm ilanları sil** sadece o tarayıcıdaki kopyayı siler. GitHub'daki dosyalar durur, otomatik eşitleme açıksa bir sonraki eşitlemede geri gelir.
- İlan açıklamalarında satıcı adı ya da telefonu geçebildiği için veri reposu **özel** kalmalı. Script her eşitlemede bunu kontrol eder; repo herkese açıksa hiçbir şey göndermez ve uyarır.

## 6. Geliştirme (katkı)

Kod herkese açık; geliştirmek isteyen GitHub'da **fork** edip değişikliğini **pull request** (PR) olarak gönderir. `main` dalına giren her değişiklik Tampermonkey ile herkese (repo sahibi dahil) **kendiliğinden** gider. Bu yüzden PR'lar testler geçmeden ve repo sahibi gözden geçirmeden birleştirilmez. Her push ve PR'da testler GitHub Actions'ta kendiliğinden çalışır; PR sayfasında yeşil tik görünmeden birleştirme.

**Kurulum:** Node.js 18+ (testler için). Testler: `node tests/core.test.js`. Claude Code kullanıyorsan proje kurallarını `CLAUDE.md`'den okur. Değişikliğini tarayıcıda denemek için Tampermonkey'de linkten kurulu asıl script'i kapat (silme), kendi dosyanı **Yardımcı Araçlar → Dosyadan içe aktar** ile ayrı ekle; bitince seninkini kapatıp asıl script'i aç. İkisi aynı anda açık olursa çakışır.

### "Benim sıralamam"ı bozma

Repo sahibinin elle yaptığı sıralama ve ondan öğrenilen puanlar emek; bir güncellemeyle kaybolmamalı ya da sessizce değişmemeli:

1. **Veri biçimleri kalır.** `config.calibration` (`order`: sıralanan ilan id'leri, `important`: önemli işaretli bileşenler), ilanlardaki `manual` (Var/Yok, elle eleme) ve `track` (durum, not) ile `scoring` alanları silinmez, yeniden adlandırılmaz, anlamı değişmez. Değişiklik gerekiyorsa eski kayıtlı ayarları okuyabilen bir geçiş yazılır (`loadConfig`).
2. **Ayarlar toptan sıfırlanmaz.** Varsayılan bir değer değişecekse sadece kullanıcının hiç değiştirmediği eski varsayılan yenisine çevrilir (örnek: `OLD_VISION`, `OLD_KEYWORDS`). Kullanıcının kendi değeri asla ezilmez.
3. **Puanlamaya yeni bileşen varsayılan 0 puanla girer** ve `calibComponents` / `calibFeatures`'a da eklenir; böylece mevcut sıralamalar ve puanlar değişmez, "Benim sıralamam" yeni bileşeni öğrenebilir.
4. **Testler gevşetilmez.** "Benim sıralamam" ve "kalibrasyon" testleri sıralamanın, önemli işaretlerinin ve mutlak filtrelerin korunduğunu, önerinin tekrarlanabilir olduğunu ve gizli bir tercihi geri bulduğunu kontrol eder. Bunlar kırılıyorsa düzeltilecek olan koddur, test değil.
5. **Başkasının verisiyle deneme yapılmaz.** Geliştirirken kendi ilanlarınla ve ayrı bir tarayıcı profiliyle dene; repo sahibinin veri reposuna yazma token'ı ile eşitleme denemesi yapma (salt okunur token'la ve **Sadece oku** ile güvenli). Denemeden önce **Veri → Verileri indir** ve **Ayarlar → Dosyaya indir** ile yedek al.
6. **Her değişiklikte `@version` artar** ve README'de anlatılır.

## Bilinen sınırlar

- **Sayfa yapısı** Kasım 2026 itibarıyla gerçek bir ilanla doğrulandı. Sahibinden sayfa tasarımını değiştirirse veri okuma bozulabilir; ilan kaydedilince çıkan bildirimde puan veya boya bilgisi tuhaf görünürse haber ver.
- **Tramer** açıklamadan metin olarak okunur. "Tramer 2 parça 30 bin" gibi ifadeleri yakalar ama alışılmadık yazımlar kaçabilir; tramer sütununda `?` görürsen ilanı kendin oku.
- **Fotoğraf analizi kesin değildir**, özellikle 554M jant gibi ince ayrımlarda. Puanı fotoğraftan gelen kriterler ayrıntılarda "fotoğraf (x evet / y hayır)" olarak işaretlenir; son 10'dakilere kendin de bak. Model her fotoğrafın türünü de söyler (ön, arka, yan, iç mekân, jant) ve oy sadece ilgili türden sayılır (ayarlarda kriterin `views` alanı); kırmızı bir aracın dış fotoğrafı "kırmızı koltuk" oyu veremez. Fotoğraflar galeriye yayılarak seçilir, sorular netleşince analiz erken biter. AI'ın ne kadar isabetli olduğunu **Piyasa analizi → Yerel AI'ın fotoğraf isabeti** tablosunda görürsün: AI'dan sonra Var/Yok ile işaretlediğin kriterler gerçek cevap sayılır.
- **Örnek fotoğraf (isteğe bağlı):** İnce ayrımlarda soru metni yetmezse bir **örnek fotoğraf** seçebilirsin. (Gerçek ilanlarla yapılan ölçümde jant için rengi açıkça söyleyen düz soru %88 ile örnekle karşılaştırmadan (%76) daha isabetli çıktı; bu yüzden varsayılan olarak kapalı.) Seçmek için: bir ilanda kriteri **Var** diye işaretledikten sonra ayrıntılarda **📷 örnek yap**'a bas ve o ilanın en net fotoğrafına tıkla (ör. jantın yan ya da yakından göründüğü). Yerel AI bundan sonra diğer ilanların fotoğraflarını bu örnekle karşılaştırır. Örnek ayarlara kaydedilir (diğer bilgisayarlarına da gider) ve bir kez indirildikten sonra tarayıcıda saklanır, kaynak ilan kaldırılsa da çalışır. Örneği değiştirince o kriter bütün ilanlarda yeniden analiz edilir. Seçili örnekleri **Ayarlar** sekmesinin üstünde görür, oradan kaldırabilirsin.
- **Piyasa modeli** sadece yıl ve km'ye bakar, donanım ve hasar farkını hesaba katmaz.
- Asistan sadece senin açtığın sayfaları okur; otomatik gezinme yapmaz. Sahibinden'in bot kontrolüne takılırsan kontrolü kendin geç ve devam et.
