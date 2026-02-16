import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "deniznegro-omgithastobe-verysecure";

export function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing token" });
  }
  const token = auth.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // { id, role, email }
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: "Forbidden: Insufficient permissions" });
    }
    next();
  };
}
