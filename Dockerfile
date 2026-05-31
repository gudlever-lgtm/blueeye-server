# BlueEye server — on-prem API + agent WebSocket.
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

# docker-compose overrides this to run migrations (and the demo seed) first.
CMD ["node", "src/server.js"]
