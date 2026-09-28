FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=750

EXPOSE 8080

CMD ["npm", "start"]
