# بوابة حلم — Helm Portal

موقع واحد (GitHub Pages) وقاعدة بيانات واحدة (Supabase) لكل أنظمة فريق حلم:

| الرابط | النظام |
|---|---|
| `/` | البوابة (الصفحة الرئيسية) |
| `/attendance/` | نظام الحضور والدورات — له صفحة دخول خاصة |
| `/cases/` | سجل الحالات — له صفحة دخول خاصة |

> هذا الملف سيُستكمل في المرحلة الثالثة (النشر، إضافة المستخدمين، تغيير الرقم السري).
> This README will be completed in phase 3 (deploy, add users, change PIN).

## ترتيب ملفات قاعدة البيانات / Database setup order

في Supabase → SQL Editor → New query، الصقي كل ملف واضغطي Run بالترتيب:
In Supabase → SQL Editor, paste and run each file in order:

1. `supabase/migrations/0001_core.sql`
2. `supabase/migrations/0002_cases.sql`
3. `supabase/migrations/0003_attendance.sql`
4. `supabase/migrations/0004_shared.sql`
5. `supabase/tests/rls_isolation_test.sql` — اختبار الأمان: لازم كل الصفوف `pass = true` (لا يحفظ أي بيانات)

## أول مسؤول / First admin

1. Authentication → Users → Add user → Create new user (إيميل المسؤول + كلمة مرور مؤقتة + Auto Confirm User).
2. SQL Editor: `select public.helm_bootstrap_admin('ADMIN_EMAIL');` (اكتبي الإيميل مكان ADMIN_EMAIL — لا تحفظيه في أي ملف هنا).
3. أول دخول: المسؤول يكتب الإيميل وكلمة المرور المؤقتة، والنظام يطلب منه يختار كلمة مرور جديدة.

## قواعد الأمان / Security rules

- المستودع عام: لا أسرار، لا بيانات حقيقية، لا إيميلات أو أرقام تليفونات. كل البيانات في Supabase فقط.
- في `shared/config.js`: رابط المشروع والمفتاح العام (publishable) فقط. **ممنوع** مفتاح `service_role` / `secret`.
- التسجيل الذاتي مقفول (Authentication → Sign In / Providers → Allow new users to sign up = OFF).
- كل جدول عليه RLS، ولا يرى أحد إلا ما يسمح به دوره.

## التجربة على الجهاز / Run locally

```bash
node tools/serve.mjs . 8080
```
ثم افتحي http://localhost:8080/
