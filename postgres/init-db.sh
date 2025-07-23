#!/bin/bash
set -e

# Create memrok database and user if they don't exist
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    -- Create memrok database if it doesn't exist
    SELECT 'CREATE DATABASE memrok'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'memrok')\gexec

    -- Create memrok user if it doesn't exist
    DO \$\$
    BEGIN
        IF NOT EXISTS (SELECT FROM pg_user WHERE usename = '${MEMROK_DB_USER}') THEN
            CREATE USER ${MEMROK_DB_USER} WITH PASSWORD '${MEMROK_DB_PASSWORD}';
        END IF;
    END
    \$\$;

    -- Grant privileges
    GRANT ALL PRIVILEGES ON DATABASE memrok TO ${MEMROK_DB_USER};
EOSQL

echo "memrok database initialized"