/* Helm Portal — connection to Supabase.
 *
 * Fill these two values from: Supabase Dashboard -> Project Settings -> API Keys
 *   SUPABASE_URL              = Project URL (https://xxxx.supabase.co)
 *   SUPABASE_PUBLISHABLE_KEY  = the "publishable" key (sb_publishable_...) or the legacy "anon public" key
 *
 * These two are SAFE to be public: the data is protected by the security rules
 * (RLS) in supabase/migrations. NEVER put the "secret" / "service_role" key here.
 *
 * بالعربي: القيمتين دول آمنين يبقوا ظاهرين. ممنوع تمامًا تحطي هنا مفتاح service_role أو secret.
 */
window.HELM_CONFIG = {
  SUPABASE_URL: '',
  SUPABASE_PUBLISHABLE_KEY: ''
};
