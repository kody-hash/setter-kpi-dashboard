# Setter KPI Dashboard

Live daily KPI dashboard for Top Drawer Cabinetry's setter — tracks unique leads called and texted per day, with answered/responded breakouts.

**Live URL:** https://kody-hash.github.io/setter-kpi-dashboard/

## How it works

A scheduled GitHub Action pulls fresh data from GoHighLevel every 15 minutes (Mon-Fri 7am-6pm Phoenix time) and writes it to `data.json`. The static page (`index.html`) loads that JSON and renders the dashboard.

## Files

- `index.html` — dashboard UI (plain HTML + Chart.js from CDN)
- `data.json` — latest snapshot (auto-refreshed)
- `scripts/refresh.js` — pulls GHL data, computes unique counts, writes `data.json`
- `.github/workflows/refresh.yml` — schedules the refresh

## KPIs

- **Unique leads called** — distinct contacts dialed (target: 30/day)
- **Answered (≥30s)** - picked up for at least 30 seconds
- **Unique leads texted** — distinct contacts SMS'd (target: 50/day)
- **Responded same-day** — texted back same calendar day (target: Phoenix time)

All counters reset at midnight Phoenix.

## Adjust

- Targets: edit `CALL_TARGET`, `TEXT_TARGET` in `index.html`.
- Refresh frequency: edit `cron` in `.github/workflows/refresh.yml`.
