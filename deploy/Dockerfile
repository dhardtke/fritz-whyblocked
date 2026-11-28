ARG BUN_VERSION
FROM oven/bun:${BUN_VERSION}-distroless
WORKDIR /app
COPY fritz-whyblocked.js fritz-whyblocked.js.map ./
USER 65532:65532
ENV DATA_DIR=/data
EXPOSE 8053
ENTRYPOINT ["bun", "/app/fritz-whyblocked.js"]
