const ORDER_ROLES = new Set(['admin', 'agent', 'user']);
const ORDER_TEST_USERNAMES = new Set(['CNTORO']);

function canAccessOrderManagement(user = {}) {
  const role = String(user.role || '').trim().toLowerCase();
  const username = String(user.username || '').trim().toUpperCase();
  return ORDER_ROLES.has(role) || ORDER_TEST_USERNAMES.has(username);
}

function canManageWarehouses(user = {}) {
  return String(user.role || '').trim().toLowerCase() === 'admin';
}

module.exports = { canAccessOrderManagement, canManageWarehouses };
