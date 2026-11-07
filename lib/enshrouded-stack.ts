import { CfnOutput, Duration, RemovalPolicy, Size, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import * as dlm from 'aws-cdk-lib/aws-dlm';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import { fileURLToPath } from 'node:url';
import type { Construct } from 'constructs';
import { buildDoorbellUserData } from './doorbell.js';
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
  readonly instanceId: string;
  readonly instanceArn: string;
  readonly passwordSecret: secrets.ISecret;

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

    // Wake on connect. One Elastic IP follows whichever instance should answer: the game
    // server while it runs, a tiny always-on "doorbell" while it is stopped. The doorbell
    // starts the server when a packet arrives; the Lambda moves the IP on state changes.
    // The IP starts on the server (deployed running); the Lambda owns it after that, so a
    // later change to the association resource could move it back until the next event.
    const eip = new ec2.CfnEIP(this, 'Ip', { domain: 'vpc' });
    new ec2.CfnEIPAssociation(this, 'IpAssociation', { allocationId: eip.attrAllocationId, instanceId: instance.instanceId });

    const instanceArn = this.formatArn({ service: 'ec2', resource: 'instance', resourceName: instance.instanceId });

    const doorbellRole = new iam.Role(this, 'DoorbellRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    doorbellRole.addToPolicy(new iam.PolicyStatement({ actions: ['ec2:StartInstances'], resources: [instanceArn] }));
    const doorbell = new ec2.Instance(this, 'Doorbell', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      // No public IP of its own: it only needs one while it holds the Elastic IP.
      associatePublicIpAddress: false,
      instanceType: new ec2.InstanceType('t4g.nano'),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64 }),
      securityGroup: sg,
      role: doorbellRole,
      requireImdsv2: true,
    });
    doorbell.addUserData(
      ...buildDoorbellUserData({
        region: this.region,
        targetInstanceId: instance.instanceId,
        maxWakesPerDay: 6,
        cooldownSeconds: 600,
      }),
    );

    const moveIp = new NodejsFunction(this, 'MoveIp', {
      entry: fileURLToPath(new URL('./wake/eip-handler.ts', import.meta.url)),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: Duration.seconds(30),
      environment: {
        ALLOCATION_ID: eip.attrAllocationId,
        SERVER_INSTANCE_ID: instance.instanceId,
        DOORBELL_INSTANCE_ID: doorbell.instanceId,
      },
      bundling: { externalModules: ['@aws-sdk/*'], minify: true, target: 'node24' },
    });
    moveIp.addToRolePolicy(new iam.PolicyStatement({ actions: ['ec2:AssociateAddress'], resources: ['*'] }));
    new events.Rule(this, 'ServerStateChange', {
      eventPattern: {
        source: ['aws.ec2'],
        detailType: ['EC2 Instance State-change Notification'],
        detail: { 'instance-id': [instance.instanceId], state: ['running', 'stopped'] },
      },
      targets: [new eventTargets.LambdaFunction(moveIp)],
    });

    // Auto-stop: about 30 minutes of near-idle network traffic stops the server.
    // Boot-time downloads count as traffic, so the clock effectively starts after startup.
    // Missing data (instance stopped) is treated as fine. Tune the threshold after a real session.
    const idle = new cloudwatch.Alarm(this, 'Idle', {
      alarmDescription: 'Game server network traffic stayed near idle; stop it',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/EC2',
        metricName: 'NetworkIn',
        dimensionsMap: { InstanceId: instance.instanceId },
        statistic: 'Sum',
        period: Duration.minutes(5),
      }),
      threshold: 5_000_000,
      evaluationPeriods: 6,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    idle.addAlarmAction(new cwActions.Ec2Action(cwActions.Ec2InstanceAction.STOP));

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

    this.instanceId = instance.instanceId;
    this.instanceArn = instanceArn;
    this.passwordSecret = password;

    new CfnOutput(this, 'ServerAddress', { value: `${eip.attrPublicIp}:15637` });
    new CfnOutput(this, 'InstanceId', { value: instance.instanceId });
    new CfnOutput(this, 'PasswordSecretArn', { value: password.secretArn });
  }
}
