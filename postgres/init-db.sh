#!/bin/bash
set -e

# memrok is the default database created by POSTGRES_DB
# This script creates additional databases and users

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
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

echo "Additional databases initialized (zitadel)"