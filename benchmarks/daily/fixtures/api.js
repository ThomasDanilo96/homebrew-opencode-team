const store = require("./store.js");

function read(key) {
  return store.get(key);
}

module.exports = { read };
