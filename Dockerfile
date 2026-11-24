FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
RUN mkdir -p data && chown node:node data
USER node
EXPOSE 3000
CMD ["node", "--no-warnings", "src/server.js"]
