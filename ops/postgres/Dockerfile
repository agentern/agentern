FROM postgres:18-alpine
RUN apk add --no-cache pgbackrest
COPY postgresql.conf /etc/postgresql/postgresql.conf
COPY pgbackrest.conf /etc/pgbackrest/pgbackrest.conf
COPY archive-push.sh /usr/local/bin/agentern-archive-push
COPY entrypoint.sh /usr/local/bin/agentern-postgres-entrypoint
RUN chmod 755 /usr/local/bin/agentern-archive-push /usr/local/bin/agentern-postgres-entrypoint && mkdir -p /var/spool/pgbackrest /var/log/pgbackrest && chown -R postgres:postgres /var/spool/pgbackrest /var/log/pgbackrest /etc/pgbackrest
ENTRYPOINT ["agentern-postgres-entrypoint"]
