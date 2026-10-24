#!/bin/sh
# Nightly database backup (run by the "backup" container at 01:30).
#  - A compressed dump of the whole database (every school) in /backups.
#  - Kept here: the last 7 nightly ones, plus the one of the 1st of each month for 12 months.
#  - Copied off the machine to Oracle Object Storage (or any rclone remote) when BACKUP_REMOTE is set,
#    e.g. BACKUP_REMOTE=oci:erp-backups (configure deploy/rclone.conf; see DEPLOY-OCI.md).
# Restore: see "Restoring" in DEPLOY-OCI.md.
set -e
day=$(date +%F)
dir=/backups
mkdir -p "$dir/daily" "$dir/monthly"
file="$dir/daily/erp-$day.dump"

pg_dump -h postgres -U erp -d erp -Fc -Z 6 -f "$file.part"
mv "$file.part" "$file"
echo "$(date '+%F %T') backup $file ($(du -h "$file" | cut -f1))"

# The 1st of the month is also kept as a monthly copy.
if [ "$(date +%d)" = "01" ]; then cp "$file" "$dir/monthly/erp-$day.dump"; fi

# Keep 7 nightly and 12 monthly copies.
ls -1t "$dir/daily"/*.dump 2>/dev/null | tail -n +8 | xargs -r rm -f
ls -1t "$dir/monthly"/*.dump 2>/dev/null | tail -n +13 | xargs -r rm -f

# Off the machine (the same rules apply there: old copies are removed by the bucket's lifecycle rule).
if [ -n "$RCLONE_REMOTE" ]; then
	rclone copy "$file" "$RCLONE_REMOTE/daily/" && echo "$(date '+%F %T') copied to $RCLONE_REMOTE"
	if [ "$(date +%d)" = "01" ]; then rclone copy "$file" "$RCLONE_REMOTE/monthly/"; fi
fi
