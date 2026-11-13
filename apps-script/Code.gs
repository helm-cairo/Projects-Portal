/**
 * سجل حالات فريق حلم — حفظ صور البطاقات على Google Drive وقراءتها (OCR)
 *
 * خطوات الإعداد (مرة واحدة):
 * 1) فعّلي "Drive API" (Services + أو appsscript.json).
 * 2) شغّلي الدالة setup ووافقي على الصلاحيات. تُنشئ فولدر "صور البطايق - سجل حلم"
 *    وتطبع في الـ Execution log كلمة السر (SECRET) — انسخيها لـ Supabase.
 * 3) Deploy → New deployment → Web app (Execute as: Me، Who has access: Anyone)
 *    وانسخي رابط الـ Web app لـ Supabase.
 *    عند تعديل الكود لاحقًا: Deploy → Manage deployments → ✏️ → Version: New version → Deploy
 *    (الرابط يفضل كما هو).
 *
 * أسماء الملفات:   "كود الحالة - اسم الحالة - Front" و "... - Back"
 *   قبل اعتماد الحالة لا يوجد كود، فيُكتب "بدون كود"، ثم تُعاد التسمية تلقائيًا
 *   عند صدور الكود أو تعديل الاسم (من النظام عبر action "rename").
 * لكل حالة فولدر بنفس الاسم "كود الحالة - اسم الحالة". رقم الحالة الداخلي محفوظ
 * في وصف الفولدر وفي إعدادات السكريبت، فإعادة التسمية لا تكسر أي شيء.
 *
 * لا أحد يقدر يرفع أو يفتح أو يعيد تسمية صورة من غير كلمة السر، وكلمة السر في Supabase فقط.
 */

const FOLDER_NAME = 'صور البطايق - سجل حلم';
const NO_CODE = 'بدون كود';

function setup() {
  const props = PropertiesService.getScriptProperties();
  let folderId = props.getProperty('FOLDER_ID');
  if (!folderId) {
    const folder = DriveApp.createFolder(FOLDER_NAME);
    folderId = folder.getId();
    props.setProperty('FOLDER_ID', folderId);
  }
  let secret = props.getProperty('SECRET');
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('SECRET', secret);
  }
  const test = Utilities.newBlob(Utilities.base64Decode(TEST_PNG), 'image/png', 'test.png');
  try { ocr_(test); } catch (e) { Logger.log('تنبيه: تجربة الـ OCR ما نجحتش — اتأكدي من تفعيل Drive API: ' + e); }
  Logger.log('FOLDER: https://drive.google.com/drive/folders/' + folderId);
  Logger.log('SECRET (انسخيها لـ Supabase باسم APPS_SCRIPT_SECRET): ' + secret);
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const props = PropertiesService.getScriptProperties();
    const secret = props.getProperty('SECRET');
    if (!secret || body.secret !== secret) return out_({ ok: false, error: 'unauthorized' });
    const folder = DriveApp.getFolderById(props.getProperty('FOLDER_ID'));
    if (body.action === 'upload') return out_(upload_(folder, body));
    if (body.action === 'get') return out_(getImage_(folder, String(body.fileId || '')));
    if (body.action === 'rename') return out_(rename_(folder, body));
    if (body.action === 'ping') return out_({ ok: true });
    return out_({ ok: false, error: 'unknown_action' });
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message || err) });
  }
}

function doGet() {
  return out_({ ok: true, service: 'helm-id-cards' });
}

// ---------- names ----------
function clean_(s, max) {
  return String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 80);
}
function baseName_(code, name) {
  return (clean_(code, 30) || NO_CODE) + ' - ' + (clean_(name, 80) || 'بدون اسم');
}
function fileName_(code, name, side, ext) {
  return baseName_(code, name) + ' - ' + (side === 'back' ? 'Back' : 'Front') + (ext ? '.' + ext : '');
}

// ---------- one folder per case (found by the case id, whatever its name) ----------
function caseFolder_(folder, caseId, code, name, create) {
  const props = PropertiesService.getScriptProperties();
  const key = 'case_' + caseId;
  const id = props.getProperty(key);
  if (id) {
    try {
      const f = DriveApp.getFolderById(id);
      if (!f.isTrashed()) return f;
    } catch (e) { /* folder deleted: fall through */ }
  }
  // older uploads used the case id as the folder name
  const old = folder.getFoldersByName(caseId);
  if (old.hasNext()) { const f = old.next(); props.setProperty(key, f.getId()); f.setDescription(caseId); return f; }
  if (!create) return null;
  const f = folder.createFolder(baseName_(code, name));
  f.setDescription(caseId);
  props.setProperty(key, f.getId());
  return f;
}

function upload_(folder, b) {
  const caseId = String(b.caseId || '').replace(/[^\w-]/g, '').slice(0, 60) || 'case';
  const side = b.side === 'back' ? 'back' : 'front';
  const mime = /^image\/(jpeg|png|webp)$/.test(b.mime) ? b.mime : 'image/jpeg';
  const bytes = Utilities.base64Decode(String(b.data || ''));
  if (!bytes.length) return { ok: false, error: 'empty' };
  if (bytes.length > 8 * 1024 * 1024) return { ok: false, error: 'too_large' };
  const ext = mime.split('/')[1].replace('jpeg', 'jpg');
  const blob = Utilities.newBlob(bytes, mime, fileName_(b.code, b.name, side, ext));
  const dir = caseFolder_(folder, caseId, b.code, b.name, true);
  const file = dir.createFile(blob);
  let text = '';
  let ocrError = '';
  try { text = ocr_(blob); } catch (err) { ocrError = String(err && err.message || err); }
  // (a replaced photo is trashed later, by "rename", once the case is saved)
  return { ok: true, fileId: file.getId(), text: text, ocrError: ocrError };
}

function rename_(folder, b) {
  const caseId = String(b.caseId || '').replace(/[^\w-]/g, '').slice(0, 60);
  if (!caseId) return { ok: false, error: 'bad_case' };
  const files = Array.isArray(b.files) ? b.files.slice(0, 4) : [];
  let renamed = 0;
  files.forEach(function (x) {
    const id = String(x && x.id || '');
    if (!/^[\w-]{10,}$/.test(id)) return;
    try {
      const f = DriveApp.getFileById(id);
      if (!insideFolder_(f, folder)) return;
      const m = f.getName().match(/\.(jpe?g|png|webp)$/i);
      f.setName(fileName_(b.code, b.name, x.side === 'back' ? 'back' : 'front', m ? m[1].toLowerCase() : 'jpg'));
      renamed++;
    } catch (e) {}
  });
  const dir = caseFolder_(folder, caseId, b.code, b.name, false);
  if (dir) dir.setName(baseName_(b.code, b.name));
  // photos replaced in the last save: to the Drive trash (recoverable for 30 days),
  // but only if they are in THIS case's folder and not one of its current photos
  let trashed = 0;
  const keep = files.map(function (x) { return String(x && x.id || ''); });
  (Array.isArray(b.trash) ? b.trash.slice(0, 4) : []).forEach(function (id) {
    id = String(id || '');
    if (!dir || !/^[\w-]{10,}$/.test(id) || keep.indexOf(id) >= 0) return;
    try {
      const f = DriveApp.getFileById(id);
      const ps = f.getParents();
      while (ps.hasNext()) { if (ps.next().getId() === dir.getId()) { f.setTrashed(true); trashed++; break; } }
    } catch (e) {}
  });
  return { ok: true, renamed: renamed, trashed: trashed };
}

function getImage_(folder, fileId) {
  if (!/^[\w-]{10,}$/.test(fileId)) return { ok: false, error: 'bad_id' };
  const file = DriveApp.getFileById(fileId);
  if (!insideFolder_(file, folder)) return { ok: false, error: 'not_in_folder' };
  const blob = file.getBlob();
  return { ok: true, mime: blob.getContentType(), data: Utilities.base64Encode(blob.getBytes()) };
}

function ocr_(blob) {
  let id;
  if (Drive.Files.create) {               // Drive API v3
    id = Drive.Files.create({ name: 'ocr-tmp-' + Date.now(), mimeType: MimeType.GOOGLE_DOCS }, blob, { ocrLanguage: 'ar' }).id;
  } else {                                 // Drive API v2
    id = Drive.Files.insert({ title: 'ocr-tmp-' + Date.now(), mimeType: MimeType.GOOGLE_DOCS }, blob, { ocr: true, ocrLanguage: 'ar' }).id;
  }
  try {
    return DocumentApp.openById(id).getBody().getText();
  } finally {
    try { Drive.Files.remove(id); } catch (e) { try { DriveApp.getFileById(id).setTrashed(true); } catch (e2) {} }
  }
}

function insideFolder_(file, folder) {
  const target = folder.getId();
  const parents = file.getParents();
  while (parents.hasNext()) {
    const p = parents.next();
    if (p.getId() === target) return true;
    const grand = p.getParents();
    while (grand.hasNext()) if (grand.next().getId() === target) return true;
  }
  return false;
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// صورة صغيرة جدًا للتجربة فقط (عشان جوجل يطلب الصلاحيات)
const TEST_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
