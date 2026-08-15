FROM node:22-bookworm-slim
WORKDIR /app
COPY server.mjs /app/server.mjs
ENV PORT=8788 SLSKD_URL=http://slskd:5030 DOWNLOAD_DIR=/downloads
EXPOSE 8788
CMD ["node", "/app/server.mjs"]
