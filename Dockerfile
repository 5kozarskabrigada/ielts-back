FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN chmod +x start.sh

EXPOSE 4000

CMD ["sh", "./start.sh"]
