FROM docker.io/library/alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
ARG BINARY_NAME=webdrop-linux-x86_64
LABEL org.opencontainers.image.title="WebDrop" \
      org.opencontainers.image.description="File and text sharing with embedded frontend" \
      org.opencontainers.image.source="https://github.com/greepar/webdrop" \
      org.opencontainers.image.licenses="MIT"
COPY --chmod=755 dist/api/${BINARY_NAME} /webdrop
COPY --chown=65532:65532 containers/container.env /app/.env
COPY --chown=65532:65532 containers/data/ /data/
COPY LICENSE /licenses/WebDrop
ENV API_HOST=0.0.0.0 API_PORT=8080 DATA_DIR=/data
WORKDIR /app
USER 65532:65532
EXPOSE 8080
VOLUME ["/data"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["/webdrop"]
CMD ["serve"]
