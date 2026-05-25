FROM apify/actor-node-puppeteer-chrome:latest

# Switch to root to fix permission issues
USER root

# Remove default files and any existing node_modules to avoid conflicts
RUN rm -f /home/apify/main.js \
    && rm -rf /home/apify/node_modules \
    && rm -f /home/apify/package-lock.json

# Copy our project files
COPY package.json /home/apify/
COPY main.js /home/apify/
COPY *.json /home/apify/

WORKDIR /home/apify

# Install dependencies fresh
RUN npm install

# Switch back to the default non-root user for security
USER myuser
