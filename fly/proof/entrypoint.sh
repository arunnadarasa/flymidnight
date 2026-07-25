#!/bin/bash
set -e

# The stock midnight-proof-server binary only listens on IPv4. We run it on a
# loopback port and proxy all IPv4 + IPv6 traffic on the external port to it.
INTERNAL_PORT=${INTERNAL_PORT:-6301}
EXTERNAL_PORT=${PORT:-6300}

echo "Starting midnight-proof-server on 127.0.0.1:${INTERNAL_PORT}"
midnight-proof-server -v --port "${INTERNAL_PORT}" &
PROOF_PID=$!

# Wait until the proof server is accepting TCP connections on the loopback port.
for i in {1..30}; do
  if (exec 3<>/dev/tcp/127.0.0.1/${INTERNAL_PORT}) 2>/dev/null; then
    exec 3<&- 3>&-
    break
  fi
  sleep 1
done

if ! kill -0 "${PROOF_PID}" 2>/dev/null; then
  echo "midnight-proof-server failed to start"
  exit 1
fi

echo "Proxying :${EXTERNAL_PORT} -> 127.0.0.1:${INTERNAL_PORT}"

# Listen on both IPv4 and IPv6 using a single IPv6 socket with V6ONLY=0.
socat TCP6-LISTEN:${EXTERNAL_PORT},reuseaddr,fork,ipv6-v6only=0 TCP4:127.0.0.1:${INTERNAL_PORT} &
PROXY_PID=$!

cleanup() {
  echo "Shutting down..."
  kill "${PROXY_PID}" "${PROOF_PID}" 2>/dev/null || true
  wait 2>/dev/null || true
  exit 0
}
trap cleanup TERM INT

# Block until any child exits, then clean up the rest.
set +e
wait -n
EXIT_CODE=$?
cleanup
exit ${EXIT_CODE}
