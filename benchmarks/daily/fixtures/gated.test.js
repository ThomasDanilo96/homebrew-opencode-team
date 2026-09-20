const { classify } = require("./gated.js");

if (classify(1) !== "positive" || classify(0) !== "non-positive") throw new Error("gated fixture failed");
