![memrok logo](https://raw.githubusercontent.com/memrok-com/app/refs/heads/main/app/assets/logo/2025-memrok-logo.svg)

# Deploy memrok

Self-host memrok on your own infrastructure to keep your AI assistant memories private and secure.

## Prerequisites

- Server with Docker and Docker Compose installed
- Domain name pointing to your server
- Ports 80 and 443 open for web traffic

## Installation

1. **Download the deployment configuration**

   ```bash
   git clone https://github.com/memrok-com/memrok.git
   cd memrok
   ```

2. **Configure your environment**

   ```bash
   cp .env.example .env
   ```

   Then, edit the `.env` file with your settings.

3. **Start memrok**
   ```bash
   docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
   ```

Visit your configured domain to access memrok!

## What Gets Deployed

- **memrok**: Main application (from GitHub Container Registry)
- **Zitadel**: Authentication service
- **PostgreSQL**: Database for memories and user data
- **Traefik**: Reverse proxy with automatic SSL certificates

All services run in Docker containers and communicate over a private network.

### Docker Images

memrok uses official pre-built images from GitHub Container Registry:

- **Latest stable**: `ghcr.io/memrok-com/app:latest`
- **Specific version**: `ghcr.io/memrok-com/app:v1.0.0`
- **Multi-platform**: Supports both `linux/amd64` and `linux/arm64`

Images are automatically built, signed, and scanned for vulnerabilities on each release.

## Management

### Update to latest version

```bash
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### Stop memrok

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml down
```

## Backup

Backup your database regularly:

```bash
# Create backup
docker compose exec postgres pg_dump -U postgres memrok > memrok-backup-$(date +%Y%m%d).sql

# Restore backup
docker compose exec -T postgres psql -U postgres memrok < memrok-backup.sql
```

## Security

### Verifying Docker Images

All memrok images are signed with cosign. To verify:

```bash
# Install cosign
brew install cosign  # or see https://docs.sigstore.dev/cosign/installation/

# Verify image signature
cosign verify ghcr.io/memrok-com/app:latest \
  --certificate-identity-regexp "https://github.com/memrok-com/app/.github/workflows/docker-build.yml" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

### Environment Variables

Never commit `.env` files. Required variables:

- `MEMROK_APP_DOMAIN`: Your application domain
- `MEMROK_AUTH_DOMAIN`: Your authentication domain
- `DATABASE_URL`: Auto-configured by Docker Compose
- Various secrets: Generated during setup

See `.env.example` for complete documentation.
