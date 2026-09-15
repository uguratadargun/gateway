# Gate — Çoklu proje ortak planlama ve yürütme

**Belge sürümü: 7 — küçük ilk paket ve açık yetki sınırı**  
Tarih: 15 Eylül 2026  
Durum: Kod incelemesine dayalı uygulama planı; özellik uygulanmadı.  
İncelenen checkout: `2f50e4e`. Superpowers kullanılmadı.

Bu belge önceki revizyon notlarını tek plana birleştirir. Aşağıdaki beş paket güncel teslim sırasıdır; eski A–G sırası kullanılmaz.

## 1. Hedef

Desktop, iOS, mobile ve sunucu projeleri tek bir hedef üzerinde çalışabilmeli. Bir projede iş ilerlediyse diğerleri bu çalışmayı kaynaklarıyla görmeli, aynı başlangıç bilgisi üzerinden katkı vermeli ve tek nihai plan oluşmalı. Uygulama proje başına ayrı run ile yapılmalı; bağımlılıklar ve sonuçlar ortak task üzerinde izlenmeli.

İlerlemiş projenin doğrulanmış işi korunur. Uyumsuz kararlar gerekçeli revizyon olarak plana girer. Bir projenin önce başlaması bütün kararlarının doğru olduğu anlamına gelmez.

İlk teslim ayrıca bugün yaşanan kaybı çözer: sunucu desktop kararına itiraz eder, kişi onaylar, desktop sonraki recall sırasında bu açık itirazı görür. Bunun için dört repoyu sunucuda çalıştırmak gerekmez.

Kapsam Gate ürününün geliştirilmesidir. Dört ürün reposunun gerçek değişiklikleri ve canlı Gate veritabanı incelenmedi. Repo adresleri, yayın hedefleri ve çalışma makineleri kurulumda eşlenecek.

## 2. Koddan doğrulanan durum

| Alan | Mevcut durum | Gereken değişiklik |
| --- | --- | --- |
| Takım/bellek | `src/lib/teams.ts`, `src/memory/`: hiyerarşi, family araması, feature kataloğu ve recorder var | Mevcut temel kullanılacak |
| Recall | `src/workflows/defaults.ts`, `src/memory/access.ts`, `cards.ts`: plan girdisine bellek taşıyor | Açık itirazlar bütün okuma yollarına eklenecek |
| Yerel adım kaydı | `src/app/api/v1/executions/[id]/events/route.ts`: adımları `recordStep` ile yazıyor | Atomik ve tekrara dayanıklı itiraz kaydı |
| Adım tekrarı | `src/executions/store.ts`: `ON CONFLICT(execution_id, step_index) DO NOTHING`; dönüş tipi `void` | Yeni eklenip eklenmediği döndürülecek |
| Transaction | Events route adımları tek tek yazıyor; sarmalayan transaction yok | Adım ve türetilen itiraz birlikte commit/rollback olacak |
| Çıktı doğrulama | `src/lib/client-api-schemas.ts`: `step.output` şu an `unknown` | İtiraz ve onay alanları sunucuda ayrıca doğrulanacak |
| İnsan sorusu | `src/client/step.ts`: `asks !== undefined && executor === "gate"` | Mevcut session soru/cevap akışı kullanılacak |
| Repo | `src/repos/store.ts`: URL/yerel path ve setup var; takım ilişkisi yok | Kimlik, erişim ve yayın hedefi eklenecek |
| Kaynak | Kararda base/head commit var; repoId yok | Kaynaklar repo ile birlikte tanımlanacak |
| Yürütme | Run başına tek worktree; engine parallel aynı workspace'i kullanır; session dalları sırayla yürür | Proje başına ayrı execution ve ortak task ilişkisi |
| Devam | `resumedFrom` mevcut run devam zinciridir | Ortak task/child ilişkisi için yeniden kullanılmayacak |

Doğrulanan hatalar/sınırlar:

- `replaceDecisions` başka takımın kararını `supersedes` ile kapatmayı sahiplik kontrolüyle engellemiyor.
- `outcomeOf`, tamamlanan bazı run'ları veya başarılı PR açma adımını `shipped` sayıyor. Merge/deploy kanıtı değildir.
- `replaceDecisions` yeniden çıkarımda kararları silip yeni ID üretiyor. İtirazın varlığı bu ID'ye bağlı olmamalı.
- `parseArgs` tekrarlanan `--input` değerlerini NUL ile birleştiriyor; `parseInputs` boşlukla ayırıyor. Tekrarlanan biçim bozuktur. `2013a0f` bunu tamamen düzeltmemiştir; mevcut ayrıştırıcı çalıştırılarak doğrulandı.
- Finish diff yalnız biten run'ın bildirdiği değişikliktir; tüm repo içeriği veya devam eden run'ın güncel kodu değildir.

## 3. Paket 1 — Kaybolan itirazı çöz ve mevcut hataları düzelt

### 3.1 Task ve itiraz kaydı

Kalıcı task kimliği ve run–task bağlantısı eklenir. Eski tek-repo run'lar aynı şekilde çalışır. İtiraz task etiketi olmasa da ilgili feature veya repo kapsamlı yollar üzerinden bulunur.

`DecisionIssue`: kendi kalıcı ID'si, kaynak execution/adım, hedef takım, biliniyorsa repo kimliği, kaynak commit, feature/yollar, karar içeriği snapshot'ı, gerekçe, öneri, revizyon, onay kaynağı ve durum.

İlk paket bütün repo envanterini beklemez: mevcut execution/workspace kaynağı açık kaynak tanımı olarak saklanır. Kimlik belirsizse tahmin edilmez. Paket 2'de kanıtla canonical repoId'ye eşlenir. Aynı göreli dosya yolu farklı repolardaki kararları birleştirmez.

İtirazın durumu `proposed → open → resolved/withdrawn`; reddedilen öneri `rejected` olarak kalır. Onay bildirimi ayrı kalıcı bir kayıt olarak `pending_source → applied/rejected` durumlarını taşır. Kaynak henüz yokken var olmayan itirazı açmak yerine onayın kendisi saklanır. Yeni recorder çalışması itirazı silemez. Kart ID'si yardımcı bağlantıdır; kaynak snapshot'ı ve itiraz ID'si korunur. Yollar/feature arama anahtarıdır, benzersiz itiraz kimliği değildir.

### 3.2 Adım ve itirazın atomik yazılması

Session-driven yazma girişi mevcut `POST /api/v1/executions/[id]/events` route'udur. Yeni sunucu model run'ı gerektirmez.

1. Rapor kimliği/yetkisi ve yapısı doğrulanır. Paket 1 sunucunun sürümlü, sabit itiraz/onay protokol şemasını kullanır; workflow bundle snapshot'ı zorunlu değildir. Execution çağırana ait olmalı, kaynak aynı run'daki kayıtlı adım olmalı ve hedef takım sunucunun çağıran için hesapladığı family kapsamında olmalıdır. `conflicts[]` / `resolved[]` alanları tip, boyut ve kaynak bağları bakımından doğrulanır. Bu, çıktının gerçekten belirli bir agent tarafından üretildiğini kanıtlamaz; sınırlı öneri gönderme yetkisidir. Sadece alan adının varlığı başka takımın kararını veya teslim durumunu değiştiremez.
2. `recordStep`, SQLite insert sonucunu `inserted: boolean` veya `changes` olarak döndürecek şekilde değiştirilir. `ON CONFLICT ... DO NOTHING` korunur.
3. Events route'un adım döngüsü aynı SQLite bağlantısında `BEGIN` / `COMMIT` ve hata halinde `ROLLBACK` kullanan ortak kayıt servisine alınır. Transaction içinde model/network çağrısı veya `await` yapılmaz.
4. **Yalnız `changes > 0` olan yeni adım için** aday itiraz veya kalıcı onay bildirimi ilk kez yazılır. Kaynak varsa onay doğrulanıp uygulanır; yoksa `pending_source` olur. Adım yazılıp bu kayıtlar yazılamazsa gerçek veritabanı hatası nedeniyle bütün transaction geri alınır; tekrar gönderimde birlikte yeniden denenir. Kaynak adımın henüz gelmemesi yazma hatası değildir ve rollback gerekçesi olmaz.
5. Ek koruma: aday kaynağına `UNIQUE(execution_id, step_index, conflict_key)`, onay bildirimine onay execution/adım kimliği + kaynak node/visit/conflict_key üzerinden unique anahtar konur. Böylece kaynak henüz yokken de aynı onay ikinci satır oluşturamaz. Planner her adımda benzersiz, şemayla doğrulanan `conflict_key` verir.
6. Aynı adım tekrar gelirse yeni itiraz/geçiş üretilmez. Aynı adım kimliğinde farklı çıktı gelirse protokol uyuşmazlığı olarak raporlanır; kayıt sessizce değiştirilmez. Onay akışı events cevabında kimlik eşlemesi dönmesine bağlı değildir.
7. Başarı bildirimi ve UI/bus olayları ancak commit sonrasında yayınlanır. Rollback olmuş itiraz UI'da açılmış gösterilmez. Mevcut maliyet, pause/resume, workspace ve heartbeat davranışları korunur; yan etkilerin transaction sınırı açıkça uygulanır.

Server engine'deki `runner.ts` onStep yolu da aynı atomik kayıt servisini kullanır; kendi içine ikinci transaction açmaz. Geçmiş adımlara itiraz çıkarılması gerekiyorsa canlı tekrar bildiriminden ayrı, kimlikli bir backfill işlemi olur. Eski adım insert edilmedi diye geçmişte eksik itirazlar rastgele yeniden türetilmez.

### 3.3 Conflict kimliği soru ve cevaptan nasıl geçer?

Planner çıktısında şeması belirli `conflicts[]` bulunur; her öğe adım içinde benzersiz bir `conflict_key` taşır. `walk.ts` önceki çıktıyı `state.outputs` içine alır; `prepareAgentNode` / `resolveInputs` bunu sonraki düğüme taşır. Onay agent'ı input bildiriminde `planner.conflicts` ve kaynak ziyaretini belirlemek için `visits.planner` kullanır; workflow node girdileri bu beyanı daraltabilir, genişletemez.

Soran agent'ın çıktı şemasına `resolved[]` eklenir. Her öğe `sourceNodeId`, `sourceVisit`, `conflict_key`, `decision` taşır. Execution kimliği doğrulanmış run/route bağlamından gelir. Kaynak ziyaretinin numarası mevcut StepRecord.visit ile aynı kurala normalize edilir ve tekrarlı planner ziyaretleriyle test edilir. Bir ziyaretin çıktısı sonradan düzenlenmez; revizyon yeni bir kaynak ziyareti/anahtarıdır.

Sunucu `(executionId, sourceNodeId, sourceVisit, conflict_key)` ile kaynak adımı ve aday itirazı bulur. Kaynak node/visit eşlemesinin tek anlamlı olduğu doğrulanır; belirsiz kayıt reddedilir. Kendi kalıcı `conflictId` değerini üretip saklar, fakat onay girdisinin bu ID'yi sunucudan alması gerekmez. UI bu ID'yi okuyabilir. Yeni zorunlu events cevap alanı, istemci kimlik eşleme durumu veya soru öncesi ağ beklemesi eklenmez.

Sunucu onay düğümünün execution/node/visit bağlamını, kaynak adımını, raporlanan kaynak ilişkisini ve çağıranın yetkisini kontrol eder. Onay yalnız bu düğüme verilmiş güncel kaynak ziyareti için geçerlidir. Yanlış anahtar, eski planner ziyareti veya tekrar cevap yeni geçiş oluşturamaz. Kişinin cevabı normal node çıktısı olarak events route'una ulaşır. Gerçek kullanıcı cevabını alma mevcut soru mekanizmasının sorumluluğudur; bir model alanı tek başına bağımsız insan onayı kanıtı değildir.

**Rapor sırası ve kalıcı bekleme:** şeması ve yetkisi geçerli raporda kaynak ve onay varsa adımlar stepIndex sırasıyla işlenir. Kaynak henüz gelmediyse onay adımı ve onay bildirimi aynı transaction içinde `pending_source` olarak yazılır; diğer geçerli adımlar da kaydedilir ve HTTP başarı cevabı döner. Raporun tamamı eksik kaynak yüzünden reddedilmez. İstemcinin batch bölmesi, yeni cevap eşlemesi veya soruyu ağ cevabına bağlaması gerekmez.

Kaynak adım geldiğinde ortak kayıt servisi bu kaynağı bekleyen onayları sorgular. Kaynak anahtar, node/visit, kaynak ilişkisi, revizyon ve yetki kontrollerini tekrar yapar. Uygun onay `applied` olur ve izinli itiraz geçişi aynı transaction içinde gerçekleşir. Geçersiz onay gerekçeli `rejected` olur; kaynağın kendisi veya diğer adımlar kaybedilmez. İtirazın kapatılmış/geri çekilmiş olması gibi güncel durumlar kontrol edilir; geç gelen onay kapalı işi tekrar açamaz. Aynı kaynağa çelişkili birden fazla onay varsa sessizce sonuncusu kazanmaz; çelişki görünür biçimde işaretlenir.

Yeni kayıt oluşturma `changes > 0` koşuluna bağlıdır; **zaten kalıcı pending kaydı çözmek**, yeniden adım insert etmeye bağlı değildir. Kaynak gelişi sırasında ve sunucu yeniden başlatıldığında/sınırlı bakım geçişinde kalıcı bekleyenler uzlaştırılır. Durum geçişleri beklenen durum koşulu ve unique anahtarlarla atomiktir; yeniden uzlaştırma aynı onayı ikinci kez uygulamaz. Kaynak hiç gelmezse onay `pending_source` olarak görünür kalır; otomatik silinmez veya uygulanmış sayılmaz. UI/recall gerektiğinde “onay bildirildi, kaynak adım bekleniyor” diye ayırır; bunu açık/doğrulanmış itiraz diye sunmaz.

Bu davranış reporter'ın kaynak-eksik hata nedeniyle bütün batch'i yeniden göndermesini gerektirmez. Kimlik doğrulama, bozuk rapor ve gerçek depolama hataları mevcut hata yolunu korur; “raporu reddetme” kuralı yalnız geçerli raporun henüz gelmemiş kaynak bağımlılığı içindir. Commit sonrası yayın ve gerçek depolama hatasında rollback kuralı değişmez.

**Teslim güvenilirliği sınırı:** mevcut `RunReporter` bellekte en fazla 200 adım tutuyor ve stop sırasında en fazla dört tur deniyor. `pending_source`, sunucuya ulaşmış onayı korur; sunucuya hiç ulaşmayan adımı kurtaramaz. İlk paketin garantisi sunucunun kabul ettiği kayıtlardan itibaren başlar. Uzun ağ kesintisinde de uçtan uca kayıpsız teslim isteniyorsa kalıcı yerel outbox, onaylanmış teslim işareti, limitlere uygun batch boyutu ve restart sonrası yeniden gönderim ayrı bir iş olarak `src/client/{reporter,api,step}.ts` kapsamına alınmalıdır. Bu mevcut taşıma açığı görünür kalır; bu sürümün bunu çözdüğü iddia edilmez.

**Paket 1 yetki sınırı:** kimliği doğrulanmış run sahibi kendi aile kapsamındaki takıma itiraz önerisi gönderebilir. İstemcinin bildirdiği kişi cevabı, öneriyi `open` yapabilir; bu yalnız “açık inceleme talebi” anlamındadır. UI/recall bunun istemci tarafından bildirilen onay olduğunu belirtir. Hedef kararın `valid_to`, `supersedes`, geçerlilik veya teslim durumu değiştirilmez; öneri doğrulanmış ortak ürün kararı sayılmaz. Gönderen kendi önerisini geri çekebilir; çözüm kaydı için sunucu hedef takım sahipliğini veya açık yönetici yetkisini kontrol eder. Başka takımın run'ının başarı raporu tek başına itirazı kapatamaz. Family filtresi yalnız okumada değil öneri oluştururken ve bekleyen onayı uygularken de hesaplanır.

Bu sınır, aile içinde yanlış öneri ve inceleme gürültüsü oluşma riskini kabul eder. Kayıtlar kaynak/aktörleriyle gösterilir; model bunları gerçek olarak otomatik benimsemez. Kaynak ve çıktı boyutu/adet sınırları uygulanır. Family dışına kayıt yazmak, başka takımın kararını kapatmak veya onlar adına kod yürütmek bu yetkiye dahil değildir.

**Paket 2'ye taşınan tanım sabitleme:** istemcinin `pinDefinitions` ile kopyaladığı workflow/agent bundle'ının hash'ini run kaydında karşılaştırmak ve sunucuda immutable snapshot saklamak, tanım değişimleri altında şema ve planner–onay input bağını doğru doğrulamak içindir. Snapshot, yetkili istemcinin sahte ama şemaya uygun çıktı göndermesini tek başına engellemez; bağımsız insan onayı kanıtı değildir. Bu nedenle Paket 1'in dar öneri yetkileri snapshot'a bağlı değildir. Paket 2'de yeni run'lar aynı yetkili tanım sürümüne bağlanır; uyuşmazlıkta eşitleme istenir. Eski run'lar Paket 1 protokolüyle raporlanabilir; sahip olmadıkları tarihsel tanım kanıtı varmış gibi gösterilmez.

Genel workflow traversal motoru ve mevcut upstream aktarımı korunur. Paket 1 işleri agent çıktı/input tanımları, sabit protokol şeması, family/ownership kontrolleri, atomik kayıt ve kalıcı bekleyen onayların uzlaştırılmasıdır. Tam workflow/agent snapshot eşleştirmesi Paket 2 işidir.

### 3.4 Recall'a uçtan uca taşıma

Issue store/sorgusu → `LocalMemoryAccess.search/feature` → `MemorySearchResult` / `FeatureDetail` → `cards.ts` metin üreticileri → memory search/feature API'leri → istemci memory erişimi ve CLI → runtime memory araçları → recall prompt'u → planner girdisi.

Açık itirazlar ayrı alan olarak dönebilir; silinmiş memory kartının sonuçlara girmesine bağlı olmaz. Execution memory ekranı da aynı durumu gösterir. Recorder açıklamayı zenginleştirir; itirazın varlığı run sonu çıkarımına bağlı değildir. İtiraz yalnız yetkili çözüm kaydı ve düzeltme/test kanıtıyla kapanır; run'ın tamamlanması tek başına yeterli değildir.

### 3.5 Bağımsız düzeltmeler

Paket içi uygulama sırası: önce `--input` ve regresyon testi; ardından cross-team supersede sahiplik kontrolü ve testi; sonra atomik itiraz/onay kaydı ile recall zinciri. Teslim durumu ayrımı aynı pakette bağımsız doğruluk işi olarak ele alınır.

- Başka takımın kararını doğrudan supersede etmeyi engelle; itiraz yolunu kullan.
- PR açıldı, merge edildi, deploy edildi ve yalnız run tamamlandı durumlarını ayır. Eski `shipped` kayıtlarını kanıt olmadan yeniden etiketleme.
- `--input`: NUL ve boşlukla ayrılan iki desteklenen biçimi düzelt. `split(/[\u0000 ]/)` adaydır; tekrarlı/karma flag, boş ayırıcı ve değerin içinde `=` testlerini ekle. Boşluk içeren tek değerlerin sözdizimini ayrıca netleştir. Paketlenmiş CLI build ile yeniden üretilip test edilir.

**Dokunulacak yerler:** `src/executions/store.ts`, events route, `src/executions/runner.ts`, `src/lib/{db,client-api-schemas}.ts`, `src/client/{api,step,cli,memory}.ts`, `src/agents/defaults.ts`, `src/workflows/defaults.ts`, `src/memory/`, runtime memory tools ve ilgili API/UI yolları.

**Kabul:** sunucu planlayıcısı itiraz üretir, kişi onaylar, run kesilir; desktop sonraki session'da recall ile açık itirazı görür. Tekrar raporu tek kayıt üretir. İtiraz insert hatası adım insert'ini de geri alır. Yanlış/eski onay reddedilir. Yeniden recorder çalışması itirazı kaybettirmez. Engine ve HTTP/CLI yolları aynı sonucu verir.

## 4. Paket 2 — Kaynak erişimi, yayın hedefi, gate ask ve tanım sabitleme

Bu pakette run başlangıcındaki workflow/agent bundle hash eşleştirmesi ve sunucu snapshot kaydı da eklenir. Başlangıç sonrasında güncel tanımlar değişse bile events doğrulaması run'ın snapshot'ını kullanır; node rolü, beyan edilmiş çıktı şeması ve input bağı doğrulanır.

Repo kimliği ve repo–takım ilişkisi eklenir. Family belleğini okumak repo kodunu okuma veya başka takımda workflow yürütme yetkisi sayılmaz. Canonical repoId execution, karar, touch, feature uygulaması ve kaynak alıntılarına taşınır. Eski kayıtlarda kimlik kaynaklardan güvenle çıkarılamıyorsa unknown kalır.

Desktop'tan kimse makinesinde değilken cevap gereksinimi için repo kaydında erişilebilir `publicationRemote`, dal politikası ve son doğrulanmış yayın commit'i zorunludur. Lokal run dalı bitişte bu hedefe push edilir; devam eden çalışma açık checkpoint commit'leriyle yayınlanır. Yalnız run sonunda push, bitmemiş çalışmayı paylaşmaya yetmez. Push, baseline sorgusundan ayrı bir yayın adımıdır; force push yapılmaz. Hedef ve erişim bilgileri kurulumda tanımlanır.

`gate ask` istenen repo/run/ref'i sabit commit'e çözer. Bellek veya önceki cevap ancak soruyu ve istenen kaynak sürümünü karşılıyorsa kullanılır; aksi halde yetkili salt okunur kaynak incelemesi yapılır. Cevap repo, commit, dosya/satır veya karar/run kaynağını belirtir. Commit edilmemiş ve yayınlanmamış kod, uzaktan erişilebilir sayılmaz.

Kaynak yoksa `source_unavailable` ve hangi dal/commit'in yayınlanması gerektiği döner; “özellik yapılmamış” denmez. Eski commit'ten cevap ancak sürümü açıkça belirtilerek verilir. Yayın hatası geliştirme sonucunu silmez; yayın durumu ayrı bekler/başarısız olur. Sunucuda dört clone olduğu varsayılmaz; erişim yöntemi repo kaydında doğrulanır.

Kaynak okuma araç katmanında salt okunur olmalıdır. Executor bunu sağlayamıyorsa yazma/keyfî komut aracı olmayan model executor kullanılır. Testler ayrı izole doğrulama işidir.

**Dokunulacak yerler:** run kayıt API/şemaları, `src/client/step.ts` tanım sabitleme ve bundle aktarımı, execution snapshot store, `src/repos/{store,setup}.ts`, `src/lib/{db,tenancy}.ts`, `src/client/`, `src/runtime/tools/`, `src/memory/`, repo API/UI ve plugin komutları. `gate ask` bu paketin parçasıdır.

**Kabul:** desktop kapalıyken yayınlanmış checkpoint hakkında kaynaklı cevap gelir; yayınlanmamış ref açık erişim hatası verir; aile/repo yetkisi dışına bilgi sızmaz; aynı yol farklı repolarda karışmaz.

## 5. Paket 3 — Dört proje katkısı ve tek nihai plan

Akış: task/proje seçimi → mevcut ilerlemeyi incele → baseline v1 → dört proje katkısı → tek koordinatör taslağı → dört kısa uyumluluk incelemesi → nihai plan sürümü.

Baseline ilk sürümde repoId, seçilmiş run/branch, sabit commit, kaynaklı memory özeti, test kanıtları ve açık itirazlardan oluşur. Hareketli branch adı tek başına yeterli değildir. Commit edilmemiş çalışma açıkça gösterilir; dahil edilmesi için önce seçilmiş çalışma commit/checkpoint yapılır. Otomatik dirty snapshot taşıma ilk sürüm dışındadır.

Her proje aynı baseline sürümünü alır ve yapılmış/kalan/revize işlerini bildirir. Koordinatör planın tek yazarıdır. Her proje ilk taslağı inceler; sonraki revizyonda yalnız değişiklikten etkilenen projeler tekrar çağrılır. En fazla iki otomatik revizyon turundan sonra çözülemeyen ürün kararları kullanıcıya açık seçeneklerle sunulur. Bütün projelerin katkısı kullanıcı gereksinimidir; tek planner kıyaslamasına ertelenmez.

Plan; ortak davranış, API/veri sözleşmeleri, proje işleri, bağımlılıklar ve kabul testlerini içerir. Açık engelleyici itiraz, eksik proje incelemesi, farklı baseline veya bağımlılık döngüsü varsa hazır sayılmaz. Kaynak değişirse yeni baseline/plan sürümü oluşturulur; yalnız etkilenen öneri ve incelemeler yenilenir.

Örnek: desktop'ta mevcut iş korunur; sunucu uyumsuzluk bulursa desktop'a gereken sınırlı revizyon eklenir. Diğer projeler doğrulanmış desktop davranışını kendi yapılarına uyarlar. Yapılmış iş, kabul ölçütünü karşıladığı doğrulanınca yeniden uygulanmaz.

**Kayıtlar:** ChangeTask, TaskProject, Baseline, ProjectProposal, PlanVersion, PlanReview, WorkItem. Paket 1 task/itiraz kayıtları genişletilir; tüm tablolar baştan zorunlu değildir. Kaynak snapshot'ları planın kanıtını korur; recorder'ın bütün ID modelini yeniden kurmak ilk teslim önkoşulu değildir.

**Dokunulacak yerler:** yeni `src/orchestration/{types,store,baseline,planning,validation}.ts`, mevcut agent/workflow tanımları, task API ve ortak plan ekranı/CLI. Yeni yollar öneridir, çalışan modül iddiası değildir.

**Kabul:** dört katkı aynı baseline'a dayanır, tek plan çıkar; korunacak desktop işi ve gerekli revizyonlar görünür. Eski kaynak üzerindeki inceleme yeni planı hazır yapamaz.

## 6. Paket 4 — Mevcut yürütücülerle uygulama ve entegrasyon

Her proje kendi session veya engine run'ında `taskId + planVersion + workItemId + baselineRevision` ile çalışır. Ayrı worktree/branch kullanılır. Mevcut session parallel düğümü dört repo yürütücüsü yerine kullanılmaz. `resumedFrom` devam ilişkisi olarak kalır; TaskExecution iş/run/attempt bağını ayrıca tutar.

CLI veya UI seçili projede sıradaki işi başlatır; sunucu yetkiyi, plan sürümünü, bağımlılık çıktılarının doğrulandığını ve aynı işte geçerli başka run olmadığını kontrol eder. Henüz farklı makineleri tek merkezden otomatik başlatma yoktur. Kaynak/iş/attempt durumları SQLite transaction ve unique anahtarlarla tutulur.

Her proje gerekli sözleşme çıktısının sürüm/hash'ini kullanır. İlerleme ve maliyet ortak task'ta görünür. Başarısız işin bağımlıları bekler; bağımsız sonuçlar korunur. Devam işlemi tamamlanmış işi tekrarlamaz. Plan değişince etkilenen işler ve transitif bağımlıları yeniden incelemeye alınır; eski çıktı yeni plana sessizce dahil edilmez.

Tamamlanma: repo testleri + sabit çıktı/commit manifesti üzerinde ortak sözleşme/entegrasyon testleri. Dört ayrı başarılı repo testi ortak uyumluluk kanıtı değildir. PR, merge ve deploy ayrı durumlar olarak tutulur; dört repoda atomik merge varsayılmaz. Kararlar ve çözülmüş itirazlar kaynaklarıyla belleğe yazılır.

**Dokunulacak yerler:** `src/client/{api,cli,run,step,reporter}.ts`, `src/executions/{runner,store,resume}.ts`, worktree altyapısı, task API/UI, yeni orchestration integration ve memory bitiş bağlantıları.

**Kabul:** bağımlılık tamamlanmadan iş başlamaz; tekrar başlatma çift run üretmez; failed/continue çalışan işi korur; sözleşme testi başarısızken task tamamlanmış görünmez.

## 7. Paket 5 — Otomatik dağıtık yürütme

Bütün projelerin uygun makinelerde tek merkezden otomatik başlatılması için runner kaydı, yetenek/host eşlemesi, kalıcı iş kuyruğu, dispatch, lease ve heartbeat eklenir. Paket 1–3'ün önkoşulu değildir; tam otomatik çoklu makine uygulamasının ayrı teslimidir.

İş alma ve child başlatma tekrar çağrılabilir olmalı; aynı iş/sürüm için iki geçerli yazıcı oluşmamalı. Süresi dolan lease ile geç gelen sonuç reddedilir. Sunucu yeniden başlayınca kayıtları uzlaştırır; eski worker'ın çalışmadığı kesinleşmeden aynı repo/işe ikinci yazıcı göndermez. Bağlantı kaybı başarı sayılmaz. Uygun iOS makinesi yoksa iş bekler ve sebep görünür.

İptal yeni dağıtımı durdurur, çalışan child'lara iletilir; tamamlanan kanıtları silmez. Maliyet ve paralellik sınırları yapılandırılır. Uzun yaşayan task kalıcı kayıttır, günlerce açık model oturumu değildir. Repo'suz koordinatör mevcut gate model executor ile çalışabilir; claude-code executor workspace gerektirir.

**Dokunulacak yerler:** yeni orchestration scheduler/dispatch/events, runner API/client desteği, execution/event altyapısı, task UI.

**Kabul:** restart çift iş üretmez; eski lease yeni planı değiştiremez; çevrimdışı host bekler; stop/retry bağımsız tamamlanan işleri korur.

## 8. Doğrulama ve teslim ölçütleri

Paket 1 testleri özellikle şunları kapsar:

- Aynı raporu tekrar gönder: tek adım, tek itiraz; kalıcı itiraz ID'si değişmez.
- Adım insert'inden sonra itiraz insert'ini hata ile kes: ikisi de rollback; retry'da ikisi de oluşur.
- Aynı adım kimliği, farklı çıktı: hata; mevcut kayıt değişmez.
- Bozuk `conflicts[]` / `resolved[]`, yanlış node, başka conflict veya eski revizyon: durum değişmez.
- Events cevabı gelmeden yerel asks, upstream planner çıktısıyla doğru itirazı gösterir; retry ikinci kayıt üretmez.
- Onay raporu kaynak adımdan önce gelir: HTTP başarı, kalıcı `pending_source`; batch içindeki diğer adımlar da kaydedilir. Kaynak gelince onay otomatik uygulanır.
- Aynı bekleyen onay tekrar raporlanır: tek satır; restart sonrası uzlaştırma bir kez geçiş yapar.
- Kaynak hiç gelmez: bekleyen onay görünür ve kalıcıdır. Kaynak geldiğinde anahtar/revizyon yanlışsa gerekçeli reddedilir; diğer kayıtlar korunur.
- Kaynak insert edilmişken uzlaştırmada gerçek DB hatası: atomik rollback; retry veya kalıcı bekleyen taraması sonunda tek geçiş.
- Geç gelen onay kapanmış itirazı açmaz; çelişkili cevaplar sessizce birbirini geçersiz kılmaz.
- Family dışına itiraz önerisi ve başka takım kararını kapatma girişimi reddedilir. Şemaya uygun istemci bildirimi doğrulanmış karar/teslim bilgisine dönüşmez.
- Hedef takım yetkisi olmayan kaynak run, itirazı çözülmüş yapamaz; kendi önerisini geri çekme ayrı yetkidir.
- Planner ikinci kez ziyaret edilir: eski ziyaretin onayı yeni itirazı açamaz; visit numarası aktarımı doğru eşleşir.
- İnsan onayından sonra run kesilir: desktop recall/CLI/engine/API açık itirazı görür.
- Recorder yeniden çıkarır: itirazın kaynağı ve bulunabilirliği korunur.
- `--input` tekrarlı, gruplanmış ve karma biçimleri kaynak ve paketlenmiş CLI'da çalışır.

Paket 2 testleri: run başladıktan sonra tanım değişse de snapshot doğrulaması aynı kalır; yeni run'da hash uyuşmazlığı ve yanlış planner–onay input bağı reddedilir; eski run'ların kısıtlı protokol davranışı korunur.

Diğer paketlerde: repo kimliği/yetki ayrımı, makine kapalıyken kaynak erişimi, aynı baseline kullanan dört proje, plan revizyonunun etkileri, bağımlılık kontrolü, restart/lease testleri ve çapraz sözleşme doğrulaması yapılır.

Mevcut Vitest altyapısı kullanılır. İlgili mevcut testler: local-runs, executions, session-walk, session-continue, resume, worktree-prep, memory-recall, memory-store ve tenancy. Hedefli testler, typecheck ve ilgili build kontrolü uygulama sırasında çalıştırılır. Planlama sırasında uygulama testleri çalıştırılmadı; yalnız mevcut input ayrıştırıcısındaki hata örneği çalıştırılarak doğrulandı.

Ölçümler: açık itirazın kapanma süresi, kaynak erişim başarısı, proje analiz maliyeti, tekrar kullanılan doğrulanmış iş, revizyon sayısı, kuyruk gecikmesi ve entegrasyon sonucu. Performans hedefleri gerçek pilotla belirlenir.

`doc-takimlar-arasi.md` eski tasarım notu olarak değiştirilmedi. Güncel uygulama kaynağı bu belgedir.
