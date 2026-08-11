const express = require("express");
const path = require("path");
const app = require("./src/app");
const http = require("http");
const socket = require("./src/socket");

const server = http.createServer(app);
const publicStatic = express.static(path.join(__dirname, "public"));

const port = Number(process.env.HTTP_PORT) || 3003;

socket.init(server);

server.listen(port, () => {
    console.log(`Robot server running at http://localhost:${port}/`);
});