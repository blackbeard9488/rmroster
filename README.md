# REPCO ROSTER MANAGEMENT - FIXED

## Fixes
- Roster button now works (showMain fixed)
- Empty pages fixed (account, public holidays, buddies, staff unavailable, account management)
- Data recovery: auto-deletes corrupted 0 entry, reseeds roster
- Logo: Using your provided Repco Roster Management logo for all icons
- Role menus: Staff 7, Manager all 13
- All notifications preserved

## Deploy
Upload all files to GitHub root, enable Pages: main branch / root.

If blank roster (0 dropdown), run in console:
```js
localStorage.clear();
fetch('https://repco-roster-default-rtdb.firebaseio.com/retail_roster_byFortnight_v1.json',{method:'DELETE'}).then(()=>fetch('https://repco-roster-default-rtdb.firebaseio.com/repco_state.json',{method:'DELETE'}).then(()=>location.reload()))
```
