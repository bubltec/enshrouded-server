import { App } from 'aws-cdk-lib';
import { AdminStack } from '../lib/admin-stack.js';
import { EnshroudedStack } from '../lib/enshrouded-stack.js';

const app = new App();

// fromLookup needs a concrete account/region. Both stacks live in us-east-1: CloudFront's
// certificate and the CLOUDFRONT-scope shared WAF must be there.
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
};
const zone = { hostedZoneId: 'Z08503632G57OD1I2BJ7V', zoneName: 'bubbletech.io' };

const server = new EnshroudedStack(app, 'Enshrouded', {
  env,
  allowedCidrs: app.node.tryGetContext('allowedCidrs')?.split(','),
  slotCount: 5,
  dns: { hostedZoneId: zone.hostedZoneId, zoneName: zone.zoneName, recordName: 'enshrouded' },
});

new AdminStack(app, 'EnshroudedAdmin', {
  env,
  instanceId: server.instanceId,
  instanceArn: server.instanceArn,
  passwordSecret: server.passwordSecret,
  zone,
  domainName: 'enshrouded-admin.bubbletech.io',
  serverHost: 'enshrouded.bubbletech.io',
  // Register the OAuth app first (README), then pass its client id: -c githubClientId=...
  githubClientId: app.node.tryGetContext('githubClientId') ?? '',
  adminEmails: ['john.josef@gmail.com'],
});
