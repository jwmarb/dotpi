#  Reference verification base image for the ralph-loop runtime gate.
#
#  This is the image the `verifier` agent runs the project's checks inside. It
#  provides a browser and the agent-browser CLI; project images extend it with
#  whatever toolchain the project itself needs (see `image.ts`).
#
#  WHY THIS FILE IS TRACKED
#
#  Generated project Dockerfiles are cached, disposable, and gitignored. This one
#  is not: it is the contract the verifier relies on, and every measured
#  behaviour below was a bug before it was a line of this file. Regenerating it
#  from scratch would rediscover all four the hard way.
#
#  MEASURED BEHAVIOURS — change these only against a real container
#
#   1. `agent-browser` requires Node >= 24. `node:22-slim` fails with
#      `EBADENGINE` at install time.
#   2. `agent-browser install --with-deps` shells out to `sudo apt-get`. Slim
#      images have no `sudo`, and the CLI reports success-with-warnings while
#      installing nothing, so the browser then fails to launch. `sudo` is a
#      build dependency, not a convenience.
#   3. `install` puts Chrome under the *building* user's `$HOME`
#      (`/root/.agent-browser/browsers/chrome-<version>`). The gate runs
#      containers as the invoking UID with `HOME=/tmp`, which cannot see it and
#      fails with "Chrome not found". So Chrome is relocated to `/opt`, made
#      world-readable, and pinned via `AGENT_BROWSER_EXECUTABLE_PATH`.
#   4. The Chrome directory carries its version, which changes on every CLI
#      release. It is discovered at build time and symlinked to a stable path
#      rather than hard-coded.
#
#  SAFETY
#
#  Page content is untrusted input. `AGENT_BROWSER_CONTENT_BOUNDARIES` and
#  `AGENT_BROWSER_MAX_OUTPUT` are set here rather than left to the caller: the
#  verifier feeds page text into an LLM context, and upstream's own docs are
#  explicit that these markers are a provenance cue, not a security boundary.
#  Defence in depth is the whole point of running this in a container.

FROM node:24-slim

# Pinned deliberately. agent-browser is pre-1.0 and moving fast (~700 commits),
# and this file depends on install-path behaviour that is not a documented API.
# Bump only together with a real re-verification of the four behaviours above.
ARG AGENT_BROWSER_VERSION=0.38.1

# `sudo` is required by `install --with-deps` (behaviour 2). `curl`/`ca-certificates`
# are needed to fetch Chrome.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      sudo \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g "agent-browser@${AGENT_BROWSER_VERSION}"

# Install Chrome + its system libraries, then relocate it out of root's $HOME so
# a non-root runtime user can execute it (behaviours 3 and 4).
RUN agent-browser install --with-deps \
 && mkdir -p /opt/agent-browser \
 && if [ -d /root/.agent-browser/browsers ]; then \
      cp -r /root/.agent-browser/browsers /opt/agent-browser/; \
    fi \
 && CHROME="$(find /opt/agent-browser -name chrome -type f | head -1)" \
 && test -n "$CHROME" \
 && ln -sf "$CHROME" /opt/agent-browser/chrome \
 && chmod -R a+rX /opt/agent-browser \
 && /opt/agent-browser/chrome --version

# A stable path, independent of the Chrome version baked in above.
ENV AGENT_BROWSER_EXECUTABLE_PATH=/opt/agent-browser/chrome

# Untrusted-content handling, on by default (see SAFETY above).
ENV AGENT_BROWSER_CONTENT_BOUNDARIES=1
ENV AGENT_BROWSER_MAX_OUTPUT=50000

# The daemon otherwise lingers for an hour after the last command. Containers are
# `--rm` and short-lived, so a long idle timeout only risks holding one open.
ENV AGENT_BROWSER_IDLE_TIMEOUT_MS=60000

# Screenshots and other evidence go here; the gate bind-mounts a host scratch
# directory over it so the verifier can read the artifacts afterwards.
RUN mkdir -p /artifacts && chmod 777 /artifacts

WORKDIR /project

# Fail loudly at build time if the browser cannot actually launch, rather than
# handing the verifier a broken image and calling the result "inconclusive".
RUN agent-browser --version && echo "verify-base OK"
