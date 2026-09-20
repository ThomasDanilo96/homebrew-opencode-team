const store = require("./store.js");
const { read } = require("./api.js");

store.put("answer", 42);
if (read("answer") !== 42) throw new Error("multi-module fixture failed");
