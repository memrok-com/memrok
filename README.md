# memrok Deployment Configuration

This directory contains the Docker Compose configuration for deploying memrok with Zitadel authentication in both development and production environments.

## Quick Start

1. **Copy environment file:**
   ```bash
   cp .env.example .env
   ```

2. **Generate required secrets:**
   ```bash
   # Generate 32+ character strings for these variables in .env:
   ZITADEL_MASTERKEY=your-32-char-master-key-here
   ZITADEL_DB_PASSWORD=your-db-password-here  
   ZITADEL_DB_ADMIN_PASSWORD=your-admin-password-here
   ```

3. **Set domain configuration:**
   ```bash
   # For development (in .env):
   MEMROK_AUTH_DOMAIN=auth.dev.memrok.com
   MEMROK_APP_DOMAIN=app.dev.memrok.com
   
   # For production (in .env):
   MEMROK_AUTH_DOMAIN=auth.yourdomain.com
   MEMROK_APP_DOMAIN=app.yourdomain.com
   ```

4. **Start the infrastructure:**
   ```bash
   # From project root
   bun run setup      # First time setup (certs + infrastructure)
   # OR
   bun run infra:start   # Just start infrastructure
   ```

5. **Extract OIDC configuration** (after first startup):
   ```bash
   bun run auth:config
   ```

## Automated Configuration

The deployment includes **fully automated Zitadel setup** with:

- ✅ **Admin user**: `admin@{MEMROK_AUTH_DOMAIN}` 
- ✅ **Password**: Set via `ZITADEL_ADMIN_PASSWORD` env var
- ✅ **OIDC Client**: Pre-configured for memrok app
- ✅ **Development domains**: Includes localhost:3000 for dev
- ✅ **Service account**: For API automation
- ✅ **Project & roles**: Ready for user management

### Login Credentials

- **Admin Console**: https://{MEMROK_AUTH_DOMAIN}/ui/console
- **Username**: `admin@{MEMROK_AUTH_DOMAIN}`
- **Password**: Value from `ZITADEL_ADMIN_PASSWORD` in .env

## Architecture

### Development Setup
- **Traefik**: Reverse proxy with mkcert certificates
- **Zitadel**: Authentication service with automated config
- **PostgreSQL**: Database for Zitadel
- **Domains**: `*.dev.memrok.com` (resolves to 127.0.0.1)

### Production Setup  
- **Traefik**: Reverse proxy with Let's Encrypt
- **Zitadel**: Same automated config as dev
- **PostgreSQL**: Persistent database
- **Domains**: Your custom domain configuration

## Files

- `docker-compose.yml` - Base configuration for all environments
- `docker-compose.dev.yml` - Development overrides (mkcert, dev domains)
- `docker-compose.prod.yml` - Production overrides (app container)
- `zitadel/init-steps.yaml` - Automated Zitadel configuration
- `scripts/` - Utility scripts for certificates and config extraction

## Environment Variables

### Required
```bash
ZITADEL_MASTERKEY=          # 32+ characters
ZITADEL_DB_PASSWORD=        # Database password  
ZITADEL_DB_ADMIN_PASSWORD=  # Database admin password
ZITADEL_ADMIN_PASSWORD=     # Zitadel admin user password
MEMROK_AUTH_DOMAIN=         # auth.yourdomain.com
MEMROK_APP_DOMAIN=          # app.yourdomain.com
```

### Optional (for email notifications)
```bash
ZITADEL_SMTP_HOST=          # smtp.example.com:587
ZITADEL_SMTP_USER=          # SMTP username
ZITADEL_SMTP_PASSWORD=      # SMTP password
ZITADEL_SMTP_FROM=          # From email address
```

## Management Commands

```bash
# Infrastructure control
bun run infra:start     # Start all containers
bun run infra:stop      # Stop all containers  
bun run infra:restart   # Restart containers
bun run infra:logs      # View logs
bun run infra:status    # Check status

# Configuration
bun run auth:config     # Extract OIDC client config
bun run certs          # Generate development certificates
```

## Troubleshooting

### First Time Setup Issues
1. **"No such file or directory"**: Run `bun run certs` first
2. **"Connection refused"**: Check Docker is running
3. **"Environment variable not set"**: Copy and configure `.env`

### Authentication Issues  
1. **Can't login**: Check `ZITADEL_ADMIN_PASSWORD` in .env
2. **Client not found**: Run `bun run auth:config` to extract client ID
3. **Domain issues**: Verify `MEMROK_AUTH_DOMAIN` matches your setup

### Reset Zitadel Configuration
```bash
# Stop containers and remove volumes to start fresh
bun run infra:stop
docker volume rm deployment_zitadel-db-data deployment_zitadel-machinekey deployment_zitadel-pat
bun run infra:start
```

## Security Notes

- The automated setup uses **PKCE** (no client secrets needed)
- **Development** includes `localhost:3000` for local Nuxt dev server
- **Production** should use proper TLS certificates via Let's Encrypt
- All secrets are stored in environment variables, not in code