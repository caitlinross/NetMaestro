# Pin to a specific ROSS and CODES commits for reproducible builds.
ARG ROSS_GIT_REF=dc3a6a056cfc7a5e68f7141f88d8833407599ef8
ARG CODES_GIT_REF=a5958cfaee6dcc73a98d084005e3412da773fb35
# PIN to a specific CODES Branch for FFW
# This points to a forked repo and should be updated/removed when merged into CODES proper
# Tip of digital-twin-sbir-fluid-flow-wan-fabric-topology, which carries the FABRIC
# testbed example that DJANGO_FFW_CONFIG_PATH points at.
ARG FFW_GIT_REF=ce288a286c35ca12f553429ca14e7d88fb8d354d

FROM ubuntu:24.04 AS ross-builder
ARG ROSS_GIT_REF
ARG CODES_GIT_REF
ARG FFW_GIT_REF

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git \
    build-essential clang \
    cmake ninja-build \
    pkg-config flex \
    bison lcov wget \
    && rm -rf /var/lib/apt/lists/*

# --- MPICH from source, ch4:ofi device (embedded libfabric, sockets/TCP). No UCX
#     and no verbs probing, reliable PMI wire-up -> mpiexec forms a real multi-
#     rank world on the CI runners. Installed to /opt/mpich and put on PATH so
#     find_package(MPI) discovers mpicc/mpicxx/mpiexec with no CODES/ROSS config
#     change. Bump MPICH_VERSION to update -- that's the whole maintenance story.
ARG MPICH_VERSION=4.3.2
RUN wget -q "https://www.mpich.org/static/downloads/${MPICH_VERSION}/mpich-${MPICH_VERSION}.tar.gz" \
    && tar xzf "mpich-${MPICH_VERSION}.tar.gz" \
    && cd "mpich-${MPICH_VERSION}" \
    && ./configure --prefix=/opt/mpich --with-device=ch4:ofi --disable-fortran \
    && make -j"$(nproc)" \
    && make install \
    && cd / \
    && rm -rf "mpich-${MPICH_VERSION}" "mpich-${MPICH_VERSION}.tar.gz"

# Put our mpich first so find_package(MPI) picks it over anything else.
ENV PATH=/opt/mpich/bin:$PATH

RUN git clone https://github.com/ross-org/ross.git /ross \
    && cd /ross \
    && git checkout "${ROSS_GIT_REF}" \
    && git submodule update --init --recursive

RUN cmake -S /ross -B /ross/build \
        -DCMAKE_BUILD_TYPE=Release \
        -DROSS_BUILD_MODELS=ON \
        -DROSS_BUILD_TESTING=OFF \
    && cmake --build /ross/build --parallel \
    && cmake --install /ross/build --prefix /ross/install

RUN git clone https://github.com/codes-org/codes.git opt/codes \
    && cd /opt/codes \
    && git checkout "${CODES_GIT_REF}" \
    && git submodule update --init --recursive

RUN cmake -S /opt/codes -B /opt/codes/build \
        -DROSS_DIR=/ross/install/lib \
        -DROSS_PKG_CONFIG_PATH=/ross/install/lib/pkgconfig \
    && cmake --build opt/codes/build \
    && cmake --install opt/codes/build/

# TODO: Points to forked repo and should be changed/removed when merged
RUN git clone https://github.com/caitlinross/codes.git opt/FFW \
    && cd opt/FFW \
    && git checkout "${FFW_GIT_REF}" \
    && git submodule update --init --recursive

RUN cmake -S opt/FFW -B opt/FFW/build/local \
        -DROSS_DIR=/ross/install/lib \
    && cmake --build opt/FFW/build/local -j"$(nproc)" \
    --target model-net-fluid-flow-wan-random-traffic \
    model-net-fluid-flow-wan-trace-traffic


FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

# Declared (empty by default) so the LD_LIBRARY_PATH append below references a
# variable defined in this stage, rather than an inherited/unset one.
ARG LD_LIBRARY_PATH=

COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# MPICH runtime (mpiexec/mpirun + libmpi), built from source in the ross-builder
# stage above. Must be the *same* MPICH build phold was linked against -- an
# apt-installed OpenMPI or a different MPICH build here would reintroduce the
# ABI/PMI-handshake mismatch this custom build exists to avoid.
COPY --from=ross-builder --chown=vscode:vscode /opt/mpich /opt/mpich
ENV PATH=/opt/mpich/bin:$PATH \
    LD_LIBRARY_PATH=/opt/mpich/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}

# PHOLD binary built in the ross-builder stage above. Baked into the image instead
# of relying on a host `ross` checkout bind-mounted at runtime.
COPY --from=ross-builder --chown=vscode:vscode /ross/build/models/phold/phold /opt/ross/phold
COPY --from=ross-builder --chown=vscode:vscode /opt/codes /opt/codes
# TODO: This may change once the FFW changes land in the main repo
COPY --from=ross-builder --chown=vscode:vscode /opt/FFW /opt/FFW
# Ensure Python output appears immediately in container logs.
ENV PYTHONUNBUFFERED=1

# Override Node's default of attempting to bind to IPv6 interfaces over IPv4
ENV NODE_OPTIONS=--dns-result-order=ipv4first

# Put the uv and npm caches in a separate location,
# where they can persist and be shared across containers.
# The uv cache and virtual environment are on different volumes, so hardlinks won't work.
ENV UV_CACHE_DIR=/home/vscode/pkg-cache/uv \
  UV_PYTHON_INSTALL_DIR=/home/vscode/pkg-cache/uv-python \
  UV_LINK_MODE=symlink \
  NPM_CONFIG_CACHE=/home/vscode/pkg-cache/npm

# Put the virtual environment outside the project directory,
# to improve performance on macOS and prevent accidental usage from the host machine.
# Activate it, so `uv run` doesn't need to be prefixed.
ENV UV_PROJECT_ENVIRONMENT=/home/vscode/venv \
  PATH="/home/vscode/venv/bin:$PATH"

# Put tool scratch files outside the project directory too.
ENV TOX_WORK_DIR=/home/vscode/tox \
  RUFF_CACHE_DIR=/home/vscode/.cache/ruff \
  MYPY_CACHE_DIR=/home/vscode/.cache/mypy

RUN ["chsh", "-s", "/usr/bin/zsh", "vscode"]

USER vscode

# Pre-create named volume mount points, so the new volume inherits `vscode` user ownership:
# https://docs.docker.com/engine/storage/volumes/#populate-a-volume-using-a-container
RUN ["mkdir", "/home/vscode/pkg-cache"]
