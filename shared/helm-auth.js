/* Helm Portal — shared sign-in helpers.
 *
 * Each system has its OWN Supabase client with its OWN storage key, so signing
 * in to attendance does not sign you in to cases (and the other way round).
 * The page checks access on every load, but the real protection is RLS in the
 * database: without access, the database returns nothing.
 *
 * Needs (before this file): supabase-js UMD build and shared/config.js
 */
(function () {
  'use strict';

  var SYSTEMS = {
    attendance: { storageKey: 'helm-attendance-auth', name: 'نظام الحضور والدورات' },
    cases:      { storageKey: 'helm-cases-auth',      name: 'سجل الحالات' }
  };

  var cfg = window.HELM_CONFIG || {};
  var clients = {};

  function configured() {
    return !!(cfg.SUPABASE_URL && cfg.SUPABASE_PUBLISHABLE_KEY);
  }

  // Refuse to run with a secret key by mistake.
  function keyIsSecret(key) {
    if (/^sb_secret_/i.test(key)) return true;
    var parts = String(key).split('.');
    if (parts.length === 3) {
      try {
        var payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        return payload.role === 'service_role';
      } catch (e) { return false; }
    }
    return false;
  }

  function client(system) {
    if (!SYSTEMS[system]) throw new Error('unknown system ' + system);
    if (!configured()) return null;
    if (keyIsSecret(cfg.SUPABASE_PUBLISHABLE_KEY)) {
      throw new Error('secret_key_in_config');
    }
    if (!clients[system]) {
      clients[system] = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_PUBLISHABLE_KEY, {
        auth: {
          storageKey: SYSTEMS[system].storageKey,
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false
        }
      });
    }
    return clients[system];
  }

  async function myAccess(sb) {
    var r = await sb.rpc('my_access');
    if (r.error) throw r.error;
    return r.data; // {id, full_name, is_admin, must_set_password, systems:{attendance:'member', cases:'researcher'}}
  }

  // For app pages: returns {sb, access, role} or redirects to the login page.
  async function guard(system, loginUrl) {
    loginUrl = loginUrl || 'login.html';
    var sb = client(system);
    if (!sb) { location.replace(loginUrl); return new Promise(function () {}); }
    var s = await sb.auth.getSession();
    if (!s.data.session) { location.replace(loginUrl); return new Promise(function () {}); }
    var access;
    try { access = await myAccess(sb); } catch (e) { access = null; }
    if (!access || access.must_set_password || !access.systems || !access.systems[system]) {
      if (access && !access.must_set_password) await sb.auth.signOut();
      location.replace(loginUrl + (access && !access.must_set_password ? '?e=noaccess' : ''));
      return new Promise(function () {});
    }
    // If the session ends (signed out in another tab, account disabled), go back to login.
    sb.auth.onAuthStateChange(function (ev) { if (ev === 'SIGNED_OUT') location.replace(loginUrl); });
    return { sb: sb, access: access, role: access.systems[system] };
  }

  async function setPassword(sb, password) {
    var cur = await sb.auth.getSession();
    var email = cur.data.session && cur.data.session.user && cur.data.session.user.email;
    var r = await sb.functions.invoke('admin-users', { body: { action: 'set_password', password: password } });
    if (r.error) {
      var code = 'server_error';
      try { var j = await r.error.context.json(); code = j.error || code; } catch (e) {}
      throw new Error(code);
    }
    if (!r.data || !r.data.ok) throw new Error((r.data && r.data.error) || 'server_error');
    // Changing the password ends the old session on the server, so sign in again
    // with the new password to get a fresh session.
    try { await sb.auth.signOut({ scope: 'local' }); } catch (e) {}
    if (!email) throw new Error('session_expired');
    var again = await sb.auth.signInWithPassword({ email: email, password: password });
    if (again.error) throw again.error;
    return true;
  }

  function passwordRules(p) {
    return { length: p.length >= 8, notDigits: p.length > 0 && !/^\d+$/.test(p) };
  }

  window.HelmAuth = {
    SYSTEMS: SYSTEMS,
    configured: configured,
    keyIsSecret: keyIsSecret,
    client: client,
    myAccess: myAccess,
    guard: guard,
    setPassword: setPassword,
    passwordRules: passwordRules
  };
})();
