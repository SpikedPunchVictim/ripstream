# syntax=docker/dockerfile:1
# One Linux image holding every tool the xberg-methodology benchmark compares, so all lanes
# share a kernel, a CPU budget and a way of measuring RSS:
#   - Apache Tika 4.2.0 from the official image (the version the parity oracle runs), with
#     xberg's TikaExtract compiled against its jars
#   - the xberg CLI release, unpacked
#   - ripstream from `git archive HEAD`, installed and built natively for Linux
#   - Node 24 and GNU time
# Build contexts (scripts/bench/docker/run.sh passes them): ripstream, xberg, harness.
FROM node:24-slim AS node

FROM apache/tika:4.2.0
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends time \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules/corepack /usr/local/lib/node_modules/corepack
RUN ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack

# xberg's TikaExtract (MIT) with the three edits the Tika 4 API needs: parse() takes a
# TikaInputStream, and Metadata no longer carries CONTENT_TYPE. The image has a JRE only,
# so javac runs from the jdk.compiler module.
COPY --from=harness TikaExtract.java /opt/bench/src/TikaExtract.java
RUN sed -i \
      -e 's/^import java.io.InputStream;/import java.io.InputStream;\nimport org.apache.tika.io.TikaInputStream;/' \
      -e 's/try (InputStream stream = new FileInputStream(file))/try (TikaInputStream stream = TikaInputStream.get(new FileInputStream(file)))/' \
      -e 's/Metadata.CONTENT_TYPE/"Content-Type"/' \
      /opt/bench/src/TikaExtract.java \
 && java -m jdk.compiler/com.sun.tools.javac.Main -nowarn -d /opt/bench/tika-classes \
      -cp "$(ls /opt/tika-server/lib/*.jar | tr '\n' ':')" /opt/bench/src/TikaExtract.java \
 && echo "4.2.0 (apache/tika:4.2.0 /opt/tika-server/lib)" > /opt/bench/TIKA_VERSION \
 && java -version 2>&1 | head -n 1 > /opt/bench/JAVA_VERSION

COPY --from=xberg / /opt/xberg/
RUN /opt/xberg/xberg --version > /opt/xberg/VERSION

COPY --from=ripstream / /opt/ripstream/
WORKDIR /opt/ripstream
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 COREPACK_HOME=/opt/corepack
# Docker Desktop's network drops large registry downloads under pnpm's default concurrency, so
# fetch fewer at a time with a long timeout, and keep the store in a build cache so a retry
# resumes instead of starting over (`docker builder prune` clears it).
RUN --mount=type=cache,id=ripstream-bench-pnpm,target=/opt/pnpm-store \
    corepack pnpm install --frozen-lockfile --store-dir /opt/pnpm-store \
      --network-concurrency 4 --fetch-timeout 600000 --fetch-retries 5 \
 && corepack pnpm run build

USER 35002:35002
WORKDIR /tmp
ENTRYPOINT []
CMD ["node", "--version"]
