FROM node:latest
WORKDIR /app

COPY package.json package-lock.json ./
COPY tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npm run build

ENV NODE_ENV=production

USER node

CMD ["node", "dist/src/main.js"]