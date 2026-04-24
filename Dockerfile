FROM node:22-slim

WORKDIR /app

RUN apt-get update && \
    apt-get install -y git && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY tsconfig.base.json ./
COPY packages/app/package.json ./packages/app/

RUN npm ci --workspace @obsidian-mcp/app --include-workspace-root

COPY packages/app/src ./packages/app/src
COPY packages/app/tsconfig.json ./packages/app/

RUN npm run build:stdio --workspace @obsidian-mcp/app && \
    npm run build:http --workspace @obsidian-mcp/app && \
    mkdir -p dist/stdio dist/http && \
    cp packages/app/dist/stdio/index.js dist/stdio/index.js && \
    cp packages/app/dist/http/index.js dist/http/index.js && \
    if [ -d packages/app/node_modules ]; then cp -rn packages/app/node_modules/. node_modules/ 2>/dev/null; true; fi

COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENV NODE_ENV=production \
    NODE_OPTIONS="--no-warnings" \
    LOCAL_VAULT_PATH=/app/vaults/vault-local

RUN mkdir -p /app/vaults

EXPOSE 3000

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["stdio"]
