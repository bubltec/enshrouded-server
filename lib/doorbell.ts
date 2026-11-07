export interface DoorbellOptions {
  region: string;
  targetInstanceId: string;
  /** Max wake-ups per rolling 24h; stops port scanners from running the big instance all day. */
  maxWakesPerDay: number;
  /** Minimum seconds between wake-ups (the server needs a few minutes to boot). */
  cooldownSeconds: number;
}

/**
 * User data for the tiny always-on instance that holds the Elastic IP while the game server
 * is stopped. It listens on the game's UDP ports and starts the game server when anything
 * arrives. Needs no package installs: Amazon Linux 2023 ships python3 and the AWS CLI.
 */
export function buildDoorbellUserData(o: DoorbellOptions): string[] {
  return [
    '#!/bin/bash',
    'set -euxo pipefail',
    'mkdir -p /var/lib/doorbell',
    "cat > /opt/doorbell.py <<'PY'",
    'import json, os, selectors, socket, subprocess, time',
    "TARGET = os.environ['TARGET_INSTANCE']",
    "REGION = os.environ['AWS_REGION']",
    "MAX_WAKES = int(os.environ['MAX_WAKES'])",
    "COOLDOWN = int(os.environ['COOLDOWN'])",
    "STATE = '/var/lib/doorbell/wakes.json'",
    'def load():',
    '    try:',
    '        return [t for t in json.load(open(STATE)) if t > time.time() - 86400]',
    '    except Exception:',
    '        return []',
    'def wake():',
    '    wakes = load()',
    '    if (wakes and time.time() - wakes[-1] < COOLDOWN) or len(wakes) >= MAX_WAKES:',
    '        return',
    "    r = subprocess.run(['aws', 'ec2', 'start-instances', '--instance-ids', TARGET, '--region', REGION],",
    '                       capture_output=True, timeout=60)',
    '    if r.returncode == 0:',
    '        wakes.append(time.time())',
    "        json.dump(wakes, open(STATE, 'w'))",
    '    print("wake", r.returncode, flush=True)',
    'sel = selectors.DefaultSelector()',
    'for port in (15636, 15637):',
    '    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)',
    "    s.bind(('0.0.0.0', port))",
    '    sel.register(s, selectors.EVENT_READ)',
    'while True:',
    '    for key, _ in sel.select():',
    '        key.fileobj.recvfrom(2048)',
    '        try:',
    '            wake()',
    '        except Exception as e:',
    '            print("wake failed", type(e).__name__, flush=True)',
    'PY',
    'cat > /etc/systemd/system/doorbell.service <<EOF',
    '[Unit]',
    'Description=Wake the Enshrouded server on connection attempts',
    'After=network-online.target',
    '[Service]',
    `Environment=TARGET_INSTANCE=${o.targetInstanceId} AWS_REGION=${o.region} MAX_WAKES=${o.maxWakesPerDay} COOLDOWN=${o.cooldownSeconds}`,
    'ExecStart=/usr/bin/python3 /opt/doorbell.py',
    'Restart=always',
    '[Install]',
    'WantedBy=multi-user.target',
    'EOF',
    'systemctl daemon-reload',
    'systemctl enable --now doorbell',
  ];
}
