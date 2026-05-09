# AthloFit.in

This is now a small full-stack fitness web app that can:

- sync your activity data to your own account
- work across browsers and devices once deployed
- estimate when different distance and time goals are realistic
- give you weekly targets based on recent training data
- store a basic profile for calorie and protein targets
- log multiple activity types in one shared activity model

## New features now included

- dashboard with goal, calories, weekly activity, streak, and recent activity
- profile: age, sex, height, weight, activity level, and main goal
- calories v1: daily calorie target and protein target
- unified activity logging for running, walking, HIIT, HYROX, strength, and bodybuilding
- `Comfort` vs `Race-ready` forecast mode
- optional `goal date` check
- custom `goal distance`, such as 5 km, 10 km, or 21.1 km
- optional `target time`, such as 30:00 for 5 km under 30 minutes
- `readiness score` out of 100
- simple charts for weekly distance and long-run trend
- a smarter `next 4 weeks` planner with a cutback week
- account sign-up and sign-in
- email verification + password-reset scaffolding
- backend cloud-style persistence with SQLite

## Run it locally

Windows:

1. Double-click [start.bat](C:\Users\Aditya\Documents\Codex\2026-04-24-can-we-build-an-app-program\start.bat).
2. Your browser should open `http://localhost:3000`.

Mac:

1. Run [start.command](C:\Users\Aditya\Documents\Codex\2026-04-24-can-we-build-an-app-program\start.command).
2. If macOS blocks double-clicking it, open Terminal in the project folder and run `bash start.command`.
3. Your browser should open `http://localhost:3000`.

Then:

1. Create an account or sign in.
2. Complete your profile for calorie/protein estimates.
3. Set your goal distance and optional target time.
4. Log activities manually.

Or:

1. Open the manual entry section.
2. Type each activity with date, distance, and time.
3. Or paste multiple running entries as `YYYY-MM-DD, distance in km, hh:mm:ss`.
4. Click **Analyze logged data**.

You can also switch the forecast mode and add a goal date before analyzing.

## Files

- [server.js](C:\Users\Aditya\Documents\Codex\2026-04-24-can-we-build-an-app-program\server.js): local server, account API, SQLite persistence
- [app.js](C:\Users\Aditya\Documents\Codex\2026-04-24-can-we-build-an-app-program\app.js): frontend UI and forecasting logic
- [index.html](C:\Users\Aditya\Documents\Codex\2026-04-24-can-we-build-an-app-program\index.html): app layout
- [style.css](C:\Users\Aditya\Documents\Codex\2026-04-24-can-we-build-an-app-program\style.css): styling
- [data.sqlite](C:\Users\Aditya\Documents\Codex\2026-04-24-can-we-build-an-app-program\data.sqlite): created automatically when the server starts
- [AUTH_UPGRADE_PLAN.md](C:\Users\Aditya\Documents\Codex\2026-04-24-can-we-build-an-app-program\AUTH_UPGRADE_PLAN.md): next sprint plan for email verification and forgot password
- [WORK_FROM_HOME.md](C:\Users\Aditya\Documents\Codex\2026-04-24-can-we-build-an-app-program\WORK_FROM_HOME.md): how to use, clone, and run the project from your home laptop

## What "comfortable" means

The forecast is intentionally conservative. It does not assume that one big run means you are ready. Instead, it looks for enough weekly volume and enough recent long-run capacity that 21K should feel manageable rather than heroic.

## Deployment

To access it from your phone or any browser, this app needs to be deployed to a public host. The easiest path is:

1. Create a GitHub repo and push this folder.
2. Go to Railway and choose **New Project**.
3. Choose **Deploy from GitHub repo** and select this repo.
4. Railway will detect the [Dockerfile](C:\Users\Aditya\Documents\Codex\2026-04-24-can-we-build-an-app-program\Dockerfile).
5. After the app service appears, add a Railway volume to the service.
6. Set the volume mount path to `/data`.
7. Deploy again if Railway does not automatically redeploy.
8. Open the generated Railway public URL from your phone.
9. Sign in with the same account to see the same saved data.

The app automatically stores SQLite data at Railway's volume path when `RAILWAY_VOLUME_MOUNT_PATH` is available. Locally, it stores data in `data.sqlite`.

## Email scaffolding

The backend now includes:

- verification-email token flow
- resend verification endpoint
- forgot-password endpoint
- reset-password endpoint
- optional Resend integration

To turn on real email delivery in deployment, set:

```text
APP_BASE_URL=https://your-app-domain
EMAIL_FROM=no-reply@your-domain
RESEND_API_KEY=your_resend_key
```

If those are not configured yet, the server falls back to preview links in the server logs so the flow can still be tested during development.

## Current assumptions

- It only uses activities labeled as runs.
- It mainly looks at the last 12 weeks so the result reflects current fitness.
- It expects distance values in kilometers, meters, or miles and converts when possible.
- It tries to read pace and duration if present, but the forecast mostly depends on distance and consistency.
