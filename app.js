import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_KEY, SITE_TITLE, EMAIL_DOMAIN } from "./config.js";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------------------------------------------------------------- constants
const STATUS = {
  going:     { label: "Going", color: "var(--going)" },
  late:      { label: "Late",   color: "var(--late)" },
  maybe:     { label: "Maybe",   color: "var(--maybe)" },
  not_going: { label: "Can't go", color: "var(--no)" },
};
const STATUS_ORDER = ["going", "late", "maybe", "not_going"];
const ROLE_LABEL = { owner: "Owner", admin: "Admin", member: "Member" };
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
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
const nameOf = (id) => state.profiles.get(id)?.display_name ?? "(deleted user)";

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
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const fmtDate = (d) => `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
const fmtShort = (d) => `${MONTHS[d.getMonth()]} ${d.getDate()}`;
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
  if (/row-level security|permission denied/i.test(m)) return "You don't have permission to do that";
  if (/past 3 months|next 12 months/i.test(m)) return "Events must be within the past 3 months and the next 12 months";
  if (/Invalid login credentials/i.test(m)) return "Incorrect username or password";
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
  if (!state.me) { toast("Account profile not found — please contact an admin"); await sb.auth.signOut(); return; }
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
    state.mode === "month" ? `${MONTHS_LONG[c.getMonth()]} ${c.getFullYear()}`
    : state.mode === "week" ? `${fmtShort(start)} – ${fmtShort(addDays(end, -1))}, ${addDays(end, -1).getFullYear()}`
    : `${fmtDate(c)}, ${c.getFullYear()}`;
  $("#cal-prev").disabled = viewRange(state.mode, stepCursor(-1)).end <= windowMin();
  $("#cal-next").disabled = viewRange(state.mode, stepCursor(1)).start > windowMax();
  $("#cal-hint").textContent = isAdmin()
    ? (state.mode === "month" ? "Click a day to open it, then click or drag the time blocks to post an event." : "Click or drag the 30-minute blocks to post an event.")
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
    if (evs.length > max) html += `<div class="more">+${evs.length - max} more</div>`;
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
    html += `<div class="${sameDay(d, today) ? "today" : ""}" data-goto="${ymd(d)}">${WEEKDAYS[d.getDay()]}<b>${d.getDate()}</b></div>`;
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
    if (!inWindow(startDt)) { toast("Events must be within the past 3 months and the next 12 months"); return; }
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
    return `<div class="who-group"><h4><span class="dot" style="background:${STATUS[st].color}"></span>${STATUS[st].label} (${list.length})</h4><ul>${
      list.map((r) => `<li>${esc(nameOf(r.user_id))}${st === "late" ? ` (about ${r.late_minutes} min late)` : ""}</li>`).join("")}</ul></div>`;
  }).join("");

  openModal(`
    <div class="modal-head"><h2>${esc(ev.title)}</h2><button class="close-x" aria-label="Close">×</button></div>
    <dl class="meta">
      <dt>When</dt><dd>${when}</dd>
      ${ev.location ? `<dt>Location</dt><dd>${esc(ev.location)}</dd>` : ""}
      ${ev.dress_code ? `<dt>Dress code</dt><dd>${esc(ev.dress_code)}</dd>` : ""}
      ${ev.notes ? `<dt>Notes</dt><dd>${esc(ev.notes)}</dd>` : ""}
      <dt>Posted by</dt><dd>${esc(nameOf(ev.created_by))}</dd>
    </dl>
    <div><div class="muted" style="margin-bottom:6px">My response</div>
      <div class="rsvp">${STATUS_ORDER.map((st) => `<button class="btn ${mine?.status === st ? "on" : ""}" data-s="${st}">${STATUS[st].label}</button>`).join("")}</div>
      <div class="late-row" id="late-row" ${mine?.status === "late" ? "" : "hidden"} style="margin-top:8px">
        <span class="muted">Late by</span><input type="number" id="late-min" min="1" max="1440" step="1" value="${mine?.late_minutes ?? ""}" placeholder="min" /><span class="muted">minutes</span>
        <button class="btn primary small" id="late-save">Confirm</button>
      </div>
      ${mine ? `<button class="btn small" id="rsvp-clear" style="margin-top:8px">Withdraw my response</button>` : ""}
    </div>
    <details class="who">
      <summary>Going ${counts.going} · Late ${counts.late} · Maybe ${counts.maybe} · Can't go ${counts.not_going} · No reply ${noReply.length}</summary>
      ${groups || `<p class="muted">No responses yet.</p>`}
      ${noReply.length ? `<div class="who-group"><h4><span class="dot" style="background:var(--line)"></span>No reply (${noReply.length})</h4><ul>${noReply.map((p) => `<li>${esc(p.display_name)}</li>`).join("")}</ul></div>` : ""}
    </details>
    ${isAdmin() ? `<div class="actions"><button class="btn danger" id="ev-del">Delete</button><button class="btn" id="ev-edit">Edit</button></div>` : ""}
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
    if (!(v >= 1 && v <= 1440)) { toast("Please enter how many minutes late (1–1440)"); return; }
    await saveRsvp(ev.id, "late", v);
  };
  $("#rsvp-clear", body)?.addEventListener("click", async () => {
    const { error } = await sb.from("responses").delete().eq("event_id", ev.id).eq("user_id", state.me.id);
    if (error) return toast(friendlyError(error));
    await reloadEventAndReopen(ev.id);
  });
  $("#ev-edit", body)?.addEventListener("click", () => openEventForm(ev));
  $("#ev-del", body)?.addEventListener("click", async () => {
    if (!confirm(`Delete "${ev.title}"? All responses will be deleted too.`)) return;
    const { error } = await sb.from("events").delete().eq("id", ev.id);
    if (error) return toast(friendlyError(error));
    closeModal(); toast("Deleted"); renderCalendar();
  });
}

async function saveRsvp(eventId, status, lateMinutes) {
  const { error } = await sb.from("responses").upsert(
    { event_id: eventId, user_id: state.me.id, status, late_minutes: lateMinutes },
    { onConflict: "event_id,user_id" });
  if (error) return toast(friendlyError(error));
  toast("Response saved: " + STATUS[status].label + (lateMinutes ? ` (${lateMinutes} min)` : ""));
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
    <div class="modal-head"><h2>${ev ? "Edit event" : "Post event"}</h2><button class="close-x" aria-label="Close">×</button></div>
    <form id="ev-form" class="form-grid" style="max-width:none;margin:0">
      <label>Event name *<input name="title" required maxlength="120" value="${esc(ev?.title)}" /></label>
      <div class="row2">
        <label>Start date<input type="date" name="sd" required value="${ymd(s)}" /></label>
        <label>Start time<select name="st">${timeOptions(hm(s))}</select></label>
      </div>
      <div class="row2">
        <label>End date<input type="date" name="ed" required value="${ymd(e)}" /></label>
        <label>End time<select name="et">${timeOptions(hm(e))}</select></label>
      </div>
      <label>Location<input name="location" maxlength="200" value="${esc(ev?.location)}" /></label>
      <label>Dress code<input name="dress_code" maxlength="120" value="${esc(ev?.dress_code)}" /></label>
      <label>Notes<textarea name="notes" rows="3" maxlength="4000">${esc(ev?.notes)}</textarea></label>
      <p class="error" id="ev-error"></p>
      <div class="actions"><button type="button" class="btn" id="ev-cancel">Cancel</button><button class="btn primary" type="submit">${ev ? "Save" : "Post"}</button></div>
    </form>`);
  $("#ev-cancel").onclick = () => (ev ? openEvent(ev.id) : closeModal());
  $("#ev-form").onsubmit = async (evt) => {
    evt.preventDefault();
    const f = evt.target;
    const start_at = fromInputs(f.sd.value, f.st.value);
    const end_at = fromInputs(f.ed.value, f.et.value);
    const err = $("#ev-error");
    if (end_at <= start_at) { err.textContent = "End time must be after start time"; return; }
    if (end_at - start_at > 7 * 86400000) { err.textContent = "An event can't be longer than 7 days"; return; }
    if (!inWindow(start_at)) { err.textContent = "Events must be within the past 3 months and the next 12 months"; return; }
    const row = {
      title: f.title.value.trim(), location: f.location.value.trim(), dress_code: f.dress_code.value.trim(),
      notes: f.notes.value.trim(), start_at: start_at.toISOString(), end_at: end_at.toISOString(),
    };
    const q = ev ? sb.from("events").update(row).eq("id", ev.id).select().single()
                 : sb.from("events").insert(row).select().single();
    const { data, error } = await q;
    if (error) { err.textContent = friendlyError(error); return; }
    toast(ev ? "Saved" : "Posted");
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
    mine || isAdmin() ? ` <button class="del" title="Delete">Delete</button>` : ""}</div><div class="bubble">${esc(m.body)}</div>`;
  $(".del", el)?.addEventListener("click", async () => {
    if (!confirm("Delete this message?")) return;
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
const TASK_STATUS = { todo: "To do", doing: "In progress", done: "Done" };
let tasksCache = [];
async function loadTasks() {
  const { data, error } = await sb.from("assignments").select("*").order("due_at", { ascending: true, nullsFirst: false });
  if (error) return toast(friendlyError(error));
  tasksCache = data;
  const now = new Date();
  const html = Object.entries(TASK_STATUS).map(([st, label]) => {
    const items = data.filter((t) => t.status === st);
    return `<div class="task-group"><h3>${label} (${items.length})</h3>${items.map((t) => {
      const due = t.due_at ? new Date(t.due_at) : null;
      const overdue = due && due < now && st !== "done";
      return `<div class="card task" ${isAdmin() ? `data-task="${t.id}" style="cursor:pointer"` : ""}>
        <div class="task-top"><b>${esc(t.title)}</b>${due ? `<span class="badge ${overdue ? "overdue" : ""}">Due ${fmtDateTime(due)}</span>` : ""}</div>
        <div class="muted">Assigned to: ${t.assignee ? esc(nameOf(t.assignee)) : "Everyone"} · Posted by: ${esc(nameOf(t.created_by))}</div>
        ${t.details ? `<div class="task-details">${esc(t.details)}</div>` : ""}</div>`;
    }).join("") || `<p class="muted">None</p>`}</div>`;
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
    <div class="modal-head"><h2>${t ? "Edit task" : "New task"}</h2><button class="close-x" aria-label="Close">×</button></div>
    <form id="task-form" class="form-grid" style="max-width:none;margin:0">
      <label>Title *<input name="title" required maxlength="160" value="${esc(t?.title)}" /></label>
      <label>Details<textarea name="details" rows="4" maxlength="4000">${esc(t?.details)}</textarea></label>
      <label>Assigned to<select name="assignee"><option value="">Everyone</option>${people.map((p) =>
        `<option value="${p.id}" ${t?.assignee === p.id ? "selected" : ""}>${esc(p.display_name)}</option>`).join("")}</select></label>
      <div class="row2">
        <label>Due date<input type="date" name="dd" value="${due ? ymd(due) : ""}" /></label>
        <label>Due time<select name="dt">${timeOptions(due ? hm(due) : "23:30")}</select></label>
      </div>
      <label>Status<select name="status">${Object.entries(TASK_STATUS).map(([k, v]) => `<option value="${k}" ${t?.status === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
      <p class="error" id="task-error"></p>
      <div class="actions">${t ? `<button type="button" class="btn danger" id="task-del">Delete</button>` : ""}<button class="btn primary" type="submit">Save</button></div>
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
    closeModal(); toast("Saved"); loadTasks();
  };
  $("#task-del")?.addEventListener("click", async () => {
    if (!confirm("Delete this task?")) return;
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
  $("#member-list").innerHTML = `<div class="table-wrap"><table class="table"><thead><tr><th>Display name</th><th>Username</th><th>Role</th><th></th></tr></thead><tbody>${
    rows.map((p) => {
      const canReset = isOwner() || p.role === "member" || p.id === state.me.id;
      const btns = [
        canReset ? `<button class="btn small" data-act="reset" data-id="${p.id}">Reset password</button>` : "",
        isOwner() && p.role !== "owner" ? `<button class="btn small" data-act="role" data-id="${p.id}">${p.role === "admin" ? "Remove admin" : "Make admin"}</button>` : "",
        isOwner() && p.role !== "owner" ? `<button class="btn small danger" data-act="del" data-id="${p.id}">Delete</button>` : "",
      ].join(" ");
      return `<tr><td>${esc(p.display_name)}</td><td>${esc(p.username)}</td><td><span class="role ${p.role}">${ROLE_LABEL[p.role]}</span></td><td style="white-space:nowrap">${btns}</td></tr>`;
    }).join("")}</tbody></table></div>`;
}
$("#member-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target; const err = $("#member-error"); err.textContent = "";
  try {
    await callAdmin({ action: "create", username: f.username.value.trim().toLowerCase(), password: f.password.value, role: f.role.value });
    toast(`Account created: ${f.username.value.trim().toLowerCase()}`); f.reset(); loadMembers();
  } catch (ex) { err.textContent = ex.message; }
});
$("#member-list").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const p = state.profiles.get(b.dataset.id);
  try {
    if (b.dataset.act === "reset") {
      const pw = prompt(`New password for ${p.display_name} (${p.username}), at least 8 characters:`);
      if (!pw) return;
      await callAdmin({ action: "reset_password", user_id: p.id, password: pw }); toast("Password reset");
    } else if (b.dataset.act === "role") {
      await callAdmin({ action: "set_role", user_id: p.id, role: p.role === "admin" ? "member" : "admin" }); toast("Role updated");
    } else if (b.dataset.act === "del") {
      if (!confirm(`Delete account ${p.username}? Their responses and messages will be deleted too.`)) return;
      await callAdmin({ action: "delete", user_id: p.id }); toast("Account deleted");
    }
    loadMembers();
  } catch (ex) { toast(ex.message, 4000); }
});

// ================================================================= AUDIT (admin)
const TABLE_LABEL = { events: "event", responses: "response", messages: "message", assignments: "task", profiles: "profile", accounts: "account" };
const ACTION_LABEL = { INSERT: "Created", UPDATE: "Updated", DELETE: "Deleted", LOGIN: "Signed in",
  ADMIN_CREATE_USER: "Created account", ADMIN_RESET_PASSWORD: "Reset password", ADMIN_SET_ROLE: "Changed role", ADMIN_DELETE_USER: "Deleted account" };
function describe(a) {
  const d = a.new_data ?? a.old_data ?? {};
  switch (a.table_name) {
    case "events": {
      let s = `"${d.title}" ${d.start_at ? fmtDateTime(new Date(d.start_at)) : ""}`;
      if (a.action === "UPDATE" && a.old_data) {
        const ch = ["title", "location", "dress_code", "notes", "start_at", "end_at"].filter((k) => a.old_data[k] !== a.new_data[k]);
        if (ch.length) s += ` (changed: ${ch.join(", ")})`;
      }
      return s;
    }
    case "responses": return `event #${d.event_id}: ${STATUS[d.status]?.label ?? ""}${d.late_minutes ? ` ${d.late_minutes} min` : ""}`;
    case "messages": return `"${String(d.body ?? "").slice(0, 60)}"`;
    case "assignments": return `"${d.title}" ${TASK_STATUS[d.status] ?? ""}`;
    case "profiles": return a.old_data && a.new_data ? `display name: ${a.old_data.display_name} → ${a.new_data.display_name}` : "";
    case "accounts": return [d.username, d.role, d.from && `${ROLE_LABEL[d.from]} → ${ROLE_LABEL[d.to]}`].filter(Boolean).join(" ");
    default: return "";
  }
}
async function loadAudit() {
  await loadProfiles();
  const sel = $("#audit-filter");
  const cur = sel.value;
  sel.innerHTML = `<option value="">All members</option>` + [...state.profiles.values()].map((p) =>
    `<option value="${p.id}" ${p.id === cur ? "selected" : ""}>${esc(p.display_name)}</option>`).join("");
  let q = sb.from("audit_log").select("*").order("at", { ascending: false }).limit(500);
  if (cur) q = q.eq("actor", cur);
  const { data, error } = await q;
  if (error) return toast(friendlyError(error));
  $("#audit-list").innerHTML = `<div class="table-wrap"><table class="table"><thead><tr><th>Time</th><th>Member</th><th>Action</th><th>Details</th></tr></thead><tbody>${
    data.map((a) => `<tr><td style="white-space:nowrap">${fmtDateTime(new Date(a.at))}</td><td>${esc(a.actor_name ?? "")}</td>
      <td style="white-space:nowrap">${ACTION_LABEL[a.action] ?? a.action}${a.table_name ? " " + (TABLE_LABEL[a.table_name] ?? a.table_name) : ""}</td>
      <td>${esc(describe(a))}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">No activity yet</td></tr>`}</tbody></table></div>`;
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
  await loadProfiles(); $("#profile-msg").textContent = "Saved";
});
$("#password-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { error } = await sb.auth.updateUser({ password: e.target.password.value });
  $("#password-msg").textContent = error ? friendlyError(error) : "Password changed";
  if (!error) e.target.reset();
});

// ================================================================= start
if (SUPABASE_URL.includes("YOUR-PROJECT")) {
  document.body.innerHTML = `<div class="login"><div class="card login-card"><h1>One more step</h1><p>Fill in the Supabase URL and key in <code>config.js</code>.</p></div></div>`;
} else {
  sb.auth.onAuthStateChange((event) => { if (event === "SIGNED_OUT") location.reload(); });
  boot();
}
