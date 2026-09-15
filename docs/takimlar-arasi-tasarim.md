# gate — Takımlar Arası Çalışma (tasarım notu)

Durum: **gerekçe belgesi.** Uygulanan plan `multi-project-plan.md` (v7); bu not
onun öncesinde, kararların *neden* böyle verildiğini tutmak için yazıldı ve o
haliyle bırakıldı. §2'deki "yapmadıklarımız" tablosu ile §3.4'ün gerekçeleri
başka hiçbir yerde yazılı değil; asıl saklanma sebebi o.

Plandan ayrıldığı bilinen yerler:

- §3.2'deki `Dispute` kaydı `decision_issues` olarak yazıldı; alan adları
  farklı (`conflictKey`, `targetTeamId`, `sourceNodeId`/`sourceVisit`) ve
  itirazı açan şey kişinin onayı değil, **node'un kendi çıktısındaki protokol
  alanı** — onay ayrı bir adımda geliyor.
- §5'teki önkoşullardan repo kaydı artık var ve repolar kanonik `repoId` ile
  adlandırılıyor; takım↔repo bağı Paket 2'de kuruluyor.
- §6'daki dilimler, planda Paket 1–5 olarak yeniden bölündü.

## 1. Çözdüğümüz gerçek vaka

`ulak` altında dört takım var: `desktop`, `ios`, `mobile`, `sunucu`. Ayrı repolar,
ayrı run'lar, farklı günler. Postquantum task'inde olan şuydu:

1. desktop ilerledi, işi bir run'da bitti, recorder kararları memory'ye yazdı.
2. Günler sonra sunucunun planlayıcısı memory'den desktop'ın kararını okudu ve
   *"bu kullanım benim yapıma uymuyor"* dedi.
3. Kişiye sordu (`asks`), kişi **yanlış olduğunu onayladı**.
4. Ve o onay **hiçbir yere gitmedi**. Sunucunun run transkriptinde kaldı.
   desktop hiç öğrenmedi; revizyonun gerektiğini kimse kaydetmedi.

Eksik olan mesajlaşma altyapısı değil. Eksik olan, **bir takımın vardığı
sonucun başka bir takıma ulaşacağı kalıcı bir yer**.

İkinci, daha seyrek ihtiyaç: sunucunun run'ı *"desktop bunu kodsal olarak nasıl
yapmış"* sorusunu sorabilmeli — ve desktop'tan kimse bilgisayar başında
olmayabilir.

## 2. Ne yapmıyoruz, neden

| Yapmadığımız | Neden |
| --- | --- |
| Agentlar arası serbest mesajlaşma (mesh) | Routing'i modele verir. gate'in anayasası: *"The engine — never a model — decides which node runs next"* (`src/workflows/types.ts`). |
| Canlı paralel agentların birbirine soru sorması | Ölçülmüş başarısızlık modu: agentlar çoğunluk pozisyonuna uyum sağlıyor (sycophancy cascading) ve paralelliğin tek faydası olan bağımsız yargı kayboluyor. |
| Günlerce yaşayan orkestratör run'ı | Bir run saatler sürer, task haftalar. Orkestratör bir **kayıt** olmalı, bir run değil. |
| Üç ayrı planlayıcı | Aynı araç ve bağlam verildiğinde tek agent, vakaların çoğunda multi-agent'ı yakalıyor. Çoğullaştırma ölçülmeden yapılmamalı. |

Kalan ilke: **okuyan agent serbest, yazan tek.** Ekstra agentlar bilgi getirdiği
sürece sorun değil; durumu değiştiren eylemler tek-threadli kalır.

## 3. Parçalar

### 3.1 Task etiketi

`/gate:run ... --task postquantum`

- Serbest slug, önceden tanımlanmaz, ilk kullanan yaratır.
- Run'ı bir task'e bağlar; birden çok takımın run'ı aynı etiketi taşıyabilir.
- `workspace.branchPrefix` bundan türer: `gate/postquantum-<8>`. Dallar kendini
  anlatır, insan da `git branch --list 'gate/postquantum-*'` ile görebilir.
- **Kritik: doğruluk buna bağlı olmamalı.** Etiket unutulursa sistem çalışmaya
  devam etmeli (bkz. 3.2'de yol tabanlı eşleşme). Etiket işi güzelleştirir,
  ayakta tutmaz.

### 3.2 İtiraz kaydı (açık madde)

Bir run başka bir takımın kararının kendi yapısına uymadığı sonucuna varır ve
**kişi bunu onaylarsa**, bir itiraz kaydı açılır.

```
Dispute {
  id
  task            string?          // --task etiketi, varsa
  raisedBy        teamId           // sunucu
  owner           teamId           // desktop — yalnız o kapatabilir
  paths           string[]         // etkilenen yollar; recall bunun üzerinden bulur
  feature         featureId?
  disputes        memoryCardId?    // hangi kararı çekişmeli kılıyor
  what            string           // "postquantum anahtar değişimi şöyle çağrılıyor"
  why             string           // "sunucunun yapısına uymuyor: ..."
  suggestion      string?
  evidence        { executionId, file, line }[]
  confirmedBy     userId           // insan onayı — kaydın var olma sebebi
  status          open | resolved | withdrawn
  resolvedBy      executionId?
  openedAt / resolvedAt
}
```

Tasarım kararları:

- **Kaynağı yeni bir tool değil.** Sunucunun planlayıcısı zaten `asks` ile
  kişiye sordu. Kaydı açan şey o sorunun **onaylanmış cevabı**. "Tool koyarız,
  agent çağırmayı unutur" riski yok — mekanizma zaten tetiklenmiş durumda.
- **Yola bağlı, task'e değil.** Memory'de zaten `--path` önek araması var; madde
  etkilenen yollara bağlıysa, desktop `--task` yazmasa bile normal `recall`
  node'u onu getirir.
- **Açan kapatamaz.** sunucu açar, desktop kapatır. Tek yazar ilkesi.
- **Kapanışta yeni yazar icat etmiyoruz.** desktop revizyonu yaptığında zaten
  mevcut recorder (`src/memory/extract.ts`) run bitince karar kartını yazıyor;
  madde o run'a bağlanıp kapanır.

### 3.3 Çekişmeli kart

İtiraz, kaynak memory kartını **silmez**.

- Kart yerinde kalır — desktop gerçekten öyle yapmış, kart yanlış değil, *aşılmış*.
- İtiraz ayrı bir kayıt olarak yanına düşer; `recall` ikisini birlikte getirir:
  *"desktop şunu şöyle yaptı; sunucu bunun kendi yapısına uymadığını söyledi,
  15 Eylül'de onaylandı, madde açık."*
- Sunucu, desktop'ın kartını **düzenlemez**. Tek yazar ilkesi memory'de de geçerli.
- `forget` (0.36.1) burada yanlış araç: o, yanlış kayıt için. Bu kayıt yanlış değil.

Bu aynı zamanda **bayatlama** problemini de çözüyor: bir kararın artık geçerli
olmadığını söyleyen bir mekanizma, kartları sessizce yanlışlaşmaktan korur.

### 3.4 Answerer — `gate ask`

Karşı takımdan kimse uyanık olmadan cevap alma yolu. Mesaj değil: **hedef
takımda kısa ömürlü, salt-okunur bir run**.

```
gate ask <team> "<soru>" [--as-of main | --run <execId> | --task <slug>] [--json]

->
{
  answer       string
  citations    { repo, ref, file, line, excerpt }[]   // zorunlu
  basis        "memory" | "previous-answer" | "run"
  confidence   high | low
  needsHuman   boolean
  costUsd      number
}
```

- **Citation zorunlu.** Kaynak gösteremeyen bir cevap, cevap değil tahmindir ve
  öyle etiketlenir. Aksi halde halüsinasyon dört repoya birden yayılır.
- **Üç kademe, ucuzdan pahalıya; ilki tutarsa diğerleri çalışmaz:**
  1. `memory_search` (family scope) — bedava, zaten çalışıyor
  2. daha önce verilmiş cevap (hedef commit değişmediyse)
  3. answerer run — repoyu gerçekten okur
- **`--as-of` şart.** Varsayılan `main` yanlış olur: postquantum desktop'ta
  main'de değil, bitmemiş bir dalda. Bu parametre olmadan sistem sessizce
  "öyle bir şey yok" der — en kötü türden hata.
- `executor: claude-code` — repo okuma araçları daha iyi ve context'i compact
  ediyor (`src/agents/types.ts`, `executor` alanının gerekçesi).
- Sınır = `teamFamily`, memory'dekinin aynısı. İkinci bir erişim kuralı koymak
  kafa karıştırır ve sızıntı açar.
- **Soran öder.** Cevaplayan takımın bütçesi başkasının sorularıyla tükenmemeli.
- Cevap memory'ye yazılır → ikinci kez sorulduğunda 1. kademede biter.

### 3.5 Dal push

Lokal run'lar (`/gate:run`) bitince dalını uzağa iter.

- Gerekçe: `src/runtime/workspace.ts` zaten *"The branch is the deliverable"*
  diyor ve worktree gittikten sonra dal işi tutuyor. Push, onu gerçekten
  deliverable yapar ve answerer'ı diff'e mahkûm bırakmaz.
- Diff zaten `/finish` ile sunucuya gidiyor (`setExecutionDiff`) ama diff
  yalnız değişen satırları gösterir; *"nasıl yapmış"* sorusu çoğu zaman
  etrafındaki kodu da ister.
- **Dikkat: CI.** `gate/*` dalları push edilince pipeline tetiklenebilir.
  Push öncesi CI kurallarının bu dalları dışarıda bıraktığından emin olunmalı
  (GitLab'da push option ile atlatmak da mümkün).

## 4. Postquantum, baştan sona

1. `desktop` → `/gate:run dev "postquantum ..." --task postquantum`
   dal `gate/postquantum-a1b2c3d4`, bitince push edilir, recorder karar kartını yazar.
2. `sunucu` → `/gate:run dev "postquantum ..." --task postquantum`
   `recall` desktop'ın kartını getirir. Planlayıcı uyumsuzluğu görür, kişiye sorar.
3. Kişi onaylar → **itiraz kaydı açılır**: `owner: desktop`, etkilenen yollar,
   `disputes: <desktop'ın kartı>`. desktop'ın kartı çekişmeli işaretlenir.
   sunucu kendi işine devam eder; kimse beklemez, kimsenin uyanık olması gerekmez.
4. *(gerekirse)* sunucunun run'ı `gate ask desktop "... nasıl çağrılıyor?"
   --task postquantum` der; answerer desktop'ın dalını okur, citation'lı cevap döner.
5. desktop bir sonraki run'ını açar. `recall`, o yollara bağlı **açık maddeyi**
   getirir — `--task` yazılmamış olsa bile. Revizyon planın parçası olur.
6. desktop revizyonu bitirir; madde o run'a bağlanıp kapanır, recorder yeni
   karar kartını yazar, çekişme çözülmüş olarak işaretlenir.

## 5. Önkoşullar

- **Repolar gate'e kayıtlı değil.** Bugün `src/repos/store.ts`'de dört repodan
  hiçbiri yok, üstelik `RepoRecord`'da `team_id` de yok — yani takım↔repo bağı
  hiç mevcut değil. `gate ask desktop` hangi repoyu okuyacağını bilemez ve
  sunucunun o kodun checkout'u yoktur.
  - Gereken: repoların **git URL'i ile** kaydı (lokal path ile değil — sunucunun
    fetch edebilmesi lazım) ve bir takım↔repo bağı (bir takımın birden çok
    repo'su olabilir).
  - **Bu yalnız 3.4'ü (answerer) bloke eder. 3.2/3.3 bugünkü kurulumla çalışır.**
- Dört takım `ulak` altında kurulu. ✔
- Memory açık ve recorder çalışıyor. ✔

## 6. Aşamalar

**Dilim 1 — itiraz kaydı + çekişmeli kart + recall'ın maddeleri getirmesi.**
Postquantum'da başarısız olan tek şey buydu; soru-cevap hiç başarısız olmadı.
Yeni repo kaydı, yeni protokol, yeni node tipi gerektirmez.

**Dilim 2 — `gate ask` + answerer.** Önce repoların kaydı. `--as-of` ile dal
okuma, citation zorunluluğu, üç kademeli cevap.

**Dilim 3 — `--task` etiketi ve dal adlandırma.** 1 ve 2 onsuz da doğru
çalıştığı için sona bırakılabilir; gruplama ve okunabilirlik kazancı.

**Dilim 4 (ölçüme bağlı) — ortak planlama.** ulak'ta repo'suz bir epic run
(`src/executions/runner.ts:137` workspace'siz run'ı zaten destekliyor) ve
**tek** planlayıcı, `gate ask` ile dört repoya okuma erişimi. Üç planlayıcıya
ancak tek planlayıcının bağlam penceresine sığmadığı veya planın platform-özel
kısmının reddedildiği *görüldüğünde* geçilir.

## 7. Baştan konacak ölçümler

Sonra konursa hiç konmaz.

- konu başına soru sayısı (tekrarlanan soru = yazılı karar ihtiyacının sinyali)
- cevabın kaynağı: memory / önceki cevap / run
- açık madde sayısı ve kapanma süresi
- ask başına maliyet

## 8. Açık kalanlar

- **Canlı run'ın diff'i görünmüyor.** Adım kayıtları akıyor ama diff yalnız
  `/finish`'te gidiyor; yani "desktop şu anda ne yazıyor" görünmez, sadece
  bitmiş run'lar görünür. Şimdilik kabul; gerekirse `RunReporter` diff'i ara
  ara gönderir.
- **İtirazın tetiklenmesi kişiye bağlı.** Planlayıcı fark etmezse veya kişi
  onaylamazsa kayıt açılmaz. Bunu bilinçli seçtik (yanlış pozitif üretmemek
  için) ama kaçırılan vakalar ölçülemez.
- **Çekişmeli kartın recall'da gösterimi** yer kaplayacak; kart + itiraz birlikte
  gelince bağlam şişebilir. Kısa bir biçim gerekiyor.
- **Karar kartının sahipliği** kapanışta desktop'ta kalıyor; ortak bir kararın
  `ulak` scope'una mı yazılması gerektiği ileride tekrar sorulacak.

## 9. Dokunulacak yerler

- `src/memory/` — itiraz kaydı, çekişmeli işaret, `recall`'ın getirdiği küme
- `src/client/cli.ts` — `gate ask`; `gate memory` (`:916`) birebir emsal:
  *"the memory tools, for a person and for the session driving a run"*
- `src/runtime/tools/registry.ts` — aynı yeteneğin engine modundaki hali
- `src/client/run.ts` / `src/client/step.ts` — `--task`, dal adı, push
- `src/runtime/workspace.ts` — `releaseRunWorkspace` sonrası push
- `src/repos/store.ts` + `src/lib/db.ts` — takım↔repo bağı (Dilim 2)
- `plugins/gate/commands/run.md` — session modunun davranışı büyük ölçüde burada
