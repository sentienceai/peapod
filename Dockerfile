# Node for the server and the API, Python for the ingest and the build. One image, because
# the cycle writes the database the API reads and they must see the same disk.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip ca-certificates bash \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python deps first so they cache across code changes.
COPY pyproject.toml uv.lock ./
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -U pip \
    && /opt/venv/bin/pip install --no-cache-dir \
       "polars>=1.17" "numpy>=2.1" "requests>=2.32" "pyarrow>=18"

COPY package.json ./
COPY . .

# The volume mounts at /data. ingest/out and var are the only directories that must
# survive a deploy: the tape, the partitions, and the database.
# PEAPOD_LP_TERMINAL is deliberately unset: the registry the build needs is vendored in
# registry/, so there is nothing to seed before the first cycle can run.
# HOST explicitly: a container that binds loopback answers every healthcheck run inside
# itself and 502s every request from the platform's proxy. The server detects containers
# anyway; this makes it declarative rather than inferred.
ENV HOST=0.0.0.0 \
    PEAPOD_PY=/opt/venv/bin/python \
    PEAPOD_DB=/data/var/peapod.db \
    PEAPOD_DATA=/data \
    PYTHONPATH=/app/ingest:/app/export \
    NODE_ENV=production \
    PORT=8080

RUN chmod +x scripts/*.sh scripts/entrypoint.sh 2>/dev/null || true
EXPOSE 8080
ENTRYPOINT ["bash", "scripts/entrypoint.sh"]
CMD ["node", "--experimental-sqlite", "--no-warnings", "scripts/run.mjs"]
