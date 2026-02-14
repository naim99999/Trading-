FROM node:18-slim

# প্রোজেক্ট ডিরেক্টরি তৈরি
WORKDIR /app

# ফাইলগুলো কপি করা
COPY package.json ./
RUN npm install --production

# বাকি সব কোড কপি করা
COPY . .

# পোর্ট এক্সপোজ করা (আপনার কোডে ৮০৮০ দেওয়া আছে)
EXPOSE 8080

# বট রান করার কমান্ড
CMD ["node", "index.js"]
