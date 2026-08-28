# Kimaki demo server — runs the Discord bot in gateway mode on Fly.io.
# Uses the shared Kimaki bot via gateway-proxy, no bot token needed.
# Credentials are generated on first boot and persisted on the volume.

FROM node:24-slim

# git, curl, unzip are required (git for shuvcode, curl+unzip for bun installer)
RUN apt-get update && apt-get install -y git curl unzip && rm -rf /var/lib/apt/lists/*

# Install bun (required by shuvcode)
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Install kimaki globally from npm.
# IMPORTANT: always use the latest published version here.
# Check with: npm view kimaki version
# Bump this after publishing a new kimaki version, then fly deploy.
#
# DO NOT fly deploy a shuvcode-only image while this pin is still a
# pre-cutover kimaki. kimaki@0.23.1 spawns
# `opencode serve --port N --print-logs --log-level WARN`, and shuvcode
# v2 serve rejects `--print-logs`. Keep the upstream opencode install
# below until the pin moves to the first shuvcode-aware kimaki release
# in the SAME commit. Then drop the opencode installer.
RUN npm install -g kimaki@0.23.1

# kimaki@0.23.1 still launches upstream opencode. Required until the pin
# above is bumped. The installer can fail when GitHub API rate-limits
# the version lookup, so pin a specific version.
RUN curl -fsSL https://opencode.ai/install | bash -s -- --version 1.18.3
ENV PATH="/root/.opencode/bin:$PATH"

# Pre-install shuvcode so the next pin bump does not need a second image
# change. Unused by kimaki@0.23.1.
RUN npm install -g shuvcode@2.0.0-alpha-16

# Pre-install tools the AI agent uses via bunx so first invocations are instant.
# critique: diff viewing and sharing (bunx critique --web)
# tuistory: background process management for dev servers (bunx tuistory)
# opensrc: read dependency source code for context (bunx opensrc)
RUN bun install -g critique tuistory opensrc

# Create persistent data directories on the volume mount point
RUN mkdir -p /data/projects

ENV OPENCODE_ENABLE_EXA=1

WORKDIR /data

# Allow shuvcode to read/write all directories without prompting.
# The demo server creates projects in /data/projects and the agent needs
# unrestricted filesystem access since there is no human to approve prompts.
RUN mkdir -p /root/.config/opencode && \
    printf '{\n  "$schema": "https://opencode.ai/config.json",\n  "permission": "allow"\n}\n' > /root/.config/opencode/opencode.json

# --gateway: use the shared Kimaki bot via gateway-proxy (no bot token needed)
# --data-dir /data: store sqlite DB and config on the persistent volume
# --projects-dir /data/projects: store user-created projects on the volume
# --allow-all-users: anyone in the Discord server can use the bot
# --auto-restart: respawn wrapper for crash recovery inside the container
CMD ["kimaki", "--gateway", "--data-dir", "/data", "--projects-dir", "/data/projects", "--allow-all-users", "--auto-restart"]
