import { DescribeInstancesCommand, EC2Client, StartInstancesCommand, StopInstancesCommand } from '@aws-sdk/client-ec2';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createApp } from './app.js';

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
};

const ec2 = new EC2Client({});
const sm = new SecretsManagerClient({});
const instanceIds = [env('INSTANCE_ID')];

const secret = async (id: string): Promise<string> => {
  const r = await sm.send(new GetSecretValueCommand({ SecretId: id }));
  if (!r.SecretString) throw new Error('empty secret');
  return r.SecretString;
};

let cached: Promise<{ sessionSecret: string; githubClientSecret: string }> | undefined;

export const handler = createApp({
  config: {
    domain: env('DOMAIN'),
    serverHost: env('SERVER_HOST'),
    githubClientId: env('GITHUB_CLIENT_ID'),
    adminEmails: env('ADMIN_EMAILS')
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  },
  secrets: () => {
    cached ??= Promise.all([secret(env('SESSION_SECRET_ARN')), secret(env('GITHUB_SECRET_ARN'))]).then(
      ([sessionSecret, githubClientSecret]) => ({ sessionSecret, githubClientSecret }),
    );
    // A failed fetch must not stick for the life of the container.
    cached.catch(() => (cached = undefined));
    return cached;
  },
  instance: {
    async describe() {
      const r = await ec2.send(new DescribeInstancesCommand({ InstanceIds: instanceIds }));
      return { state: r.Reservations?.[0]?.Instances?.[0]?.State?.Name ?? 'unknown' };
    },
    async start() {
      await ec2.send(new StartInstancesCommand({ InstanceIds: instanceIds }));
    },
    async stop() {
      await ec2.send(new StopInstancesCommand({ InstanceIds: instanceIds }));
    },
  },
  serverPassword: async () => (JSON.parse(await secret(env('PASSWORD_SECRET_ARN'))) as { password: string }).password,
  fetch,
  now: () => Date.now(),
});
