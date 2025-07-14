#!/bin/bash

# Generate SSL certificates for development using mkcert
# Requires mkcert to be installed: https://mkcert.dev
set -e

echo "🔒 Generating SSL certificates for development..."

# Check if mkcert is installed
if ! command -v mkcert &> /dev/null; then
    echo "❌ mkcert is not installed. Please install it first:"
    echo "   Visit: https://mkcert.dev"
    echo ""
    exit 1
fi

# Create certs directory if it doesn't exist
mkdir -p traefik/certs

# Install the local CA if not already done
echo "📋 Installing local CA..."
mkcert -install

# Generate certificates for our domains
echo "🔐 Generating certificates for memrok domains..."
cd traefik/certs

# Generate wildcard certificate for dev.memrok.com
mkcert "*.dev.memrok.com" localhost 127.0.0.1 ::1

# Rename files to standard names
mv _wildcard.dev.memrok.com+3.pem dev.memrok.com.crt
mv _wildcard.dev.memrok.com+3-key.pem dev.memrok.com.key

echo "✅ SSL certificates generated successfully!"
echo "   Certificate: traefik/certs/dev.memrok.com.crt"
echo "   Private key: traefik/certs/dev.memrok.com.key"
echo ""
echo "🚀 You can now start the development environment with:"
echo "   bun run dev:infra"