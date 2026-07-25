# Midnight proof-server with IPv6 dual-stack proxy.
#
# The stock midnightntwrk/proof-server:8.0.3 binary is hard-coded to bind to
# 0.0.0.0 (IPv4 only). Fly.io's private 6PN network is IPv6-only, so a service
# that only listens on IPv4 cannot be reached from another app via
# choreo-proof.internal. This image wraps the proof server with a static socat
# that listens on both IPv4 and IPv6 and proxies to the proof server on a
# loopback port.
#
# Build context: this directory (fly/proof).
# Deploy: FLY_ACCESS_TOKEN=... flyctl deploy -c fly/proof/fly.toml --remote-only

FROM midnightntwrk/proof-server:8.0.3

COPY --chmod=0755 socat /usr/local/bin/socat
COPY --chmod=0755 entrypoint.sh /entrypoint.sh

ENV PATH="/usr/local/bin:${PATH}"

ENTRYPOINT ["/entrypoint.sh"]
