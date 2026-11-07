import { CfnOutput, Duration, SecretValue, Stack, type StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';

/** Published by the dotio repo's DotioWaf stack: one web ACL shared by every bubbletech site. */
export const WAF_ARN_PARAMETER = '/bubbletech/waf/web-acl-arn';

export interface AdminStackProps extends StackProps {
  instanceId: string;
  instanceArn: string;
  passwordSecret: secrets.ISecret;
  /** Existing public hosted zone, e.g. bubbletech.io. */
  zone: { hostedZoneId: string; zoneName: string };
  /** Admin site host, e.g. enshrouded-admin.bubbletech.io. */
  domainName: string;
  /** Game hostname shown in the UI. */
  serverHost: string;
  /** GitHub OAuth app client id (not secret). Empty until the OAuth app is registered. */
  githubClientId: string;
  /** Verified primary GitHub emails allowed in. */
  adminEmails: string[];
  /** Attach the shared WAF (CLOUDFRONT scope, so this stack must be in us-east-1). Default true. */
  useSharedWaf?: boolean;
}

export class AdminStack extends Stack {
  constructor(scope: Construct, id: string, props: AdminStackProps) {
    super(scope, id, props);

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', props.zone);

    const sessionSecret = new secrets.Secret(this, 'SessionSecret', {
      description: 'Signs admin session cookies',
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });
    // Placeholder: put the real value with `aws secretsmanager put-secret-value` (see README).
    const githubSecret = new secrets.Secret(this, 'GithubClientSecret', {
      description: 'GitHub OAuth app client secret for the Enshrouded admin app',
      secretStringValue: SecretValue.unsafePlainText('REPLACE_ME_AFTER_DEPLOY'),
    });

    const fn = new NodejsFunction(this, 'Api', {
      entry: fileURLToPath(new URL('../admin/src/handler.ts', import.meta.url)),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(15),
      environment: {
        INSTANCE_ID: props.instanceId,
        DOMAIN: props.domainName,
        SERVER_HOST: props.serverHost,
        GITHUB_CLIENT_ID: props.githubClientId,
        ADMIN_EMAILS: props.adminEmails.join(','),
        SESSION_SECRET_ARN: sessionSecret.secretArn,
        GITHUB_SECRET_ARN: githubSecret.secretArn,
        PASSWORD_SECRET_ARN: props.passwordSecret.secretArn,
      },
      bundling: { externalModules: ['@aws-sdk/*'], minify: true, target: 'node24' },
    });
    sessionSecret.grantRead(fn);
    githubSecret.grantRead(fn);
    props.passwordSecret.grantRead(fn);
    fn.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['ec2:StartInstances', 'ec2:StopInstances'], resources: [props.instanceArn] }),
    );
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['ec2:DescribeInstances'], resources: ['*'] }));

    // The app does its own auth (GitHub sign-in, signed cookie, allow-list), so the URL is
    // public; CloudFront in front is for the hostname, TLS and the shared WAF.
    const fnUrl = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    const certificate = new acm.Certificate(this, 'Cert', {
      domainName: props.domainName,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      domainNames: [props.domainName],
      certificate,
      webAclId:
        props.useSharedWaf === false ? undefined : ssm.StringParameter.valueForStringParameter(this, WAF_ARN_PARAMETER),
      defaultBehavior: {
        origin: new origins.FunctionUrlOrigin(fnUrl),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        // Function URLs route on their own hostname, so don't forward the viewer's Host.
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      },
    });

    for (const [recordId, Record] of [
      ['A', route53.ARecord],
      ['AAAA', route53.AaaaRecord],
    ] as const) {
      new Record(this, `Alias${recordId}`, {
        zone,
        recordName: props.domainName,
        target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
      });
    }

    new CfnOutput(this, 'Url', { value: `https://${props.domainName}` });
    new CfnOutput(this, 'GithubCallbackUrl', { value: `https://${props.domainName}/api/auth/github/callback` });
    new CfnOutput(this, 'GithubSecretArn', { value: githubSecret.secretArn });
  }
}
