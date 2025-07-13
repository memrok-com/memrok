# memrok Deployment

Modular Docker Compose setup for [memrok](https://www.memrok.com/) with [Traefik](https://traefik.io/traefik) and [Authelia](https://www.authelia.com/).

## Quick Start

### Development Deployment (HTTP)

1. **Setup environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your domains, secrets, and network name
   ```

2. **Create network**:
   ```bash
   docker network create ${DOCKER_NETWORK}
   ```

3. **Deploy services**:
   ```bash
   docker compose -f traefik/docker-compose.yml up -d
   docker compose -f authelia/docker-compose.yml up -d
   docker compose -f memrok/docker-compose.yml up -d
   ```

### Production Deployment (HTTPS with Let's Encrypt)

1. **Setup environment**:
   ```bash
   cp .env.example .env
   # Edit .env with:
   # - Your real domains (MEMROK_APP_DOMAIN, MEMROK_AUTH_DOMAIN)
   # - Email for Let's Encrypt
   # - DNS provider and API credentials
   ```

2. **Create network**:
   ```bash
   docker network create ${DOCKER_NETWORK}
   ```

3. **Deploy services with production overrides**:
   ```bash
   docker compose \
     -f traefik/docker-compose.yml \
     -f traefik/docker-compose.prod.yml \
     -f authelia/docker-compose.yml \
     -f authelia/docker-compose.prod.yml \
     -f memrok/docker-compose.yml \
     up -d
   ```

The production deployment adds:
- Automatic HTTPS with Let's Encrypt certificates
- HTTP to HTTPS redirect
- DNS challenge for certificate generation

## Configuration

- Edit `authelia/users_database.yml` to add users
- Update `.env` for domain and network settings
- All Traefik and Authelia settings are configured via environment variables

## Services

- **Traefik**: Reverse proxy with automatic HTTPS
- **Authelia**: Authentication and authorization
- **memrok**: AI memory service

Each service is independent and can be mixed with your existing infrastructure.