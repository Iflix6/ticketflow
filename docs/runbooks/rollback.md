# Runbook — rollback

**Audience:** whoever is deploying / on call after a bad release. **Owner area:** deployment + schema.

"Rollback" means two different, often-sequenced actions. Pick the right one (or both):

- **Application rollback** — redeploy the previous code. Almost always the *first* move after a bad
  deploy, because it is reversible and fast.
- **Schema rollback** — run the migration's `--down`. Slower and, for destructive migrations, not always
  possible; a restore-from-backup is the true safety net.

The guiding rule: **prefer a forward-fix or an app rollback over a schema rollback.** `--down` on a
migration that dropped or rewrote data cannot recreate it, no matter what the script says.

## 1. Application rollback

```powershell
# Rebuilt container running the prior tag/sha:
docker compose up -d --force-recreate api worker
# Or locally, run the previous build's entrypoint:
npm run build ; npm run start:api          # node apps/api/dist/server.js
```

Verify it is healthy and serving before touching the schema:

```powershell
curl.exe -s http://127.0.0.1:4000/health/ready     # readiness (dependencies ok) — distinct from /health/live
curl.exe -s http://127.0.0.1:9464/health/live       # worker liveness
npm run boot:smoke                                  # 8 checks against the built artifact
npm run invariants -- --quiescent                    # correctness held across the switch
```

## 2. Schema rollback (only if the app rollback is insufficient or the schema itself is the fault)

Check the ledger and roll back the newest applied version(s):

```powershell
docker compose exec -T postgres psql -U ticketflow -d ticketflow -c `
  "SELECT version, name, applied_at FROM migrations.schema_migrations ORDER BY version DESC;"

npm run migrate:down            # rolls back exactly 1 newest version, in its own transaction
npm run migrate:down -- 2       # rolls back the newest 2, reverse order
```

`scripts/migrate.ts` contract that keeps this honest:

- Each `.down.sql` runs inside **its own transaction**; a failure prints `FAILED (rolled back)` and aborts,
  leaving the database unchanged from before that step — a rollback can itself be safely retried.
- It errors `Missing rollback script for NNNN_name` if the pair is absent — this is why
  [migrations.md](migrations.md) requires the down script in the same PR.
- The ledger is in the `migrations` schema, so even a full `--down` that drops `app` still knows what it
  already reversed.

## 3. Restore from backup (the only path when a destructive migration must be undone)

If `--down` cannot recover the data (dropped column, changed type, migrated rows), restore the pre-change
dump taken in [migrations.md](migrations.md) §Pre-flight:

```powershell
docker compose stop api worker                                   # no writers during restore
docker compose exec -T postgres pg_restore -U ticketflow -d ticketflow --clean --if-exists /tmp/ticketflow-pre-migrate.dump
docker compose up -d api worker
npm run invariants -- --quiescent                                # prove the restored state is consistent
```

A restore is a *deliberate data-loss* decision (everything after the dump is gone). Confirm the dump
timestamp and get sign-off before running it; document what was lost.

## Ordering that avoids most incidents

1. Expand-only migration (adds columns/tables, breaks nothing) → deploy new code that reads both shapes.
2. Back-fill / migrate data.
3. Contract migration (drops the old shape) only once no running code references it.

With that discipline, "rollback" is almost always just step **1** (app rollback), and you rarely need
`--down` at all.

## Never do

- Never run `--down` past the point your code still expects: rolling the schema back under a running new
  API guarantees errors. Stop or roll back the app first.
- Never hand-`DROP`/`ALTER` to "make the schema match" as a substitute for a versioned migration — that
  desynchronizes the checksummed ledger and the next `npm run migrate` aborts on a checksum mismatch.

## See also

- [migrations.md](migrations.md) — forward application and the append-only history rule.
- [reconciliation-mismatch.md](reconciliation-mismatch.md) — if a rollback is triggered *by* a consistency
  finding, the fix belongs in a migration, not an ad-hoc `UPDATE`.
