#!/bin/bash
# AlphaSignal — Oracle Cloud VM one-time setup
# Run as: bash setup.sh
set -e

echo "==> Updating system..."
sudo apt-get update -y && sudo apt-get upgrade -y

echo "==> Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "==> Installing build tools (needed for better-sqlite3)..."
sudo apt-get install -y python3 make g++ git nginx certbot python3-certbot-nginx

echo "==> Installing PM2..."
sudo npm install -g pm2

echo "==> Creating app directory..."
sudo mkdir -p /var/www/alphasignal
sudo chown -R $USER:$USER /var/www/alphasignal

echo "==> Creating data directory for SQLite..."
sudo mkdir -p /data/alphasignal
sudo chown -R $USER:$USER /data/alphasignal

echo "==> Setup complete. Now run: bash deploy.sh"
