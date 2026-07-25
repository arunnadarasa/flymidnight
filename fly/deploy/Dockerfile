# Ephemeral image used by scripts/fly-deploy-contract.sh. Bundles the
# compiled contract artefacts + the deploy script + node_modules, then runs
# once on a Fly Machine attached to the choreo-node app so it can reach
# ws://choreo-node.internal:9944 over 6PN.
FROM oven/bun:1.2.20-debian
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install

COPY scripts ./scripts
COPY contracts ./contracts
ENV NODE_ENV=production
CMD ["bun", "scripts/deploy-midnight.mjs"]
