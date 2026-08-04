#!/bin/sh
set -eu

# Unraid's conventional appdata owner is nobody:users (UID 99, GID 100).
# Repair only the dedicated /config mount, then drop root before starting the
# application. Numeric IDs are used because host and container account names
# do not have to match.
if [ "$(id -u)" = "0" ]; then
  puid="${PUID:-99}"
  pgid="${PGID:-100}"

  case "$puid" in
    ""|*[!0-9]*) echo "PUID must be a positive numeric user ID" >&2; exit 1 ;;
  esac
  case "$pgid" in
    ""|*[!0-9]*) echo "PGID must be a positive numeric group ID" >&2; exit 1 ;;
  esac
  if [ "$puid" -eq 0 ] || [ "$pgid" -eq 0 ]; then
    echo "PUID and PGID must not be 0" >&2
    exit 1
  fi

  mkdir -p /config
  chown -R "${puid}:${pgid}" /config
  exec su-exec "${puid}:${pgid}" "$@"
fi

exec "$@"
