import { CfnOutput, Duration, RemovalPolicy, Size, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import * as dlm from 'aws-cdk-lib/aws-dlm';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';
import { buildUserData } from './user-data.js';

export interface EnshroudedStackProps extends StackProps {
  /** Default m6i.xlarge (4 vCPU / 16 GiB). */
  instanceType?: string;
  serverName?: string;
  slotCount?: number;
  /** CIDRs allowed to reach the game ports. Default: the whole internet (the server is password protected). */
  allowedCidrs?: string[];
  /** Community Wine image. Pin a digest/tag once chosen. */
  image?: string;
  worldVolumeGiB?: number;
  /** Existing public hosted zone; an A record `<recordName>.<zoneName>` points at the Elastic IP. */
  dns?: { hostedZoneId: string; zoneName: string; recordName: string };
}

export class EnshroudedStack extends Stack {
  constructor(scope: Construct, id: string, props: EnshroudedStackProps = {}) {
    super(scope, id, props);

    const serverName = props.serverName ?? 'Enshrouded';
    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { isDefault: true });

    const password = new secrets.Secret(this, 'Password', {
      description: 'Enshrouded server password (JSON: {"password": ...})',
      generateSecretString: {
        secretStringTemplate: '{}',
        generateStringKey: 'password',
        passwordLength: 16,
        excludePunctuation: true,
      },
    });

    const sg = new ec2.SecurityGroup(this, 'Sg', {
      vpc,
      description: 'Enshrouded game + query ports (UDP)',
      allowAllOutbound: true,
    });
    for (const cidr of props.allowedCidrs ?? ['0.0.0.0/0']) {
      sg.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.udpRange(15636, 15637), 'Enshrouded');
    }

    const role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      // Session Manager instead of SSH: no port 22.
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    password.grantRead(role);

    const instance = new ec2.Instance(this, 'Server', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: new ec2.InstanceType(props.instanceType ?? 'm6i.xlarge'),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: sg,
      role,
      requireImdsv2: true,
      blockDevices: [{ deviceName: '/dev/xvda', volume: ec2.BlockDeviceVolume.ebs(16, { volumeType: ec2.EbsDeviceVolumeType.GP3 }) }],
      userDataCausesReplacement: false,
    });
    instance.addUserData(
      ...buildUserData({
        region: this.region,
        secretArn: password.secretArn,
        serverName,
        slotCount: props.slotCount ?? 5,
        image: props.image ?? 'mornedhels/enshrouded-server:latest',
      }),
    );

    // World saves live on their own volume so replacing the instance never touches them.
    const world = new ec2.Volume(this, 'World', {
      availabilityZone: instance.instanceAvailabilityZone,
      size: Size.gibibytes(props.worldVolumeGiB ?? 30),
      volumeType: ec2.EbsDeviceVolumeType.GP3,
      encrypted: true,
      removalPolicy: RemovalPolicy.SNAPSHOT,
    });
    Tags.of(world).add('Backup', 'enshrouded');
    new ec2.CfnVolumeAttachment(this, 'WorldAttachment', {
      device: '/dev/sdf',
      instanceId: instance.instanceId,
      volumeId: world.volumeId,
    });

    const dlmRole = new iam.Role(this, 'DlmRole', {
      assumedBy: new iam.ServicePrincipal('dlm.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSDataLifecycleManagerServiceRole')],
    });
    new dlm.CfnLifecyclePolicy(this, 'DailySnapshots', {
      description: 'Daily Enshrouded world snapshots with 7 day retention',
      state: 'ENABLED',
      executionRoleArn: dlmRole.roleArn,
      policyDetails: {
        resourceTypes: ['VOLUME'],
        targetTags: [{ key: 'Backup', value: 'enshrouded' }],
        schedules: [
          {
            name: 'daily',
            createRule: { interval: 24, intervalUnit: 'HOURS', times: ['08:00'] },
            retainRule: { count: 7 },
            copyTags: true,
          },
        ],
      },
    });

    // Stable address across stop/start.
    const eip = new ec2.CfnEIP(this, 'Ip', { instanceId: instance.instanceId });

    if (props.dns) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        hostedZoneId: props.dns.hostedZoneId,
        zoneName: props.dns.zoneName,
      });
      new route53.ARecord(this, 'Dns', {
        zone,
        recordName: props.dns.recordName,
        target: route53.RecordTarget.fromIpAddresses(eip.attrPublicIp),
        ttl: Duration.minutes(1),
      });
      new CfnOutput(this, 'ServerHostname', { value: `${props.dns.recordName}.${props.dns.zoneName}` });
    }

    new CfnOutput(this, 'ServerAddress', { value: `${eip.attrPublicIp}:15637` });
    new CfnOutput(this, 'InstanceId', { value: instance.instanceId });
    new CfnOutput(this, 'PasswordSecretArn', { value: password.secretArn });
  }
}
