// ============================================================
//  EVENT RSVP — server logic (Neon Postgres)
//  Island Hills Land Corporation — Christmas Party & Annual Awards Night 2026
//  "A Night in Paris" · Midnight Blue, Silver & Ice
//
//  A port of the Apps Script Code.gs — same function names and return
//  shapes, so index.html and admin.html work unchanged apart from the
//  google.script.run → /api/rpc swap.
//  • Main guest + up to 19 companions (Name2..Name20), Open or Fixed mode
//  • Per-guest "Joyfully Accepts" / "Regretfully Declines"
//  • Fuzzy guest search with "Did you mean…?" suggestions
//  • Optional message to the organizers
//  • Admin: dashboard, guest list, import/export, responses, RSVP on/off,
//    password change
// ============================================================
import { q, ensureSchema } from './db.js';
import { fuzzyFind } from './fuzzy.js';
import { checkPassword, issueToken, setPassword, isDefaultPassword } from './auth.js';

export const MAX_GUESTS = 20;
const ACCEPT = 'Joyfully Accepts';
const DECLINE = 'Regretfully Declines';
const TZ = 'Asia/Manila';

const clampCompanions = (n) => Math.min(Math.max(Math.floor(Number(n) || 0), 0), MAX_GUESTS - 1);
const cleanMode = (m) => (m === 'Fixed' ? 'Fixed' : 'Open');
const iso = (d) => (d ? new Date(d).toISOString() : '');

function newId() {
  return 'G' + Date.now() + Math.floor(Math.random() * 1000);
}

function companionsArr(row) {
  const c = row.companions;
  const arr = Array.isArray(c) ? c : (typeof c === 'string' ? JSON.parse(c || '[]') : []);
  const out = [];
  for (let i = 0; i < MAX_GUESTS - 1; i++) {
    const x = arr[i] || {};
    out.push({ name: String(x.name || ''), status: String(x.status || '') });
  }
  return out;
}

// Same shape as rowToGuestObj_ in Code.gs
function toGuestObj(row) {
  const comps = companionsArr(row);
  const obj = { id: row.id, name1: row.name1 || '', status1: row.status1 || '' };
  for (let g = 2; g <= MAX_GUESTS; g++) {
    obj['name' + g] = comps[g - 2].name;
    obj['status' + g] = comps[g - 2].status;
  }
  obj.companionCount = Number(row.companion_count || 0);
  obj.mode = row.mode || 'Open';
  obj.totalAttending = Number(row.total_attending || 0);
  obj.submitted = !!row.submitted;
  obj.submittedAt = iso(row.submitted_at);
  obj.allergies = row.allergies || '';
  obj.message = row.message || '';
  return obj;
}

function companionsFromInput(guest) {
  const list = Array.isArray(guest.companions) ? guest.companions : [];
  const out = [];
  for (let i = 0; i < MAX_GUESTS - 1; i++) out.push({ name: String(list[i] || '').trim().slice(0, 120), status: '' });
  return out;
}

async function allGuests() {
  await ensureSchema();
  return q(`SELECT * FROM guests ORDER BY created_at, id`);
}

function cmp(av, bv, dir) {
  if (av === undefined || av === null) av = '';
  if (bv === undefined || bv === null) bv = '';
  let r;
  if (typeof av === 'number' && typeof bv === 'number') r = av - bv;
  else if (typeof av === 'boolean' || typeof bv === 'boolean') r = Number(av) - Number(bv);
  else r = String(av).localeCompare(String(bv), undefined, { sensitivity: 'base', numeric: true });
  return dir === 'asc' ? r : -r;
}

function paginate(rows, opts) {
  const page = Math.max(Number(opts.page || 1), 1);
  const pageSize = Math.max(Number(opts.pageSize || 10), 1);
  const start = (page - 1) * pageSize;
  return { rows: rows.slice(start, start + pageSize), total: rows.length, page, pageSize };
}

// ============================================================
//  SETTINGS — RSVP active toggle
// ============================================================
export async function getRsvpStatus() {
  await ensureSchema();
  const rows = await q(`SELECT value FROM settings WHERE key = 'rsvp_active'`);
  return { active: !rows.length || String(rows[0].value) !== 'false' };
}

export async function setRsvpStatus(active) {
  await ensureSchema();
  await q(
    `INSERT INTO settings (key, value) VALUES ('rsvp_active', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [active ? 'true' : 'false']
  );
  return { success: true, active: !!active };
}

// ============================================================
//  ADMIN PASSWORD
// ============================================================
export async function checkAdminPassword(password) {
  const ok = await checkPassword(String(password || ''));
  if (!ok) {
    await new Promise((r) => setTimeout(r, 500)); // slows down guessing
    return { success: false };
  }
  return { success: true, token: await issueToken() };
}

export async function isAdminPasswordDefault() {
  return { isDefault: await isDefaultPassword() };
}

export async function setAdminPassword(payload) {
  const current = String((payload && payload.currentPassword) || '');
  const next = String((payload && payload.newPassword) || '');
  if (!(await checkPassword(current))) return { success: false, message: 'Current password is incorrect.' };
  if (next.length < 4) return { success: false, message: 'New password must be at least 4 characters.' };
  await setPassword(next);
  // the old session is signed with the old password, so hand back a fresh one
  return { success: true, token: await issueToken() };
}

// ============================================================
//  GUEST-FACING RSVP
// ============================================================
export async function getGuestData(name) {
  if (!name || !String(name).trim()) return { found: false };
  const status = await getRsvpStatus();
  if (!status.active) return { found: false, rsvpClosed: true };

  const rows = await allGuests();
  const res = fuzzyFind(name, rows.map((r) => ({ id: r.id, name: r.name1 })));
  if (!res.match) return res.suggestions.length ? { found: false, suggestions: res.suggestions } : { found: false };

  const row = rows.find((r) => r.id === res.match.id);
  const seat = Number(row.companion_count || 0) + 1;
  const mode = row.mode || 'Open';
  const comps = companionsArr(row);
  const companions = [];
  if (mode === 'Fixed') for (let g = 2; g <= seat; g++) companions.push(comps[g - 2].name);

  return {
    found: true,
    alreadySubmitted: !!row.submitted,
    name: row.name1,
    seat,
    mode,
    guests: companions,
  };
}

// payload: { name, mainStatus, guest2..guestN, status2..statusN, message }
export async function submitForm(payload) {
  payload = payload || {};
  const status = await getRsvpStatus();
  if (!status.active) return { success: false, message: 'RSVP submissions are currently closed.', rsvpClosed: true };

  const mainName = String(payload.name || '').trim();
  if (!mainName) return { success: false, message: 'Guest name is required.' };

  const found = await q(`SELECT * FROM guests WHERE lower(name1) = lower($1) LIMIT 1`, [mainName]);
  if (!found.length) return { success: false, message: 'Guest record not found.' };
  const row = found[0];
  if (row.submitted) return { success: false, message: 'This RSVP has already been submitted.' };

  const mode = row.mode || 'Open';
  const seat = Number(row.companion_count || 0) + 1;
  const accepted = payload.mainStatus === ACCEPT;
  const mainStatus = accepted ? ACCEPT : DECLINE;

  let attendingCount = accepted ? 1 : 0;
  const attendingNames = accepted ? [row.name1] : [];
  const comps = companionsArr(row);

  for (let g = 2; g <= seat; g++) {
    const c = comps[g - 2];
    if (mode !== 'Fixed' && payload['guest' + g] !== undefined) {
      c.name = String(payload['guest' + g] || '').trim().slice(0, 120);
    }
    c.status = '';
    if (c.name) {
      c.status = payload['status' + g] === ACCEPT ? ACCEPT : DECLINE;
      if (c.status === ACCEPT) { attendingCount++; attendingNames.push(c.name); }
    }
  }
  const message = String(payload.message || '').trim().slice(0, 1000);

  // "submitted = false" in the WHERE stops a double submission from two tabs
  const upd = await q(
    `UPDATE guests SET status1 = $2, companions = $3::jsonb, total_attending = $4,
            submitted = true, submitted_at = now(), message = $5
     WHERE id = $1 AND submitted = false RETURNING id`,
    [row.id, mainStatus, JSON.stringify(comps), attendingCount, message]
  );
  if (!upd.length) return { success: false, message: 'This RSVP has already been submitted.' };

  return {
    success: true,
    message: attendingCount > 0
      ? 'We are excited to celebrate with you.'
      : 'We are sorry you cannot make it, but thank you for letting us know.',
    summary: {
      name: row.name1,
      attendance: mainStatus,
      seatCount: attendingCount,
      guestNames: attendingNames,
      message,
    },
  };
}

// ============================================================
//  ADMIN — DASHBOARD
// ============================================================
export async function getDashboardData() {
  const rows = await allGuests();
  const s = { totalMainGuests: 0, totalInvited: 0, totalResponded: 0, totalPending: 0,
    totalAccepted: 0, totalDeclined: 0, totalAttending: 0, totalNotAttending: 0 };
  const timeline = {};
  const recent = [];
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

  for (const r of rows) {
    if (!String(r.name1 || '').trim()) continue;
    s.totalMainGuests++;
    const invited = Number(r.companion_count || 0) + 1;
    s.totalInvited += invited;
    if (r.submitted) {
      s.totalResponded++;
      if (r.status1 === ACCEPT) s.totalAccepted++;
      else if (r.status1 === DECLINE) s.totalDeclined++;
      const attending = Number(r.total_attending || 0);
      s.totalAttending += attending;
      s.totalNotAttending += Math.max(invited - attending, 0);
      if (r.submitted_at) {
        const key = fmt.format(new Date(r.submitted_at));
        timeline[key] = (timeline[key] || 0) + 1;
      }
      recent.push({ id: r.id, name: r.name1, response: r.status1, attending, date: iso(r.submitted_at) });
    } else {
      s.totalPending++;
    }
  }
  recent.sort((a, b) => new Date(b.date) - new Date(a.date));
  return {
    stats: s,
    timeline: Object.keys(timeline).sort().map((k) => ({ date: k, count: timeline[k] })),
    recent: recent.slice(0, 10),
  };
}

// kind: 'attending' | 'not-attending' — individual people, not rows
export async function getAttendanceList(kind) {
  const rows = await allGuests();
  const want = kind === 'attending' ? ACCEPT : DECLINE;
  const list = [];
  for (const r of rows) {
    const main = String(r.name1 || '').trim();
    if (!main) continue;
    const seat = Number(r.companion_count || 0) + 1;
    const comps = companionsArr(r);
    for (let g = 1; g <= seat; g++) {
      const nm = g === 1 ? main : comps[g - 2].name.trim();
      const st = g === 1 ? r.status1 : comps[g - 2].status;
      if (!nm || st !== want) continue;
      list.push({ name: nm, isMain: g === 1, mainGuest: main });
    }
  }
  list.sort((a, b) => {
    if (a.mainGuest === b.mainGuest) return a.isMain ? -1 : (b.isMain ? 1 : 0);
    return a.mainGuest < b.mainGuest ? -1 : 1;
  });
  return { list, count: list.length };
}

export async function getGuestById(id) {
  await ensureSchema();
  const rows = await q(`SELECT * FROM guests WHERE id = $1`, [String(id)]);
  return rows.length ? toGuestObj(rows[0]) : null;
}

// ============================================================
//  ADMIN — GUEST LIST
// ============================================================
export async function getGuestList(opts) {
  opts = opts || {};
  const search = String(opts.search || '').trim().toLowerCase();
  const filter = opts.filter || 'all';
  const sortField = opts.sortField || 'name1';
  const sortDir = opts.sortDir || 'asc';

  const rows = (await allGuests()).map(toGuestObj).filter((o) => {
    if (!String(o.name1).trim()) return false;
    if (search) {
      const hay = [o.name1];
      for (let g = 2; g <= MAX_GUESTS; g++) hay.push(o['name' + g]);
      if (hay.join(' ').toLowerCase().indexOf(search) === -1) return false;
    }
    if (filter === 'responded' && !o.submitted) return false;
    if (filter === 'pending' && o.submitted) return false;
    if (filter === 'accepted' && o.status1 !== ACCEPT) return false;
    if (filter === 'declined' && o.status1 !== DECLINE) return false;
    if (filter === 'attending' && o.totalAttending <= 0) return false;
    if (filter === 'not-attending' && !(o.submitted && o.totalAttending === 0)) return false;
    return true;
  });
  rows.sort((a, b) => cmp(a[sortField], b[sortField], sortDir));
  return paginate(rows, opts);
}

export async function addGuest(guest) {
  guest = guest || {};
  await ensureSchema();
  const name1 = String(guest.name1 || '').trim();
  if (!name1) return { success: false, message: 'Main guest name is required.' };
  const dup = await q(`SELECT 1 FROM guests WHERE lower(name1) = lower($1)`, [name1]);
  if (dup.length) return { success: false, message: 'A guest with this name already exists.' };
  const mode = cleanMode(guest.mode);
  const comps = mode === 'Fixed' ? companionsFromInput(guest) : companionsFromInput({});
  await q(
    `INSERT INTO guests (id, name1, companion_count, mode, companions) VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [newId(), name1, clampCompanions(guest.companionCount), mode, JSON.stringify(comps)]
  );
  return { success: true, message: 'Guest added.' };
}

export async function updateGuest(guest) {
  guest = guest || {};
  await ensureSchema();
  const rows = await q(`SELECT * FROM guests WHERE id = $1`, [String(guest.id)]);
  if (!rows.length) return { success: false, message: 'Guest not found.' };
  const name1 = String(guest.name1 || '').trim();
  if (!name1) return { success: false, message: 'Main guest name is required.' };
  const dup = await q(`SELECT 1 FROM guests WHERE lower(name1) = lower($1) AND id <> $2`, [name1, String(guest.id)]);
  if (dup.length) return { success: false, message: 'A guest with this name already exists.' };
  const mode = cleanMode(guest.mode);
  let comps = companionsArr(rows[0]);
  if (mode === 'Fixed' && Array.isArray(guest.companions)) {
    const names = companionsFromInput(guest);
    comps = comps.map((c, i) => ({ name: names[i].name, status: c.status }));
  }
  await q(
    `UPDATE guests SET name1 = $2, companion_count = $3, mode = $4, companions = $5::jsonb WHERE id = $1`,
    [String(guest.id), name1, clampCompanions(guest.companionCount), mode, JSON.stringify(comps)]
  );
  return { success: true, message: 'Guest updated.' };
}

export async function deleteGuest(id) {
  return bulkDeleteGuests([id]);
}

export async function bulkDeleteGuests(ids) {
  await ensureSchema();
  const list = (ids || []).map(String);
  if (!list.length) return { success: true, deleted: 0 };
  const rows = await q(`DELETE FROM guests WHERE id = ANY($1::text[]) RETURNING id`, [list]);
  return { success: true, deleted: rows.length };
}

// ============================================================
//  ADMIN — IMPORT / EXPORT
// ============================================================
// rows: [{ name1, companionCount, mode, companions: [] }]
export async function importGuests(rows) {
  await ensureSchema();
  const existing = new Set((await q(`SELECT lower(name1) AS n FROM guests`)).map((r) => r.n));
  let imported = 0, duplicates = 0, invalid = 0;
  const batch = [];
  for (const guest of rows || []) {
    const name1 = String((guest && guest.name1) || '').trim();
    if (!name1) { invalid++; continue; }
    const key = name1.toLowerCase();
    if (existing.has(key)) { duplicates++; continue; }
    existing.add(key);
    const mode = cleanMode(guest.mode);
    batch.push({
      id: newId() + '' + imported,
      name1,
      companion_count: clampCompanions(guest.companionCount),
      mode,
      companions: mode === 'Fixed' ? companionsFromInput(guest) : companionsFromInput({}),
    });
    imported++;
  }
  // one INSERT per 200 rows
  for (let i = 0; i < batch.length; i += 200) {
    const chunk = batch.slice(i, i + 200);
    await q(
      `INSERT INTO guests (id, name1, companion_count, mode, companions)
       SELECT x.id, x.name1, x.companion_count, x.mode, x.companions
       FROM jsonb_to_recordset($1::jsonb) AS x(id text, name1 text, companion_count int, mode text, companions jsonb)
       ON CONFLICT DO NOTHING`,
      [JSON.stringify(chunk)]
    );
  }
  return { success: true, imported, duplicates, invalid };
}

export async function getExportData(opts) {
  opts = opts || {};
  if (opts.ids && opts.ids.length) {
    await ensureSchema();
    const rows = await q(`SELECT * FROM guests WHERE id = ANY($1::text[]) ORDER BY created_at, id`, [opts.ids.map(String)]);
    return rows.map(toGuestObj);
  }
  return (await getGuestList({ ...opts, page: 1, pageSize: 100000 })).rows;
}

// ============================================================
//  ADMIN — RESPONSES (one row per individual attendee)
// ============================================================
export async function getResponsesList(opts) {
  opts = opts || {};
  const search = String(opts.search || '').trim().toLowerCase();
  const filter = opts.filter || 'all';
  const sortField = opts.sortField || 'family';
  const sortDir = opts.sortDir || 'asc';

  let rows = [];
  for (const r of await allGuests()) {
    const main = String(r.name1 || '').trim();
    if (!main || !r.submitted) continue;
    const seat = Number(r.companion_count || 0) + 1;
    const comps = companionsArr(r);
    for (let g = 1; g <= seat; g++) {
      const nm = g === 1 ? main : comps[g - 2].name.trim();
      if (!nm) continue;
      rows.push({
        id: r.id + '-' + g,
        guestId: r.id,
        family: main,
        name: nm,
        relation: g === 1 ? 'Main Guest' : 'Companion',
        isMain: g === 1,
        status: (g === 1 ? r.status1 : comps[g - 2].status) || '',
        message: r.message || '',
        allergies: r.allergies || '',
        submittedAt: iso(r.submitted_at),
        totalAttending: Number(r.total_attending || 0),
      });
    }
  }
  if (search) rows = rows.filter((o) => (o.name + ' ' + o.family).toLowerCase().indexOf(search) !== -1);
  if (filter === 'attending') rows = rows.filter((o) => o.status === ACCEPT);
  if (filter === 'not-attending') rows = rows.filter((o) => o.status === DECLINE);
  rows.sort((a, b) => cmp(a[sortField], b[sortField], sortDir) || (a.isMain === b.isMain ? 0 : a.isMain ? -1 : 1));
  return paginate(rows, opts);
}

export async function getResponsesExportData(opts) {
  return (await getResponsesList({ ...(opts || {}), page: 1, pageSize: 100000 })).rows;
}
