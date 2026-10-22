# REPCO ROSTER - FIXED V168

## Fixes Applied:
1. vite.config.js -> base: '/rmroster/' (was missing, caused 404 on GitHub Pages)
2. sw.js -> urlsToCache now uses /rmroster/ prefix, network-first for Firebase, clears old cache v167
3. manifest.json -> start_url and scope now /rmroster/, removed broken Logo.png 2000x2000 reference that blocked install, added all icon sizes
4. firebase-messaging-sw.js -> databaseURL fixed to asia-southeast1 region, placeholder for real apiKey/senderId
5. firebase.json -> public: dist (was '.'), added database rules link
6. database.rules.json -> granular rules for each node
7. package.json -> added vite, plugin-react, gh-pages, build scripts, homepage
8. index.html -> kept your V167 full roster (751KB) - no changes needed, but ensure Firebase config inside uses real DB URL
9. Deleted duplicates: index_1.html, index_2.html, index_react.html, manifest.json.txt, sw.js.txt, etc

## Firebase Data Fix (Do in Console):
- repco_state/maintenance_mode must be boolean false, not string ""false""
- Delete duplicate retail_roster_byFortnight_v1 inside repco_state
- Delete push_notifications and repco_notifications_v1 to stop triple notifications

## Deploy:
npm install
npm run build
npm run deploy
Then hard refresh https://blackbeard9488.github.io/rmroster/ with Ctrl+Shift+R
