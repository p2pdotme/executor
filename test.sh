#!/usr/bin/env bash
set -euo pipefail

echo "Building TypeScript..."
# create build
npm run build

echo "Building Docker image executor:local..."
# build docker image
docker build -t executor:local .

echo "Starting with docker compose (foreground)..."
echo "Press Ctrl+C to stop"

# Run in foreground (no -d)
docker compose up --build
