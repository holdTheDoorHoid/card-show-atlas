// Dev server only: while there is no real data in public/data, serve the made-up sample data from
// fixtures/data under /data/. Nothing is copied into public/, so a production build can never pick
// sample data up by accident.
import fs from 'node:fs';
import path from 'node:path';

const TYPES = { '.json': 'application/json; charset=utf-8' };

export function fixtureDataPlugin(prefix) {
  return {
    name: 'csa-dev-fixtures',
    apply: 'serve',
    configureServer(server) {
      const root = process.cwd();
      const fixturesDir = path.join(root, 'fixtures', 'data');
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        const rel = url.startsWith(prefix) ? url.slice(prefix.length) : url.startsWith('/data/') ? url.slice('/data/'.length) : null;
        if (rel === null) return next();
        if (fs.existsSync(path.join(root, 'public', 'data', 'shows.json'))) return next();
        const file = path.join(fixturesDir, decodeURIComponent(rel));
        if (!file.startsWith(fixturesDir + path.sep)) return next();
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }
        res.setHeader('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream');
        res.setHeader('cache-control', 'no-store');
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}
