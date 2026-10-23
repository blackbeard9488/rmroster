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
  byKey: {}
};
RC_SYNC.forEach(function (s) { RC.byKey[s.key] = s; });

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
  var next = rcToCloud(spec, local);
  var prev = RC.base[spec.key];
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
  RC.db.ref().update(updates).then(function () {
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
    Object.keys(next || {}).forEach(function (fk) {
      var nf = next[fk], of = prev && prev[fk];
      var fnLabel = rcFnRange(rcDecodeTree(nf));
      if (!of) { newFns.push(fk); }
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
            updates['offers/' + oid + '/status'] = 'cancelled';
            updates['offers/' + oid + '/respondedTs'] = firebase.database.ServerValue.TIMESTAMP;
            rcWithdrawOfferAlert(offer, updates);
            notes.push({ withdraw: offer });
          }
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
      if (!of && prev) {
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
function rcReqSummary(r) {
  if (!r) return '';
  if (r.type === 'unavailability') { var d = rcAsArray(r.dates); return 'Unavailable ' + (d.length > 1 ? d[0] + ' - ' + d[d.length - 1] : (d[0] || '')) + (r.reason ? ' (' + r.reason + ')' : ''); }
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
function rcManagerUids() { return rcUserList().filter(function (u) { return rcIsMgrRole(u.role); }).map(function (u) { return u.uid; }); }
function rcUserByUsername(name) { var l = String(name || '').toLowerCase(); return rcUserList().find(function (u) { return u.usernameLower === l; }) || null; }
/* Every login whose name matches a roster row (someone can have an admin and a staff login) */
function rcUsersForStaff(st) {
  if (!st) return [];
  var f = String(st.firstName || '').toLowerCase().trim(), l = String(st.lastName || '').toLowerCase().trim();
  if (!f) return [];
  return rcUserList().filter(function (u) { return String(u.firstName || '').toLowerCase().trim() === f && String(u.lastName || '').toLowerCase().trim() === l; });
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
    RC.users = all;
    var mine = all[uid];
    if (!mine) { rcForceLogout('Your account has been removed. Ask a manager for help.'); return; }
    var roleChanged = rcIsMgrRole(mine.role) !== rcIsMgrRole(RC.session.profile.role);
    RC.session.profile = mine;
    safeSet('repco_username', mine.username);
    safeSet('repco_currentRole', String(mine.role || 'staff').toLowerCase());
    rcSetLocal('retail_roster_users_v1', rcUserList().map(function (u) { return { username: u.username, firstName: u.firstName || '', lastName: u.lastName || '', role: u.role, employmentType: u.employmentType || 'casual', isHidden: !!u.isHidden, uid: u.uid }; }));
    RC.ready.users = true;
    if (roleChanged) { toast('Your access level changed - reloading'); setTimeout(function () { location.reload(); }, 1500); return; }
    rcScheduleRender('users');
  }, function () {
    // Losing read access to the user list means this account was deleted
    if (RC.session) rcForceLogout('Your account has been removed. Ask a manager for help.');
  });
  RC_SYNC.forEach(function (spec) {
    if (spec.mgrRead && !mgr) { rcSetLocal(spec.key, JSON.parse(JSON.stringify(spec.def))); return; }
    rcListen(RC.db.ref(spec.path), 'value', function (s) { rcOnValue(spec, s.val()); });
  });
  var offersRef = mgr ? RC.db.ref('offers') : RC.db.ref('offers').orderByChild('toUid').equalTo(uid);
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
  var conn = RC.db.ref('.info/connected');
  rcListen(conn, 'value', function (s) { rcSetStatus(s.val() ? 'live' : 'offline'); });
}
function rcDetach() { RC.listeners.forEach(function (off) { try { off(); } catch (e) {} }); RC.listeners = []; RC.ready = {}; RC.base = {}; RC.offers = {}; RC.notifs = []; RC.users = {}; }

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
  RC.session = { uid: user.uid, profile: profile };
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
  var badge = document.getElementById('user-badge'); if (badge) badge.textContent = String(profile.username).toUpperCase() + ' • ' + String(profile.role || 'staff').toUpperCase();
  rcSetStatus(RC.online === false ? 'offline' : 'live');
  rcRenderBell(); rcRenderOfferBanner();
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
    if (!last || Date.now() - last > INACTIVITY_LIMIT_MS) {
      rcClearLocal();
      RC.auth.signOut();
      rcShowLogin(last ? 'Session timed out after 30 minutes of inactivity. Please log in again.' : '');
      return;
    }
  }
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
  RC.session = null;
  rcDetach();
  rcClearLocal();
  if (!RC.auth || !RC.auth.currentUser) return;
  // Stop this phone getting the leaving person's alerts, then sign out
  var done = false, out = function () { if (done) return; done = true; if (RC.auth.currentUser) RC.auth.signOut(); };
  setTimeout(out, 2500);
  rcThisDeviceSubId().then(function (sid) { return sid && leaving ? RC.db.ref('push/' + leaving + '/' + sid).remove() : null; }).catch(function () {}).then(out);
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
    box.innerHTML = '<div class="rc-h">FIRST-TIME SETUP</div><div class="rc-small">No accounts exist yet. Create the main admin account. After this, add everyone else from ACCOUNT MANAGEMENT, or import them from the old database.</div>'
      + '<input id="rc-su-user" placeholder="Admin username" autocomplete="off"><input id="rc-su-first" placeholder="First name"><input id="rc-su-last" placeholder="Last name">'
      + '<input id="rc-su-pass" type="password" placeholder="Password (min 6)"><input id="rc-su-pass2" type="password" placeholder="Confirm password">'
      + '<button type="button" onclick="rcBootstrap()">CREATE ADMIN ACCOUNT</button><div id="rc-su-err" class="rc-err"></div>';
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
    upd['users/' + uid] = { username: u, usernameLower: u.toLowerCase(), firstName: first, lastName: last, role: 'admin', employmentType: 'fulltime', createdTs: Date.now() };
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
  Object.keys(RC.offers).forEach(function (oid) { if (RC.offers[oid].toUid === uid) upd['offers/' + oid + '/toUid'] = acc.uid; });
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
    return '<div class="rc-row"><div><b>' + rcEsc(u.username) + '</b> <span class="rc-pill">' + rcEsc(u.role) + '</span><br><span class="rc-small">' + rcEsc((u.firstName || '') + ' ' + (u.lastName || '')) + ' • ' + rcEsc(u.employmentType || '') + ' • ' + (linked ? '<span style="color:#1a7f37">on roster</span>' : '<span style="color:#E30613">no matching roster name</span>') + '</span></div>'
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
        else { if (!st.originalShifts) st.originalShifts = {}; if (!st.absentApproved) st.absentApproved = {}; if (st.originalShifts[di] == null) st.originalShifts[di] = st.shifts[di]; st.shifts[di] = req.newShift; st.absentApproved[di] = false; }
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
  if (!rcIsMgr()) { _rcOrigRenderRequests(); setTimeout(rcRenderMyRequestsList, 0); return; }
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
    + (done.length ? '<div class="rc-h" style="margin:14px 0 8px">RECENT DECISIONS</div>' + done.map(function (r) { return card(r, false); }).join('') : '')
    + '<div class="card"><button onclick="showMain()" class="rc-b rc-wide">← BACK</button></div>';
};
/* Staff: replace the "my requests" box with one that shows live status and can withdraw pending ones */
function rcRenderMyRequestsList() {
  var el = document.getElementById('requests-list'); if (!el || !RC.session) return;
  var box = document.getElementById('rc-my-reqs');
  if (!box) {
    Array.prototype.forEach.call(el.querySelectorAll('.card'), function (c) { if (/MY REQUESTS/.test(c.textContent)) c.remove(); });
    box = document.createElement('div'); box.id = 'rc-my-reqs';
    var back = el.lastElementChild; el.insertBefore(box, back);
  }
  var me = RC.session.profile.usernameLower;
  var mine = rcAsArray(safeGetJSON('retail_roster_requests_v2', [])).filter(function (r) { return String(r.username || '').toLowerCase() === me; }).sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
  box.innerHTML = mine.length ? '<div class="card"><div class="rc-h">MY REQUESTS (' + mine.length + ')</div>' + mine.map(function (r) {
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
  RC.db.ref('offers/' + oid).set(offer).then(function () {
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
  var upd = {}; upd['offers/' + oid + '/status'] = 'cancelled'; upd['offers/' + oid + '/respondedTs'] = firebase.database.ServerValue.TIMESTAMP;
  rcWithdrawOfferAlert(o, upd);
  return RC.db.ref().update(upd).then(function () {
    rcPushWithdraw(o);
    if (!quiet) toast('Offer withdrawn - ' + o.toUsername + '\'s alert removed');
  }).catch(function (e) { toast('Not cancelled: ' + rcErrMsg(e)); });
}
function rcCancelOffer(oid) { return rcWithdrawOffer(oid, false); }
function rcRespondOffer(oid, accept) {
  var o = RC.offers[oid];
  if (!o || o.status !== 'pending') { toast('This offer is no longer available'); return; }
  if (rcOfferExpired(o)) { toast('This shift date has passed'); return; }
  var upd = {};
  upd['offers/' + oid + '/status'] = accept ? 'accepted' : 'declined';
  upd['offers/' + oid + '/respondedTs'] = firebase.database.ServerValue.TIMESTAMP;
  if (accept) {
    var cellPath = 'data/roster/' + o.fn + '/staff/' + o.sk;
    upd[cellPath + '/shifts/' + o.i] = o.shift;
    var curFn = rcAsArray(safeGetJSON('retail_roster_byFortnight_v1', [])).find(function (f) { return rcEncodeKey(f.id) === o.fn; });
    var curSt = curFn && curFn.staff[rcStaffKeys(curFn).map(rcEncodeKey).indexOf(o.sk)];
    var hasOrig = curSt && curSt.originalShifts && curSt.originalShifts[o.i] != null;
    if (!hasOrig) upd[cellPath + '/originalShifts/' + o.i] = (curSt && curSt.shifts && curSt.shifts[o.i]) || 'OFF';
  }
  RC.db.ref().update(upd).then(function () {
    toast(accept ? 'Accepted - the shift is now on your roster' : 'Offer declined');
    var who = RC.session.profile.username;
    var uids = rcManagerUids(); if (o.byUid && uids.indexOf(o.byUid) === -1) uids.push(o.byUid);
    rcNotify(uids, { type: accept ? 'offer-accepted' : 'offer-declined', title: who + (accept ? ' accepted a shift' : ' declined a shift'), body: o.dateLabel + ' ' + o.shift + (accept ? ' is now on the roster.' : ' is still open.') });
    rcCloseModal();
  }).catch(function (e) {
    console.error(e);
    toast(accept ? 'Could not accept - the shift may have been filled or withdrawn' : 'Could not decline: ' + rcErrMsg(e));
  });
}
function rcCloseModal() { var m = document.getElementById('custom-modal'); if (m) m.classList.remove('show'); }
function rcMyPendingOffers() {
  if (!RC.session) return [];
  return Object.keys(RC.offers).map(function (k) { return Object.assign({ id: k }, RC.offers[k]); })
    .filter(function (o) { return o.toUid === RC.session.uid && o.status === 'pending' && !rcOfferExpired(o); })
    .sort(function (a, b) { return String(a.dateIso).localeCompare(String(b.dateIso)); });
}
/* Mark offered cells on the roster */
renderRosterSafe = (function (orig) {
  return function () { var r = orig.apply(this, arguments); try { rcDecorateRoster(); rcCurrentIndicator(); } catch (e) { console.error('decorate', e); } return r; };
})(renderRosterSafe);
/* Shows whether the roster on screen is the one containing today, with a quick way back to it */
function rcCurrentIndicator() {
  var sel = document.getElementById('fortnight-select'); if (!sel) return;
  var today = getCurrentFortnight(), shown = getSelectedFortnight();
  var iso = getISO();
  var todayId = today && today.dates.some(function (d) { return d.iso === iso; }) ? today.id : null;
  Array.prototype.forEach.call(sel.options, function (o) {
    if (!o.dataset.base) o.dataset.base = o.textContent;
    o.textContent = o.dataset.base + (o.value === todayId ? '  ★ CURRENT' : '');
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
    var toMgr = RC.users[uid] && rcIsMgrRole(RC.users[uid].role);
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
function rcUnreadAlerts() { return RC.notifs.filter(function (n) { return !n.read; }).length + (rcIsMgr() ? 0 : rcMyPendingOffers().length); }
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
  var open = document.querySelector('.full-page.show');
  if (open && (open.id === 'notif-page' || open.id === 'requests-page')) rcInboxTabs(open.id);
  try { if (navigator.setAppBadge) { if (n) navigator.setAppBadge(n); else navigator.clearAppBadge(); } } catch (e) {}
}
openPage = (function (orig) {
  return function (id) {
    if (id === 'hidden-staff-page' && !rcIsMgr()) { toast('Admin only'); return; }
    orig.apply(this, arguments);
    if (id === 'hidden-staff-page') renderHiddenStaffPage();
    if (id === 'notif-page') rcRenderNotifPage(true);
    if (id === 'notif-page' || id === 'requests-page') { rcInboxTabs(id); document.querySelectorAll('#btn-notif').forEach(function (b) { b.classList.add('active'); }); }
    else document.querySelectorAll('#btn-notif').forEach(function (b) { b.classList.remove('active'); });
    if (id === 'notif-page') setTimeout(rcRenderBell, 300);
  };
})(openPage);
function rcRenderNotifPage(markRead) {
  var el = document.getElementById('notif-inner'); if (!el || !RC.session) return;
  var h = '';
  if (!rcIsMgr()) {
    var offers = rcMyPendingOffers();
    h += '<div class="card"><div class="rc-h">SHIFT OFFERS</div>' + (offers.length ? offers.map(function (o) {
      return '<div class="rc-row"><div><b>' + rcEsc(o.dateLabel) + '</b> ' + rcEsc(fmt(o.shift)) + '<br><span class="rc-small">' + rcEsc(o.fnLabel || '') + '</span></div><div class="rc-btns"><button class="rc-b rc-green" onclick="rcRespondOffer(\'' + o.id + '\',true)">ACCEPT</button><button class="rc-b rc-white" onclick="rcRespondOffer(\'' + o.id + '\',false)">DECLINE</button></div></div>';
    }).join('') : '<div class="rc-small">No open offers right now.</div>') + '</div>';
  } else {
    var all = Object.keys(RC.offers).map(function (k) { return Object.assign({ id: k }, RC.offers[k]); }).sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); }).slice(0, 40);
    h += '<div class="card"><div class="rc-h">SHIFT OFFERS</div><div class="rc-small">To offer a shift, tap an empty cell on the roster.</div>' + (all.length ? all.map(function (o) {
      var st = o.status === 'pending' && rcOfferExpired(o) ? 'expired' : o.status;
      return '<div class="rc-row"><div><b>' + rcEsc(o.dateLabel) + '</b> ' + rcEsc(fmt(o.shift)) + ' → ' + rcEsc(o.toUsername) + ' <span class="rc-pill rc-st-' + rcEsc(st) + '">' + rcEsc(st) + '</span><br><span class="rc-small">by ' + rcEsc(o.byName) + ' • ' + new Date(o.ts || 0).toLocaleString() + '</span></div>' + (o.status === 'pending' ? '<button class="rc-b rc-white" onclick="rcCancelOffer(\'' + o.id + '\')">CANCEL</button>' : '') + '</div>';
    }).join('') : '') + '</div>';
  }
  h += rcPushCardHtml();
  h += '<div class="card"><div class="rc-row" style="border:none"><div class="rc-h">NOTIFICATIONS</div>' + (RC.notifs.length ? '<button class="rc-b rc-white" onclick="rcClearNotifs()">CLEAR ALL</button>' : '') + '</div>' + (RC.notifs.length ? RC.notifs.map(function (n) {
    return '<div class="rc-notif' + (n.read ? '' : ' rc-unread') + '"><div style="font-weight:900">' + rcEsc(n.title) + '</div><div class="rc-small" style="white-space:pre-line">' + rcEsc(n.body || '') + '</div><div class="rc-small" style="opacity:.6">' + new Date(n.ts || 0).toLocaleString() + (n.from && rcIsMgr() ? ' • ' + rcEsc(n.from) : '') + '</div></div>';
  }).join('') : '<div class="rc-small">Nothing yet.</div>') + '</div>';
  h += '<div class="card"><button onclick="showMain()" class="rc-b rc-wide">← BACK TO ROSTER</button></div>';
  el.innerHTML = h;
  if (markRead) {
    var upd = {};
    RC.notifs.forEach(function (n) { if (!n.read) upd['notifications/' + RC.session.uid + '/' + n.id + '/read'] = true; });
    if (Object.keys(upd).length) RC.db.ref().update(upd).catch(function () {});
  }
}
function rcClearNotifs() {
  var upd = {}; RC.notifs.forEach(function (n) { upd['notifications/' + RC.session.uid + '/' + n.id] = null; });
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
    if (sub) { s.textContent = 'On for this device ✓'; if (b) { b.textContent = 'SEND A TEST ALERT'; b.onclick = rcTestPush; } }
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
  if (h) return h + 'h ' + mm + 'm';
  return mm + 'm';
}
function rcMyRows() {
  var fns = rcAsArray(safeGetJSON('retail_roster_byFortnight_v1', [])), out = [];
  fns.forEach(function (fn) {
    var me = findMyStaff(fn); if (!me) return;
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
function rcSchedPanel(r, pend) {
  var id = 'ms-ed';
  if (pend) {
    return '<div class="ms-edit" onclick="event.stopPropagation()"><div class="ms-edit-h">You asked for: ' + rcEsc(rcReqSummary(pend)) + '</div><div class="rc-small">Waiting for a manager.</div>'
      + '<div class="rc-btns" style="margin-top:8px"><button class="rc-b rc-white" onclick="rcSchedWithdraw(\'' + rcEsc(rcReqId(pend)) + '\')">WITHDRAW</button><button class="rc-b rc-white" onclick="rcSchedToggle(null)">CLOSE</button></div></div>';
  }
  var p = parseShiftRange(r.sh), pad = function (n) { return String(n).padStart(2, '0'); };
  var st = p ? pad(Math.floor(p.start / 60) % 24) + ':' + pad(p.start % 60) : '', en = p ? pad(Math.floor(p.end / 60) % 24) + ':' + pad(p.end % 60) : '';
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
  if (cant) newShift = 'UA';
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
  toast(cant ? 'Sent - a manager will review it' : 'New times sent to a manager');
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
    var rows = rcMyRows(), now = Date.now(), today = getISO();
    if (!rows.length) { el.innerHTML = '<div class="card">Your login isn\'t linked to a roster row yet. Ask a manager to check your first and last name in Account Management.</div>'; return; }
    var current = rows.find(function (r) { return r.t && r.t.start.getTime() <= now && now < r.t.end.getTime(); });
    var next = rows.filter(function (r) { return r.t && r.t.start.getTime() > now; }).sort(function (a, b) { return a.t.start - b.t.start; })[0];
    var h = '';
    if (current) {
      var pct = Math.min(100, Math.max(0, (now - current.t.start) / (current.t.end - current.t.start) * 100));
      h += '<div class="ms-panel ms-on" data-end="' + current.t.end.getTime() + '" data-start="' + current.t.start.getTime() + '"><div class="ms-kicker">ON SHIFT NOW</div>'
        + '<div class="ms-big"><span class="ms-count">' + rcDur(current.t.end - now) + '</span> to go</div>'
        + '<div class="ms-sub">' + rcEsc(current.d.day + ' ' + current.d.date) + ' • ' + rcEsc(fmt(current.sh)) + ' • finishes ' + rcEsc(fmt(current.sh).split('-')[1] || '') + '</div>'
        + '<div class="ms-bar"><div style="width:' + pct.toFixed(1) + '%"></div></div></div>';
    } else if (next) {
      var key = next.fn.id + '|' + next.i + '|' + next.sh;
      if (!rcSchedDismissed(key)) {
        h += '<div class="ms-panel ms-next" data-start="' + next.t.start.getTime() + '"><button class="ms-x" title="Hide" onclick="rcSchedDismiss(\'' + rcEsc(key).replace(/'/g, '') + '\')">✕</button><div class="ms-kicker">NEXT SHIFT</div>'
          + '<div class="ms-big">starts in <span class="ms-count">' + rcDur(next.t.start - now) + '</span></div>'
          + '<div class="ms-sub">' + rcEsc(next.d.day + ' ' + next.d.date) + ' • ' + rcEsc(fmt(next.sh)) + (next.d.iso === today ? ' • TODAY' : '') + '</div></div>';
      }
    } else {
      h += '<div class="ms-panel ms-none"><div class="ms-kicker">NO UPCOMING SHIFTS</div><div class="ms-sub">Nothing on the roster for you yet.</div></div>';
    }
    h += '<div class="ms-hint">Need a change? Tap an upcoming shift.</div>';
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
        var tap = work && !past && (!r.t || r.t.start.getTime() > now);
        var pend = tap ? rcMyPendingChange(r.fn.id, r.i, r.d.date) : null;
        var key = r.fn.id + '|' + r.i, open = tap && RC.schedOpen === key;
        if (pend) right += '<span class="ms-tag ms-req">CHANGE REQUESTED</span>';
        h += '<div class="' + cls + (tap ? ' ms-tap' + (open ? ' ms-open' : '') + '" onclick="rcSchedToggle(\'' + rcEsc(key) + '\')"' : '"') + '><span class="ms-date"><b>' + rcEsc(r.d.day) + '</b> ' + rcEsc(r.d.date) + (isToday ? ' <span class="ms-tag ms-tt">TODAY</span>' : '') + '</span><span class="ms-right">' + right + (tap ? '<span class="ms-chev">' + (open ? '⌄' : '›') + '</span>' : '') + '</span></div>';
        if (open) h += rcSchedPanel(r, pend);
      });
      h += '</div>';
    });
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
  Promise.all(['data', 'mgrdata', 'offers', 'users'].map(function (p) { return RC.db.ref(p).once('value').then(function (s) { return [p, s.val()]; }); }))
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
    + '.rc-notif{padding:8px 0;border-bottom:1px solid #e3e3e3}.rc-unread{border-left:5px solid #E30613;padding-left:8px}'
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
