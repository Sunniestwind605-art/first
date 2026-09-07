const jwt = require('jsonwebtoken');

function verifyToken(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing authorization token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (_) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}
function requireCustomer(req, res, next) {
  if (req.user?.type !== 'customer') return res.status(403).json({ error: 'Customer account required' });
  next();
}
function requireStaff(...roles) {
  return (req, res, next) => {
    if (req.user?.type !== 'staff') return res.status(403).json({ error: 'Staff account required' });
    if (roles.length && !roles.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient staff permissions' });
    next();
  };
}
module.exports = { verifyToken, requireCustomer, requireStaff };
