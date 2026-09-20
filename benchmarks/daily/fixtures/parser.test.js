const { parsePair } = require("./parser.js");

const result = parsePair("left:right");
if (result.left !== "left" || result.right !== "right") throw new Error("parser fixture failed");
console.log("parser fixture passed");
