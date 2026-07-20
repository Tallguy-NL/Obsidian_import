const crypto = require('crypto');

function generateGuid() {
  return crypto.randomUUID();
}

module.exports = { generateGuid };
