FROM node:22-alpine

WORKDIR /app

COPY index.js .

# index.js uses only built-in Node modules – no npm install needed.

ENTRYPOINT ["node", "index.js"]
