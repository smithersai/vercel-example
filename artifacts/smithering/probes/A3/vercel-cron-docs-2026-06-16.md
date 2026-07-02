# Evidence: Vercel Cron Jobs — Usage & Pricing (fetched 2026-07-01)

Source: https://vercel.com/docs/cron-jobs/usage-and-pricing (page `last_updated: 2026-06-16`)

Fetched verbatim via WebFetch on 2026-07-01. Relevant excerpt:

> |                | **Number of cron jobs per project** | **Minimum interval** | **Scheduling precision** |
> | -------------- | ------------------------------------ | --------------------- | ------------------------- |
> | **Hobby**      | 100 cron jobs                        | Once per day          | Per-hour (±59 min)        |
> | **Pro**        | 100 cron jobs                        | Once per minute       | Per-minute                |
> | **Enterprise** | 100 cron jobs                        | Once per minute       | Per-minute                |
>
> ### Hobby scheduling limits
>
> Hobby accounts are limited to cron jobs that run **once per day**. Cron expressions that
> would run more frequently will fail during deployment with the error: "Hobby accounts are
> limited to daily cron jobs. This cron expression would run more than once per day."
>
> Timing precision: Vercel cannot assure a timely cron job invocation. For example, a cron
> job configured as `0 1 * * *` will trigger anywhere between 1:00am and 1:59am (Hobby).
>
> For cron jobs that run more frequently or with precise timing, upgrade to Pro.

## Key facts extracted

1. **Hobby plan cannot run a 1-minute cron at all.** A `* * * * *` expression fails
   *deployment*, not just runtime — this is a hard blocker, not a reliability caveat.
2. **Pro/Enterprise support "once per minute" with "per-minute" scheduling precision.**
   This is the plan's stated tier for the `/api/cron/tick` design (see
   `docs/planning/02-design.md` Decision D21).
3. **Vercel does not publish a numeric reliability SLA** (e.g. "fires ≥58/60 times per
   hour") for Pro/Enterprise cron. "Per-minute precision" is qualitative, not a guarantee
   count. No empirical uptime/jitter data is published on this page.
4. We could not find, on this page, any explicit statement of *how many minutes per hour*
   a Pro cron is expected to actually fire (e.g. skipped ticks under platform load). That
   number (the literal "≥58 times/hour" in the assumption) is not something Vercel
   documents — it would require a live, hours-long deployment to measure empirically,
   which is out of scope for this probe (see `README.md`).
