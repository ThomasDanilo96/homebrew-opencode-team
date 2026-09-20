const { canTransition } = require("./state-machine.js");

if (!canTransition("idle", "running")) throw new Error("valid transition rejected");
if (canTransition("idle", "failed")) throw new Error("invalid transition accepted");
