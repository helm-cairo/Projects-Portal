/* Helm Portal — login page controller (used by attendance/login.html and cases/login.html).
 * <body data-system="attendance|cases"> decides which system this page signs in to.
 * Screens: sign in -> (first time) choose your password -> open the system.
 */
(function () {
  'use strict';
  var system = document.body.getAttribute('data-system');
  var sysName = HelmAuth.SYSTEMS[system].name;
  var card = document.getElementById('authCard');

  var I = {
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
    dot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="5"/></svg>'
  };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function latinDigits(s) { return String(s).replace(/[٠-٩]/g, function (d) { return '٠١٢٣٤٥٦٧٨٩'.indexOf(d); }).replace(/[۰-۹]/g, function (d) { return '۰۱۲۳۴۵۶۷۸۹'.indexOf(d); }); }
  function msg(kind, html) { return '<div class="msg msg-' + kind + '" role="' + (kind === 'error' ? 'alert' : 'status') + '">' + (kind === 'error' ? I.alert : I.info) + '<div>' + html + '</div></div>'; }
  function pwField(id, label, autocomplete, hint) {
    return '<div class="field"><label for="' + id + '">' + label + '</label><div class="pw-wrap">' +
      '<input class="input" id="' + id + '" type="password" dir="ltr" autocomplete="' + autocomplete + '" required>' +
      '<button class="pw-toggle" type="button" data-toggle="' + id + '" aria-label="إظهار كلمة المرور">' + I.eye + '</button></div>' +
      (hint ? '<div class="hint">' + hint + '</div>' : '') + '</div>';
  }
  function busy(btn, on, text) {
    btn.disabled = on;
    btn.innerHTML = on ? '<span class="spinner" aria-hidden="true"></span><span>' + esc(text) + '</span>' : esc(btn.getAttribute('data-label'));
  }

  function errorText(e) {
    var m = String((e && (e.message || e.error_description || e.code)) || e || '');
    if (/invalid login credentials|invalid_credentials/i.test(m)) return '<b>خطأ:</b> البريد الإلكتروني أو كلمة المرور غير صحيحة.';
    if (/banned|user_banned/i.test(m)) return '<b>خطأ:</b> هذا الحساب موقوف. يُرجى التواصل مع المسؤول.';
    if (/rate|too many|429/i.test(m)) return '<b>خطأ:</b> محاولات كثيرة. يُرجى الانتظار قليلًا ثم المحاولة مرة أخرى.';
    if (/fetch|network|failed to/i.test(m)) return '<b>خطأ:</b> تعذّر الاتصال. تحقّق من الإنترنت ثم حاول مرة أخرى.';
    if (m === 'session_expired') return '<b>خطأ:</b> انتهت الجلسة. سجّل الدخول مرة أخرى بكلمة المرور الجديدة.';
    if (m === 'weak_password') return '<b>خطأ:</b> كلمة المرور ضعيفة. اتبع الشروط الموضحة.';
    if (m === 'secret_key_in_config') return '<b>خطأ في الإعداد:</b> الملف shared/config.js يحتوي على مفتاح سرّي. ضع المفتاح العام (publishable) فقط.';
    return '<b>خطأ:</b> حدث خطأ غير متوقع. حاول مرة أخرى.';
  }

  var sb = null;

  // ---------- screens ----------
  function showNotConfigured() {
    card.innerHTML = '<h2>تسجيل الدخول</h2><p class="sub">' + esc(sysName) + '</p>' +
      msg('info', 'لم يُربط الموقع بقاعدة البيانات بعد. أضف رابط المشروع والمفتاح العام في الملف <b dir="ltr">shared/config.js</b>.');
  }

  function showSignIn(errHtml) {
    card.innerHTML =
      '<h2>تسجيل الدخول</h2><p class="sub">ادخل بحسابك إلى ' + esc(sysName) + '.</p>' +
      (errHtml ? msg('error', errHtml) : '') +
      '<form id="f" novalidate>' +
      '<div class="field"><label for="email">البريد الإلكتروني</label><input class="input" id="email" type="email" dir="ltr" autocomplete="username" inputmode="email" required></div>' +
      pwField('pw', 'كلمة المرور', 'current-password', 'أول مرة؟ اكتب الرمز المؤقت الذي أرسله لك المسؤول.') +
      '<div id="err"></div>' +
      '<button class="btn btn-primary btn-block" type="submit" id="go" data-label="دخول">دخول</button>' +
      '</form>' +
      '<div class="auth-links"><button class="btn btn-ghost" type="button" id="forgot">نسيت كلمة المرور؟</button></div>';
    var f = document.getElementById('f'), go = document.getElementById('go'), err = document.getElementById('err');
    document.getElementById('email').focus();
    document.getElementById('forgot').onclick = showForgot;
    f.onsubmit = async function (ev) {
      ev.preventDefault();
      err.innerHTML = '';
      var email = document.getElementById('email').value.trim().toLowerCase();
      var pw = latinDigits(document.getElementById('pw').value);
      if (!email || !pw) { err.innerHTML = msg('error', '<b>خطأ:</b> اكتب البريد الإلكتروني وكلمة المرور.'); return; }
      busy(go, true, 'جارٍ الدخول');
      try {
        var r = await sb.auth.signInWithPassword({ email: email, password: pw });
        if (r.error) throw r.error;
        await afterSignIn();
      } catch (e) {
        err.innerHTML = msg('error', errorText(e));
        busy(go, false);
      }
    };
  }

  function showForgot() {
    card.innerHTML = '<h2>نسيت كلمة المرور؟</h2>' +
      msg('info', 'تواصل مع <b>مسؤول الفريق</b>، وسيعطيك رمز دخول مؤقتًا. ادخل به، وسيطلب منك النظام اختيار كلمة مرور جديدة.') +
      '<button class="btn btn-secondary btn-block" type="button" id="back" data-label="العودة لتسجيل الدخول">العودة لتسجيل الدخول</button>';
    document.getElementById('back').onclick = function () { showSignIn(); };
    document.getElementById('back').focus();
  }

  function showSetPassword(name) {
    card.innerHTML =
      '<h2>اختر كلمة مرورك</h2><p class="sub">' + (name ? 'مرحبًا ' + esc(name) + '. ' : '') + 'هذه أول مرة تدخل فيها (أو أعاد المسؤول تعيين حسابك). اختر كلمة مرور خاصة بك لتكمل.</p>' +
      '<form id="f" novalidate>' +
      pwField('p1', 'كلمة المرور الجديدة', 'new-password') +
      pwField('p2', 'أعد كتابة كلمة المرور', 'new-password') +
      '<ul class="rules" id="rules"><li data-r="length">' + I.dot + '٨ أحرف على الأقل</li><li data-r="notDigits">' + I.dot + 'ليست أرقامًا فقط</li><li data-r="match">' + I.dot + 'الكلمتان متطابقتان</li></ul>' +
      '<div id="err"></div>' +
      '<button class="btn btn-primary btn-block" type="submit" id="go" data-label="حفظ والمتابعة">حفظ والمتابعة</button>' +
      '</form>' +
      '<div class="auth-links"><button class="btn btn-ghost" type="button" id="out">خروج</button></div>';
    var p1 = document.getElementById('p1'), p2 = document.getElementById('p2'), go = document.getElementById('go'), err = document.getElementById('err');
    p1.focus();
    function check() {
      var a = latinDigits(p1.value), b = latinDigits(p2.value), r = HelmAuth.passwordRules(a);
      r.match = a.length > 0 && a === b;
      Array.prototype.forEach.call(document.querySelectorAll('#rules li'), function (li) {
        var ok = r[li.getAttribute('data-r')];
        li.classList.toggle('ok', !!ok);
        li.querySelector('svg').outerHTML = ok ? I.check : I.dot;
      });
      return r.length && r.notDigits && r.match;
    }
    p1.oninput = p2.oninput = check;
    document.getElementById('out').onclick = async function () { await sb.auth.signOut(); showSignIn(); };
    document.getElementById('f').onsubmit = async function (ev) {
      ev.preventDefault();
      err.innerHTML = '';
      if (!check()) { err.innerHTML = msg('error', '<b>خطأ:</b> كلمة المرور لا تحقق الشروط الموضحة.'); return; }
      busy(go, true, 'جارٍ الحفظ');
      try {
        await HelmAuth.setPassword(sb, latinDigits(p1.value));
        await afterSignIn();
      } catch (e) {
        err.innerHTML = msg('error', errorText(e));
        busy(go, false);
      }
    };
  }

  // ---------- after a successful sign-in / on page load with a session ----------
  async function afterSignIn() {
    var access = await HelmAuth.myAccess(sb);
    if (!access) { await sb.auth.signOut(); showSignIn('<b>خطأ:</b> لم يُعثر على بيانات هذا الحساب. تواصل مع المسؤول.'); return; }
    if (access.must_set_password) { showSetPassword(access.full_name); return; }
    if (!access.systems || !access.systems[system]) {
      await sb.auth.signOut();
      showSignIn('<b>خطأ:</b> هذا الحساب ليس لديه صلاحية دخول ' + esc(sysName) + '.');
      return;
    }
    location.replace('./');
  }

  // ---------- show / hide password ----------
  card.addEventListener('click', function (e) {
    var t = e.target.closest('[data-toggle]');
    if (!t) return;
    var inp = document.getElementById(t.getAttribute('data-toggle'));
    var show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    t.innerHTML = show ? I.eyeOff : I.eye;
    t.setAttribute('aria-label', show ? 'إخفاء كلمة المرور' : 'إظهار كلمة المرور');
  });

  // ---------- start ----------
  (async function start() {
    if (!HelmAuth.configured()) { showNotConfigured(); return; }
    try { sb = HelmAuth.client(system); } catch (e) { card.innerHTML = '<h2>تسجيل الدخول</h2>' + msg('error', errorText(e)); return; }
    var q = new URLSearchParams(location.search);
    var pre = q.get('e') === 'noaccess' ? '<b>خطأ:</b> هذا الحساب ليس لديه صلاحية دخول ' + esc(sysName) + '.' : '';
    try {
      var s = await sb.auth.getSession();
      if (s.data.session && !pre) { await afterSignIn(); return; }
    } catch (e) { /* fall through to sign-in */ }
    showSignIn(pre);
  })();
})();
