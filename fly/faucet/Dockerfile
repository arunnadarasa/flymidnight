# Faucet service. Small Node.js server that opens the faucet wallet on the
# Fly indexer + node and sends tDUST to requesters. Rate-limited in-memory.
FROM oven/bun:1.1.42-debian AS build
WORKDIR /app
COPY fly/faucet/package.json fly/faucet/bun.lockb* ./
RUN bun install --frozen-lockfile || bun install
COPY fly/faucet/server.mjs ./server.mjs

FROM oven/bun:1.1.42-debian
WORKDIR /app
COPY --from=build /app /app
ENV PORT=8787
EXPOSE 8787
CMD ["bun", "server.mjs"]
