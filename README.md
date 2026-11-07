# enshrouded-server

CDK app that runs an [Enshrouded](https://enshrouded.com) dedicated server (up to 5 players) on a single EC2 instance. Same conventions as [mycota](https://github.com/bubltec/mycota): TypeScript CDK, pnpm, exact-pinned dependencies, Node 26.

## What it creates

- `m6i.xlarge` (4 vCPU / 16 GiB) running Amazon Linux 2023 in the default VPC, no SSH (use SSM Session Manager).
- The community Wine-based image `mornedhels/enshrouded-server` (the server itself is Windows-only), UDP 15636-15637 open.
- A separate encrypted 30 GiB gp3 volume for world saves (snapshot on stack delete), plus daily snapshots kept for 7 days.
- An Elastic IP, and a generated server password in Secrets Manager.

## Use

```bash
pnpm install
pnpm synth                      # no changes made
pnpm deploy                     # creates billable resources
scripts/server.sh password      # share with players
scripts/server.sh stop|start|status
```

Restrict access: `pnpm deploy -c allowedCidrs=1.2.3.4/32,5.6.7.8/32`.

Players connect with the address from the `ServerAddress` stack output (Enshrouded -> Join -> Direct connect).

## Cost

Roughly $140/month running 24/7. Stopped, you pay only for the volume, snapshots and Elastic IP (a few dollars).

## Not verified yet

The user-data script and the image's environment variables (`SERVER_NAME`, `SERVER_PASSWORD`, `SERVER_SLOT_COUNT`, save path) have not been tested on a real instance. Check the first boot with `docker logs enshrouded` through Session Manager and pin the image tag.
