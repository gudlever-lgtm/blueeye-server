# When a deploy goes wrong

`scripts/deploy.sh` has three places it can stop, and each one stops on purpose
rather than carrying on. What follows is what to do at each.

## The order of a deploy

1. **Pre-flight** — every repo is clean and on the deploy branch (nothing has
   been pulled yet), docker compose exists.
2. **Pull** — all repos, with retries. The pre-pull commit of each is remembered
   as the rollback target.
3. **Dump** — `mysqldump` of the live database to `backups/blueeye-<ts>.sql.gz`,
   *before* anything starts. A dump smaller than 4 KiB is treated as a failed
   dump and the deploy stops: a truncated file that looks like a backup is worse
   than no backup.
4. **Build + start** — `up -d --build`. The server container's command is
   `migrate && server`, so this is the moment pending migrations run.
5. **Restart server** — re-packages the on-disk agent source.
6. **Health** — `/health` must answer 200 within ~60 s.
7. **Smoke** — the dashboard loads, an unknown path is 404, an auth-gated route
   is 401. A 500 anywhere here is a server that boots but does not work.
8. **Version reconciliation** — the server is serving the agent version on disk.

Steps 6 and 7 are **fatal**. They used to warn and print "Done." on the way to
exit 0, which meant a broken deploy looked like a good one and the next person
to notice was a customer. `test/deploySmokeContract.test.js` pins the status
codes the smoke checks assert, so they cannot drift away from what the app
returns.

## The deploy failed its health or smoke check

The script prints the last 60 lines of the server log, the exact `git -C … checkout <sha>`
for every repo, and the restore command for the dump it took. Code rollback is
safe to do; whether to restore the database depends on step 4:

- **No migration ran this deploy** (the log says "No pending migrations") →
  check the code out and rebuild. Leave the database alone.
- **A migration ran and succeeded, the app is broken for another reason** →
  check the code out and rebuild. Migrations are written to leave the previous
  server version working (add columns, don't rename; widen, don't narrow), so
  the old code runs against the new schema. Leave the database alone.
- **A migration failed** → see below.

The script never rolls the database back by itself. MySQL commits DDL as it
goes; a half-reverted schema is worse than a stopped one, and only a person who
has looked at it can say which half it is in.

## A migration failed

`src/migrate.js` writes a `running` row for a migration **before** running it,
and flips it to `applied` afterwards. So a file that died — or whose process was
killed — leaves `running` or `failed` behind, and the next boot stops with:

```
Refusing to migrate: 1 migration(s) started and never finished:
  148_something.sql (failed): Duplicate column name 'foo'
```

That refusal is the feature. Replaying a file that is already half in the schema
fails on whatever it already created, on every boot, for ever — the container
command is `migrate && server`.

Decide which half it is in, by looking:

```sh
docker compose exec db mysql -u root -p"$MYSQL_ROOT_PASSWORD" blueeye \
  -e 'SHOW CREATE TABLE whatever_the_migration_touched'
```

Then pick one:

```sh
# It did finish (the error came after the last statement). Record it and move on.
docker compose exec server node src/migrate.js --mark-applied 148_something.sql

# It did not. Undo its partial work by hand first, then let it run again.
docker compose exec server node src/migrate.js --retry 148_something.sql
```

Or restore the pre-deploy dump and start the old code — the clean option when
the partial state is not obvious:

```sh
gunzip < backups/blueeye-<ts>.sql.gz \
  | docker compose exec -T db sh -c 'exec mysql -u root -p"$MYSQL_ROOT_PASSWORD" blueeye'
```

Neither `--mark-applied` nor `--retry` runs or undoes any SQL. They only ever
touch the `schema_migrations` row, because the schema is the operator's call.

## "Another migration run has held the lock"

Two containers started at once, and the runner takes a MySQL named lock
(`blueeye_schema_migrations`) for the whole run so only one applies anything.
Nothing was applied by the one that printed this. If no other deploy is running,
a previous one was killed mid-migration — check for a `running` row as above.

## "An already-applied migration has been edited"

A file's sha256 no longer matches what was recorded when it was applied. Every
database that ran the old bytes now differs from every database that will run
the new ones, and nothing but this check would ever say so. Put the change in a
**new** numbered migration. If the edit really is cosmetic (a comment), record
the new content:

```sh
docker compose exec server node src/migrate.js --accept-checksum 148_something.sql
```

Migrations applied before checksums existed have no recorded hash; those are
backfilled on the next run rather than reported, because there is no way to know
retroactively what they contained.

## Related

- `docs/gate.md` — the pre-build gate; no branch is deployed without it passing.
- `docs/command-signing.md` — why a privileged agent command now fails with a
  503 instead of going out unsigned.
