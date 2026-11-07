import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { EnshroudedStack } from '../lib/enshrouded-stack.js';

const template = () => {
  const stack = new EnshroudedStack(new App(), 'T', { env: { account: '111111111111', region: 'us-east-1' } });
  return Template.fromStack(stack);
};

describe('EnshroudedStack', () => {
  it('opens only the game UDP ports', () => {
    template().hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: [Match.objectLike({ IpProtocol: 'udp', FromPort: 15636, ToPort: 15637 })],
    });
  });

  it('keeps world saves on an encrypted volume that snapshots on delete', () => {
    const t = template();
    t.hasResource('AWS::EC2::Volume', { Properties: { Encrypted: true }, DeletionPolicy: 'Snapshot' });
    t.resourceCountIs('AWS::DLM::LifecyclePolicy', 1);
  });

  it('points an A record at the Elastic IP when dns is given', () => {
    const stack = new EnshroudedStack(new App(), 'D', {
      env: { account: '111111111111', region: 'us-east-1' },
      dns: { hostedZoneId: 'Z123', zoneName: 'example.com', recordName: 'enshrouded' },
    });
    Template.fromStack(stack).hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'enshrouded.example.com.',
      Type: 'A',
    });
  });

  it('runs one IMDSv2-only instance', () => {
    const t = template();
    t.resourceCountIs('AWS::EC2::Instance', 1);
    expect(JSON.stringify(t.toJSON())).toContain('"HttpTokens":"required"');
  });
});
