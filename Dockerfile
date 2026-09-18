# The remote MCP endpoint (https://mcp.arcnautical.com/mcp). Built by the
# main repo's docker-compose `mcp` service from this directory; see src/http.ts.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3005
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3005
CMD ["node", "dist/serve.js"]
