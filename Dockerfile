FROM node:26-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Node 26 no longer bundles Corepack. Install the lockfile's pnpm version
# explicitly so dependency installs remain reproducible across base images.
RUN npm install --global pnpm@10.33.4
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/eslint-config/package.json packages/eslint-config/package.json
COPY packages/typescript-config/package.json packages/typescript-config/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS builder
COPY . .
ARG DEPLOYMENT_VERSION=development
ENV DEPLOYMENT_VERSION=$DEPLOYMENT_VERSION
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM deps AS migrator
COPY . .
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
CMD ["pnpm", "db:migrate"]

FROM node:26-alpine AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
RUN apk add --no-cache su-exec
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
# The standalone Next.js runner never invokes npm. Removing the bundled npm
# toolchain keeps its transitive CLI dependencies out of the production image.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public
COPY ops/web-entrypoint.sh /usr/local/bin/agentern-web-entrypoint
RUN chmod 755 /usr/local/bin/agentern-web-entrypoint
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"
ENTRYPOINT ["/usr/local/bin/agentern-web-entrypoint"]
CMD ["node", "apps/web/server.js"]
