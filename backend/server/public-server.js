/**
 * The only part of the register that is meant to be reachable from the internet.
 *
 * A parent's phone cannot reach the dashboard API (and must not: it lists every
 * student). So the approval pages live on their own port with their own tiny
 * app: nothing here can read the roster, the log, or any other pass without
 * that pass's private token. Point the tunnel (see README) at this port, never
 * at the dashboard's port.
 */

const outpass = require('./outpass');
const pages = require('./approval-page');
const mailer = require('./mailer');

const HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function sendHtml(res, status, html) {
  res.status(status);
  res.set(HEADERS);
  res.send(html);
}

const str = (v) => (typeof v === 'string' ? v : '');

/** Pick the page for a lookup/respond outcome. */
function render(result, { id, token, choice, cfg }) {
  switch (result.state) {
    case 'pending':
      return [200, pages.confirmPage({ pass: result.outpass, id, token, choice, cfg })];
    case 'done':
      return [200, pages.resultPage({ pass: result.outpass, decision: result.decision, cfg, justNow: true })];
    case 'decided':
      return [200, pages.resultPage({ pass: result.outpass, decision: result.decision, cfg, justNow: false })];
    case 'closed':
      return [200, pages.messagePage({
        title: 'No longer open',
        text: 'This outpass was already closed by the PG, so there is nothing to approve.',
        cfg,
      })];
    case 'expired':
      return [410, pages.messagePage({
        title: 'This link has expired',
        text: 'Please contact the PG office to have a new request sent.',
        cfg,
      })];
    case 'invalid_choice':
      return [400, pages.messagePage({ title: 'Something went wrong', text: 'Please open the link in your email again.', cfg })];
    default:
      // Wrong id and wrong token look identical, on purpose.
      return [404, pages.messagePage({ title: 'Link not valid', text: 'This link is not valid. Please use the buttons in the most recent email.', cfg })];
  }
}

function createPublicApp(express) {
  const app = express();
  if (typeof app.disable === 'function') app.disable('x-powered-by');

  const form = express.urlencoded({ extended: false, limit: '4kb' });
  app.use((req, res, next) => (req.path === '/outpass/respond' ? form(req, res, next) : next()));

  // GET only looks. Mail scanners open links; a GET that changed anything
  // would approve or decline before the parent had read the email.
  app.get('/outpass/respond', (req, res) => {
    const id = str(req.query.id);
    const token = str(req.query.t);
    const choice = str(req.query.choice);
    const cfg = mailer.config();
    const [status, html] = render(outpass.lookup(id, token), { id, token, choice, cfg });
    sendHtml(res, status, html);
  });

  app.post('/outpass/respond', (req, res) => {
    const b = req.body || {};
    const id = str(b.id);
    const token = str(b.t);
    const choice = str(b.choice);
    const cfg = mailer.config();
    const result = outpass.respond(id, token, choice, str(b.comment));
    if (result.state === 'done') console.log(`[approval] ${id} ${result.decision} by parent`);
    const [status, html] = render(result, { id, token, choice, cfg });
    sendHtml(res, status, html);
  });

  app.use((req, res) => {
    sendHtml(res, 404, pages.messagePage({ title: 'Not found', text: 'There is nothing at this address.', cfg: mailer.config() }));
  });

  return app;
}

module.exports = { createPublicApp };
