# The ldes-client CLI in a container.
#
#   docker build -t ldes-client .
#   docker run --rm -v ldes-state:/data ldes-client https://example.org/ldes --follow --save /data/state
#
# The image is built from the sources with the lockfile of npm (package-lock.json), the same way as in CI.
# The Debian based image has everything the native dependencies (classic-level) need, so no compiler is installed.
ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-slim AS build
WORKDIR /usr/src/app
# No git hooks in an image
ENV HUSKY=0

# The dependencies first: this layer is cached as long as the lockfile does not change
COPY package.json package-lock.json ./
RUN npm ci

# What `npm run build` needs: the sources, and the configuration of tsc and rollup
# (tsconfig.json also includes tests/helper.ts)
COPY tsconfig.json rollup.config.mjs ./
COPY lib ./lib
COPY bin ./bin
COPY tests/helper.ts ./tests/helper.ts
RUN npm run build

# Only what the CLI needs to run
RUN npm prune --omit=dev

FROM node:${NODE_VERSION}-slim AS release
ENV NODE_ENV=production
WORKDIR /usr/src/app
# package.json is needed too: it says that the code is an ES module
COPY --from=build --chown=node:node /usr/src/app/package.json ./
COPY --from=build --chown=node:node /usr/src/app/node_modules ./node_modules
COPY --from=build --chown=node:node /usr/src/app/dist ./dist

# The client keeps its state (--save) in the working directory, which the user of the image can mount
RUN mkdir /data && chown node:node /data
WORKDIR /data
VOLUME /data
USER node

ENTRYPOINT ["node", "/usr/src/app/dist/bin/cli.js"]
CMD ["--help"]
