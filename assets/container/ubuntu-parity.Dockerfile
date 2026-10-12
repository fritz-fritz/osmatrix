# Linux CI legs run in this layer over act's default image when act_linux_image is left at its default.
# It adds what GitHub's ubuntu-24.04 runner image preinstalls and act's image lacks, where a missing tool
# makes local runs fail in ways GitHub never shows. osmatrix tags the build with a hash of this file, so
# editing it rebuilds the image on the next Linux leg.
FROM catthehacker/ubuntu:act-24.04

# Rust: GitHub preinstalls rustup stable with rustfmt and clippy. Without them, the first rustc/cargo call
# in a repo whose rust-toolchain.toml lists those components installs them, and a tool that kills that
# call early (pip probes `rustc --version` with a 0.5 s timeout) leaves the toolchain corrupted.
ENV CARGO_HOME=/root/.cargo RUSTUP_HOME=/root/.rustup
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path --profile minimal --default-toolchain stable -c rustfmt -c clippy
ENV PATH=/root/.cargo/bin:$PATH
