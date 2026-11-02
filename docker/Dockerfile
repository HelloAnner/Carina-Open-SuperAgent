# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pnpm@10.33.0
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/persistence/package.json packages/persistence/package.json
COPY packages/queue/package.json packages/queue/package.json
COPY packages/sources/package.json packages/sources/package.json
COPY packages/channels/package.json packages/channels/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/runtime/package.json packages/runtime/package.json
COPY packages/application/package.json packages/application/package.json
COPY packages/observability/package.json packages/observability/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build:web

FROM base AS app
COPY --from=build /app /app
ENV NODE_ENV=production
EXPOSE 8080
CMD ["pnpm", "exec", "tsx", "apps/api/src/main.ts"]

FROM nginx:1.27-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
