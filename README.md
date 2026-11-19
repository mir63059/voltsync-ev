# RideaseVX — Smart EV Charging Station

A prototype EV charging management SPA with Supabase authentication, realtime station data, wallet transactions, QR scanner/generator, and an admin dashboard.

## 1. Supabase setup

1. Create a project at https://supabase.com.
2. Open **SQL Editor**.
3. Paste the complete contents of `supabase-schema.sql` and select **Run**.
4. In Supabase **Authentication → URL Configuration**, set the Site URL to `https://mir63059.github.io/voltsync-ev/` and add `https://mir63059.github.io/voltsync-ev/**` to Redirect URLs.
5. In **Authentication → Providers → Email**, enable Email/Password authentication.
6. Create an account through the app, then in **Table Editor → profiles**, set that user's `role` column to `admin`.

The schema seeds three Karachi stations with example coordinates. Verify and replace these coordinates and station records before using them for real-world directions or operations.

### Security note

The anon key is public and safe for browser use when RLS policies are enabled. Never expose a Supabase service-role key in `app.js` or any static deployment.

Charging telemetry is currently simulated in the browser. Do not use client-generated energy values for real billing; connect a trusted device gateway or server-side telemetry verifier before enabling physical charging.

On `localhost`, `127.0.0.1`, `.local` hostnames, and private LAN addresses, the charging control runs a local-only simulation against the loaded station list. Choose a PKR 500/1,000/1,500 or custom budget before starting; the simulator caps the bill at that amount and stops if the remaining wallet cannot cover the per-kWh rate. Simulated sessions and wallet changes are not persisted to Supabase. On deployed hosts, starting a session remains disabled until trusted device telemetry is connected.

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
```

The publishable/anon key is browser-safe with RLS enabled. Copy secret/service-role values only to the ignored `.env` file for backend/server code. Never add `SUPABASE_SECRET_KEY` to `app.js`, `index.html`, or any `NEXT_PUBLIC_*`/browser variable.

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

Wallet top-ups are disabled in the live Supabase app until a verified payment provider is integrated; demo-mode top-ups are local only.

## 9. ESP32 MQTT firmware

The included `esp32-firmware.ino` publishes sensor telemetry and receives START/STOP commands over MQTT, but it is not yet bridged to Supabase. A trusted server-side gateway must validate device messages and write station/session telemetry before live energy billing is enabled. Supabase Realtime mirrors committed database updates into connected browsers. MQTT broker credentials must not be committed to public repositories; provision them through secure firmware configuration.
