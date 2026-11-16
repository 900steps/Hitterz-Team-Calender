// Supabase Edge Function: admin-users
// Lets the owner / admins create accounts and reset passwords,
// and lets the owner change roles and delete accounts.
//
// Deploy: Supabase Dashboard → Edge Functions → "Deploy a new function"
//         → "Via Editor", name it exactly  admin-users , paste this file.
import { createClient } from "npm:@supabase/supabase-js@2";

const EMAIL_DOMAIN = "team.local"; // must match EMAIL_DOMAIN in config.js

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{1,30}[a-z0-9]$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Who is calling?
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return reply({ error: "未登录" }, 401);
  const { data: who, error: whoErr } = await admin.auth.getUser(token);
  if (whoErr || !who?.user) return reply({ error: "登录已失效，请重新登录" }, 401);

  const { data: me } = await admin.from("profiles")
    .select("id, username, display_name, role").eq("id", who.user.id).single();
  if (!me || (me.role !== "owner" && me.role !== "admin")) {
    return reply({ error: "只有网站创建者或管理员可以管理账号" }, 403);
  }
  const isOwner = me.role === "owner";

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return reply({ error: "Bad JSON" }, 400); }
  const action = String(body.action ?? "");

  async function audit(actionName: string, recordId: string | null, data: unknown) {
    await admin.from("audit_log").insert({
      actor: me!.id,
      actor_name: `${me!.display_name} (${me!.username})`,
      action: actionName,
      table_name: "accounts",
      record_id: recordId,
      new_data: data,
    });
  }

  async function target(userId: unknown) {
    if (typeof userId !== "string") return null;
    const { data } = await admin.from("profiles").select("id, username, role").eq("id", userId).single();
    return data;
  }

  const validPassword = (p: unknown) => typeof p === "string" && p.length >= 8 && p.length <= 72;

  try {
    if (action === "create") {
      const username = String(body.username ?? "").trim().toLowerCase();
      const password = body.password;
      const role = isOwner && body.role === "admin" ? "admin" : "member";
      if (!USERNAME_RE.test(username)) {
        return reply({ error: "用户名需为 3–32 位小写字母、数字或 . _ -" }, 400);
      }
      if (!validPassword(password)) return reply({ error: "密码至少 8 位" }, 400);

      const { data, error } = await admin.auth.admin.createUser({
        email: `${username}@${EMAIL_DOMAIN}`,
        password: password as string,
        email_confirm: true,
      });
      if (error) {
        const msg = /already|registered|exists/i.test(error.message) ? "该用户名已存在" : error.message;
        return reply({ error: msg }, 400);
      }
      if (role === "admin") await admin.from("profiles").update({ role }).eq("id", data.user.id);
      await audit("ADMIN_CREATE_USER", data.user.id, { username, role });
      return reply({ ok: true, id: data.user.id });
    }

    if (action === "reset_password") {
      const t = await target(body.user_id);
      if (!t) return reply({ error: "用户不存在" }, 404);
      if (!isOwner && t.role !== "member" && t.id !== me.id) {
        return reply({ error: "管理员只能重置普通成员的密码" }, 403);
      }
      if (!validPassword(body.password)) return reply({ error: "密码至少 8 位" }, 400);
      const { error } = await admin.auth.admin.updateUserById(t.id, { password: body.password as string });
      if (error) return reply({ error: error.message }, 400);
      await audit("ADMIN_RESET_PASSWORD", t.id, { username: t.username });
      return reply({ ok: true });
    }

    if (action === "set_role") {
      if (!isOwner) return reply({ error: "只有网站创建者可以设置管理员" }, 403);
      const t = await target(body.user_id);
      if (!t) return reply({ error: "用户不存在" }, 404);
      if (t.role === "owner") return reply({ error: "不能修改创建者的角色" }, 400);
      const role = body.role === "admin" ? "admin" : "member";
      const { error } = await admin.from("profiles").update({ role }).eq("id", t.id);
      if (error) return reply({ error: error.message }, 400);
      await audit("ADMIN_SET_ROLE", t.id, { username: t.username, from: t.role, to: role });
      return reply({ ok: true });
    }

    if (action === "delete") {
      if (!isOwner) return reply({ error: "只有网站创建者可以删除账号" }, 403);
      const t = await target(body.user_id);
      if (!t) return reply({ error: "用户不存在" }, 404);
      if (t.role === "owner") return reply({ error: "不能删除创建者账号" }, 400);
      const { error } = await admin.auth.admin.deleteUser(t.id);
      if (error) return reply({ error: error.message }, 400);
      await audit("ADMIN_DELETE_USER", t.id, { username: t.username });
      return reply({ ok: true });
    }

    return reply({ error: "Unknown action" }, 400);
  } catch (e) {
    return reply({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
