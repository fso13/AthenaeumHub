# Backup and restore — operation notes

Scripts in this directory operate on the production compose stack
(`deploy/production/docker-compose.prod.yml`) through `docker compose exec/run`.
No PostgreSQL or MinIO host port is required or published.

| File | Purpose |
|---|---|
| `preflight.sh` | Validates `.env.prod` placeholders, lengths, E2EE flag, Keycloak realm/client and compose config |
| `backup.sh` | `pg_dump --format=custom` for `krug` and `keycloak`, `mc mirror` for MinIO, SHA-256 manifest, retention |
| `restore.sh` | Verified restore of both databases and the MinIO bucket; requires typing `RESTORE` |

The complete production runbook is [`docs/PRODUCTION-RUNBOOK.md`](../../docs/PRODUCTION-RUNBOOK.md).

## What a backup contains

`krug-backup-YYYYMMDDTHHMMSSZ[-tag]/`

| Entry | Contents |
|---|---|
| `app.dump` | Application DB (`krug`) as a PostgreSQL custom-format archive |
| `keycloak.dump` | Keycloak DB (`keycloak`) as a PostgreSQL custom-format archive |
| `minio/<bucket>/...` | Object mirror of the S3 bucket (managed files) |
| `app.pg_dump.log`, `keycloak.pg_dump.log` | `pg_dump --verbose` output |
| `minio.log` | `mc mirror` output |
| `MANIFEST.txt` | Timestamp, git commit, DB/bucket names, retention, skip flags |
| `SHA256SUMS` | SHA-256 for every file in the directory |

The backup deliberately **does not** contain:

- `deploy/production/.env.prod` (DB passwords, SMTP password, MinIO keys);
- `KRUG_CONTENT_KEY` and `KRUG_AUTH_BFF_EMAIL_SECRET_KEY`;
- the Caddy private keys in the `krug-prod-caddy-data` volume.

The content key is required to decrypt managed message bodies. Store it in a
secret manager and back it up separately; a database backup without the key is
not a usable restore for managed messages.

## Pre-flight

```bash
./deploy/scripts/preflight.sh --strict
```

Fails on `CHANGE_ME`/`change-me` placeholders, short secrets, `KRUG_E2EE_ENABLED=true`,
master-realm/admin-cli runtime Keycloak access, a 465 SMTP port and
`S3_SCAN_MODE=noop` (in `--strict`). It never prints secret values.

## Backup

```bash
# From the repository root, as a user allowed to run docker compose:
./deploy/scripts/backup.sh

# Explicit paths and a pre-upgrade tag:
./deploy/scripts/backup.sh \
  --env-file deploy/production/.env.prod \
  --out-dir /srv/backups/krug \
  --tag pre-upgrade
```

Options: `--skip-minio`, `--skip-keycloak`, `--retention-days N`,
`--no-retention`, `--help`. The script:

1. verifies that `postgres`, `keycloak-postgres` and (unless skipped) `minio`
   are running;
2. dumps both databases through the container's Unix socket using the
   container's `POSTGRES_*` environment (passwords are not placed in `argv`);
3. validates each archive with `pg_restore --list`;
4. mirrors the bucket with `mc mirror --overwrite --preserve` (it never deletes
   objects in the backup);
5. writes `MANIFEST.txt` and `SHA256SUMS`, then atomically renames the
   `.partial` directory into place;
6. removes only directories matching `krug-backup-*` older than the retention
   window. A failed run leaves no valid-looking backup directory.

Default retention is 30 days (`KRUG_BACKUP_RETENTION_DAYS` or the flag). Set
`KRUG_BACKUP_DIR` in `.env.prod` or pass `--out-dir`; the default
`deploy/backups` is convenient for a smoke test but **not** a real backup
location.

### Schedule (systemd timer, Linux)

`/etc/systemd/system/krug-backup.service`:

```ini
[Unit]
Description=Krug production backup
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
User=krug
WorkingDirectory=/opt/krug
ExecStart=/opt/krug/deploy/scripts/backup.sh --out-dir /srv/backups/krug
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
```

`/etc/systemd/system/krug-backup.timer`:

```ini
[Unit]
Description=Daily Krug backup

[Timer]
OnCalendar=*-*-* 02:15:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now krug-backup.timer
```

The service user needs access to the Docker socket (normally membership in the
`docker` group). That is effectively root-equivalent on the host; restrict the
account and the host to the same trust boundary.


A cron entry is equivalent, but it must not put secrets on the command line:

```cron
15 2 * * * cd /opt/krug && ./deploy/scripts/backup.sh --out-dir /srv/backups/krug >> /var/log/krug-backup.log 2>&1
```

### Off-host copy and encryption

The backup directory is mode `0700` and the dump files are `0600`, but that is
not encryption. Copy backups to a different failure domain and encrypt at rest.
Example (choose one, keep the key outside the backup host):

```bash
# age: encrypt the whole directory into one file
tar -C /srv/backups/krug -czf - krug-backup-20260101T021500Z \
  | age -r age1... > /srv/offsite/krug-backup-20260101T021500Z.tar.gz.age
age -d -i /etc/krug/backup-age.key \
  /srv/offsite/krug-backup-20260101T021500Z.tar.gz.age \
  | tar -C /srv/restore -xzf -

# or GPG
tar -C /srv/backups/krug -czf - krug-backup-20260101T021500Z \
  | gpg --encrypt --recipient ops@example.com \
  > /srv/offsite/krug-backup-20260101T021500Z.tar.gz.gpg
```

Verify the off-host copy by downloading it and running
`sha256sum -c SHA256SUMS` after extraction. Do not rely on the backup host's
copy alone.

## Restore

> Restore is destructive and has no automatic undo. Take a fresh
> `backup.sh --tag pre-restore` first if the current data is still readable.

```bash
./deploy/scripts/restore.sh \
  --backup /srv/backups/krug/krug-backup-20260101T021500Z
# type RESTORE at the prompt
```

What it does:

1. verifies every file against `SHA256SUMS` (aborts on mismatch);
2. reads the manifest and respects backups made with `--skip-keycloak` /
   `--skip-minio`;
3. stops `caddy`, `frontend`, `backend` and `keycloak` (the DBs and MinIO stay
   up);
4. runs `pg_restore --clean --if-exists --no-owner --single-transaction` on
   `krug` and `keycloak`;
5. mirrors the bucket back with `mc mirror --overwrite` (extra objects in the
   bucket are kept unless `--exact-minio` is passed);
6. starts the stack with `docker compose up -d` and waits up to five minutes
   for `GET /api/v1/health` inside the backend container.

`--yes` skips the typed confirmation and is intended only for an approved
automation path; it does not make the operation reversible.

### Disaster recovery on a new host

1. Install Docker and clone the repository at the same commit (or a compatible
   release).
2. Restore `.env.prod` from the secret manager, including `KRUG_CONTENT_KEY`.
3. Create the empty volumes and start only the databases and object store:
   ```bash
   docker compose --env-file .env.prod -f docker-compose.prod.yml \
     up -d postgres keycloak-postgres db-bootstrap minio createbuckets
   ```
4. Run `restore.sh --backup ...` (it starts the rest of the stack).
5. Point DNS at the new host and let Caddy issue new certificates.
6. Verify login, message history, managed-file download and the admin panel's
   SMTP test.

If the old host is still running, stop its public tier first to avoid split
brain and writes after the backup timestamp.

## Verification and drills

Minimum before go-live and quarterly afterwards:

```bash
# 1. The dump is readable and contains the expected schemas.
LATEST="$(ls -dt /srv/backups/krug/krug-backup-* | head -n 1)"
docker compose --env-file deploy/production/.env.prod \
  -f deploy/production/docker-compose.prod.yml \
  exec -T postgres pg_restore --list < "$LATEST/app.dump" | head

# 2. Checksums.
(cd "$LATEST" && sha256sum -c SHA256SUMS)

# 3. Full restore into a disposable stack (separate host or project name),
#    then smoke-test login and a managed-file download.
```

A backup that has never been restored is an assumption, not a recovery plan.
Record the drill date, restore duration (RTO), and the age of the newest
recoverable backup (RPO) in the operations log.
