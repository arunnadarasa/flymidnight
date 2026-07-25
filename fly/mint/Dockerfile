# choreo-mint — server-side minter for the Undeployed Fly stack.
# Holds the genesis seed (…0002) and signs publishKit txs on behalf of
# visitors so a mobile-only user never needs Lace or tDUST.
#
# The compiled Compact artefacts (keys/, zkir/, contract/) must be present
# in the build context under contracts/managed/tokenized-choreo-kits.
FROM oven/bun:1.2.20-debian AS build
WORKDIR /app
COPY fly/mint/package.json ./package.json
RUN bun install
COPY fly/mint/server.mjs ./server.mjs
COPY contracts/managed/tokenized-choreo-kits ./contracts/managed/tokenized-choreo-kits

FROM oven/bun:1.2.20-debian
WORKDIR /app
COPY --from=build /app /app
ENV PORT=8080
EXPOSE 8080
CMD ["bun", "server.mjs"]
