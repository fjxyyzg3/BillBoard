FROM node:22-bookworm-slim AS base

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

FROM base AS deps

COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS tools

COPY . .
RUN npx prisma generate

FROM deps AS builder

COPY . .
RUN npx prisma generate
RUN npm run build

FROM base AS runner

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

EXPOSE 3000

CMD ["sh", "-lc", "if [ -z \"$AUTH_SECRET\" ] || [ \"$AUTH_SECRET\" = \"change-me-before-launch\" ] || [ \"$AUTH_SECRET\" = \"replace-me\" ]; then echo 'AUTH_SECRET must be set to a non-placeholder value' >&2; exit 1; fi; node server.js"]
