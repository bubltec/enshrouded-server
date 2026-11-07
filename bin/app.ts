import { App } from 'aws-cdk-lib';
import { EnshroudedStack } from '../lib/enshrouded-stack.js';

const app = new App();

// fromLookup needs a concrete account/region. Defaults to the CLI's current account.
new EnshroudedStack(app, 'Enshrouded', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  allowedCidrs: app.node.tryGetContext('allowedCidrs')?.split(','),
  slotCount: 5,
});
