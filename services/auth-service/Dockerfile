FROM node:18-alpine

WORKDIR /app
COPY shared /shared

WORKDIR /app/service
COPY services/auth-service/package*.json ./
RUN npm install --prefix /shared && npm install

COPY services/auth-service/ ./

EXPOSE 3010

CMD ["npm", "start"]
