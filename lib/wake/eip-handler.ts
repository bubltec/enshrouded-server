import { AssociateAddressCommand, EC2Client } from '@aws-sdk/client-ec2';
import type { EventBridgeEvent } from 'aws-lambda';

const ec2 = new EC2Client({});

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
};

/**
 * Keeps one Elastic IP on whichever instance should answer: the game server while it is
 * running, the doorbell while it is stopped. The public address never changes.
 */
export const handler = async (event: EventBridgeEvent<'EC2 Instance State-change Notification', { state: string }>) => {
  const state = event.detail.state;
  if (state !== 'running' && state !== 'stopped') return;
  const InstanceId = state === 'running' ? env('SERVER_INSTANCE_ID') : env('DOORBELL_INSTANCE_ID');
  await ec2.send(new AssociateAddressCommand({ AllocationId: env('ALLOCATION_ID'), InstanceId, AllowReassociation: true }));
  console.log(JSON.stringify({ state, movedTo: InstanceId }));
};
