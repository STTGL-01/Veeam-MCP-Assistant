# Veeam Assistant portal.
#
# Carries both runtimes, because the MCP servers it starts are written in
# different languages: vi-mcp is Node.js, vbr-mcp is Python.
#
# The base is Python 3.13 because vbr-mcp requires >=3.13,<3.14. The Node
# binary is copied in from the official Node image. Both images are Debian
# based, so the binary runs as-is.
#
# The MCP servers themselves are built separately and mounted at /servers, so
# either can be rebuilt without rebuilding this image. See SETUP_GUIDE.md.
FROM node:24-slim AS node
FROM python:3.13-slim

COPY --from=node /usr/local/bin/node /usr/local/bin/node

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates wget \
 && rm -rf /var/lib/apt/lists/* \
 && node --version && python3 --version \
 && useradd --system --create-home --home-dir /home/portal portal

WORKDIR /portal
COPY package.json server.mjs ./
COPY lib ./lib
COPY public ./public
RUN mkdir -p /data /servers && chown -R portal:portal /data \
 && chown -R root:root /portal && chmod -R a+rX /portal

USER portal
ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    BACKENDS_FILE=/etc/veeam-assistant/backends.json \
    PYTHONUNBUFFERED=1

VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null || exit 1

CMD ["node", "/portal/server.mjs"]
