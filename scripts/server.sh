#!/usr/bin/env bash
# Usage: scripts/server.sh start|stop|status|password
set -euo pipefail
STACK=${STACK:-Enshrouded}
out() { aws cloudformation describe-stacks --stack-name "$STACK" --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }
ID=$(out InstanceId)
case "${1:-status}" in
  start)  aws ec2 start-instances --instance-ids "$ID" --query 'StartingInstances[0].CurrentState.Name' --output text ;;
  stop)   aws ec2 stop-instances --instance-ids "$ID" --query 'StoppingInstances[0].CurrentState.Name' --output text ;;
  status) aws ec2 describe-instances --instance-ids "$ID" --query 'Reservations[0].Instances[0].State.Name' --output text; echo "address: $(out ServerAddress)" ;;
  password) aws secretsmanager get-secret-value --secret-id "$(out PasswordSecretArn)" --query SecretString --output text | jq -r .password ;;
  *) echo "usage: $0 start|stop|status|password" >&2; exit 1 ;;
esac
