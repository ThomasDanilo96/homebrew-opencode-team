function parsePair(value) {
  const [left, right] = value.split(":");
  return { left, right };
}

module.exports = { parsePair };
