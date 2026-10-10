#!/bin/sh
set -e
if [ -n "$AUTHORIZED_KEY" ]; then
  printf '%s\n' "$AUTHORIZED_KEY" > /root/.ssh/authorized_keys
  chmod 600 /root/.ssh/authorized_keys
fi
# ssh sessions don't inherit the container env; expose the runner image's env (PATH, tool caches) via pam_env.
env | grep -Ev '^(AUTHORIZED_KEY|HOSTNAME|HOME|PWD|SHLVL|TERM|_)=' > /etc/environment || true
ssh-keygen -A >/dev/null
exec /usr/sbin/sshd -D -e
