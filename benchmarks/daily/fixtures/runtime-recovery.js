function recover(state) {
  return state === "stale" ? "recovered" : state;
}

module.exports = { recover };
