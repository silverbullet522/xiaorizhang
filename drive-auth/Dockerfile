FROM node:24-bookworm-slim
WORKDIR /app
COPY cloud-run.mjs service.mjs firestore.mjs ./
USER node
CMD ["node", "cloud-run.mjs"]
