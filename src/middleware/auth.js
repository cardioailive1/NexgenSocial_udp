const jwt = require("jsonwebtoken");

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Sign in required." });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ error: "Your session expired. Sign in again." });
  }
}

// Attaches req.userId if a valid token is present, but doesn't block the request.
function optionalAuth(req, _res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token) {
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      req.userId = payload.sub;
    } catch {
      // ignore invalid token for optional routes
    }
  }
  next();
}

function requirePremium(req, res, next) {
  req.tierChecked = true;
  next(); // real check happens in the route after loading the user; see routes/premium.js
}

module.exports = { requireAuth, optionalAuth, requirePremium };
