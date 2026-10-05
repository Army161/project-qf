# Project QF launchpad server image. Build from the repository root:
#   docker build -f deploy/Dockerfile -t qf-launchpad .
#
# PRIVATE IMAGE. It holds proprietary code and, under licence exception QF-LIC-EX-001, the unmodified LGPL-3.0
# rpc-websockets@9.3.9 inside the server-side Meteora adapter. Push it only to your own host's private registry (your
# Fly.io or Render app). Never to a public registry, and never hand it to customers (ADR-012).
#
# By default it runs mainnet READ-ONLY (DEPLOYMENT.md "staging"): no key is loaded, the RPC connections cannot send, and
# every launch, trade, claim, treasury step and faucet request is refused. QF_CLUSTER=devnet runs the test launchpad.
# Settings: deploy/launchpad.env.example. Steps: deploy/RUNBOOK.md.

# Node 22.22.0 on Debian bookworm, pinned by digest (multi-arch index, as published on Docker Hub).
ARG NODE_IMAGE=node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94

# ---- build: install everything, build the web app, prove the browser bundle is clean
FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY . .
# --ignore-scripts: no dependency lifecycle script runs (also .npmrc); --frozen-lockfile: exactly the reviewed versions
RUN pnpm install --frozen-lockfile --ignore-scripts
# the web build, then the browser boundary check: the image is not built if web3.js, rpc-websockets or @meteora-ag/*
# reached the browser bundle
RUN pnpm build:web && pnpm boundary

# ---- runtime: production dependencies of the launchpad only, the built web app, and the notices
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
COPY . .
RUN pnpm --filter "@project-qf/launchpad..." install --prod --frozen-lockfile --ignore-scripts \
 && rm -rf /root/.cache /root/.local/share/pnpm /tmp/* \
 && mkdir -p /data && chown node:node /data
COPY --from=build /app/apps/web/dist /app/apps/web/dist
COPY --chmod=755 deploy/entrypoint.sh /usr/local/bin/qf-entrypoint
LABEL org.opencontainers.image.title="qf-launchpad" \
      org.opencontainers.image.description="Project QF launchpad server (private image; see deploy/RUNBOOK.md)" \
      org.opencontainers.image.licenses="LicenseRef-Proprietary"

# The server runs as the unprivileged `node` user: the entrypoint hands it /data (host volumes may mount root-owned) and drops
# to it before starting anything.
WORKDIR /app/apps/launchpad
# HOME=/data puts the devnet operator key's default location (~/.qf-devnet/operator.json, a throwaway key generated on
# first start) on the volume, mode 0600. Mainnet loads no key at all.
ENV NODE_ENV=production \
    HOME=/data \
    QF_CLUSTER=mainnet-beta \
    QF_LP_HOST=0.0.0.0 \
    QF_LP_PORT=8080 \
    QF_LP_DB=/data/qf-launchpad-mainnet.sqlite \
    QF_STATIC_DIR=/app/apps/web/dist
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.QF_LP_PORT||8080)+'/api/lp/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/usr/local/bin/qf-entrypoint"]
# --use-env-proxy only matters where the host routes egress through HTTPS_PROXY; without proxy settings it does nothing
CMD ["node", "--no-warnings", "--use-env-proxy", "src/main.ts", "serve"]
