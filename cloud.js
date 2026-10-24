/* Repco Roster cloud layer: Firebase login (usernames only), live per-record sync,
   shift offers, in-app + phone notifications, and moving data from the old database.
   Loaded after the main page scripts, so it replaces some of their functions. */

var RC_CONFIG = {
  apiKey: "AIzaSyC6MGrMUHyQL6NCgU_2kw9h8hN_-Vxkp7A",
  authDomain: "repco-roster.firebaseapp.com",
  databaseURL: "https://repco-roster-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "repco-roster",
  storageBucket: "repco-roster.firebasestorage.app",
  messagingSenderId: "61137172083",
  appId: "1:61137172083:web:82ddd7799346cdec171c06"
};
// Phone alerts while the app is closed: paste your Cloudflare worker URL here (see push-worker/README.md)
var RC_PUSH_WORKER_URL = "https://repco-roster-push.blackbeard9488.workers.dev";
var RC_VAPID_PUBLIC_KEY = "BPo8UDyWHwgVI8cVIXiB0uVBEiPgiCRjmtZ8MLOYE_BbfGFqpWasjhPL0uA8TYVf_n0tlH4aw8JVU4qq04bWc8I";
var RC_OLD_DB_URL = "https://testing-de079-default-rtdb.asia-southeast1.firebasedatabase.app";
var RC_EMAIL_DOMAIN = "repco-roster.firebaseapp.com";
var RC_MANAGER_ROLES = ['admin', 'manager', 'master'];
var RC_EMULATOR = /[?&]emulator=1\b/.test(location.search);

/* Which localStorage keys live in the cloud, where, and who may change them */
var RC_SYNC = [
  { key: 'retail_roster_byFortnight_v1', path: 'data/roster', kind: 'roster', mgrWrite: true, def: [] },
  { key: 'retail_roster_requests_v2', path: 'data/requests', kind: 'list', mgrWrite: false, def: [] },
  { key: 'retail_roster_hidden_v1', path: 'data/kv/hidden', kind: 'value', mgrWrite: true, def: [] },
  { key: 'retail_roster_hidden_staff_v1', path: 'data/kv/hidden_staff', kind: 'value', mgrWrite: true, def: [] },
  { key: 'retail_roster_public_holidays_v1', path: 'data/kv/public_holidays', kind: 'value', mgrWrite: true, def: [] },
  { key: 'retail_roster_hidden_shifts_v1', path: 'mgrdata/hidden_shifts', kind: 'value', mgrWrite: true, mgrRead: true, def: {} },
  { key: 'retail_roster_archive_v1', path: 'mgrdata/archive', kind: 'value', mgrWrite: true, mgrRead: true, def: [] },
  { key: 'retail_roster_uploaded_excels_v1', path: 'mgrdata/uploaded_excels', kind: 'value', mgrWrite: true, mgrRead: true, def: [] }
];

var RC = {
  app: null, auth: null, db: null,
  session: null,        // {uid, profile}
  users: {},            // uid -> profile
  base: {},             // key -> last known cloud value (normalised)
  ready: {},            // key -> true once the first cloud value arrived
  applying: false,
  listeners: [],
  offers: {},           // offer id -> offer
  notifs: [],           // my notifications, newest first
  seenNotifs: {},
  sessionStart: 0,
  freshLogin: false,
  bootstrapping: false,
  setupDone: null,
  byKey: {},
  team: 'main',         // the team whose roster this page shows (switching reloads the page)
  teamInfo: {},         // team id -> {name}
  access: {},           // uid -> {team id: true} extra teams someone may see
  allUsers: {},         // every login in every team (RC.users is only this team's)
  guests: {},           // team id -> {uid: true} people borrowed from other teams
  otherRosters: {},     // team id -> fortnights, for people rostered in more than one team
  shared: {},           // person key -> team id -> {days: {iso: shift}} for people on more than one team's roster
  xOffers: {}           // team id -> my offers from teams other than the open one
};
RC_SYNC.forEach(function (s) { s.base = s.path; RC.byKey[s.key] = s; });

/* ---------- Firebase start-up ---------- */
try {
  RC.app = firebase.apps.length ? firebase.app() : firebase.initializeApp(RC_CONFIG);
  RC.auth = firebase.auth();
  RC.db = firebase.database();
  if (RC_EMULATOR) {
    RC.auth.useEmulator('http://127.0.0.1:9099', { disableWarnings: true });
    RC.db.useEmulator('127.0.0.1', 9000);
  }
  db = RC.db;
} catch (e) { console.error('Firebase failed to start', e); }

/* ---------- small helpers ---------- */
function rcIsMgrRole(r) { return RC_MANAGER_ROLES.indexOf(String(r || '').toLowerCase()) !== -1; }
function rcIsMgr() { return !!(RC.session && rcIsMgrRole(RC.session.profile.role)); }
/* ---------- teams: each team's data lives apart; the first team keeps the original paths ---------- */
function rcTP(p) { return rcTPx(RC.team, p); }
function rcTPx(t, p) { return t === 'main' ? p : 'teams/' + t + '/' + p; }
function rcGuestTeams(uid) { return Object.keys(RC.guests).filter(function (t) { return (RC.guests[t] || {})[uid] === true; }); }
function rcIsGuestHere(uid) { return (RC.guests[RC.team] || {})[uid] === true; }
/* Everyone who can be on this team's roster: its own people plus anyone borrowed from another team */
function rcTeamPeople() {
  return Object.keys(RC.allUsers).filter(function (k) { return rcHomeTeam(RC.allUsers[k]) === RC.team || rcIsGuestHere(k); })
    .map(function (k) { return Object.assign({ uid: k }, RC.allUsers[k]); });
}
function rcHomeTeam(u) { return (u && u.team) || 'main'; }
/* Roles: master (both teams, accounts) > manager (own team: rosters, requests, staff, settings)
   > admin (own team: roster changes, logged) > staff */
function rcRoleOf(u) { return String((u && u.role) || 'staff').toLowerCase(); }
function rcMyRole() { return RC.session ? rcRoleOf(RC.session.profile) : 'staff'; }
function rcIsOwner() { return !!RC.session && rcRoleOf(RC.allUsers[RC.session.uid] || RC.session.profile) === 'master'; }   // a master: every team
function rcIsManagerUp() { var r = rcMyRole(); return r === 'manager' || r === 'master'; }
function rcIsAdminOnly() { return rcMyRole() === 'admin'; }
function rcTeamName(t) { var i = RC.teamInfo[t]; return (i && i.name) || (t === 'main' ? 'Main team' : t); }
function rcTeamIds() { return ['main'].concat(Object.keys(RC.teamInfo).filter(function (t) { return t !== 'main'; })); }
/* Teams a login may open: masters see all, everyone else their own team plus any that borrowed them */
function rcTeamsFor(uid, prof) {
  if (rcRoleOf(prof) === 'master') return rcTeamIds();
  var home = rcHomeTeam(prof), guest = rcGuestTeams(uid);
  return [home].concat(rcTeamIds().filter(function (t) { return t !== home && guest.indexOf(t) !== -1; }));
}
/* Masters keep their role everywhere; someone borrowed into another team is staff there */
function rcEffProfile(uid, prof) {
  if (rcRoleOf(prof) === 'master') return prof;
  // borrowed into another team: staff there, whatever their role at home
  if (RC.team !== rcHomeTeam(prof) && rcIsGuestHere(uid)) return Object.assign({}, prof, { role: 'staff' });
  return prof;
}
function rcCanManageAccounts() { return rcIsOwner() || (rcMyRole() === 'manager' && rcHomeTeam(RC.allUsers[RC.session.uid] || RC.session.profile) === RC.team); }
function rcSyncKeys() { return RC_SYNC.map(function (s) { return s.key; }).concat(['retail_roster_currentFortnightId']); }
function rcSwitchTeam(t) {
  if (t === RC.team) return;
  try { sessionStorage.setItem('rc_switched', '1'); } catch (e) {}
  safeSet('repco_team', t);
  rcSyncKeys().forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
  safeSet('repco_last_activity', String(Date.now()));
  location.reload();
}
async function rcLoadTeamContext(uid, prof) {
  var get = function (p) { return RC.db.ref(p).once('value').then(function (s) { return s.val(); }).catch(function () { return null; }); };
  var r = await Promise.all([get('teamInfo'), get('guests')]);
  RC.teamInfo = r[0] || {}; RC.guests = r[1] || {};
  var allowed = rcTeamsFor(uid, prof), want = safeGet('repco_team', '') || rcHomeTeam(prof);
  RC.team = allowed.indexOf(want) !== -1 ? want : rcHomeTeam(prof);
  if (allowed.indexOf(RC.team) === -1) RC.team = allowed[0] || 'main';
  safeSet('repco_team', RC.team);
  RC_SYNC.forEach(function (s) { s.path = rcTP(s.base); });
}
function rcEsc(s) { return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function rcEncodeKey(k) { k = String(k); if (k === '') return '%00'; return k.replace(/[.#$\[\]\/%]/g, function (c) { return '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'); }); }
function rcDecodeKey(k) { if (k === '%00') return ''; return String(k).replace(/%([0-9A-F]{2})/g, function (m, h) { return String.fromCharCode(parseInt(h, 16)); }); }
function rcLoginKey(u) { return rcEncodeKey(String(u || '').trim().toLowerCase()); }
function rcAuthPassword(p) { return 'repco-roster:' + String(p); }  // lets short legacy passwords meet Firebase's 6-character minimum
function rcMakeEmail(u) {
  var hex = Array.prototype.map.call(unescape(encodeURIComponent(String(u).trim().toLowerCase())), function (c) { return c.charCodeAt(0).toString(16).padStart(2, '0'); }).join('');
  return 'u' + hex + '.' + Date.now().toString(36) + '@' + RC_EMAIL_DOMAIN;
}
function rcValidUsername(u) { return /^[A-Za-z0-9._-]{2,40}$/.test(u); }
function rcSetLocal(k, v) { RC.applying = true; try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { MEMORY_STORE[k] = JSON.stringify(v); } finally { RC.applying = false; } }
function rcIsObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function rcErrMsg(e) {
  var c = (e && e.code) || '';
  if (/PERMISSION_DENIED|permission/i.test(c + ' ' + (e && e.message))) return 'you do not have permission for that change';
  if (c === 'auth/wrong-password' || c === 'auth/invalid-credential' || c === 'auth/invalid-login-credentials' || c === 'auth/user-not-found') return 'incorrect username or password';
  if (c === 'auth/too-many-requests') return 'too many attempts - wait a few minutes and try again';
  if (c === 'auth/network-request-failed') return 'no internet connection';
  if (c === 'auth/operation-not-allowed' || c === 'auth/configuration-not-found') return 'Email/Password sign-in is not switched on in Firebase (see SETUP.md)';
  return (e && e.message) || String(e);
}

/* Firebase stores no empty objects/arrays and turns arrays into numbered objects.
   Normalising both sides the same way lets us compare them field by field. */
function rcNorm(v, encode) {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'number' && !isFinite(v)) return undefined;
  if (Array.isArray(v) || typeof v === 'object') {
    var o = {}, n = 0;
    Object.keys(v).forEach(function (k) { var x = rcNorm(v[k], encode); if (x !== undefined) { o[encode ? rcEncodeKey(k) : k] = x; n++; } });
    return n ? o : undefined;
  }
  return v;
}
function rcDecodeTree(v) {
  if (!v || typeof v !== 'object') return v;
  var keys = Object.keys(v);
  if (keys.length && keys.every(function (k) { return /^\d+$/.test(k); })) {
    var arr = [];
    keys.forEach(function (k) { arr[parseInt(k, 10)] = rcDecodeTree(v[k]); });
    for (var i = 0; i < arr.length; i++) if (arr[i] === undefined) arr[i] = null;
    return arr;
  }
  var o = {};
  keys.forEach(function (k) { o[rcDecodeKey(k)] = rcDecodeTree(v[k]); });
  return o;
}
function rcSparse(v) { var o = {}; if (v && typeof v === 'object') Object.keys(v).forEach(function (k) { if (v[k] !== null && v[k] !== undefined) o[k] = v[k]; }); return o; }
function rcAsArray(v) { if (Array.isArray(v)) return v.filter(function (x) { return x !== null && x !== undefined; }); if (v && typeof v === 'object') return Object.keys(v).map(function (k) { return v[k]; }).filter(function (x) { return x !== null && x !== undefined; }); return []; }
function rcDiff(a, b, path, out) {
  if (rcIsObj(a) && rcIsObj(b)) {
    var seen = {};
    Object.keys(a).concat(Object.keys(b)).forEach(function (k) { if (seen[k]) return; seen[k] = 1; rcDiff(a[k], b[k], path + '/' + k, out); });
    return;
  }
  if (a === b) return;
  out[path] = (b === undefined) ? null : b;
}

/* Staff rows are stored by name so two people editing different rows never collide */
function rcStaffKeys(fn) {
  var used = {};
  return (fn && fn.staff ? fn.staff : []).map(function (st) {
    var base = String((st && st.lastName) || '').trim().toUpperCase() + '_' + String((st && st.firstName) || '').trim();
    var k = base, n = 2;
    while (used[k]) k = base + '~' + (n++);
    used[k] = 1;
    return k;
  });
}
function rcStaffSort(a, b) { var c = String(a.lastName || '').localeCompare(String(b.lastName || '')); if (c !== 0) return c; return String(a.firstName || '').localeCompare(String(b.firstName || '')); }
function rcReqId(r) { return r.id || ('r' + (r.ts || 0) + '_' + String(r.username || 'x').toLowerCase().replace(/[^a-z0-9]/g, '')); }

function rcToCloud(spec, local) {
  if (spec.kind === 'roster') {
    var out = {};
    rcAsArray(local).forEach(function (fn) {
      if (!fn || !fn.id) return;
      var keys = rcStaffKeys(fn), staff = {};
      (fn.staff || []).forEach(function (st, i) { staff[keys[i]] = st; });
      var copy = {}; Object.keys(fn).forEach(function (k) { if (k !== 'staff') copy[k] = fn[k]; });
      copy.staff = staff;
      out[fn.id] = copy;
    });
    return rcNorm(out, true);
  }
  if (spec.kind === 'list') {
    var o = {};
    rcAsArray(local).forEach(function (r) {
      if (!r || typeof r !== 'object') return;
      var c = Object.assign({}, r);
      c.id = rcReqId(r);
      c.usernameLower = String(r.username || '').toLowerCase();
      o[c.id] = c;
    });
    return rcNorm(o, true);
  }
  return rcNorm(local, true);
}
function rcFromCloud(spec, raw) {
  var v = rcDecodeTree(raw);
  if (spec.kind === 'roster') {
    var fns = rcAsArray(v).map(function (fn) {
      fn.staff = rcAsArray(fn.staff).sort(rcStaffSort);
      // Per-cell flags must stay sparse: the Excel re-import treats any present entry as "edited by a manager"
      fn.staff.forEach(function (st) { ['originalShifts', 'absentApproved', 'cellGreen', 'cellG'].forEach(function (k) { if (st[k] !== undefined) st[k] = rcSparse(st[k]); }); });
      fn.dates = rcAsArray(fn.dates);
      return fn;
    });
    fns.sort(function (a, b) { var x = (a.dates[0] && a.dates[0].iso) || '', y = (b.dates[0] && b.dates[0].iso) || ''; return x < y ? -1 : x > y ? 1 : 0; });
    if (RC.session && !rcIsMgr()) fns = fns.filter(function (f) { return !f.draft; });   // drafts are for managers only
    return fns;
  }
  if (spec.kind === 'list') return rcAsArray(v).sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); });
  if (v === undefined || v === null) return JSON.parse(JSON.stringify(spec.def));
  if (Array.isArray(spec.def)) return rcAsArray(v);
  return v;
}

/* ---------- writing: every local save becomes a field-level cloud update ---------- */
var _rcOrigSafeSet = safeSet;
safeSet = function (k, v) {
  _rcOrigSafeSet(k, v);
  if (!RC.applying && RC.byKey[k]) rcFlush(RC.byKey[k]);
};

function rcFlush(spec) {
  if (!RC.session || !RC.ready[spec.key]) return;
  if (spec.mgrWrite && !rcIsMgr()) return;
  var local = safeGetJSON(spec.key, spec.def);
  var prev = RC.base[spec.key];
  if (spec.kind === 'roster' && RC.importDraft) {   // "Import as a draft": new fortnights start hidden from staff
    var marked = false;
    RC.importDraftIds = RC.importDraftIds || {};   // the import can save more than once; keep its new fortnights marked
    rcAsArray(local).forEach(function (fn) {
      if (!fn || !fn.id || fn.draft) return;
      if (!(prev && prev[rcEncodeKey(fn.id)]) || RC.importDraftIds[fn.id]) { fn.draft = true; RC.importDraftIds[fn.id] = 1; marked = true; }
    });
    if (marked) rcSetLocal(spec.key, local);
  }
  var next = rcToCloud(spec, local);
  var updates = {};
  rcDiff(prev, next, spec.path, updates);
  if (!Object.keys(updates).length) return;

  if (spec.kind === 'roster') {
    var before = prev ? Object.keys(prev).length : 0, after = next ? Object.keys(next).length : 0;
    if (before > 0 && after === 0) { toast('Blocked: that change would delete every roster'); rcApplyCloud(spec); return; }
    if (before - after > 1 && !RC.allowBulkDelete) { toast('Blocked: that change would delete ' + (before - after) + ' rosters at once'); rcApplyCloud(spec); return; }
  }
  var extraNotes = [];
  try { rcCollectSideEffects(spec, prev, next, updates, extraNotes); } catch (e) { console.error('side effects', e); }
  RC.base[spec.key] = next;
  rcSetStatus('saving');
  rcSave(updates).then(function () {
    rcSetStatus('saved');
    extraNotes.forEach(function (n) { if (n.withdraw) rcPushWithdraw(n.withdraw); else rcNotify(n.uids, n.note); });
  }).catch(function (e) {
    console.error('save failed', spec.key, e);
    rcSetStatus('error');
    toast('NOT SAVED - ' + rcErrMsg(e));
    rcApplyCloud(spec, true);
  });
}

/* Put the cloud copy back into the page (after a refused save, or a blocked one) */
function rcApplyCloud(spec, refetch) {
  if (refetch) {
    RC.db.ref(spec.path).once('value').then(function (s) { rcOnValue(spec, s.val()); }).catch(function () {});
    return;
  }
  rcSetLocal(spec.key, rcFromCloud(spec, RC.base[spec.key]));
  rcScheduleRender();
}

function rcOnValue(spec, raw) {
  RC.base[spec.key] = rcNorm(raw, false);
  RC.ready[spec.key] = true;
  rcSetLocal(spec.key, rcFromCloud(spec, raw));
  rcScheduleRender(spec.key);
}

/* Notifications and offer clean-up that follow from a saved change */
function rcCollectSideEffects(spec, prev, next, updates, notes) {
  var me = RC.session.uid;
  if (spec.kind === 'roster' && rcIsMgr()) {
    var newFns = [];
    Object.keys(prev || {}).forEach(function (fk) {
      if (!next || !next[fk]) rcLogHistory(updates, { fnId: prev[fk].id, fn: rcFnRange(rcDecodeTree(prev[fk])), action: 'Roster deleted' });
    });
    Object.keys(next || {}).forEach(function (fk) {
      var nf = next[fk], of = prev && prev[fk];
      var fnLabel = rcFnRange(rcDecodeTree(nf));
      // Drafts: staff can't see them, so no alerts until a manager publishes
      var isDraft = !!(nf && nf.draft) || (!of && RC.importDraft);
      if (!of) { newFns.push(fk); if (prev) rcLogHistory(updates, { fnId: nf.id, fn: fnLabel, action: isDraft ? 'Roster added as draft' : 'Roster added' }); }
      var changesByUser = {};
      Object.keys((nf && nf.staff) || {}).forEach(function (sk) {
        var ns = nf.staff[sk], os = of && of.staff && of.staff[sk];
        var user = rcUserForStaff(ns);
        var targets = rcUsersForStaff(ns).map(function (u) { return u.uid; }).filter(function (uid) { return uid !== me; });
        var nsh = (ns && ns.shifts) || {}, osh = (os && os.shifts) || {};
        Object.keys(nsh).forEach(function (i) {
          var nv = String(nsh[i]), ov = osh[i] === undefined ? undefined : String(osh[i]);
          var oid = fk + '~' + sk + '~' + i;
          var offer = RC.offers[oid];
          if (offer && offer.status === 'pending' && !rcIsEmptyVal(nv)) {
            updates[rcTP('offers/' + oid + '/status')] = 'cancelled';
            updates[rcTP('offers/' + oid + '/respondedTs')] = firebase.database.ServerValue.TIMESTAMP;
            rcWithdrawOfferAlert(offer, updates);
            notes.push({ withdraw: offer });
          }
          if (of && ov !== undefined && ov !== nv) rcLogHistory(updates, { fnId: nf.id, fn: fnLabel, name: String(ns.lastName || '').toUpperCase() + ', ' + ns.firstName, day: rcDayLabel(rcDecodeTree(nf), i), from: rcShiftText(ov), to: rcShiftText(nv) });
          if (isDraft) return;
          if (!of || ov === undefined || ov === nv || !targets.length) return;
          if (RC.quietUids && targets.some(function (uid) { return RC.quietUids[uid]; })) return;   // a request decision sends its own alert
          if (rcIsEmptyVal(ov) && rcIsEmptyVal(nv)) return;
          var day = nf.dates && nf.dates[i];
          if (day && day.iso && day.iso < getISO()) return;            // no alerts about days already gone
          var label = rcDayLabel(rcDecodeTree(nf), i);
          var bucket = changesByUser[sk] = changesByUser[sk] || { abs: [], back: [], ua: [], uaBack: [], shift: [], uids: targets };
          var orig = ns.originalShifts && ns.originalShifts[i] != null ? String(ns.originalShifts[i]) : ov;
          var missed = rcIsEmptyVal(orig) || rcIsAbsentVal(orig) || rcIsUAVal(orig) ? 'day off' : 'your ' + orig + ' shift';
          if (rcIsUAVal(nv) && !rcIsUAVal(ov)) bucket.ua.push(label + ' - ' + missed);
          else if (rcIsUAVal(ov) && !rcIsUAVal(nv) && !rcIsAbsentVal(nv)) bucket.uaBack.push(label + ' - ' + (rcIsEmptyVal(nv) ? 'OFF' : 'back on ' + nv));
          else if (rcIsAbsentVal(nv) && !rcIsAbsentVal(ov)) bucket.abs.push(label + ' - ' + (rcIsEmptyVal(orig) || rcIsAbsentVal(orig) ? 'day off' : 'your ' + orig + ' shift'));
          else if (rcIsAbsentVal(ov) && !rcIsAbsentVal(nv)) bucket.back.push(label + ' - ' + (rcIsEmptyVal(nv) ? 'OFF' : 'back on ' + nv));
          else bucket.shift.push(label + ': ' + rcShiftText(nv) + ' (was ' + rcShiftText(ov) + ')');
        });
      });
      Object.keys(changesByUser).forEach(function (key) {
        var b = changesByUser[key], uid = b.uids;
        if (b.abs.length) notes.push({ uids: uid, note: { type: 'absent', title: 'Marked absent (AB)', body: 'A manager has marked you absent for:\n' + b.abs.join('\n') } });
        if (b.ua.length) notes.push({ uids: uid, note: { type: 'unavailable', title: 'Marked unavailable (UA)', body: 'You have been marked unavailable for:\n' + b.ua.join('\n') } });
        if (b.uaBack.length) notes.push({ uids: uid, note: { type: 'unavailable-removed', title: 'Unavailability removed', body: b.uaBack.join('\n') } });
        if (b.back.length) notes.push({ uids: uid, note: { type: 'absent-removed', title: 'Absence removed', body: b.back.join('\n') } });
        var lines = b.shift;
        if (lines.length) notes.push({ uids: uid, note: { type: 'shift-update', title: 'Your shifts changed', body: lines.length <= 3 ? lines.join('\n') : (lines.length + ' shifts changed in ' + fnLabel + '. Open the roster to check.') } });
      });
      if (!of && prev && !isDraft) {
        var who = {};
        Object.keys((nf && nf.staff) || {}).forEach(function (sk) {
          var ns = nf.staff[sk];
          var works = Object.keys((ns && ns.shifts) || {}).some(function (i) { return !rcIsEmptyVal(String(ns.shifts[i])); });
          if (works) rcUsersForStaff(ns).forEach(function (u) { if (u.uid !== me) who[u.uid] = 1; });
        });
        var uids = Object.keys(who);
        if (uids.length) notes.push({ uids: uids, note: { type: 'roster-new', title: 'New roster published', body: fnLabel + ' is now on the roster.' } });
      }
    });
    if (newFns.length && prev) setTimeout(function () { rcEnsureHiddenRows(); rcApplyApprovedUnavailability(); }, 50);
  }
  if (spec.kind === 'list') {
    Object.keys(next || {}).forEach(function (id) {
      var n = next[id], o = prev && prev[id];
      if (!o && n.status === 'pending' && !rcIsMgr()) {
        notes.push({ uids: rcManagerUids(), note: { type: 'request-new', title: 'New request', body: (n.username || '') + ': ' + rcReqSummary(rcDecodeTree(n)) } });
      }
      var dn = rcDecodeTree(n), aff = rcAsArray(dn.affected);
      if (o && o.status === 'pending' && n.status && n.status !== 'pending') {
        var u = rcUserByUsername(n.username);
        var extra = '';
        if (n.status === 'approved' && dn.type === 'unavailability') extra = aff.length ? '\nShifts marked unavailable (UA):\n' + aff.join('\n') : '\nNo rostered shifts were affected.';
        if (n.status === 'approved' && dn.type === 'shift-correction' && aff.length) extra = '\nRoster updated: ' + aff.join(', ');
        if (u && u.uid !== me) notes.push({ uids: [u.uid], note: { type: 'request-' + n.status, title: 'Request ' + n.status, body: rcReqSummary(dn) + extra } });
      }
      if (o && o.status === 'approved' && n.status === 'reversed') {
        var ur = rcUserByUsername(n.username);
        if (ur && ur.uid !== me) notes.push({ uids: [ur.uid], note: { type: 'request-reversed', title: 'Approval reversed', body: rcReqSummary(dn) + (aff.length ? '\nBack on the roster:\n' + aff.join('\n') : '') } });
      }
    });
  }
}
/* Change history: one entry per changed cell, kept for managers */
/* Save a change; change-history entries go in a second write so a history problem (e.g. database
   rules not updated yet) can never block the change itself */
function rcSave(upd) {
  var main = {}, hist = {};
  Object.keys(upd).forEach(function (k) { (/^(teams\/[^/]+\/)?history\//.test(k) ? hist : main)[k] = upd[k]; });
  return RC.db.ref().update(main).then(function () {
    if (Object.keys(hist).length) RC.db.ref().update(hist).catch(function (e) { console.warn('history not saved', e && e.code); });
  });
}
function rcLogHistory(updates, e, team) {
  team = team || RC.team;
  var key = RC.db.ref(rcTPx(team, 'history')).push().key;
  updates[rcTPx(team, 'history/' + key)] = Object.assign({ ts: firebase.database.ServerValue.TIMESTAMP, by: RC.session.profile.username }, e);
}
function rcReqSummary(r) {
  if (!r) return '';
  if (r.type === 'unavailability') { var d = rcAsArray(r.dates); return 'Unavailable ' + (d.length > 1 ? d[0] + ' - ' + d[d.length - 1] : (d[0] || '')) + (r.reason ? ' (' + r.reason + ')' : ''); }
  if (r.type === 'shift-correction' && rcIsEmptyVal(r.newShift)) return "Didn't work " + (r.shiftDate || '') + (r.oldShift && !rcIsEmptyVal(r.oldShift) ? ' (rostered ' + r.oldShift + ')' : '') + (r.reason ? ' - ' + r.reason : '');
  if (r.type === 'shift-correction' && rcIsUAVal(r.newShift)) return "Can't work " + (r.shiftDate || '') + (r.oldShift ? ' (' + r.oldShift + ')' : '') + (r.reason ? ' - ' + r.reason : '');
  if (r.type === 'shift-correction') return 'Shift change ' + (r.shiftDate || '') + ': ' + (r.oldShift || '') + ' -> ' + (r.newShift || '') + (r.reason ? ' - ' + r.reason : '');
  return r.type || 'request';
}
function rcIsAbsentVal(v) { return /^(AB|ABSENT)$/i.test(String(v === undefined || v === null ? '' : v).trim()); }
function rcIsEmptyVal(v) { var u = String(v === undefined || v === null ? '' : v).toUpperCase().trim(); return u === '' || u === 'OFF'; }
function rcShiftText(v) { return rcIsEmptyVal(v) ? 'OFF' : String(v); }
function rcDayLabel(fn, i) { var d = fn && fn.dates && fn.dates[i]; return d ? (d.day + ' ' + d.date) : ('day ' + (parseInt(i, 10) + 1)); }
function rcFnRange(fn) { var d = (fn && fn.dates) || []; return d.length ? (d[0].date + ' - ' + d[d.length - 1].date) : ((fn && fn.label) || 'roster'); }

/* ---------- users ---------- */
function rcUserList() { return Object.keys(RC.users).map(function (uid) { return Object.assign({ uid: uid }, RC.users[uid]); }); }
function rcManagerUids(team) {
  team = team || RC.team;
  return Object.keys(RC.allUsers).filter(function (uid) {
    var u = RC.allUsers[uid];
    var r = rcRoleOf(u);   // requests and alerts for managers: that team's managers and every master (not admins)
    return r === 'master' || (r === 'manager' && rcHomeTeam(u) === team);
  });
}
function rcUserByUsername(name) { var l = String(name || '').toLowerCase(); return rcUserList().find(function (u) { return u.usernameLower === l; }) || null; }
/* Every login whose name matches a roster row (someone can have an admin and a staff login) */
function rcUsersForStaff(st) {
  if (!st) return [];
  var f = String(st.firstName || '').toLowerCase().trim(), l = String(st.lastName || '').toLowerCase().trim();
  if (!f) return [];
  var same = function (u) { return String(u.firstName || '').toLowerCase().trim() === f && String(u.lastName || '').toLowerCase().trim() === l; };
  var out = rcTeamPeople().filter(same);
  // the same person on another team's roster (e.g. hidden here, normal staff there): their other login hears too
  var linked = RC.shared[rcPersonKey(st)];
  if (linked) Object.keys(RC.allUsers).forEach(function (k) {
    var u = RC.allUsers[k]; if (!same(u) || out.some(function (x) { return x.uid === k; }) || !linked[rcHomeTeam(u)]) return;
    out.push(Object.assign({ uid: k }, u));
  });
  return out;
}
/* The one login that receives shift offers for a row: their staff login if they have one */
function rcUserForStaff(st) {
  var all = rcUsersForStaff(st);
  return all.find(function (u) { return !rcIsMgrRole(u.role); }) || all[0] || null;
}
function rcStaffForUser(fn, user) {
  if (!fn || !user) return -1;
  var f = String(user.firstName || '').toLowerCase().trim(), l = String(user.lastName || '').toLowerCase().trim();
  return (fn.staff || []).findIndex(function (s) { return String(s.firstName || '').toLowerCase().trim() === f && String(s.lastName || '').toLowerCase().trim() === l; });
}

/* ---------- live listeners ---------- */
function rcListen(ref, ev, fn, onErr) {
  ref.on(ev, fn, function (e) { console.error('listener', ref.toString(), e); if (onErr) onErr(e); });
  RC.listeners.push(function () { ref.off(ev, fn); });
}
function rcAttach() {
  var uid = RC.session.uid, mgr = rcIsMgr();
  rcListen(RC.db.ref('users'), 'value', function (s) {
    var all = s.val() || {};
    RC.allUsers = all;
    RC.users = {};
    Object.keys(all).forEach(function (k) { if (rcHomeTeam(all[k]) === RC.team) RC.users[k] = all[k]; });
    var mine = all[uid];
    if (!mine) { rcForceLogout('Your account has been removed. Ask a manager for help.'); return; }
    if (rcTeamsFor(uid, mine).indexOf(RC.team) === -1) { rcSwitchTeam(rcHomeTeam(mine)); return; }
    mine = rcEffProfile(uid, mine);
    var roleChanged = rcIsMgrRole(mine.role) !== rcIsMgrRole(RC.session.profile.role);
    RC.session.profile = mine;
    safeSet('repco_username', mine.username);
    safeSet('repco_currentRole', String(mine.role || 'staff').toLowerCase());
    rcSetLocal('retail_roster_users_v1', rcUserList().map(function (u) { return { username: u.username, firstName: u.firstName || '', lastName: u.lastName || '', role: u.role, employmentType: u.employmentType || 'casual', isHidden: !!u.isHidden, uid: u.uid }; }));
    RC.ready.users = true;
    if (roleChanged) { toast('Your access level changed - reloading'); setTimeout(function () { location.reload(); }, 1500); return; }
    rcWatchOtherTeams();
    rcScheduleRender('users');
  }, function () {
    // Losing read access to the user list means this account was deleted
    if (RC.session) rcForceLogout('Your account has been removed. Ask a manager for help.');
  });
  RC_SYNC.forEach(function (spec) {
    if (spec.mgrRead && !mgr) { rcSetLocal(spec.key, JSON.parse(JSON.stringify(spec.def))); return; }
    rcListen(RC.db.ref(spec.path), 'value', function (s) { rcOnValue(spec, s.val()); });
  });
  var offersRef = mgr ? RC.db.ref(rcTP('offers')) : RC.db.ref(rcTP('offers')).orderByChild('toUid').equalTo(uid);
  rcListen(offersRef, 'value', function (s) { RC.offers = s.val() || {}; RC.ready.offers = true; rcScheduleRender('offers'); });
  rcListen(RC.db.ref('notifications/' + uid).orderByChild('ts').limitToLast(100), 'value', function (s) {
    var v = s.val() || {};
    var list = Object.keys(v).map(function (k) { return Object.assign({ id: k }, v[k]); }).sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    list.forEach(function (n) {
      if (RC.seenNotifs[n.id]) return;
      RC.seenNotifs[n.id] = 1;
      if (!n.read && (n.ts || 0) > RC.sessionStart) rcAlertForeground(n);
    });
    // Alerts removed in the database (e.g. a withdrawn offer) also disappear from this device's notification tray
    var still = {}; list.forEach(function (n) { still[n.id] = 1; });
    RC.notifs.forEach(function (n) { if (!still[n.id]) rcCloseDeviceAlert(n.id); });
    RC.notifs = list;
    rcScheduleRender('notifs');
  });
  var reTeam = function () {
    var mine = RC.allUsers[uid]; if (!mine || !RC.ready.users) return;
    if (rcTeamsFor(uid, mine).indexOf(RC.team) === -1) { toast('You no longer have access to ' + rcTeamName(RC.team)); setTimeout(function () { rcSwitchTeam(rcHomeTeam(mine)); }, 1200); }
  };
  if (mgr) rcListen(RC.db.ref('shared'), 'value', function (s) { RC.shared = s.val() || {}; rcScheduleRender('shared'); rcQueueShared(); });
  else {
    var mk = rcPersonKey(RC.session.profile);
    if (mk) rcListen(RC.db.ref('shared/' + mk), 'value', function (s) { RC.shared = {}; RC.shared[mk] = s.val() || {}; rcScheduleRender('shared'); });
  }
  rcListen(RC.db.ref('guests'), 'value', function (s) { RC.guests = s.val() || {}; reTeam(); rcWatchOtherTeams(); rcScheduleRender('guests'); });
  rcListen(RC.db.ref('teamInfo'), 'value', function (s) { RC.teamInfo = s.val() || {}; reTeam(); rcScheduleRender('teams'); });
  var conn = RC.db.ref('.info/connected');
  rcListen(conn, 'value', function (s) { rcSetStatus(s.val() ? 'live' : 'offline'); });
}
/* People rostered in more than one team (borrowed): watch their other teams' rosters and offers, read-only */
function rcWatchOtherTeams() {
  if (!RC.session) return;
  var uid = RC.session.uid, mine = RC.allUsers[uid] || RC.session.profile;
  var want = [rcHomeTeam(mine)].concat(rcGuestTeams(uid)).filter(function (t, i, a) { return t !== RC.team && a.indexOf(t) === i; });
  RC.otherWatch = RC.otherWatch || {};
  Object.keys(RC.otherWatch).forEach(function (t) { if (want.indexOf(t) === -1) { RC.otherWatch[t](); delete RC.otherWatch[t]; delete RC.otherRosters[t]; delete RC.xOffers[t]; } });
  want.forEach(function (t) {
    if (RC.otherWatch[t]) return;
    var rRef = RC.db.ref(rcTPx(t, 'data/roster')), oRef = RC.db.ref(rcTPx(t, 'offers')).orderByChild('toUid').equalTo(uid);
    var onR = function (s) {
      var fns = rcAsArray(rcDecodeTree(s.val())).map(function (fn) { fn.staff = rcAsArray(fn.staff).sort(rcStaffSort); fn.dates = rcAsArray(fn.dates); return fn; }).filter(function (fn) { return !fn.draft; });
      RC.otherRosters[t] = fns; rcScheduleRender('other');
    };
    var onO = function (s) { RC.xOffers[t] = s.val() || {}; rcScheduleRender('other'); };
    var quiet = function () { delete RC.otherRosters[t]; delete RC.xOffers[t]; };
    rRef.on('value', onR, quiet); oRef.on('value', onO, quiet);
    RC.otherWatch[t] = function () { rRef.off('value', onR); oRef.off('value', onO); };
  });
}
function rcDetach() { if (RC.otherWatch) { Object.keys(RC.otherWatch).forEach(function (t) { try { RC.otherWatch[t](); } catch (e) {} }); RC.otherWatch = {}; } RC.otherRosters = {}; RC.xOffers = {}; RC.listeners.forEach(function (off) { try { off(); } catch (e) {} }); RC.listeners = []; RC.ready = {}; RC.base = {}; RC.offers = {}; RC.notifs = []; RC.users = {}; RC.allUsers = {}; }

/* Re-draw whatever is on screen after live changes, keeping scroll positions and half-typed forms */
var _rcRenderTimer = null;
function rcScheduleRender() {
  if (_rcRenderTimer) clearTimeout(_rcRenderTimer);
  _rcRenderTimer = setTimeout(rcRenderLive, 120);
}
function rcRenderLive() {
  if (!RC.session) return;
  // Redrawing after someone else's change is not activity, so it must not reset the 30-minute idle timer
  var keepActivity = safeGet('repco_last_activity'), keepTs = lastActivityTs;
  try { rcRenderLiveInner(); } finally {
    if (keepActivity) { _rcOrigSafeSet('repco_last_activity', keepActivity); try { lastActivityTs = keepTs; } catch (e) {} }
  }
}
function rcRenderLiveInner() {
  try {
    var v65 = document.getElementById('repco-v65');
    if (v65 && v65.classList.contains('show') && !RC.cellEditing) {
      var wraps = Array.prototype.map.call(document.querySelectorAll('#roster-mount .r-table-wrap'), function (w) { return [w.scrollLeft, w.scrollTop]; });
      var sel = document.getElementById('fortnight-select');
      var ids = rcAsArray(safeGetJSON('retail_roster_byFortnight_v1', [])).map(function (f) { return f.id; }).join('|');
      if (sel && Array.prototype.map.call(sel.options, function (o) { return o.value; }).join('|') !== ids) {
        var keep = safeGet('retail_roster_currentFortnightId');
        populateFortnightSelect();
        if (keep && ids.split('|').indexOf(keep) !== -1) { sel.value = keep; safeSet('retail_roster_currentFortnightId', keep); }
      }
      renderRosterSafe();
      document.querySelectorAll('#roster-mount .r-table-wrap').forEach(function (w, i) { if (wraps[i]) { w.scrollLeft = wraps[i][0]; w.scrollTop = wraps[i][1]; } });
    }
    var open = document.querySelector('.full-page.show');
    var typing = open && open.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (open && !typing) {
      var id = open.id;
      if (id === 'requests-page') { if (rcIsMgr()) renderRequests(); else rcRenderMyRequestsList(); }
      else if (id === 'unavail-page') renderUnavail();
      else if (id === 'mysched-page') renderMySchedule();
      else if (id === 'notif-page') rcRenderNotifPage();
      else if (id === 'account-mgmt-page' && !document.getElementById('rc-migrate-users') && !(document.getElementById('rc-bulk-log') || {}).textContent) renderAccountMgmtPage();
      else if (id === 'buddies-today-page-v141') renderBuddies('today');
      else if (id === 'buddies-tomorrow-page-v141') renderBuddies('tomorrow');
      else if (id === 'today-workers-page') renderTodayWorkers();
    }
    try { updateMyScheduleCard(); } catch (e) {}
    rcRenderBell();
    rcRenderOfferBanner();
  } catch (e) { console.error('live render', e); }
}

/* Little "LIVE / SAVING / OFFLINE" pill in the roster controls */
function rcSetStatus(s) {
  var el = document.getElementById('rc-sync-status');
  if (!el) {
    var ctl = document.querySelector('#repco-v65 .r-controls');
    if (!ctl) return;
    el = document.createElement('span'); el.id = 'rc-sync-status'; ctl.appendChild(el);
  }
  if (s === 'saved') s = RC.online === false ? 'offline' : 'live';
  if (s === 'live') RC.online = true;
  if (s === 'offline') RC.online = false;
  var map = { live: ['LIVE', '#1a7f37'], saving: ['SAVING...', '#b58900'], offline: ['OFFLINE - changes will send when back online', '#E30613'], error: ['NOT SAVED', '#E30613'] };
  var m = map[s] || map.live;
  el.textContent = '● ' + m[0];
  el.style.cssText = 'font-weight:900;font-size:10px;color:' + m[1] + ';white-space:nowrap';
}

/* ---------- login, setup and logout ---------- */
function rcLoginMsg(msg) { var e = document.getElementById('login-err'); if (e) e.textContent = msg || ''; }
function rcShowLogin(msg) {
  var lp = document.getElementById('login-page'); if (lp) lp.style.display = 'flex';
  document.getElementById('repco-v65').classList.remove('show');
  document.querySelectorAll('.full-page').forEach(function (e) { e.classList.remove('show'); });
  var gh = document.getElementById('global-header'); if (gh) gh.classList.remove('show');
  rcLoginMsg(msg || '');
  rcLoginBusy(false);
  rcCheckSetup();
  rcSyncCogs();
  rcAddKeepSignedIn();
  rcApplyMobile();
}
function rcLoginBusy(b) { var btn = document.getElementById('login-signin-btn'); if (btn) { btn.disabled = b; btn.textContent = b ? 'SIGNING IN...' : 'SIGN IN'; } }

async function rcSignIn(username, password) {
  var key = rcLoginKey(username);
  var snap = await RC.db.ref('logins/' + key).once('value');
  var rec = snap.val();
  if (!rec || !rec.email) { var err = new Error('incorrect username or password'); err.code = 'auth/user-not-found'; throw err; }
  safeSet('repco_last_activity', String(Date.now()));
  RC.freshLogin = true;
  await RC.auth.signInWithEmailAndPassword(rec.email, rcAuthPassword(password));
}

doLogin = function () {
  if (RC.loggingIn) return;
  var u = (document.getElementById('login-user').value || '').trim();
  var p = (document.getElementById('login-pass').value || '').trim();
  if (!u || !p) { rcLoginMsg('Enter username & password'); return; }
  var keep = document.getElementById('rc-keep');
  try { localStorage.setItem('repco_keep_signed_in', keep && keep.checked ? '1' : '0'); } catch (e) {}
  RC.loggingIn = true; rcLoginBusy(true); rcLoginMsg('');
  rcSignIn(u, p).catch(function (e) {
    RC.freshLogin = false;
    rcLoginMsg(rcErrMsg(e).replace(/^./, function (c) { return c.toUpperCase(); }));
    rcLoginBusy(false);
  }).finally(function () { RC.loggingIn = false; });
};
autoRestoreSession = function () { return true; };  // the Firebase login listener below restores sessions

async function rcStartSession(user) {
  var snap = await RC.db.ref('users/' + user.uid).once('value');
  var profile = snap.val();
  if (!profile) { await RC.auth.signOut(); rcShowLogin('This account has been disabled. Ask a manager for help.'); return; }
  rcSaveLegacyCopy();
  await rcLoadTeamContext(user.uid, profile);
  profile = rcEffProfile(user.uid, profile);
  RC.session = { uid: user.uid, profile: profile };
  rcStampLogin(user.uid, profile);
  RC.sessionStart = Date.now();
  safeSet('repco_username', profile.username);
  safeSet('repco_currentRole', String(profile.role || 'staff').toLowerCase());
  safeSetJSON('retail_roster_session_v1', { username: profile.username, firstName: profile.firstName || '', lastName: profile.lastName || '', role: profile.role });
  safeSet('repco_last_activity', String(Date.now()));
  try { lastActivityTs = Date.now(); } catch (e) {}
  rcLoginMsg('Loading roster...');
  rcAttach();
  var t0 = Date.now();
  while (!(RC.ready.users && RC.ready.retail_roster_byFortnight_v1) && Date.now() - t0 < 10000) await new Promise(function (r) { setTimeout(r, 100); });
  if (!RC.session) return;
  if (!RC.ready.retail_roster_byFortnight_v1) toast('Still connecting - showing what is available');
  rcLoginMsg('');
  rcLoginBusy(false);
  rcEnsureHeaderBits();
  var fns = rcAsArray(safeGetJSON('retail_roster_byFortnight_v1', []));
  if (fns.length) {
    var cur = getCurrentFortnight();
    if (cur) safeSet('retail_roster_currentFortnightId', cur.id);
  }
  enterApp(profile);
  if (!rcIsMgrRole(profile.role)) setTimeout(function () { openPage('mysched-page'); }, 0);
  var badge = document.getElementById('user-badge'); if (badge) badge.textContent = String(profile.username).toUpperCase() + ' • ' + String(profile.role || 'staff').toUpperCase() + (rcTeamIds().length > 1 ? ' • ' + rcTeamName(RC.team).toUpperCase() : '');
  rcSetStatus(RC.online === false ? 'offline' : 'live');
  rcRenderBell(); rcRenderOfferBanner();
  rcApplyMobile();
  toast('Welcome ' + (profile.firstName || profile.username));
  rcMaybeRegisterSW();
  setTimeout(function () { rcDeviceSetup(false); }, 1500);
}

if (RC.auth) RC.auth.onAuthStateChanged(function (user) {
  if (RC.bootstrapping) return;
  if (!user) { if (RC.session) { RC.session = null; rcDetach(); } rcShowLogin(document.getElementById('login-err') ? document.getElementById('login-err').textContent : ''); return; }
  if (RC.session && RC.session.uid === user.uid) return;
  if (!RC.freshLogin) {
    var last = parseInt(safeGet('repco_last_activity', '') || '0', 10);
    if (!staysSignedIn() && (!last || Date.now() - last > INACTIVITY_LIMIT_MS)) {
      rcClearLocal();
      if (last) rcAccessLog('Timed out (30 min idle)', user.uid).then(function () { RC.auth.signOut(); }); else RC.auth.signOut();
      rcShowLogin(last ? 'Session timed out after 30 minutes of inactivity. Please log in again.' : '');
      return;
    }
  }
  var sw = null; try { sw = sessionStorage.getItem('rc_switched'); sessionStorage.removeItem('rc_switched'); } catch (e) {}
  RC.startKind = RC.freshLogin ? 'Signed in' : sw ? 'Switched team' : 'Opened (still signed in)';
  RC.freshLogin = false;
  rcLoginBusy(true);
  rcStartSession(user).catch(function (e) { console.error('session', e); rcShowLogin('Could not load: ' + rcErrMsg(e)); RC.auth.signOut(); });
});

var _rcOrigLogout = doLogout;
doLogout = function () {
  try { _rcOrigLogout.apply(this, arguments); } catch (e) { console.error(e); }
  rcEndSession();
};
function rcEndSession() {
  var leaving = RC.session && RC.session.uid;
  var logged = leaving ? rcAccessLog('Signed out') : Promise.resolve();
  RC.session = null;
  rcDetach();
  rcClearLocal();
  if (!RC.auth || !RC.auth.currentUser) return;
  // Stop this phone getting the leaving person's alerts, then sign out
  var done = false, out = function () { if (done) return; done = true; if (RC.auth.currentUser) RC.auth.signOut(); };
  setTimeout(out, 2500);
  logged.then(function () { return rcThisDeviceSubId(); }).then(function (sid) { return sid && leaving ? RC.db.ref('push/' + leaving + '/' + sid).remove() : null; }).catch(function () {}).then(out);
}
function rcThisDeviceSubId() {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  return navigator.serviceWorker.getRegistration().then(function (reg) { return reg ? reg.pushManager.getSubscription() : null; }).then(function (sub) {
    if (!sub) return null;
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(sub.endpoint)).then(function (h) { return Array.prototype.map.call(new Uint8Array(h), function (x) { return x.toString(16).padStart(2, '0'); }).join('').slice(0, 32); });
  });
}
/* Nothing from the cloud stays on the device after logout */
function rcClearLocal() {
  RC_SYNC.forEach(function (s) { try { localStorage.removeItem(s.key); } catch (e) {} });
  ['retail_roster_users_v1', 'retail_roster_session_v1', 'retail_roster_backup_autosave_v1', 'repco_currentRole'].forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
}
function rcForceLogout(msg) { doLogout(); setTimeout(function () { rcLoginMsg(msg); }, 50); }

/* Lets managers confirm each person has logged in and set up their phone */
function rcDeviceKind() { var u = navigator.userAgent; return /android/i.test(u) ? 'Android' : rcIsIOS() ? 'iPhone' : /mobile/i.test(u) ? 'phone' : 'computer'; }
function rcStampLogin(uid, profile) {
  var p = 'users/' + uid + '/', upd = {}, now = firebase.database.ServerValue.TIMESTAMP;
  if (!profile.firstLoginTs) upd[p + 'firstLoginTs'] = now;
  upd[p + 'lastLoginTs'] = now;
  upd[p + 'lastDevice'] = rcDeviceKind();
  if (rcIsStandalone()) upd[p + 'appInstalled'] = true;
  RC.db.ref().update(upd).catch(function (e) { console.warn('login stamp', e); });
  rcAccessLog(RC.startKind || 'Opened');
}
/* Access log: every sign-in, app open, team switch and sign-out (masters can read it) */
function rcAccessLog(kind, uid) {
  if (!RC.db) return Promise.resolve();
  uid = uid || (RC.session && RC.session.uid); if (!uid) return Promise.resolve();
  var prof = (RC.session && RC.session.uid === uid && (RC.allUsers[uid] || RC.session.profile)) || {};
  var e = { uid: uid, ts: firebase.database.ServerValue.TIMESTAMP, kind: kind, device: rcDeviceKind() + (rcIsStandalone() ? ' (app)' : ' (browser)') };
  if (prof.username) e.username = prof.username;
  if (RC.team && RC.session) e.team = RC.team;
  return RC.db.ref('accesslog').push(e).then(function () {}, function (err) { console.warn('access log', err && err.code); });
}
function rcCanSeeAccessLog() {
  if (!RC.session) return false;
  var me = RC.allUsers[RC.session.uid] || {};
  return rcIsOwner();
}

/* Data the old version kept on this device, saved once so it can be imported later */
function rcSaveLegacyCopy() {
  try {
    if (localStorage.getItem('repco_legacy_device_copy_v1')) return;
    var fns = localStorage.getItem('retail_roster_byFortnight_v1');
    if (!fns || fns === '[]' || fns === 'null') return;
    var copy = { ts: Date.now() };
    ['retail_roster_byFortnight_v1', 'retail_roster_users_v1', 'retail_roster_requests_v2', 'retail_roster_hidden_v1', 'retail_roster_hidden_staff_v1', 'retail_roster_public_holidays_v1', 'retail_roster_hidden_shifts_v1', 'retail_roster_archive_v1', 'retail_roster_uploaded_excels_v1'].forEach(function (k) {
      var v = localStorage.getItem(k); if (v) { try { copy[k] = JSON.parse(v); } catch (e) {} }
    });
    localStorage.setItem('repco_legacy_device_copy_v1', JSON.stringify(copy));
  } catch (e) {}
}

/* First-time setup: creates the first admin account on an empty database */
function rcCheckSetup() {
  if (!RC.db) return;
  RC.db.ref('meta/setupDone').once('value').then(function (s) {
    RC.setupDone = s.val() === true;
    var box = document.getElementById('rc-setup');
    if (RC.setupDone) { if (box) box.remove(); return; }
    if (box) return;
    var form = document.querySelector('#login-page .login-form');
    if (!form) return;
    box = document.createElement('div');
    box.id = 'rc-setup';
    box.className = 'rc-setup';
    box.innerHTML = '<div class="rc-h">FIRST-TIME SETUP</div><div class="rc-small">No accounts exist yet. Create the master account (masters run every team and look after logins). After this, add everyone else from ACCOUNT MANAGEMENT, or import them from the old database.</div>'
      + '<input id="rc-su-user" placeholder="Admin username" autocomplete="off"><input id="rc-su-first" placeholder="First name"><input id="rc-su-last" placeholder="Last name">'
      + '<input id="rc-su-pass" type="password" placeholder="Password (min 6)"><input id="rc-su-pass2" type="password" placeholder="Confirm password">'
      + '<button type="button" onclick="rcBootstrap()">CREATE MASTER ACCOUNT</button><div id="rc-su-err" class="rc-err"></div>';
    form.appendChild(box);
  }).catch(function (e) {
    // Say why instead of silently showing nothing
    console.error('setup check', e);
    var msg = /permission/i.test(String(e && (e.code || e.message)))
      ? 'Database rules are not set up yet - paste database.rules.json into Firebase > Realtime Database > Rules and Publish (SETUP.md step 2).'
      : 'Cannot reach the database: ' + ((e && e.message) || e);
    rcLoginMsg(msg);
  });
}
async function rcBootstrap() {
  var u = document.getElementById('rc-su-user').value.trim(), p = document.getElementById('rc-su-pass').value, p2 = document.getElementById('rc-su-pass2').value;
  var first = document.getElementById('rc-su-first').value.trim(), last = document.getElementById('rc-su-last').value.trim();
  var err = document.getElementById('rc-su-err');
  if (!rcValidUsername(u)) { err.textContent = 'Username: 2-40 letters, numbers, dot, dash or underscore'; return; }
  if (p.length < 6) { err.textContent = 'Password must be at least 6 characters'; return; }
  if (p !== p2) { err.textContent = 'Passwords do not match'; return; }
  err.textContent = 'Creating...';
  RC.bootstrapping = true;
  try {
    var email = rcMakeEmail(u);
    var cred = await RC.auth.createUserWithEmailAndPassword(email, rcAuthPassword(p));
    var uid = cred.user.uid, upd = {};
    upd['users/' + uid] = { username: u, usernameLower: u.toLowerCase(), firstName: first, lastName: last, role: 'master', employmentType: 'fulltime', createdTs: Date.now() };
    upd['logins/' + rcLoginKey(u)] = { email: email, uid: uid };
    upd['meta/setupDone'] = true;
    await RC.db.ref().update(upd);
    RC.bootstrapping = false;
    safeSet('repco_last_activity', String(Date.now()));
    var box = document.getElementById('rc-setup'); if (box) box.remove();
    await rcStartSession(cred.user);
    setTimeout(function () { openPage('account-mgmt-page'); toast('Admin created. Next: import your old data below.'); }, 600);
  } catch (e) {
    RC.bootstrapping = false;
    err.textContent = 'Setup failed: ' + rcErrMsg(e);
    if (RC.auth.currentUser) RC.auth.signOut();
  }
}

/* ---------- creating and changing accounts (managers) ---------- */
var _rcSecondary = null;
function rcSecondaryAuth() {
  if (!_rcSecondary) {
    var app = firebase.apps.find(function (a) { return a.name === 'rc-secondary'; }) || firebase.initializeApp(RC_CONFIG, 'rc-secondary');
    _rcSecondary = app.auth();
    if (RC_EMULATOR) _rcSecondary.useEmulator('http://127.0.0.1:9099', { disableWarnings: true });
    _rcSecondary.setPersistence(firebase.auth.Auth.Persistence.NONE);
  }
  return _rcSecondary;
}
async function rcNewAuthAccount(username, password) {
  var email = rcMakeEmail(username);
  var sec = rcSecondaryAuth();
  var cred = await sec.createUserWithEmailAndPassword(email, rcAuthPassword(password));
  var uid = cred.user.uid;
  await sec.signOut();
  return { uid: uid, email: email };
}
async function rcCreateAccount(username, password, prof) {
  if (!rcValidUsername(username)) throw new Error('Username: 2-40 letters, numbers, dot, dash or underscore');
  var key = rcLoginKey(username);
  if ((await RC.db.ref('logins/' + key).once('value')).exists()) throw new Error('Username "' + username + '" already exists');
  var acc = await rcNewAuthAccount(username, password);
  var upd = {};
  upd['users/' + acc.uid] = { username: username, usernameLower: username.toLowerCase(), firstName: prof.firstName || '', lastName: prof.lastName || '', role: prof.role || 'staff', employmentType: prof.employmentType || 'casual', isHidden: !!prof.isHidden, createdTs: Date.now() };
  if (RC.team !== 'main') upd['users/' + acc.uid].team = RC.team;
  upd['logins/' + key] = { email: acc.email, uid: acc.uid };
  await RC.db.ref().update(upd);
  return acc.uid;
}
/* A forgotten password can't be changed without a paid server, so the person gets a fresh
   login account with the new password and their profile moves across to it. */
async function rcResetPassword(uid, newPassword) {
  var prof = RC.users[uid]; if (!prof) throw new Error('User not found');
  var acc = await rcNewAuthAccount(prof.username, newPassword);
  var upd = {};
  upd['users/' + acc.uid] = Object.assign({}, prof, { passwordResetTs: Date.now() });
  upd['users/' + uid] = null;
  upd['logins/' + rcLoginKey(prof.username)] = { email: acc.email, uid: acc.uid };
  Object.keys(RC.offers).forEach(function (oid) { if (RC.offers[oid].toUid === uid) upd[rcTP('offers/' + oid + '/toUid')] = acc.uid; });
  await RC.db.ref().update(upd);
  return acc.uid;
}

renderAccountMgmtPage = function () {
  var el = document.getElementById('account-mgmt-inner'); if (!el) return;
  var users = rcUserList().sort(function (a, b) { return String(a.username).localeCompare(String(b.username)); });
  var cur = getCurrentFortnight();
  var h = '<div class="card"><div class="rc-h">ALL USERS (' + users.length + ')</div>';
  h += users.map(function (u) {
    var linked = cur && rcStaffForUser(cur, u) !== -1;
    var when = function (t) { return new Date(t).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane', day: '2-digit', month: '2-digit', year: '2-digit', hour: 'numeric', minute: '2-digit' }); };
    var setup = u.firstLoginTs
      ? '<span class="am-ok">First login ' + rcEsc(when(u.firstLoginTs)) + '</span>' + (u.lastLoginTs ? ' • last seen ' + rcEsc(when(u.lastLoginTs)) + (u.lastDevice ? ' on ' + rcEsc(u.lastDevice) : '') : '')
        + ' • ' + (u.appInstalled ? '<span class="am-ok">app installed ✓</span>' : '<span class="am-no">app not installed</span>') + ' • ' + (u.pushOn ? '<span class="am-ok">alerts on ✓</span>' : '<span class="am-no">alerts off</span>')
      : '<span class="am-no">Never logged in</span>';
    return '<div class="rc-row"><div><b>' + rcEsc(u.username) + '</b> <span class="rc-pill">' + rcEsc(u.role) + '</span><br><span class="rc-small">' + rcEsc((u.firstName || '') + ' ' + (u.lastName || '')) + ' • ' + rcEsc(u.employmentType || '') + ' • ' + (linked ? '<span style="color:#1a7f37">on roster</span>' : '<span style="color:#E30613">no matching roster name</span>') + '</span><br><span class="rc-small">' + setup + '</span></div>'
      + '<div class="rc-btns"><button class="rc-b" onclick="rcEditUser(\'' + u.uid + '\')">EDIT</button><button class="rc-b" onclick="rcResetUserPassword(\'' + u.uid + '\')">RESET PASSWORD</button>' + (u.uid === RC.session.uid ? '' : '<button class="rc-b rc-red" onclick="rcDeleteUser(\'' + u.uid + '\')">DEL</button>') + '</div></div>';
  }).join('');
  h += '<div class="rc-h" style="margin-top:16px">ADD NEW USER</div><div class="rc-small">First and last name must match the roster so their shifts, offers and alerts reach them.</div>'
    + '<div class="rc-grid"><input id="new-user-name" placeholder="Username"><input id="new-user-pass" type="password" placeholder="Password (min 6)"><input id="new-user-first" placeholder="First name"><input id="new-user-last" placeholder="Last name (as on roster)">'
    + '<select id="new-user-role"><option value="staff">staff</option><option value="manager">manager</option><option value="admin">admin</option><option value="master">master</option></select>'
    + '<select id="new-user-type"><option value="casual">casual</option><option value="fulltime">full time</option></select></div>'
    + '<button class="rc-b rc-red rc-wide" onclick="adminAddUserMgmt()">ADD USER</button></div>';
  h += '<div class="card"><div class="rc-h">STAFF PASSWORDS</div><div class="rc-small">Sets every staff login (not admins or managers) to their first and last name in lowercase with no space, e.g. Michael EVANS becomes <b>michaelevans</b>.</div><button class="rc-b rc-red rc-wide" style="margin-top:8px" onclick="rcResetAllToFullName()">SET ALL STAFF PASSWORDS TO FULL NAME</button><div id="rc-bulk-log" class="rc-small" style="white-space:pre-line;margin-top:6px"></div></div>';
  h += rcMigrationCardHtml();
  h += '<div class="card"><div class="rc-h">DATA SAFETY</div><div class="rc-small">Downloads everything (rosters, requests, offers, users without passwords) as a backup file.</div><button class="rc-b rc-wide" onclick="rcDownloadBackup()">DOWNLOAD FULL BACKUP</button></div>';
  h += '<div class="card"><button onclick="showMain()" class="rc-b rc-wide">← BACK TO ROSTER</button></div>';
  el.innerHTML = h;
};
adminAddUserMgmt = function () {
  var un = document.getElementById('new-user-name').value.trim(), pw = document.getElementById('new-user-pass').value;
  var first = document.getElementById('new-user-first').value.trim(), last = document.getElementById('new-user-last').value.trim();
  var role = document.getElementById('new-user-role').value, type = document.getElementById('new-user-type').value;
  if (!un || !pw) { toast('Enter username & password'); return; }
  if (pw.length < 6) { toast('Password must be at least 6 characters'); return; }
  toast('Creating ' + un + '...');
  rcCreateAccount(un, pw, { firstName: first, lastName: last, role: role, employmentType: type })
    .then(function () { toast('Added ' + un); renderAccountMgmtPage(); })
    .catch(function (e) { toast('Could not add: ' + rcErrMsg(e)); });
};
adminEditUser = function () { toast('Use the EDIT button next to the user'); };
adminDelUser = function () { toast('Use the DEL button next to the user'); };
function rcEditUser(uid) {
  var u = RC.users[uid]; if (!u) return;
  var opt = function (v, l) { return '<option value="' + v + '"' + (String(u.role) === v || String(u.employmentType) === v ? ' selected' : '') + '>' + l + '</option>'; };
  showCustomPrompt('Edit ' + u.username, '<div class="rc-grid1"><label class="rc-small">Username</label><input id="rc-eu-name" value="' + rcEsc(u.username) + '"><label class="rc-small">First name</label><input id="rc-eu-first" value="' + rcEsc(u.firstName || '') + '"><label class="rc-small">Last name (as on roster)</label><input id="rc-eu-last" value="' + rcEsc(u.lastName || '') + '"><label class="rc-small">Role</label><select id="rc-eu-role">' + opt('staff', 'staff') + opt('manager', 'manager') + opt('admin', 'admin') + opt('master', 'master') + '</select><label class="rc-small">Employment</label><select id="rc-eu-type">' + opt('casual', 'casual') + opt('fulltime', 'full time') + '</select></div>', function (ok) {
    if (!ok) return;
    var name = document.getElementById('rc-eu-name').value.trim();
    var upd = {}, p = 'users/' + uid + '/';
    if (!rcValidUsername(name)) { toast('Invalid username'); return; }
    upd[p + 'firstName'] = document.getElementById('rc-eu-first').value.trim();
    upd[p + 'lastName'] = document.getElementById('rc-eu-last').value.trim();
    upd[p + 'role'] = document.getElementById('rc-eu-role').value;
    upd[p + 'employmentType'] = document.getElementById('rc-eu-type').value;
    var go = function () { RC.db.ref().update(upd).then(function () { toast('Saved ' + name); renderAccountMgmtPage(); }).catch(function (e) { toast('Not saved: ' + rcErrMsg(e)); }); };
    if (name.toLowerCase() !== u.usernameLower) {
      RC.db.ref('logins/' + rcLoginKey(name)).once('value').then(function (s) {
        if (s.exists()) { toast('Username taken'); return; }
        return RC.db.ref('logins/' + rcLoginKey(u.username)).once('value').then(function (old) {
          upd['logins/' + rcLoginKey(name)] = old.val();
          upd['logins/' + rcLoginKey(u.username)] = null;
          upd[p + 'username'] = name; upd[p + 'usernameLower'] = name.toLowerCase();
          go();
        });
      });
    } else { upd[p + 'username'] = name; go(); }
  });
}
function rcResetUserPassword(uid) {
  var u = RC.users[uid]; if (!u) return;
  showCustomPrompt('Reset password - ' + u.username, '<div class="rc-small">Sets a new password for ' + rcEsc(u.username) + '. Their old password stops working.</div><input id="rc-rp-pass" type="password" placeholder="New password (min 6)" style="margin-top:8px">', function (ok) {
    if (!ok) return;
    var pw = document.getElementById('rc-rp-pass').value;
    if (pw.length < 6) { toast('Password must be at least 6 characters'); return; }
    if (uid === RC.session.uid) { toast('Change your own password on the ACCOUNT page'); return; }
    rcResetPassword(uid, pw).then(function () { toast('Password reset for ' + u.username); renderAccountMgmtPage(); }).catch(function (e) { toast('Reset failed: ' + rcErrMsg(e)); });
  });
}
function rcFullNamePassword(u) { return (String(u.firstName || '') + String(u.lastName || '')).toLowerCase().replace(/\s+/g, ''); }
function rcResetAllToFullName() {
  var staff = rcUserList().filter(function (u) { return !rcIsMgrRole(u.role) && u.uid !== RC.session.uid; });
  showCustomConfirm('Set ' + staff.length + ' staff passwords?', 'Each staff member\'s password becomes their first + last name in lowercase (e.g. <b>michaelevans</b>). Their current password stops working.<br><br><b style="color:#E30613">Anyone who knows a colleague\'s name could then log in as them.</b> Ask staff to change it on the ACCOUNT page.', async function (ok) {
    if (!ok) return;
    var log = document.getElementById('rc-bulk-log'), say = function (t) { if (log) log.textContent += t + '\n'; };
    if (log) log.textContent = '';
    var done = 0, skipped = 0;
    for (var i = 0; i < staff.length; i++) {
      var u = staff[i], pw = rcFullNamePassword(u);
      if (!u.firstName || !u.lastName || pw.length < 6) { say('✗ ' + u.username + ': name missing or too short - set by hand'); skipped++; continue; }
      try { await rcResetPassword(u.uid, pw); say('✓ ' + u.username + ' → ' + pw); done++; }
      catch (e) { say('✗ ' + u.username + ': ' + rcErrMsg(e)); skipped++; }
    }
    say('Done: ' + done + ' changed, ' + skipped + ' skipped.');
    toast(done + ' staff passwords set');
  });
}
function rcDeleteUser(uid) {
  var u = RC.users[uid]; if (!u) return;
  showCustomConfirm('Delete user?', rcEsc(u.username) + ' will no longer be able to log in.', function (ok) {
    if (!ok) return;
    var upd = {}; upd['users/' + uid] = null; upd['logins/' + rcLoginKey(u.username)] = null;
    RC.db.ref().update(upd).then(function () { toast('Deleted ' + u.username); renderAccountMgmtPage(); }).catch(function (e) { toast('Not deleted: ' + rcErrMsg(e)); });
  });
}

/* Hidden staff page creates real logins too */
addHiddenStaff = (function (orig) {
  return function () {
    var user = (document.getElementById('hs-user').value || '').trim(), pass = (document.getElementById('hs-pass').value || '').trim();
    var first = (document.getElementById('hs-first').value || '').trim(), last = (document.getElementById('hs-last').value || '').trim();
    var type = document.getElementById('hs-type').value || 'casual';
    if (!first || !last || !user || !pass) { toast('Fill first, last, username, password'); return; }
    if (pass.length < 6) { toast('Password must be at least 6 characters'); return; }
    orig.apply(this, arguments);
    rcCreateAccount(user, pass, { firstName: first, lastName: last, role: 'staff', employmentType: type, isHidden: true })
      .then(function () { toast('Login created for ' + user); })
      .catch(function (e) { toast('Login not created: ' + rcErrMsg(e)); });
  };
})(addHiddenStaff);
deleteHiddenStaff = (function (orig) {
  return function (name) {
    var u = rcUserList().find(function (x) { return (String(x.firstName) + ' ' + String(x.lastName)).toLowerCase() === String(name).toLowerCase(); });
    orig.apply(this, arguments);
    if (u && u.isHidden) { var upd = {}; upd['users/' + u.uid] = null; upd['logins/' + rcLoginKey(u.username)] = null; RC.db.ref().update(upd).catch(function () {}); }
  };
})(deleteHiddenStaff);

/* Hidden Staff page: current shifts from the roster, edit in place, delete */
renderHiddenStaffPage = (function (orig) {
  return function () {
    try { orig.apply(this, arguments); } catch (e) { console.error(e); }
    var list = document.getElementById('hs-list'); if (!list) return;
    var fn = getSelectedFortnight() || getCurrentFortnight();
    var rows = fn ? (fn.staff || []).map(function (st, i) { return { st: st, i: i }; }).filter(function (x) { return isHiddenStaffRow(x.st); }) : [];
    if (!rows.length) { list.innerHTML = '<div class="card">No hidden staff yet.</div>'; return; }
    list.innerHTML = '<div class="card"><div class="rc-h">HIDDEN STAFF' + (fn ? ' • ' + rcEsc(rcFnRange(fn)) : '') + '</div>' + rows.map(function (x) {
      var st = x.st, u = rcUserForStaff(st), name = st.firstName + ' ' + st.lastName, key = rcEsc(name).replace(/'/g, '');
      var hrs = 0, chips = fn.dates.map(function (d, i) { var sh = st.shifts[i]; var on = parseShiftRange(sh); if (on) hrs += netH(sh); return '<span class="hs-chip' + (on ? ' on' : '') + '"><b>' + rcEsc(d.day.slice(0, 2)) + ' ' + rcEsc(d.date.slice(0, 2)) + '</b>' + (on ? rcEsc(fmt(sh)) : rcIsUAVal(sh) ? 'UA' : rcIsAbsentVal(sh) ? 'AB' : '-') + '</span>'; }).join('');
      return '<div class="hs-person" id="hs-p-' + x.i + '"><div class="rc-row" style="border:none;padding:0"><div><b>' + rcEsc(String(st.lastName).toUpperCase() + ', ' + st.firstName) + '</b> <span class="rc-pill">' + rcEsc(st.employmentType || 'casual') + '</span><br><span class="rc-small">' + (u ? 'Login: ' + rcEsc(u.username) : 'No login') + ' • ' + hrs.toFixed(1) + 'h this fortnight</span></div>'
        + '<div class="rc-btns"><button class="rc-b" onclick="rcHiddenEditShifts(' + x.i + ')">EDIT SHIFTS</button><button class="rc-b rc-white" onclick="rcHiddenEditDetails(' + x.i + ')">EDIT</button><button class="rc-b rc-red" onclick="deleteHiddenStaff(\'' + key + '\')">DELETE</button></div></div>'
        + '<div class="hs-chips">' + chips + '</div><div class="hs-edit" id="hs-e-' + x.i + '"></div></div>';
    }).join('') + '</div>';
  };
})(renderHiddenStaffPage);
function rcHiddenEditShifts(rowIdx) {
  showMain();
  setTimeout(function () {
    var td = document.querySelector('#roster-mount .hidden-sec td[data-r="' + rowIdx + '"][data-i="0"]');
    if (!td) { toast('Their row is in the last table on the roster'); return; }
    td.scrollIntoView({ block: 'center', inline: 'nearest' });
    editCell(td, rowIdx, 0);
    toast('Type a shift and press Tab to move along the days');
  }, 300);
}
function rcHiddenEditDetails(rowIdx) {
  var fn = getSelectedFortnight() || getCurrentFortnight(); var st = fn && fn.staff[rowIdx]; if (!st) return;
  var box = document.getElementById('hs-e-' + rowIdx); if (!box) return;
  if (box.innerHTML) { box.innerHTML = ''; return; }
  box.innerHTML = '<div class="rc-grid"><input id="hse-f" value="' + rcEsc(st.firstName) + '" placeholder="First name"><input id="hse-l" value="' + rcEsc(st.lastName) + '" placeholder="Last name"><select id="hse-t"><option value="casual"' + (st.employmentType === 'casual' ? ' selected' : '') + '>casual</option><option value="fulltime"' + (st.employmentType !== 'casual' ? ' selected' : '') + '>full time</option></select></div>'
    + '<div class="rc-btns"><button class="rc-b" onclick="rcHiddenSaveDetails(' + rowIdx + ')">SAVE</button><button class="rc-b rc-white" onclick="document.getElementById(\'hs-e-' + rowIdx + '\').innerHTML=\'\'">CANCEL</button></div>';
}
function rcHiddenSaveDetails(rowIdx) {
  var cur = getSelectedFortnight() || getCurrentFortnight(); var st0 = cur && cur.staff[rowIdx]; if (!st0) return;
  var f = document.getElementById('hse-f').value.trim(), l = document.getElementById('hse-l').value.trim(), t = document.getElementById('hse-t').value;
  if (!f || !l) { toast('First and last name are needed'); return; }
  var oldName = (st0.firstName + ' ' + st0.lastName).toLowerCase(), u = rcUserForStaff(st0);
  var fns = rcAsArray(safeGetJSON('retail_roster_byFortnight_v1', []));
  fns.forEach(function (fn) { (fn.staff || []).forEach(function (st) { if ((st.firstName + ' ' + st.lastName).toLowerCase() === oldName) { st.firstName = f; st.lastName = l; st.employmentType = t; st.isHidden = true; } }); fn.staff.sort(rcStaffSort); });
  var hid = rcAsArray(safeGetJSON('retail_roster_hidden_v1', [])).map(function (n) { return String(n).toLowerCase() === oldName ? f + ' ' + l : n; });
  safeSetJSON('retail_roster_hidden_v1', hid);
  safeSetJSON('retail_roster_byFortnight_v1', fns);
  if (u) { var upd = {}; upd['users/' + u.uid + '/firstName'] = f; upd['users/' + u.uid + '/lastName'] = l; upd['users/' + u.uid + '/employmentType'] = t; RC.db.ref().update(upd).catch(function () {}); }
  toast('Saved'); renderHiddenStaffPage();
}

/* Own account page */
renderAccountPage = function () {
  var target = document.getElementById('account-list'); var inner = document.getElementById('account-inner');
  if (inner) inner.innerHTML = '';
  if (!target || !RC.session) return;
  var p = RC.session.profile;
  target.innerHTML = '<div class="card"><div class="rc-h">ACCOUNT - ' + rcEsc((p.firstName || '') + ' ' + (p.lastName || '')) + '</div>'
    + '<div class="rc-small"><b>Username:</b> ' + rcEsc(p.username) + ' • <b>Role:</b> ' + rcEsc(p.role) + '</div>'
    + '<div class="rc-grid1" style="margin-top:10px"><label class="rc-small">NEW USERNAME</label><input id="new-username" value="' + rcEsc(p.username) + '">'
    + '<label class="rc-small">CURRENT PASSWORD (needed to change password)</label><input id="cur-pass" type="password">'
    + '<label class="rc-small">NEW PASSWORD (min 6, leave blank to keep)</label><input id="new-pass" type="password"></div>'
    + '<button onclick="changePassword()" class="rc-b rc-wide" style="margin-top:10px">SAVE CHANGES</button></div>'
    + '<div class="card"><button onclick="showMain()" class="rc-b rc-wide">BACK TO ROSTER</button></div>';
};
changePassword = async function () {
  var p = RC.session && RC.session.profile; if (!p) return;
  var newU = (document.getElementById('new-username').value || '').trim();
  var cur = document.getElementById('cur-pass').value, np = document.getElementById('new-pass').value;
  try {
    if (np) {
      if (np.length < 6) { toast('New password must be at least 6 characters'); return; }
      if (!cur) { toast('Enter your current password'); return; }
      var user = RC.auth.currentUser;
      await user.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(user.email, rcAuthPassword(cur)));
      await user.updatePassword(rcAuthPassword(np));
    }
    if (newU && newU.toLowerCase() !== p.usernameLower) {
      if (!rcValidUsername(newU)) { toast('Username: 2-40 letters, numbers, dot, dash or underscore'); return; }
      if ((await RC.db.ref('logins/' + rcLoginKey(newU)).once('value')).exists()) { toast('Username taken'); return; }
      var old = (await RC.db.ref('logins/' + rcLoginKey(p.username)).once('value')).val();
      var upd = {};
      upd['logins/' + rcLoginKey(newU)] = { email: old.email, uid: RC.session.uid };
      upd['logins/' + rcLoginKey(p.username)] = null;
      upd['users/' + RC.session.uid + '/username'] = newU;
      upd['users/' + RC.session.uid + '/usernameLower'] = newU.toLowerCase();
      await RC.db.ref().update(upd);
    } else if (newU && newU !== p.username) {
      await RC.db.ref('users/' + RC.session.uid + '/username').set(newU);
    }
    toast('Saved');
    setTimeout(renderAccountPage, 400);
  } catch (e) { toast('Not saved: ' + rcErrMsg(e)); }
};

/* ---------- requests: stable ids, correct staff matching, decisions are kept ---------- */
function rcFindReq(id) { var all = rcAsArray(safeGetJSON('retail_roster_requests_v2', [])); return { all: all, idx: all.findIndex(function (r) { return rcReqId(r) === id; }) }; }
function rcStaffIndexForUsername(fn, username) {
  var u = rcUserByUsername(username);
  var i = u ? rcStaffForUser(fn, u) : -1;
  if (i !== -1) return i;
  try { var m = mapUsernameToStaffKey(username); if (m) i = (fn.staff || []).findIndex(function (s) { return String(s.firstName).toLowerCase() === String(m.firstName).toLowerCase() && (!m.lastName || String(s.lastName).toLowerCase() === String(m.lastName).toLowerCase()); }); } catch (e) {}
  return i;
}
function rcDateKey(s) { return String(s || '').split(' ')[0].trim(); }
/* UA = unavailable (approved time off); AB = absent. Both keep the uploaded shift as the original */
function rcMarkUnavailable(st, i) {
  if (!st.originalShifts) st.originalShifts = {};
  if (!st.absentApproved) st.absentApproved = {};
  if (!st.unavailable) st.unavailable = [];
  if (st.originalShifts[i] == null && !rcIsUAVal(st.shifts[i]) && !rcIsAbsentVal(st.shifts[i])) st.originalShifts[i] = st.shifts[i];
  st.unavailable[i] = true;
  st.absentApproved[i] = false;
  st.shifts[i] = 'UA';
}
function rcMarkAbsent(st, i) {
  if (!st.originalShifts) st.originalShifts = {};
  if (!st.absentApproved) st.absentApproved = {};
  if (st.originalShifts[i] == null && !rcIsUAVal(st.shifts[i]) && !rcIsAbsentVal(st.shifts[i])) st.originalShifts[i] = st.shifts[i];
  if (st.unavailable) st.unavailable[i] = false;
  st.absentApproved[i] = true;
  st.shifts[i] = 'AB';
}
function rcIsUAVal(v) { return /^(UA|NA)$/i.test(String(v === undefined || v === null ? '' : v).trim()); }
/* Hidden staff aren't in the Excel files, so a newly uploaded fortnight gets their rows (empty) */
function rcEnsureHiddenRows() {
  if (!rcIsMgr()) return;
  var fns = rcAsArray(safeGetJSON('retail_roster_byFortnight_v1', [])), people = {}, changed = false;
  var nameOf = function (s) { return (String(s.firstName || '') + ' ' + String(s.lastName || '')).trim().toLowerCase(); };
  fns.forEach(function (fn) { (fn.staff || []).forEach(function (st) { if (isHiddenStaffRow(st)) people[nameOf(st)] = st; }); });
  fns.forEach(function (fn) {
    Object.keys(people).forEach(function (n) {
      if ((fn.staff || []).some(function (st) { return nameOf(st) === n; })) return;
      var p = people[n], len = fn.dates.length;
      fn.staff.push({ firstName: p.firstName, lastName: p.lastName, role: 'staff', employmentType: p.employmentType || 'casual', shifts: Array(len).fill('OFF'), originalShifts: {}, absentApproved: {}, cellGreen: {}, unavailable: Array(len).fill(false), isHidden: true });
      changed = true;
    });
  });
  if (changed) safeSetJSON('retail_roster_byFortnight_v1', fns);
}

/* Approved unavailability also applies to rosters uploaded after the approval */
function rcApplyApprovedUnavailability() {
  if (!rcIsMgr()) return;
  var reqs = rcAsArray(safeGetJSON('retail_roster_requests_v2', [])).filter(function (r) { return r.type === 'unavailability' && r.status === 'approved'; });
  if (!reqs.length) return;
  var fns = rcAsArray(safeGetJSON('retail_roster_byFortnight_v1', [])), changed = false;
  reqs.forEach(function (r) {
    var applied = r.appliedFns || {};
    fns.forEach(function (fn) {
      if (applied[fn.id]) return;
      var si = rcStaffIndexForUsername(fn, r.username); if (si === -1) return;
      var st = fn.staff[si];
      rcAsArray(r.dates).forEach(function (d) {
        var di = fn.dates.findIndex(function (x) { return x.date === rcDateKey(d); });
        if (di !== -1 && !rcIsUAVal(st.shifts[di]) && !(st.unavailable && st.unavailable[di])) { rcMarkUnavailable(st, di); changed = true; }
      });
    });
  });
  if (changed) { safeSetJSON('retail_roster_byFortnight_v1', fns); toast('Approved unavailability applied to the new roster'); }
}
/* Roster saves made on behalf of a request decision don't send a separate "shifts changed" alert */
function rcQuietFor(username, fn) {
  var u = rcUserByUsername(username), q = {};
  if (u) q[u.uid] = 1;
  RC.quietUids = q;
  try { fn(); } finally { RC.quietUids = null; }
}
function rcDecide(id, approve) {
  var f = rcFindReq(id); if (f.idx === -1) { toast('Request no longer exists'); return; }
  var req = f.all[f.idx];
  if (req.status !== 'pending') { toast('Already ' + req.status); return; }
  if (approve) {
    var fns = rcAsArray(safeGetJSON('retail_roster_byFortnight_v1', [])), hit = 0, applied = {}, affected = [];
    fns.forEach(function (fn) {
      var si = rcStaffIndexForUsername(fn, req.username); if (si === -1) return;
      var st = fn.staff[si];
      if (req.type === 'unavailability') {
        rcAsArray(req.dates).forEach(function (d) {
          var di = fn.dates.findIndex(function (x) { return x.date === rcDateKey(d); }); if (di === -1) return;
          var was = st.shifts[di];
          if (!rcIsEmptyVal(was) && !rcIsAbsentVal(was) && !rcIsUAVal(was) && !(fn.dates[di].iso < getISO())) affected.push(fn.dates[di].day + ' ' + fn.dates[di].date + ' - ' + was);
          rcMarkUnavailable(st, di); hit++;
        });
        applied[fn.id] = true;
      } else if (req.type === 'shift-correction') {
        if (req.fnId && fn.id !== req.fnId) return;
        var di = fn.dates.findIndex(function (x) { return x.date === req.shiftDate; });
        if (di === -1) return;
        affected.push(fn.dates[di].day + ' ' + fn.dates[di].date + ': ' + req.newShift);
        if (String(req.newShift).toUpperCase() === 'AB') rcMarkAbsent(st, di);
        else if (rcIsUAVal(req.newShift)) rcMarkUnavailable(st, di);
        else { if (!st.originalShifts) st.originalShifts = {}; if (!st.absentApproved) st.absentApproved = {}; if (st.originalShifts[di] == null && !rcIsUAVal(st.shifts[di]) && !rcIsAbsentVal(st.shifts[di])) st.originalShifts[di] = st.shifts[di]; st.shifts[di] = rcIsEmptyVal(req.newShift) ? 'OFF' : req.newShift; st.absentApproved[di] = false; if (st.unavailable) st.unavailable[di] = false; }
        hit++;
      }
    });
    if (!hit && req.type === 'shift-correction') { toast('Could not find ' + req.username + ' on the roster for ' + req.shiftDate + ' - check their first/last name in Account Management'); return; }
    rcQuietFor(req.username, function () { safeSetJSON('retail_roster_byFortnight_v1', fns); });
    req.appliedFns = applied;
    req.affected = affected;
  }
  req.status = approve ? 'approved' : 'denied';
  req.decidedBy = RC.session.profile.username;
  req.decidedTs = Date.now();
  safeSetJSON('retail_roster_requests_v2', f.all);
  toast((approve ? 'Approved' : 'Denied') + ' - ' + req.username + ' notified');
  renderRequests(); renderRosterSafe();
}
approveReq = function (i) { var r = rcAsArray(safeGetJSON('retail_roster_requests_v2', []))[i]; if (r) rcDecide(rcReqId(r), true); };
denyReq = function (i) { var r = rcAsArray(safeGetJSON('retail_roster_requests_v2', []))[i]; if (r) rcDecide(rcReqId(r), false); };
/* Undo an approval: the affected cells go back to their uploaded (original) shifts */
function rcReverseReq(id) {
  var f = rcFindReq(id); if (f.idx === -1) return;
  var req = f.all[f.idx];
  showCustomConfirm('Reverse this approval?', rcEsc(req.username) + ' - ' + rcEsc(rcReqSummary(req)) + '<br><br>The roster goes back to the uploaded shifts for those days.', function (ok) {
    if (!ok) return;
    var fns = rcAsArray(safeGetJSON('retail_roster_byFortnight_v1', [])), n = 0, back = [];
    fns.forEach(function (fn) {
      var si = rcStaffIndexForUsername(fn, req.username); if (si === -1) return;
      var st = fn.staff[si];
      var days = req.type === 'unavailability' ? rcAsArray(req.dates).map(rcDateKey) : [req.shiftDate];
      days.forEach(function (dk) {
        var di = fn.dates.findIndex(function (x) { return x.date === dk; }); if (di === -1) return;
        var marked = (st.unavailable && st.unavailable[di]) || rcIsUAVal(st.shifts[di]) || (st.absentApproved && st.absentApproved[di]);
        if (req.type === 'unavailability' && !marked) return;
        if (st.originalShifts && st.originalShifts[di] != null) { st.shifts[di] = st.originalShifts[di]; delete st.originalShifts[di]; }
        else if (rcIsUAVal(st.shifts[di]) || rcIsAbsentVal(st.shifts[di])) st.shifts[di] = 'OFF';
        if (st.absentApproved) st.absentApproved[di] = false;
        if (st.unavailable) st.unavailable[di] = false;
        if (!rcIsEmptyVal(st.shifts[di]) && !(fn.dates[di].iso < getISO())) back.push(fn.dates[di].day + ' ' + fn.dates[di].date + ' - ' + st.shifts[di]);
        n++;
      });
    });
    rcQuietFor(req.username, function () { safeSetJSON('retail_roster_byFortnight_v1', fns); });
    var g = rcFindReq(id); if (g.idx !== -1) { g.all[g.idx].affected = back; g.all[g.idx].status = 'reversed'; g.all[g.idx].decidedBy = RC.session.profile.username; g.all[g.idx].decidedTs = Date.now(); safeSetJSON('retail_roster_requests_v2', g.all); }
    toast('Reversed - ' + n + ' day(s) back to the uploaded roster');
    renderRequests(); renderRosterSafe();
  });
}
function rcDeleteReq(id) {
  showCustomConfirm('Delete this request?', '', function (ok) {
    if (!ok) return;
    var f = rcFindReq(id); if (f.idx === -1) return;
    f.all.splice(f.idx, 1); safeSetJSON('retail_roster_requests_v2', f.all); toast('Deleted'); renderRequests();
  });
}
var _rcOrigRenderRequests = renderRequests;
renderRequests = function () {
  if (!rcIsMgr()) { rcRenderTimeOffForm(); return; }
  if (rcIsAdminOnly()) { rcRenderAdminRequestForm(); return; }
  var el = document.getElementById('requests-list'); if (!el) return;
  var reqs = rcAsArray(safeGetJSON('retail_roster_requests_v2', []));
  var pending = reqs.filter(function (r) { return !r.status || r.status === 'pending'; });
  var done = reqs.filter(function (r) { return r.status && r.status !== 'pending'; }).sort(function (a, b) { return (b.decidedTs || b.ts || 0) - (a.decidedTs || a.ts || 0); }).slice(0, 30);
  var card = function (r, actions) {
    var id = rcReqId(r);
    return '<div class="card"><div style="font-weight:900;font-size:12px">' + rcEsc(r.username) + ' <span class="rc-pill">' + rcEsc(r.type) + '</span> <span class="rc-pill rc-st-' + rcEsc(r.status || 'pending') + '">' + rcEsc(r.status || 'pending') + '</span></div>'
      + '<div class="rc-small">' + rcEsc(rcReqSummary(r)) + '</div><div class="rc-small">Sent ' + new Date(r.ts || 0).toLocaleString() + (r.decidedBy ? ' • ' + rcEsc(r.status) + ' by ' + rcEsc(r.decidedBy) : '') + '</div>'
      + (actions ? '<div class="rc-btns" style="margin-top:6px"><button class="rc-b" onclick="rcDecide(\'' + id + '\',true)">APPROVE</button><button class="rc-b rc-white" onclick="rcDecide(\'' + id + '\',false)">DENY</button></div>'
        : '<div class="rc-btns" style="margin-top:6px">' + (r.status === 'approved' ? '<button class="rc-b rc-red" onclick="rcReverseReq(\'' + id + '\')">REVERSE</button>' : '') + '<button class="rc-b rc-white" onclick="rcDeleteReq(\'' + id + '\')">REMOVE FROM LIST</button></div>') + '</div>';
  };
  el.innerHTML = '<div class="rc-h" style="margin:4px 0 8px">PENDING (' + pending.length + ')</div>' + (pending.length ? pending.map(function (r) { return card(r, true); }).join('') : '<div class="card">No pending requests</div>')
    + (done.length ? '<div class="rc-row" style="border:none;margin:14px 0 8px"><div class="rc-h">RECENT DECISIONS</div><button class="rc-b rc-white" onclick="rcClearDecided()">CLEAR DECIDED</button></div>' + done.map(function (r) { return card(r, false); }).join('') : '')
    + '<div class="card"><button onclick="showMain()" class="rc-b rc-wide">← BACK</button></div>';
};
/* A request date ('2026-10-31' or '31/10') as an ISO date, or '' if unknown */
function rcDateIso(d) {
  d = rcDateKey(d);
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  var m = d.match(/^(\d{1,2})\/(\d{1,2})$/); if (!m) return '';
  var t = getISO(), y = +t.slice(0, 4), mo = +m[2], now = +t.slice(5, 7);
  if (mo - now > 6) y--; else if (now - mo > 6) y++;   // dates have no year: pick the nearest one
  return y + '-' + String(mo).padStart(2, '0') + '-' + m[1].padStart(2, '0');
}
function rcClearDecided() {
  showCustomConfirm('Clear decided requests?', 'Removes denied and reversed requests, and approved ones whose dates have passed. Approved time off that is still to come stays, so it keeps applying to new rosters.', function (ok) {
    if (!ok) return;
    var today = getISO();
    var future = function (r) { return r.status === 'approved' && r.type === 'unavailability' && rcAsArray(r.dates).some(function (d) { var k = rcDateIso(d); return !k || k >= today; }); };
    var all = rcAsArray(safeGetJSON('retail_roster_requests_v2', [])).filter(function (r) { return !r.status || r.status === 'pending' || future(r); });
    safeSetJSON('retail_roster_requests_v2', all); toast('Cleared'); renderRequests();
  });
}
/* Staff: one simple time-off form (shift changes are made from My Schedule) */
function rcRenderTimeOffForm() {
  var el = document.getElementById('requests-list'); if (!el) return;
  var tomorrow = new Date(new Date(getISO() + 'T00:00:00').getTime() + 86400000);
  var iso = function (d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  el.innerHTML = '<div class="card"><div class="rc-h">REQUEST TIME OFF</div>'
    + '<div class="ms-edit-row" style="margin-top:6px"><label class="rc-to">First day<input type="date" id="to-from" min="' + getISO() + '" value="' + iso(tomorrow) + '"></label><label class="rc-to">Last day <span style="font-weight:400">(blank = one day)</span><input type="date" id="to-to" min="' + getISO() + '"></label></div>'
    + '<input id="to-reason" class="rc-to-in" placeholder="Reason (optional)">'
    + '<button class="rc-b rc-red rc-wide" style="margin-top:10px" onclick="rcSubmitTimeOff()">SEND REQUEST</button>'
    + '<div class="rc-small" style="margin-top:8px">Need to change one shift instead? <a href="#" onclick="openPage(\'mysched-page\');return false">Tap it on My Schedule</a>.</div></div>'
    + '<div id="rc-my-reqs"></div>'
    + '<div class="card"><button onclick="showMain()" class="rc-b rc-wide">← BACK</button></div>';
  rcRenderMyRequestsList();
}
function rcSubmitTimeOff() {
  var from = (document.getElementById('to-from') || {}).value, to = (document.getElementById('to-to') || {}).value || from;
  var reason = ((document.getElementById('to-reason') || {}).value || '').trim();
  if (!from) { toast('Choose the first day'); return; }
  if (to < from) { toast('The last day is before the first day'); return; }
  if (from < getISO()) { toast('Choose today or a later day'); return; }
  var dates = expandDateRange(from, to);
  if (!dates.length) { toast('Choose the dates'); return; }
  if (dates.length > 60) { toast('That is more than 60 days - please split it up'); return; }
  var all = rcAsArray(safeGetJSON('retail_roster_requests_v2', []));
  all.push({ username: RC.session.profile.username, type: 'unavailability', dates: dates, reason: reason, status: 'pending', ts: Date.now() });
  safeSetJSON('retail_roster_requests_v2', all);
  toast('Time-off request sent');
  rcRenderTimeOffForm();
}

/* Staff: replace the "my requests" box with one that shows live status and can withdraw pending ones */
function rcHideMyReqs() {
  var hidden = {}; try { hidden = JSON.parse(localStorage.getItem('repco_hidden_reqs') || '{}'); } catch (e) {}
  rcAsArray(safeGetJSON('retail_roster_requests_v2', [])).forEach(function (r) { if (r.status && r.status !== 'pending') hidden[rcReqId(r)] = 1; });
  try { localStorage.setItem('repco_hidden_reqs', JSON.stringify(hidden)); } catch (e) {}
  rcRenderMyRequestsList();
}
function rcRenderMyRequestsList() {
  var el = document.getElementById('requests-list'); if (!el || !RC.session) return;
  var box = document.getElementById('rc-my-reqs');
  if (!box) {
    Array.prototype.forEach.call(el.querySelectorAll('.card'), function (c) { if (/MY REQUESTS/.test(c.textContent)) c.remove(); });
    box = document.createElement('div'); box.id = 'rc-my-reqs';
    var back = el.lastElementChild; el.insertBefore(box, back);
  }
  var me = RC.session.profile.usernameLower;
  var hidden = {}; try { hidden = JSON.parse(localStorage.getItem('repco_hidden_reqs') || '{}'); } catch (e) {}
  var mine = rcAsArray(safeGetJSON('retail_roster_requests_v2', [])).filter(function (r) { return String(r.username || '').toLowerCase() === me && !hidden[rcReqId(r)]; }).sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
  var decided = mine.filter(function (r) { return r.status && r.status !== 'pending'; });
  box.innerHTML = mine.length ? '<div class="card"><div class="rc-row" style="border:none"><div class="rc-h">MY REQUESTS (' + mine.length + ')</div>' + (decided.length ? '<button class="rc-b rc-white" onclick="rcHideMyReqs()">HIDE DECIDED</button>' : '') + '</div>' + mine.map(function (r) {
    var st = r.status || 'pending';
    return '<div class="rc-row"><div><span class="rc-pill rc-st-' + rcEsc(st) + '">' + rcEsc(st) + '</span> <span class="rc-small">' + rcEsc(rcReqSummary(r)) + '</span></div>' + (st === 'pending' ? '<button class="rc-b rc-white" onclick="rcDeleteReq(\'' + rcReqId(r) + '\')">WITHDRAW</button>' : '') + '</div>';
  }).join('') + '</div>' : '';
}
/* The correction form's button called a function that never existed, so corrections could not be sent */
submitShiftCorrection = function () {
  var idxStr = (document.getElementById('corr-shift-idx') || {}).value;
  var start = (document.getElementById('corr-start') || {}).value, end = (document.getElementById('corr-end') || {}).value;
  var special = (document.getElementById('corr-special') || {}).value, reason = ((document.getElementById('corr-reason') || {}).value || '').trim();
  if (idxStr === '' || idxStr === undefined) { toast('Select a shift'); return; }
  var newShift = special || (start && end ? start + '-' + end : '');
  if (!newShift) { toast('Enter the new start and end times, or choose OFF / NA / AB'); return; }
  var cur = getSelectedFortnight() || getCurrentFortnight();
  var me = cur && findMyStaff(cur);
  if (!me) { toast('Your account is not linked to a roster row'); return; }
  var i = parseInt(idxStr, 10);
  var all = rcAsArray(safeGetJSON('retail_roster_requests_v2', []));
  all.push({ username: RC.session.profile.username, type: 'shift-correction', fnId: cur.id, shiftDate: cur.dates[i].date, shiftIdx: i, oldShift: me.shifts[i] || 'OFF', newShift: newShift, reason: reason, status: 'pending', ts: Date.now(), dates: [cur.dates[i].date] });
  safeSetJSON('retail_roster_requests_v2', all);
  toast('Correction sent to managers');
  renderRequests();
};
var submitCorrection = submitShiftCorrection;

submitUnavail = (function (orig) { return function () { orig.apply(this, arguments); setTimeout(rcRenderMyRequestsList, 50); }; })(submitUnavail);

/* Unavailable page: absences on the current roster plus approved upcoming unavailability */
/* STAFF UNAVAILABLE: time-off requests and days marked UA (absences are a separate thing) */
renderUnavail = function () {
  var el = document.getElementById('unavail-list'); if (!el) return;
  var reqs = rcAsArray(safeGetJSON('retail_roster_requests_v2', [])).filter(function (r) { return r.type === 'unavailability'; });
  var pend = reqs.filter(function (r) { return !r.status || r.status === 'pending'; });
  var today = getISO();
  // requests store dd/mm without a year: use the year that puts the last day nearest to today
  var upcoming = function (r) {
    var d = rcAsArray(r.dates), m = String(d[d.length - 1] || '').match(/^(\d{1,2})\/(\d{1,2})/); if (!m) return true;
    var now = new Date(today + 'T00:00:00'), best = null;
    [-1, 0, 1].forEach(function (k) { var t = new Date(now.getFullYear() + k, +m[2] - 1, +m[1]); if (best === null || Math.abs(t - now) < Math.abs(best - now)) best = t; });
    return best >= now;
  };
  var appr = reqs.filter(function (r) { return r.status === 'approved' && upcoming(r); });
  var fn = getSelectedFortnight() || getCurrentFortnight();
  var marked = [];
  if (fn) (fn.staff || []).forEach(function (st) {
    if (isHiddenStaffRow(st) && !rcIsMgr()) return;
    (fn.dates || []).forEach(function (d, i) {
      if (!((st.unavailable && st.unavailable[i]) || rcIsUAVal(st.shifts[i]))) return;
      var o = st.originalShifts && st.originalShifts[i] != null ? String(st.originalShifts[i]) : '';
      marked.push({ name: String(st.lastName || '').toUpperCase() + ', ' + st.firstName, day: d.day + ' ' + d.date, shift: rcIsEmptyVal(o) || rcIsUAVal(o) || rcIsAbsentVal(o) ? 'day off' : o, past: d.iso < today });
    });
  });
  var h = '';
  h += '<div class="card" style="background:#FFF6CC"><div class="rc-h">WAITING FOR APPROVAL (' + pend.length + ')</div>' + (pend.length ? pend.map(function (r) { return '<div class="rc-small">' + rcEsc(r.username) + ' - ' + rcEsc(rcReqSummary(r)) + '</div>'; }).join('') + '<button class="rc-b" style="margin-top:6px" onclick="openPage(\'requests-page\')">REVIEW REQUESTS</button>' : '<div class="rc-small">No time-off requests waiting.</div>') + '</div>';
  h += '<div class="card"><div class="rc-h">APPROVED TIME OFF</div>' + (appr.length ? appr.map(function (r) { return '<div class="rc-row"><span><b>' + rcEsc(r.username) + '</b> <span class="rc-small">' + rcEsc(rcReqSummary(r)) + '</span></span></div>'; }).join('') : '<div class="rc-small">No upcoming approved time off.</div>') + '</div>';
  h += '<div class="card"><div class="rc-h">MARKED UA' + (fn ? ' • ' + rcEsc(rcFnRange(fn)) : '') + '</div>' + (marked.length ? marked.map(function (m) { return '<div class="rc-row" style="' + (m.past ? 'opacity:.5' : '') + '"><span><b>' + rcEsc(m.name) + '</b></span><span class="rc-small">' + rcEsc(m.day) + ' • ' + rcEsc(m.shift) + ' <span class="rc-pill" style="background:#555">UA</span></span></div>'; }).join('') : '<div class="rc-small">Nobody is marked unavailable on this roster.</div>') + '</div>';
  h += '<div class="card"><button onclick="showMain()" class="rc-b rc-wide">← BACK TO ROSTER</button></div>';
  el.innerHTML = h;
};

/* ---------- shift offers ---------- */
function rcOfferId(fn, staffIdx, i) { var keys = rcStaffKeys(fn); return rcEncodeKey(fn.id) + '~' + rcEncodeKey(keys[staffIdx]) + '~' + i; }
function rcIsEmptyCell(st, i) {
  if (!st || !st.shifts) return false;
  if (st.unavailable && st.unavailable[i]) return false;
  if (st.absentApproved && st.absentApproved[i]) return false;
  // The uploaded Excel shift is kept in originalShifts once a cell is edited
  if (st.originalShifts && st.originalShifts[i] != null && !rcIsEmptyVal(st.originalShifts[i])) return false;
  return rcIsEmptyVal(st.shifts[i]);
}
function rcCleanShift(v) {
  var s = String(v || '').replace(/G/gi, '').trim().replace(/\s+/g, '');
  var m = s.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  if (+m[1] > 23 || +m[3] > 24 || +m[2] > 59 || +m[4] > 59) return null;
  return String(+m[1]).padStart(2, '0') + ':' + m[2] + '-' + String(+m[3]).padStart(2, '0') + ':' + m[4];
}
function rcOfferExpired(o) { return o.dateIso && o.dateIso < getISO(); }

/* ---------- in-cell shift editing (managers) ---------- */
// Same rules as the old pop-up: blank = back to the uploaded shift, OFF = off, G = manager (green), AB = absent
function rcSaveCell(fnId, rowIdx, colIdx, raw) {
  var newVal = String(raw || '').trim();
  if (!newVal) { revertCellToOriginal(fnId, rowIdx, colIdx); return; }
  var fns = safeGetJSON('retail_roster_byFortnight_v1', []);
  var fn = fns.find(function (f) { return f.id === fnId; }); if (!fn) return;
  var st = fn.staff[rowIdx]; if (!st) return;
  var current = st.shifts[colIdx] || 'OFF', upper = newVal.toUpperCase(), isG = false, clean = newVal;
  if (upper === 'G') { isG = true; clean = rcIsEmptyVal(current) ? 'OFF' : current; }
  else if (upper.indexOf('G') !== -1) {
    isG = true;
    clean = newVal.replace(/G/gi, '').trim().replace(/\s{2,}/g, ' ');
    if (!clean) clean = current || 'OFF';
    if (clean.toUpperCase() === 'OFF' && !rcIsEmptyVal(current)) clean = current;
  }
  if (/^(ABSENT)$/i.test(clean)) clean = 'AB';
  if (/^(UA|NA)$/i.test(clean)) clean = 'UA';
  if (/^OFF$/i.test(clean)) clean = 'OFF';
  st.originalShifts = st.originalShifts || {}; st.cellGreen = st.cellGreen || {}; st.cellG = st.cellG || {}; st.absentApproved = st.absentApproved || {};
  var green = upper === 'G' ? true : (isG && clean.toUpperCase() !== 'OFF');
  var ab = /^AB$/i.test(clean), ua = clean === 'UA';
  if (!st.unavailable) st.unavailable = [];
  if (clean === current && !!st.cellGreen[colIdx] === green && !!st.absentApproved[colIdx] === ab && !!st.unavailable[colIdx] === ua) return;
  if (st.originalShifts[colIdx] == null && !rcIsUAVal(st.shifts[colIdx]) && !rcIsAbsentVal(st.shifts[colIdx])) st.originalShifts[colIdx] = st.shifts[colIdx];
  st.shifts[colIdx] = clean;
  st.cellGreen[colIdx] = green && !ua; st.cellG[colIdx] = green && !ua; st.absentApproved[colIdx] = ab; st.unavailable[colIdx] = ua;
  if (st.originalShifts[colIdx] === clean && !green && !ab && !ua) delete st.originalShifts[colIdx];
  safeSetJSON('retail_roster_byFortnight_v1', fns);
}

editCell = function (el, rowIdx, colIdx) {
  if (!rcIsMgr()) { toast('Manager only'); return; }
  if (!el || el.classList.contains('rc-cell-edit')) return;
  var open = document.querySelector('#roster-mount .rc-cell-edit');
  if (open && open._rcFinish) open._rcFinish(true);
  try { updateActivity(); } catch (e) {}
  var fn = getSelectedFortnight() || getCurrentFortnight(); if (!fn) return;
  var st = fn.staff[rowIdx]; if (!st) return;
  // the table may have been redrawn by the save above; find this cell again
  el = document.querySelector('#roster-mount td[data-r="' + rowIdx + '"][data-i="' + colIdx + '"]') || el;
  var oid = rcOfferId(fn, rowIdx, colIdx), offer = RC.offers[oid];
  var pending = offer && offer.status === 'pending' ? offer : null;
  var cur = st.shifts[colIdx] || 'OFF', green = (st.cellGreen && st.cellGreen[colIdx]) || (st.cellG && st.cellG[colIdx]);
  var start = pending ? pending.shift : (rcIsEmptyVal(cur) ? (green ? 'G' : '') : cur + (green ? ' G' : ''));
  var user = !pending && rcIsEmptyCell(st, colIdx) ? rcUserForStaff(st) : null;
  RC.cellEditing = true;
  el.classList.add('rc-cell-edit');
  el.innerHTML = '<input id="rc-cell-input" class="rc-cell-input" autocomplete="off" spellcheck="false" placeholder="' + (pending ? '' : '09:00-17:00') + '">'
    + (pending ? '<div class="rc-cell-acts"><button type="button" data-a="update">UPDATE</button><button type="button" data-a="cancel" class="rc-red">CANCEL</button></div><div class="rc-cell-note">offered to ' + rcEsc(pending.toUsername) + '</div>'
      : user ? '<div class="rc-cell-acts"><button type="button" data-a="offer">OFFER</button></div>' : '');
  var inp = el.querySelector('input');
  inp.value = start;
  var done = false;
  var finish = function (save, move) {
    if (done) return; done = true;
    RC.cellEditing = false;
    var val = inp.value.trim();
    if (save) {
      if (pending) {
        if (!val) { rcCancelOffer(oid); renderRosterSafe(); }
        else if (val === pending.shift) renderRosterSafe();
        else { rcSaveCell(fn.id, rowIdx, colIdx, val); renderRosterSafe(); }
      } else { rcSaveCell(fn.id, rowIdx, colIdx, val); renderRosterSafe(); }
    } else renderRosterSafe();
    rcScheduleRender();
    if (move) {
      var nextI = colIdx + move;
      if (nextI >= 0 && nextI < fn.dates.length) {
        var td = document.querySelector('#roster-mount td[data-r="' + rowIdx + '"][data-i="' + nextI + '"]');
        if (td) editCell(td, rowIdx, nextI);
      }
    }
  };
  el._rcFinish = finish;
  inp.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    else if (e.key === 'Tab') { e.preventDefault(); finish(true, e.shiftKey ? -1 : 1); }
  });
  inp.addEventListener('blur', function () { setTimeout(function () { if (!done && document.activeElement !== inp) finish(true); }, 120); });
  inp.addEventListener('click', function (e) { e.stopPropagation(); });
  Array.prototype.forEach.call(el.querySelectorAll('.rc-cell-acts button'), function (btn) {
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); });   // keep the text box focused
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var act = btn.getAttribute('data-a'), shift = rcCleanShift(inp.value);
      if (act === 'cancel') { done = true; RC.cellEditing = false; rcCancelOffer(oid).then(function () { renderRosterSafe(); }); return; }
      if (!shift) { toast('Type a time like 09:00-17:30 first'); inp.focus(); return; }
      done = true; RC.cellEditing = false;
      if (act === 'offer') { rcCreateOffer(fn, rowIdx, colIdx, shift, user); renderRosterSafe(); }
      if (act === 'update') {
        if (shift === pending.shift) { renderRosterSafe(); return; }
        var to = RC.users[pending.toUid] ? Object.assign({ uid: pending.toUid }, RC.users[pending.toUid]) : null;
        if (!to) { toast('That employee no longer has a login'); renderRosterSafe(); return; }
        rcWithdrawOffer(oid, true).then(function () { rcCreateOffer(fn, rowIdx, colIdx, shift, to); });
      }
    });
  });
  inp.focus(); inp.select();
};
function rcCreateOffer(fn, rowIdx, colIdx, shift, user) {
  var st = fn.staff[rowIdx], keys = rcStaffKeys(fn), d = fn.dates[colIdx];
  var oid = rcOfferId(fn, rowIdx, colIdx);
  var offer = {
    fn: rcEncodeKey(fn.id), fnId: fn.id, fnLabel: fn.label || '', sk: rcEncodeKey(keys[rowIdx]), i: colIdx,
    shift: shift, toUid: user.uid, toUsername: user.username, staffName: st.firstName + ' ' + st.lastName,
    dateIso: d.iso || '', dateLabel: d.day + ' ' + d.date,
    byUid: RC.session.uid, byName: RC.session.profile.username, status: 'pending', ts: firebase.database.ServerValue.TIMESTAMP
  };
  offer.notifId = RC.db.ref('notifications/' + user.uid).push().key;
  RC.db.ref(rcTP('offers/' + oid)).set(offer).then(function () {
    toast('Offer sent to ' + user.username);
    rcNotify([user.uid], { type: 'offer', title: 'Shift offered to you', body: offer.dateLabel + ' ' + shift + ' - open INBOX to accept or decline.', offerId: oid }, offer.notifId);
  }).catch(function (e) { toast('Offer not sent: ' + rcErrMsg(e)); });
}
/* Withdrawing an offer removes the employee's alert for it, in the app and on their phone */
function rcWithdrawOfferAlert(o, upd) { if (o && o.notifId && o.toUid) upd['notifications/' + o.toUid + '/' + o.notifId] = null; }
function rcPushWithdraw(o) {
  if (!o || !o.notifId) return;
  var ids = {}; ids[o.toUid] = o.notifId;
  rcSendPush(ids, { title: 'Shift offer withdrawn', body: o.dateLabel + ' ' + o.shift + ' is no longer offered.', close: true });
}
function rcWithdrawOffer(oid, quiet) {
  var o = RC.offers[oid]; if (!o) return Promise.resolve();
  var upd = {}; upd[rcTP('offers/' + oid + '/status')] = 'cancelled'; upd[rcTP('offers/' + oid + '/respondedTs')] = firebase.database.ServerValue.TIMESTAMP;
  rcWithdrawOfferAlert(o, upd);
  return RC.db.ref().update(upd).then(function () {
    rcPushWithdraw(o);
    if (!quiet) toast('Offer withdrawn - ' + o.toUsername + '\'s alert removed');
  }).catch(function (e) { toast('Not cancelled: ' + rcErrMsg(e)); });
}
function rcCancelOffer(oid) { return rcWithdrawOffer(oid, false); }
function rcRespondOffer(oid, accept) {
  var team = RC.team, sep = String(oid).indexOf('::');
  if (sep !== -1) { team = oid.slice(0, sep); oid = oid.slice(sep + 2); }   // an offer from another team I'm on
  var o = team === RC.team ? RC.offers[oid] : (RC.xOffers[team] || {})[oid];
  var TP = function (p) { return rcTPx(team, p); };
  if (!o || o.status !== 'pending') { toast('This offer is no longer available'); return; }
  if (rcOfferExpired(o)) { toast('This shift date has passed'); return; }
  var upd = {};
  upd[TP('offers/' + oid + '/status')] = accept ? 'accepted' : 'declined';
  if (accept) rcLogHistory(upd, { fnId: o.fnId || '', fn: o.fnLabel || '', name: String(o.staffName || '').replace(/^(\S+)\s+(.*)$/, function (m, f, l) { return l.toUpperCase() + ', ' + f; }), day: o.dateLabel, from: 'OFF', to: o.shift, action: 'Accepted shift offer' }, team);
  upd[TP('offers/' + oid + '/respondedTs')] = firebase.database.ServerValue.TIMESTAMP;
  if (accept) {
    var cellPath = TP('data/roster/' + o.fn + '/staff/' + o.sk);
    upd[cellPath + '/shifts/' + o.i] = o.shift;
    var curFn = rcAsArray(team === RC.team ? safeGetJSON('retail_roster_byFortnight_v1', []) : (RC.otherRosters[team] || [])).find(function (f) { return rcEncodeKey(f.id) === o.fn; });
    var curSt = curFn && curFn.staff[rcStaffKeys(curFn).map(rcEncodeKey).indexOf(o.sk)];
    var hasOrig = curSt && curSt.originalShifts && curSt.originalShifts[o.i] != null;
    if (!hasOrig) upd[cellPath + '/originalShifts/' + o.i] = (curSt && curSt.shifts && curSt.shifts[o.i]) || 'OFF';
  }
  rcSave(upd).then(function () {
    toast(accept ? 'Accepted - the shift is now on your roster' : 'Offer declined');
    var who = RC.session.profile.username;
    var uids = rcManagerUids(team); if (o.byUid && uids.indexOf(o.byUid) === -1) uids.push(o.byUid);
    rcNotify(uids, { type: accept ? 'offer-accepted' : 'offer-declined', title: who + (accept ? ' accepted a shift' : ' declined a shift'), body: o.dateLabel + ' ' + o.shift + (accept ? ' is now on the roster.' : ' is still open.') });
    rcCloseModal();
  }).catch(function (e) {
    console.error(e);
    toast(accept ? 'Could not accept - the shift may have been filled or withdrawn' : 'Could not decline: ' + rcErrMsg(e));
  });
}
function rcCloseModal() { var m = document.getElementById('custom-modal'); if (m) m.classList.remove('show'); }
function rcMyPendingOffers(otherOnly) {
  if (!RC.session) return [];
  var list = otherOnly ? [] : Object.keys(RC.offers).map(function (k) { return Object.assign({ id: k }, RC.offers[k]); });
  Object.keys(RC.xOffers).forEach(function (t) { var v = RC.xOffers[t] || {}; Object.keys(v).forEach(function (k) { list.push(Object.assign({ id: t + '::' + k }, v[k], { _team: t })); }); });
  return list
    .filter(function (o) { return o.toUid === RC.session.uid && o.status === 'pending' && !rcOfferExpired(o); })
    .sort(function (a, b) { return String(a.dateIso).localeCompare(String(b.dateIso)); });
}
/* Mark offered cells on the roster */
renderRosterSafe = (function (orig) {
  return function () { var r = orig.apply(this, arguments); try { rcDecorateRoster(); rcCurrentIndicator(); rcDraftBar(); rcTeamPill(); rcFreshButton(); rcMobileRoster(); rcGuestTags(); rcApplyRowSize(); rcSharedMarks(); rcQueueShared(); } catch (e) { console.error('decorate', e); } return r; };
})(renderRosterSafe);
/* ---------- phones: day view (default) or an easier-to-read fortnight table ---------- */
function rcRosterView() { try { return localStorage.getItem('repco_roster_view') || 'day'; } catch (e) { return 'day'; } }
function rcSetRosterView(v) { try { localStorage.setItem('repco_roster_view', v); } catch (e) {} renderRosterSafe(); }
function rcSetDay(i) { RC.dayIdx = i; RC.dayFn = (getSelectedFortnight() || {}).id; renderRosterSafe(); }
function rcMobileRoster() {
  var mount = document.getElementById('roster-mount'); if (!mount || !RC.session || RC.pdfMode) return;
  var old = document.getElementById('rc-viewbar'); if (old) old.remove();
  if (!document.body.classList.contains('rc-mobile')) return;
  var fn = getSelectedFortnight() || getCurrentFortnight(); if (!fn) return;
  var view = rcRosterView(), today = getISO();
  var bar = document.createElement('div'); bar.id = 'rc-viewbar';
  bar.innerHTML = '<button class="' + (view === 'day' ? 'on' : '') + '" onclick="rcSetRosterView(\'day\')">DAY</button><button class="' + (view !== 'day' ? 'on' : '') + '" onclick="rcSetRosterView(\'table\')">FORTNIGHT</button>';
  mount.parentNode.insertBefore(bar, mount);
  if (view !== 'day') { rcEasyTable(fn, today); return; }
  // Day view
  var ti = fn.dates.findIndex(function (d) { return d.iso === today; });
  if (RC.dayFn !== fn.id || RC.dayIdx == null || RC.dayIdx >= fn.dates.length) { RC.dayIdx = ti >= 0 ? ti : 0; RC.dayFn = fn.id; }
  var i = RC.dayIdx, day = fn.dates[i], mgr = rcIsMgr();
  var me = findMyStaff(fn);
  var people = fn.staff.map(function (st, r) { return { st: st, r: r }; }).filter(function (x) { return !isHiddenStaffRow(x.st) || mgr || x.st === me; });
  var status = function (st) {
    var sh = String(st.shifts[i] == null ? 'OFF' : st.shifts[i]);
    if ((st.absentApproved && st.absentApproved[i]) || rcIsAbsentVal(sh)) return 'AB';
    if ((st.unavailable && st.unavailable[i]) || rcIsUAVal(sh)) return 'UA';
    return parseShiftRange(sh) ? 'work' : 'OFF';
  };
  var working = people.filter(function (x) { return status(x.st) === 'work'; }).sort(function (a, b) { return parseShiftRange(a.st.shifts[i]).start - parseShiftRange(b.st.shifts[i]).start || String(a.st.lastName).localeCompare(String(b.st.lastName)); });
  var notWorking = people.filter(function (x) { return status(x.st) !== 'work'; });
  var hrs = working.reduce(function (t, x) { return t + (isHiddenStaffRow(x.st) ? 0 : netH(x.st.shifts[i])); }, 0);
  var chips = fn.dates.map(function (d, k) { return '<button class="dv-chip' + (k === i ? ' on' : '') + (d.iso === today ? ' today' : '') + (d.day === 'SAT' || d.day === 'SUN' ? ' wk' : '') + '" onclick="rcSetDay(' + k + ')"><span>' + d.day + '</span><b>' + d.date.slice(0, 2) + '</b></button>'; }).join('');
  var nm = function (st) { return '<b>' + rcEsc(st.firstName) + '</b> ' + rcEsc(String(st.lastName || '').charAt(0).toUpperCase() + String(st.lastName || '').slice(1).toLowerCase()); };
  var h = '<div class="dv-chips" id="dv-chips">' + chips + '</div>'
    + '<div class="dv-head"><div><div class="dv-day">' + rcEsc(day.day + ' ' + day.date) + (day.iso === today ? ' <span class="ms-tag ms-tt">TODAY</span>' : '') + '</div><div class="rc-small">' + working.length + ' working' + (mgr ? ' • ' + hrs.toFixed(1) + 'h' : '') + '</div></div></div>'
    + '<div class="dv-list">' + (working.length ? working.map(function (x) {
      var st = x.st, sh = String(st.shifts[i]), green = (st.cellGreen && st.cellGreen[i]) || isAutoGreenShift(st, sh), own = st === me;
      var oid = rcOfferId(fn, x.r, i), offer = RC.offers[oid];
      return '<div class="dv-row' + (own ? ' own' : '') + (mgr ? ' dv-edit' : '') + '" data-r="' + x.r + '"' + (mgr ? ' onclick="rcDayEdit(this,' + x.r + ',' + i + ')"' : '') + '>'
        + '<span class="dv-name">' + nm(st) + (own ? ' <span class="you-pill">YOU</span>' : '') + (green ? ' <span class="ms-tag" style="background:#1a7f37">MANAGER</span>' : '') + (isHiddenStaffRow(st) ? ' <span class="ms-tag" style="background:#555">HIDDEN</span>' : '') + '</span>'
        + '<span class="dv-shift">' + rcEsc(fmt(sh)) + '<small>' + netH(sh).toFixed(1) + 'h</small></span></div>';
    }).join('') : '<div class="dv-empty">Nobody is rostered.</div>') + '</div>';
  if (notWorking.length) h += '<div class="dv-off"><div class="rc-h" style="font-size:11px;margin-bottom:6px">NOT WORKING</div>' + notWorking.map(function (x) {
    var stt = status(x.st), own = x.st === me;
    return '<span class="dv-offname' + (own ? ' own' : '') + '"' + (mgr ? ' onclick="rcDayEdit(this,' + x.r + ',' + i + ')"' : '') + '>' + rcEsc(x.st.firstName + ' ' + String(x.st.lastName || '').charAt(0)) + (stt !== 'OFF' ? ' <b class="' + (stt === 'AB' ? 'dv-ab' : 'dv-ua') + '">' + stt + '</b>' : '') + '</span>';
  }).join('') + '</div>';
  if (mgr) h += '<div class="rc-small" style="margin:8px 4px;color:#777">Tap a name to change their shift. Use FORTNIGHT to make offers.</div>';
  mount.innerHTML = h;
  var c = document.querySelector('#dv-chips .dv-chip.on'); if (c) c.scrollIntoView({ inline: 'center', block: 'nearest' });
}
/* Managers: edit a shift right in the day view (same rules as the table) */
function rcDayEdit(el, r, i) {
  if (!rcIsMgr() || el.querySelector('input')) return;
  var fn = getSelectedFortnight() || getCurrentFortnight(); var st = fn.staff[r];
  var cur = String(st.shifts[i] == null ? 'OFF' : st.shifts[i]);
  RC.cellEditing = true;
  var box = document.createElement('div'); box.className = 'dv-editbox';
  box.innerHTML = '<input value="' + rcEsc(rcIsEmptyVal(cur) ? '' : cur) + '" placeholder="09:00-17:00, OFF, AB, UA or blank">';
  el.appendChild(box);
  var inp = box.querySelector('input'), done = false;
  var fin = function (save) { if (done) return; done = true; RC.cellEditing = false; if (save) rcSaveCell(fn.id, r, i, inp.value); renderRosterSafe(); };
  inp.addEventListener('click', function (e) { e.stopPropagation(); });
  inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); fin(true); } else if (e.key === 'Escape') fin(false); });
  inp.addEventListener('blur', function () { setTimeout(function () { fin(true); }, 100); });
  inp.focus(); inp.select();
}
/* Fortnight table on phones: start/finish stacked, today's column marked */
function rcEasyTable(fn, today) {
  var ti = fn.dates.findIndex(function (d) { return d.iso === today; });
  document.querySelectorAll('#roster-mount .r-table').forEach(function (t) {
    t.classList.add('rc-easy');
    if (ti >= 0) {
      var th = t.querySelectorAll('thead th')[ti + 1]; if (th) th.classList.add('rc-today-col');
      t.querySelectorAll('td[data-i="' + ti + '"]').forEach(function (td) { td.classList.add('rc-today-col'); });
    }
    t.querySelectorAll('td[data-i]').forEach(function (td) {
      if (td.classList.contains('rc-cell-edit')) return;
      var m = td.textContent.trim().match(/^(\d{1,2}:\d{2}\s*(?:[AP]M)?)\s*-\s*(\d{1,2}:\d{2}\s*(?:[AP]M)?)(.*)$/i);
      if (m && !td.querySelector('.rc-offer-tag')) td.innerHTML = '<span class="rc-t">' + m[1] + '</span><span class="rc-t">' + m[2] + '</span>' + (m[3].trim() ? '<span class="rc-t2">' + rcEsc(m[3].trim()) + '</span>' : '');
    });
  });
}

/* Shows whether the roster on screen is the one containing today, with a quick way back to it */
function rcCurrentIndicator() {
  var sel = document.getElementById('fortnight-select'); if (!sel) return;
  var today = getCurrentFortnight(), shown = getSelectedFortnight();
  var iso = getISO();
  var todayId = today && today.dates.some(function (d) { return d.iso === iso; }) ? today.id : null;
  Array.prototype.forEach.call(sel.options, function (o) {
    if (!o.dataset.base) o.dataset.base = o.textContent;
    var f = rcAsArray(safeGetJSON('retail_roster_byFortnight_v1', [])).find(function (x) { return x.id === o.value; });
    o.textContent = o.dataset.base + (o.value === todayId ? '  ★ CURRENT' : '') + (f && f.draft ? '  (DRAFT)' : '');
  });
  var el = document.getElementById('rc-current');
  if (!el) { el = document.createElement('span'); el.id = 'rc-current'; sel.insertAdjacentElement('afterend', el); }
  if (shown && todayId && shown.id === todayId) {
    el.className = 'rc-current on'; el.textContent = '★ CURRENT ROSTER'; el.onclick = null;
  } else if (todayId) {
    var past = shown && shown.dates.length && shown.dates[shown.dates.length - 1].iso < iso;
    el.className = 'rc-current off'; el.textContent = (past ? 'PAST ROSTER' : 'FUTURE ROSTER') + ' • GO TO CURRENT';
    el.onclick = function () { safeSet('retail_roster_currentFortnightId', todayId); sel.value = todayId; renderRosterSafe(); };
  } else { el.className = 'rc-current off'; el.textContent = 'NO ROSTER FOR TODAY'; el.onclick = null; }
}
function rcDecorateRoster() {
  if (!RC.session || RC.pdfMode) return;
  if (!rcIsMgr()) return;
  var fn = getSelectedFortnight() || getCurrentFortnight(); if (!fn) {
    var m = document.getElementById('roster-mount');
    if (m && !m.innerHTML.trim()) m.innerHTML = '<div class="card" style="margin:14px">No roster has been uploaded yet.' + (rcIsMgr() ? ' Use OPTIONS → IMPORT ROSTER, or import your old data from ACCOUNT MANAGEMENT.' : '') + '</div>';
    return;
  }
  var keys = rcStaffKeys(fn), fk = rcEncodeKey(fn.id);
  var rowOf = {}; keys.forEach(function (k, i) { rowOf[rcEncodeKey(k)] = i; });
  Object.keys(RC.offers).forEach(function (oid) {
    var o = RC.offers[oid];
    if (o.status !== 'pending' || o.fn !== fk || rowOf[o.sk] === undefined) return;
    var td = document.querySelector('#roster-mount td[data-r="' + rowOf[o.sk] + '"][data-i="' + o.i + '"]');
    if (!td || !td.classList.contains('cell-off')) return;
    td.classList.add('rc-cell-offer');
    td.innerHTML = '<span class="rc-offer-tag">OFFERED</span>' + rcEsc(fmt(o.shift));
  });
}
/* Employees only see offers in their INBOX, never on the roster itself */
function rcRenderOfferBanner() {}

/* ---------- notifications ---------- */
function rcNotify(uids, note, fixedKey) {
  if (!RC.session || !uids || !uids.length) return;
  var upd = {}, ids = {};
  uids.forEach(function (uid) {
    if (!uid) return;
    var key = fixedKey || RC.db.ref('notifications/' + uid).push().key;
    ids[uid] = key;
    // Employees never see which manager/admin login sent something
    var toMgr = RC.allUsers[uid] && rcIsMgrRole(RC.allUsers[uid].role);
    upd['notifications/' + uid + '/' + key] = Object.assign({ ts: firebase.database.ServerValue.TIMESTAMP, read: false }, toMgr ? { from: RC.session.profile.username } : {}, note);
  });
  return RC.db.ref().update(upd).then(function () { return rcSendPush(ids, note); }).catch(function (e) { console.error('notify', e); return { error: rcErrMsg(e) }; });
}
/* Resolves with what the relay reported ({sent, removed} or {error}) so problems can be shown */
function rcSendPush(ids, note) {
  if (!RC_PUSH_WORKER_URL || !RC.auth.currentUser) return Promise.resolve({ error: 'relay not configured' });
  return RC.auth.currentUser.getIdToken().then(function (token) {
    return fetch(RC_PUSH_WORKER_URL.replace(/\/$/, '') + '/notify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token, targets: Object.keys(ids).map(function (uid) { return { uid: uid, tag: ids[uid] }; }), title: note.title, body: note.body, close: !!note.close })
    });
  }).then(function (r) { return r.json().catch(function () { return { error: 'relay answered ' + r.status }; }); })
    .catch(function (e) { console.warn('push not sent', e); return { error: 'could not reach the relay (' + (e.message || e) + ')' }; });
}
function rcAlertForeground(n) {
  toast('🔔 ' + n.title);
  try {
    if (document.visibilityState === 'visible') return;
    if (!('Notification' in window) || Notification.permission !== 'granted' || !navigator.serviceWorker) return;
    navigator.serviceWorker.ready.then(function (reg) { reg.showNotification(n.title, { body: n.body || '', tag: n.id, icon: 'icon-192.png', badge: 'icon-192.png' }); });
  } catch (e) {}
}
/* INBOX = alerts + requests in one place */
function rcCloseDeviceAlert(tag) {
  try {
    if (!navigator.serviceWorker) return;
    navigator.serviceWorker.getRegistration().then(function (reg) { return reg && reg.getNotifications({ tag: tag }); }).then(function (ns) { (ns || []).forEach(function (n) { n.close(); }); }).catch(function () {});
  } catch (e) {}
}
function rcUnreadAlerts() { return RC.notifs.filter(function (n) { return !n.read; }).length + rcMyPendingOffers(rcIsMgr()).length; }
function rcPendingRequests() {
  if (!RC.session) return 0;
  var me = RC.session.profile.usernameLower;
  return rcAsArray(safeGetJSON('retail_roster_requests_v2', [])).filter(function (r) { return (!r.status || r.status === 'pending') && (rcIsMgr() || String(r.username || '').toLowerCase() === me); }).length;
}
function rcUnreadCount() { return rcUnreadAlerts() + (rcIsMgr() ? rcPendingRequests() : 0); }
function rcInboxTabs(pageId) {
  var page = document.getElementById(pageId); if (!page) return;
  var inner = page.querySelector('.page-inner'); if (!inner) return;
  var title = inner.querySelector('.page-title'); if (title) title.textContent = 'INBOX';
  var bar = inner.querySelector('.rc-tabs');
  if (!bar) { bar = document.createElement('div'); bar.className = 'rc-tabs'; inner.insertBefore(bar, title ? title.nextSibling : inner.firstChild); }
  var a = rcUnreadAlerts(), r = rcPendingRequests();
  bar.innerHTML = '<button class="rc-tab' + (pageId === 'notif-page' ? ' on' : '') + '" onclick="openPage(\'notif-page\')">ALERTS' + (rcIsMgr() ? '' : ' & OFFERS') + (a ? ' <span class="rc-badge">' + a + '</span>' : '') + '</button>'
    + '<button class="rc-tab' + (pageId === 'requests-page' ? ' on' : '') + '" onclick="openPage(\'requests-page\')">REQUESTS' + (r ? ' <span class="rc-badge">' + r + '</span>' : '') + '</button>';
}
function rcEnsureHeaderBits() {
  var btns = document.querySelector('#global-header .r-btns-consistent');
  if (btns && !document.getElementById('btn-notif')) {
    var b = document.createElement('button');
    b.className = 'r-btn-consistent'; b.id = 'btn-notif';
    b.onclick = function () { openPage('notif-page'); };
    var lo = document.getElementById('btn-logout');
    btns.insertBefore(b, lo);
  }
  if (!document.getElementById('notif-page')) {
    var p = document.createElement('div');
    p.id = 'notif-page'; p.className = 'full-page';
    p.innerHTML = '<div class="page-inner"><div class="page-title">INBOX</div><div id="notif-inner"></div></div>';
    document.body.appendChild(p);
  }
  rcRenderBell();
  rcFitHeader();
}
function rcRenderBell() {
  var b = document.getElementById('btn-notif'); if (!b) return;
  var n = rcUnreadCount();
  b.innerHTML = '📥 INBOX' + (n ? ' <span class="rc-badge">' + n + '</span>' : '');
  rcNavState();
  var open = document.querySelector('.full-page.show');
  if (open && (open.id === 'notif-page' || open.id === 'requests-page')) rcInboxTabs(open.id);
  try { if (navigator.setAppBadge) { if (n) navigator.setAppBadge(n); else navigator.clearAppBadge(); } } catch (e) {}
}
openPage = (function (orig) {
  return function (id) {
    if (id === 'hidden-staff-page' && !rcIsManagerUp()) { toast('Managers only'); return; }
    orig.apply(this, arguments);
    if (id === 'hidden-staff-page') renderHiddenStaffPage();
    if (id === 'notif-page') rcRenderNotifPage(true);
    if (id === 'notif-page' || id === 'requests-page') { rcInboxTabs(id); document.querySelectorAll('#btn-notif').forEach(function (b) { b.classList.add('active'); }); }
    else document.querySelectorAll('#btn-notif').forEach(function (b) { b.classList.remove('active'); });
    if (id === 'notif-page') setTimeout(rcRenderBell, 300);
  };
})(openPage);
function rcRemoveOffers(ids) {
  var upd = {}; (ids || []).forEach(function (id) { var o = RC.offers[id]; if (o && (o.status !== 'pending' || rcOfferExpired(o))) upd[rcTP('offers/' + id)] = null; });
  if (!Object.keys(upd).length) return;
  RC.db.ref().update(upd).then(function () { toast('Removed'); }).catch(function (e) { toast('Not removed: ' + rcErrMsg(e)); });
}
function rcRenderNotifPage(markRead) {
  var el = document.getElementById('notif-inner'); if (!el || !RC.session) return;
  var h = '';
  var myOff = rcIsMgr() ? rcMyPendingOffers(true) : [];
  if (myOff.length) h += '<div class="card"><div class="rc-h">SHIFTS OFFERED TO YOU</div>' + myOff.map(function (o) {
    return '<div class="rc-row"><div><b>' + rcEsc(o.dateLabel) + '</b> ' + rcEsc(fmt(o.shift)) + '<br><span class="rc-small">' + rcEsc(rcTeamName(o._team)) + ' • ' + rcEsc(o.fnLabel || '') + '</span></div><div class="rc-btns"><button class="rc-b rc-green" onclick="rcRespondOffer(\'' + o.id + '\',true)">ACCEPT</button><button class="rc-b" onclick="rcRespondOffer(\'' + o.id + '\',false)">DECLINE</button></div></div>';
  }).join('') + '</div>';
  if (!rcIsMgr()) {
    var offers = rcMyPendingOffers();
    h += '<div class="card"><div class="rc-h">SHIFT OFFERS</div>' + (offers.length ? offers.map(function (o) {
      return '<div class="rc-row"><div><b>' + rcEsc(o.dateLabel) + '</b> ' + rcEsc(fmt(o.shift)) + '<br><span class="rc-small">' + (o._team ? rcEsc(rcTeamName(o._team)) + ' • ' : '') + rcEsc(o.fnLabel || '') + '</span></div><div class="rc-btns"><button class="rc-b rc-green" onclick="rcRespondOffer(\'' + o.id + '\',true)">ACCEPT</button><button class="rc-b rc-white" onclick="rcRespondOffer(\'' + o.id + '\',false)">DECLINE</button></div></div>';
    }).join('') : '<div class="rc-small">No open offers right now.</div>') + '</div>';
  } else {
    var all = Object.keys(RC.offers).map(function (k) { return Object.assign({ id: k }, RC.offers[k]); }).sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); }).slice(0, 40);
    var done = all.filter(function (o) { return o.status !== 'pending' || rcOfferExpired(o); }).map(function (o) { return o.id; });
    RC.finishedOffers = done;
    h += '<div class="card"><div class="rc-row" style="border:none"><div class="rc-h">SHIFT OFFERS</div>' + (done.length ? '<button class="rc-b rc-white" onclick="rcRemoveOffers(RC.finishedOffers)">CLEAR FINISHED (' + done.length + ')</button>' : '') + '</div><div class="rc-small">To offer a shift, tap an empty cell on the roster.</div>' + (all.length ? all.map(function (o) {
      var st = o.status === 'pending' && rcOfferExpired(o) ? 'expired' : o.status;
      return '<div class="rc-row"><div><b>' + rcEsc(o.dateLabel) + '</b> ' + rcEsc(fmt(o.shift)) + ' → ' + rcEsc(o.toUsername) + ' <span class="rc-pill rc-st-' + rcEsc(st) + '">' + rcEsc(st) + '</span><br><span class="rc-small">by ' + rcEsc(o.byName) + ' • ' + new Date(o.ts || 0).toLocaleString() + '</span></div>' + (o.status === 'pending' && st !== 'expired' ? '<button class="rc-b rc-white" onclick="rcCancelOffer(\'' + o.id + '\')">CANCEL</button>' : '<button class="rc-x" title="Remove" onclick="rcRemoveOffers([\'' + o.id + '\'])">✕</button>') + '</div>';
    }).join('') : '') + '</div>';
  }
  h += rcPushCardHtml();
  h += '<div class="card"><div class="rc-row" style="border:none"><div class="rc-h">NOTIFICATIONS</div>' + (RC.notifs.length ? '<span class="rc-btns">' + (RC.notifs.some(function (n) { return n.read; }) ? '<button class="rc-b rc-white" onclick="rcClearNotifs(true)">CLEAR READ</button>' : '') + '<button class="rc-b rc-white" onclick="rcClearNotifs()">CLEAR ALL</button></span>' : '') + '</div>' + (RC.notifs.length ? RC.notifs.map(function (n) {
    return '<div class="rc-notif' + (n.read ? '' : ' rc-unread') + '"><div style="font-weight:900">' + rcEsc(n.title) + '</div><div class="rc-small" style="white-space:pre-line">' + rcEsc(n.body || '') + '</div><div class="rc-small" style="opacity:.6">' + new Date(n.ts || 0).toLocaleString() + (n.from && rcIsMgr() ? ' • ' + rcEsc(n.from) : '') + '</div><button class="rc-x" title="Remove" onclick="rcRemoveNotif(\'' + n.id + '\')">✕</button></div>';
  }).join('') : '<div class="rc-small">Nothing yet.</div>') + '</div>';
  h += '<div class="card"><button onclick="showMain()" class="rc-b rc-wide">← BACK TO ROSTER</button></div>';
  el.innerHTML = h;
  if (markRead) {
    var upd = {};
    RC.notifs.forEach(function (n) { if (!n.read) upd['notifications/' + RC.session.uid + '/' + n.id + '/read'] = true; });
    if (Object.keys(upd).length) RC.db.ref().update(upd).catch(function () {});
  }
}
function rcRemoveNotif(id) { RC.db.ref('notifications/' + RC.session.uid + '/' + id).remove().catch(function (e) { toast(rcErrMsg(e)); }); }
function rcClearNotifs(readOnly) {
  var upd = {}; RC.notifs.forEach(function (n) { if (!readOnly || n.read) upd['notifications/' + RC.session.uid + '/' + n.id] = null; });
  RC.db.ref().update(upd).catch(function (e) { toast(rcErrMsg(e)); });
}

/* ---------- phone notifications (web push) ---------- */
function rcIsIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
function rcIsStandalone() { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
function rcPushCardHtml() {
  var supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  var h = '<div class="card"><div class="rc-h">PHONE NOTIFICATIONS</div>';
  if (rcIsIOS() && !rcIsStandalone()) return h + '<div class="rc-small">On iPhone: tap the Share button, then <b>Add to Home Screen</b>. Open Repco Roster from the home screen icon and come back here to turn notifications on.</div></div>';
  if (!supported) return h + '<div class="rc-small">This browser can\'t receive notifications. Try Chrome on Android, or Safari from the home screen on iPhone.</div></div>';
  var perm = Notification.permission;
  if (perm === 'denied') return h + '<div class="rc-small">Notifications are blocked for this site. Allow them in your browser or phone settings, then reload.</div></div>';
  h += '<div class="rc-small" id="rc-push-state">' + (perm === 'granted' ? 'Checking this device...' : 'Get an alert on this device for shift offers, roster changes and request decisions.') + '</div>';
  h += '<button class="rc-b rc-wide" id="rc-push-btn" onclick="rcEnablePush()">TURN ON NOTIFICATIONS ON THIS DEVICE</button>';
  if (!RC_PUSH_WORKER_URL && rcIsMgr()) h += '<div class="rc-small" style="color:#E30613;margin-top:6px">Manager note: alerts with the app closed need the free push worker set up (push-worker/README.md). Until then, alerts arrive while the app is open.</div>';
  setTimeout(rcRefreshPushState, 0);
  return h + '</div>';
}
function rcRefreshPushState() {
  if (!('serviceWorker' in navigator) || Notification.permission !== 'granted') return;
  navigator.serviceWorker.getRegistration().then(function (reg) { return reg && reg.pushManager.getSubscription(); }).then(function (sub) {
    var s = document.getElementById('rc-push-state'), b = document.getElementById('rc-push-btn');
    if (!s) return;
    if (sub) { s.textContent = 'On for this device ✓'; if (b) b.remove(); }
    else s.textContent = 'Not set up on this device yet.';
  }).catch(function () {});
}
function rcMaybeRegisterSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then(function () {
    if ('Notification' in window && Notification.permission === 'granted') rcSubscribePush(true);
  }).catch(function (e) { console.warn('sw', e); });
}
function rcB64ToBytes(b64) { var p = '='.repeat((4 - b64.length % 4) % 4); var s = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/')); var a = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
async function rcSubscribePush(silent) {
  try {
    var reg = await navigator.serviceWorker.ready;
    var sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: rcB64ToBytes(RC_VAPID_PUBLIC_KEY) });
    var json = sub.toJSON();
    var id = Array.prototype.map.call(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json.endpoint))), function (x) { return x.toString(16).padStart(2, '0'); }).join('').slice(0, 32);
    await RC.db.ref('push/' + RC.session.uid + '/' + id).set({ endpoint: json.endpoint, keys: json.keys, ua: navigator.userAgent.slice(0, 160), ts: firebase.database.ServerValue.TIMESTAMP });
    var pu = {}; pu['users/' + RC.session.uid + '/pushOn'] = true; pu['users/' + RC.session.uid + '/pushTs'] = firebase.database.ServerValue.TIMESTAMP;
    RC.db.ref().update(pu).catch(function () {});
    if (!silent) toast('Notifications on for this device');
  } catch (e) { if (!silent) toast('Could not turn on notifications: ' + (e.message || e)); console.warn('push subscribe', e); }
  rcRefreshPushState();
}
function rcEnablePush() {
  Notification.requestPermission().then(function (p) {
    if (p !== 'granted') { toast('Notifications were not allowed'); rcRenderNotifPage(); return; }
    navigator.serviceWorker.register('sw.js').then(function () { return rcSubscribePush(false); });
  });
}
function rcTestPush() {
  toast('Sending test alert...');
  rcNotify([RC.session.uid], { type: 'test', title: 'Test alert', body: 'Notifications are working on this device.' }).then(function (res) {
    var msg = !res ? 'No answer from the relay'
      : res.error ? 'Test failed: ' + res.error
      : res.sent ? 'Relay sent the alert to ' + res.sent + ' device(s)' + (res.removed ? ' (' + res.removed + ' old device(s) removed)' : '') + '. Lock your phone - it should appear within a few seconds.'
      : res.removed ? 'This device\'s registration had expired and was removed. Press TURN ON NOTIFICATIONS again.'
      : 'Relay found your device but the phone\'s push service refused the alert.';
    var st = document.getElementById('rc-push-state'); if (st) st.textContent = msg;
    toast(msg);
  });
}

/* ---------- new phone: set up the app and notifications ---------- */
var _rcInstallEvt = null;
window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); _rcInstallEvt = e; var b = document.getElementById('rc-ds-install'); if (b) rcDeviceSetup(true); });
window.addEventListener('appinstalled', function () { _rcInstallEvt = null; try { localStorage.setItem('repco_app_installed', '1'); } catch (e) {} rcDeviceSetup(true); });
function rcIsPhone() { return /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
function rcPushReady() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return Promise.resolve(false);
  if (Notification.permission !== 'granted') return Promise.resolve(false);
  return navigator.serviceWorker.getRegistration().then(function (reg) { return reg ? reg.pushManager.getSubscription() : null; }).then(function (s) { return !!s; }).catch(function () { return false; });
}
/* Shown after login on a phone until the app is installed and notifications are on */
function rcDeviceSetup(refreshOnly) {
  if (!RC.session || !rcIsPhone()) return;
  var installed = rcIsStandalone() || (function () { try { return localStorage.getItem('repco_app_installed') === '1'; } catch (e) { return false; } })();
  rcPushReady().then(function (pushOn) {
    var sheet = document.getElementById('rc-device-setup');
    if (installed && pushOn) { if (sheet) sheet.remove(); return; }
    if (refreshOnly && !sheet) return;
    if (!refreshOnly && RC.deviceSetupShown) return;
    RC.deviceSetupShown = true;
    var ios = rcIsIOS(), blocked = 'Notification' in window && Notification.permission === 'denied';
    var step1 = installed ? '<div class="rc-ds-done">✓ App installed</div>'
      : ios ? '<div class="rc-small">Tap the <b>Share</b> button <span class="rc-ds-ico">⬆︎</span> at the bottom of Safari, then <b>Add to Home Screen</b>. Open Repco Roster from the new icon.</div>'
      : _rcInstallEvt ? '<button class="rc-b rc-red rc-wide" id="rc-ds-install">INSTALL APP</button>'
      : '<div class="rc-small">Open your browser menu <b>⋮</b> and tap <b>Install app</b> or <b>Add to Home screen</b>.</div>';
    var step2 = pushOn ? '<div class="rc-ds-done">✓ Notifications on</div>'
      : blocked ? '<div class="rc-small">Notifications are blocked for this site. Allow them in your phone settings, then reopen the app.</div>'
      : (ios && !rcIsStandalone()) ? '<div class="rc-small">Do step 1 first. Notifications can be turned on once the app is opened from your home screen.</div>'
      : '<button class="rc-b rc-wide" id="rc-ds-push">TURN ON NOTIFICATIONS</button>';
    if (!sheet) { sheet = document.createElement('div'); sheet.id = 'rc-device-setup'; document.body.appendChild(sheet); }
    sheet.innerHTML = '<div class="rc-ds-card"><div class="rc-ds-title">SET UP THIS PHONE</div><div class="rc-small" style="margin-bottom:10px">So you get shift offers and roster changes straight away.</div>'
      + '<div class="rc-ds-step"><div class="rc-ds-num">1</div><div class="rc-ds-body"><b>Add the app to your home screen</b>' + step1 + '</div></div>'
      + '<div class="rc-ds-step"><div class="rc-ds-num">2</div><div class="rc-ds-body"><b>Turn on notifications</b>' + step2 + '</div></div>'
      + '<button class="rc-b rc-white rc-wide" id="rc-ds-later" style="margin-top:6px">LATER</button></div>';
    var later = document.getElementById('rc-ds-later'); if (later) later.onclick = function () { sheet.remove(); };
    var ib = document.getElementById('rc-ds-install');
    if (ib) ib.onclick = function () { var ev = _rcInstallEvt; if (!ev) return; ev.prompt(); ev.userChoice.then(function (c) { if (c && c.outcome === 'accepted') { try { localStorage.setItem('repco_app_installed', '1'); } catch (e) {} } _rcInstallEvt = null; rcDeviceSetup(true); }); };
    var pb = document.getElementById('rc-ds-push');
    if (pb) pb.onclick = function () {
      Notification.requestPermission().then(function (perm) {
        if (perm !== 'granted') { toast('Notifications were not allowed'); rcDeviceSetup(true); return; }
        navigator.serviceWorker.register('sw.js').then(function () { return rcSubscribePush(false); }).then(function () { rcDeviceSetup(true); });
      });
    };
  });
}

/* ---------- "Keep me signed in" on the login page ---------- */
function rcAddKeepSignedIn() {
  if (document.getElementById('rc-keep')) return;
  var btn = document.getElementById('login-signin-btn'); if (!btn) return;
  var pref = null; try { pref = localStorage.getItem('repco_keep_signed_in'); } catch (e) {}
  var on = pref === null ? (rcIsPhone() || rcIsStandalone()) : pref === '1';
  var l = document.createElement('label'); l.className = 'rc-keep';
  l.innerHTML = '<input type="checkbox" id="rc-keep"' + (on ? ' checked' : '') + '> Keep me signed in on this device';
  btn.parentNode.insertBefore(l, btn);
}

/* ---------- phone layout: slim top bar + bottom tab bar ---------- */
var RC_MOBILE = window.matchMedia('(max-width: 760px)');
var RC_ICONS = {
  roster: '<path d="M3 5h18v15H3z M3 10h18 M8 5v15 M3 15h18"/>',
  sched: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  buddies: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6 M14 20c0-2.6 1.4-4.5 3.5-4.5S21 17.4 21 20"/>',
  inbox: '<path d="M3 13l3-8h12l3 8v6H3z M3 13h5l1 3h6l1-3h5"/>',
  unavail: '<circle cx="12" cy="12" r="9"/><path d="M6 6l12 12"/>',
  options: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3 M12 19v3 M2 12h3 M19 12h3 M4.9 4.9l2.1 2.1 M17 17l2.1 2.1 M4.9 19.1L7 17 M17 7l2.1-2.1"/>',
  more: '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>'
};
function rcNavTabs() {
  return rcIsMgr()
    ? [['roster', 'Roster', 'roster'], ['notif-page', 'Inbox', 'inbox'], ['unavail-page', 'Unavailable', 'unavail'], ['options-page', 'Options', 'options'], ['more', 'More', 'more']]
    : [['roster', 'Roster', 'roster'], ['mysched-page', 'My Schedule', 'sched'], ['buddies-today-page-v141', 'Buddies', 'buddies'], ['notif-page', 'Inbox', 'inbox'], ['more', 'More', 'more']];
}
function rcBuildNav() {
  var nav = document.getElementById('rc-bottom-nav');
  if (!nav) { nav = document.createElement('nav'); nav.id = 'rc-bottom-nav'; document.body.appendChild(nav); }
  nav.innerHTML = rcNavTabs().map(function (t) {
    return '<button data-go="' + t[0] + '"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + RC_ICONS[t[2]] + '</svg><span>' + t[1] + '</span>' + (t[0] === 'notif-page' ? '<b class="rc-nav-badge" id="rc-nav-badge"></b>' : '') + '</button>';
  }).join('');
  Array.prototype.forEach.call(nav.querySelectorAll('button'), function (b) {
    b.onclick = function () {
      var go = b.getAttribute('data-go');
      if (go === 'more') { rcMoreSheet(); return; }
      if (go === 'roster') showMain(); else openPage(go);
    };
  });
  rcNavState();
}
function rcNavState() {
  var nav = document.getElementById('rc-bottom-nav'); if (!nav) return;
  var open = document.querySelector('.full-page.show'), id = open ? open.id : 'roster';
  if (id === 'requests-page') id = 'notif-page';
  if (id === 'buddies-tomorrow-page-v141') id = 'buddies-today-page-v141';
  Array.prototype.forEach.call(nav.querySelectorAll('button'), function (b) { b.classList.toggle('on', b.getAttribute('data-go') === id); });
  var badge = document.getElementById('rc-nav-badge'), n = RC.session ? rcUnreadCount() : 0;
  if (badge) { badge.textContent = n > 99 ? '99+' : n; badge.style.display = n ? 'flex' : 'none'; }
}
function rcMoreSheet() {
  var old = document.getElementById('rc-more'); if (old) { old.remove(); return; }
  var p = RC.session ? RC.session.profile : {};
  var sh = document.createElement('div'); sh.id = 'rc-more';
  sh.innerHTML = '<div class="rc-more-card"><div class="rc-small" style="margin-bottom:8px">Signed in as <b>' + rcEsc(p.username || '') + '</b></div>'
    + '<button data-a="account">My account &amp; password</button>'
    + (rcIsMgr() ? '' : '<button data-a="tomorrow">Tomorrow\'s buddies</button>')
    + '<button data-a="logout" class="rc-more-out">Log out</button><button data-a="close" class="rc-more-close">Close</button></div>';
  sh.onclick = function (e) {
    var a = e.target.getAttribute && e.target.getAttribute('data-a');
    if (e.target === sh || a === 'close') { sh.remove(); return; }
    if (!a) return;
    sh.remove();
    if (a === 'account') openPage('account-page');
    if (a === 'tomorrow') openPage('buddies-tomorrow-page-v141');
    if (a === 'logout') doLogout();
  };
  document.body.appendChild(sh);
}
function rcApplyMobile() {
  var m = RC_MOBILE.matches;
  document.body.classList.toggle('rc-mobile', m);
  document.body.classList.toggle('rc-in', !!RC.session);
  if (m && RC.session) rcBuildNav();
  var prev = document.querySelector('.r-controls button[onclick="prevFortnight()"]'), next = document.querySelector('.r-controls button[onclick="nextFortnight()"]');
  if (prev) { prev.textContent = m ? '‹' : 'PREV'; prev.title = 'Previous fortnight'; }
  if (next) { next.textContent = m ? '›' : 'NEXT'; next.title = 'Next fortnight'; }
  var tf = document.querySelector('.r-controls button[onclick="toggleTimeFormat()"]'); if (tf) tf.textContent = m ? '12/24H' : '12H/24H';
  var del = document.getElementById('delete-roster-btn'); if (del) del.textContent = m ? 'DELETE' : 'DELETE ROSTER';
  var v65 = document.getElementById('repco-v65');
  if (RC.session && v65 && v65.classList.contains('show')) renderRosterSafe();   // day view / easy table
  setTimeout(rcFitHeader, 0);
}
if (RC_MOBILE.addEventListener) RC_MOBILE.addEventListener('change', rcApplyMobile);
openPage = (function (orig) { return function () { var r = orig.apply(this, arguments); var m = document.getElementById('rc-more'); if (m) m.remove(); rcNavState(); return r; }; })(openPage);
showMain = (function (orig) { return function () { var r = orig.apply(this, arguments); var m = document.getElementById('rc-more'); if (m) m.remove(); rcNavState(); return r; }; })(showMain);

/* ---------- maintenance mode (live, managers only) ---------- */
if (RC.db) RC.db.ref('maintenance').on('value', function (s) {
  var v = s.val() || { enabled: false };
  rcSetLocal('repco_maintenance_first_v1', v);
  safeSet('maintenance_mode', String(!!v.enabled));
  checkMaintenance();
}, function () {});
checkMaintenance = function () {
  var el = document.getElementById('maintenance-main-v141'); if (!el) return;
  var on = !!safeGetJSON('repco_maintenance_first_v1', { enabled: false }).enabled;
  el.classList.toggle('show', on); document.body.classList.toggle('maintenance-active', on);
  var t = document.getElementById('maint-time-display'); if (t) t.textContent = 'Time: ' + new Date().toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' });
  ['maint-toggle', 'maint-toggle-options'].forEach(function (id) { var c = document.getElementById(id); if (c) c.checked = on; });
  ['maint-status', 'maint-status-options'].forEach(function (id) { var c = document.getElementById(id); if (c) c.textContent = 'Maintenance: ' + (on ? 'ON' : 'OFF'); });
};
function rcSetMaintenance(on) {
  if (!rcIsMgr()) { toast('Managers only'); checkMaintenance(); return; }
  RC.db.ref('maintenance').set({ enabled: !!on, by: RC.session.profile.username, ts: firebase.database.ServerValue.TIMESTAMP })
    .then(function () { toast('Maintenance ' + (on ? 'ON' : 'OFF') + ' - live on all devices'); })
    .catch(function (e) { toast('Not changed: ' + rcErrMsg(e)); checkMaintenance(); });
}
toggleMaintenance = function () { var c = document.getElementById('maint-toggle'); rcSetMaintenance(c ? c.checked : true); };
toggleMaintenanceFromOptions = function () { var c = document.getElementById('maint-toggle-options'); rcSetMaintenance(c ? c.checked : false); };
doAdminLogin = async function () {
  var err = document.getElementById('admin-err');
  var show = function () { document.getElementById('admin-login-section').style.display = 'none'; document.getElementById('admin-toggle-section').style.display = 'block'; checkMaintenance(); };
  if (rcIsMgr()) { show(); return; }
  var u = document.getElementById('admin-user').value.trim(), p = document.getElementById('admin-pass').value;
  err.textContent = 'Checking...';
  try {
    await rcSignIn(u, p);
    var t0 = Date.now();
    while (!RC.session && Date.now() - t0 < 10000) await new Promise(function (r) { setTimeout(r, 100); });
    if (!rcIsMgr()) { err.textContent = 'Managers only'; return; }
    err.textContent = ''; show();
  } catch (e) { err.textContent = rcErrMsg(e); }
};
openAdmin = (function (orig) { return function () { orig.apply(this, arguments); if (rcIsMgr()) doAdminLogin(); }; })(openAdmin);

/* ---------- moving data from the old database / this device ---------- */
function rcMigrationCardHtml() {
  if (!rcIsMgr()) return '';
  var dev = null; try { dev = JSON.parse(localStorage.getItem('repco_legacy_device_copy_v1') || 'null'); } catch (e) {}
  return '<div class="card" style="background:#FFF6CC"><div class="rc-h">IMPORT FROM OLD VERSION</div><div class="rc-small">Copies rosters, requests, archive and staff logins (with their current passwords) from the old database into this one. Existing users are skipped.</div>'
    + '<input id="rc-old-url" value="' + rcEsc(RC_OLD_DB_URL) + '" style="margin-top:8px">'
    + '<div class="rc-btns" style="margin-top:8px"><button class="rc-b" onclick="rcLoadOld(\'url\')">LOAD OLD DATABASE</button>' + (dev ? '<button class="rc-b rc-white" onclick="rcLoadOld(\'device\')">USE COPY SAVED ON THIS DEVICE (' + new Date(dev.ts).toLocaleDateString() + ')</button>' : '') + '</div>'
    + '<div id="rc-migrate-out"></div></div>';
}
async function rcLoadOld(src) {
  var out = document.getElementById('rc-migrate-out'); out.innerHTML = '<div class="rc-small">Loading...</div>';
  var state;
  try {
    if (src === 'device') state = JSON.parse(localStorage.getItem('repco_legacy_device_copy_v1'));
    else {
      var url = document.getElementById('rc-old-url').value.trim().replace(/\/$/, '');
      var r = await fetch(url + '/repco_state.json', { cache: 'no-store' });
      if (!r.ok) throw new Error('old database answered ' + r.status);
      state = await r.json();
    }
  } catch (e) { out.innerHTML = '<div class="rc-err">Could not load: ' + rcEsc(e.message || e) + '</div>'; return; }
  if (!state) { out.innerHTML = '<div class="rc-err">Nothing found there.</div>'; return; }
  RC.migrateState = state;
  var fns = rcAsArray(state.retail_roster_byFortnight_v1), reqs = rcAsArray(state.retail_roster_requests_v2);
  var users = rcAsArray(state.retail_roster_users_v1).filter(function (u) { return u && u.username; });
  var generic = ['admin', 'manager', 'master'];
  var h = '<div class="rc-small" style="margin-top:8px"><b>Found:</b> ' + fns.length + ' rosters, ' + reqs.length + ' requests, ' + rcAsArray(state.retail_roster_archive_v1 || state.repco_archive).length + ' archived, ' + users.length + ' logins.</div>';
  h += '<label class="rc-small"><input type="checkbox" id="rc-mig-data" checked> Replace rosters, requests and archive in the new database with this data</label>';
  h += '<div class="rc-h" style="margin-top:8px">LOGINS TO CREATE</div><div id="rc-migrate-users">' + users.map(function (u, i) {
    var exists = !!rcUserByUsername(u.username);
    var weak = !u.password || String(u.password).toLowerCase() === String(u.username).toLowerCase() || String(u.password).length < 4;
    var isGen = generic.indexOf(String(u.username).toLowerCase()) !== -1;
    return '<label class="rc-small" style="display:block;padding:3px 0"><input type="checkbox" data-i="' + i + '"' + (exists || isGen ? '' : ' checked') + (exists ? ' disabled' : '') + '> <b>' + rcEsc(u.username) + '</b> (' + rcEsc(u.role || 'staff') + ', ' + rcEsc((u.firstName || '') + ' ' + (u.lastName || '')) + ')' + (exists ? ' - already exists' : '') + (isGen ? ' - <span style="color:#E30613">shared account, not recommended</span>' : '') + (weak && !exists ? ' - <span style="color:#E30613">weak password, reset it after</span>' : '') + '</label>';
  }).join('') + '</div>';
  h += '<button class="rc-b rc-red rc-wide" style="margin-top:8px" onclick="rcRunMigration()">IMPORT NOW</button><div id="rc-mig-log" class="rc-small" style="white-space:pre-line;margin-top:6px"></div>';
  out.innerHTML = h;
}
async function rcRunMigration() {
  var st = RC.migrateState; if (!st) return;
  var log = document.getElementById('rc-mig-log'), say = function (t) { log.textContent += t + '\n'; };
  log.textContent = '';
  if (document.getElementById('rc-mig-data').checked) {
    var map = {
      retail_roster_byFortnight_v1: st.retail_roster_byFortnight_v1,
      retail_roster_requests_v2: st.retail_roster_requests_v2,
      retail_roster_hidden_v1: st.retail_roster_hidden_v1,
      retail_roster_hidden_staff_v1: st.retail_roster_hidden_staff_v1,
      retail_roster_public_holidays_v1: st.retail_roster_public_holidays_v1,
      retail_roster_hidden_shifts_v1: st.retail_roster_hidden_shifts_v1,
      retail_roster_archive_v1: st.retail_roster_archive_v1 || st.repco_archive,
      retail_roster_uploaded_excels_v1: st.retail_roster_uploaded_excels_v1
    };
    RC.allowBulkDelete = true;
    try {
      Object.keys(map).forEach(function (k) {
        if (map[k] === undefined || map[k] === null) return;
        var spec = RC.byKey[k], v = map[k];
        if (Array.isArray(spec.def)) v = rcAsArray(v);
        if (k === 'retail_roster_requests_v2') v = v.filter(function (r) { return r && typeof r === 'object'; }).map(function (r) { if (!r.status) r.status = 'pending'; return r; });
        rcSetLocal(k, v);
        if (k === 'retail_roster_byFortnight_v1') { RC.applying = true; try { sanitizeState(); } finally { RC.applying = false; } }
        rcFlush(spec);
        say('✓ ' + k.replace('retail_roster_', '').replace(/_v\d+$/, ''));
      });
    } finally { RC.allowBulkDelete = false; }
  }
  var users = rcAsArray(st.retail_roster_users_v1);
  var boxes = document.querySelectorAll('#rc-migrate-users input[type=checkbox]:checked');
  for (var b = 0; b < boxes.length; b++) {
    var u = users[parseInt(boxes[b].getAttribute('data-i'), 10)];
    if (!u) continue;
    var role = rcIsMgrRole(u.role) ? String(u.role).toLowerCase() : 'staff';
    try {
      var pw = String(u.password || '');
      if (!pw) { say('✗ ' + u.username + ': no password saved - add them by hand'); continue; }
      await rcCreateAccount(u.username, pw, { firstName: u.firstName || '', lastName: u.lastName || '', role: role, employmentType: u.employmentType || 'casual', isHidden: !!u.isHidden });
      say('✓ login ' + u.username);
    } catch (e) { say('✗ ' + u.username + ': ' + rcErrMsg(e)); }
  }
  say('Done. Check the roster, then reset any weak passwords.');
  toast('Import finished');
}

/* ---------- My Schedule ---------- */
function rcShiftTimes(iso, sh) {
  var p = parseShiftRange(sh); if (!p || !iso) return null;
  var pad = function (n) { return String(n).padStart(2, '0'); };
  // Brisbane has no daylight saving, so +10:00 is always right
  var start = new Date(iso + 'T' + pad(Math.floor(p.start / 60) % 24) + ':' + pad(p.start % 60) + ':00+10:00');
  var end = new Date(start.getTime() + (p.end - p.start) * 60000);
  return { start: start, end: end };
}
function rcDur(ms) {
  var m = Math.max(0, Math.ceil(ms / 60000)), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d) return d + 'd ' + h + 'h';
  if (h) return h + 'h' + (mm ? ' ' + mm + 'm' : '');
  return mm + 'm';
}
function rcOtherRows() {
  var out = [], prof = RC.session && (RC.allUsers[RC.session.uid] || RC.session.profile); if (!prof) return out;
  Object.keys(RC.otherRosters).forEach(function (t) {
    rcMyRows(RC.otherRosters[t], function (fn) { var i = rcStaffForUser(fn, prof); return i === -1 ? null : fn.staff[i]; }).forEach(function (r) { r.team = t; out.push(r); });
  });
  // the same person on another team's roster under another login (e.g. hidden staff there)
  var mine = RC.shared[rcPersonKey(prof)] || {};
  Object.keys(mine).forEach(function (t) {
    if (t === RC.team || RC.otherRosters[t]) return;
    var days = (mine[t] && mine[t].days) || {};
    Object.keys(days).sort().forEach(function (iso) {
      var sh = String(days[iso] || 'OFF'), p = iso.split('-'), dt = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
      var ab = /^(AB|ABSENT)$/i.test(sh.trim()), na = rcIsUAVal(sh);
      out.push({ fn: { id: 'shared-' + t }, i: 0, d: { iso: iso, day: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][dt.getUTCDay()], date: p[2] + '/' + p[1] }, sh: sh, ab: ab, na: na, t: (!ab && !na) ? rcShiftTimes(iso, sh) : null, orig: '', team: t });
    });
  });
  return out;
}
function rcMyRows(fnsIn, finder) {
  var fns = fnsIn || rcAsArray(safeGetJSON('retail_roster_byFortnight_v1', [])), out = [];
  fns.forEach(function (fn) {
    var me = (finder || findMyStaff)(fn); if (!me) return;
    fn.dates.forEach(function (d, i) {
      var sh = (me.shifts && me.shifts[i] != null) ? String(me.shifts[i]) : 'OFF';
      var ab = !!(me.absentApproved && me.absentApproved[i]) || /^(AB|ABSENT)$/i.test(sh.trim());
      var na = !!(me.unavailable && me.unavailable[i]) || rcIsUAVal(sh);
      var t = (!ab && !na) ? rcShiftTimes(d.iso, sh) : null;
      var orig = me.originalShifts && me.originalShifts[i] != null ? String(me.originalShifts[i]) : '';
      out.push({ fn: fn, i: i, d: d, sh: sh, ab: ab, na: na, t: t, orig: (rcIsEmptyVal(orig) || rcIsAbsentVal(orig)) ? '' : orig, mgr: !!((me.cellGreen && me.cellGreen[i]) || (me.cellG && me.cellG[i])) });
    });
  });
  return out;
}
function rcSchedDismissed(key) { try { return localStorage.getItem('repco_sched_dismiss') === key; } catch (e) { return false; } }
function rcSchedUndismiss() { try { localStorage.removeItem('repco_sched_dismiss'); } catch (e) {} renderMySchedule(); }
function rcSchedDismiss(key) { try { localStorage.setItem('repco_sched_dismiss', key); } catch (e) {} renderMySchedule(); }
/* Shift changes are asked for right under the day on My Schedule */
function rcMyPendingChange(fnId, i, date) {
  if (!RC.session) return null;
  var me = RC.session.profile.usernameLower;
  return rcAsArray(safeGetJSON('retail_roster_requests_v2', [])).find(function (q) {
    return q.type === 'shift-correction' && (!q.status || q.status === 'pending') && String(q.username || '').toLowerCase() === me
      && (q.fnId ? q.fnId === fnId && Number(q.shiftIdx) === Number(i) : q.shiftDate === date);
  }) || null;
}
function rcSchedToggle(key) { RC.schedOpen = RC.schedOpen === key ? null : key; renderMySchedule(); }
function rcSchedPanel(r, pend, pastMode) {
  var id = 'ms-ed';
  if (pend) {
    return '<div class="ms-edit" onclick="event.stopPropagation()"><div class="ms-edit-h">You asked for: ' + rcEsc(rcReqSummary(pend)) + '</div><div class="rc-small">Waiting for a manager.</div>'
      + '<div class="rc-btns" style="margin-top:8px"><button class="rc-b rc-white" onclick="rcSchedWithdraw(\'' + rcEsc(rcReqId(pend)) + '\')">WITHDRAW</button><button class="rc-b rc-white" onclick="rcSchedToggle(null)">CLOSE</button></div></div>';
  }
  var p = parseShiftRange(r.sh), pad = function (n) { return String(n).padStart(2, '0'); };
  var st = p ? pad(Math.floor(p.start / 60) % 24) + ':' + pad(p.start % 60) : '', en = p ? pad(Math.floor(p.end / 60) % 24) + ':' + pad(p.end % 60) : '';
  if (pastMode) {
    var rostered = r.t ? fmt(r.sh) : (r.ab ? 'absent' : r.na ? 'unavailable' : 'OFF');
    return '<div class="ms-edit" onclick="event.stopPropagation()">'
      + '<div class="ms-edit-h">Correct ' + rcEsc(r.d.day + ' ' + r.d.date) + ' • rostered ' + rcEsc(rostered) + '</div>'
      + '<div class="rc-small" style="margin-bottom:6px">Enter the times you actually worked.</div>'
      + '<div class="ms-edit-row"><label>Start<input type="time" id="' + id + '-s" value="' + st + '"></label><label>Finish<input type="time" id="' + id + '-e" value="' + en + '"></label></div>'
      + '<input id="' + id + '-r" class="ms-reason" placeholder="Reason (optional)">'
      + '<div class="rc-btns" style="margin-top:8px"><button class="rc-b" onclick="rcSchedSend(\'' + rcEsc(r.fn.id) + '\',' + r.i + ',false)">SEND ACTUAL TIMES</button>'
      + (r.t ? '<button class="rc-b rc-red" onclick="rcSchedSend(\'' + rcEsc(r.fn.id) + '\',' + r.i + ',\'off\')">I DIDN\'T WORK IT</button>' : '')
      + '<button class="rc-b rc-white" onclick="rcSchedToggle(null)">CANCEL</button></div></div>';
  }
  return '<div class="ms-edit" onclick="event.stopPropagation()">'
    + '<div class="ms-edit-h">Change ' + rcEsc(r.d.day + ' ' + r.d.date) + ' • ' + rcEsc(fmt(r.sh)) + '</div>'
    + '<div class="ms-edit-row"><label>Start<input type="time" id="' + id + '-s" value="' + st + '"></label><label>Finish<input type="time" id="' + id + '-e" value="' + en + '"></label></div>'
    + '<input id="' + id + '-r" class="ms-reason" placeholder="Reason (optional)">'
    + '<div class="rc-btns" style="margin-top:8px"><button class="rc-b" onclick="rcSchedSend(\'' + rcEsc(r.fn.id) + '\',' + r.i + ',false)">SEND NEW TIMES</button>'
    + '<button class="rc-b rc-red" onclick="rcSchedSend(\'' + rcEsc(r.fn.id) + '\',' + r.i + ',true)">I CAN\'T WORK IT</button>'
    + '<button class="rc-b rc-white" onclick="rcSchedToggle(null)">CANCEL</button></div></div>';
}
function rcSchedSend(fnId, i, cant) {
  var fn = rcAsArray(safeGetJSON('retail_roster_byFortnight_v1', [])).find(function (f) { return f.id === fnId; });
  var me = fn && findMyStaff(fn); if (!me) { toast('Could not find your roster row'); return; }
  var old = me.shifts[i] || 'OFF', newShift;
  if (cant === 'off') newShift = 'OFF';
  else if (cant) newShift = 'UA';
  else {
    var s = (document.getElementById('ms-ed-s') || {}).value, e = (document.getElementById('ms-ed-e') || {}).value;
    if (!s || !e) { toast('Enter a start and finish time'); return; }
    newShift = s + '-' + e;
    if (newShift === old) { toast('Those are the same times as now'); return; }
  }
  var reason = ((document.getElementById('ms-ed-r') || {}).value || '').trim();
  var all = rcAsArray(safeGetJSON('retail_roster_requests_v2', []));
  all.push({ username: RC.session.profile.username, type: 'shift-correction', fnId: fnId, shiftDate: fn.dates[i].date, shiftIdx: i, oldShift: old, newShift: newShift, reason: reason, status: 'pending', ts: Date.now(), dates: [fn.dates[i].date] });
  RC.schedOpen = null;
  safeSetJSON('retail_roster_requests_v2', all);
  toast(cant ? 'Sent - a manager will review it' : 'Times sent to a manager');
  renderMySchedule();
}
function rcSchedWithdraw(id) {
  var f = rcFindReq(id); if (f.idx === -1) return;
  f.all.splice(f.idx, 1); RC.schedOpen = null;
  safeSetJSON('retail_roster_requests_v2', f.all);
  toast('Request withdrawn'); renderMySchedule();
}
function rcRequestChange(fnId, i) {
  safeSet('retail_roster_currentFortnightId', fnId);
  openPage('requests-page');
  setTimeout(function () {
    var t = document.getElementById('req-type'); if (!t) return;
    t.value = 'shift-correction'; onReqTypeChange();
    var c = document.getElementById('corr-shift-idx'); if (c) c.value = String(i);
  }, 120);
}
renderMySchedule = function () {
  var el = document.getElementById('mysched-list'); if (!el) return;
  try {
    var rows = rcMyRows(), now = Date.now(), today = getISO(), other = rcOtherRows();
    if (!rows.length && !other.length) { el.innerHTML = '<div class="card">Your login isn\'t linked to a roster row yet. Ask a manager to check your first and last name in Account Management.</div>'; return; }
    var both = rows.concat(other), tTag = function (r) { return r.team ? ' • ' + rcTeamName(r.team).toUpperCase() : ''; };
    var current = both.find(function (r) { return r.t && r.t.start.getTime() <= now && now < r.t.end.getTime(); });
    var next = both.filter(function (r) { return r.t && r.t.start.getTime() > now; }).sort(function (a, b) { return a.t.start - b.t.start; })[0];
    var h = '';
    if (current) {
      var pct = Math.min(100, Math.max(0, (now - current.t.start) / (current.t.end - current.t.start) * 100));
      h += '<div class="ms-panel ms-on" data-end="' + current.t.end.getTime() + '" data-start="' + current.t.start.getTime() + '"><div class="ms-kicker">ON SHIFT NOW</div>'
        + '<div class="ms-big"><span class="ms-count">' + rcDur(current.t.end - now) + '</span> to go</div>'
        + '<div class="ms-sub">' + rcEsc(current.d.day + ' ' + current.d.date) + ' • ' + rcEsc(fmt(current.sh)) + ' • finishes ' + rcEsc(fmt(current.sh).split('-')[1] || '') + rcEsc(tTag(current)) + '</div>'
        + '<div class="ms-bar"><div style="width:' + pct.toFixed(1) + '%"></div></div></div>';
    } else if (next) {
      var key = (next.team ? next.team + ':' : '') + next.fn.id + '|' + next.i + '|' + next.sh;
      if (!rcSchedDismissed(key)) {
        h += '<div class="ms-panel ms-next" data-start="' + next.t.start.getTime() + '"><button class="ms-x" title="Hide" onclick="rcSchedDismiss(\'' + rcEsc(key).replace(/'/g, '') + '\')">✕</button><div class="ms-kicker">NEXT SHIFT</div>'
          + '<div class="ms-big">starts in <span class="ms-count">' + rcDur(next.t.start - now) + '</span></div>'
          + '<div class="ms-sub">' + rcEsc(next.d.day + ' ' + next.d.date) + ' • ' + rcEsc(fmt(next.sh)) + (next.d.iso === today ? ' • TODAY' : '') + rcEsc(tTag(next)) + '</div></div>';
      } else {
        h += '<button class="ms-show" onclick="rcSchedUndismiss()">⏱ SHOW COUNTDOWN TO NEXT SHIFT</button>';
      }
    } else {
      h += '<div class="ms-panel ms-none"><div class="ms-kicker">NO UPCOMING SHIFTS</div><div class="ms-sub">Nothing on the roster for you yet.</div></div>';
    }
    h += '<div class="ms-hint">Need a change? Tap a shift. Days already worked this fortnight can be corrected too.</div>';
    var byFn = {}, order = [];
    rows.forEach(function (r) { if (!byFn[r.fn.id]) { byFn[r.fn.id] = []; order.push(r.fn); } byFn[r.fn.id].push(r); });
    order.filter(function (fn) { var last = fn.dates[fn.dates.length - 1]; return last && last.iso >= today; }).slice(0, 2).forEach(function (fn) {
      var list = byFn[fn.id], hrs = 0, n = 0;
      list.forEach(function (r) { if (r.t) { hrs += netH(r.sh); n++; } });
      var isCur = fn.dates.some(function (d) { return d.iso === today; });
      h += '<div class="ms-fn"><div class="ms-fn-head"><span>' + (isCur ? 'THIS FORTNIGHT' : 'NEXT FORTNIGHT') + ' • ' + rcEsc(rcFnRange(fn)) + '</span><span>' + n + ' shifts • ' + hrs.toFixed(1) + 'h</span></div>';
      list.forEach(function (r) {
        var past = r.d.iso < today, isToday = r.d.iso === today, work = !!r.t;
        var cls = 'ms-day' + (isToday ? ' ms-today' : '') + (past ? ' ms-past' : '') + (work ? '' : ' ms-off');
        var right = r.ab ? (r.orig ? '<span class="ms-time ms-struck">' + rcEsc(fmt(r.orig)) + '</span>' : '') + '<span class="ms-tag ms-ab">ABSENT</span>' : r.na ? (r.orig ? '<span class="ms-time ms-struck">' + rcEsc(fmt(r.orig)) + '</span>' : '') + '<span class="ms-tag ms-ua">UNAVAILABLE</span>' : work ? '<span class="ms-time">' + rcEsc(fmt(r.sh)) + '</span>' + (r.mgr ? '<span class="ms-tag">MANAGER</span>' : '') + '<span class="ms-hrs">' + netH(r.sh).toFixed(1) + 'h</span>' : '<span class="ms-offtxt">OFF</span>';
        var started = past || (r.t && r.t.start.getTime() <= now);
        var fixPast = isCur && started;                       // worked (or missed) days in this fortnight can be corrected
        var tap = fixPast || (work && !past && (!r.t || r.t.start.getTime() > now));
        var pend = tap ? rcMyPendingChange(r.fn.id, r.i, r.d.date) : null;
        var key = r.fn.id + '|' + r.i, open = tap && RC.schedOpen === key;
        if (pend) right += '<span class="ms-tag ms-req">CHANGE REQUESTED</span>';
        h += '<div class="' + cls + (tap ? ' ms-tap' + (open ? ' ms-open' : '') + '" onclick="rcSchedToggle(\'' + rcEsc(key) + '\')"' : '"') + '><span class="ms-date"><b>' + rcEsc(r.d.day) + '</b> ' + rcEsc(r.d.date) + (isToday ? ' <span class="ms-tag ms-tt">TODAY</span>' : '') + '</span><span class="ms-right">' + right + (tap ? '<span class="ms-chev">' + (open ? '⌄' : '›') + '</span>' : '') + '</span></div>';
        if (open) h += rcSchedPanel(r, pend, fixPast);
      });
      h += '</div>';
    });
    h += rcOtherTeamsCard(other, today);
    h += rcMyHoursCard(rows, today);
    h += '<div class="card"><button onclick="showMain()" class="rc-b rc-wide">BACK TO ROSTER</button></div>';
    el.innerHTML = h;
    rcStartSchedTicker();
  } catch (e) {
    console.error('my schedule', e);
    el.innerHTML = '<div class="card">Could not show your schedule: ' + rcEsc(e.message) + '</div>';
  }
};
/* Countdowns tick every 15 seconds without redrawing the page */
var _rcSchedTimer = null;
function rcStartSchedTicker() {
  if (_rcSchedTimer) return;
  _rcSchedTimer = setInterval(function () {
    var page = document.getElementById('mysched-page');
    if (!page || !page.classList.contains('show')) { clearInterval(_rcSchedTimer); _rcSchedTimer = null; return; }
    var p = page.querySelector('.ms-panel'); if (!p) return;
    var now = Date.now(), c = p.querySelector('.ms-count');
    if (p.classList.contains('ms-on')) {
      var end = +p.dataset.end, start = +p.dataset.start;
      if (now >= end) { renderMySchedule(); return; }
      if (c) c.textContent = rcDur(end - now);
      var bar = p.querySelector('.ms-bar div'); if (bar) bar.style.width = Math.min(100, (now - start) / (end - start) * 100).toFixed(1) + '%';
    } else if (p.classList.contains('ms-next')) {
      var st = +p.dataset.start;
      if (now >= st) { renderMySchedule(); return; }
      if (c) c.textContent = rcDur(st - now);
    }
  }, 15000);
}

/* ---------- Today's / Tomorrow's Buddies ---------- */
/* Live countdown for one shift: starts in / time left / finished */
function rcBuddyLeft(iso, sh) {
  var t = rcShiftTimes(iso, sh); if (!t) return '';
  return '<span class="bd-left" data-s="' + t.start.getTime() + '" data-e="' + t.end.getTime() + '">' + rcBuddyLeftText(t.start.getTime(), t.end.getTime()) + '</span>';
}
function rcBuddyLeftText(s, e) {
  var now = Date.now();
  if (now < s) return 'starts in ' + rcDur(s - now);
  if (now < e) return '<b>' + rcDur(e - now) + ' left</b>';
  return 'finished';
}
var _rcBudTimer = null;
function rcBuddyTicker() {
  if (_rcBudTimer) return;
  _rcBudTimer = setInterval(function () {
    var open = document.querySelector('#buddies-today-page-v141.show, #buddies-tomorrow-page-v141.show');
    if (!open) { clearInterval(_rcBudTimer); _rcBudTimer = null; return; }
    open.querySelectorAll('.bd-left').forEach(function (el) { el.innerHTML = rcBuddyLeftText(+el.dataset.s, +el.dataset.e); });
  }, 30000);
}
renderBuddies = function (which) {
  var el = document.getElementById(which === 'tomorrow' ? 'buddies-tomorrow-list' : 'buddies-today-list'); if (!el) return;
  try {
    var iso = getISO(); if (which === 'tomorrow') { var t = new Date(iso + 'T12:00:00'); t.setDate(t.getDate() + 1); iso = t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0'); }
    var fns = rcAsArray(safeGetJSON('retail_roster_byFortnight_v1', []));
    var fn = fns.find(function (f) { return (f.dates || []).some(function (d) { return d.iso === iso; }); });
    var tabs = '<div class="rc-tabs"><button class="rc-tab' + (which !== 'tomorrow' ? ' on' : '') + '" onclick="openPage(\'buddies-today-page-v141\')">TODAY</button><button class="rc-tab' + (which === 'tomorrow' ? ' on' : '') + '" onclick="openPage(\'buddies-tomorrow-page-v141\')">TOMORROW</button></div>';
    if (!fn) { el.innerHTML = tabs + '<div class="card">No roster has been uploaded for ' + (which === 'tomorrow' ? 'tomorrow' : 'today') + ' yet.</div>'; return; }
    var i = fn.dates.findIndex(function (d) { return d.iso === iso; }), day = fn.dates[i];
    var me = findMyStaff(fn);
    var mineSh = me ? String(me.shifts[i] || 'OFF') : 'OFF';
    var meOut = !me || (me.unavailable && me.unavailable[i]) || (me.absentApproved && me.absentApproved[i]) || rcIsUAVal(mineSh) || rcIsAbsentVal(mineSh);
    var mine = meOut ? null : parseShiftRange(mineSh);
    var people = (fn.staff || []).filter(function (st) {
      if (st === me || !st.firstName) return false;      // hidden staff do show here: buddies are who you work with
      if ((st.unavailable && st.unavailable[i]) || (st.absentApproved && st.absentApproved[i])) return false;
      return !!parseShiftRange(st.shifts[i]);
    }).map(function (st) {
      var p = parseShiftRange(st.shifts[i]);
      var ov = mine ? Math.max(0, Math.min(mine.end, p.end) - Math.max(mine.start, p.start)) : 0;
      var mgr = (st.cellGreen && st.cellGreen[i]) || isAutoGreenShift(st, st.shifts[i]);
      return { st: st, p: p, ov: ov, mgr: mgr };
    }).filter(function (x) { return !mine || x.ov > 0; }).sort(function (a, b) { return a.p.start - b.p.start || a.p.end - b.p.end; });
    var lo = Math.min.apply(null, people.map(function (x) { return x.p.start; }).concat(mine ? [mine.start] : [])), hi = Math.max.apply(null, people.map(function (x) { return x.p.end; }).concat(mine ? [mine.end] : []));
    if (!isFinite(lo)) { lo = 7 * 60; hi = 18 * 60; }
    lo = Math.floor(lo / 60) * 60; hi = Math.ceil(hi / 60) * 60; if (hi - lo < 240) hi = lo + 240;
    var pct = function (m) { return ((m - lo) / (hi - lo) * 100).toFixed(2) + '%'; };
    var hm = function (m) { var h = Math.floor(m / 60) % 24, mm = m % 60; return (h % 12 || 12) + (mm ? ':' + String(mm).padStart(2, '0') : '') + (h < 12 ? 'am' : 'pm'); };
    var dur = function (m) { return Math.floor(m / 60) + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : ''); };
    var band = mine ? '<div class="bd-me-band" style="left:' + pct(mine.start) + ';width:calc(' + pct(mine.end) + ' - ' + pct(mine.start) + ')"></div>' : '';
    var h = tabs + '<div class="bd-hero"><div class="ms-kicker">' + (which === 'tomorrow' ? 'TOMORROW' : 'TODAY') + '</div><div class="bd-day">' + rcEsc(day.day + ' ' + day.date) + '</div>'
      + '<div class="bd-you">' + (mine ? 'You: <b>' + rcEsc(fmt(mineSh)) + '</b> ' + rcBuddyLeft(day.iso, mineSh) : meOut && me && (rcIsUAVal(mineSh) || rcIsAbsentVal(mineSh) || (me.unavailable && me.unavailable[i]) || (me.absentApproved && me.absentApproved[i])) ? 'You are not working this day' : "You're OFF") + '</div>'
      + '<div class="bd-count">' + (mine ? people.length + (people.length === 1 ? ' buddy' : ' buddies') + ' on with you' : people.length + ' working') + '</div></div>';
    if (!people.length) h += '<div class="card">' + (mine ? 'Nobody else overlaps with your shift.' : 'Nobody is rostered this day.') + '</div>';
    else {
      var ticks = ''; for (var m = lo; m <= hi; m += 120) ticks += '<span style="left:' + pct(m) + '">' + hm(m) + '</span>';
      h += '<div class="bd-list"><div class="bd-axis">' + ticks + '</div>' + people.map(function (x) {
        return '<div class="bd-row"><div class="bd-name"><b>' + rcEsc(x.st.firstName) + '</b> ' + rcEsc(String(x.st.lastName || '').charAt(0).toUpperCase() + String(x.st.lastName || '').slice(1).toLowerCase()) + (x.mgr ? ' <span class="ms-tag" style="background:#1a7f37">MANAGER</span>' : '') + '<span class="bd-time">' + rcEsc(fmt(x.st.shifts[i])) + ' ' + rcBuddyLeft(day.iso, x.st.shifts[i]) + '</span></div>'
          + '<div class="bd-track">' + band + '<div class="bd-bar' + (x.mgr ? ' mgr' : '') + '" style="left:' + pct(x.p.start) + ';width:calc(' + pct(x.p.end) + ' - ' + pct(x.p.start) + ')"></div></div></div>';
      }).join('') + (mine ? '<div class="bd-legend"><span class="bd-key me"></span>your shift <span class="bd-key"></span>their shift</div>' : '') + '</div>';
    }
    h += '<div class="card"><button onclick="showMain()" class="rc-b rc-wide">BACK TO ROSTER</button></div>';
    el.innerHTML = h;
    rcBuddyTicker();
  } catch (e) { console.error('buddies', e); el.innerHTML = '<div class="card">Could not show buddies: ' + rcEsc(e.message) + '</div>'; }
};

/* ---------- Roster photo check (managers): Gemini spots crossed-out / handwritten changes ---------- */
renderOptions = (function (orig) {
  return function () {
    orig.apply(this, arguments);
    if (!rcIsMgr()) return;
    var grid = document.querySelector('#options-inner > div'); if (!grid || document.getElementById('btn-photo-check')) return;
    var b = document.createElement('button');
    b.className = 'card'; b.id = 'btn-photo-check'; b.style.cssText = 'font-weight:900;text-align:left;background:#FFF6CC';
    b.textContent = 'CHECK ROSTER PHOTO'; b.onclick = function () { openPage('photo-check-page'); };
    grid.insertBefore(b, grid.lastElementChild);
  };
})(renderOptions);
function rcEnsurePhotoPage() {
  if (document.getElementById('photo-check-page')) return;
  var p = document.createElement('div'); p.id = 'photo-check-page'; p.className = 'full-page';
  p.innerHTML = '<div class="page-inner"><div class="page-title">CHECK ROSTER PHOTO</div><div id="photo-check-inner"></div></div>';
  document.body.appendChild(p);
}
openPage = (function (orig) {
  return function (id) {
    if (id === 'photo-check-page') { if (!rcIsMgr()) { toast('Admin only'); return; } rcEnsurePhotoPage(); }
    orig.apply(this, arguments);
    if (id === 'photo-check-page') { rcRenderPhotoPage(); setTimeout(rcFitHeader, 0); }
  };
})(openPage);
function rcRenderPhotoPage() {
  var el = document.getElementById('photo-check-inner'); if (!el) return;
  var fn = getSelectedFortnight() || getCurrentFortnight();
  el.innerHTML = '<div class="card"><div class="rc-h">PHOTO OF A PRINTED ROSTER</div>'
    + '<div class="rc-small">Checking against <b>' + rcEsc(fn ? rcFnRange(fn) : 'no roster') + '</b> (the fortnight on the roster screen). Take the photo straight on, with the whole table in frame. Crossed-out, X\'d or handwritten shifts are listed below for you to approve. Nothing changes until you press APPLY.</div>'
    + '<input type="file" id="pc-file" accept="image/*" style="margin-top:10px;width:100%">'
    + '<img id="pc-preview" style="display:none;width:100%;max-height:320px;object-fit:contain;background:#f3f3f3;margin-top:10px;border:2px solid #111;border-radius:10px">'
    + '<button class="rc-b rc-red rc-wide" id="pc-go" style="margin-top:10px" onclick="rcScanPhoto()" disabled>CHECK PHOTO</button>'
    + '<div class="rc-small" style="margin-top:6px;color:#777">The photo is sent to Google Gemini to read it. On the free tier Google may use it to improve its products.</div></div>'
    + '<div id="pc-results"></div><div class="card"><button onclick="showMain()" class="rc-b rc-wide">← BACK TO ROSTER</button></div>';
  var f = document.getElementById('pc-file');
  f.onchange = function () {
    var file = f.files && f.files[0]; if (!file) return;
    var img = document.getElementById('pc-preview'); img.src = URL.createObjectURL(file); img.style.display = 'block';
    document.getElementById('pc-go').disabled = false; document.getElementById('pc-results').innerHTML = '';
  };
}
/* Shrink big phone photos so they upload quickly (text stays readable at 2400px) */
function rcPhotoToJpeg(file) {
  return new Promise(function (res, rej) {
    var img = new Image();
    img.onload = function () {
      var k = Math.min(1, 2400 / Math.max(img.width, img.height));
      var c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      res(c.toDataURL('image/jpeg', 0.88).split(',')[1]);
    };
    img.onerror = function () { rej(new Error('That file is not a photo this browser can read')); };
    img.src = URL.createObjectURL(file);
  });
}
function rcNameKey(s) { return String(s || '').toUpperCase().replace(/[^A-Z]/g, ''); }
async function rcScanPhoto() {
  var file = (document.getElementById('pc-file').files || [])[0]; if (!file) return;
  var fn = getSelectedFortnight() || getCurrentFortnight(); if (!fn) { toast('No roster to check against'); return; }
  var out = document.getElementById('pc-results'), go = document.getElementById('pc-go');
  go.disabled = true; go.textContent = 'READING PHOTO... (can take up to a minute)';
  out.innerHTML = '';
  try {
    var image = await rcPhotoToJpeg(file);
    var roster = {
      dates: fn.dates.map(function (d) { return d.day + ' ' + d.date; }),
      rows: fn.staff.map(function (st) { return { name: String(st.lastName || '').toUpperCase() + ', ' + st.firstName, shifts: st.shifts.map(function (v) { return rcIsEmptyVal(v) ? 'OFF' : String(v); }) }; })
    };
    var token = await RC.auth.currentUser.getIdToken();
    var r = await fetch(RC_PUSH_WORKER_URL.replace(/\/$/, '') + '/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token, image: image, mime: 'image/jpeg', roster: roster, team: RC.team }) });
    var res = await r.json().catch(function () { return { error: 'the relay answered ' + r.status }; });
    if (res.error) throw new Error(res.error);
    rcShowPhotoResults(fn, res.changes || [], res.service, res.weak);
  } catch (e) {
    out.innerHTML = '<div class="card"><b style="color:#E30613">Could not check the photo:</b> ' + rcEsc(e.message || e) + '</div>';
  } finally { go.disabled = false; go.textContent = 'CHECK PHOTO'; }
}
function rcShowPhotoResults(fn, changes, service, weak) {
  var out = document.getElementById('pc-results');
  var byName = {}; fn.staff.forEach(function (st, i) { byName[rcNameKey(st.lastName + st.firstName)] = i; byName[rcNameKey(st.firstName + st.lastName)] = i; });
  var items = [], skipped = [];
  changes.forEach(function (c) {
    var row = byName[rcNameKey(c.name)];
    var dm = String(c.date || '').match(/(\d{1,2})\/(\d{1,2})/);
    var col = dm ? fn.dates.findIndex(function (d) { return d.date === dm[1].padStart(2, '0') + '/' + dm[2].padStart(2, '0'); }) : -1;
    if (row === undefined || col === -1) { skipped.push(c); return; }
    var st = fn.staff[row], cur = String(st.shifts[col] || 'OFF');
    var photo = /^off$/i.test(String(c.photo || '').trim()) || !String(c.photo || '').trim() ? 'OFF' : (rcCleanShift(c.photo) || String(c.photo).trim().toUpperCase());
    if ((rcIsEmptyVal(cur) && photo === 'OFF') || cur === photo) return;
    items.push({ row: row, col: col, st: st, cur: cur, photo: photo, mark: c.mark || 'different', conf: weak ? 0 : (typeof c.confidence === 'number' ? c.confidence : 0.5) });
  });
  RC.photoItems = items; RC.photoFn = fn.id;
  var mk = { crossed: 'crossed out', written: 'written in', different: 'differs' };
  var h = '<div class="card"><div class="rc-h">' + (items.length ? items.length + ' CHANGE' + (items.length > 1 ? 'S' : '') + ' FOUND' : 'NO CHANGES FOUND') + '</div>';
  if (!items.length) h += '<div class="rc-small">The photo matches the roster, or no hand-made changes could be read. Check a few cells yourself if you expected changes.</div>';
  h += items.map(function (it, k) {
    return '<label class="pc-item"><input type="checkbox" id="pc-c-' + k + '"' + (it.conf >= 0.6 ? ' checked' : '') + '>'
      + '<span class="pc-who"><b>' + rcEsc(String(it.st.lastName).toUpperCase() + ', ' + it.st.firstName) + '</b><br><span class="rc-small">' + rcEsc(fn.dates[it.col].day + ' ' + fn.dates[it.col].date) + ' • ' + rcEsc(mk[it.mark] || it.mark) + (it.conf < 0.6 ? ' • <span style="color:#E30613">not sure</span>' : '') + '</span></span>'
      + '<span class="pc-vals"><span class="pc-cur">' + rcEsc(rcShiftText(it.cur)) + '</span> → <input id="pc-v-' + k + '" value="' + rcEsc(it.photo) + '"></span></label>';
  }).join('');
  if (items.length) h += '<button class="rc-b rc-red rc-wide" style="margin-top:10px" onclick="rcApplyPhoto()">APPLY TICKED CHANGES</button>';
  if (service) h += '<div class="rc-small" style="margin-top:8px;color:#777">Read by ' + rcEsc(service) + (weak ? ' - this last-resort reader often gets cells wrong, so nothing is ticked: check each one against the photo.' : '') + '</div>';
  if (skipped.length) h += '<div class="rc-small" style="margin-top:10px;color:#777">Couldn\'t match to the roster: ' + skipped.map(function (c) { return rcEsc((c.name || '?') + ' ' + (c.date || '?') + ' ' + (c.photo || '')); }).join('; ') + '</div>';
  out.innerHTML = h + '</div>';
}
function rcApplyPhoto() {
  var items = RC.photoItems || [], n = 0;
  items.forEach(function (it, k) {
    var box = document.getElementById('pc-c-' + k); if (!box || !box.checked) return;
    var v = (document.getElementById('pc-v-' + k) || {}).value; v = String(v || '').trim();
    if (/^off$/i.test(v)) v = 'OFF';
    rcSaveCell(RC.photoFn, it.row, it.col, v === '' ? 'OFF' : v); n++;
  });
  toast(n ? n + ' change' + (n > 1 ? 's' : '') + ' applied' : 'Nothing ticked');
  if (n) { safeSet('retail_roster_currentFortnightId', RC.photoFn); showMain(); }
}

/* ---------- Excel export: the uploaded file itself, with the roster's edits written into it ---------- */
renderImportExportPage = (function (orig) {
  return function () {
    orig.apply(this, arguments);
    var csv = document.getElementById('btn-export-csv'); if (!csv || document.getElementById('btn-export-xlsx')) return;
    var b = document.createElement('button');
    b.id = 'btn-export-xlsx'; b.textContent = 'EXPORT EXCEL (.xlsx)'; b.onclick = rcExportExcel;
    b.style.cssText = 'background:#E30613;color:#fff;border:none;border-radius:9999px;padding:8px 14px;font-weight:900';
    csv.parentNode.insertBefore(b, csv);
  };
})(renderImportExportPage);
function rcLoadScript(src) {
  return new Promise(function (res, rej) { var sc = document.createElement('script'); sc.src = src; sc.onload = res; sc.onerror = function () { rej(new Error('could not load ' + src)); }; document.head.appendChild(sc); });
}
function rcB64ToBuf(b64) { var bin = atob(b64), a = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a.buffer; }
/* Split "LAST, First" / "LAST First" the same way the importer does */
function rcSheetNameKey(raw) {
  var n = String(raw || '').trim(); if (!n) return '';
  var last, first;
  if (n.indexOf(',') !== -1) { var parts = n.split(','); last = parts[0]; first = parts.slice(1).join(','); }
  else { var t = n.split(/\s+/); if (t.length < 2) return ''; last = t[0]; first = t.slice(1).join(' '); }
  return rcNameKey(String(first).trim() + String(last).trim());
}
/* What a roster cell should look like in the spreadsheet: two time cells, or a code, or empty */
function rcSheetCells(st, i) {
  var sh = String((st.shifts || [])[i] == null ? 'OFF' : st.shifts[i]).trim();
  if ((st.absentApproved && st.absentApproved[i]) || rcIsAbsentVal(sh)) return ['AB', null];
  if ((st.unavailable && st.unavailable[i]) || rcIsUAVal(sh)) return ['UA', null];
  var p = parseShiftRange(sh);
  if (!p) return rcIsEmptyVal(sh) ? [null, null] : [sh, null];
  var t = function (m) { return new Date(Date.UTC(1899, 11, 30, Math.floor(m / 60) % 24, m % 60)); };
  return [t(p.start), t(p.end)];
}
function rcSameCell(a, b) {
  var norm = function (v) { if (v && v.result !== undefined && v.formula === undefined) v = v.result; if (v instanceof Date) return 'd' + Math.round(((v.getTime() % 86400000) + 86400000) % 86400000 / 60000); if (v === '' || v === undefined) v = null; return v === null ? null : String(v).trim().toUpperCase(); };
  return norm(a) === norm(b);
}
async function rcExportExcel() {
  var fn = getSelectedFortnight() || getCurrentFortnight(); if (!fn) { toast('No roster'); return; }
  var ups = rcAsArray(safeGetJSON('retail_roster_uploaded_excels_v1', [])).filter(function (u) { return u && u.data; });
  var tpl = ups.filter(function (u) { return u.fortnightId === fn.id; }).pop() || ups.slice().sort(function (a, b) { return (a.ts || 0) - (b.ts || 0); }).pop();
  if (!tpl) { toast('No uploaded Excel to use as the template - export CSV instead'); return; }
  toast('Building Excel...');
  try {
    if (!window.ExcelJS) await rcLoadScript('https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js');
    var wb = new ExcelJS.Workbook();
    await wb.xlsx.load(rcB64ToBuf(tpl.data));
    var ws = wb.worksheets[0];
    var sameFn = tpl.fortnightId === fn.id;
    if (!sameFn) {
      // another fortnight's file: put this fortnight's dates and day names in the header rows
      fn.dates.forEach(function (d, i) {
        var c = 2 + i * 2, p = d.iso.split('-');
        ws.getCell(1, c).value = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
        var names = { SUN: 'SUNDAY', MON: 'MONDAY', TUE: 'TUESDAY', WED: 'WEDNESDAY', THU: 'THURSDAY', FRI: 'FRIDAY', SAT: 'SATURDAY' };
        var dc = ws.getCell(2, c); if (dc.value) dc.value = names[d.day] || d.day;
      });
    }
    var byKey = {}; fn.staff.forEach(function (st) { if (!isHiddenStaffRow(st)) byKey[rcNameKey(st.firstName + st.lastName)] = st; });
    var changed = 0, matched = {};
    for (var r = 3; r <= ws.rowCount; r++) {
      var row = ws.getRow(r), rowText = [];
      row.eachCell({ includeEmpty: false }, function (c) { if (typeof c.value === 'string') rowText.push(c.value); });
      if (rcMainTeam() && /\bkate\b/i.test(rowText.join(' '))) continue;               // notes row
      var key = rcSheetNameKey(ws.getCell(r, 1).value); if (!key) continue;
      var st = byKey[key]; if (!st) continue;
      matched[key] = 1;
      fn.dates.forEach(function (d, i) {
        var want = rcSheetCells(st, i);
        [0, 1].forEach(function (k) {
          var cell = ws.getCell(r, 2 + i * 2 + k);
          if (rcSameCell(cell.value, want[k])) return;
          cell.value = want[k];
          changed++;
        });
      });
    }
    wb.calcProperties = Object.assign({}, wb.calcProperties, { fullCalcOnLoad: true });   // TOTAL HOURS recalculates in Excel
    var missing = Object.keys(byKey).filter(function (k) { return !matched[k]; }).map(function (k) { var st = byKey[k]; return st.firstName + ' ' + st.lastName; });
    var buf = await wb.xlsx.writeBuffer();
    var blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = sameFn ? tpl.name : ('Roster ' + rcFnRange(fn).replace(/\//g, '.').replace(/\s/g, '') + '.xlsx');
    a.click();
    toast('Excel exported - ' + changed + ' cell' + (changed === 1 ? '' : 's') + ' updated' + (missing.length ? '. Not in the file: ' + missing.join(', ') : ''));
  } catch (e) { console.error('xlsx export', e); toast('Excel export failed: ' + (e.message || e)); }
}

/* ---------- Drafts: managers can keep a fortnight hidden from staff until it's published ---------- */
function rcDraftBar() {
  var old = document.getElementById('rc-draft-bar'); if (old) old.remove();
  if (!rcIsMgr() || RC.pdfMode) return;
  var fn = getSelectedFortnight(); if (!fn) return;
  var mount = document.getElementById('roster-mount'); if (!mount) return;
  var bar = document.createElement('div'); bar.id = 'rc-draft-bar';
  if (fn.draft) {
    bar.className = 'rc-draft on';
    bar.innerHTML = '<span><b>DRAFT</b> - staff can\'t see this fortnight yet</span><button class="rc-b rc-green" onclick="rcPublishFn(true)">PUBLISH TO STAFF</button>';
  } else {
    bar.className = 'rc-draft';
    bar.innerHTML = '<span>Published - staff can see this fortnight</span><button class="rc-b rc-white" onclick="rcPublishFn(false)">MAKE DRAFT</button>';
  }
  mount.parentNode.insertBefore(bar, mount);
}
function rcPublishFn(publish) {
  var fn = getSelectedFortnight(); if (!fn) return;
  var go = function () {
    if (RC.importDraftIds) delete RC.importDraftIds[fn.id];
    var upd = {}; upd[rcTP('data/roster/' + rcEncodeKey(fn.id) + '/draft')] = publish ? null : true;
    rcLogHistory(upd, { fnId: fn.id, fn: rcFnRange(fn), action: publish ? 'Roster published' : 'Roster made draft' });
    rcSave(upd).then(function () {
      toast(publish ? 'Published - staff can see it now' : 'Now a draft - hidden from staff');
      if (!publish) return;
      var who = {};
      fn.staff.forEach(function (st) { if (st.shifts.some(function (v) { return !!parseShiftRange(v); })) rcUsersForStaff(st).forEach(function (u) { if (u.uid !== RC.session.uid) who[u.uid] = 1; }); });
      if (Object.keys(who).length) rcNotify(Object.keys(who), { type: 'roster-new', title: 'New roster published', body: rcFnRange(fn) + ' is now on the roster.' });
    }).catch(function (e) { toast('Not changed: ' + rcErrMsg(e)); });
  };
  if (publish) go();
  else showCustomConfirm('Make this fortnight a draft?', 'Staff will stop seeing ' + rcEsc(rcFnRange(fn)) + ' until you publish it again.', function (ok) { if (ok) go(); });
}
renderImportExportPage = (function (orig) {
  return function () {
    orig.apply(this, arguments);
    var f = document.getElementById('excel-file-input'); if (!f || document.getElementById('rc-import-draft')) return;
    var l = document.createElement('label'); l.className = 'rc-keep'; l.style.margin = '10px 0 0';
    l.innerHTML = '<input type="checkbox" id="rc-import-draft" onchange="RC.importDraftPick=this.checked"' + (RC.importDraftPick ? ' checked' : '') + '> Import as a draft (staff won\'t see it until you publish)';
    f.parentNode.insertBefore(l, f.nextSibling);
  };
})(renderImportExportPage);
importExcelFile = (function (orig) {
  return function () {
    if (RC.importDraftPick && document.getElementById('rc-import-draft')) {
      RC.importDraft = true; RC.importDraftPick = false;
      setTimeout(function () { RC.importDraft = false; RC.importDraftIds = {}; }, 15000);
    }
    return orig.apply(this, arguments);
  };
})(importExcelFile);

/* ---------- Teams: switcher, the TEAMS page (masters) ---------- */
rcMigrationCardHtml = (function (orig) { return function () { return RC.team === 'main' ? orig.apply(this, arguments) : ''; }; })(rcMigrationCardHtml);
renderAccountMgmtPage = (function (orig) {
  return function () {
    var el = document.getElementById('account-mgmt-inner'); if (!el || !RC.session) return orig.apply(this, arguments);
    if (!rcCanManageAccounts()) {
      el.innerHTML = '<div class="card"><div class="rc-h">' + rcEsc(rcTeamName(RC.team).toUpperCase()) + '</div><div class="rc-small">Logins are looked after by masters and this team\'s managers.</div></div>' + rcBorrowCardHtml();
      return;
    }
    orig.apply(this, arguments);
    if (!document.getElementById('rc-borrow-card')) { var first = el.querySelector('.card'); if (first) first.insertAdjacentHTML('afterend', rcBorrowCardHtml()); }
    if (!rcIsOwner()) rcLimitAccountsForManager(el);
    var top = '';
    if (rcTeamIds().length > 1) top += '<div class="card rc-small">Showing logins in <b>' + rcEsc(rcTeamName(RC.team)) + '</b>. New users you add here join this team.</div>';
    if (top) el.insertAdjacentHTML('afterbegin', top);
  };
})(renderAccountMgmtPage);
function rcPickTeam() {
  var mine = RC.allUsers[RC.session.uid] || RC.session.profile;
  var ids = rcTeamsFor(RC.session.uid, mine); if (ids.length < 2) return;
  var names = ids.map(function (t) { return rcTeamName(t) + (t === RC.team ? '  (open now)' : ''); });
  showCustomSelect('Open which team?', names, function (pick) { if (pick === null || pick === undefined) return; var t = ids[names.indexOf(pick)]; if (t) rcSwitchTeam(t); });
}
function rcTeamPill() {
  var ctl = document.querySelector('#repco-v65 .r-controls') || document.querySelector('.r-controls'); if (!ctl || !RC.session) return;
  var mine = RC.allUsers[RC.session.uid] || RC.session.profile;
  var multi = rcTeamsFor(RC.session.uid, mine).length > 1;
  var b = document.getElementById('rc-team-btn');
  if (!multi) { if (b) b.remove(); return; }
  if (!b) { b = document.createElement('button'); b.id = 'rc-team-btn'; b.onclick = rcPickTeam; ctl.insertBefore(b, ctl.firstChild); }
  b.textContent = rcTeamName(RC.team).toUpperCase() + ' ▾';
}
renderOptions = (function (orig) {
  return function () {
    orig.apply(this, arguments);
    var grid = document.querySelector('#options-inner > div'); if (!grid || !RC.session) return;
    var mine = RC.allUsers[RC.session.uid] || RC.session.profile;
    var add = function (id, text, fn, bg) {
      if (document.getElementById(id)) return;
      var b = document.createElement('button'); b.className = 'card'; b.id = id; b.style.cssText = 'font-weight:900;text-align:left' + (bg ? ';background:' + bg : '');
      b.textContent = text; b.onclick = fn; grid.insertBefore(b, grid.lastElementChild);
    };
    if (rcTeamsFor(RC.session.uid, mine).length > 1) add('btn-switch-team', 'SWITCH TEAM (NOW: ' + rcTeamName(RC.team).toUpperCase() + ')', rcPickTeam);
    if (rcIsOwner()) add('btn-teams', 'TEAMS', function () { openPage('teams-page'); }, '#FFE9EA');
  };
})(renderOptions);
openPage = (function (orig) {
  return function (id) {
    if (id === 'teams-page') {
      if (!rcIsOwner()) { toast('Masters only'); return; }
      if (!document.getElementById('teams-page')) {
        var p = document.createElement('div'); p.id = 'teams-page'; p.className = 'full-page';
        p.innerHTML = '<div class="page-inner"><div class="page-title">TEAMS</div><div id="teams-inner"></div></div>';
        document.body.appendChild(p);
      }
    }
    orig.apply(this, arguments);
    if (id === 'teams-page') { rcRenderTeamsPage(); setTimeout(rcFitHeader, 0); }
  };
})(openPage);
function rcRenderTeamsPage() {
  var el = document.getElementById('teams-inner'); if (!el || !rcIsOwner()) return;
  var ids = rcTeamIds(), all = RC.allUsers;
  var count = function (t) { return Object.keys(all).filter(function (k) { return rcHomeTeam(all[k]) === t; }).length; };
  var h = '<div class="card"><div class="rc-h">TEAMS</div><div class="rc-small">Each team has its own staff, managers, rosters, requests and history. Nobody sees another team unless you tick them below.</div>';
  ids.forEach(function (t) {
    h += '<div class="tm-row"><input id="tm-name-' + rcEsc(t) + '" value="' + rcEsc(rcTeamName(t)) + '" class="rc-to-in" style="margin:0;flex:1"><span class="rc-small" style="white-space:nowrap">' + count(t) + ' logins</span>'
      + '<button class="rc-b rc-white" onclick="rcRenameTeam(\'' + t + '\')">SAVE</button>'
      + (t === RC.team ? '<span class="rc-pill">OPEN</span>' : '<button class="rc-b" onclick="rcSwitchTeam(\'' + t + '\')">OPEN</button>') + '</div>';
  });
  h += '<div class="tm-row" style="margin-top:10px"><input id="tm-new" class="rc-to-in" style="margin:0;flex:1" placeholder="New team name"><button class="rc-b rc-red" onclick="rcAddTeam()">ADD TEAM</button></div>';
  h += '<div class="rc-small" style="margin-top:8px">To set up a new team: ADD TEAM, OPEN it, then add its admins, managers and staff in Account Management. Then upload its Excel or press + NEW FORTNIGHT on the roster.</div></div>';
  // people: masters see every team; everyone else belongs to one team
  h += '<div class="card"><div class="rc-h">PEOPLE IN EACH TEAM</div><div class="rc-small">Masters see and run every team. Everyone else sees only their own team (plus any team that has borrowed them, as staff). To give someone both teams, make them a master in Account Management.</div>';
  var users = Object.keys(all).map(function (k) { return Object.assign({ uid: k }, all[k]); });
  var rank = { master: 0, manager: 1, admin: 2 };
  ids.forEach(function (home) {
    var list = users.filter(function (u) { return rcHomeTeam(u) === home; }).sort(function (a, b) { return ((rank[rcRoleOf(a)] === undefined ? 3 : rank[rcRoleOf(a)]) - (rank[rcRoleOf(b)] === undefined ? 3 : rank[rcRoleOf(b)])) || String(a.username).localeCompare(String(b.username)); });
    if (!list.length) return;
    h += '<div class="tm-team">' + rcEsc(rcTeamName(home).toUpperCase()) + '</div>';
    list.forEach(function (u) {
      h += '<div class="tm-user"><div><b>' + rcEsc(u.username) + '</b> <span class="rc-pill">' + rcEsc(u.role) + '</span><br><span class="rc-small">' + rcEsc(((u.firstName || '') + ' ' + (u.lastName || '')).trim()) + '</span></div><div class="tm-acc">';
      if (rcRoleOf(u) === 'master') h += '<span class="rc-small"><b>Master</b> - every team</span>';
      h += '<select class="tm-move" onchange="rcMoveUser(\'' + u.uid + '\',this.value,this)">' + ids.map(function (t) { return '<option value="' + rcEsc(t) + '"' + (t === home ? ' selected' : '') + '>' + (t === home ? 'In ' : 'Move to ') + rcEsc(rcTeamName(t)) + '</option>'; }).join('') + '</select>';
      h += '</div></div>';
    });
  });
  if (ids.length < 2) h += '<div class="rc-small" style="margin-top:8px">Add a second team first.</div>';
  el.innerHTML = h + '</div>';
}
function rcAddTeam() {
  var n = (document.getElementById('tm-new') || {}).value; n = String(n || '').trim();
  if (!n) { toast('Type a name for the team'); return; }
  if (rcTeamIds().some(function (t) { return rcTeamName(t).toLowerCase() === n.toLowerCase(); })) { toast('There is already a team called ' + n); return; }
  var id = 't' + Date.now().toString(36);
  RC.db.ref('teamInfo/' + id).set({ name: n, createdTs: firebase.database.ServerValue.TIMESTAMP, by: RC.session.profile.username })
    .then(function () { toast('Added ' + n); }).catch(function (e) { toast('Not added: ' + rcErrMsg(e)); });
}
function rcRenameTeam(t) {
  var n = String((document.getElementById('tm-name-' + t) || {}).value || '').trim(); if (!n) { toast('Name can\'t be empty'); return; }
  RC.db.ref('teamInfo/' + t + '/name').set(n).then(function () { toast('Saved'); }).catch(function (e) { toast('Not saved: ' + rcErrMsg(e)); });
}
function rcMoveUser(uid, t, sel) {
  var u = RC.allUsers[uid]; if (!u) return;
  showCustomConfirm('Move ' + rcEsc(u.username) + '?', 'They will belong to <b>' + rcEsc(rcTeamName(t)) + '</b> and stop seeing ' + rcEsc(rcTeamName(rcHomeTeam(u))) + '. Their shifts on old rosters stay where they are.', function (ok) {
    if (!ok) { rcRenderTeamsPage(); return; }
    var upd = {}; upd['users/' + uid + '/team'] = t === 'main' ? null : t;
    RC.db.ref().update(upd).then(function () { toast('Moved'); }).catch(function (e) { toast('Not moved: ' + rcErrMsg(e)); rcRenderTeamsPage(); });
  });
}

/* ---------- Borrowed staff: someone from another team on this team's roster ---------- */
function rcOtherTeamsCard(other, today) {
  var up = other.filter(function (r) { return r.d.iso >= today && (r.t || r.ab || r.na); }).sort(function (a, b) { return a.d.iso < b.d.iso ? -1 : a.d.iso > b.d.iso ? 1 : 0; }).slice(0, 14);
  if (!other.length) return '';
  var h = '<div class="card"><div class="rc-h">YOUR SHIFTS IN OTHER TEAMS</div>';
  if (!up.length) h += '<div class="rc-small">Nothing coming up.</div>';
  up.forEach(function (r) {
    var right = r.ab ? '<span class="ms-tag ms-ab">ABSENT</span>' : r.na ? '<span class="ms-tag">UNAVAILABLE</span>' : '<span class="ms-time">' + rcEsc(fmt(r.sh)) + '</span>';
    h += '<div class="ms-day' + (r.d.iso === today ? ' ms-today' : '') + '"><span class="ms-date"><b>' + rcEsc(r.d.day) + '</b> ' + rcEsc(r.d.date) + ' <span class="rc-pill">' + rcEsc(rcTeamName(r.team)) + '</span></span>' + right + '</div>';
  });
  return h + '<div class="rc-small" style="margin-top:6px">Changes and requests for these shifts go through that team' + (rcTeamsFor(RC.session.uid, RC.allUsers[RC.session.uid] || RC.session.profile).length > 1 ? ' - use the team button on the roster to open it.' : '.') + '</div></div>';
}
function rcBorrowCardHtml() {
  if (!rcIsManagerUp() || rcTeamIds().length < 2) return '';
  var here = RC.guests[RC.team] || {}, all = RC.allUsers;
  var guests = Object.keys(here).filter(function (k) { return here[k] === true && all[k]; });
  var pool = Object.keys(all).filter(function (k) { return rcHomeTeam(all[k]) !== RC.team && !here[k] && all[k].firstName && all[k].lastName; })
    .sort(function (a, b) { return (rcHomeTeam(all[a]) + all[a].lastName).localeCompare(rcHomeTeam(all[b]) + all[b].lastName); });
  var h = '<div class="card" id="rc-borrow-card"><div class="rc-h">BORROWED FROM OTHER TEAMS</div><div class="rc-small">Put someone from another team on this team\'s roster. They get a row here (from this fortnight on), shift offers and alerts from this team, and see these shifts on their own My Schedule. They see this team as staff only.</div>';
  h += guests.length ? guests.map(function (k) {
    var u = all[k];
    return '<div class="rc-row"><div><b>' + rcEsc(u.firstName + ' ' + u.lastName) + '</b><br><span class="rc-small">from ' + rcEsc(rcTeamName(rcHomeTeam(u))) + '</span></div><div class="rc-btns"><button class="rc-b" onclick="rcUnborrow(\'' + k + '\')">REMOVE</button></div></div>';
  }).join('') : '<div class="rc-small" style="margin-top:6px"><i>Nobody borrowed.</i></div>';
  if (pool.length) h += '<div class="tm-row" style="margin-top:8px"><select id="rc-borrow-pick" class="tm-move" style="flex:1;font-size:13px;padding:8px" onchange="RC.borrowPick=this.value">' + pool.map(function (k) { var u = all[k]; return '<option value="' + k + '"' + (k === RC.borrowPick ? ' selected' : '') + '>' + rcEsc(u.firstName + ' ' + u.lastName) + ' (' + rcEsc(rcTeamName(rcHomeTeam(u))) + ')</option>'; }).join('') + '</select><button class="rc-b rc-red" onclick="rcBorrow()">ADD TO ROSTER</button></div>';
  return h + '</div>';
}
function rcRowFor(u, len, from) { return { firstName: u.firstName, lastName: u.lastName, role: 'staff', employmentType: u.employmentType || 'casual', shifts: Array(len).fill('OFF'), unavailable: Array(len).fill(false), guestFrom: from || rcHomeTeam(u) }; }
function rcBorrow() {
  var uid = (document.getElementById('rc-borrow-pick') || {}).value, u = RC.allUsers[uid]; if (!u) return;
  RC.borrowPick = null;
  var today = getISO(), cur = getCurrentFortnight();
  var fns = rcAsArray(safeGetJSON('retail_roster_byFortnight_v1', [])), added = 0;
  var nameOf = function (s) { return (String(s.firstName || '') + ' ' + String(s.lastName || '')).trim().toLowerCase(); }, me = nameOf(u);
  fns.forEach(function (fn) {
    var last = fn.dates[fn.dates.length - 1];
    if (!last || last.iso < today) return;            // this fortnight and later only
    if ((fn.staff || []).some(function (st) { return nameOf(st) === me; })) return;
    fn.staff.push(rcRowFor(u, fn.dates.length)); fn.staff.sort(rcStaffSort); added++;
  });
  var upd = {}; upd['guests/' + RC.team + '/' + uid] = true;
  RC.db.ref().update(upd).then(function () {
    if (added) safeSetJSON('retail_roster_byFortnight_v1', fns);
    renderRosterSafe();
    rcNotify([uid], { type: 'borrowed', title: 'Added to ' + rcTeamName(RC.team), body: 'You are now on the ' + rcTeamName(RC.team) + ' roster. Your shifts there show on My Schedule.' });
    toast(u.firstName + ' added to ' + added + ' roster' + (added === 1 ? '' : 's'));
    renderAccountMgmtPage();
  }).catch(function (e) { toast('Not added: ' + rcErrMsg(e)); });
}
function rcUnborrow(uid) {
  var u = RC.allUsers[uid]; if (!u) return;
  showCustomConfirm('Remove ' + rcEsc(u.firstName + ' ' + u.lastName) + '?', 'They stop seeing this team. Their empty rows on future rosters are removed; rows with shifts stay so nothing is lost - clear those first if they shouldn\'t be there.', function (ok) {
    if (!ok) return;
    var today = getISO(), me = (u.firstName + ' ' + u.lastName).toLowerCase(), changed = false;
    var fns = rcAsArray(safeGetJSON('retail_roster_byFortnight_v1', []));
    fns.forEach(function (fn) {
      if (!fn.dates[0] || fn.dates[0].iso <= today) return;
      var before = fn.staff.length;
      fn.staff = fn.staff.filter(function (st) { return !((String(st.firstName) + ' ' + String(st.lastName)).toLowerCase() === me && (st.shifts || []).every(function (v) { return rcIsEmptyVal(v); })); });
      if (fn.staff.length !== before) changed = true;
    });
    var upd = {}; upd['guests/' + RC.team + '/' + uid] = null;
    RC.db.ref().update(upd).then(function () { if (changed) safeSetJSON('retail_roster_byFortnight_v1', fns); renderRosterSafe(); toast('Removed'); renderAccountMgmtPage(); }).catch(function (e) { toast('Not removed: ' + rcErrMsg(e)); });
  });
}
/* Borrowed people appear on the roster with their team's name */
function rcGuestTags() {
  var fn = getSelectedFortnight(); if (!fn) return;
  (fn.staff || []).forEach(function (st, r) {
    if (!st.guestFrom || st.guestFrom === RC.team) return;
    var cell = document.querySelector('#roster-mount tr td[data-r="' + r + '"]'); var row = cell && cell.parentNode;
    var name = row && row.querySelector('td:first-child'); if (!name || name.querySelector('.rc-guest')) return;
    name.insertAdjacentHTML('beforeend', ' <span class="rc-guest">' + rcEsc(rcTeamName(st.guestFrom)) + '</span>');
  });
  document.querySelectorAll('.dv-row').forEach(function (el) {
    var r = parseInt(el.getAttribute('data-r'), 10), st = fn.staff[r];
    if (!st || !st.guestFrom || st.guestFrom === RC.team || el.querySelector('.rc-guest')) return;
    var nm = el.querySelector('.dv-name') || el.firstElementChild; if (nm) nm.insertAdjacentHTML('beforeend', ' <span class="rc-guest">' + rcEsc(rcTeamName(st.guestFrom)) + '</span>');
  });
}

/* ---------- Start a fresh (empty) roster for the next fortnight ---------- */
function rcIsoAdd(iso, n) { var p = iso.split('-'); var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n)); return d.toISOString().slice(0, 10); }
function rcFreshDates(startIso) {
  var out = [];
  for (var i = 0; i < 14; i++) {
    var iso = rcIsoAdd(startIso, i), p = iso.split('-'), d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    out.push({ day: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][d.getUTCDay()], date: p[2] + '/' + p[1], iso: iso });
  }
  return out;
}
function rcFreshStart(fns) {
  var today = getISO(), cur = getCurrentFortnight(), start;
  var lastEnd = ''; fns.forEach(function (f) { var e = f.dates && f.dates[f.dates.length - 1]; if (e && e.iso > lastEnd) lastEnd = e.iso; });
  if (cur && cur.dates && cur.dates.length) start = rcIsoAdd(cur.dates[cur.dates.length - 1].iso, 1);
  else { var p = today.split('-'), dow = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay(); start = rcIsoAdd(today, ((8 - dow) % 7) || 7); }   // next Monday
  var end = rcIsoAdd(start, 13);
  var clash = fns.some(function (f) { return (f.dates || []).some(function (d) { return d.iso >= start && d.iso <= end; }); });
  if (clash && lastEnd) start = rcIsoAdd(lastEnd, 1);
  return start;
}
function rcFreshRoster() {
  if (!rcIsMgr()) return;
  var fns = rcAsArray(safeGetJSON('retail_roster_byFortnight_v1', []));
  var dates = rcFreshDates(rcFreshStart(fns));
  var label = dates[0].date + ' - ' + dates[13].date;
  var recent = fns.slice().sort(function (a, b) { return ((a.dates[0] || {}).iso || '') < ((b.dates[0] || {}).iso || '') ? 1 : -1; }).slice(0, 3);   // last 3 rosters, in case one was a partial upload
  var people = [], seen = {};
  var addP = function (p) {
    var k = (String(p.firstName || '').trim() + ' ' + String(p.lastName || '').trim()).toLowerCase(); if (!p.firstName || !p.lastName || seen[k]) return; seen[k] = 1;
    if (p.guestFrom && p.guestFrom !== RC.team && !rcTeamPeople().some(function (u) { return (String(u.firstName) + ' ' + String(u.lastName)).toLowerCase() === k; })) return;   // no longer borrowed
    if (p.guestFrom) { people.push(rcRowFor(p, 14, p.guestFrom)); return; }
    people.push({ firstName: p.firstName, lastName: p.lastName, role: rcIsMgrRole(p.role) ? p.role : 'staff', employmentType: p.employmentType || 'casual', shifts: Array(14).fill('OFF'), unavailable: Array(14).fill(false), isHidden: !!(p.isHidden || isHiddenStaffRow(p)) });
  };
  recent.forEach(function (f) { (f.staff || []).forEach(addP); });
  if (!recent.length) rcUserList().forEach(addP);
  if (!people.length) { toast('Add this team\'s staff in Account Management first'); return; }
  showCustomConfirm('Start a fresh roster?', 'Creates an empty roster for <b>' + rcEsc(label) + '</b> with ' + people.length + ' staff ' + (recent.length ? '(everyone on the last ' + (recent.length > 1 ? recent.length + ' rosters' : 'roster') + ')' : '(everyone with a login in this team)') + '. Every day starts OFF - type shifts straight into the cells. Uploading the Excel for these dates later fills in the cells you haven\'t touched.'
    + '<label class="rc-keep" style="margin-top:10px"><input type="checkbox" id="rc-fresh-draft"> Keep it as a draft (staff won\'t see it until you publish)</label>', function (ok) {
    if (!ok) return;
    var draft = !!(document.getElementById('rc-fresh-draft') || {}).checked;
    var all = rcAsArray(safeGetJSON('retail_roster_byFortnight_v1', []));
    if (all.some(function (f) { return (f.dates || []).some(function (d) { return d.iso === dates[0].iso; }); })) { toast('There is already a roster for ' + label); return; }
    people.sort(rcStaffSort);
    var fn = { id: 'fn_' + Date.now(), label: label, dates: dates, staff: people };
    if (draft) fn.draft = true;
    all.push(fn);
    safeSet('retail_roster_currentFortnightId', fn.id);
    safeSetJSON('retail_roster_byFortnight_v1', all);
    populateFortnightSelect(); renderRosterSafe();
    toast('Fresh roster started: ' + label + (draft ? ' (draft)' : ''));
  });
}
function rcFreshButton() {
  var ctl = document.querySelector('#repco-v65 .r-controls') || document.querySelector('.r-controls'); if (!ctl) return;
  var b = document.getElementById('rc-fresh-btn');
  if (!rcIsMgr() || RC.pdfMode) { if (b) b.remove(); return; }
  if (b) return;
  b = document.createElement('button'); b.id = 'rc-fresh-btn'; b.textContent = '+ NEW FORTNIGHT'; b.title = 'Start an empty roster for the next fortnight'; b.onclick = rcFreshRoster;
  var del = document.getElementById('delete-roster-btn'); ctl.insertBefore(b, del || null);
}
renderImportExportPage = (function (orig) {
  return function () {
    orig.apply(this, arguments);
    var el = document.getElementById('import-export-inner'); if (!el || !rcIsMgr() || document.getElementById('rc-fresh-card')) return;
    el.insertAdjacentHTML('afterbegin', '<div class="card" id="rc-fresh-card"><div class="rc-h">NO EXCEL YET?</div><div class="rc-small">Start an empty roster for the next fortnight with the same staff, and fill it in on the roster.</div><button class="rc-b rc-red rc-wide" style="margin-top:8px" onclick="rcFreshRoster()">START A FRESH ROSTER</button></div>');
  };
})(renderImportExportPage);

/* ---------- What each role sees ---------- */
/* Managers: add and edit staff logins only; passwords, roles, deleting and access are for masters */
function rcLimitAccountsForManager(el) {
  el.querySelectorAll('button').forEach(function (b) {
    var oc = b.getAttribute('onclick') || '';
    if (/rcResetUserPassword|rcDeleteUser|adminDelUserMgmt|rcBulk|rcLoadOld|rcRunMigration/.test(oc) || /^(DEL|DELETE)$/.test(b.textContent.trim())) b.remove();
  });
  var hid = 0;
  el.querySelectorAll('.rc-row').forEach(function (row) {
    var pill = row.querySelector('.rc-pill'), ed = row.querySelector('button[onclick^="rcEditUser"]'), r = pill ? pill.textContent.trim().toLowerCase() : '';
    if (r === 'master' && ed) { row.remove(); hid++; return; }   // managers don't see master logins
    if (ed && r !== 'staff') ed.remove();
  });
  el.querySelectorAll('.rc-h').forEach(function (h) { var m = h.textContent.match(/^ALL USERS \((\d+)\)$/); if (m) h.textContent = 'ALL USERS (' + (+m[1] - hid) + ')'; });
  el.querySelectorAll('.card').forEach(function (c) { if (/STAFF PASSWORDS|IMPORT FROM OLD VERSION/.test(c.textContent)) c.remove(); });
  var sel = document.getElementById('new-user-role');
  if (sel) { sel.innerHTML = '<option value="staff">staff</option>'; sel.disabled = true; }
  el.insertAdjacentHTML('afterbegin', '<div class="card rc-small">Managers can add staff and fix their names. Passwords, roles and removing logins are done by a master.</div>');
}
rcEditUser = (function (orig) {
  return function () {
    var r = orig.apply(this, arguments);
    if (!rcIsOwner()) { var sel = document.getElementById('rc-eu-role'); if (sel) { sel.innerHTML = '<option value="staff">staff</option>'; sel.disabled = true; } }
    return r;
  };
})(rcEditUser);
renderOptions = (function (orig) {
  return function () {
    orig.apply(this, arguments);
    if (!rcIsAdminOnly()) return;
    var inner = document.getElementById('options-inner'); if (!inner) return;
    inner.querySelectorAll('button').forEach(function (b) { if (/account-mgmt-page|hidden-staff-page/.test(b.getAttribute('onclick') || '')) b.remove(); });
    inner.querySelectorAll('.card').forEach(function (c) { if (/MAINTENANCE/.test(c.textContent) && c.tagName !== 'BUTTON') c.remove(); });
  };
})(renderOptions);
/* Admins: send a shift change for an employee - a manager approves or denies it */
function rcRenderAdminRequestForm() {
  var el = document.getElementById('requests-list'); if (!el) return;
  // live redraws keep what's been picked and typed
  var keep = {}; ['ar-who', 'ar-day', 'ar-s', 'ar-e', 'ar-r'].forEach(function (id) { var x = document.getElementById(id); if (x) keep[id] = x.value; });
  var fn = getSelectedFortnight() || getCurrentFortnight();
  if (!fn) { el.innerHTML = '<div class="card">No roster yet.</div>'; return; }
  var people = (fn.staff || []).map(function (st, r) { var u = rcUserForStaff(st); return u ? { r: r, st: st, u: u } : null; }).filter(Boolean);
  var today = getISO();
  var h = '<div class="card"><div class="rc-h">SUBMIT A SHIFT CHANGE FOR AN EMPLOYEE</div><div class="rc-small">For ' + rcEsc(rcFnRange(fn)) + ' (the fortnight on the roster screen). A manager approves or denies it, and the employee is told.</div>'
    + '<select id="ar-who" class="rc-to-in" onchange="rcAdminReqShow()">' + people.map(function (p) { return '<option value="' + p.r + '">' + rcEsc(p.st.firstName + ' ' + p.st.lastName) + '</option>'; }).join('') + '</select>'
    + '<select id="ar-day" class="rc-to-in" onchange="rcAdminReqShow()">' + fn.dates.map(function (d, i) { return '<option value="' + i + '"' + (d.iso === today ? ' selected' : '') + '>' + rcEsc(d.day + ' ' + d.date) + '</option>'; }).join('') + '</select>'
    + '<div id="ar-now" class="rc-small" style="margin:6px 0"></div>'
    + '<div class="ms-edit-row"><label class="rc-to">Start<input type="time" id="ar-s"></label><label class="rc-to">Finish<input type="time" id="ar-e"></label></div>'
    + '<input id="ar-r" class="rc-to-in" placeholder="Reason (optional)">'
    + '<div class="rc-btns" style="margin-top:8px"><button class="rc-b rc-red" onclick="rcAdminReqSend(\'times\')">SEND NEW TIMES</button><button class="rc-b" onclick="rcAdminReqSend(\'off\')">MAKE IT OFF</button><button class="rc-b rc-white" onclick="rcAdminReqSend(\'ua\')">UNAVAILABLE</button></div></div>';
  var mine = rcAsArray(safeGetJSON('retail_roster_requests_v2', [])).filter(function (q) { return q.byUsername === RC.session.profile.username; }).sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); }).slice(0, 20);
  h += '<div class="card"><div class="rc-h">CHANGES YOU SENT</div>' + (mine.length ? mine.map(function (q) {
    return '<div class="rc-row"><div><b>' + rcEsc(q.username) + '</b> ' + rcEsc(q.shiftDate || '') + ': ' + rcEsc(q.oldShift || '') + ' → <b>' + rcEsc(q.newShift || '') + '</b></div><span class="rc-pill rc-st-' + rcEsc(q.status || 'pending') + '">' + rcEsc(q.status || 'pending') + '</span></div>';
  }).join('') : '<div class="rc-small">None yet.</div>') + '</div>';
  el.innerHTML = h + '<div class="card"><button onclick="showMain()" class="rc-b rc-wide">← BACK</button></div>';
  if (!people.length) document.getElementById('ar-now').textContent = 'Nobody on this roster has a login yet.';
  if (keep['ar-who'] !== undefined) {
    ['ar-who', 'ar-day'].forEach(function (id) { var x = document.getElementById(id); if (x && [].some.call(x.options, function (o) { return o.value === keep[id]; })) x.value = keep[id]; });
    rcAdminReqShow();
    ['ar-s', 'ar-e', 'ar-r'].forEach(function (id) { var x = document.getElementById(id); if (x) x.value = keep[id]; });
  } else rcAdminReqShow();
}
function rcAdminReqShow() {
  var fn = getSelectedFortnight() || getCurrentFortnight(), r = +(document.getElementById('ar-who') || {}).value, i = +(document.getElementById('ar-day') || {}).value;
  var st = fn && fn.staff[r], out = document.getElementById('ar-now'); if (!st || !out) return;
  var cur = (st.shifts && st.shifts[i]) || 'OFF', p = parseShiftRange(cur);
  out.innerHTML = 'Now: <b>' + rcEsc(fmt(cur)) + '</b>';
  var pad = function (m) { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
  document.getElementById('ar-s').value = p ? pad(p.start) : ''; document.getElementById('ar-e').value = p ? pad(p.end) : '';
}
function rcAdminReqSend(mode) {
  var fn = getSelectedFortnight() || getCurrentFortnight(), r = +(document.getElementById('ar-who') || {}).value, i = +(document.getElementById('ar-day') || {}).value;
  var st = fn && fn.staff[r], u = st && rcUserForStaff(st); if (!u) { toast('Pick an employee'); return; }
  var old = (st.shifts && st.shifts[i]) || 'OFF', ns;
  if (mode === 'off') ns = 'OFF'; else if (mode === 'ua') ns = 'UA';
  else { var a = document.getElementById('ar-s').value, b = document.getElementById('ar-e').value; if (!a || !b) { toast('Enter a start and finish time'); return; } ns = a + '-' + b; }
  if (ns === old) { toast('That is what the roster already says'); return; }
  var reason = (document.getElementById('ar-r').value || '').trim();
  var all = rcAsArray(safeGetJSON('retail_roster_requests_v2', []));
  all.push({ username: u.username, type: 'shift-correction', fnId: fn.id, shiftDate: fn.dates[i].date, shiftIdx: i, oldShift: old, newShift: ns, reason: reason, status: 'pending', ts: Date.now(), dates: [fn.dates[i].date], byUsername: RC.session.profile.username });
  safeSetJSON('retail_roster_requests_v2', all);
  rcNotify([u.uid], { type: 'req-for-you', title: 'Shift change sent for you', body: fn.dates[i].day + ' ' + fn.dates[i].date + ': ' + old + ' → ' + ns + '. A manager will review it.' });
  toast('Sent to a manager');
  rcRenderAdminRequestForm();
}

/* ---------- Roster row size: small / normal / large (remembered on this device) ---------- */
var RC_ROW_SIZES = [['s', 'SMALL'], ['m', 'NORMAL'], ['l', 'LARGE']];
function rcRowSize() { try { var v = localStorage.getItem('repco_row_size'); return /^[sml]$/.test(v || '') ? v : 'm'; } catch (e) { return 'm'; } }
function rcApplyRowSize() {
  var v = rcRowSize();
  document.body.classList.toggle('rc-rh-s', v === 's'); document.body.classList.toggle('rc-rh-l', v === 'l');
  var ctl = document.querySelector('#repco-v65 .r-controls') || document.querySelector('.r-controls'); if (!ctl || !RC.session) return;
  var b = document.getElementById('rc-rows-btn');
  if (!b) { b = document.createElement('button'); b.id = 'rc-rows-btn'; b.title = 'Row size'; b.onclick = rcCycleRowSize; var tf = ctl.querySelector('button[onclick="toggleTimeFormat()"]'); ctl.insertBefore(b, tf ? tf.nextSibling : null); }
  b.textContent = 'ROWS: ' + RC_ROW_SIZES.find(function (x) { return x[0] === v; })[1];
}
function rcCycleRowSize() {
  var v = rcRowSize(), i = RC_ROW_SIZES.findIndex(function (x) { return x[0] === v; });
  try { localStorage.setItem('repco_row_size', RC_ROW_SIZES[(i + 1) % 3][0]); } catch (e) {}
  rcApplyRowSize();
}

/* ---------- One person on more than one team's roster (hidden here, normal staff there, or borrowed) ----------
   Each team publishes those people's upcoming shifts to shared/<person>/<team>; the other team's managers and
   admins see them in that person's cells, and the person sees both teams on My Schedule. */
function rcPersonKey(p) {
  var f = String((p && p.firstName) || '').trim(), l = String((p && p.lastName) || '').trim();
  return f && l ? rcEncodeKey((l + '_' + f).toLowerCase()) : '';
}
function rcIsLinkedRow(st, key) {
  if (st.isHidden || isHiddenStaffRow(st) || (st.guestFrom && st.guestFrom !== RC.team)) return true;
  var sh = RC.shared[key]; if (sh && Object.keys(sh).some(function (t) { return t !== RC.team; })) return true;
  return Object.keys(RC.guests).some(function (t) { return t !== RC.team && rcTeamPeople().some(function (u) { return (RC.guests[t] || {})[u.uid] && rcPersonKey(u) === key; }); });
}
var _rcSharedTimer = null;
function rcQueueShared() { if (_rcSharedTimer) clearTimeout(_rcSharedTimer); _rcSharedTimer = setTimeout(rcPublishShared, 1500); }
function rcPublishShared() {
  if (!RC.session || !rcIsMgr() || !RC.ready.retail_roster_byFortnight_v1) return;
  var fns = rcAsArray(safeGetJSON('retail_roster_byFortnight_v1', [])), from = rcIsoAdd(getISO(), -14), want = {};
  fns.forEach(function (fn) {
    if (fn.draft) return;
    var last = fn.dates[fn.dates.length - 1]; if (!last || last.iso < from) return;
    (fn.staff || []).forEach(function (st) {
      var key = rcPersonKey(st); if (!key || !rcIsLinkedRow(st, key)) return;
      var w = want[key] = want[key] || { name: st.firstName + ' ' + st.lastName, days: {} };
      fn.dates.forEach(function (d, i) { if (d.iso >= from) w.days[d.iso] = String((st.shifts && st.shifts[i] != null) ? st.shifts[i] : 'OFF'); });
    });
  });
  var upd = {};
  Object.keys(want).forEach(function (key) {
    var cur = (RC.shared[key] || {})[RC.team];
    if (cur && JSON.stringify(cur.days || {}) === JSON.stringify(rcSortObj(want[key].days)) && cur.name === want[key].name) return;
    upd['shared/' + key + '/' + RC.team] = { name: want[key].name, days: rcSortObj(want[key].days), ts: firebase.database.ServerValue.TIMESTAMP };
  });
  Object.keys(RC.shared).forEach(function (key) { if ((RC.shared[key] || {})[RC.team] && !want[key]) upd['shared/' + key + '/' + RC.team] = null; });
  if (Object.keys(upd).length) RC.db.ref().update(upd).catch(function (e) { console.warn('shared shifts', e && e.code); });
}
function rcDayViewIso(fn) { var i = RC.dayFn === fn.id && RC.dayIdx != null ? RC.dayIdx : -1; return i >= 0 && fn.dates[i] ? fn.dates[i].iso : ''; }
function rcSortObj(o) { var r = {}; Object.keys(o).sort().forEach(function (k) { r[k] = o[k]; }); return r; }
/* Show the other team's shifts in that person's cells (managers and admins only) */
function rcSharedMarks() {
  if (!rcIsMgr() || RC.pdfMode) return;
  var fn = getSelectedFortnight(); if (!fn) return;
  (fn.staff || []).forEach(function (st, r) {
    var sh = RC.shared[rcPersonKey(st)]; if (!sh) return;
    fn.dates.forEach(function (d, i) {
      Object.keys(sh).forEach(function (t) {
        if (t === RC.team) return;
        var v = ((sh[t] || {}).days || {})[d.iso]; if (!v || rcIsEmptyVal(v)) return;
        var label = /^(AB|ABSENT)$/i.test(v) ? 'AB' : rcIsUAVal(v) ? 'UA' : fmt(v);
        var td = document.querySelector('#roster-mount td[data-r="' + r + '"][data-i="' + i + '"]');
        if (td && !td.querySelector('.rc-else')) {
          var mine = (st.shifts && st.shifts[i] != null) ? String(st.shifts[i]) : 'OFF', clash = !!parseShiftRange(mine) && !!parseShiftRange(v);
          td.insertAdjacentHTML('beforeend', '<span class="rc-else' + (clash ? ' rc-clash' : '') + '" title="Rostered at ' + rcEsc(rcTeamName(t)) + '">' + (clash ? '⚠ ' : '') + rcEsc(rcTeamName(t)) + ' ' + rcEsc(label) + '</span>');
        }
      });
    });
  });
  // day view: one line under the name for the day shown
  document.querySelectorAll('.dv-row[data-r]').forEach(function (el) {
    if (el.querySelector('.rc-else')) return;
    var st = fn.staff[+el.getAttribute('data-r')], sh = st && RC.shared[rcPersonKey(st)]; if (!sh) return;
    var iso = rcDayViewIso(fn); if (!iso) return;
    var bits = Object.keys(sh).filter(function (t) { return t !== RC.team; }).map(function (t) { var v = ((sh[t] || {}).days || {})[iso]; return v && !rcIsEmptyVal(v) ? rcTeamName(t) + ' ' + (rcIsUAVal(v) ? 'UA' : fmt(v)) : ''; }).filter(Boolean);
    if (bits.length) el.insertAdjacentHTML('beforeend', '<span class="rc-else rc-else-dv">Also: ' + rcEsc(bits.join(' • ')) + '</span>');
  });
}

/* ---------- Access log page (masters) ---------- */
renderOptions = (function (orig) {
  return function () {
    orig.apply(this, arguments);
    if (!rcCanSeeAccessLog()) return;
    var grid = document.querySelector('#options-inner > div'); if (!grid || document.getElementById('btn-accesslog')) return;
    var b = document.createElement('button'); b.className = 'card'; b.id = 'btn-accesslog'; b.style.cssText = 'font-weight:900;text-align:left';
    b.textContent = 'ACCESS LOG'; b.onclick = function () { RC.accessFilter = ''; openPage('accesslog-page'); };
    grid.insertBefore(b, grid.lastElementChild);
  };
})(renderOptions);
openPage = (function (orig) {
  return function (id) {
    if (id === 'accesslog-page') {
      if (!rcCanSeeAccessLog()) { toast('Masters only'); return; }
      if (!document.getElementById('accesslog-page')) {
        var p = document.createElement('div'); p.id = 'accesslog-page'; p.className = 'full-page';
        p.innerHTML = '<div class="page-inner"><div class="page-title">ACCESS LOG</div><div id="accesslog-inner"></div></div>';
        document.body.appendChild(p);
      }
    }
    orig.apply(this, arguments);
    if (id === 'accesslog-page') { rcLoadAccessLog(); setTimeout(rcFitHeader, 0); }
  };
})(openPage);
function rcOpenAccessLogFor(username) { RC.accessFilter = username; openPage('accesslog-page'); }
function rcLoadAccessLog() {
  var el = document.getElementById('accesslog-inner'); if (!el) return;
  el.innerHTML = '<div class="card">Loading...</div>';
  RC.db.ref('accesslog').orderByChild('ts').limitToLast(2000).once('value').then(function (s) {
    var v = s.val() || {};
    RC.accessLog = Object.keys(v).map(function (k) { return v[k]; }).sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    var people = {}; RC.accessLog.forEach(function (e) { var n = rcAccessName(e); people[n] = 1; });
    el.innerHTML = '<div class="card"><div class="tm-row" style="border:none;padding:0"><select id="al-who" class="tm-move" style="flex:1;font-size:13px;padding:8px" onchange="rcRenderAccessLog()"><option value="">Everyone</option>'
      + Object.keys(people).sort().map(function (n) { return '<option' + (n === RC.accessFilter ? ' selected' : '') + '>' + rcEsc(n) + '</option>'; }).join('') + '</select>'
      + '<select id="al-kind" class="tm-move" style="font-size:13px;padding:8px" onchange="rcRenderAccessLog()"><option value="">All events</option><option value="Signed in">Sign-ins only</option><option value="Opened">App opens</option><option value="out">Sign-outs and time-outs</option></select></div>'
      + '<div class="rc-small" style="margin-top:6px">Every sign-in, app open, team switch and sign-out, newest first (latest 2,000). Wrong-password attempts can\'t be recorded.</div>'
      + '<div id="al-summary" style="margin-top:8px"></div>'
      + '<button class="rc-b rc-white" style="margin-top:8px" onclick="rcPruneAccessLog()">DELETE ENTRIES OLDER THAN 90 DAYS</button></div><div id="al-list"></div>';
    rcRenderAccessLog();
  }).catch(function (e) { el.innerHTML = '<div class="card">Could not load: ' + rcEsc(rcErrMsg(e)) + '</div>'; });
}
function rcAccessName(e) {
  var u = RC.allUsers[e.uid];
  return (u && u.username) || e.username || 'deleted login';
}
function rcRenderAccessLog() {
  var list = document.getElementById('al-list'); if (!list) return;
  var who = (document.getElementById('al-who') || {}).value || '', kind = (document.getElementById('al-kind') || {}).value || '';
  RC.accessFilter = who;
  var rows = (RC.accessLog || []).filter(function (e) {
    if (who && rcAccessName(e) !== who) return false;
    if (kind === 'out') return /out/i.test(e.kind || '');
    if (kind) return String(e.kind || '').indexOf(kind) === 0;
    return true;
  });
  var sum = document.getElementById('al-summary');
  if (sum) {
    var wk = Date.now() - 7 * 864e5, ins = rows.filter(function (e) { return e.ts > wk; });
    sum.innerHTML = '<span class="rc-pill">' + rows.length + ' events</span> <span class="rc-pill">' + ins.length + ' in the last 7 days</span>'
      + (who ? ' <span class="rc-pill">first seen ' + rcEsc(rows.length ? new Date(rows[rows.length - 1].ts).toLocaleDateString('en-AU', { timeZone: 'Australia/Brisbane' }) : '-') + '</span>' : '');
  }
  if (!rows.length) { list.innerHTML = '<div class="card">Nothing recorded yet.</div>'; return; }
  var lastDay = '', h = '', multi = rcTeamIds().length > 1;
  rows.slice(0, 600).forEach(function (e) {
    var d = new Date(e.ts || 0), dayKey = d.toLocaleDateString('en-AU', { timeZone: 'Australia/Brisbane', weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
    if (dayKey !== lastDay) { if (lastDay) h += '</div>'; h += '<div class="card"><div class="rc-h">' + rcEsc(dayKey) + '</div>'; lastDay = dayKey; }
    var u = RC.allUsers[e.uid], real = u ? ((u.firstName || '') + ' ' + (u.lastName || '')).trim() : '';
    var cls = /out/i.test(e.kind || '') ? ' al-out' : /^Signed in/.test(e.kind || '') ? ' al-in' : '';
    h += '<div class="hist-row"><span class="hist-t">' + rcEsc(d.toLocaleTimeString('en-AU', { timeZone: 'Australia/Brisbane', hour: 'numeric', minute: '2-digit' })) + '</span><span class="hist-w"><b>' + rcEsc(rcAccessName(e)) + '</b>' + (real ? ' <span class="rc-small">' + rcEsc(real) + '</span>' : '')
      + ' <span class="rc-pill' + cls + '">' + rcEsc(e.kind || '') + '</span><br><span class="rc-small">' + rcEsc(e.device || '') + (multi && e.team ? ' • ' + rcEsc(rcTeamName(e.team)) : '') + '</span></span></div>';
  });
  list.innerHTML = h + '</div>' + (rows.length > 600 ? '<div class="card rc-small">Showing the newest 600. Pick a person to see more of theirs.</div>' : '');
}
function rcPruneAccessLog() {
  showCustomConfirm('Delete old entries?', 'Removes access log entries older than 90 days.', function (ok) {
    if (!ok) return;
    RC.db.ref('accesslog').orderByChild('ts').endAt(Date.now() - 90 * 864e5).once('value').then(function (s) {
      var upd = {}; s.forEach(function (c) { upd['accesslog/' + c.key] = null; });
      var n = Object.keys(upd).length; if (!n) { toast('Nothing older than 90 days'); return; }
      return RC.db.ref().update(upd).then(function () { toast('Deleted ' + n); rcLoadAccessLog(); });
    }).catch(function (e) { toast('Not deleted: ' + rcErrMsg(e)); });
  });
}
renderAccountMgmtPage = (function (orig) {
  return function () {
    orig.apply(this, arguments);
    if (!rcCanSeeAccessLog()) return;
    document.querySelectorAll('#account-mgmt-inner .rc-row').forEach(function (row) {
      var b = row.querySelector('.rc-btns'), nm = row.querySelector('b'); if (!b || !nm || b.querySelector('.al-btn') || !row.querySelector('button[onclick^="rcEditUser"]')) return;
      var x = document.createElement('button'); x.className = 'rc-b rc-white al-btn'; x.textContent = 'ACCESS LOG';
      x.onclick = function () { rcOpenAccessLogFor(nm.textContent); }; b.appendChild(x);
    });
  };
})(renderAccountMgmtPage);

/* ---------- Change history page (managers) ---------- */
function rcEnsureHistoryPage() {
  if (document.getElementById('history-page')) return;
  var p = document.createElement('div'); p.id = 'history-page'; p.className = 'full-page';
  p.innerHTML = '<div class="page-inner"><div class="page-title">CHANGE HISTORY</div><div id="history-inner"></div></div>';
  document.body.appendChild(p);
}
openPage = (function (orig) {
  return function (id) {
    if (id === 'history-page') { if (!rcIsManagerUp()) { toast('Managers only'); return; } rcEnsureHistoryPage(); }
    orig.apply(this, arguments);
    if (id === 'history-page') { rcLoadHistory(); setTimeout(rcFitHeader, 0); }
  };
})(openPage);
renderOptions = (function (orig) {
  return function () {
    orig.apply(this, arguments);
    if (!rcIsManagerUp()) return;
    var grid = document.querySelector('#options-inner > div'); if (!grid || document.getElementById('btn-history')) return;
    var b = document.createElement('button'); b.className = 'card'; b.id = 'btn-history'; b.style.cssText = 'font-weight:900;text-align:left';
    b.textContent = 'CHANGE HISTORY'; b.onclick = function () { openPage('history-page'); };
    grid.insertBefore(b, grid.lastElementChild);
  };
})(renderOptions);
function rcLoadHistory() {
  var el = document.getElementById('history-inner'); if (!el) return;
  el.innerHTML = '<div class="card">Loading...</div>';
  RC.db.ref(rcTP('history')).orderByChild('ts').limitToLast(500).once('value').then(function (s) {
    var v = s.val() || {};
    RC.history = Object.keys(v).map(function (k) { return v[k]; }).sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    el.innerHTML = '<div class="card"><input id="hist-q" class="rc-to-in" style="margin:0" placeholder="Search name, day or who made the change" oninput="rcRenderHistory()"><div class="rc-small" style="margin-top:6px">Latest 500 changes. Entries can\'t be edited or deleted.</div></div><div id="hist-list"></div>';
    rcRenderHistory();
  }).catch(function (e) { el.innerHTML = '<div class="card">Could not load: ' + rcEsc(rcErrMsg(e)) + '</div>'; });
}
function rcRenderHistory() {
  var list = document.getElementById('hist-list'); if (!list) return;
  var q = ((document.getElementById('hist-q') || {}).value || '').toLowerCase().trim();
  var rows = (RC.history || []).filter(function (e) { return !q || [e.name, e.day, e.by, e.fn, e.action, e.from, e.to].join(' ').toLowerCase().indexOf(q) !== -1; });
  if (!rows.length) { list.innerHTML = '<div class="card">' + (q ? 'Nothing matches.' : 'No changes recorded yet.') + '</div>'; return; }
  var lastDay = '', h = '';
  rows.slice(0, 300).forEach(function (e) {
    var d = new Date(e.ts || 0), dayKey = d.toLocaleDateString('en-AU', { timeZone: 'Australia/Brisbane', weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
    if (dayKey !== lastDay) { if (lastDay) h += '</div>'; h += '<div class="card"><div class="rc-h">' + rcEsc(dayKey) + '</div>'; lastDay = dayKey; }
    var time = d.toLocaleTimeString('en-AU', { timeZone: 'Australia/Brisbane', hour: 'numeric', minute: '2-digit' });
    var what = e.name ? '<b>' + rcEsc(e.name) + '</b> · ' + rcEsc(e.day || '') + ': <span class="pc-cur">' + rcEsc(e.from || '') + '</span> → <b>' + rcEsc(e.to || '') + '</b>' + (e.action ? ' <span class="rc-pill">' + rcEsc(e.action) + '</span>' : '')
      : '<b>' + rcEsc(e.action || 'Change') + '</b> · ' + rcEsc(e.fn || '');
    h += '<div class="hist-row"><span class="hist-t">' + rcEsc(time) + '</span><span class="hist-w">' + what + '<br><span class="rc-small">by ' + rcEsc(e.by || '?') + (e.name && e.fn ? ' • ' + rcEsc(e.fn) : '') + '</span></span></div>';
  });
  list.innerHTML = h + '</div>';
}

/* ---------- My hours (My Schedule) ---------- */
function rcMyHoursCard(rows, today) {
  var byFn = {}, order = [];
  rows.forEach(function (r) { if (!byFn[r.fn.id]) { byFn[r.fn.id] = []; order.push(r.fn); } byFn[r.fn.id].push(r); });
  var idx = order.findIndex(function (fn) { return fn.dates.some(function (d) { return d.iso === today; }); });
  if (idx === -1) idx = order.findIndex(function (fn) { return fn.dates[0] && fn.dates[0].iso > today; }) - 0.5;
  var pick = function (k) { return Number.isInteger(k) && k >= 0 && k < order.length ? order[k] : null; };
  var sum = function (fn, onlyPast) {
    var h = 0, n = 0;
    (byFn[fn.id] || []).forEach(function (r) { if (!r.t) return; if (onlyPast && r.t.end.getTime() > Date.now()) return; h += netH(r.sh); n++; });
    return { h: h, n: n };
  };
  var line = function (label, fn, extra) { if (!fn) return ''; var a = sum(fn); return '<div class="hrs-row"><span><b>' + label + '</b><br><span class="rc-small">' + rcEsc(rcFnRange(fn)) + '</span></span><span class="hrs-v">' + a.h.toFixed(1) + 'h<small>' + a.n + ' shifts' + (extra ? ' • ' + extra : '') + '</small></span></div>'; };
  var cur = pick(Math.round(idx)), prev = pick(Math.round(idx) - 1), next = pick(Math.round(idx) + 1);
  if (!Number.isInteger(idx)) { cur = null; prev = pick(Math.floor(idx)); next = pick(Math.ceil(idx)); }
  var done = cur ? sum(cur, true).h.toFixed(1) + 'h done so far' : '';
  var h = line('LAST FORTNIGHT', prev) + line('THIS FORTNIGHT', cur, done) + line('NEXT FORTNIGHT', next);
  if (!h) return '';
  return '<div class="card"><div class="rc-h">MY HOURS</div>' + h + '<div class="rc-small" style="margin-top:6px;color:#777">Rostered hours after a 30-minute break on shifts over 5 hours. Absent and unavailable days aren\'t counted.</div></div>';
}

/* ---------- PDF export: a picture of the roster tables exactly as they look on screen ---------- */
exportPDF = async function () {
  var fn = getSelectedFortnight() || getCurrentFortnight();
  if (!fn) { toast('No roster'); return; }
  if (!window.html2canvas || !window.jspdf) { toast('PDF tools are still loading - try again in a moment'); return; }
  toast('Building PDF...');
  var wasHidden = !document.getElementById('repco-v65').classList.contains('show');
  var holder = document.createElement('div');
  try {
    RC.pdfMode = true;
    if (wasHidden) document.getElementById('repco-v65').classList.add('show');
    renderRosterSafe();
    holder.style.cssText = 'position:absolute;left:-30000px;top:0;background:#fff;padding:0;width:max-content';
    var head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:30px;padding:14px 16px 10px;background:#fff;border-bottom:4px solid #0a0a0a;margin-bottom:6px';
    head.innerHTML = '<div style="display:flex;align-items:center;gap:14px"><div style="display:flex;gap:5px;transform:skewX(-15deg)"><div style="width:40px;height:30px;background:#E30613"></div><div style="width:10px;height:30px;background:#E30613"></div><div style="width:10px;height:30px;background:#E30613"></div><div style="width:10px;height:30px;background:#E30613"></div></div>'
      + '<div style="font-family:\'Arial Black\',Impact,sans-serif;font-weight:900;font-size:26px;font-style:italic"><span style="color:#E30613">REPCO</span> ROSTER</div></div>'
      + '<div style="font-family:\'Arial Black\',Impact,sans-serif;font-weight:900;font-size:16px">' + rcEsc(rcFnRange(fn)) + '</div>';
    holder.appendChild(head);
    document.querySelectorAll('#roster-mount .roster-section').forEach(function (sec) {
      var c = sec.cloneNode(true);
      c.style.margin = '8px 10px';
      c.querySelectorAll('.r-table-wrap').forEach(function (w) { w.style.overflow = 'visible'; });
      c.querySelectorAll('th,td').forEach(function (cell) { cell.style.position = 'static'; });
      c.querySelectorAll('tr.own').forEach(function (tr) { tr.classList.remove('own'); });
      c.querySelectorAll('.you-pill').forEach(function (p) { p.remove(); });
      holder.appendChild(c);
    });
    document.body.appendChild(holder);
    var JsPDF = window.jspdf.jsPDF;
    var doc = new JsPDF({ orientation: 'landscape', unit: 'mm', format: 'a3' });
    var pw = doc.internal.pageSize.getWidth(), ph = doc.internal.pageSize.getHeight(), m = 8;
    // One picture of the header and every table, scaled once so they all share one page and one scale
    holder.style.padding = '4px 6px 10px';
    var canvas = await html2canvas(holder, { scale: 2, backgroundColor: '#ffffff', logging: false, width: holder.scrollWidth, height: holder.scrollHeight, windowWidth: holder.scrollWidth + 100 });
    var k = Math.min((pw - 2 * m) / canvas.width, (ph - 2 * m) / canvas.height);
    var wmm = canvas.width * k, hmm = canvas.height * k;
    doc.addImage(canvas.toDataURL('image/png'), 'PNG', (pw - wmm) / 2, m, wmm, hmm);
    doc.save(String(fn.label || 'roster').replace(/[^a-z0-9]+/gi, '_') + '.pdf');
    toast('PDF exported');
  } catch (e) {
    console.error('pdf', e);
    toast('PDF error: ' + (e.message || e));
  } finally {
    holder.remove();
    RC.pdfMode = false;
    if (wasHidden) document.getElementById('repco-v65').classList.remove('show');
    renderRosterSafe();
  }
};

/* ---------- backup ---------- */
function rcDownloadBackup() {
  Promise.all(['data', 'mgrdata', 'offers', 'users'].map(function (p) { return RC.db.ref(p === 'users' ? p : rcTP(p)).once('value').then(function (s) { return [p, s.val()]; }); }))
    .then(function (parts) {
      var o = { exportedAt: new Date().toISOString(), by: RC.session.profile.username };
      parts.forEach(function (p) { o[p[0]] = p[1]; });
      var blob = new Blob([JSON.stringify(o, null, 1)], { type: 'application/json' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'repco-roster-backup-' + getISO() + '.json'; a.click();
      toast('Backup downloaded');
    }).catch(function (e) { toast('Backup failed: ' + rcErrMsg(e)); });
}

/* ---------- things from the old version that are no longer safe ---------- */
repairRosterData = function () {
  var spec = RC.byKey.retail_roster_byFortnight_v1;
  if (RC.session && RC.ready[spec.key]) { rcApplyCloud(spec); toast('Reloaded the roster from the cloud'); }
  else location.reload();
};
seedIfEmpty = (function (orig) { return function () { if (RC.session) return; }; })(seedIfEmpty);
try { undoStack.length = 0; localStorage.removeItem('repco_undo_stack'); updateUndoButton(); } catch (e) {}
undoLastEdit = function () { toast('Undo is turned off: it could overwrite other people\'s live changes'); };
cloudSave = function () {}; debouncedCloudSave = function () {}; cloudLoadAll = function () {}; cloudLoad = function () {};
window.createAdmin = undefined;
document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') { rcScheduleRender(); } });

/* One settings cog: only on the login screen (and inside the maintenance screen, which has its own) */
function rcSyncCogs() {
  var maint = document.getElementById('maintenance-main-v141');
  document.querySelectorAll('#admin-cog, #maint-admin-cog').forEach(function (c) {
    var insideMaint = maint && maint.contains(c);
    c.style.display = insideMaint ? 'flex' : (c.id === 'admin-cog' && !RC.session ? 'flex' : 'none');
  });
}

/* The header wraps onto several lines on phones; push the page content below it */
function rcFitHeader() {
  rcSyncCogs();
  var gh = document.getElementById('global-header');
  if (!gh || !gh.classList.contains('show')) return;
  var h = gh.offsetHeight + 12;
  var v = document.getElementById('repco-v65'); if (v) v.style.setProperty('padding-top', h + 'px', 'important');
  document.querySelectorAll('.full-page').forEach(function (p) { p.style.setProperty('padding-top', h + 'px', 'important'); });
}
window.addEventListener('resize', function () { setTimeout(rcFitHeader, 50); });
enterApp = (function (orig) { return function () { var r = orig.apply(this, arguments); setTimeout(rcFitHeader, 0); return r; }; })(enterApp);
applyRoleVisibility = (function (orig) { return function () { var r = orig.apply(this, arguments); document.querySelectorAll('#btn-requests').forEach(function (b) { b.style.display = 'none'; }); setTimeout(rcFitHeader, 0); return r; }; })(applyRoleVisibility);

/* ---------- styles for the new parts (same Repco look) ---------- */
(function () {
  var css = ''
    + '.rc-h{font-family:"Arial Black",Impact,sans-serif;font-weight:900;font-size:13px;letter-spacing:.3px;margin-bottom:6px}'
    + '.rc-small{font-size:11px;line-height:1.45;color:#333}'
    + '.rc-err{color:#E30613;font-weight:900;font-size:12px;margin-top:6px;min-height:14px}'
    + '.rc-b{border:2px solid #111;background:#111;color:#fff;border-radius:9999px;padding:7px 12px;font-weight:900;font-size:11px;cursor:pointer}'
    + '.rc-b.rc-white{background:#fff;color:#111}.rc-b.rc-red{background:#E30613;border-color:#E30613;color:#fff}.rc-b.rc-green{background:#1a7f37;border-color:#1a7f37;color:#fff}'
    + '.rc-wide{width:100%;padding:10px}'
    + '.rc-btns{display:flex;gap:6px;flex-wrap:wrap}'
    + '.rc-row{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 0;border-bottom:1px solid #e3e3e3}'
    + '.rc-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin:8px 0}.rc-grid1{display:flex;flex-direction:column;gap:6px}'
    + '.rc-grid input,.rc-grid select,.rc-grid1 input,.rc-grid1 select,#rc-old-url,#rc-rp-pass{width:100%;padding:9px 12px;border:2px solid #111;border-radius:9999px;font-size:12px;background:#fff}'
    + '.rc-pill{display:inline-block;background:#111;color:#fff;border-radius:9999px;padding:2px 8px;font-size:9px;font-weight:900;text-transform:uppercase;vertical-align:middle}'
    + '.rc-st-pending{background:#FDE9A3;color:#111}.rc-st-approved,.rc-st-accepted{background:#1a7f37}.rc-st-denied,.rc-st-declined{background:#E30613}.rc-st-cancelled,.rc-st-expired,.rc-st-overridden,.rc-st-reversed{background:#9DA0A3}'
    + '.rc-badge{display:inline-block;background:#E30613;color:#fff;border-radius:9999px;min-width:18px;padding:1px 6px;font-size:10px;margin-left:4px}'
    + '#btn-notif{background:#fff;border:2px solid #111}#btn-notif.active{background:#111;color:#fff}'
    + '.rc-tabs{display:flex;gap:8px;margin:0 0 12px;flex-wrap:wrap}.rc-tab{flex:1;min-width:130px;border:3px solid #111;background:#fff;color:#111;border-radius:9999px;padding:10px 12px;font-family:"Arial Black",Impact,sans-serif;font-weight:900;font-size:12px;cursor:pointer}.rc-tab.on{background:#E30613;border-color:#E30613;color:#fff;box-shadow:3px 3px 0 #111}.rc-tab.on .rc-badge{background:#111}'
    + '.rc-notif{padding:8px 34px 8px 0;border-bottom:1px solid #e3e3e3;position:relative}.rc-x{border:none;background:transparent;color:#999;font-size:16px;font-weight:900;cursor:pointer;padding:4px 8px;line-height:1}.rc-notif .rc-x{position:absolute;top:6px;right:0}.rc-x:hover{color:#E30613}.rc-unread{border-left:5px solid #E30613;padding-left:8px}'
    + '.rc-offer-box{margin-top:12px;padding:10px;border:3px dashed #E30613;border-radius:12px;background:#fff5f5;display:flex;flex-direction:column;gap:6px}'
    + '.r-table td.rc-cell-offer{background:repeating-linear-gradient(135deg,#fff,#fff 6px,#ffe3e5 6px,#ffe3e5 12px) !important;color:#111 !important;font-weight:900 !important;outline:2px dashed #E30613;outline-offset:-3px;cursor:pointer}'
    + '.rc-offer-tag{display:block;font-size:8px;color:#E30613;letter-spacing:.5px}'
    + '.rc-current{display:inline-block;border-radius:9999px;padding:7px 12px;font-weight:900;font-size:11px;white-space:nowrap;border:2px solid #111}'
    + '.rc-current.on{background:#1a7f37;border-color:#1a7f37;color:#fff}.rc-current.off{background:#FFEB3B;color:#111;cursor:pointer}'
    + '.roster-section.hidden-sec{border-color:#555;box-shadow:4px 4px 0 #555}'
    + '.ms-panel{position:relative;border-radius:16px;padding:16px 18px;margin:0 0 12px;border:3px solid #111;box-shadow:5px 5px 0 #111;overflow:hidden}'
    + '.ms-on{background:#0a0a0a;color:#fff;border-left:12px solid #E30613}.ms-next{background:#fff;border-left:12px solid #E30613}.ms-none{background:#fff}'
    + '.ms-kicker{font-family:"Arial Black",Impact,sans-serif;font-size:11px;letter-spacing:1px;color:#E30613}'
    + '.ms-big{font-family:"Arial Black",Impact,sans-serif;font-size:26px;font-weight:900;margin:4px 0;font-style:italic}.ms-count{font-size:34px}'
    + '.ms-sub{font-size:13px;font-weight:700;opacity:.85}'
    + '.ms-bar{height:10px;background:#333;border-radius:9999px;margin-top:12px;overflow:hidden}.ms-bar div{height:100%;background:#E30613;border-radius:9999px}'
    + '.ms-x{position:absolute;top:10px;right:10px;width:30px;height:30px;border-radius:50%;border:2px solid #111;background:#fff;font-weight:900;cursor:pointer}'
    + '.ms-open{background:#fff5f5}.ms-req{background:#b58900}'
    + '.ms-edit{background:#fff5f5;border-top:1px dashed #E30613;padding:12px 14px 14px;font-size:13px}.ms-edit-h{font-weight:900;margin-bottom:8px}'
    + '.ms-edit-row{display:flex;gap:10px}.ms-edit-row label{flex:1;font-size:11px;font-weight:900;display:flex;flex-direction:column;gap:4px}'
    + '.ms-edit input{width:100%;box-sizing:border-box;padding:9px 12px;border:2px solid #111;border-radius:9999px;font-size:16px;background:#fff}.ms-reason{margin-top:8px}'
    + '.rc-to{flex:1;font-size:11px;font-weight:900;display:flex;flex-direction:column;gap:4px}.rc-to input,.rc-to-in{width:100%;box-sizing:border-box;padding:9px 12px;border:2px solid #111;border-radius:9999px;font-size:16px;background:#fff}.rc-to-in{margin-top:8px}'
    + '.hs-person{padding:10px 0;border-top:1px solid #e3e3e3}.hs-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:8px}'
    + '.hs-chip{font-size:10px;border:1px solid #ccc;border-radius:8px;padding:3px 6px;color:#999;display:flex;flex-direction:column;align-items:center;min-width:44px}.hs-chip b{font-size:9px;color:#666}.hs-chip.on{border-color:#111;color:#111;font-weight:700;background:#fff}'
    + '.hs-edit{margin-top:8px}'
    + '.bd-hero{background:#0a0a0a;color:#fff;border-radius:16px;padding:16px 18px;margin-bottom:12px;border-left:12px solid #E30613;box-shadow:5px 5px 0 #E30613}'
    + '.bd-day{font-family:"Arial Black",Impact,sans-serif;font-size:28px;font-style:italic;margin:2px 0}.bd-you{font-size:14px}.bd-count{margin-top:6px;font-size:12px;font-weight:900;color:#E30613;letter-spacing:.5px;text-transform:uppercase}'
    + '.bd-list{background:#fff;border:3px solid #111;border-radius:14px;box-shadow:4px 4px 0 #111;padding:10px 14px 12px;margin-bottom:12px}'
    + '.bd-axis{position:relative;height:16px;margin:0 0 4px;font-size:9px;color:#888;font-weight:700}.bd-axis span{position:absolute;transform:translateX(-50%);white-space:nowrap}.bd-axis span:first-child{transform:none}.bd-axis span:last-child{transform:translateX(-100%)}'
    + '.bd-row{padding:8px 0;border-top:1px solid #eee}.bd-name{font-size:14px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}.bd-time{margin-left:auto;font-size:11px;font-weight:700;color:#555}'
    + '.bd-track{position:relative;height:12px;background:#f1f1f1;border-radius:9999px;margin-top:6px;overflow:hidden}.bd-me-band{position:absolute;top:0;bottom:0;background:#ffd6d9}'
    + '.bd-bar{position:absolute;top:2px;bottom:2px;background:#111;border-radius:9999px}.bd-bar.mgr{background:#1a7f37}'
    + '.bd-legend{font-size:10px;color:#666;margin-top:8px;display:flex;align-items:center;gap:6px}.bd-key{display:inline-block;width:18px;height:8px;border-radius:9999px;background:#111}.bd-key.me{background:#ffd6d9}'
    + '.pc-item{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid #eee;cursor:pointer;flex-wrap:wrap}.pc-item input[type=checkbox]{width:22px;height:22px;accent-color:#E30613}'
    + '.pc-who{flex:1;min-width:150px}.pc-vals{display:flex;align-items:center;gap:6px;font-weight:900}.pc-cur{color:#999;text-decoration:line-through}.pc-vals input{width:120px;padding:7px 10px;border:2px solid #111;border-radius:9999px;font-size:16px;font-weight:700}'
    + '.am-ok{color:#1a7f37;font-weight:700}.am-no{color:#E30613;font-weight:700}'
    + '.ms-show{display:block;width:100%;margin:0 0 12px;padding:10px;border:2px dashed #E30613;border-radius:14px;background:#fff;color:#E30613;font-weight:900;font-size:12px;cursor:pointer}'
    + '.rc-keep{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:700;margin:4px 0 0;cursor:pointer;color:#111}.rc-keep input{width:20px;height:20px;accent-color:#E30613}'
    + '#rc-bottom-nav{display:none}'
    + 'body.rc-mobile.rc-in #rc-bottom-nav{display:flex;position:fixed;left:0;right:0;bottom:0;z-index:10000001;background:#0a0a0a;border-top:4px solid #E30613;padding:4px 2px calc(4px + env(safe-area-inset-bottom))}'
    + '#rc-bottom-nav button{flex:1;position:relative;background:none;border:none;color:#9a9a9a;display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 0;font-size:10px;font-weight:900;letter-spacing:.2px;cursor:pointer;min-height:52px}'
    + '#rc-bottom-nav button.on{color:#fff}#rc-bottom-nav button.on svg{color:#E30613}'
    + '.rc-nav-badge{position:absolute;top:2px;left:calc(50% + 6px);min-width:18px;height:18px;padding:0 5px;border-radius:9999px;background:#E30613;color:#fff;font-size:10px;display:none;align-items:center;justify-content:center;border:2px solid #0a0a0a}'
    + '#rc-more{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:10000002;display:flex;align-items:flex-end}'
    + '.rc-more-card{background:#fff;width:100%;border-radius:18px 18px 0 0;padding:16px 16px calc(16px + env(safe-area-inset-bottom));border-top:6px solid #E30613}'
    + '.rc-more-card button{display:block;width:100%;text-align:left;padding:14px 12px;border:none;border-bottom:1px solid #eee;background:#fff;font-size:15px;font-weight:900;cursor:pointer}'
    + '.rc-more-card .rc-more-out{color:#E30613}.rc-more-card .rc-more-close{text-align:center;color:#666;border:none}'
    + 'body.rc-mobile.rc-in #global-header{padding:8px 14px;gap:0}'
    + 'body.rc-mobile.rc-in #global-header .r-btns-consistent{display:none !important}'
    + 'body.rc-mobile.rc-in #global-header .r-title-consistent{font-size:20px}'
    + 'body.rc-mobile.rc-in #repco-v65,body.rc-mobile.rc-in .full-page{padding-bottom:calc(78px + env(safe-area-inset-bottom)) !important}'
    + 'body.rc-mobile.rc-in #toast-v141{bottom:calc(84px + env(safe-area-inset-bottom))}'
    + 'body.rc-mobile .r-controls{margin:8px;padding:8px;gap:6px}'
    + 'body.rc-mobile .r-controls select#fortnight-select{min-width:0;flex:1 1 0;order:1;padding:8px 10px;font-size:12px}'
    + 'body.rc-mobile .r-controls button[onclick="prevFortnight()"]{order:0;min-width:40px;padding:6px 0;font-size:20px;line-height:1}'
    + 'body.rc-mobile .r-controls button[onclick="nextFortnight()"]{order:2;min-width:40px;padding:6px 0;font-size:20px;line-height:1}'
    + 'body.rc-mobile .r-controls #rc-current{order:3;padding:5px 10px;font-size:10px}'
    + 'body.rc-mobile .r-controls button[onclick="toggleTimeFormat()"],body.rc-mobile .r-controls #delete-roster-btn{order:4;min-width:0;padding:5px 10px;font-size:10px}'
    + 'body.rc-mobile .r-controls #admin-total-badge{order:5;margin:0 !important;padding:5px 10px !important;font-size:10px !important}'
    + 'body.rc-mobile .r-controls #rc-sync-status{order:6;margin-left:auto}'
    + 'body.rc-mobile .r-controls #user-badge,body.rc-mobile .r-controls #brisbane-time-v141{display:none !important}'
    + 'body.rc-mobile .r-controls::after{content:"";order:2;flex-basis:100%;height:0}'
    + 'body.rc-mobile .roster-section{margin:10px 6px;box-shadow:3px 3px 0 #111}'
    + 'body.rc-mobile .sec-head{padding:8px 10px;font-size:12px}'
    + 'body.rc-mobile .r-table th,body.rc-mobile .r-table td{min-width:58px !important;width:58px !important;max-width:58px !important;font-size:10px;padding:5px 1px}'
    + 'body.rc-mobile .r-table.rc-easy td[data-i]{font-size:12px;font-weight:700 !important;line-height:1.15}.rc-t{display:block}.rc-t2{display:block;font-size:9px;color:#E30613;font-weight:900}'
    + 'body.rc-mobile .r-table th.rc-today-col{background:#E30613 !important;color:#fff !important}body.rc-mobile .r-table td.rc-today-col{box-shadow:inset 3px 0 0 #E30613,inset -3px 0 0 #E30613}'
    + '#rc-viewbar{display:flex;margin:8px 8px 0;border:2px solid #111;border-radius:9999px;overflow:hidden;background:#fff}#rc-viewbar button{flex:1;border:none;background:#fff;padding:9px 0;font-weight:900;font-size:12px;letter-spacing:.5px}#rc-viewbar button.on{background:#111;color:#fff}'
    + '.dv-chips{display:flex;gap:6px;overflow-x:auto;padding:10px 8px 6px;scrollbar-width:none}.dv-chips::-webkit-scrollbar{display:none}'
    + '.dv-chip{flex:0 0 auto;width:48px;border:2px solid #111;border-radius:12px;background:#fff;padding:5px 0;display:flex;flex-direction:column;align-items:center;font-size:10px;font-weight:900}.dv-chip b{font-size:17px}.dv-chip.wk{background:#e8f2fc}.dv-chip.today{border-color:#E30613;color:#E30613}.dv-chip.on{background:#111;color:#fff;border-color:#111}'
    + '.dv-head{padding:4px 12px 8px}.dv-day{font-family:"Arial Black",Impact,sans-serif;font-size:22px;font-style:italic}'
    + '.dv-list{background:#fff;border:3px solid #111;border-radius:14px;margin:0 8px;box-shadow:3px 3px 0 #111;overflow:hidden}'
    + '.dv-row{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:6px;padding:12px 14px;border-top:1px solid #eee;font-size:15px}.dv-row:first-child{border-top:none}.dv-row.own{background:#0a0a0a;color:#fff;border-left:6px solid #E30613}.dv-edit{cursor:pointer}'
    + '.dv-shift{font-weight:900;font-size:16px;white-space:nowrap}.dv-shift small{font-size:10px;font-weight:700;color:#888;margin-left:6px}.dv-row.own .dv-shift small{color:#bbb}'
    + '.dv-empty{padding:14px;color:#777}.dv-off{margin:12px 8px;padding:10px 12px;background:#fff;border:2px dashed #bbb;border-radius:12px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}.dv-off .rc-h{flex-basis:100%}'
    + '.dv-offname{font-size:12px;font-weight:700;background:#f1f1f1;border-radius:9999px;padding:4px 10px}.dv-offname.own{background:#111;color:#fff}.dv-ab,.dv-ua{font-size:9px;color:#fff;border-radius:9999px;padding:1px 5px;margin-left:2px}.dv-ab{background:#E30613}.dv-ua{background:#555}'
    + '.dv-editbox{flex-basis:100%}.dv-editbox input{width:100%;box-sizing:border-box;padding:9px 12px;border:2px solid #E30613;border-radius:9999px;font-size:16px;font-weight:700;color:#111}'
    + 'body.rc-mobile .r-table th.staff-col,body.rc-mobile .r-table td.staff-cell{min-width:104px !important;width:104px !important;max-width:104px !important;padding-left:6px;font-size:10px}'
    + 'body.rc-mobile .page-title{font-size:18px !important;padding:6px 12px !important;margin:4px 0 10px !important}'
    + 'body.rc-mobile .full-page .page-inner{padding:10px !important}'
    + 'body.rc-mobile .full-page .card:has(> button[onclick^="showMain"]:only-child){display:none}'
    + 'body.rc-mobile #options-inner button[onclick="showMain()"]{display:none}'
    + '.bd-left{font-size:11px;font-weight:700;color:#555;white-space:nowrap}.bd-left b{color:#E30613}.bd-you .bd-left{color:#ddd;margin-left:6px}.bd-you .bd-left b{color:#ff6b74}'
    + '.rc-draft{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin:8px 14px 0;padding:8px 12px;border-radius:12px;background:#fff;border:2px solid #ccc;font-size:12px;font-weight:700;color:#555}'
    + '.rc-draft.on{background:#FFF6CC;border:3px solid #b58900;color:#111}body.rc-mobile .rc-draft{margin:8px 8px 0}'
    + '.tm-row{display:flex;gap:6px;align-items:center;padding:6px 0;border-top:1px solid #eee;flex-wrap:wrap}.tm-team{margin:12px 0 2px;font-weight:900;color:#E30613;font-size:12px;letter-spacing:.5px}'
    + '.tm-user{display:flex;justify-content:space-between;gap:8px;padding:8px 0;border-top:1px solid #eee;flex-wrap:wrap}.tm-acc{display:flex;flex-direction:column;gap:4px;align-items:flex-end}.tm-chk{font-size:12px;font-weight:700}.tm-move{font-size:11px;padding:4px 8px;border:2px solid #111;border-radius:9999px;background:#fff}'
    + '.rc-guest{display:inline-block;background:#111;color:#fff;border-radius:9999px;padding:1px 7px;font-size:9px;font-weight:900;letter-spacing:.3px;vertical-align:middle;text-transform:uppercase}'
    + '#rc-team-btn{background:#111!important;color:#fff!important}#rc-fresh-btn{background:#fff;border-color:#E30613!important;color:#E30613}'
    + 'body.rc-mobile .r-controls #rc-fresh-btn,body.rc-mobile .r-controls #rc-team-btn{order:4;min-width:0;padding:5px 10px;font-size:10px}'
    + '.rc-pill.al-in{background:#1a7f37;color:#fff}.rc-pill.al-out{background:#777;color:#fff}'
    + 'body.rc-rh-s table td,body.rc-rh-s table th{padding:2px 2px !important;font-size:9.5px !important;line-height:1.15}body.rc-rh-s .dv-row{padding:7px 12px;font-size:13px}body.rc-rh-s .dv-shift{font-size:14px}'
    + 'body.rc-rh-l table td,body.rc-rh-l table th{padding:13px 3px !important;font-size:14px !important;line-height:1.3;min-width:108px !important;width:108px !important;max-width:108px !important;white-space:normal}'
    + 'body.rc-rh-l table td.staff-cell,body.rc-rh-l table th.staff-col{min-width:180px !important;width:180px !important;max-width:180px !important;font-size:14px !important}'
    + 'body.rc-mobile.rc-rh-l .r-table td,body.rc-mobile.rc-rh-l table td{min-width:80px !important;width:80px !important;max-width:80px !important;font-size:13px !important}'
    + 'body.rc-rh-l .dv-row{padding:17px 16px;font-size:18px}body.rc-rh-l .dv-shift{font-size:19px}'
    + 'body.rc-mobile .r-controls #rc-rows-btn{order:4;min-width:0;padding:5px 10px;font-size:10px}'
    + '.rc-else{display:block;margin-top:2px;font-size:8.5px;font-weight:800;color:#555 !important;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}td.cell-off .rc-else{color:#fff !important}.rc-else.rc-clash{color:#E30613 !important}.rc-else-dv{flex-basis:100%;font-size:11px;color:#666 !important}'
    + '.hist-row{display:flex;gap:10px;padding:8px 0;border-top:1px solid #eee;font-size:13px}.hist-t{flex:0 0 64px;font-weight:900;color:#E30613;font-size:12px}.hist-w{flex:1}'
    + '.hrs-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-top:1px solid #eee}.hrs-v{font-family:"Arial Black",Impact,sans-serif;font-size:20px;text-align:right}.hrs-v small{display:block;font-family:Arial,sans-serif;font-size:10px;color:#777;font-weight:700}'
    + '.ms-hint{font-size:12px;font-weight:700;color:#555;margin:4px 2px 10px}'
    + '.ms-fn{background:#fff;border:3px solid #111;border-radius:14px;box-shadow:4px 4px 0 #111;margin-bottom:14px;overflow:hidden}'
    + '.ms-fn-head{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;background:#111;color:#fff;padding:10px 14px;font-weight:900;font-size:12px}'
    + '.ms-day{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:11px 14px;border-top:1px solid #e6e6e6;font-size:13px}'
    + '.ms-today{background:#FFF6CC;border-left:6px solid #E30613}.ms-past{opacity:.45}.ms-off .ms-date{color:#777}.ms-tap{cursor:pointer}.ms-tap:active{background:#f3f3f3}'
    + '.ms-right{display:flex;align-items:center;gap:8px}.ms-time{font-weight:900;font-size:14px}.ms-hrs{font-size:11px;color:#666;min-width:34px;text-align:right}.ms-offtxt{font-size:11px;font-weight:900;color:#999}'
    + '.ms-ua{background:#555}'
    + '.ms-struck{text-decoration:line-through;color:#999;font-weight:700}'
    + '.ms-tag{background:#111;color:#fff;border-radius:9999px;padding:2px 7px;font-size:9px;font-weight:900}.ms-ab{background:#E30613}.ms-tt{background:#E30613}.ms-chev{font-size:20px;font-weight:900;color:#E30613;line-height:1}'
    + '.r-table td.rc-cell-edit{background:#fff !important;outline:3px solid #E30613;outline-offset:-3px;padding:2px !important;vertical-align:middle}'
    + '.r-table td.rc-cell-edit{overflow:hidden}'
    + '.rc-cell-input{width:154%;box-sizing:border-box;border:none;background:#FFF6CC;font-size:16px !important;font-weight:700;text-align:center;padding:5px 2px !important;border-radius:4px;outline:none;transform:scale(.65);transform-origin:left center;margin-right:-54%;display:block}'
    + '.rc-cell-acts{display:flex;gap:2px;margin-top:2px}.rc-cell-acts button{flex:1;border:none;border-radius:9999px;background:#111;color:#fff;font-size:8px;font-weight:900;padding:3px 0;cursor:pointer}.rc-cell-acts button.rc-red{background:#E30613}'
    + '.rc-cell-note{font-size:7px;color:#E30613;font-weight:900;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
    + '#rc-device-setup{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10000001;display:flex;align-items:flex-end;justify-content:center}'
    + '.rc-ds-card{background:#fff;width:100%;max-width:480px;border-radius:20px 20px 0 0;border-top:8px solid #E30613;padding:18px 18px calc(18px + env(safe-area-inset-bottom));box-shadow:0 -6px 0 #111}'
    + '.rc-ds-title{font-family:"Arial Black",Impact,sans-serif;font-size:18px;font-style:italic;margin-bottom:4px}'
    + '.rc-ds-step{display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-top:1px solid #eee}.rc-ds-body{flex:1;display:flex;flex-direction:column;gap:6px;font-size:13px}'
    + '.rc-ds-num{width:28px;height:28px;border-radius:50%;background:#111;color:#fff;font-weight:900;display:flex;align-items:center;justify-content:center;flex-shrink:0}'
    + '.rc-ds-done{color:#1a7f37;font-weight:900;font-size:13px}.rc-ds-ico{display:inline-block;border:1px solid #999;border-radius:4px;padding:0 4px}'
    + '.rc-setup{width:100%;margin-top:18px;padding:14px;border:3px solid #111;border-radius:14px;background:#fff;box-shadow:4px 4px 0 #E30613;display:flex;flex-direction:column;gap:8px;text-align:left}'
    + '.rc-setup input{background:#C4C4C4;border:none;border-radius:9999px;padding:10px 16px;font-size:14px;font-weight:600}'
    + '.rc-setup button{background:#E30613;color:#fff;border:none;border-radius:9999px;padding:12px;font-weight:900}';
  var s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
})();

/* Until Firebase answers, don't let the old login screen look ready */
(function () {
  rcLoginMsg(RC.auth ? 'Checking login...' : 'Could not reach the server - check your internet connection');
  rcLoginBusy(true);
  if (RC.auth) setTimeout(function () { if (!RC.session && !RC.loggingIn) { var e = document.getElementById('login-err'); if (e && e.textContent === 'Checking login...') rcLoginMsg(''); rcLoginBusy(false); } }, 4000);
})();
