FROM apify/actor-node:24 AS builder

COPY --chown=myuser:myuser package*.json ./

RUN npm ci --include=dev

COPY --chown=myuser:myuser . ./

RUN npm run build

FROM apify/actor-node:24

COPY --chown=myuser:myuser package*.json ./

RUN npm --quiet set progress=false \
    && npm ci --omit=dev --omit=optional \
    && echo "Node.js version:" \
    && node --version \
    && rm -r ~/.npm

COPY --from=builder --chown=myuser:myuser /usr/src/app/dist ./dist

COPY --chown=myuser:myuser . ./

CMD ["node", "dist/global-corporate-patent-intelligence/main.js"]
