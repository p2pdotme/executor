#!/bin/bash

# Docker Installation Script for Ubuntu/Debian
# Based on official Docker installation instructions

set -e

echo "=============================================="
echo "Installing Docker Engine"
echo "=============================================="
echo ""

# Check if running on Ubuntu/Debian
if [ ! -f /etc/debian_version ]; then
    echo "Error: This script is designed for Ubuntu/Debian systems."
    echo "Please refer to Docker documentation for other distributions."
    exit 1
fi

# Update package index
echo "Step 1: Updating package index..."
sudo apt-get update

# Install prerequisites
echo ""
echo "Step 2: Installing prerequisites..."
sudo apt-get install -y ca-certificates curl gnupg lsb-release

# Add Docker's official GPG key
echo ""
echo "Step 3: Adding Docker's official GPG key..."
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg

# Set up repository
echo ""
echo "Step 4: Setting up Docker repository..."
sudo mkdir -p /etc/apt/sources.list.d
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker Engine
echo ""
echo "Step 5: Installing Docker Engine..."
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Start Docker service
echo ""
echo "Step 6: Starting Docker service..."
sudo systemctl start docker
sudo systemctl enable docker

# Add user to docker group
echo ""
echo "Step 7: Adding user to docker group..."
sudo usermod -aG docker $USER

echo ""
echo "=============================================="
echo "Docker installation completed!"
echo "=============================================="
echo ""
echo "Note: You may need to log out and log back in"
echo "      (or run 'newgrp docker') for group changes to take effect."
echo ""
echo "Verifying installation..."
echo ""

# Verify installation
docker --version
docker compose version

echo ""
echo "=============================================="
echo "Installation verified successfully!"
echo "=============================================="
