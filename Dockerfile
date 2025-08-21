FROM node:latest

WORKDIR /app
COPY ./src ./src
COPY package.json ./
COPY package-lock.json ./
COPY tsconfig.json ./

RUN npm install
RUN npm run build

ENV RPC_URL=https://rpc.aboutcircles.com/
ENV BLACKLISTING_SERVICE_URL=https://squid-app-3gxnl.ondigitalocean.app/aboutcircles-advanced-analytics2/bot-analytics/classify
ENV BACKERS_GROUP_ADDRESS=0x1ACA75e38263c79d9D4F10dF0635cc6FCfe6F026
ENV BACKING_FACTORY_ADDRESS=0xeced91232c609a42f6016860e8223b8aecaa7bd0
ENV START_AT_BLOCK=39743285
ENV EXPECTED_SECONDS_TILL_COMPLETION=60
ENV VERBOSE_LOGGING=""
ENV CONFIRMATION_BLOCKS=2
ENV ERRORS_BEFORE_CRASH=3
ENV SLACK_WEBHOOK_URL=""
ENV SERVICE_PRIVATE_KEY=""

CMD ["node", "dist/src/main.js"]