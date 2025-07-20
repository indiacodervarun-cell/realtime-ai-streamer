# Use the official Node.js 20 image as the base
FROM node:20-slim

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if exists) to the working directory
# This step is done separately to leverage Docker's layer caching
COPY package*.json ./

# Install application dependencies
# Use --production to only install dependencies listed in "dependencies"
RUN npm install --production

# Copy the service account key file into the container
COPY serviceAccountKey.json ./

# Copy the rest of your application's source code to the working directory
COPY . .

# Expose the port that the application listens on.
# Cloud Run services typically listen on port 8080 by default.
ENV PORT 8080
EXPOSE 8080

# Define the command to run your application
# This command will be executed when the container starts
CMD [ "npm", "start" ]
