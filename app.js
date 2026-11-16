import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_KEY, SITE_TITLE, EMAIL_DOMAIN } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------------------------------------------------------- constants
const STATUS = {
  going:     { label: "确定参与", color: "var(--going)" },
  late:      { label: "会迟到",   color: "var(--late)" },
  maybe:     { label: "不确定",   color: "var(--maybe)" },
  not_going: { label: "无法参与", color: "var(--no)" },
};
const STATUS_ORDER = ["going", "late", "maybe", "not_going"];
const ROLE_LABEL = { owner: "创建者", admin: "管理员", member: "成员" };
const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const SLOT_MIN = 30;
const SLOTS = 48;

// ---------------------------------------------------------------- state
const state = {
  me: null,             // my profile row
  profiles: new Map(),  // id -> profile
  tab: "calendar",
  mode: window.innerWidth < 640 ? "month" : "month",
  cursor: startOfDay(new Date()),
  events: [],
  responses: new Map(), // event_id -> [response]
  channel: null,
};
const isAdmin = () => state.me && (state.me.role === "owner" || state.me.role === "admin");
const isOwner = () => state.me?.role === "owner";
const nameOf = (id) => state.profiles.get(id)?.display_name ?? "（已删除用户）";

// ---------------------------------------------------------------- dates
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function addMonths(d, n) { const x = new Date(d); const day = x.getDate(); x.setDate(1); x.setMonth(x.getMonth() + n); x.setDate(Math.min(day, daysInMonth(x))); return x; }
function daysInMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); }
function startOfWeek(d) { const x = startOfDay(d); return addDays(x, -x.getDay()); } // Sunday
function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
const pad = (n) => String(n).padStart(2, "0");
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtDate = (d) => `${d.getMonth() + 1}月${d.getDate()}日 周${WEEKDAYS[d.getDay()]}`;
const fmtDateTime = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm(d)}`;
function fromInputs(dateStr, timeStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = timeStr.split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm);
}
// Allowed window: past 3 months … next 12 months
function windowMin() { return startOfDay(addMonths(new Date(), -3)); }
function windowMax() { return addMonths(new Date(), 12); }
const inWindow = (d) => d >= windowMin() && d <= windowMax();

// ---------------------------------------------------------------- ui helpers
function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
const modal = $("#modal");
function openModal(html) { $("#modal-body").innerHTML = html; if (!modal.open) modal.showModal(); }
function closeModal() { if (modal.open) modal.close(); }
modal.addEventListener("click", (e) => { if (e.target === modal || e.target.closest(".close-x")) closeModal(); });
function friendlyError(error) {
  const m = error?.message ?? String(error);
  if (/row-level security|permission denied/i.test(m)) return "没有权限执行此操作";
  if (/past 3 months|next 12 months/i.test(m)) return "日程只能安排在过去 3 个月到未来 12 个月之间";
  if (/Invalid login credentials/i.test(m)) return "用户名或密码错误";
  return m;
}

// ---------------------------------------------------------------- auth
document.title = SITE_TITLE;
$("#brand").textContent = SITE_TITLE;
$("#login-title").textContent = SITE_TITLE;

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const username = f.username.value.trim().toLowerCase();
  $("#login-error").textContent = "";
  const { error } = await sb.auth.signInWithPassword({ email: `${username}@${EMAIL_DOMAIN}`, password: f.password.value });
  if (error) { $("#login-error").textContent = friendlyError(error); return; }
  await sb.rpc("log_login");
  f.reset();
  await boot();
});

$("#logout").addEventListener("click", async () => {
  await sb.auth.signOut();
  location.reload();
});

async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { $("#login-view").hidden = false; $("#app-view").hidden = true; return; }
  await loadProfiles();
  state.me = state.profiles.get(session.user.id);
  if (!state.me) { toast("找不到账号资料，请联系管理员"); await sb.auth.signOut(); return; }
  $("#login-view").hidden = true; $("#app-view").hidden = false;
  $$("[data-admin]").forEach((el) => (el.hidden = !isAdmin()));
  $("#member-role-wrap").hidden = !isOwner();
  subscribeRealtime();
  showTab(state.tab);
}

async function loadProfiles() {
  const { data, error } = await sb.from("profiles").select("*").order("display_name");
  if (error) { toast(friendlyError(error)); return; }
  state.profiles = new Map(data.map((p) => [p.id, p]));
  if (state.me) state.me = state.profiles.get(state.me.id) ?? state.me;
}

// ---------------------------------------------------------------- tabs
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]"); if (b) showTab(b.dataset.tab);
});
function showTab(tab) {
  state.tab = tab;
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".tab-panel").forEach((p) => (p.hidden = p.id !== `tab-${tab}`));
  ({ calendar: renderCalendar, chat: loadChat, tasks: loadTasks, members: loadMembers, audit: loadAudit, me: renderMe })[tab]();
}

// ---------------------------------------------------------------- realtime
function subscribeRealtime() {
  if (state.channel) return;
  let calTimer;
  const refreshCal = () => { clearTimeout(calTimer); calTimer = setTimeout(() => state.tab === "calendar" && renderCalendar(), 400); };
  state.channel = sb.channel("live")
    .on("postgres_changes", { event: "*", schema: "public", table: "events" }, refreshCal)
    .on("postgres_changes", { event: "*", schema: "public", table: "responses" }, refreshCal)
    .on("postgres_changes", { event: "*", schema: "public", table: "assignments" }, () => state.tab === "tasks" && loadTasks())
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (p) => onNewMessage(p.new))
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "messages" }, (p) => {
      const el = document.querySelector(`.msg[data-id="${p.old.id}"]`); el?.remove();
    })
    .subscribe();
}

// ================================================================= CALENDAR
$("#cal-mode").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-mode]"); if (!b) return;
  state.mode = b.dataset.mode; renderCalendar();
});
$("#cal-today").addEventListener("click", () => { state.cursor = startOfDay(new Date()); renderCalendar(); });
$("#cal-prev").addEventListener("click", () => step(-1));
$("#cal-next").addEventListener("click", () => step(1));

function viewRange(mode = state.mode, cursor = state.cursor) {
  if (mode === "month") {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const start = startOfWeek(first);
    return { start, end: addDays(start, 42) };
  }
  if (mode === "week") { const start = startOfWeek(cursor); return { start, end: addDays(start, 7) }; }
  return { start: startOfDay(cursor), end: addDays(startOfDay(cursor), 1) };
}
function stepCursor(dir) {
  if (state.mode === "month") return new Date(state.cursor.getFullYear(), state.cursor.getMonth() + dir, 1);
  return addDays(state.cursor, dir * (state.mode === "week" ? 7 : 1));
}
function step(dir) {
  const next = stepCursor(dir);
  const r = viewRange(state.mode, next);
  if (r.end <= windowMin() || r.start > windowMax()) return;
  state.cursor = next; renderCalendar();
}

async function loadEvents(start, end) {
  const { data: events, error } = await sb.from("events").select("*")
    .lt("start_at", end.toISOString()).gt("end_at", start.toISOString()).order("start_at");
  if (error) { toast(friendlyError(error)); return; }
  state.events = events.map((e) => ({ ...e, s: new Date(e.start_at), e: new Date(e.end_at) }));
  state.responses = new Map();
  const ids = events.map((e) => e.id);
  for (let i = 0; i < ids.length; i += 150) {
    const { data } = await sb.from("responses").select("*").in("event_id", ids.slice(i, i + 150));
    (data ?? []).forEach((r) => {
      if (!state.responses.has(r.event_id)) state.responses.set(r.event_id, []);
      state.responses.get(r.event_id).push(r);
    });
  }
}

let renderSeq = 0;
async function renderCalendar() {
  const seq = ++renderSeq;
  const { start, end } = viewRange();
  $$("#cal-mode button").forEach((b) => b.classList.toggle("active", b.dataset.mode === state.mode));
  const c = state.cursor;
  $("#cal-title").textContent =
    state.mode === "month" ? `${c.getFullYear()}年${c.getMonth() + 1}月`
    : state.mode === "week" ? `${start.getFullYear()}年 ${fmtDate(start).split(" ")[0]} – ${fmtDate(addDays(end, -1)).split(" ")[0]}`
    : `${c.getFullYear()}年 ${fmtDate(c)}`;
  $("#cal-prev").disabled = viewRange(state.mode, stepCursor(-1)).end <= windowMin();
  $("#cal-next").disabled = viewRange(state.mode, stepCursor(1)).start > windowMax();
  $("#cal-hint").textContent = isAdmin()
    ? (state.mode === "month" ? "点击某一天进入日视图，在时间格上点击或拖动即可发布日程。" : "点击或拖动 30 分钟时间格来发布日程。")
    : "";
  await loadEvents(start, end);
  if (seq !== renderSeq) return;
  if (state.mode === "month") renderMonth(start); else renderTimeGrid(start, state.mode === "week" ? 7 : 1);
}

function eventsOnDay(day) {
  const ds = startOfDay(day), de = addDays(ds, 1);
  return state.events.filter((ev) => ev.s < de && ev.e > ds);
}

function renderMonth(start) {
  const today = new Date();
  const month = state.cursor.getMonth();
  let html = `<div class="month"><div class="month-head">${WEEKDAYS.map((w) => `<div>${w}</div>`).join("")}</div><div class="month-grid">`;
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    const evs = eventsOnDay(d);
    const out = addDays(d, 1) <= windowMin() || d > windowMax();
    const cls = ["month-cell", d.getMonth() !== month && "other", sameDay(d, today) && "today", out && "out"].filter(Boolean).join(" ");
    const max = window.innerWidth < 640 ? 2 : 3;
    html += `<div class="${cls}" data-day="${ymd(d)}"><span class="num">${d.getDate()}</span>`;
    evs.slice(0, max).forEach((ev) => {
      html += `<div class="chip" data-ev="${ev.id}"><span class="t">${sameDay(ev.s, d) ? hm(ev.s) : "…"}</span>${esc(ev.title)}</div>`;
    });
    if (evs.length > max) html += `<div class="more">+${evs.length - max} 更多</div>`;
    html += `</div>`;
  }
  html += `</div></div>`;
  const body = $("#cal-body");
  body.innerHTML = html;
  body.onclick = (e) => {
    const chip = e.target.closest("[data-ev]");
    if (chip) { openEvent(Number(chip.dataset.ev)); return; }
    const cell = e.target.closest(".month-cell");
    if (!cell || cell.classList.contains("out")) return;
    const [y, m, dd] = cell.dataset.day.split("-").map(Number);
    state.cursor = new Date(y, m - 1, dd);
    state.mode = window.innerWidth < 640 ? "day" : "week";
    renderCalendar();
  };
}

function layoutDay(items) {
  items.sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  let cluster = [], clusterEnd = -1;
  const flush = () => {
    const cols = [];
    cluster.forEach((it) => {
      let i = cols.findIndex((end) => end <= it.top);
      if (i === -1) { i = cols.length; cols.push(0); }
      cols[i] = it.bottom; it.col = i;
    });
    cluster.forEach((it) => (it.ncol = cols.length));
    cluster = [];
  };
  items.forEach((it) => {
    if (cluster.length && it.top >= clusterEnd) flush();
    cluster.push(it); clusterEnd = Math.max(clusterEnd, it.bottom);
  });
  if (cluster.length) flush();
  return items;
}

function renderTimeGrid(start, ndays) {
  const days = Array.from({ length: ndays }, (_, i) => addDays(start, i));
  const today = new Date();
  const cols = `52px repeat(${ndays}, minmax(0, 1fr))`;
  const slotPx = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--slot")) || 24;
  let html = `<div class="tgrid ${isAdmin() ? "can-edit" : ""}">`;
  html += `<div class="tgrid-head" style="grid-template-columns:${cols}"><div></div>`;
  days.forEach((d) => {
    html += `<div class="${sameDay(d, today) ? "today" : ""}" data-goto="${ymd(d)}">周${WEEKDAYS[d.getDay()]}<b>${d.getDate()}</b></div>`;
  });
  html += `</div><div class="tgrid-scroll"><div class="tgrid-body" style="grid-template-columns:${cols}">`;
  html += `<div class="hours">${Array.from({ length: 24 }, (_, h) => `<div>${h === 0 ? "" : pad(h) + ":00"}</div>`).join("")}</div>`;
  days.forEach((d, di) => {
    const out = addDays(d, 1) <= windowMin() || d > windowMax();
    html += `<div class="daycol ${out ? "out" : ""}" data-col="${di}" data-day="${ymd(d)}">`;
    for (let s = 0; s < SLOTS; s++) html += `<div class="slot" data-slot="${s}"></div>`;
    const ds = startOfDay(d), de = addDays(ds, 1);
    const items = eventsOnDay(d).map((ev) => {
      const s = ev.s < ds ? ds : ev.s, e = ev.e > de ? de : ev.e;
      const top = ((s - ds) / 60000) / SLOT_MIN * slotPx;
      const bottom = Math.max(top + slotPx * 0.9, ((e - ds) / 60000) / SLOT_MIN * slotPx);
      return { ev, top, bottom };
    });
    layoutDay(items).forEach(({ ev, top, bottom, col, ncol }) => {
      const w = 100 / ncol;
      const counts = rsvpCounts(ev.id);
      html += `<div class="ev" data-ev="${ev.id}" style="top:${top}px;height:${bottom - top - 2}px;left:calc(${col * w}% + 1px);width:calc(${w}% - 3px)">
        <b>${esc(ev.title)}</b><span>${hm(ev.s)}–${hm(ev.e)}${ev.location ? " · " + esc(ev.location) : ""}</span>
        ${counts.going + counts.late ? `<br><span>✓ ${counts.going + counts.late}</span>` : ""}</div>`;
    });
    if (sameDay(d, today)) {
      const top = ((today - ds) / 60000) / SLOT_MIN * slotPx;
      html += `<div class="nowline" style="top:${top}px"></div>`;
    }
    html += `</div>`;
  });
  html += `</div></div></div>`;
  const body = $("#cal-body");
  body.innerHTML = html;
  const scroller = $(".tgrid-scroll", body);
  scroller.scrollTop = slotPx * 2 * 7.5; // start around 07:30
  body.onclick = (e) => {
    const evEl = e.target.closest("[data-ev]");
    if (evEl) { openEvent(Number(evEl.dataset.ev)); return; }
    const g = e.target.closest("[data-goto]");
    if (g && state.mode === "week") {
      const [y, m, dd] = g.dataset.goto.split("-").map(Number);
      state.cursor = new Date(y, m - 1, dd); state.mode = "day"; renderCalendar();
    }
  };
  if (isAdmin()) attachSlotSelection(body);
}

// Click a block (or drag across blocks with a mouse) to create an event.
function attachSlotSelection(body) {
  let drag = null;
  const slotAt = (x, y) => document.elementFromPoint(x, y)?.closest?.(".slot");
  const paint = () => {
    $$(".slot.sel", body).forEach((s) => s.classList.remove("sel"));
    if (!drag) return;
    const [a, b] = [Math.min(drag.from, drag.to), Math.max(drag.from, drag.to)];
    $$(".slot", drag.col).forEach((s, i) => s.classList.toggle("sel", i >= a && i <= b));
  };
  body.onpointerdown = (e) => {
    const slot = e.target.closest(".slot");
    if (!slot || e.button > 0) return;
    const col = slot.closest(".daycol");
    if (col.classList.contains("out")) return;
    drag = { col, from: Number(slot.dataset.slot), to: Number(slot.dataset.slot), mouse: e.pointerType === "mouse", moved: false, x: e.clientX, y: e.clientY };
    if (drag.mouse) { e.preventDefault(); paint(); }
  };
  body.onpointermove = (e) => {
    if (!drag) return;
    if (!drag.mouse) { if (Math.abs(e.clientY - drag.y) > 8 || Math.abs(e.clientX - drag.x) > 8) drag = null; return; }
    const s = slotAt(e.clientX, e.clientY);
    if (s && s.closest(".daycol") === drag.col) { drag.to = Number(s.dataset.slot); drag.moved = true; paint(); }
  };
  const finish = () => {
    if (!drag) return;
    const d = drag; drag = null;
    const [a, b] = [Math.min(d.from, d.to), Math.max(d.from, d.to)];
    const day = d.col.dataset.day;
    const [y, m, dd] = day.split("-").map(Number);
    const startDt = new Date(y, m - 1, dd, 0, a * SLOT_MIN);
    const endDt = new Date(y, m - 1, dd, 0, (b + 1) * SLOT_MIN + (d.moved || d.mouse ? 0 : SLOT_MIN));
    paint();
    if (!inWindow(startDt)) { toast("日程只能安排在过去 3 个月到未来 12 个月之间"); return; }
    openEventForm(null, startDt, endDt);
  };
  body.onpointerup = finish;
  body.onpointercancel = () => { drag = null; paint(); };
}

function rsvpCounts(eventId) {
  const c = { going: 0, late: 0, maybe: 0, not_going: 0 };
  (state.responses.get(eventId) ?? []).forEach((r) => c[r.status]++);
  return c;
}

// ---------------------------------------------------------------- event detail
function openEvent(id) {
  const ev = state.events.find((x) => x.id === id);
  if (!ev) return;
  const rs = state.responses.get(id) ?? [];
  const mine = rs.find((r) => r.user_id === state.me.id);
  const counts = rsvpCounts(id);
  const responded = new Set(rs.map((r) => r.user_id));
  const noReply = [...state.profiles.values()].filter((p) => !responded.has(p.id));
  const sameDate = sameDay(ev.s, ev.e) || (ev.e - startOfDay(ev.e) === 0 && ev.e - ev.s <= 86400000);
  const when = `${fmtDate(ev.s)} ${hm(ev.s)} – ${sameDate ? "" : fmtDate(ev.e) + " "}${hm(ev.e)}`;

  const groups = STATUS_ORDER.map((st) => {
    const list = rs.filter((r) => r.status === st)
      .sort((a, b) => nameOf(a.user_id).localeCompare(nameOf(b.user_id), "zh"));
    if (!list.length) return "";
    return `<div class="who-group"><h4><span class="dot" style="background:${STATUS[st].color}"></span>${STATUS[st].label}（${list.length}）</h4><ul>${
      list.map((r) => `<li>${esc(nameOf(r.user_id))}${st === "late" ? `（迟到约 ${r.late_minutes} 分钟）` : ""}</li>`).join("")}</ul></div>`;
  }).join("");

  openModal(`
    <div class="modal-head"><h2>${esc(ev.title)}</h2><button class="close-x" aria-label="关闭">×</button></div>
    <dl class="meta">
      <dt>时间</dt><dd>${when}</dd>
      ${ev.location ? `<dt>地点</dt><dd>${esc(ev.location)}</dd>` : ""}
      ${ev.dress_code ? `<dt>着装</dt><dd>${esc(ev.dress_code)}</dd>` : ""}
      ${ev.notes ? `<dt>备注</dt><dd>${esc(ev.notes)}</dd>` : ""}
      <dt>发布</dt><dd>${esc(nameOf(ev.created_by))}</dd>
    </dl>
    <div><div class="muted" style="margin-bottom:6px">我的回复</div>
      <div class="rsvp">${STATUS_ORDER.map((st) => `<button class="btn ${mine?.status === st ? "on" : ""}" data-s="${st}">${STATUS[st].label}</button>`).join("")}</div>
      <div class="late-row" id="late-row" ${mine?.status === "late" ? "" : "hidden"} style="margin-top:8px">
        <span class="muted">预计迟到</span><input type="number" id="late-min" min="1" max="1440" step="1" value="${mine?.late_minutes ?? ""}" placeholder="分钟" /><span class="muted">分钟</span>
        <button class="btn primary small" id="late-save">确认</button>
      </div>
      ${mine ? `<button class="btn small" id="rsvp-clear" style="margin-top:8px">撤回我的回复</button>` : ""}
    </div>
    <details class="who">
      <summary>出席 ${counts.going} · 迟到 ${counts.late} · 不确定 ${counts.maybe} · 无法参与 ${counts.not_going} · 未回复 ${noReply.length}</summary>
      ${groups || `<p class="muted">还没有人回复。</p>`}
      ${noReply.length ? `<div class="who-group"><h4><span class="dot" style="background:var(--line)"></span>未回复（${noReply.length}）</h4><ul>${noReply.map((p) => `<li>${esc(p.display_name)}</li>`).join("")}</ul></div>` : ""}
    </details>
    ${isAdmin() ? `<div class="actions"><button class="btn danger" id="ev-del">删除</button><button class="btn" id="ev-edit">编辑</button></div>` : ""}
  `);

  const body = $("#modal-body");
  $$(".rsvp button", body).forEach((b) => b.onclick = async () => {
    const st = b.dataset.s;
    if (st === "late") {
      $$(".rsvp button", body).forEach((x) => x.classList.toggle("on", x === b));
      $("#late-row").hidden = false; $("#late-min").focus(); return;
    }
    await saveRsvp(ev.id, st, null);
  });
  $("#late-save", body).onclick = async () => {
    const v = parseInt($("#late-min").value, 10);
    if (!(v >= 1 && v <= 1440)) { toast("请填写迟到分钟数（1–1440）"); return; }
    await saveRsvp(ev.id, "late", v);
  };
  $("#rsvp-clear", body)?.addEventListener("click", async () => {
    const { error } = await sb.from("responses").delete().eq("event_id", ev.id).eq("user_id", state.me.id);
    if (error) return toast(friendlyError(error));
    await reloadEventAndReopen(ev.id);
  });
  $("#ev-edit", body)?.addEventListener("click", () => openEventForm(ev));
  $("#ev-del", body)?.addEventListener("click", async () => {
    if (!confirm(`确定删除「${ev.title}」？所有回复也会被删除。`)) return;
    const { error } = await sb.from("events").delete().eq("id", ev.id);
    if (error) return toast(friendlyError(error));
    closeModal(); toast("已删除"); renderCalendar();
  });
}

async function saveRsvp(eventId, status, lateMinutes) {
  const { error } = await sb.from("responses").upsert(
    { event_id: eventId, user_id: state.me.id, status, late_minutes: lateMinutes },
    { onConflict: "event_id,user_id" });
  if (error) return toast(friendlyError(error));
  toast("已回复：" + STATUS[status].label + (lateMinutes ? `（${lateMinutes} 分钟）` : ""));
  await reloadEventAndReopen(eventId);
}

async function reloadEventAndReopen(eventId) {
  const { start, end } = viewRange();
  await loadEvents(start, end);
  if (state.mode === "month") renderMonth(start); else renderTimeGrid(start, state.mode === "week" ? 7 : 1);
  openEvent(eventId);
}

// ---------------------------------------------------------------- event form
function timeOptions(selected) {
  let o = "";
  for (let m = 0; m < 24 * 60; m += SLOT_MIN) {
    const v = `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
    o += `<option ${v === selected ? "selected" : ""}>${v}</option>`;
  }
  return o;
}
function openEventForm(ev, startDt, endDt) {
  const s = ev ? ev.s : startDt, e = ev ? ev.e : endDt;
  openModal(`
    <div class="modal-head"><h2>${ev ? "编辑日程" : "发布日程"}</h2><button class="close-x" aria-label="关闭">×</button></div>
    <form id="ev-form" class="form-grid" style="max-width:none;margin:0">
      <label>活动名称 Event name *<input name="title" required maxlength="120" value="${esc(ev?.title)}" /></label>
      <div class="row2">
        <label>开始日期<input type="date" name="sd" required value="${ymd(s)}" /></label>
        <label>开始时间<select name="st">${timeOptions(hm(s))}</select></label>
      </div>
      <div class="row2">
        <label>结束日期<input type="date" name="ed" required value="${ymd(e)}" /></label>
        <label>结束时间<select name="et">${timeOptions(hm(e))}</select></label>
      </div>
      <label>地点 Location<input name="location" maxlength="200" value="${esc(ev?.location)}" /></label>
      <label>着装要求 Dress code<input name="dress_code" maxlength="120" value="${esc(ev?.dress_code)}" /></label>
      <label>备注 Notes<textarea name="notes" rows="3" maxlength="4000">${esc(ev?.notes)}</textarea></label>
      <p class="error" id="ev-error"></p>
      <div class="actions"><button type="button" class="btn" id="ev-cancel">取消</button><button class="btn primary" type="submit">${ev ? "保存" : "发布"}</button></div>
    </form>`);
  $("#ev-cancel").onclick = () => (ev ? openEvent(ev.id) : closeModal());
  $("#ev-form").onsubmit = async (evt) => {
    evt.preventDefault();
    const f = evt.target;
    const start_at = fromInputs(f.sd.value, f.st.value);
    const end_at = fromInputs(f.ed.value, f.et.value);
    const err = $("#ev-error");
    if (end_at <= start_at) { err.textContent = "结束时间必须晚于开始时间"; return; }
    if (end_at - start_at > 7 * 86400000) { err.textContent = "单个日程不能超过 7 天"; return; }
    if (!inWindow(start_at)) { err.textContent = "日程只能安排在过去 3 个月到未来 12 个月之间"; return; }
    const row = {
      title: f.title.value.trim(), location: f.location.value.trim(), dress_code: f.dress_code.value.trim(),
      notes: f.notes.value.trim(), start_at: start_at.toISOString(), end_at: end_at.toISOString(),
    };
    const q = ev ? sb.from("events").update(row).eq("id", ev.id).select().single()
                 : sb.from("events").insert(row).select().single();
    const { data, error } = await q;
    if (error) { err.textContent = friendlyError(error); return; }
    toast(ev ? "已保存" : "已发布");
    state.cursor = startOfDay(start_at);
    await reloadEventAndReopen(data.id);
  };
}

// ================================================================= CHAT
let chatLoaded = false;
let lastMsgDay = null;
async function loadChat() {
  const { data, error } = await sb.from("messages").select("*").order("created_at", { ascending: false }).limit(300);
  if (error) return toast(friendlyError(error));
  const list = $("#chat-list");
  list.innerHTML = ""; lastMsgDay = null;
  data.reverse().forEach((m) => list.appendChild(msgEl(m)));
  list.scrollTop = list.scrollHeight;
  chatLoaded = true;
}
function msgEl(m) {
  const frag = document.createDocumentFragment();
  const d = new Date(m.created_at);
  if (!lastMsgDay || !sameDay(lastMsgDay, d)) {
    const sep = document.createElement("div"); sep.className = "day-sep";
    sep.textContent = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    frag.appendChild(sep); lastMsgDay = d;
  }
  const mine = m.user_id === state.me.id;
  const el = document.createElement("div");
  el.className = "msg" + (mine ? " mine" : ""); el.dataset.id = m.id;
  el.innerHTML = `<div class="who">${esc(nameOf(m.user_id))} · ${hm(d)}${
    mine || isAdmin() ? ` <button class="del" title="删除">删除</button>` : ""}</div><div class="bubble">${esc(m.body)}</div>`;
  $(".del", el)?.addEventListener("click", async () => {
    if (!confirm("删除这条消息？")) return;
    const { error } = await sb.from("messages").delete().eq("id", m.id);
    if (error) toast(friendlyError(error)); else el.remove();
  });
  frag.appendChild(el);
  return frag;
}
async function onNewMessage(m) {
  if (!chatLoaded) return;
  if (document.querySelector(`.msg[data-id="${m.id}"]`)) return;
  if (!state.profiles.has(m.user_id)) await loadProfiles();
  const list = $("#chat-list");
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  list.appendChild(msgEl(m));
  if (atBottom || m.user_id === state.me.id) list.scrollTop = list.scrollHeight;
}
const chatForm = $("#chat-form");
chatForm.body.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); chatForm.requestSubmit(); }
});
chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = chatForm.body.value.trim(); if (!body) return;
  chatForm.body.value = "";
  const { data, error } = await sb.from("messages").insert({ body }).select().single();
  if (error) { chatForm.body.value = body; return toast(friendlyError(error)); }
  onNewMessage(data);
});

// ================================================================= TASKS
const TASK_STATUS = { todo: "待办", doing: "进行中", done: "已完成" };
let tasksCache = [];
async function loadTasks() {
  const { data, error } = await sb.from("assignments").select("*").order("due_at", { ascending: true, nullsFirst: false });
  if (error) return toast(friendlyError(error));
  tasksCache = data;
  const now = new Date();
  const html = Object.entries(TASK_STATUS).map(([st, label]) => {
    const items = data.filter((t) => t.status === st);
    return `<div class="task-group"><h3>${label}（${items.length}）</h3>${items.map((t) => {
      const due = t.due_at ? new Date(t.due_at) : null;
      const overdue = due && due < now && st !== "done";
      return `<div class="card task" ${isAdmin() ? `data-task="${t.id}" style="cursor:pointer"` : ""}>
        <div class="task-top"><b>${esc(t.title)}</b>${due ? `<span class="badge ${overdue ? "overdue" : ""}">截止 ${fmtDateTime(due)}</span>` : ""}</div>
        <div class="muted">负责人：${t.assignee ? esc(nameOf(t.assignee)) : "全体"} · 发布：${esc(nameOf(t.created_by))}</div>
        ${t.details ? `<div class="task-details">${esc(t.details)}</div>` : ""}</div>`;
    }).join("") || `<p class="muted">无</p>`}</div>`;
  }).join("");
  const list = $("#task-list");
  list.innerHTML = html;
  list.onclick = (e) => { const c = e.target.closest("[data-task]"); if (c) openTaskForm(tasksCache.find((t) => t.id === Number(c.dataset.task))); };
}
$("#task-new").addEventListener("click", () => openTaskForm(null));
function openTaskForm(t) {
  const due = t?.due_at ? new Date(t.due_at) : null;
  const people = [...state.profiles.values()];
  openModal(`
    <div class="modal-head"><h2>${t ? "编辑任务" : "新任务"}</h2><button class="close-x" aria-label="关闭">×</button></div>
    <form id="task-form" class="form-grid" style="max-width:none;margin:0">
      <label>标题 *<input name="title" required maxlength="160" value="${esc(t?.title)}" /></label>
      <label>内容<textarea name="details" rows="4" maxlength="4000">${esc(t?.details)}</textarea></label>
      <label>负责人<select name="assignee"><option value="">全体</option>${people.map((p) =>
        `<option value="${p.id}" ${t?.assignee === p.id ? "selected" : ""}>${esc(p.display_name)}</option>`).join("")}</select></label>
      <div class="row2">
        <label>截止日期<input type="date" name="dd" value="${due ? ymd(due) : ""}" /></label>
        <label>截止时间<select name="dt">${timeOptions(due ? hm(due) : "23:30")}</select></label>
      </div>
      <label>状态<select name="status">${Object.entries(TASK_STATUS).map(([k, v]) => `<option value="${k}" ${t?.status === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
      <p class="error" id="task-error"></p>
      <div class="actions">${t ? `<button type="button" class="btn danger" id="task-del">删除</button>` : ""}<button class="btn primary" type="submit">保存</button></div>
    </form>`);
  $("#task-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    const row = {
      title: f.title.value.trim(), details: f.details.value.trim(), assignee: f.assignee.value || null,
      due_at: f.dd.value ? fromInputs(f.dd.value, f.dt.value).toISOString() : null, status: f.status.value,
    };
    const { error } = t ? await sb.from("assignments").update(row).eq("id", t.id) : await sb.from("assignments").insert(row);
    if (error) { $("#task-error").textContent = friendlyError(error); return; }
    closeModal(); toast("已保存"); loadTasks();
  };
  $("#task-del")?.addEventListener("click", async () => {
    if (!confirm("删除这个任务？")) return;
    const { error } = await sb.from("assignments").delete().eq("id", t.id);
    if (error) return toast(friendlyError(error));
    closeModal(); loadTasks();
  });
}

// ================================================================= MEMBERS (admin)
async function callAdmin(payload) {
  const { data, error } = await sb.functions.invoke("admin-users", { body: payload });
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error ?? msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return data;
}
async function loadMembers() {
  await loadProfiles();
  const rows = [...state.profiles.values()].sort((a, b) =>
    ({ owner: 0, admin: 1, member: 2 }[a.role] - { owner: 0, admin: 1, member: 2 }[b.role]) || a.username.localeCompare(b.username));
  $("#member-list").innerHTML = `<div class="table-wrap"><table class="table"><thead><tr><th>显示名称</th><th>用户名</th><th>角色</th><th></th></tr></thead><tbody>${
    rows.map((p) => {
      const canReset = isOwner() || p.role === "member" || p.id === state.me.id;
      const btns = [
        canReset ? `<button class="btn small" data-act="reset" data-id="${p.id}">重置密码</button>` : "",
        isOwner() && p.role !== "owner" ? `<button class="btn small" data-act="role" data-id="${p.id}">${p.role === "admin" ? "取消管理员" : "设为管理员"}</button>` : "",
        isOwner() && p.role !== "owner" ? `<button class="btn small danger" data-act="del" data-id="${p.id}">删除</button>` : "",
      ].join(" ");
      return `<tr><td>${esc(p.display_name)}</td><td>${esc(p.username)}</td><td><span class="role ${p.role}">${ROLE_LABEL[p.role]}</span></td><td style="white-space:nowrap">${btns}</td></tr>`;
    }).join("")}</tbody></table></div>`;
}
$("#member-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target; const err = $("#member-error"); err.textContent = "";
  try {
    await callAdmin({ action: "create", username: f.username.value.trim().toLowerCase(), password: f.password.value, role: f.role.value });
    toast(`已创建账号 ${f.username.value.trim().toLowerCase()}`); f.reset(); loadMembers();
  } catch (ex) { err.textContent = ex.message; }
});
$("#member-list").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const p = state.profiles.get(b.dataset.id);
  try {
    if (b.dataset.act === "reset") {
      const pw = prompt(`为 ${p.display_name}（${p.username}）设置新密码（至少 8 位）：`);
      if (!pw) return;
      await callAdmin({ action: "reset_password", user_id: p.id, password: pw }); toast("密码已重置");
    } else if (b.dataset.act === "role") {
      await callAdmin({ action: "set_role", user_id: p.id, role: p.role === "admin" ? "member" : "admin" }); toast("角色已更新");
    } else if (b.dataset.act === "del") {
      if (!confirm(`确定删除账号 ${p.username}？其回复和留言也会被删除。`)) return;
      await callAdmin({ action: "delete", user_id: p.id }); toast("账号已删除");
    }
    loadMembers();
  } catch (ex) { toast(ex.message, 4000); }
});

// ================================================================= AUDIT (admin)
const TABLE_LABEL = { events: "日程", responses: "回复", messages: "留言", assignments: "任务", profiles: "资料", accounts: "账号" };
const ACTION_LABEL = { INSERT: "新增", UPDATE: "修改", DELETE: "删除", LOGIN: "登录",
  ADMIN_CREATE_USER: "创建账号", ADMIN_RESET_PASSWORD: "重置密码", ADMIN_SET_ROLE: "修改角色", ADMIN_DELETE_USER: "删除账号" };
function describe(a) {
  const d = a.new_data ?? a.old_data ?? {};
  switch (a.table_name) {
    case "events": {
      let s = `「${d.title}」 ${d.start_at ? fmtDateTime(new Date(d.start_at)) : ""}`;
      if (a.action === "UPDATE" && a.old_data) {
        const ch = ["title", "location", "dress_code", "notes", "start_at", "end_at"].filter((k) => a.old_data[k] !== a.new_data[k]);
        if (ch.length) s += `（改动：${ch.join(", ")}）`;
      }
      return s;
    }
    case "responses": return `日程 #${d.event_id}：${STATUS[d.status]?.label ?? ""}${d.late_minutes ? ` ${d.late_minutes} 分钟` : ""}`;
    case "messages": return `「${String(d.body ?? "").slice(0, 60)}」`;
    case "assignments": return `「${d.title}」 ${TASK_STATUS[d.status] ?? ""}`;
    case "profiles": return a.old_data && a.new_data ? `显示名称：${a.old_data.display_name} → ${a.new_data.display_name}` : "";
    case "accounts": return [d.username, d.role, d.from && `${ROLE_LABEL[d.from]} → ${ROLE_LABEL[d.to]}`].filter(Boolean).join(" ");
    default: return "";
  }
}
async function loadAudit() {
  await loadProfiles();
  const sel = $("#audit-filter");
  const cur = sel.value;
  sel.innerHTML = `<option value="">全部成员</option>` + [...state.profiles.values()].map((p) =>
    `<option value="${p.id}" ${p.id === cur ? "selected" : ""}>${esc(p.display_name)}</option>`).join("");
  let q = sb.from("audit_log").select("*").order("at", { ascending: false }).limit(500);
  if (cur) q = q.eq("actor", cur);
  const { data, error } = await q;
  if (error) return toast(friendlyError(error));
  $("#audit-list").innerHTML = `<div class="table-wrap"><table class="table"><thead><tr><th>时间</th><th>成员</th><th>操作</th><th>内容</th></tr></thead><tbody>${
    data.map((a) => `<tr><td style="white-space:nowrap">${fmtDateTime(new Date(a.at))}</td><td>${esc(a.actor_name ?? "")}</td>
      <td style="white-space:nowrap">${ACTION_LABEL[a.action] ?? a.action}${a.table_name ? " " + (TABLE_LABEL[a.table_name] ?? a.table_name) : ""}</td>
      <td>${esc(describe(a))}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">暂无记录</td></tr>`}</tbody></table></div>`;
}
$("#audit-filter").addEventListener("change", loadAudit);

// ================================================================= ME
function renderMe() {
  $("#me-username").textContent = state.me.username;
  $("#me-role").textContent = ROLE_LABEL[state.me.role];
  $("#profile-form").display_name.value = state.me.display_name;
  $("#profile-msg").textContent = ""; $("#password-msg").textContent = "";
}
$("#profile-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = e.target.display_name.value.trim();
  const { error } = await sb.from("profiles").update({ display_name: name }).eq("id", state.me.id);
  if (error) { $("#profile-msg").textContent = friendlyError(error); return; }
  await loadProfiles(); $("#profile-msg").textContent = "已保存";
});
$("#password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { error } = await sb.auth.updateUser({ password: e.target.password.value });
  $("#password-msg").textContent = error ? friendlyError(error) : "密码已修改";
  if (!error) e.target.reset();
});

// ================================================================= start
if (SUPABASE_URL.includes("YOUR-PROJECT")) {
  document.body.innerHTML = `<div class="login"><div class="card login-card"><h1>还差一步</h1><p>请先在 <code>config.js</code> 里填入 Supabase 的 URL 和 key。</p></div></div>`;
} else {
  sb.auth.onAuthStateChange((event) => { if (event === "SIGNED_OUT") location.reload(); });
  boot();
}
