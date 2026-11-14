# CEVIRI — Android (APK)

CEVIRI canlı sesli çeviri uygulamasının Android sürümü. APK, GitHub Actions
üzerinde otomatik derlenir; bilgisayarına Android Studio kurman gerekmez.

## APK'yı almak (ilk kez)

1. GitHub'da yeni bir depo (repository) oluştur, örn. `ceviri-android`.
2. Bu klasörün **içindeki her şeyi** depoya yükle (gizli `.github` klasörü dahil).
   - En kolayı: GitHub Desktop ile bu klasörü depo olarak ekleyip "Publish".
   - Ya da komut satırı:
     ```
     git init
     git add .
     git commit -m "ilk surum"
     git branch -M main
     git remote add origin https://github.com/kerilov1138/ceviri-android.git
     git push -u origin main
     ```
3. Depoda **Actions** sekmesine gir. "Android APK Derle" kendiliğinden başlar
   (başlamazsa "Run workflow"a bas). Yaklaşık 5–8 dakika sürer.
4. Bitince APK iki yerde olur:
   - **Releases** (sağ taraf) → `CEVIRI.apk` — telefondan doğrudan indirilebilir.
   - Actions → çalışma → **Artifacts** → `CEVIRI-apk` (zip içinde).
5. Telefonda APK'yı aç; "bilinmeyen kaynaklardan yükleme" iznini ver.

Kodu her güncelleyip push ettiğinde yeni bir APK çıkar. İmza sabit olduğu için
yeni sürüm eskisinin üzerine, uygulamayı silmeden kurulur.

## Klasör yapısı

| Yol | Ne işe yarar |
|---|---|
| `www/` | Uygulamanın arayüzü (masaüstü sürümdeki `public/` klasörünün kopyası) |
| `www/android-shim.js` | Android uyumluluk katmanı: ses tanıma, seslendirme ve çeviriyi Android'in kendi servislerine bağlar |
| `www/online-relay.js` | Sunucusuz, şifreli online oda modu |
| `tests/` | Otomatik testler |
| `android/` | Capacitor'ın oluşturduğu Android projesi |
| `.github/workflows/build-apk.yml` | APK'yı derleyen GitHub Actions iş akışı |

Arayüzde değişiklik yapınca `TERCUMAN/public` içindeki dosyaları `www/` içine
kopyala (`index.html` ve `app.js`'teki küçük Android düzenlemelerini koruyarak).

## Davet linki ve web sürümü (iPhone / uygulaması olmayanlar)

GitHub Actions her push'ta uygulamanın web sürümünü ücretsiz olarak
**GitHub Pages**'te yayınlar: `https://kerilov1138.github.io/ceviri-android/`

- APK'da Online → "Yeni Oda Oluştur" deyince davet kutusunda bu adrese giden
  bir link çıkar (ör. `.../ceviri-android/?room=AB12CD34`). "Davet Linkini
  Kopyala" ile WhatsApp vb. üzerinden gönder; QR düğmesi aynı linkin QR kodunu gösterir.
- Linki açan kişi uygulama kurmadan tarayıcıdan katılır: iPhone'da **Safari**,
  Android/bilgisayarda **Chrome** veya **Edge**. Adını yazıp "Odaya Katıl"a basması yeterli.
- Odalar yine şifrelidir; link oda kodunu içerdiği için yalnızca konuşacağın kişiye gönder.
- Mikrofon için tarayıcı izin ister. iPhone'da seslendirmenin çalışması için
  sayfada bir kez herhangi bir yere dokunmak gerekir.

## Arayüz dili (32 dil)

Uygulamadaki tüm yazılar 32 dilde hazır: Türkçe, English, Deutsch, Français,
Español, Italiano, Português, Русский, العربية, 日本語, 한국어, 简体中文, 繁體中文,
Nederlands, Polski, Українська, Ελληνικά, Svenska, Norsk, Dansk, Suomi, Čeština,
Română, Magyar, Български, हिन्दी, Bahasa Indonesia, Tiếng Việt, ไทย,
Azərbaycan dili, فارسی, עברית.

- İlk açılışta telefonun/tarayıcının dili otomatik seçilir (desteklenmiyorsa Türkçe).
- Üst bardaki **🌐** düğmesinden veya Ayarlar'dan değiştirilir; seçim hatırlanır.
- Arapça, Farsça ve İbranice'de ekran sağdan sola döner.
- Dil listelerindeki dil adları da seçilen arayüz dilinde görünür.
- Çeviriler `www/i18n-data.js` dosyasındadır (internetsiz çalışır).

## Online oda modu (sunucusuz)

Masaüstü sürümde odaları bilgisayardaki `server.js` yönetir. Telefonda sunucu
olmadığı için `www/online-relay.js` aynı oda davranışını uygulamanın içinde
taklit eder; cihazlar herkese açık ücretsiz MQTT aracıları üzerinden buluşur.

- **Kurulum, hesap ya da sunucu gerekmez.**
- **Şifreli:** Oda kodu aynı zamanda şifreleme anahtarıdır. Mesajlar AES-GCM ile
  şifrelenir; aracı ya da başka biri içeriği okuyamaz. Oda kodunu yalnızca
  konuşacağın kişiyle paylaş.
- **Yedekli:** Aynı anda iki aracıya (HiveMQ, EMQX) bağlanılır, biri çökse
  diğeri çalışır.
- **Kullanım:** Online → adını yaz → "Yeni Oda Oluştur" → çıkan 8 haneli kodu
  karşı tarafa gönder. O da Online → adını yaz → kodu gir → "Odaya Katıl".
- Çeviri, mesajı gönderen cihazda karşı tarafın diline yapılır (masaüstündeki
  sunucuyla aynı mantık). Mikrofon sırası kilidi de aynı şekilde çalışır.

## Masaüstü sürümünden farkları

- Masaüstü `CEVIRI.exe` henüz eski (sunucu + tünel) yöntemini kullanır; bu
  yüzden şimdilik telefon yalnızca telefonla (veya bu APK'yı kullanan cihazla)
  aynı odaya girer.
- Ses tanıma Android'in kendi servisini (Google) kullanır; konuşma bittiğinde
  metin bir kerede gelir.
- QR kod ve sohbeti dosyaya indirme düğmeleri gizlendi.
- İnternet bağlantısı gerekir.

## İmza anahtarı (GitHub Secrets)

APK'lar gizli bir anahtarla imzalanır. Anahtar depoda **yoktur**, GitHub'ın
gizli ayarlarında durur; böylece başkası "CEVIRI" adıyla sahte bir APK imzalayıp
senin uygulamanın üzerine güncelleme gibi kuramaz.

Depo → **Settings → Secrets and variables → Actions → New repository secret**:

| Ad | Değer |
|---|---|
| `CEVIRI_KEYSTORE_BASE64` | anahtar dosyasının base64 hali |
| `CEVIRI_KEYSTORE_PASSWORD` | anahtar şifresi |

Bu iki secret yoksa derleme bilerek hata verir (rastgele bir anahtarla imzalanmış,
güncellenemeyen APK çıkmasın diye). Anahtar dosyasının yedeğini güvenli bir yerde
sakla: kaybolursa yeni APK'lar eskilerinin üzerine kurulamaz.

## Testler

`npm test` ses tanıma/seslendirme katmanını ve online odayı (yerel bir test
aracısı ve iki sanal cihazla) dener. GitHub Actions her derlemeden önce
testleri çalıştırır; test bozulursa APK üretilmez.

## Sorun giderme

- **"Mikrofon izni reddedildi"**: Ayarlar → Uygulamalar → CEVIRI → İzinler →
  Mikrofon → İzin ver. Telefonda Google uygulaması yüklü ve güncel olmalı.
- **Ses çıkmıyor**: Ayarlar → Erişilebilirlik → Metin okuma (TTS) çıkışı bölümünden
  Google konuşma motorunu seç ve ilgili dilin ses paketini indir.
- **Online: "Online sunucuya ulaşılamadı"**: İnternet bağlantını kontrol et; bazı
  kurumsal/okul Wi-Fi ağları bu bağlantıları engeller, mobil veriyle dene.
- **Actions kırmızı (hata)**: Hatalı adımın kaydını aç, en alttaki hata satırlarını
  kopyalayıp bana gönder.
