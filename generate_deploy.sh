#!/bin/bash
# Simple helper: replace ${VAR} in deploy.yml with actual values from .env

set -e
ENV_FILE=".env"
INPUT_YAML="deploy.yml"
OUTPUT_YAML="deploy.final.yml"

if [ ! -f "$ENV_FILE" ]; then
  echo "❌ .env file not found!"
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
