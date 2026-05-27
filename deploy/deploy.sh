#!/bin/bash
# AlphaSignal — deploy / update script
# Run from your LOCAL machine: bash deploy/deploy.sh
set -e

SERVER=$1
if [ -z "$SERVER" ]; then
  echo "Usage: bash deploy/deploy.sh ubuntu@<your-server-ip>"
  exit 1
fi

echo "==> Syncing files to $SERVER..."
rsync -avz --exclude 'node_modules' --exclude 'dist' --exclude 'data' --exclude '.env' --exclude '*.db' \
  ./ $SERVER:/var/www/alphasignal/

echo "==> Installing dependencies and building..."
ssh $SERVER "cd /var/www/alphasignal && npm ci && npm run build"

echo "==> Restarting app with PM2..."
ssh $SERVER "cd /var/www/alphasignal && pm2 startOrRestart ecosystem.config.js --env production"
ssh $SERVER "pm2 save"

echo "==> Done! App is live."
