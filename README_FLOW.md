# REPCO ROSTER - Base44 Flow + Username Only + Firebase

This version flows like your base44 template:

## Flow
1. **AuthLayout** - Centered card with Repco corners, icon, title, subtitle
2. **Register** - Username, First/Last, Password, Confirm → OTP step (6-digit)
3. **OTP Verify** - InputOTP component, checks Firebase `otps/{username}`
4. **Login** - Username + Password, checks `retail_roster_users_v1`
5. **Roster App** - Protected route, header with user badge, iframe to existing roster OR full React roster

## Why it flows nicely like base44:
- Same component structure: AuthLayout > Button > Input > Label > InputOTP
- Same visual: rounded-full buttons with shadow-[4px_4px_0_#111], border-[3px] border-black
- Same logic: showOtp state → conditional render OTP screen
- Same toast pattern
- All data through Firebase RTDB, no base44

## Files to Upload to GitHub

### Option A - Simple (just roster):
Upload:
- /index.html (your 766KB full roster)
- /rmroster/index.html (same file)
- /.gitattributes
- /manifest.json

### Option B - Full React App (base44 flow):
Upload everything in this zip:
- /src/pages/Register.jsx - Username only + OTP via Firebase
- /src/pages/Login.jsx - Username only
- /src/components/AuthLayout.jsx - Base44-style layout with Repco corners
- /src/components/ui/* - Button, Input, InputOTP, GoogleIcon
- /src/App.jsx - Router + Firebase init + ProtectedRoute + Roster wrapper
- /src/main.jsx + index.css + vite.config.js + index_react.html
- /rmroster/index.html - Your existing roster (embedded via iframe)
- firebase.json, database.rules.json

## Firebase Rules
All data goes through:
- retail_roster_users_v1 - users
- retail_roster_byFortnight_v1 - rosters
- users/{username}
- otps/{username}
- logins/{username}
- repco_state/*

Set rules to:
{
  "rules": {
    ".read": true,
    ".write": true
  }
}

For production, lock down to auth.

## Menus by Role (fixed)
Staff sees: ROSTER, SHIFT OFFERS, TODAY'S BUDDIES, TOMORROW'S BUDDIES, MY SCHEDULE, ACCOUNT, LOG OUT
Manager/Admin sees: ALL + DELETE ROSTER + BYPASS PENDING

## How Username-Only Works
- No email field anywhere
- Username is primary key, stored lowercase for lookup
- Password stored in retail_roster_users_v1 (hash in production)
- Firebase RTDB stores same data for sync
- OTP generated locally, stored in otps/{username} with expiry

## Deploy
1. npm install
2. npm run build
3. Upload dist/ + rmroster/ to GitHub
4. Enable Pages: main branch / root or /docs

Or just upload index.html + rmroster/index.html for simple deploy.
