# memrok Deployment

Modular Docker Compose setup for memrok with Traefik and Authelia.

## Quick Start

1. **Setup environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your domains, secrets, and network name
   ```

2. **Create network**:
   ```bash
   # Use the network name from your .env file
   docker network create ${NETWORK_NAME}
   ```

3. **Deploy services**:
   ```bash
   docker-compose -f traefik/docker-compose.yml up -d
   docker-compose -f authelia/docker-compose.yml up -d
   docker-compose -f memrok/docker-compose.yml up -d
   ```

## Configuration

- Edit `authelia/config/users_database.yml` to add users
- Modify `traefik/config/traefik.yml` for custom Traefik settings
- Update `.env` for domain and network settings

## Services

- **Traefik**: Reverse proxy with automatic HTTPS
- **Authelia**: Authentication and authorization
- **memrok**: AI memory service

Each service is independent and can be mixed with your existing infrastructure.