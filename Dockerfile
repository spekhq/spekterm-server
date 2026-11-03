# spekterm-server: one container, one data directory, one port (docs/self-hosting.md).
FROM node:22.22-alpine

ENV NODE_ENV=production \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    DATA_DIR=/data \
    PORT=8080

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY LICENSE README.md ./
COPY src ./src
COPY bin ./bin

# /data must belong to the node user before VOLUME, or a new named volume is not writable by it.
RUN ln -s /app/bin/spekterm-server-admin /usr/local/bin/spekterm-server-admin \
 && mkdir -p /data && chown node:node /data
VOLUME /data

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 CMD ["node", "src/healthcheck.ts"]
# Exec form, so that node itself receives SIGTERM on `docker stop`.
CMD ["node", "src/server.ts"]
