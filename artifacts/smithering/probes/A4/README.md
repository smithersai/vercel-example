# A4 — Neon branch create/reset latency probe

**Question:** does `neon branches create` (via the Neon API, since the `neon`/`neonctl`
CLI is not installed in this environment) return a usable connection string in under
60 seconds from CI?

## Method

Used the Neon API directly with `NEON_API_KEY` (already present in env) against the
existing `smithers-multi-prod` project (`mute-bar-47103064`, org `org-long-lab-58335738`):

1. `POST /projects/{project}/branches` — create branch `probe-a4-test` with a
   `read_write` endpoint. (`04_create_response.json`, secrets redacted)
2. Poll `GET /projects/{project}/branches/{branch}` until `current_state == "ready"`.
   (`06_poll_1.json`)
3. `GET /projects/{project}/connection_uri` for the pooled `neondb_owner` connection
   string. (`07_connection_uri.json`, password redacted)
4. TCP-connect to the pooled endpoint host:5432 to confirm the compute is actually
   reachable (no `psql`/`psycopg2`/`pg` available in this environment, so this is a raw
   socket check rather than a real query — see Limitations). (`10_tcp_connect_timing.txt`)
5. `DELETE /projects/{project}/branches/{branch}` to clean up. (`11_delete_response.json`)

## Result

| Step | Elapsed |
|---|---|
| Branch create → `current_state: ready` | **0.3 s** (ready on first poll) |
| TCP reachability of pooled endpoint | **0.19 s** |

Total well under the 60 s budget — by roughly two orders of magnitude, on the free plan,
against a project already warmed by prior activity.

## Limitations / what wasn't verified

- No `psql`/Postgres client library was available in this sandbox, so a real
  `SELECT 1` round-trip was not executed — only TCP-level reachability of the pooled
  endpoint. The endpoint reported `current_state: ready` from the branch API, which in
  Neon's model means the compute is provisioned and should accept SQL connections, but
  this probe did not directly confirm a query executes.
- This ran against the Neon **free** plan tier, not the plan CI/Vercel Preview will
  actually use in production. Neon docs indicate branch-create latency is dominated by
  compute cold-start, which is plan/autoscaling-config dependent, not by the control-plane
  API call itself — so paid-plan behavior should be equal or better, but wasn't measured.
- Single sample, single region (`aws-us-east-2`), against a project with an existing
  branch tree (not a cold/empty project). CI-quota throttling under many concurrent PRs
  (fan-out) is untested — this only proves one branch create/delete cycle.
- The API key used is a personal account key, not a CI-scoped key with the quota limits
  the real pipeline would have.

## Cleanup

The test branch (`br-orange-haze-aj69w458`) was deleted via the API at the end of the
probe (`11_delete_response.json`); no persistent state was left in the Neon project. No
secrets are stored in any artifact file (passwords redacted post-hoc, verified with
`grep -rl npg_` returning no hits).
