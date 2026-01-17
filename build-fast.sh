#!/bin/bash

# Fast Docker build script using BuildKit and cache mounts
# This script enables Docker BuildKit for faster builds with layer caching

set -e

echo "Building Forgejo with optimized Dockerfile..."
echo "This uses BuildKit cache mounts to speed up subsequent builds."
echo ""

# Enable BuildKit
export DOCKER_BUILDKIT=1

# Build with the optimized Dockerfile
sudo DOCKER_BUILDKIT=1 docker build \
  -f Dockerfile.fast \
  -t forgejo \
  --progress=plain \
  .

echo ""
echo "✓ Build complete!"
echo "Run with: docker run -p 3000:3000 forgejo"
