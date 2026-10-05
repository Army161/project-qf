#!/bin/sh
# Hosts such as Fly.io mount volumes owned by root. Start as root only long enough to give /data to the unprivileged
# `node` user, then run the server as that user. Nothing else runs as root.
set -eu
if [ "$(id -u)" = "0" ]; then
  chown -R node:node /data
  # setpriv replaces this process (no root parent left behind); the server becomes PID 1 and receives stop signals directly
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi
exec "$@"
