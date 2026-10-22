# REPCO ROSTER - All Features Preserved

## ✅ Features Verified (Nothing Lost)

- **Notifications**: retail_roster_notifications, updateRequestsBadge, title badge (5), flashing REQUESTS button, BroadcastChannel sync
- **Phone Notifications**: ServiceWorker, PushManager, FCM, VAPID, enablePhoneNotifications()
- **Shift Offers**: retail_roster_shift_offers_v1, renderShiftOffers, shift-offers-badge
- **Requests**: retail_roster_requests_v2, pending/approved/denied, readByAdmin/readByStaff
- **Public Holidays**: retail_roster_public_holidays_v1
- **Hidden Staff**: retail_roster_hidden_staff_v1
- **Buddies**: TODAY'S BUDDIES, TOMORROW'S BUDDIES
- **My Schedule**: my-schedule-card, renderMySchedule
- **Archive**: archive page
- **Account**: account page
- **Time Format**: 12H/24H toggle
- **Bypass Pending**: BYPASS PENDING - DIRECT SET toggle + per-edit confirm
- **Delete Roster**: deleteCurrentRoster
- **Role Visibility**: applyRoleVisibility, isManagerRole, getActualRole - Staff sees 7 menus, Manager sees all 13
- **Firebase**: cloudSave, cloudLoadAll, FIREBASE_DB_URL, all data through Firebase
- **Seed**: seedIfEmpty, retail_roster_byFortnight_v1
- **Banner**: 📅 CURRENT ROSTER only (date details removed)
- **C Logic**: shopClosed, CLOSED, originalShifts - whole-day C closes all shifts, clearing restores originals

## File Info
- Size: 766KB
- Brace balance: 5311/5311
- Try/catch: 736/736 balanced
- No syntax errors

## Menus by Role (Fixed)
Staff (role=staff):
- ROSTER, SHIFT OFFERS, TODAY'S BUDDIES, TOMORROW'S BUDDIES, MY SCHEDULE, ACCOUNT, LOG OUT

Manager/Admin/Master:
- ALL: ROSTER, REQUESTS, SHIFT OFFERS, STAFF UNAVAILABLE, TODAY'S BUDDIES, TOMORROW'S BUDDIES, MY SCHEDULE, OPTIONS, ARCHIVE, ACCOUNT, HIDDEN STAFF, PUBLIC HOLIDAYS, LOG OUT
- Plus DELETE ROSTER and BYPASS PENDING controls

## Username Only (No Email)
- Login: username + password
- Register: username + first/last + password + OTP via Firebase RTDB otps/{username}
- All keys: retail_roster_users_v1, retail_roster_byFortnight_v1, etc.
- Firebase: https://repco-roster-default-rtdb.firebaseio.com

## Base44 Flow (React)
- src/components/AuthLayout.jsx - centered card with Repco corners
- src/pages/Register.jsx - username + OTP flow like base44 template
- src/pages/Login.jsx - username only
- src/App.jsx - Router + ProtectedRoute
- All UI: rounded-full, border-[3px] border-black, shadow-[4px_4px_0_#111]

## Deploy to GitHub
1. Upload entire folder to repo
2. Settings > Pages > Source: main branch, / (root)
3. Site at https://username.github.io/repo/

## Recovery if blank (shows 0)
Console (F12):
```js
localStorage.removeItem('retail_roster_byFortnight_v1');
localStorage.removeItem('retail_roster_currentFortnightId');
localStorage.removeItem('repco_cloud_ts');
fetch('https://repco-roster-default-rtdb.firebaseio.com/retail_roster_byFortnight_v1.json',{method:'DELETE',mode:'cors'}).then(()=>location.reload());
```
