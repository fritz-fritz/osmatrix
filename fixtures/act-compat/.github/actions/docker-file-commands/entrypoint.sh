#!/bin/sh
set -eu
echo "GITHUB_OUTPUT=$GITHUB_OUTPUT GITHUB_ENV=$GITHUB_ENV"
echo "greeting=hello-from-docker" >> "$GITHUB_OUTPUT"
echo "OSMATRIX_DOCKER_ACTION=set" >> "$GITHUB_ENV"
