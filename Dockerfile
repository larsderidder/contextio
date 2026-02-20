FROM node:22-alpine AS build
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/package.json
COPY packages/proxy/package.json packages/proxy/package.json
COPY packages/logger/package.json packages/logger/package.json
COPY packages/redact/package.json packages/redact/package.json

RUN pnpm install --frozen-lockfile --filter @contextio/proxy...

COPY packages/core/src packages/core/src
COPY packages/core/tsconfig.json packages/core/tsconfig.json
COPY packages/proxy/src packages/proxy/src
COPY packages/proxy/tsconfig.json packages/proxy/tsconfig.json
COPY packages/logger/src packages/logger/src
COPY packages/logger/tsconfig.json packages/logger/tsconfig.json
COPY packages/redact/src packages/redact/src
COPY packages/redact/tsconfig.json packages/redact/tsconfig.json

RUN pnpm --filter @contextio/core --filter @contextio/logger --filter @contextio/redact --filter @contextio/proxy build

FROM node:22-alpine AS runtime
WORKDIR /app

ARG BUILDTIME
ARG VERSION
ARG REVISION

LABEL org.opencontainers.image.title="contextio-proxy"
LABEL org.opencontainers.image.description="LLM API proxy with redaction and logging. Zero external dependencies."
LABEL org.opencontainers.image.url="https://github.com/larsderidder/contextio"
LABEL org.opencontainers.image.source="https://github.com/larsderidder/contextio"
LABEL org.opencontainers.image.vendor="Lars de Ridder"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.created="${BUILDTIME}"
LABEL org.opencontainers.image.revision="${REVISION}"

ENV NODE_ENV=production
ENV CONTEXT_PROXY_BIND_HOST=0.0.0.0
ENV CONTEXT_PROXY_PORT=4040
ENV CONTEXT_PROXY_PLUGINS=/app/logger-plugin.js

COPY --from=build /app/packages/proxy/dist ./dist
COPY --from=build /app/packages/proxy/package.json ./package.json
COPY --from=build /app/packages/core/package.json ./node_modules/@contextio/core/package.json
COPY --from=build /app/packages/core/dist ./node_modules/@contextio/core/dist
COPY --from=build /app/packages/logger/package.json ./node_modules/@contextio/logger/package.json
COPY --from=build /app/packages/logger/dist ./node_modules/@contextio/logger/dist
COPY --from=build /app/packages/redact/package.json ./node_modules/@contextio/redact/package.json
COPY --from=build /app/packages/redact/dist ./node_modules/@contextio/redact/dist

RUN echo 'import { createLoggerPlugin } from "@contextio/logger";\n\
const captureDir = process.env.LOGGER_CAPTURE_DIR;\n\
const maxSessions = process.env.LOGGER_MAX_SESSIONS ? parseInt(process.env.LOGGER_MAX_SESSIONS, 10) : 0;\n\
export default () => createLoggerPlugin({ captureDir, maxSessions });' > /app/logger-plugin.js && \
    echo 'import { createRedactPlugin } from "@contextio/redact";\n\
const preset = process.env.REDACT_PRESET || "pii";\n\
const reversible = process.env.REDACT_REVERSIBLE === "true";\n\
const policyFile = process.env.REDACT_POLICY_FILE;\n\
const config = policyFile ? { policyFile, reversible } : { preset, reversible };\n\
export default () => createRedactPlugin(config);' > /app/redact-plugin.js

USER node
EXPOSE 4040

CMD ["node", "dist/server.js"]
