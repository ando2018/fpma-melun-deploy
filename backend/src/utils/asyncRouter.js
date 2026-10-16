const express = require('express');

// Router Express dont les gestionnaires peuvent être « async » : une erreur levée (base
// injoignable…) est transmise au gestionnaire d'erreurs au lieu de faire planter le serveur
// ou de laisser la requête sans réponse.
function wrap(handler) {
  if (typeof handler !== 'function' || handler.length === 4) return handler;
  return (req, res, next) => {
    try {
      const result = handler(req, res, next);
      if (result && typeof result.then === 'function') result.catch(next);
    } catch (err) {
      next(err);
    }
  };
}

function asyncRouter() {
  const router = express.Router();
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'use', 'all']) {
    const original = router[method].bind(router);
    router[method] = (...args) => original(...args.map(wrap));
  }
  return router;
}

module.exports = asyncRouter;
