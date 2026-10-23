# Push relay (free Cloudflare Worker)

Browsers only deliver phone notifications while the app is closed if a server sends them.
Firebase's server option needs a paid plan, so this small relay runs on Cloudflare's free plan
(100,000 requests a day, no card needed).

## Set it up (about 10 minutes)

1. Sign up at https://dash.cloudflare.com (free plan).
2. **Workers & Pages → Create → Create Worker.** Name it `repco-roster-push`, then **Deploy**.
3. **Edit code.** Delete the sample code, paste in all of [`worker.js`](worker.js), then **Deploy**.
4. **Settings → Variables and Secrets → Add**:

   | Type   | Name                | Value |
   |--------|---------------------|-------|
   | Text   | `DB_URL`            | `https://repco-roster-default-rtdb.asia-southeast1.firebasedatabase.app` |
   | Text   | `VAPID_PUBLIC_KEY`  | the `RC_VAPID_PUBLIC_KEY` value at the top of `cloud.js` |
   | Secret | `VAPID_PRIVATE_KEY` | the private key you were given with this change (never put it in the repo) |
   | Text   | `VAPID_SUBJECT`     | `mailto:` followed by your email address |
   | Text   | `ALLOWED_ORIGIN`    | `https://blackbeard9488.github.io` |

5. Copy the worker's address (something like `https://repco-roster-push.<name>.workers.dev`) and put it in
   `RC_PUSH_WORKER_URL` at the top of `cloud.js`.

## How it stays safe

The page sends the signed-in person's Firebase login token with each request. The worker uses that
token to read the recipients' phone subscriptions, so the database rules decide who may send.
Anyone without a roster account is refused. The private key stays in Cloudflare.

If you ever need new keys, run `npx web-push generate-vapid-keys`, put the public key in `cloud.js`
and in the worker, and the private key in the worker. Everyone then needs to turn notifications on again.
