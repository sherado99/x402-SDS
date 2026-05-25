FROM apify/actor-node-puppeteer-chrome:latest
RUN rm -f /home/apify/main.js
COPY main.js /home/apify/main.js
