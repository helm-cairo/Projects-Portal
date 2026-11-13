# بوابة حلم — Helm Portal

موقع واحد على GitHub Pages وقاعدة بيانات واحدة على Supabase لكل أنظمة فريق حلم.
One static site (GitHub Pages) and one Supabase project for all of Helm's systems.

| الرابط / Path | ماذا يفتح / What it opens |
|---|---|
| `/` | البوابة: ٤ بطاقات + قائمة جانبية / The portal: 4 cards + side menu |
| `/attendance/` | نظام الحضور والدورات (دخول خاص به) / Attendance & courses (own login) |
| `/cases/` | سجل الحالات (دخول خاص به) / Cases register (own login) |
| جدول التبرعات / Donations sheet | يُفتح بعد الرمز السري / Opens after the PIN |
| لوحة التبرعات / Donation dashboard | رابط مباشر بدون رمز / Direct link, no PIN |

> كل الكود عام (المستودع عام). لا أسرار ولا بيانات حقيقية هنا. كل البيانات في Supabase فقط.
> All code is public. No secrets and no real data in this repo. All data lives only in Supabase.

---

## ١) ما في المجلدات / What is where

```
index.html, manifest.webmanifest, sw.js   البوابة + التثبيت على الموبايل / portal + phone install
icons/                                    أيقونات التطبيق / app icons
shared/   config.js   رابط Supabase + المفتاح العام فقط / Supabase URL + publishable key only
          helm.css    تصميم حلم / Helm design
          helm-auth.js, login.js, account.js, helm-db.js   الدخول والبيانات / login + data
attendance/   login.html, index.html, account.html
cases/        login.html, index.html, account.html
supabase/migrations/   ملفات قاعدة البيانات بالترتيب / database files, in order
supabase/tests/        اختبار الأمان / security test
supabase/functions/    admin-users, id-card (تعمل على خوادم Supabase / run on Supabase)
apps-script/           كود Google Drive لصور البطاقات / Drive code for ID-card images
tools/make-lock.html   مولّد قفل جدول التبرعات (على جهازك فقط) / PIN lock maker (local only)
tools/serve.mjs        سيرفر للتجربة على الجهاز / local test server
```

---

## ٢) النشر على GitHub Pages / Deploy

1. ارفعي كل الملفات إلى المستودع (فرع `main`). مجلد `existing/` لا يُرفع (موجود في `.gitignore`).
   Push everything to the repo (`main` branch). `existing/` is never uploaded.
2. في GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / `(root)` → Save**.
3. بعد دقيقة يظهر الرابط، مثل `https://USERNAME.github.io/REPO-NAME/`.
   كل الروابط داخل الموقع نسبية، فتعمل تحت أي اسم للمستودع.
   All links are relative, so it works under any repo name.
4. في Supabase: **Authentication → URL Configuration → Site URL** = رابط الموقع. (يفيد لاحقًا فقط؛ الدخول لا يعتمد على الإيميل.)

**تثبيت على الموبايل / Install on the phone:** افتحي الرابط في Chrome (أندرويد) ← القائمة ⋮ ← «إضافة إلى الشاشة الرئيسية». في iPhone: Safari ← مشاركة ← «إضافة إلى الشاشة الرئيسية».

---

## ٣) إعداد Supabase (مرة واحدة) / Supabase setup (once)

في **SQL Editor → New query**، الصقي كل ملف واضغطي **Run** بالترتيب:
In **SQL Editor**, paste and run each file in order:

1. `supabase/migrations/0001_core.sql`
2. `supabase/migrations/0002_cases.sql`
3. `supabase/migrations/0003_attendance.sql`
4. `supabase/migrations/0004_shared.sql`
5. `supabase/migrations/0005_app_support.sql`
6. `supabase/tests/rls_isolation_test.sql` ← **اختبار الأمان**: لازم كل الصفوف `pass = true`. لا يحفظ أي بيانات.

ثم / Then:
- **Authentication → Sign In / Providers → Allow new users to sign up = OFF** (التسجيل الذاتي مقفول).
- **Edge Functions**: أنشئي `admin-users` و `id-card` من الملفات في `supabase/functions/`.
- `shared/config.js`: ضعي **Project URL** و **Publishable key** فقط. **ممنوع** `service_role` أو `secret`.

---

## ٤) أول مسؤول / First admin

1. **Authentication → Users → Add user → Create new user**: إيميل المسؤول + كلمة مرور مؤقتة + ✔ **Auto Confirm User**.
2. في SQL Editor:
   ```sql
   select public.helm_bootstrap_admin('ADMIN_EMAIL');
   ```
   (اكتبي الإيميل مكان `ADMIN_EMAIL`. لا تحفظيه في أي ملف هنا.)
3. أول دخول: الإيميل + كلمة المرور المؤقتة ← النظام يطلب اختيار كلمة مرور جديدة.

---

## ٥) إضافة المستخدمين / Add users

من أي نظام ← **حسابي** (أو «إدارة المستخدمين») ← **إضافة مستخدم**:
1. اكتبي الاسم والإيميل.
2. اختاري: ✔ نظام الحضور، و/أو دور في سجل الحالات.
3. **إنشاء الحساب** ← يظهر **رمز دخول مؤقت** مرة واحدة ← «مشاركة عبر واتساب» أو «نسخ الرسالة».
4. الشخص يدخل بإيميله والرمز، ويختار كلمة مروره.

**نسيت كلمة المرور؟** المسؤول ← حسابي ← بجانب الاسم **رمز مؤقت جديد**. (لا توجد رسائل إيميل.)
**إيقاف حساب:** زر **إيقاف** (يمكن إعادة تفعيله).

### الأدوار في سجل الحالات / Cases roles

| | مسؤول | معتمد | باحثة | عرض فقط |
|---|---|---|---|---|
| رؤية الحالات | كلها | كلها | حالاتها فقط | كلها |
| إضافة / تعديل | ✔ | ✔ | حالاتها (قبل القرار) | ✖ |
| اعتماد الاستحقاق | ✔ | ✔ | ✖ | ✖ |
| حذف حالة | ✔ | ✖ | ✖ | ✖ |
| الرقم القومي كاملًا | ✔ | ✔ | حالاتها فقط | مخفي (آخر ٤ أرقام) |
| صور البطاقة | ✔ | ✔ | حالاتها فقط | ✖ |
| الإعدادات (المناطق والأنشطة) | ✔ | ✖ | ✖ | ✖ |
| إدارة المستخدمين | حسابات الحالات فقط | ✖ | ✖ | ✖ |

مسؤول البوابة يدير كل المستخدمين في النظامين. في نظام الحضور كل الأعضاء بنفس الصلاحيات.
The portal admin manages everyone. In attendance, all members have the same rights.

---

## ٦) تغيير الرمز السري لجدول التبرعات / Change the donations PIN

1. على جهازك افتحي `tools/make-lock.html` في Chrome (أو `http://localhost:8080/tools/make-lock.html`).
2. الصقي رابط الشيت، واكتبي الرمز الجديد مرتين ← **إنشاء القفل** ← **نسخ النص**.
3. في `index.html` ابحثي عن `var DONATIONS_LOCK = '';` والصقي النص بين `''`.
4. احفظي وارفعي التعديل. (لتغيير الرمز لاحقًا: كرري الخطوات واستبدلي النص القديم.)

- الرابط لا يظهر في الكود أبدًا؛ المحفوظ نص مشفّر (AES-GCM، المفتاح من الرمز بـ PBKDF2 SHA-256، 250,000 تكرار).
- ٣ محاولات خاطئة ← الزر يُقفل لثوانٍ.
- لو `DONATIONS_LOCK` فارغ، البطاقة تظهر «قريبًا».
- **تنبيه:** أي شخص يعرف الرمز يقدر يفتح الرابط. اختاري رمزًا طويلًا، واجعلي صلاحيات الشيت نفسه في Google مقصورة على الفريق.

---

## ٧) صور البطاقات على Google Drive / ID-card images

1. في [script.google.com](https://script.google.com) بحساب الفريق: مشروع جديد ← الصقي `apps-script/Code.gs`، وفي الإعدادات فعّلي عرض `appsscript.json` والصقي `apps-script/appsscript.json`.
2. شغّلي الدالة **setup** ووافقي على الصلاحيات ← انسخي سطر **SECRET** من السجل.
3. **Deploy → New deployment → Web app** (Execute as: Me، Who has access: Anyone) ← انسخي **Web app URL**.
4. Supabase ← **Edge Functions → Secrets**: `APPS_SCRIPT_URL` = الرابط، `APPS_SCRIPT_SECRET` = الرمز.

الصور في فولدر خاص على Drive. لا أحد يصل إليها إلا عبر Supabase بعد التحقق من الدخول والدور.

---

## ٨) نقل البيانات من Google Sheet / Import from Google Sheets

**الحضور:** نظام الحضور ← الطلاب ← استيراد ملف (Excel أو CSV). نزّلي القالب أولًا لتعرفي أسماء الأعمدة. من Google Sheets: File ← Download ← CSV.
**الحالات:** تُضاف من داخل النظام (حالة جديدة).
لا تضعي ملفات البيانات داخل مجلد المشروع (ملفات `.csv` و `.xlsx` مستثناة من الرفع أصلًا).

---

## ٩) التجربة على الجهاز / Run locally

```bash
node tools/serve.mjs . 8080
```
ثم افتحي http://localhost:8080/

---

## ١٠) قائمة الأمان / Security checklist

- [x] RLS مفعّل على كل الجداول، والزائر غير المسجّل لا يرى شيئًا.
- [x] التسجيل الذاتي مقفول؛ الحسابات ينشئها المسؤول فقط.
- [x] لا يوجد مفتاح `service_role` في الكود (يُستخدم داخل Edge Functions تلقائيًا فقط).
- [x] لا أسرار ولا بيانات حقيقية في المستودع.
- [x] رابط جدول التبرعات مشفّر.
- [x] كل نظام بدخول منفصل، ومن له صلاحية نظام واحد لا يرى شيئًا من الآخر (اختبار `rls_isolation_test.sql`).
