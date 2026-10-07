# Build server + dashboard into a single image.
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /repo
# Dependencies are fetched in a separate layer that only changes when the lockfile changes (cacheable).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack install && pnpm fetch
COPY . .
RUN pnpm install --prefer-offline --frozen-lockfile=false --filter @patchkite/server... --filter @patchkite/dashboard...
RUN pnpm --filter @patchkite/server... --filter @patchkite/dashboard... build
RUN pnpm --filter @patchkite/server --config.inject-workspace-packages=true deploy --prod /out/server \
  && cp -r apps/server/drizzle /out/server/drizzle \
  && mkdir -p /out/dashboard && (cp -r apps/dashboard/dist/. /out/dashboard/ || true)

FROM node:24-alpine
WORKDIR /app
COPY --from=build /out/server /app
COPY --from=build /out/dashboard /app/dashboard
ENV NODE_ENV=production PORT=3000 DASHBOARD_DIR=/app/dashboard
# Run as the Node image's built-in non-root user.
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
