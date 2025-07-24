#!/bin/bash
set -e

# memrok database and user are created automatically by PostgreSQL via POSTGRES_USER/POSTGRES_DB
# This script creates the postgres superuser (for Zitadel admin operations) and zitadel database

# Create postgres superuser with admin password
psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER}" --dbname="${POSTGRES_DB}" <<-EOSQL
    -- Create postgres superuser for Zitadel admin operations
    DO \$\$
    BEGIN
        IF NOT EXISTS (SELECT FROM pg_user WHERE usename = 'postgres') THEN
            CREATE USER postgres WITH SUPERUSER PASSWORD '${POSTGRES_ADMIN_PASSWORD}';
        END IF;
    END
    \$\$;

    -- Create zitadel database for authentication service
    SELECT 'CREATE DATABASE zitadel'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'zitadel')\gexec

    -- Create zitadel user if it doesn't exist
    DO \$\$
    BEGIN
        IF NOT EXISTS (SELECT FROM pg_user WHERE usename = '${ZITADEL_DB_USER}') THEN
            CREATE USER ${ZITADEL_DB_USER} WITH PASSWORD '${ZITADEL_DB_PASSWORD}';
        END IF;
    END
    \$\$;

    -- Grant privileges on zitadel database
    GRANT ALL PRIVILEGES ON DATABASE zitadel TO ${ZITADEL_DB_USER};
EOSQL

echo "Additional databases initialized (postgres superuser, zitadel)"