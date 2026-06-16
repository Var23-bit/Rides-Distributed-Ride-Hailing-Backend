FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY init.sql ./
COPY run_init.js ./

EXPOSE 3000

CMD ["npm", "start"]
