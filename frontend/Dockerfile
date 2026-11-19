# Krug SPA: Vite build + nginx same-origin proxy.
# Build context: ../frontend (not the repository root).
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ARG VITE_API_BASE_URL=/api/v1
ARG VITE_USE_MOCKS=false
ARG VITE_AUTH_MODE=password
ARG VITE_DEV_SESSION=false
ARG VITE_DEVICE_NAME="Сова — браузер"
ARG VITE_APP_VERSION=0.1.0
ARG VITE_REALTIME_ENABLED=true
ARG VITE_MEDIA_ORIGINS=http://localhost:9002
ARG VITE_E2EE_ENABLED=false

ENV VITE_API_BASE_URL=$VITE_API_BASE_URL \
    VITE_USE_MOCKS=$VITE_USE_MOCKS \
    VITE_AUTH_MODE=$VITE_AUTH_MODE \
    VITE_DEV_SESSION=$VITE_DEV_SESSION \
    VITE_DEVICE_NAME=$VITE_DEVICE_NAME \
    VITE_APP_VERSION=$VITE_APP_VERSION \
    VITE_REALTIME_ENABLED=$VITE_REALTIME_ENABLED \
    VITE_MEDIA_ORIGINS=$VITE_MEDIA_ORIGINS \
    VITE_E2EE_ENABLED=$VITE_E2EE_ENABLED

RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=10 CMD wget -qO- http://127.0.0.1/healthz >/dev/null || exit 1
