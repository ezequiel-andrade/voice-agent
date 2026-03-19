FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY setup-vad.js ./
RUN npm install
COPY server.js ./
COPY index.html ./
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/ > /dev/null || exit 1
CMD ["node", "server.js"]
