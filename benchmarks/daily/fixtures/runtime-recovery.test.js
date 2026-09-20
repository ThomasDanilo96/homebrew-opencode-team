const { recover } = require("./runtime-recovery.js");

if (recover("stale") !== "recovered") throw new Error("recovery fixture failed");
