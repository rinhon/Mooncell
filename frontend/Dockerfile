FROM node:22-alpine AS builder

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM nginx:1.27-alpine AS runtime
RUN apk add --no-cache --virtual .nginx-capabilities libcap \
    && sed -i '/^user[[:space:]]/d; s@^pid[[:space:]].*;@pid /tmp/nginx.pid;@' /etc/nginx/nginx.conf \
    && chown -R nginx:nginx /var/cache/nginx \
    && setcap 'cap_net_bind_service=+ep' /usr/sbin/nginx \
    && apk del .nginx-capabilities
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

USER nginx

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1
