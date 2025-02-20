FROM node:22-alpine AS build
ENV NODE_ENV production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY . ./
RUN npx tsc

FROM node:22-alpine
ENV NODE_ENV production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist/
ENTRYPOINT ["node", "/app/dist/controller.js"]
