#!/bin/bash
# Build and push Docker image for Akash deployment

set -euo pipefail

IMAGE_NAME="keccak002/p2pme-executor"
TAG="v0.0.3"

echo "📦 Creating build..."
npm run build

echo "🚀 Building Docker image for Akash..."
docker build --platform linux/amd64 -t $IMAGE_NAME:$TAG .

echo "✅ Build complete!"

echo "📤 Pushing image to Docker Hub..."
docker push $IMAGE_NAME:$TAG

echo "✅ Push complete!"
echo "🎯 Image ready: $IMAGE_NAME:$TAG"
