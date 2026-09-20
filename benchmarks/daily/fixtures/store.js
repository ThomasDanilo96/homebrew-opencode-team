const values = new Map();

function put(key, value) {
  values.set(key, value);
}

function get(key) {
  return values.get(key);
}

module.exports = { put, get };
