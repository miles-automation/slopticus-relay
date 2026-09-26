FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 SLOPTICUS_SECURE_PAIRING=1
LABEL org.opencontainers.image.source="https://github.com/miles-automation/slopticus-relay"
LABEL org.opencontainers.image.licenses="Apache-2.0"
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY LICENSE NOTICE ./
COPY LICENSES ./LICENSES
RUN mkdir data && chown node:node data
USER node
EXPOSE 8787
CMD ["node", "dist/server.js"]
