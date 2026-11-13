/**
 * سجل حالات فريق حلم — حفظ صور البطايق على Google Drive وقراءتها (OCR)
 *
 * خطوات الإعداد (مرة واحدة):
 * 1) من القائمة الجانبية: Services (+) → أضيفي "Drive API".
 * 2) اختاري الدالة setup من القائمة فوق ودوسي Run، ووافقي على الصلاحيات.
 *    هتعمل فولدر "صور البطايق - سجل حلم" في الـ Drive، وتطبع في الـ Execution log
 *    كلمة السر (SECRET) — انسخيها لـ Supabase.
 * 3) Deploy → New deployment → Web app
 *      Execute as: Me
 *      Who has access: Anyone
 *    وانسخي رابط الـ Web app لـ Supabase.
 *
 * الصور بتتحفظ في فولدر فرعي لكل حالة، والملفات خاصة بحسابك.
 * محدش يقدر يرفع أو يفتح صورة من غير كلمة السر، وكلمة السر محفوظة في Supabase بس.
 */

const FOLDER_NAME = 'صور البطايق - سجل حلم';

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
  // تجربة الـ OCR عشان جوجل يطلب كل الصلاحيات المطلوبة مرة واحدة
  const test = Utilities.newBlob(Utilities.base64Decode(TEST_PNG), 'image/png', 'test.png');
  try { ocr_(test); } catch (e) { Logger.log('تنبيه: تجربة الـ OCR ما نجحتش — اتأكدي إنك ضفتي Drive API من Services: ' + e); }
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
    if (body.action === 'ping') return out_({ ok: true });
    return out_({ ok: false, error: 'unknown_action' });
  } catch (err) {
    return out_({ ok: false, error: String(err && err.message || err) });
  }
}

function doGet() {
  return out_({ ok: true, service: 'helm-id-cards' });
}

function upload_(folder, b) {
  const caseId = String(b.caseId || '').replace(/[^\w-]/g, '').slice(0, 60) || 'case';
  const side = b.side === 'back' ? 'back' : 'front';
  const mime = /^image\/(jpeg|png|webp)$/.test(b.mime) ? b.mime : 'image/jpeg';
  const bytes = Utilities.base64Decode(String(b.data || ''));
  if (!bytes.length) return { ok: false, error: 'empty' };
  if (bytes.length > 8 * 1024 * 1024) return { ok: false, error: 'too_large' };
  const stamp = Utilities.formatDate(new Date(), 'Africa/Cairo', 'yyyyMMdd-HHmmss');
  const ext = mime.split('/')[1].replace('jpeg', 'jpg');
  const blob = Utilities.newBlob(bytes, mime, caseId + '_' + (side === 'front' ? 'وش' : 'ضهر') + '_' + stamp + '.' + ext);
  const file = subFolder_(folder, caseId).createFile(blob);
  let text = '';
  let ocrError = '';
  try { text = ocr_(blob); } catch (err) { ocrError = String(err && err.message || err); }
  return { ok: true, fileId: file.getId(), text: text, ocrError: ocrError };
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

function subFolder_(folder, name) {
  const it = folder.getFoldersByName(name);
  return it.hasNext() ? it.next() : folder.createFolder(name);
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
