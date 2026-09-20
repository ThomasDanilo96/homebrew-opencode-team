const transitions = {
  idle: ["running"],
  running: ["idle", "failed"],
  failed: ["idle"],
};

function canTransition(from, to) {
  return transitions[from]?.includes(to) ?? false;
}

module.exports = { canTransition };
