FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 3000 4000
CMD ["node", "src/index.js"]
