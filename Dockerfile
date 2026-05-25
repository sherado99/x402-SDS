FROM apify/actor-node-puppeteer-chrome:latest

# Hapus main.js default
RUN rm -f /home/apify/main.js

# Salin seluruh file proyek kita
COPY package.json /home/apify/
COPY main.js /home/apify/
COPY *.json /home/apify/

# Install dependencies (termasuk puppeteer jika belum ada di image)
WORKDIR /home/apify
RUN npm install
