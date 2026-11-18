FROM node:22-bookworm-slim AS base

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

FROM base AS deps

COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS tools

ARG APP_IMAGE_TAG=latest
LABEL org.opencontainers.image.revision=$APP_IMAGE_TAG

COPY . .
RUN npx prisma generate

FROM deps AS agent

ARG APP_IMAGE_TAG=latest
LABEL org.opencontainers.image.revision=$APP_IMAGE_TAG

ENV NODE_ENV=production

COPY agent ./agent
COPY src/lib/imports/agent-protocol.ts ./src/lib/imports/agent-protocol.ts
COPY src/lib/transactions/natural-language-protocol.ts src/lib/transactions/datetime.ts ./src/lib/transactions/
COPY src/lib/reports/bill-analysis-protocol.ts src/lib/reports/bill-analysis-types.ts ./src/lib/reports/
COPY src/lib/reports/bill-reconciliation-protocol.ts src/lib/reports/bill-reconciliation-preview.ts src/lib/reports/bill-reconciliation-types.ts ./src/lib/reports/
USER node

CMD ["node", "--import", "tsx", "agent/main.ts"]

FROM deps AS builder

ARG APP_BASE_PATH=""
ENV APP_BASE_PATH=$APP_BASE_PATH

COPY . .
RUN npx prisma generate
RUN npm run build

FROM base AS runner

ARG APP_IMAGE_TAG=latest
LABEL org.opencontainers.image.revision=$APP_IMAGE_TAG

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

EXPOSE 3000

CMD ["sh", "-lc", "if [ -z \"$AUTH_SECRET\" ] || [ \"$AUTH_SECRET\" = \"change-me-before-launch\" ] || [ \"$AUTH_SECRET\" = \"replace-me\" ]; then echo 'AUTH_SECRET must be set to a non-placeholder value' >&2; exit 1; fi; if [ -z \"$POSTGRES_PASSWORD\" ] || [ \"$POSTGRES_PASSWORD\" = \"billboard\" ] || [ \"$POSTGRES_PASSWORD\" = \"change-me\" ] || [ \"$POSTGRES_PASSWORD\" = \"replace-me\" ] || [ \"$POSTGRES_PASSWORD\" = \"change-me-before-launch\" ]; then echo 'POSTGRES_PASSWORD must be set to a non-placeholder value' >&2; exit 1; fi; node server.js"]
