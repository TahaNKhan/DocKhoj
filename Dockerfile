FROM node:22-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (including dev for build)
RUN npm install

# Copy source
COPY tsconfig.json ./
COPY src ./src
COPY public ./public

# Build TypeScript
RUN npm run build

# Prune dev dependencies after build
RUN npm prune --production

# Production startup
CMD ["node", "dist/index.js"]

EXPOSE 3000
