FROM node:22-alpine

ARG VERSION=dev
ENV APP_VERSION=${VERSION}

WORKDIR /app

COPY index.js .

# index.js uses only built-in Node modules – no npm install needed.

LABEL org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.title="Chrome Tabs to Pinboard" \
      org.opencontainers.image.description="Automatically bookmark Chrome tabs to Pinboard with AI-generated tags" \
      org.opencontainers.image.source="https://github.com/slmingol/chrome-tabs-to-pinboard"

ENTRYPOINT ["node", "index.js"]
