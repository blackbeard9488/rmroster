# Repco Roster – setup

The roster now uses a new Firebase project (`repco-roster`) with real logins, live updates for everyone,
and locked-down database rules. Everything here uses free plans.

## 1. Firebase (one time, about 5 minutes)

In https://console.firebase.google.com → project **repco-roster**:

1. **Build → Authentication → Get started → Sign-in method → Email/Password → Enable → Save.**
   Staff never see or need an email address. The app turns each username into a hidden login address.
2. **Build → Realtime Database → Rules.** Delete everything in the box, paste in the whole of
   [`database.rules.json`](database.rules.json) from this repo, then press **Publish**.

## 2. Put the new version live

Merge this branch into the branch GitHub Pages serves (usually `main`). Open devices pick up
the new version within about 30 seconds and reload themselves.

## 3. First login and moving your data across

1. Open the site. Because the new database is empty, the login page shows **FIRST-TIME SETUP**.
   Create your admin account straight away (before anyone else can).
2. You'll land on **ACCOUNT MANAGEMENT**. Under **IMPORT FROM OLD VERSION**, press **LOAD OLD DATABASE**.
   It reads the old `testing-de079` database and lists the logins it found.
   - Shared logins (`admin`, `manager`, `master`) are unticked by default. Leave them that way.
   - Logins whose password is the same as the username are marked **weak**. Use **RESET PASSWORD** after the import.
3. Press **IMPORT NOW**. Rosters, requests, archive and staff logins are copied across.
   Staff keep their current username and password.
4. Check each user's **first and last name** matches the roster (the list shows "on roster" or
   "no matching roster name"). Shift offers, alerts and "← YOU" depend on it.

## 4. Close the old database

The old `testing-de079` database is open to anyone online and holds every old password.
Once the import has worked: in that project, go to **Realtime Database → Rules**, set
`".read": false, ".write": false`, publish, then delete its data.

## 5. Phone notifications when the app is closed (optional, free)

Alerts already work while the app is open. For alerts while it is closed, set up the free relay in
[`push-worker/README.md`](push-worker/README.md), then paste its address into `RC_PUSH_WORKER_URL`
at the top of `cloud.js`.

Each person then opens **INBOX → TURN ON NOTIFICATIONS ON THIS DEVICE**.
On iPhone they must first use **Share → Add to Home Screen**, and open the app from that icon.

## 6. Roles

| Role | Can do |
|------|--------|
| **Master** | Everything, in every team: logins and passwords, roles, teams, the access log |
| **Manager** | Their own team: rosters, shift edits, requests, adding staff, hidden staff, settings, change history |
| **Admin** | Their own team: roster changes (every change is in the change history), and sending a shift change for an employee for a manager to approve. No requests list and no logins. |
| **Staff** | Their own schedule, offers and requests |

Managers can't see master logins in Account Management. Passwords, roles and removing logins are done by a master.

## 7. More than one team (optional)

Each team has its own staff, managers, admins, rosters, requests, offers and change history. People in one
team can't see another team; masters see every team.

1. Paste the latest `database.rules.json` into Firebase (Realtime Database → Rules → Publish).
2. Sign in as a master. **Options → TEAMS → ADD TEAM**, then **OPEN** it. Add that team's managers, admins and
   staff in Account Management. New logins join the team that's open.
3. Upload the team's Excel, or press **+ NEW / DUPLICATE** on the roster to start an empty fortnight or copy the
   one on screen (copies always start as a draft).
4. To give someone both teams, make them a master.

To put someone from another team on a team's roster, open that team and go to **Account Management →
BORROWED FROM OTHER TEAMS**. Pick the person and press **ADD TO ROSTER**. They get a row on that team's roster
from the current fortnight on, along with that team's shift offers and alerts. Their shifts in both teams show
live on their My Schedule. In the other team they only have staff access.

When the same person is on two teams' rosters (for example hidden staff in one team and normal staff in the
other), the app links them by name. Managers and admins see that person's shifts from the other team in their
cells, with a red ⚠ if both teams have them working the same day. The person sees both teams' shifts on
My Schedule, whichever login they use. Staff don't see any of this.

The Kate notes row and the Luke/Chris green cells only apply to the first team.

## How things work now

- **Logins**: username and password only. Managers add people, reset forgotten passwords and remove
  access in ACCOUNT MANAGEMENT. Everyone can change their own password on the ACCOUNT page.
  Passwords are no longer stored in the page or the database.
- **Live**: every change (shift edits, requests, approvals, offers) reaches everyone within a second.
  Each cell is saved on its own, so two managers editing different cells never overwrite each other.
  A change that would delete every roster is blocked.
- **Excel is the original**: the uploaded Excel shift is the cell's original. Clearing a cell
  (backspace, then SAVE) puts the Excel shift back. Typing `OFF` sets OFF. Re-uploading the same
  fortnight updates untouched cells and keeps manager edits, approvals and accepted offers.
  Any spreadsheet row that mentions "Kate" is ignored.
- **Shift offers**: a manager taps an empty cell (one with no shift in the Excel upload), types a
  time and presses **OFFER SHIFT**. The employee sees it in **INBOX** (never on the roster view) and
  can accept or decline. Accepting puts it on the roster immediately. Clearing the cell or pressing
  CANCEL OFFER withdraws it and removes the employee's alert. UPDATE OFFER changes the time.
- **Requests**: staff send unavailability and shift corrections from **INBOX → REQUESTS**. Managers
  approve or deny them there. Approved unavailability is also applied to rosters uploaded later.
  **REVERSE** undoes an approval and restores the uploaded shifts.
- **PDF export** (OPTIONS → IMPORT ROSTER / EXPORT) is a picture of the roster table exactly as it
  looks on screen, colours included.
- **Backup**: ACCOUNT MANAGEMENT → DOWNLOAD FULL BACKUP. The free Firebase plan has no automatic
  backups, so download one now and then.
- **Sessions**: you stay logged in across refreshes and are logged out after 30 minutes of
  inactivity. Logging out clears the roster from that device.
