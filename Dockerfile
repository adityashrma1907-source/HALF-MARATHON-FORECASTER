FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY index.html ./
COPY style.css ./
COPY app.js ./

ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
