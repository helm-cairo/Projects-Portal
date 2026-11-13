/* Helm Portal — "My account" page (change password) + user management for admins.
 * Used by attendance/account.html and cases/account.html (<body data-system="...">).
 * All user changes go through the "admin-users" Edge Function, which checks
 * permissions on the server. This page only shows what the server allows.
 */
(function () {
  'use strict';
  var system = document.body.getAttribute('data-system');
  var root = document.getElementById('acct');
  var CASES_ROLES = { admin: 'مسؤول', approver: 'معتمد', researcher: 'باحثة', viewer: 'عرض فقط' };
  var ROLE_HINT = {
    admin: 'كل الصلاحيات في سجل الحالات، بما فيها الحذف والإعدادات',
    approver: 'يرى كل الحالات ويعتمد الاستحقاق',
    researcher: 'تسجّل حالاتها وتعدّلها وترى الرقم القومي لحالاتها فقط',
    viewer: 'يشاهد الحالات والتقارير، والرقم القومي يظهر مخفيًا'
  };
  var ERR = {
    weak_password: 'كلمة المرور ضعيفة: ٨ أحرف على الأقل وليست أرقامًا فقط.',
    bad_email: 'البريد الإلكتروني غير صحيح.',
    bad_name: 'اكتب الاسم.',
    email_exists: 'هذا البريد الإلكتروني مسجّل بالفعل.',
    no_access: 'اختر نظامًا واحدًا على الأقل.',
    forbidden: 'لا تملك صلاحية لهذا الإجراء.',
    forbidden_attendance: 'صلاحيات نظام الحضور يحددها مسؤول البوابة فقط.',
    self_reset: 'لا يمكنك إعادة تعيين كلمة مرورك من هنا؛ استخدم "تغيير كلمة المرور".',
    self_demote: 'لا يمكنك إزالة صلاحية المسؤول من نفسك.',
    self_disable: 'لا يمكنك إيقاف حسابك.',
    bad_role: 'الدور غير صحيح.',
    unauthorized: 'انتهت الجلسة، يُرجى تسجيل الدخول مرة أخرى.'
  };
  var I = {
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
    dot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="5"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>'
  };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function latin(s) { return String(s).replace(/[٠-٩]/g, function (d) { return '٠١٢٣٤٥٦٧٨٩'.indexOf(d); }); }
  function msg(kind, html) { return '<div class="msg msg-' + kind + '" role="' + (kind === 'error' ? 'alert' : 'status') + '">' + (kind === 'error' ? I.alert : I.info) + '<div>' + html + '</div></div>'; }
  function errText(code) { return '<b>خطأ:</b> ' + esc(ERR[code] || 'حدث خطأ غير متوقع. حاول مرة أخرى.'); }

  var g = null, me = null, users = [], email = '';

  async function call(body) {
    var r = await g.sb.functions.invoke('admin-users', { body: body });
    if (r.error) {
      var code = 'server_error';
      try { var j = await r.error.context.json(); code = j.error || code; } catch (e) {}
      throw new Error(code);
    }
    if (!r.data || !r.data.ok) throw new Error((r.data && r.data.error) || 'server_error');
    return r.data;
  }

  // ---------- my account ----------
  function renderMine() {
    var acc = g.access, sys = acc.systems || {};
    var parts = [];
    if (sys.attendance) parts.push('نظام الحضور والدورات');
    if (sys.cases) parts.push('سجل الحالات (' + (CASES_ROLES[sys.cases] || sys.cases) + ')');
    return '<section class="panel stack" aria-labelledby="h-me">' +
      '<h2 id="h-me" class="sec-title">حسابي</h2>' +
      '<dl class="kv2"><dt>الاسم</dt><dd>' + esc(acc.full_name) + '</dd><dt>البريد</dt><dd dir="ltr">' + esc(email) + '</dd>' +
      '<dt>الأنظمة</dt><dd>' + esc(parts.join('، ') || '—') + (acc.is_admin ? ' <span class="badge">مسؤول البوابة</span>' : '') + '</dd></dl>' +
      '<h3 class="sub-title">تغيير كلمة المرور</h3>' +
      '<form id="pwForm" novalidate>' +
      field('cur', 'كلمة المرور الحالية', 'current-password') + field('p1', 'كلمة المرور الجديدة', 'new-password') + field('p2', 'أعد كتابة كلمة المرور الجديدة', 'new-password') +
      '<ul class="rules" id="rules"><li data-r="length">' + I.dot + '٨ أحرف على الأقل</li><li data-r="notDigits">' + I.dot + 'ليست أرقامًا فقط</li><li data-r="match">' + I.dot + 'الكلمتان متطابقتان</li></ul>' +
      '<div id="pwMsg"></div><button class="btn btn-primary" type="submit" id="pwGo">حفظ كلمة المرور</button></form></section>';
  }
  function field(id, label, ac) {
    return '<div class="field"><label for="' + id + '">' + label + '</label><input class="input" id="' + id + '" type="password" dir="ltr" autocomplete="' + ac + '" required></div>';
  }
  function wireMine() {
    var p1 = document.getElementById('p1'), p2 = document.getElementById('p2');
    function check() {
      var a = latin(p1.value), b = latin(p2.value), r = HelmAuth.passwordRules(a);
      r.match = a.length > 0 && a === b;
      Array.prototype.forEach.call(document.querySelectorAll('#rules li'), function (li) {
        var ok = r[li.getAttribute('data-r')];
        li.classList.toggle('ok', !!ok);
        li.querySelector('svg').outerHTML = ok ? I.check : I.dot;
      });
      return r.length && r.notDigits && r.match;
    }
    p1.oninput = p2.oninput = check;
    document.getElementById('pwForm').onsubmit = async function (e) {
      e.preventDefault();
      var box = document.getElementById('pwMsg'), btn = document.getElementById('pwGo');
      box.innerHTML = '';
      if (!check()) { box.innerHTML = msg('error', '<b>خطأ:</b> كلمة المرور الجديدة لا تحقق الشروط.'); return; }
      btn.disabled = true;
      try {
        // confirm the current password first
        var chk = await g.sb.auth.signInWithPassword({ email: email, password: latin(document.getElementById('cur').value) });
        if (chk.error) throw new Error('wrong_current');
        await HelmAuth.setPassword(g.sb, latin(p1.value));
        document.getElementById('pwForm').reset(); check();
        box.innerHTML = msg('info', 'تم حفظ كلمة المرور الجديدة.');
      } catch (err) {
        box.innerHTML = msg('error', err.message === 'wrong_current' ? '<b>خطأ:</b> كلمة المرور الحالية غير صحيحة.' : errText(err.message));
      }
      btn.disabled = false;
    };
  }

  // ---------- users (admins) ----------
  function accessLabel(u) {
    var out = [];
    if (u.isAdmin) out.push('<span class="badge">مسؤول البوابة</span>');
    if (u.access.attendance) out.push('<span class="badge">الحضور</span>');
    if (u.access.cases) out.push('<span class="badge">الحالات: ' + esc(CASES_ROLES[u.access.cases] || u.access.cases) + '</span>');
    return out.join(' ') || '<span class="muted">بلا صلاحيات</span>';
  }
  function renderUsers() {
    var list = users.slice().sort(function (a, b) { return (a.name || '').localeCompare(b.name || '', 'ar'); });
    return '<section class="panel stack" id="users" aria-labelledby="h-users">' +
      '<div class="row-between"><h2 id="h-users" class="sec-title">المستخدمون</h2><button class="btn btn-primary" type="button" id="addUser">إضافة مستخدم</button></div>' +
      (me.isPortalAdmin ? '' : msg('info', 'بصفتك مسؤول سجل الحالات، تدير الحسابات التي لها صلاحية سجل الحالات فقط.')) +
      '<div id="uMsg"></div><div id="uForm"></div>' +
      '<ul class="ulist">' + list.map(function (u) {
        var state = !u.active ? '<span class="state off">موقوف</span>' : u.pending ? '<span class="state wait">بانتظار اختيار كلمة المرور</span>' : '';
        return '<li class="urow"><div class="uinfo"><b>' + esc(u.name || u.email) + (u.isMe ? ' <span class="muted">(أنت)</span>' : '') + '</b>' +
          '<span class="muted" dir="ltr">' + esc(u.email) + '</span><div class="badges">' + accessLabel(u) + ' ' + state + '</div></div>' +
          (u.isMe ? '' : '<div class="uacts">' +
            '<button class="btn btn-secondary btn-sm" type="button" data-edit="' + esc(u.id) + '">الصلاحيات</button>' +
            '<button class="btn btn-secondary btn-sm" type="button" data-reset="' + esc(u.id) + '">رمز مؤقت جديد</button>' +
            '<button class="btn btn-ghost btn-sm" type="button" data-active="' + esc(u.id) + '">' + (u.active ? 'إيقاف' : 'تفعيل') + '</button></div>') +
          '</li>';
      }).join('') + '</ul></section>';
  }
  function accessForm(u) {
    var isNew = !u;
    u = u || { name: '', email: '', isAdmin: false, access: { attendance: system === 'attendance', cases: system === 'cases' ? 'researcher' : null } };
    var opts = '<option value="">بلا صلاحية</option>' + Object.keys(CASES_ROLES).map(function (k) {
      return '<option value="' + k + '"' + (u.access.cases === k ? ' selected' : '') + '>' + CASES_ROLES[k] + ' — ' + ROLE_HINT[k] + '</option>';
    }).join('');
    return '<form class="subpanel stack" id="accForm" novalidate>' +
      '<h3 class="sub-title">' + (isNew ? 'مستخدم جديد' : 'صلاحيات: ' + esc(u.name)) + '</h3>' +
      '<div class="field"><label for="uName">الاسم</label><input class="input" id="uName" value="' + esc(u.name) + '" required></div>' +
      (isNew ? '<div class="field"><label for="uEmail">البريد الإلكتروني</label><input class="input" id="uEmail" type="email" dir="ltr" autocomplete="off" required></div>' : '') +
      (me.isPortalAdmin ? '<label class="check"><input type="checkbox" id="uAtt"' + (u.access.attendance ? ' checked' : '') + '> نظام الحضور والدورات</label>' : '') +
      '<div class="field"><label for="uCases">سجل الحالات</label><select class="input" id="uCases">' + opts + '</select></div>' +
      (me.isPortalAdmin ? '<label class="check"><input type="checkbox" id="uAdmin"' + (u.isAdmin ? ' checked' : '') + '> مسؤول البوابة (يدير كل المستخدمين)</label>' : '') +
      '<div class="row-gap"><button class="btn btn-primary" type="submit">' + (isNew ? 'إنشاء الحساب' : 'حفظ الصلاحيات') + '</button><button class="btn btn-ghost" type="button" id="accCancel">إلغاء</button></div></form>';
  }
  function showCode(u, code) {
    var text = 'السلام عليكم ' + (u.name || '') + '،\nتم إنشاء حسابك في أنظمة فريق حلم.\nالبريد: ' + u.email + '\nرمز الدخول المؤقت: ' + code + '\nادخل به أول مرة، وسيطلب منك النظام اختيار كلمة مرور خاصة بك.';
    document.getElementById('uForm').innerHTML = '<div class="subpanel stack" role="status"><h3 class="sub-title">رمز الدخول المؤقت لـ ' + esc(u.name || u.email) + '</h3>' +
      '<p class="code" dir="ltr">' + esc(code) + '</p>' +
      '<p class="muted">أرسله للشخص بنفسك (واتساب مثلًا). يظهر هنا مرة واحدة فقط. أول ما يدخل به، يختار كلمة مرور جديدة.</p>' +
      '<div class="row-gap"><button class="btn btn-primary" type="button" id="copyCode">نسخ الرسالة</button>' +
      '<a class="btn btn-secondary" target="_blank" rel="noopener" href="https://wa.me/?text=' + encodeURIComponent(text) + '">مشاركة عبر واتساب</a>' +
      '<button class="btn btn-ghost" type="button" id="doneCode">تم</button></div></div>';
    document.getElementById('copyCode').onclick = function () { navigator.clipboard && navigator.clipboard.writeText(text); this.textContent = 'تم النسخ'; };
    document.getElementById('doneCode').onclick = function () { document.getElementById('uForm').innerHTML = ''; };
  }
  function wireUsers() {
    var box = document.getElementById('uMsg');
    function fail(e) { box.innerHTML = msg('error', errText(e.message)); }
    document.getElementById('addUser').onclick = function () { openForm(null); };
    function openForm(u) {
      box.innerHTML = '';
      var f = document.getElementById('uForm');
      f.innerHTML = accessForm(u);
      f.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      document.getElementById('accCancel').onclick = function () { f.innerHTML = ''; };
      document.getElementById('accForm').onsubmit = async function (e) {
        e.preventDefault();
        var access = { cases: document.getElementById('uCases').value || null };
        var att = document.getElementById('uAtt'); if (att) access.attendance = att.checked;
        var adm = document.getElementById('uAdmin');
        var name = document.getElementById('uName').value.trim();
        var btn = e.target.querySelector('[type=submit]'); btn.disabled = true;
        try {
          if (!u) {
            var em = document.getElementById('uEmail').value.trim().toLowerCase();
            var r = await call({ action: 'create', name: name, email: em, access: access });
            if (adm && adm.checked) await call({ action: 'update', userId: r.id, isAdmin: true });
            await load();
            showCode({ name: name, email: em }, r.code);
          } else {
            var body = { action: 'update', userId: u.id, name: name, access: access };
            if (adm) body.isAdmin = adm.checked;
            await call(body);
            await load();
            box.innerHTML = msg('info', 'تم حفظ الصلاحيات.');
          }
        } catch (err) { fail(err); btn.disabled = false; }
      };
    }
    root.querySelectorAll('[data-edit]').forEach(function (b) {
      b.onclick = function () { openForm(users.find(function (x) { return x.id === b.getAttribute('data-edit'); })); };
    });
    root.querySelectorAll('[data-reset]').forEach(function (b) {
      b.onclick = async function () {
        var u = users.find(function (x) { return x.id === b.getAttribute('data-reset'); });
        b.disabled = true;
        try { var r = await call({ action: 'reset', userId: u.id }); await load(); showCode(u, r.code); }
        catch (e) { fail(e); b.disabled = false; }
      };
    });
    root.querySelectorAll('[data-active]').forEach(function (b) {
      b.onclick = async function () {
        var u = users.find(function (x) { return x.id === b.getAttribute('data-active'); });
        b.disabled = true;
        try { await call({ action: 'active', userId: u.id, active: !u.active }); await load(); box.innerHTML = msg('info', u.active ? 'تم إيقاف الحساب.' : 'تم تفعيل الحساب.'); }
        catch (e) { fail(e); b.disabled = false; }
      };
    });
  }

  async function load() {
    var html = renderMine();
    if (me) {
      var r = await call({ action: 'list' });
      users = r.users;
      html += renderUsers();
    }
    root.innerHTML = html;
    wireMine();
    if (me) wireUsers();
  }

  (async function start() {
    g = await HelmAuth.guard(system, 'login.html');
    var u = await g.sb.auth.getUser();
    email = (u.data && u.data.user && u.data.user.email) || '';
    var casesRole = (g.access.systems || {}).cases;
    if (g.access.is_admin || casesRole === 'admin') me = { isPortalAdmin: !!g.access.is_admin, casesRole: casesRole };
    try { await load(); }
    catch (e) { root.innerHTML = renderMine() + msg('error', errText(e.message)); wireMine(); }
    document.getElementById('out').onclick = async function () { await g.sb.auth.signOut(); location.replace('login.html'); };
    if (location.hash === '#users') { var el = document.getElementById('users'); if (el) el.scrollIntoView(); }
  })();
})();
