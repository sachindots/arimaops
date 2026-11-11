#!/usr/bin/env bash
# Creates the ArimaOps EC2 server: Ubuntu 24.04, t3.large, 40 GB, SSH open to your current IP only.
#   AWS_REGION=ap-south-1 bash deploy/ec2/launch.sh
set -euo pipefail
cd "$(dirname "$0")"
REGION="${AWS_REGION:-$(aws configure get region)}"; : "${REGION:?set AWS_REGION}"
TYPE="${INSTANCE_TYPE:-t3.large}"
NAME=arimaops
KEY="$HOME/.ssh/$NAME.pem"
aws() { command aws --region "$REGION" "$@"; }

AMI=$(aws ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id --query Parameter.Value --output text)
if [ ! -f "$KEY" ]; then
  aws ec2 create-key-pair --key-name "$NAME" --key-type ed25519 --query KeyMaterial --output text > "$KEY"
  chmod 600 "$KEY"
fi
VPC=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=$NAME Name=vpc-id,Values=$VPC --query 'SecurityGroups[0].GroupId' --output text)
if [ "$SG" = "None" ]; then
  SG=$(aws ec2 create-security-group --group-name $NAME --description "ArimaOps: SSH from the owner only; HQ via Tailscale" --vpc-id "$VPC" --query GroupId --output text)
fi
MYIP=$(curl -fsS https://checkip.amazonaws.com)
aws ec2 authorize-security-group-ingress --group-id "$SG" --protocol tcp --port 22 --cidr "$MYIP/32" 2>/dev/null || true

ID=$(aws ec2 run-instances --image-id "$AMI" --instance-type "$TYPE" --key-name "$NAME" --security-group-ids "$SG" \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=40,VolumeType=gp3,Encrypted=true}' \
  --metadata-options HttpTokens=required \
  --user-data file://user-data.sh \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" --query 'Instances[0].InstanceId' --output text)
echo "instance $ID: waiting until it runs…"
aws ec2 wait instance-running --instance-ids "$ID"
IP=$(aws ec2 describe-instances --instance-ids "$ID" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
echo "$ID $IP" > "$HOME/.arima-ec2"
echo "ready: ssh -i $KEY ubuntu@$IP   (first-boot install takes ~5 minutes)"
