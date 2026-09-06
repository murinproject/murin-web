"use strict";

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const http = require("http");
const app = require("./src/app");
const socket = require("./src/socket");

const port = Number(process.env.HTTP_PORT) || 3003;
const server = http.createServer(app);

socket.init(server);

server.listen(port, () => {
  console.log(`Robot server running at http://localhost:${port}/`);
});
