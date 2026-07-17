FROM postgres:18-alpine
RUN apk add --no-cache pgbackrest su-exec
COPY postgresql.conf /etc/postgresql/postgresql.conf
COPY pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
COPY entrypoint.sh /usr/local/bin/agentern-postgres-entrypoint
RUN chmod 755 /usr/local/bin/agentern-postgres-entrypoint && mkdir -p /var/spool/pgbackrest /var/log/pgbackrest && chown -R postgres:postgres /var/spool/pgbackrest /var/log/pgbackrest /etc/pgbackrest
ENTRYPOINT ["agentern-postgres-entrypoint"]
