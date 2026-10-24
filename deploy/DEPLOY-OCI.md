# Running the ERP for many schools on one Oracle Cloud VM

Everything runs in Docker on one machine: Postgres (+ PgBouncer), Redis, the backend, the web app,
the report service (Jasper) and Caddy (HTTPS for every school's address). Nightly backups go off
the machine.

```
 internet ──► Caddy :443 ──► /api/*  → backend :8000 ──► PgBouncer ──► Postgres
                         └─► others  → frontend :3000      └─► Redis, Jasper :8090
```

## 1. The machine

1. Oracle Cloud → Compute → Create instance: **Ubuntu 24.04, Ampere A1 (ARM), 4 OCPU / 24 GB** (fits the
   free tier), 100 GB boot volume.
2. Networking → the subnet's security list: allow **TCP 80 and 443** from 0.0.0.0/0 (keep 22 for SSH).
3. On the VM, open the same ports in its firewall and install Docker:
   ```sh
   sudo iptables -I INPUT 6 -p tcp --dport 80 -j ACCEPT && sudo iptables -I INPUT 6 -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER   # log out and in again
   ```

## 2. Addresses (DNS)

At the domain's DNS provider (for `PLATFORM_DOMAIN`, e.g. `klytos.in`):

| Name | Type | Value |
|---|---|---|
| `klytos.in` | A | the VM's public IP |
| `*.klytos.in` | A | the VM's public IP |

- Every school then works at `<school code>.klytos.in` straight away (HTTPS is issued on its first visit).
- `console.klytos.in/platform` is the platform console; `app.klytos.in` asks for the school code.
- A school's **own domain** (e.g. `erp.greenvalley.in`): the school adds a CNAME to `greenvalley.klytos.in`
  (or an A record to the VM's IP), and you enter the domain on the school's page in the console.

## 3. The code and settings

```sh
mkdir -p ~/erp && cd ~/erp
git clone <cmsbackend repo> cmsbackend && git clone <cmsfrontend repo> cmsfrontend
cd cmsbackend/deploy
cp .env.example .env && nano .env          # fill in every value (see the comments)
touch rclone.conf                          # off-machine backups: see section 6
```

Keys: `openssl rand -hex 24` for passwords and tokens, `openssl rand -hex 32` for `MFA_ENCRYPTION_KEY`, and
for `JWT_PRIVATE_KEY`: `openssl genrsa 2048 | awk 'NF {printf "%s\\n", $0}'` (one line).

## 4. Start

```sh
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f backend     # wait for "cms-backend running"
```

The backend applies the database changes itself when it starts.

**The first console owner** (prints a one-time password once):
```sh
docker compose -f docker-compose.prod.yml exec backend node dist/scripts/platform-owner.js --email you@klytos.in --name "Your Name"
```
Open `https://console.klytos.in/platform`, sign in, choose a password and scan the authenticator QR.
Then **Plans** (optional) and **Schools → Add a school**.

## 5. Moving today's data from Supabase

Once, before going live (school users can't work during the copy):
```sh
# On any machine with Postgres 16 tools; use Supabase's direct connection string (port 5432).
pg_dump "<supabase direct url>" -Fc -f erp.dump --no-owner --no-privileges
docker compose -f docker-compose.prod.yml cp erp.dump postgres:/tmp/erp.dump
docker compose -f docker-compose.prod.yml exec postgres pg_restore -U erp -d erp --no-owner --clean --if-exists /tmp/erp.dump
docker compose -f docker-compose.prod.yml restart backend
```

## 6. Backups

- Every night at 01:30 the `backup` container dumps the whole database to the `backups` volume:
  the last **7 nightly** and **12 monthly** copies are kept there.
- **Off the machine** (strongly advised): Oracle Object Storage → create a bucket `erp-backups`, and a
  lifecycle rule deleting objects older than 400 days. Profile → *Customer secret keys* → generate one.
  Put this in `deploy/rclone.conf`, then set `BACKUP_REMOTE=oci:erp-backups` in `.env` and restart `backup`:
  ```ini
  [oci]
  type = s3
  provider = Other
  access_key_id = <the key's access key>
  secret_access_key = <its secret>
  endpoint = https://<namespace>.compat.objectstorage.<region>.oraclecloud.com
  region = <region>
  ```
- Run one now to check: `docker compose -f docker-compose.prod.yml exec backup sh /backup.sh`
- **Uploaded files** (photos, documents) are in the `files` volume (unless Cloudinary is used): back
  them up too, e.g. a weekly `rclone sync` of the volume's folder to the same bucket.

### Restoring

- **Everything** (a bad day): stop the backend, restore the chosen dump, start again.
  ```sh
  docker compose -f docker-compose.prod.yml stop backend
  docker compose -f docker-compose.prod.yml exec postgres pg_restore -U erp -d erp --clean --if-exists /backups/daily/erp-YYYY-MM-DD.dump
  docker compose -f docker-compose.prod.yml start backend
  ```
- **One school** (the others keep working): restore the dump into a temporary database
  (`createdb -U erp erp_restore` then `pg_restore -d erp_restore …`), take that school's rows from it
  (every table has `tenant_id`), and put them back. Ask before doing this on a live system: it needs care.
- **Try a restore once a month** into `erp_restore`, to know the backups work.

## 7. Updating

1. Console → **Notices** → a banner, e.g. "Update tonight 10:00–10:15 pm".
2. On the VM:
   ```sh
   cd ~/erp/cmsbackend && git pull && cd ../cmsfrontend && git pull && cd ../cmsbackend/deploy
   docker compose -f docker-compose.prod.yml up -d --build
   ```
3. Console → **Notices** → "What's new" for the schools; switch the banner off.

## 8. Before a second school goes live

```sh
# With the backend running; creates a test school with demo data the first time.
docker compose -f docker-compose.prod.yml exec backend node dist/scripts/isolation-check.js --a <a school code> --b iso-b --api http://localhost:8000/api --create-b
```
It must end with "no school B data in any answer to school A". Delete the test school afterwards
(console → suspend → delete).
