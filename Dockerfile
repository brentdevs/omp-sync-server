FROM oven/bun:1.4.2

WORKDIR /app
RUN mkdir -p /data && chown bun:bun /data
COPY --chown=bun:bun src ./src

ENV NODE_ENV=production \
    OMP_SYNC_DATA_DIR=/data \
    OMP_SYNC_HOST=0.0.0.0 \
    OMP_SYNC_PORT=8787
USER bun
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["bun", "-e", "const r = await fetch('http://127.0.0.1:' + (process.env.OMP_SYNC_PORT || '8787') + '/healthz', {signal: AbortSignal.timeout(2000)}); process.exit(r.ok ? 0 : 1)"]
ENTRYPOINT ["bun", "/app/src/main.ts"]
CMD ["serve"]
