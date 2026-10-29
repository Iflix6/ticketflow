# Runbook — applying migrations

**Audience:** whoever is deploying. **Owner area:** `scripts/migrate.ts`, `apps/api/src/db/migrations`.
This is a *planned* operation, not an incident. If a migration has already half-applied, jump to
[rollback.md](rollback.md).

## The runner's contract (read once; it is the safety model)

`scripts/migrate.ts` is deliberately framework-free; the rules fit in one file:

- Migrations are `NNNN_name.up.sql` / `NNNN_name.down.sql` pairs in `apps/api/src/db/migrations`, applied
  in ascending version order.
- **Each version runs in its own transaction.** PostgreSQL DDL is transactional, so a failed migration
  `ROLLBACK`s completely — you never get a half-created table. It prints `FAILED (rolled back)` and exits 1.
- Applied versions are recorded in `migrations.schema_migrations` with a **sha256 checksum of the file**.
  The ledger lives in its own `migrations` schema (not `app`) precisely so a full `--down` (which drops
  `app`) can still find the ledger.
- **Editing an already-applied `.up.sql` is a hard error**, not a re-run: the checksum mismatch aborts with
  `Migration NNNN_name changed after being applied … Add a new migration instead of editing history.`
  Append-only history is the invariant.
- A `pg_advisory_lock` serializes concurrent deploy steps so two runners cannot race the same DDL.

## Pre-flight (always)

```powershell
# 1. Back up the data tier before any schema change (this is the real safety net, not --down).
docker compose exec -T postgres pg_dump -U ticketflow -d ticketflow -Fc -f /tmp/ticketflow-pre-migrate.dump
docker compose cp postgres:/tmp/ticketflow-pre-migrate.dump ./backups/    # pull it off the container

# 2. See exactly what will be applied and confirm the ledger is where you expect:
docker compose exec -T postgres psql -U ticketflow -d ticketflow -c `
  "SELECT version, name, applied_at FROM migrations.schema_migrations ORDER BY version;"
```

## Apply

```powershell
npm run migrate
# applying NNNN_name ... ok            (one line per newly-applied version)
# database is up to date               (nothing pending — idempotent, safe to re-run)
```

The API and worker assume the schema at boot. After a migrate, restart both so they re-probe against the
new shape (`npm run dev:api`, `npm run dev:worker`; or `docker compose up -d --force-recreate api worker`).

## Post-apply verification (the schema change is not "done" until these pass)

```powershell
# Correctness invariants must still hold against the migrated schema:
npm run invariants -- --quiescent        # all invariants hold, exit 0
# The full gate proves nothing downstream broke:
npm run verify                            # build + typecheck + lint + unit + integration + boot smoke
```

If a migration touched the invariant views or their base tables, the invariant run **is** the acceptance
test — do not skip it.

## Writing a good migration (rules that keep `--down` honest)

- Ship a matching `.down.sql` **in the same PR** — `migrate:down` errors `Missing rollback script for …`
  otherwise. Rollback is reviewed alongside forward, always.
- Prefer **expand → migrate → contract**: add the new column/table, deploy code that reads both, then a
  later migration drops the old. PostgreSQL cannot always reverse a destructive change in a down script.
- A data correction (e.g. fixing drifted counters found via
  [reconciliation-mismatch.md](reconciliation-mismatch.md)) belongs here as a versioned migration, never as
  an ad-hoc `UPDATE` against production.

## See also

- [rollback.md](rollback.md) — reversing an applied version.
- `migrations.md` pairs with every deploy step; the invariants and `npm run verify` commands are the same
  ones the CI gate runs.
