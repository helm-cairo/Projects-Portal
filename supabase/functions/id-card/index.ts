// Helm Portal — Edge Function "id-card"
// Secure bridge between the cases app and Google Apps Script (private Google Drive folder).
//
//  - checks the caller is signed in and has the right cases role
//  - the Apps Script URL and password live ONLY here, as Supabase secrets
//  - "get" asks the database AS THE CALLER (their own token), so the RLS rules
//    decide: viewers never get an image, a researcher only for her own cases
//
// Secrets (Supabase -> Edge Functions -> Secrets):
//   APPS_SCRIPT_URL     the Web app URL from Apps Script
//   APPS_SCRIPT_SECRET  the password printed by the Apps Script "setup" function
// Optional AI reading of the card (set at most one; otherwise Google Drive OCR is used):
//   ANTHROPIC_API_KEY (+ optional ANTHROPIC_MODEL)   or   GEMINI_API_KEY (+ optional GEMINI_MODEL)
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// ---------- optional AI extraction ----------
const FIELDS = {
  side: { type: "string", enum: ["front", "back", "unknown"], description: "Which side of the card is shown" },
  is_egyptian_id: { type: "boolean", description: "True only if the image is an Egyptian national ID card" },
  full_name: { type: "string", description: "Full name exactly as printed in Arabic. Empty if not visible." },
  address: { type: "string", description: "Full address as printed in Arabic, lines joined with ' - '. Empty if not visible." },
  national_id: { type: "string", description: "The 14-digit national ID number in ASCII digits, no spaces. Empty if not fully readable." },
  birth_date: { type: "string", description: "Birth date as YYYY-MM-DD if printed, else empty." },
  occupation: { type: "string", description: "Occupation as printed in Arabic on the back, else empty." },
  marital_status: { type: "string", enum: ["married", "widowed", "divorced", "single", ""], description: "Marital status on the back, else empty." },
  spouse_name: { type: "string", description: "Spouse name if printed on the back, else empty." },
  gender: { type: "string", enum: ["male", "female", ""], description: "Gender printed on the back, else empty." },
  expiry_date: { type: "string", description: "Card expiry date as YYYY-MM-DD, else empty." },
  notes: { type: "string", description: "Short Arabic note about problems (blur, glare, cropped, not an ID), else empty." },
};
const REQUIRED = Object.keys(FIELDS);
const PROMPT =
  "You are reading a photo of an Egyptian national ID card, front or back side. " +
  "Extract only what is clearly printed; never guess. Keep Arabic text exactly as printed. " +
  "Convert Arabic-Indic digits to ASCII digits in national_id and dates. " +
  "Do NOT extract or mention religion. If the image is not an Egyptian ID card, set is_egyptian_id=false and leave other fields empty.";

type AiFields = Record<string, unknown>;

async function extractWithClaude(key: string, b64: string, mime: string): Promise<AiFields> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5-5",
      max_tokens: 1024,
      tools: [{
        name: "record_id_card",
        description: "Record the fields read from the Egyptian national ID card image.",
        input_schema: { type: "object", properties: FIELDS, required: REQUIRED },
      }],
      tool_choice: { type: "tool", name: "record_id_card" },
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mime, data: b64 } },
          { type: "text", text: PROMPT },
        ],
      }],
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error("claude " + res.status + ": " + (j?.error?.message ?? ""));
  const block = (j.content ?? []).find((c: { type: string }) => c.type === "tool_use");
  if (!block) throw new Error("claude: no tool output");
  return block.input as AiFields;
}

async function extractWithGemini(key: string, b64: string, mime: string): Promise<AiFields> {
  const model = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";
  const props: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(FIELDS)) {
    const allowed = "enum" in v ? " Allowed values: " + (v as { enum: string[] }).enum.map((x) => x || "(empty)").join(", ") + "." : "";
    props[k] = { type: v.type === "boolean" ? "BOOLEAN" : "STRING", description: v.description + allowed };
  }
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ inline_data: { mime_type: mime, data: b64 } }, { text: PROMPT }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: { type: "OBJECT", properties: props } },
    }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error("gemini " + res.status + ": " + (j?.error?.message ?? ""));
  const text = j?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
  return JSON.parse(text) as AiFields;
}

function aiProvider(): { name: string; run: (b64: string, mime: string) => Promise<AiFields> } | null {
  const a = Deno.env.get("ANTHROPIC_API_KEY");
  if (a) return { name: "claude", run: (b, m) => extractWithClaude(a, b, m) };
  const g = Deno.env.get("GEMINI_API_KEY");
  if (g) return { name: "gemini", run: (b, m) => extractWithGemini(g, b, m) };
  return null;
}

// Short, plain text for file/folder names (no path characters or control chars).
function cleanText(v: unknown, max: number) {
  return String(v ?? "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

async function callScript(url: string, secret: string, payload: Record<string, unknown>) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ ...payload, secret }),
      redirect: "follow",
    });
    const text = await res.text();
    try { return JSON.parse(text) as Record<string, unknown>; } catch { return { ok: false, error: "apps_script_bad_response" }; }
  } catch (_e) {
    return { ok: false, error: "apps_script_unreachable" };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const scriptUrl = Deno.env.get("APPS_SCRIPT_URL");
  const scriptSecret = Deno.env.get("APPS_SCRIPT_SECRET");
  if (!scriptUrl || !scriptSecret) return json({ ok: false, error: "not_configured" }, 500);

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json({ ok: false, error: "unauthorized" }, 401);

  // A client that acts AS THE CALLER: every query below goes through RLS.
  // Public key: the project's anon key, or (after legacy keys are retired) the
  // publishable key the browser sent in the "apikey" header.
  const publicKey = Deno.env.get("SUPABASE_ANON_KEY") || req.headers.get("apikey") || "";
  const asUser = createClient(Deno.env.get("SUPABASE_URL")!, publicKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: { user } } = await asUser.auth.getUser(jwt);
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);

  const { data: role, error: roleErr } = await asUser.rpc("cases_role");
  if (roleErr || !role) return json({ ok: false, error: "forbidden" }, 403);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad_json" }, 400); }

  if (body.action === "upload") {
    if (!["admin", "approver", "researcher"].includes(String(role))) return json({ ok: false, error: "forbidden" }, 403);
    const caseId = String(body.caseId ?? "").replace(/[^\w-]/g, "").slice(0, 60);
    // An existing case must be one the caller may edit; a brand-new case id is fine.
    if (caseId) {
      const { data: exists } = await asUser.rpc("cases_can_see", { p_case_id: caseId });
      const { count } = await asUser.from("cases_cases").select("id", { count: "exact", head: true }).eq("id", caseId);
      if (count && !exists) return json({ ok: false, error: "forbidden" }, 403);
    }
    const data = String(body.data ?? "");
    if (!data || data.length > 11_000_000) return json({ ok: false, error: "bad_image" }, 400);
    const mime = /^image\/(jpeg|png|webp)$/.test(String(body.mime)) ? String(body.mime) : "image/jpeg";
    const side = body.side === "back" ? "back" : "front";
    const payload = {
      action: "upload", caseId, side, mime, data,
      code: cleanText(body.code, 30), name: cleanText(body.name, 80),
    };
    const ai = aiProvider();
    const [out, aiRes] = await Promise.all([
      callScript(scriptUrl, scriptSecret, payload),
      ai ? ai.run(data, mime).then((fields) => ({ fields }), (e) => ({ error: String(e?.message ?? e) })) : Promise.resolve(null),
    ]);
    if (out.ok && aiRes) {
      out.ai = ai!.name;
      if ("fields" in aiRes) out.fields = aiRes.fields;
      else { out.aiError = "ai_failed"; console.error("AI extraction failed:", aiRes.error); }
    }
    return json(out, out.ok ? 200 : 502);
  }

  if (body.action === "rename") {
    // Rename a case's Drive folder and ID photos to "code - name - Front/Back".
    if (!["admin", "approver", "researcher"].includes(String(role))) return json({ ok: false, error: "forbidden" }, 403);
    const caseId = String(body.caseId ?? "").replace(/[^\w-]/g, "").slice(0, 60);
    if (!caseId) return json({ ok: false, error: "bad_case" }, 400);
    const { data: canSee } = await asUser.rpc("cases_can_see", { p_case_id: caseId });
    if (!canSee) return json({ ok: false, error: "forbidden" }, 403);
    // File ids come from the database (as the caller), never from the browser.
    const { data: priv } = await asUser.from("cases_private")
      .select("id_front_file_id, id_back_file_id").eq("case_id", caseId).maybeSingle();
    const files: { id: string; side: string }[] = [];
    if (priv?.id_front_file_id) files.push({ id: priv.id_front_file_id, side: "front" });
    if (priv?.id_back_file_id) files.push({ id: priv.id_back_file_id, side: "back" });
    // Photos that were replaced in the last save. Apps Script trashes them only if they
    // sit in THIS case's Drive folder and are not the case's current photos.
    const current = new Set(files.map((f) => f.id));
    const trash = (Array.isArray(body.trash) ? body.trash : [])
      .map((x: unknown) => String(x)).filter((x: string) => /^[\w-]{10,}$/.test(x) && !current.has(x)).slice(0, 4);
    if (!files.length && !trash.length) return json({ ok: true, renamed: 0 });
    const out = await callScript(scriptUrl, scriptSecret, {
      action: "rename", caseId, files, trash, code: cleanText(body.code, 30), name: cleanText(body.name, 80),
    });
    return json(out, out.ok ? 200 : 502);
  }

  if (body.action === "get") {
    const fileId = String(body.fileId ?? "");
    if (!/^[\w-]{10,}$/.test(fileId)) return json({ ok: false, error: "bad_id" }, 400);
    // RLS on cases_private: admin/approver all, researcher own cases, viewer none.
    const { data: owner } = await asUser
      .from("cases_private")
      .select("case_id")
      .or(`id_front_file_id.eq.${fileId},id_back_file_id.eq.${fileId}`)
      .limit(1);
    if (!owner?.length) return json({ ok: false, error: "not_found" }, 404);
    const out = await callScript(scriptUrl, scriptSecret, { action: "get", fileId });
    return json(out, out.ok ? 200 : 502);
  }

  return json({ ok: false, error: "unknown_action" }, 400);
});
