#!/bin/sh
set -eu

# Unraid creates bind-mounted appdata directories with host ownership that may
# not match the container's node user. Repair only the dedicated /config mount,
# then drop root before starting the application.
if [ "$(id -u)" = "0" ]; then
  mkdir -p /config
  chown -R node:node /config
  exec su-exec node "$@"
fi

exec "$@"
