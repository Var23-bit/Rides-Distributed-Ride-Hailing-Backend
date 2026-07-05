FROM node:18-alpine
WORKDIR /app
COPY shared /shared
WORKDIR /app/service
COPY services/fare-service/package*.json ./
RUN npm install --prefix /shared && npm install

# Copy service source
COPY services/fare-service/ ./

EXPOSE 3003

CMD ["npm", "start"]