# memrok Service

This directory will contain the Docker Compose configuration for the memrok service once containerization is implemented.

For now, during development, run memrok locally with:

```bash
# From the main repo directory
bun run dev
```

Traefik will proxy requests to `localhost:3000` when properly configured.