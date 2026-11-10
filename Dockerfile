# Build the web app
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Runtime: the server runs its TypeScript directly (Node 24 strips types)
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
RUN mkdir data && chown node:node data
USER node
VOLUME /app/data
EXPOSE 8787
CMD ["node", "server/index.ts"]
