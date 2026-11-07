export interface UserDataOptions {
  region: string;
  secretArn: string;
  serverName: string;
  slotCount: number;
  image: string;
}

/**
 * Boot script: mounts the persistent world volume, then runs the community
 * Wine-based dedicated server image (Enshrouded's server is Windows-only).
 * Idempotent: it runs on every boot, so a stop/start brings the server back.
 */
export function buildUserData(o: UserDataOptions): string[] {
  return [
    '#!/bin/bash',
    'set -euxo pipefail',
    'dnf install -y docker jq',
    'systemctl enable --now docker',

    '# Find the (only) non-root NVMe disk: the world volume.',
    'ROOT=$(lsblk -no PKNAME "$(findmnt -n -o SOURCE /)")',
    'DATA=""',
    'for i in $(seq 1 60); do',
    '  DATA=$(lsblk -dpno NAME,TYPE | awk \'$2=="disk"{print $1}\' | grep -v "/dev/$ROOT" | head -1 || true)',
    '  [ -n "$DATA" ] && break; sleep 5',
    'done',
    'blkid "$DATA" || mkfs.xfs "$DATA"',
    'mkdir -p /srv/enshrouded',
    'grep -q /srv/enshrouded /etc/fstab || echo "UUID=$(blkid -s UUID -o value "$DATA") /srv/enshrouded xfs defaults,nofail 0 2" >> /etc/fstab',
    'mount -a',
    'chown -R 10000:10000 /srv/enshrouded',

    `PASSWORD=$(aws secretsmanager get-secret-value --region ${o.region} --secret-id ${o.secretArn} --query SecretString --output text | jq -r .password)`,
    'docker rm -f enshrouded || true',
    'docker run -d --name enshrouded --restart unless-stopped \\',
    '  -p 15636:15636/udp -p 15637:15637/udp \\',
    '  -v /srv/enshrouded:/home/enshrouded/server/savegame -e PUID=10000 -e PGID=10000 \\',
    `  -e SERVER_NAME='${o.serverName}' -e SERVER_SLOT_COUNT=${o.slotCount} -e SERVER_PASSWORD="$PASSWORD" \\`,
    `  ${o.image}`,
  ];
}
