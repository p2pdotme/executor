#!/bin/bash
# Substitutes ${VAR} placeholders in deploy.yml with values from .env
# Run from the repo root: bash deploy/akash/generate_deploy.sh

set -e

# Resolve paths relative to repo root (where .env lives)
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
INPUT_YAML="$REPO_ROOT/deploy/akash/deploy.yml"
OUTPUT_YAML="$REPO_ROOT/deploy/akash/deploy.final.yml"

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ .env file not found at $ENV_FILE"
  exit 1
fi

cp "$INPUT_YAML" "$OUTPUT_YAML"

while IFS='=' read -r key value; do
  if [[ -n "$key" && ! "$key" =~ ^# ]]; then
    # Escape slashes and ampersands for sed safety
    safe_value=$(printf '%s\n' "$value" | sed -e 's/[\/&]/\\&/g')
    sed -i.bak "s|\${$key}|$safe_value|g" "$OUTPUT_YAML"
  fi
done < "$ENV_FILE"

# Remove backup after replacements
rm -f "$OUTPUT_YAML.bak"

echo "✅ Generated $OUTPUT_YAML with real environment values."
