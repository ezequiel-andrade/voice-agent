FROM node:20-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json ./
RUN npm install
COPY sip-server.js ./
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3001/health | grep -q '"status":"ok"' || exit 1
CMD ["node", "sip-server.js"]
