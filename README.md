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

- **memrok**: Main application
- **Zitadel**: Authentication service  
- **PostgreSQL**: Database for memories and user data
- **Traefik**: Reverse proxy with automatic SSL certificates

All services run in Docker containers and communicate over a private network.

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