import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, it } from 'vitest';
import { AdminStack } from '../lib/admin-stack.js';
import { EnshroudedStack } from '../lib/enshrouded-stack.js';

const env = { account: '111111111111', region: 'us-east-1' };

function build() {
  const app = new App();
  const server = new EnshroudedStack(app, 'S', { env });
  const stack = new AdminStack(app, 'A', {
    env,
    instanceId: server.instanceId,
    instanceArn: server.instanceArn,
    passwordSecret: server.passwordSecret,
    zone: { hostedZoneId: 'Z123', zoneName: 'example.com' },
    domainName: 'admin.example.com',
    serverHost: 'game.example.com',
    githubClientId: 'cid',
    adminEmails: ['a@example.com'],
  });
  return Template.fromStack(stack);
}

describe('AdminStack', () => {
  it('serves the app on its hostname through CloudFront with the shared WAF', () => {
    const t = build();
    t.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ Aliases: ['admin.example.com'], WebACLId: Match.anyValue() }),
    });
    t.resourceCountIs('AWS::Route53::RecordSet', 2);
  });

  it('can only start and stop the one game instance', () => {
    build().hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: ['ec2:StartInstances', 'ec2:StopInstances'], Resource: Match.anyValue() }),
        ]),
      }),
    });
  });
});
