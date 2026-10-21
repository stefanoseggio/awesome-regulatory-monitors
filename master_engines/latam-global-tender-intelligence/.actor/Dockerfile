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

# The Cordoba portal sends only its leaf certificate. certs/ holds the two PUBLIC Sectigo CA certificates it omits
# (intermediate + root, no private key); NODE_EXTRA_CA_CERTS adds them to - never replaces - the trust store.
ENV NODE_EXTRA_CA_CERTS=/usr/src/app/latam-global-tender-intelligence/certs/cordoba-sectigo-chain.pem

CMD ["node", "dist/latam-global-tender-intelligence/main.js"]
