# enshrouded-server

CDK app that runs an [Enshrouded](https://enshrouded.com) dedicated server (5 players) on EC2, wakes it when someone connects, stops it when it is idle, and has a small admin site. Same conventions as [mycota](https://github.com/bubltec/mycota): TypeScript CDK, pnpm, exact-pinned dependencies, Node 26. Everything is in us-east-1.

## What it creates

Stack `Enshrouded` (the game):

- **Game server:** `m6i.xlarge` (4 vCPU / 16 GiB), Amazon Linux 2023, default VPC, no SSH (use SSM Session Manager). It runs the community Wine-based image `mornedhels/enshrouded-server`, with UDP 15636-15637 open.
- **World saves:** a separate encrypted 30 GiB volume (snapshot on stack delete) plus daily snapshots kept for 7 days.
- **Password:** generated, in Secrets Manager.
- **Wake on connect:** one Elastic IP, and `enshrouded.bubbletech.io` points at it.
  - A tiny always-on `t4g.nano` "doorbell" holds that IP while the server is stopped. It listens on the game ports and starts the server when any packet arrives (at most 6 times per 24 h, 10 min apart, so port scanners cannot keep it running).
  - A Lambda moves the IP to the server when it reaches `running`, and back to the doorbell when it stops.
- **Auto-stop:** a CloudWatch alarm stops the server after about 30 minutes of near-idle network traffic.

Stack `EnshroudedAdmin` (the admin site, `https://enshrouded-admin.bubbletech.io`):

- Lambda (Function URL) behind CloudFront, the shared `bubbletech-shared` WAF (ARN read from SSM `/bubbletech/waf/web-acl-arn`), ACM certificate and Route 53 records.
- Sign in with GitHub. Access needs a **verified primary GitHub email** that is on the allow-list (`adminEmails` in `bin/app.ts`, currently john.josef@gmail.com). The allow-list is re-checked on every request.
- Shows state and address, starts and stops the server, reveals the password. Starting and stopping need a signed session cookie plus a CSRF header.
- AWS WAF cannot sit in front of the game itself (it only handles HTTP), so the game relies on the security group, the server password and Shield Standard. Restrict by IP with `-c allowedCidrs=1.2.3.4/32,...`.

## First deploy

1. Register a GitHub OAuth app (GitHub -> Settings -> Developer settings -> OAuth Apps):
   - Homepage: `https://enshrouded-admin.bubbletech.io`
   - Callback: `https://enshrouded-admin.bubbletech.io/api/auth/github/callback`
2. Deploy with its client id:

   ```bash
   pnpm install
   pnpm exec cdk diff --all
   pnpm exec cdk deploy --all -c githubClientId=<client id>
   ```

3. Store the client secret (the stack creates a placeholder):

   ```bash
   aws secretsmanager put-secret-value --secret-id <GithubSecretArn output> --secret-string '<client secret>'
   ```

CLI alternative to the site: `scripts/server.sh start|stop|status|password`.

## Using it

Players join `enshrouded.bubbletech.io` (Direct connect, the server password). If the server is stopped, **the first attempt fails**: the doorbell starts the server, which takes a few minutes to boot. Retry after that, or press Start on the admin site first.

## Cost

Always on, the game server is about $140/month. With auto-stop, you pay for hours actually running, plus a fixed few dollars a month for the doorbell, volumes, snapshots and the Elastic IP.

## Not verified yet

None of this has run on real infrastructure.

- The game server's boot script and the image's environment variables (`SERVER_NAME`, `SERVER_PASSWORD`, `SERVER_SLOT_COUNT`, save path). Check with `docker logs enshrouded` via Session Manager and pin the image tag.
- The doorbell and IP handover (watch the first stop/start cycle) and the idle threshold (5 MB per 5 minutes; tune after a real session).
- The IP is attached to the server at first deploy and owned by the Lambda afterwards. Changing the `IpAssociation` resource in a later deploy can move it back until the next state change.
