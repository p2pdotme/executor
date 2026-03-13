#!/bin/bash
# Build and push Docker image to Docker Hub.
# Usage: ./build_and_push.sh
# Override: IMAGE_NAME=youruser/p2pme-executor TAG=v1.0.0 ./build_and_push.sh

set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-youruser/p2pme-executor}"
TAG="${TAG:-v0.1.0}"

echo "📦 Creating build..."
npm run build

echo "🚀 Building Docker image for Akash..."
docker build --platform linux/amd64 -t $IMAGE_NAME:$TAG .

echo "✅ Build complete!"

echo "📤 Pushing image to Docker Hub..."
docker push $IMAGE_NAME:$TAG

echo "✅ Push complete!"
echo "🎯 Image ready: $IMAGE_NAME:$TAG"
