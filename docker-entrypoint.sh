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

  # Unraid may recreate a container from its template during an image update.
  # Keep the explicit reverse-proxy choice in /config so a template default
  # cannot silently turn a configured HTTPS deployment back off.
  proxy_config=/config/reverse-proxy.env
  if [ -f "$proxy_config" ]; then
    while IFS='=' read -r key value; do
      case "$key" in
        TRUST_PROXY) [ -n "$value" ] && TRUST_PROXY="$value" ;;
        PUBLIC_ORIGIN) PUBLIC_ORIGIN="$value" ;;
      esac
    done < "$proxy_config"
    export TRUST_PROXY PUBLIC_ORIGIN
  fi
  if [ "${TRUST_PROXY:-false}" = "true" ] || [ -n "${PUBLIC_ORIGIN:-}" ]; then
    umask 077
    {
      printf 'TRUST_PROXY=%s\n' "${TRUST_PROXY:-false}"
      printf 'PUBLIC_ORIGIN=%s\n' "${PUBLIC_ORIGIN:-}"
    } > "$proxy_config"
  fi
  chown -R "${puid}:${pgid}" /config
  exec su-exec "${puid}:${pgid}" "$@"
fi

exec "$@"
