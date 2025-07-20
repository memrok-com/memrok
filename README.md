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

3. **Set domain and admin configuration:**
   ```bash
   # For development (in .env):
   MEMROK_AUTH_DOMAIN=auth.dev.memrok.com
   MEMROK_APP_DOMAIN=app.dev.memrok.com
   ZITADEL_ADMIN_EMAIL=admin@yourdomain.com
   ZITADEL_ADMIN_PASSWORD=your-secure-password
   
   # For production (in .env):
   MEMROK_AUTH_DOMAIN=auth.yourdomain.com
   MEMROK_APP_DOMAIN=app.yourdomain.com
   ZITADEL_ADMIN_EMAIL=admin@yourdomain.com
   ZITADEL_ADMIN_PASSWORD=your-secure-password
   ```

4. **Run the automated setup:**
   ```bash
   # From project root - this will:
   # 1. Generate SSL certificates (dev only)
   # 2. Start infrastructure (Traefik + Zitadel)
   # 3. Automatically provision Zitadel project and application
   bun run setup
   ```
   
   The setup will output your OIDC configuration automatically.

## Automated Configuration

The deployment includes **fully automated Zitadel setup** with:

- ✅ **Admin user**: Created with email from `ZITADEL_ADMIN_EMAIL`
- ✅ **Password**: Set via `ZITADEL_ADMIN_PASSWORD` env var
- ✅ **Service account**: `memrok-provisioner` for automation
- ✅ **Project**: "memrok" project automatically created
- ✅ **OIDC Application**: User Agent (SPA) app with PKCE flow
- ✅ **User authorization**: Admin user granted access to project
- ✅ **Development domains**: Configured for `*.dev.memrok.com`

The `bun run auth` command handles all provisioning automatically and outputs the OIDC configuration needed for your `.env` file.

### Login Credentials

- **Admin Console**: https://{MEMROK_AUTH_DOMAIN}/ui/console
- **Username**: Value from `ZITADEL_ADMIN_EMAIL` in .env
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
ZITADEL_ADMIN_EMAIL=        # Admin user email
ZITADEL_ADMIN_PASSWORD=     # Admin user password
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
# Full setup (recommended for first time)
bun run setup           # Certs + infrastructure + auth provisioning

# Infrastructure control
bun run infra:start     # Start all containers
bun run infra:stop      # Stop all containers  
bun run infra:restart   # Restart containers
bun run infra:logs      # View logs
bun run infra:status    # Check status

# Authentication & configuration
bun run auth            # Provision Zitadel project and application
bun run certs           # Generate development certificates
```

## Troubleshooting

### First Time Setup Issues
1. **"No such file or directory"**: Run `bun run certs` first
2. **"Connection refused"**: Check Docker is running
3. **"Environment variable not set"**: Copy and configure `.env`

### Authentication Issues  
1. **Can't login**: Check `ZITADEL_ADMIN_EMAIL` and `ZITADEL_ADMIN_PASSWORD` in .env
2. **Client not found**: Run `bun run auth` to provision the application
3. **Domain issues**: Verify `MEMROK_AUTH_DOMAIN` matches your setup
4. **Provisioning fails**: Wait a moment and retry - Zitadel may still be starting

### Reset Zitadel Configuration
```bash
# Stop containers and remove volumes to start fresh
bun run infra:stop
docker volume rm memrok_zitadel-db-data memrok_zitadel-machinekey memrok_zitadel-pat
bun run infra:start
bun run auth  # Re-provision after restart
```

## Security Notes

- The automated setup creates a **User Agent (SPA)** application using **PKCE** flow
- No client secrets are used - authentication uses PKCE for enhanced security
- Service account credentials are automatically generated and stored in Docker volumes
- **Development** uses trusted mkcert certificates
- **Production** should use proper TLS certificates via Let's Encrypt
- All secrets are stored in environment variables, not in code