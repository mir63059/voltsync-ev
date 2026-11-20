# RideaseVX — Smart EV Charging Station

A prototype EV charging management SPA with Supabase authentication, realtime station data, manually verified Easypaisa payments, QR scanner/generator, and an admin dashboard.

## 1. Supabase setup

1. Create a project at https://supabase.com.
2. Open **SQL Editor**.
3. Paste the complete contents of `supabase-schema.sql` and select **Run**.
4. In Supabase **Authentication → URL Configuration**, set the Site URL to `https://mir63059.github.io/voltsync-ev/` and add `https://mir63059.github.io/voltsync-ev/**` to Redirect URLs.
5. In **Authentication → Providers → Email**, enable Email/Password authentication.
6. Run `supabase-easypaisa-migration.sql` in the SQL Editor after `supabase-schema.sql`.
7. Create an account through the app, then in **Table Editor → profiles**, set that user's `role` column to `admin`.

The schema seeds three Karachi stations with example coordinates. Verify and replace these coordinates and station records before using them for real-world directions or operations.

### Security note

The anon key is public and safe for browser use when RLS policies are enabled. Never expose a Supabase service-role key in `app.js` or any static deployment.

The app never treats a submitted TID or amount as proof of payment. An administrator must verify the transfer in Easypaisa and approve the request; only then does the database credit that exact amount. Charging reserves no more than the verified balance, and the database caps billing at the session budget. Legacy `wallet_balance` values are not spendable.

The static website cannot prove payment, verify device telemetry, or stop a physical charger. Do not connect real vehicles until a trusted charger gateway is deployed to report authenticated meter readings and cut the relay when the database closes the session. Without that integration, the SQL only provides a budget cap; it does not switch hardware off.

To test from a phone on the same Wi-Fi, serve the app on your computer's LAN interface and open its private IP address. Camera QR scanning requires HTTPS on a phone; over plain HTTP, select a station from the list instead. Network firewall rules may also need to allow the development server port.

## 2. Configure credentials

Option A — configure in the deployed app:

1. Open the app.
2. Click the gear icon.
3. Enter the Supabase Project URL and anon/publishable key.
4. Click **Connect**.

Option B — production constants:

Edit the browser-safe constants at the top of `app.js`:

```js
const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_...';
const EASYPAISA_ACCOUNT_TITLE = 'Your actual Easypaisa account title';
const EASYPAISA_ACCOUNT_NUMBER = 'Your actual Easypaisa account number';
const EASYPAISA_QR_IMAGE = './easypaisa-qr.png';
const ADMIN_EMAILS = ['your-admin-email@example.com'];
```

The publishable/anon key is browser-safe with RLS enabled. Copy secret/service-role values only to the ignored `.env` file for backend/server code. Never add `SUPABASE_SECRET_KEY` to `app.js`, `index.html`, or any `NEXT_PUBLIC_*`/browser variable.

Replace the Easypaisa placeholders with your real receiving account and admin email, and add your actual QR image as `easypaisa-qr.png` in the project root. Do not use a generated or unrelated QR code. Promote the admin's profile to `role='admin'` in Supabase; the frontend email list only controls display, while database policies and RPCs enforce permissions.

You can promote the intended administrator in the SQL Editor with:

```sql
update public.profiles
set role='admin'
where email='your-admin-email@example.com';
```

Replace the example address with the exact account email and confirm the affected row before running it.

### Easypaisa and charging SQL rollout

- For a new Supabase project, run `supabase-schema.sql`, then `supabase-easypaisa-migration.sql`.
- For an existing project created with this schema, back up the database and run only `supabase-easypaisa-migration.sql`.
- Before the migration, check for existing duplicate active sessions; the migration adds one-active-session-per-user and one-active-session-per-station indexes:

```sql
select user_id, count(*) from public.sessions
where status='active' group by user_id having count(*) > 1;

select station_id, count(*) from public.sessions
where status='active' group by station_id having count(*) > 1;
```

Resolve any returned rows manually before applying the migration. In Supabase **Table Editor → profiles**, set only the trusted administrator's `role` to `admin`. Review each payment TID and amount in Easypaisa before approving it in the app. A TID is globally unique in the database, and repeated or already-reviewed requests cannot be credited again.

After the migration adds `budget_pkr`, inspect any pre-existing active sessions:

```sql
select id, user_id, station_id, budget_pkr
from public.sessions
where status='active';
```

Do not settle any legacy active session with a zero budget; stop the physical station safely and resolve that row with your database operator before allowing users to charge.

### Auth concurrency and limits

The app has no global client-side account/session cap; each browser profile/device uses its own Supabase auth session. Supabase defaults allow multiple active sessions per user, but the project's **Authentication → Sessions** settings can enforce one session per user; leave that disabled if users must stay signed in on multiple devices. Sign-up/sign-in endpoints are rate-limited by IP, and Supabase's built-in email sender is limited to 2 emails/hour. For high-volume registrations, configure custom SMTP and adjust **Authentication → Rate Limits** to an appropriate, abuse-resistant value; raising limits cannot bypass email-provider delivery capacity.

## 3. Run locally for testing

Camera APIs require HTTPS or `localhost`.

```bash
cd voltsync-ev
python -m http.server 8080
```

Open `http://localhost:8080`.

## 4. Push to GitHub

```bash
git init
git add .
git commit -m "Build RideaseVX"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPOSITORY.git
git push -u origin main
```

## 5. Deploy with GitHub Pages

1. Push this project to a public GitHub repository named `voltsync-ev`.
2. In the repository, open **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**, select branch `main` and folder `/(root)`, then select **Save**.
4. Wait for the Pages deployment to finish. The site URL is `https://<username>.github.io/voltsync-ev/`.
5. In Supabase, open **Authentication → URL Configuration**. Set **Site URL** to `https://mir63059.github.io/voltsync-ev/` and add `https://mir63059.github.io/voltsync-ev/**` to **Redirect URLs**. Sign-up confirmation links use this Pages URL rather than `localhost`.
6. To install on Android, open the Pages URL in Chrome and select **Install App** or the browser's install option. On iPhone or iPad, open it in Safari, tap **Share**, then **Add to Home Screen**. The HTML, styles, and icons are cached; external libraries, sign-in, and Supabase data still require a network connection.

This is a static site and needs no build command. Its app and stylesheet are referenced with relative paths, and its Supabase endpoint and external browser libraries use HTTPS.

## 6. Deploy with Vercel

1. Import the GitHub repository in https://vercel.com.
2. Set **Framework Preset** to `Other`.
3. Set the output/root directory to the project directory.
4. Deploy.

No build command or environment variables are required when credentials are configured through the gear modal or the browser-safe constants.

## 7. Deploy with Netlify

1. Import the GitHub repository in https://app.netlify.com.
2. Set publish directory to `voltsync-ev` or `.` depending on repository layout.
3. Leave build command blank.
4. Deploy.

## 8. QR codes

Admins can open **View / Print QR** in the telemetry table. The QR content is JSON:

```json
{"station_id":"CHG-001"}
```

Older QR codes containing `charger_id` are still accepted. Users click **Open Camera to Scan QR**. The camera requires browser camera permission and an HTTPS deployment.

Easypaisa requests remain pending until an administrator verifies them. A charging budget is reserved from the verified paid balance; unused reservation is returned when the session is settled.

## 9. ESP32 MQTT firmware

The included `esp32-firmware.ino` publishes sensor telemetry and receives START/STOP commands over MQTT, but it is not yet bridged to Supabase. A trusted server-side gateway must validate device messages, invoke the protected telemetry function, and turn off the relay when the budget is exhausted before live energy billing is enabled. Supabase Realtime mirrors committed database updates into connected browsers. MQTT broker credentials must not be committed to public repositories; provision them through secure firmware configuration.
