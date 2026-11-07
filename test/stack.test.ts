import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, it } from 'vitest';
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

  it('runs the game server plus a doorbell, both IMDSv2-only', () => {
    const t = template();
    t.resourceCountIs('AWS::EC2::Instance', 2);
    t.resourceCountIs('AWS::EC2::LaunchTemplate', 2);
    t.allResourcesProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: Match.objectLike({ MetadataOptions: Match.objectLike({ HttpTokens: 'required' }) }),
    });
  });

  it('moves the Elastic IP when the server starts or stops', () => {
    const t = template();
    t.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({ detail: Match.objectLike({ state: ['running', 'stopped'] }) }),
    });
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([Match.objectLike({ Action: 'ec2:AssociateAddress', Effect: 'Allow' })]),
      }),
    });
  });

  it('stops the server after sustained idle network traffic', () => {
    template().hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'NetworkIn',
      ComparisonOperator: 'LessThanThreshold',
      EvaluationPeriods: 6,
      TreatMissingData: 'notBreaching',
      AlarmActions: [Match.objectLike({ 'Fn::Join': Match.anyValue() })],
    });
  });
});
