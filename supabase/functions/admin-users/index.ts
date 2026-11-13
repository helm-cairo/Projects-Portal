// Helm Portal — Edge Function "admin-users"
//
// Runs on Supabase's servers. The service key it uses is provided by Supabase
// automatically (SUPABASE_SERVICE_ROLE_KEY) and never reaches the browser or GitHub.
//
// Any signed-in user:
//   set_password   choose their own password (first sign-in or after a reset)
//
// Portal admin (profiles.is_admin) — everything:
//   list | create | reset | update | active
//
// Cases "admin" role (مسؤول) without portal admin — limited to the cases system:
//   may list/create/reset/update/disable ONLY accounts that have cases access only
//   (no attendance access, not a portal admin), and may change only the cases role.
//   This stops a cases admin from taking over an attendance account.
//
// No emails are sent: the admin gets an 8-digit temporary code and passes it to
// the person (e.g. WhatsApp). On first sign-in the app asks them to choose a password.
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const CASES_ROLES = ["admin", "approver", "researcher", "viewer"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Access = { attendance?: boolean; cases?: string | null };
type Profile = { id: string; full_name: string; is_admin: boolean; must_set_password: boolean };

function tempCode() {
  const a = new Uint32Array(8);
  crypto.getRandomValues(a);
  return Array.from(a, (n) => String(n % 10)).join("");
}

function strongEnough(p: string) {
  return p.length >= 8 && !/^\d+$/.test(p);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ ok: false, error: "unauthorized" }, 401);
  const { data: { user: caller } } = await admin.auth.getUser(jwt);
  if (!caller) return json({ ok: false, error: "unauthorized" }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }

  // ---------- choose your own password ----------
  if (body.action === "set_password") {
    const pass = String(body.password ?? "");
    if (!strongEnough(pass)) return json({ ok: false, error: "weak_password" }, 400);
    const { error } = await admin.auth.admin.updateUserById(caller.id, {
      password: pass,
      app_metadata: { must_set_password: false },
    });
    if (error) { console.error("set_password", error); return json({ ok: false, error: "server_error" }, 500); }
    await admin.from("profiles").update({ must_set_password: false }).eq("id", caller.id);
    return json({ ok: true });
  }

  // ---------- who is calling? ----------
  const { data: me } = await admin.from("profiles").select("id, full_name, is_admin, must_set_password")
    .eq("id", caller.id).maybeSingle<Profile>();
  if (!me || me.must_set_password) return json({ ok: false, error: "forbidden" }, 403);
  const { data: myAccess } = await admin.from("system_access").select("system, role").eq("user_id", caller.id);
  const myCasesRole = myAccess?.find((a) => a.system === "cases")?.role ?? null;
  const isPortalAdmin = me.is_admin === true;
  const isCasesAdmin = myCasesRole === "admin";
  if (!isPortalAdmin && !isCasesAdmin) return json({ ok: false, error: "forbidden" }, 403);

  async function accessOf(id: string) {
    const { data } = await admin.from("system_access").select("system, role").eq("user_id", id);
    const out: Access = { attendance: false, cases: null };
    for (const a of data ?? []) {
      if (a.system === "attendance") out.attendance = true;
      if (a.system === "cases") out.cases = a.role;
    }
    return out;
  }
  // can the caller manage this target account?
  async function canManage(id: string) {
    if (isPortalAdmin) return true;
    const { data: p } = await admin.from("profiles").select("is_admin").eq("id", id).maybeSingle();
    if (!p || p.is_admin) return false;
    const acc = await accessOf(id);
    return !acc.attendance;
  }
  async function setAccess(id: string, acc: Access) {
    if (acc.attendance !== undefined && isPortalAdmin) {
      if (acc.attendance) {
        await admin.from("system_access").upsert({ user_id: id, system: "attendance", role: "member" });
      } else {
        await admin.from("system_access").delete().eq("user_id", id).eq("system", "attendance");
      }
    }
    if (acc.cases !== undefined) {
      if (acc.cases) {
        await admin.from("system_access").upsert({ user_id: id, system: "cases", role: acc.cases });
      } else {
        await admin.from("system_access").delete().eq("user_id", id).eq("system", "cases");
      }
    }
  }
  function parseAccess(raw: unknown): Access | string {
    const a = (raw ?? {}) as Record<string, unknown>;
    const out: Access = {};
    if (a.attendance !== undefined) {
      if (!isPortalAdmin) return "forbidden_attendance";
      out.attendance = a.attendance === true;
    }
    if (a.cases !== undefined) {
      const r = a.cases === null || a.cases === "" ? null : String(a.cases);
      if (r !== null && !CASES_ROLES.includes(r)) return "bad_role";
      out.cases = r;
    }
    return out;
  }

  try {
    switch (body.action) {
      case "list": {
        const { data: list, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
        if (error) throw error;
        const { data: profiles } = await admin.from("profiles").select("id, full_name, is_admin, must_set_password");
        const { data: access } = await admin.from("system_access").select("user_id, system, role");
        const byId = new Map((profiles ?? []).map((p) => [p.id, p]));
        const users = list.users.map((u) => {
          const p = byId.get(u.id);
          const acc: Access = { attendance: false, cases: null };
          for (const a of access ?? []) if (a.user_id === u.id) {
            if (a.system === "attendance") acc.attendance = true;
            if (a.system === "cases") acc.cases = a.role;
          }
          return {
            id: u.id,
            email: u.email,
            name: p?.full_name ?? "",
            isAdmin: !!p?.is_admin,
            access: acc,
            pending: !!p?.must_set_password,
            active: !u.banned_until || new Date(u.banned_until) < new Date(),
            lastSignIn: u.last_sign_in_at ?? null,
            createdAt: u.created_at,
            isMe: u.id === caller.id,
          };
        }).filter((u) => isPortalAdmin || (u.isMe || (!u.isAdmin && !u.access.attendance && u.access.cases)));
        return json({ ok: true, users, me: { isPortalAdmin, casesRole: myCasesRole } });
      }

      case "create": {
        const email = String(body.email ?? "").trim().toLowerCase();
        const name = String(body.name ?? "").trim();
        if (!EMAIL_RE.test(email)) return json({ ok: false, error: "bad_email" }, 400);
        if (!name) return json({ ok: false, error: "bad_name" }, 400);
        const acc = parseAccess(body.access);
        if (typeof acc === "string") return json({ ok: false, error: acc }, 400);
        if (!acc.attendance && !acc.cases) return json({ ok: false, error: "no_access" }, 400);
        const code = tempCode();
        const { data: created, error } = await admin.auth.admin.createUser({
          email,
          password: code,
          email_confirm: true,
          user_metadata: { full_name: name },
          app_metadata: { must_set_password: true },
        });
        if (error) {
          if (/already|registered|exists/i.test(error.message)) return json({ ok: false, error: "email_exists" }, 409);
          throw error;
        }
        await admin.from("profiles").upsert({ id: created.user.id, full_name: name, must_set_password: true });
        await setAccess(created.user.id, acc);
        return json({ ok: true, id: created.user.id, code });
      }

      case "reset": {
        const id = String(body.userId ?? "");
        if (id === caller.id) return json({ ok: false, error: "self_reset" }, 400);
        if (!(await canManage(id))) return json({ ok: false, error: "forbidden" }, 403);
        const code = tempCode();
        const { error } = await admin.auth.admin.updateUserById(id, {
          password: code,
          app_metadata: { must_set_password: true },
        });
        if (error) throw error;
        await admin.from("profiles").update({ must_set_password: true }).eq("id", id);
        return json({ ok: true, code });
      }

      case "update": {
        const id = String(body.userId ?? "");
        if (!(await canManage(id))) return json({ ok: false, error: "forbidden" }, 403);
        if (body.name != null) {
          const name = String(body.name).trim();
          if (!name) return json({ ok: false, error: "bad_name" }, 400);
          await admin.from("profiles").update({ full_name: name }).eq("id", id);
        }
        if (body.isAdmin != null) {
          if (!isPortalAdmin) return json({ ok: false, error: "forbidden" }, 403);
          if (id === caller.id && body.isAdmin !== true) return json({ ok: false, error: "self_demote" }, 400);
          await admin.from("profiles").update({ is_admin: body.isAdmin === true }).eq("id", id);
        }
        if (body.access != null) {
          const acc = parseAccess(body.access);
          if (typeof acc === "string") return json({ ok: false, error: acc }, 400);
          if (id === caller.id && acc.cases !== undefined && myCasesRole === "admin" && acc.cases !== "admin" && !isPortalAdmin) {
            return json({ ok: false, error: "self_demote" }, 400);
          }
          await setAccess(id, acc);
        }
        return json({ ok: true });
      }

      case "active": {
        const id = String(body.userId ?? "");
        if (id === caller.id) return json({ ok: false, error: "self_disable" }, 400);
        if (!(await canManage(id))) return json({ ok: false, error: "forbidden" }, 403);
        const on = body.active === true;
        const { error } = await admin.auth.admin.updateUserById(id, { ban_duration: on ? "none" : "876000h" });
        if (error) throw error;
        return json({ ok: true });
      }

      default:
        return json({ ok: false, error: "unknown_action" }, 400);
    }
  } catch (e) {
    console.error("admin-users", e);
    return json({ ok: false, error: "server_error" }, 500);
  }
});
