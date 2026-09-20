const { add } = require("./calculator.js");

if (add(2, 3) !== 5) throw new Error("add failed");
console.log("calculator fixture passed");
