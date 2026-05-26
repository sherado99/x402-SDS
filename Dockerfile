# Menggunakan image resmi Apify untuk Node.js versi 20
FROM apify/actor-node:20

# Menyalin package.json
COPY package*.json ./

# Menginstall dependensi (hanya production)
RUN npm --quiet set progress=false \
    && npm install --omit=dev --omit=optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version

# Menyalin seluruh kode sumber ke dalam container
COPY . ./

# Menjalankan script start dari package.json
CMD npm start

