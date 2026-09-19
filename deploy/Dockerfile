# Worker image. Build context is the repository root.
FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/package.json
COPY packages/store/package.json packages/store/package.json
COPY packages/classifier/package.json packages/classifier/package.json
COPY packages/whatsapp/package.json packages/whatsapp/package.json
# Install scripts stay disabled (pnpm-workspace.yaml); the lockfile is authoritative.
RUN pnpm install --frozen-lockfile --prod
COPY packages packages
# A numeric user that exists on no host account, so host users cannot read its files.
USER 10470:10470
ENTRYPOINT ["node", "--experimental-strip-types", "packages/whatsapp/src/cli.ts"]
