#!/bin/bash

# Extract OIDC client configuration from Zitadel after automated setup
# This script reads the generated machine key and uses it to retrieve client credentials

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOYMENT_DIR="$(dirname "$SCRIPT_DIR")"

echo "🔧 Extracting Zitadel OIDC client configuration..."

# Check if machine key exists
if [ ! -f "$DEPLOYMENT_DIR/../.env" ]; then
    echo "❌ .env file not found. Please run 'bun run setup' first."
    exit 1
fi

# Source environment variables
source "$DEPLOYMENT_DIR/../.env"

# Wait for Zitadel to be ready
echo "⏳ Waiting for Zitadel to be ready..."
max_attempts=30
attempt=0
while [ $attempt -lt $max_attempts ]; do
    if curl -s -k "https://${MEMROK_AUTH_DOMAIN}/debug/ready" > /dev/null 2>&1; then
        echo "✅ Zitadel is ready!"
        break
    fi
    attempt=$((attempt + 1))
    echo "   Attempt $attempt/$max_attempts..."
    sleep 5
done

if [ $attempt -eq $max_attempts ]; then
    echo "❌ Timeout waiting for Zitadel to be ready"
    exit 1
fi

# Check if volumes exist and extract client ID/secret
echo "📋 Extracting client configuration..."

# Get client ID from machine key file
CLIENT_ID=$(docker compose exec -T zitadel cat /machinekey/zitadel-admin-sa.json 2>/dev/null | jq -r '.clientId // empty' || echo "")

if [ -z "$CLIENT_ID" ]; then
    echo "❌ Could not extract client ID from machine key"
    echo "   The automated setup may not have completed successfully."
    echo "   Try restarting the Zitadel container to re-run initialization."
    exit 1
fi

echo "✅ Client ID: $CLIENT_ID"
echo ""
echo "📝 Add this to your .env file:"
echo "ZITADEL_CLIENT_ID=$CLIENT_ID"
echo ""
echo "🔑 For the client secret, since we're using PKCE (public client),"
echo "   no client secret is needed for the OIDC flow."
echo ""
echo "🎉 Zitadel is now fully configured with:"
echo "   - Admin user: admin@${MEMROK_AUTH_DOMAIN}"
echo "   - Password: \$ZITADEL_ADMIN_PASSWORD (from .env)"
echo "   - OIDC Client: memrok-app"
echo "   - Access console: https://${MEMROK_AUTH_DOMAIN}/ui/console"