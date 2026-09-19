# Deployment (Hetzner host)

The worker runs on the shared Hetzner host (`screener`, Ubuntu 24.04) as its
own Docker Compose project at `/opt/automod`, next to the other projects,
without touching them.

## Layout

```
/opt/automod/                       root:root 0755
├── app/                            code at a pushed commit (git archive), build context
├── compose.yaml                    copy of deploy/compose.yaml
├── state/                          10470:10470 0700   encrypted WhatsApp session
└── secrets/                        root:root 0700
    ├── db_password                 70:70 0400         read by the Postgres container
    └── worker/                     10470:10470 0700
        ├── main.key                10470:10470 0600   32-byte session key
        ├── db.url                  10470:10470 0600   socket URL with password
        └── gcp.json                10470:10470 0600   service account automod-worker@flippascraper-508600
/opt/automod/compose.override.yaml  root 0600          server-only: groups, operator number, GCP project
/opt/automod/archive/               10470 0700         sessions moved aside after failed pairing
```

The Google service account has only `roles/aiplatform.user`. Its key was piped
from `gcloud` straight to the server (never written on a laptop). Revoke with
`gcloud iam service-accounts keys list/delete --iam-account automod-worker@flippascraper-508600.iam.gserviceaccount.com`.

## Decisions (Rafter secure-design)

- **Isolation on a shared host:** the worker runs as uid/gid 10470, which no
  host account has (host uid 1000 is `cyberpanel`), with a read-only root
  filesystem, all capabilities dropped, `no-new-privileges`, a 768 MB memory
  cap, and a tmpfs `/tmp`. Other projects' users and containers cannot read
  automod's state or secrets.
- **Network:** nothing is published. Postgres sits on an `internal` network
  with no route out, and the worker reaches it only through the Unix socket
  volume. The worker's own network is for outbound WhatsApp (and later Vertex
  AI) traffic only.
- **Database auth:** scram-sha-256 for local and host connections (set at
  initdb), with a random 32-byte password generated on the host and stored in
  owner-only files only.
- **Secrets:** generated on the server and never copied through this laptop or
  chat. Files, not environment variables (the connection URL would otherwise
  appear in `docker inspect`). The session key lives outside the state folder.
- **Supply chain:** images `node:24-bookworm-slim` and `postgres:17-alpine`
  (official), dependencies from the committed lockfile with install scripts
  disabled.
- **Logs:** status and counters only (the app's rule), rotated by Docker.
- **Pairing:** the first run is interactive over `ssh -t`, so the pairing code
  goes straight to the operator's terminal.

## Operate

```sh
# Deploy a new version (from a clean checkout of the pushed branch)
git archive HEAD | ssh screener 'rm -rf /opt/automod/app.new && mkdir /opt/automod/app.new &&
  tar -x -C /opt/automod/app.new && rm -rf /opt/automod/app && mv /opt/automod/app.new /opt/automod/app'
ssh screener 'cd /opt/automod && docker compose build worker && docker compose up -d'

# Status (counters only)
ssh screener 'cd /opt/automod && docker compose ps && docker compose logs --tail=20 worker'

# First pairing (interactive; QR is the method that worked)
ssh -t screener 'cd /opt/automod && docker compose stop worker && docker compose run --rm worker \
  --state-dir=/data/state --session=main --key-file=/run/automod/main.key \
  --database-url-file=/run/automod/db.url --group=0@g.us --pair-with-qr'

# List the number's groups (stops the service briefly: one process per session)
ssh screener 'cd /opt/automod && docker compose stop worker && docker compose run --rm -T worker \
  --state-dir=/data/state --session=main --key-file=/run/automod/main.key \
  --database-url-file=/run/automod/db.url --group=0@g.us --list-groups; docker compose up -d worker'
```

## Not yet done

- Backups: nightly `pg_dump` kept 30 days or less, stored off the host.
- Pairing by 8-character code failed on this account (WhatsApp never sent
  pair-success); QR pairing worked. Linked since 2026-09-19 13:33 UTC.
- The host allows SSH password and root login. The root password must be
  rotated (it was pasted into a chat on 2026-09-19), and password login should
  be disabled by the host's owner.
