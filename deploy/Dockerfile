# 生产镜像：前端静态资源 + Go 单体（无 libvips，图片处理为纯 Go，见 D-034）

FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.26-bookworm AS server
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/ops ./cmd/ops

FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tzdata \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=server /out/ops /app/ops
COPY --from=web /web/dist /app/static
RUN mkdir -p /data
ENV OPS_DEV=0 \
    OPS_LISTEN=:8080 \
    OPS_STATIC_DIR=/app/static \
    OPS_DATA_DIR=/data \
    TZ=Asia/Shanghai
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=15s --timeout=3s --start-period=25s --retries=5 \
  CMD ["curl", "-fsS", "http://127.0.0.1:8080/healthz"]
CMD ["/app/ops", "serve"]
