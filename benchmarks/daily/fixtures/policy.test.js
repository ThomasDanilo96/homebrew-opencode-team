const { canWrite } = require("./policy.js");

if (!canWrite("admin") || canWrite("guest")) throw new Error("policy fixture failed");
