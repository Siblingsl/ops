# 生产镜像：仅 Go API（无 libvips，图片处理为纯 Go，见 D-034）
# 国内构建默认走镜像源；海外可通过 build-arg 覆盖。

FROM golang:1.26-bookworm AS server
ARG GOPROXY=https://goproxy.cn,direct
ENV GOPROXY=${GOPROXY}
WORKDIR /src
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/ops ./cmd/ops

FROM debian:bookworm-slim
# apt mirror source can be overridden via build-arg (same pattern as NPM_REGISTRY/GOPROXY):
# CN default mirrors.aliyun.com; use --build-arg APT_MIRROR= for the default Debian mirrors.
ARG APT_MIRROR=mirrors.aliyun.com
RUN if [ -n "$APT_MIRROR" ]; then \
      sed -i "s|deb.debian.org|$APT_MIRROR|g; s|security.debian.org|$APT_MIRROR|g" /etc/apt/sources.list.d/debian.sources 2>/dev/null \
      || sed -i "s|deb.debian.org|$APT_MIRROR|g; s|security.debian.org|$APT_MIRROR|g" /etc/apt/sources.list; \
    fi \
    && apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl tzdata \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=server /out/ops /app/ops
RUN mkdir -p /data
ENV OPS_DEV=0 \
    OPS_LISTEN=:8080 \
    OPS_DATA_DIR=/data \
    TZ=Asia/Shanghai
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=15s --timeout=3s --start-period=25s --retries=5 \
  CMD ["curl", "-fsS", "http://127.0.0.1:8080/healthz"]
CMD ["/app/ops", "serve"]
