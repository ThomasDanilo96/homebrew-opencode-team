const { left, right } = require("./refactor.js");

if (left("a") !== "[a]" || right("b") !== "[b]") throw new Error("refactor fixture failed");
