# Linux CI legs run in this layer over act's default image when act_linux_image is left at its default.
# It adds what GitHub's ubuntu-24.04 runner image preinstalls and act's image lacks, where a missing tool
# makes local runs fail in ways GitHub never shows. osmatrix tags the build with a hash of this file and
# the pinned versions, so editing it or a new runner image release rebuilds the image on the next Linux leg.
FROM catthehacker/ubuntu:act-24.04

# Rust: GitHub preinstalls rustup stable with rustfmt and clippy. Without them, the first rustc/cargo call
# in a repo whose rust-toolchain.toml lists those components installs them, and a tool that kills that
# call early (pip probes `rustc --version` with a 0.5 s timeout) leaves the toolchain corrupted.
#
# RUST_VERSION is the version in GitHub's latest ubuntu24 runner image (osmatrix reads it from the image's
# release readme), or "stable" when that couldn't be resolved. A pinned version is installed under the name
# "stable", with the update hash of its own channel manifest, so it is the runner's "stable" toolchain: a
# workflow asking for stable gets "unchanged" while that is still the current release, and downloads the
# newer one after a Rust release, as on GitHub.
ARG RUST_VERSION=stable
ENV CARGO_HOME=/root/.cargo RUSTUP_HOME=/root/.rustup
ENV PATH=/root/.cargo/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --default-toolchain "$RUST_VERSION" -c rustfmt -c clippy \
 && if [ "$RUST_VERSION" != stable ]; then \
      host=$(rustc -vV | sed -n 's/^host: //p') \
      && mv "$RUSTUP_HOME/toolchains/$RUST_VERSION-$host" "$RUSTUP_HOME/toolchains/stable-$host" \
      && mv "$RUSTUP_HOME/update-hashes/$RUST_VERSION-$host" "$RUSTUP_HOME/update-hashes/stable-$host" \
      && rustup default stable; \
    fi \
 && rustc --version && cargo fmt --version && cargo clippy --version
