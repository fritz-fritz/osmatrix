# Adds sshd to an act-compatible runner image so osmatrix can treat it like any other guest.
ARG BASE=catthehacker/ubuntu:act-24.04
FROM ${BASE}
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd /root/.ssh /root/work \
 && chmod 700 /root/.ssh \
 && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/; s/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
 && echo 'AllowTcpForwarding yes' >> /etc/ssh/sshd_config \
 && echo 'GatewayPorts no' >> /etc/ssh/sshd_config
COPY entrypoint.sh /usr/local/bin/osmatrix-entrypoint
RUN chmod +x /usr/local/bin/osmatrix-entrypoint
EXPOSE 22
ENTRYPOINT ["/usr/local/bin/osmatrix-entrypoint"]
