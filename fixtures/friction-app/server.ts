import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Mutation } from './scenarios.ts';

interface Submission {
  name: string;
  arrival: string;
  notes: string;
  company?: string;
}

export interface FixtureServer {
  url: string;
  submissions(scope: string): Submission[];
  close(): Promise<void>;
}

const escape = (value: string): string => value.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);

const ARRIVAL_TIMES = ['Before noon', 'Afternoon', 'Evening', 'After midnight'];

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
  body { font: 18px/1.5 system-ui, sans-serif; margin: 0; padding: 16px; color: #1d1d1f; background: #fafafa; }
  a, button { font: inherit; }
  nav a, .primary { display: inline-block; margin: 8px 0; padding: 12px 18px; border-radius: 8px; background: #0b57d0; color: #fff; text-decoration: none; border: 0; }
  label { display: block; margin-top: 12px; }
  input, select, textarea { font: inherit; width: 100%; max-width: 420px; box-sizing: border-box; padding: 8px; }
  .error { color: #b3261e; font-weight: 600; }
  .panel { background: #eee; padding: 12px; margin: 12px 0; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

async function readForm(request: IncomingMessage): Promise<URLSearchParams> {
  let body = '';
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 65_536) throw new Error('form too large');
  }
  return new URLSearchParams(body);
}

export async function startFixture(
  options: { mutations?: readonly Mutation[]; host?: string } = {},
): Promise<FixtureServer> {
  const mutations = new Set(options.mutations ?? []);
  const store = new Map<string, Submission[]>();

  const requestForm = (scope: string, values: Partial<Submission>, errors: string[]): string => {
    const choices = ARRIVAL_TIMES.map(
      (time) => `<option${values.arrival === time ? ' selected' : ''}>${escape(time)}</option>`,
    ).join('');
    const filler = mutations.has('hidden_primary')
      ? `<section class="panel" style="height: 1800px"><h2>Our sustainability story</h2><p>Since opening, we have replaced every light bulb with an efficient model and introduced linen reuse.</p></section>`
      : '';
    const company = mutations.has('extra_field')
      ? `<label for="company">Company (required)</label><input id="company" name="company" value="${escape(values.company ?? '')}">`
      : '';
    return page(
      'Request early check-in',
      `<h1>Request early check-in</h1>
${errors.map((error) => `<p class="error" role="alert">${escape(error)}</p>`).join('')}
<form method="post" action="/review?scope=${encodeURIComponent(scope)}">
<label for="name">Your name</label><input id="name" name="name" value="${escape(values.name ?? '')}">
<label for="arrival">Arrival time</label><select id="arrival" name="arrival"><option value="">Choose…</option>${choices}</select>
${company}
<label for="notes">Notes</label><textarea id="notes" name="notes" rows="2">${escape(values.notes ?? '')}</textarea>
${filler}
<p><button class="primary" type="submit">Review request</button></p>
</form>`,
    );
  };

  const routes = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', 'http://fixture.invalid');
    const scope = url.searchParams.get('scope') ?? 'default';
    const q = `?scope=${encodeURIComponent(scope)}`;
    const send = (html: string, status = 200): void => {
      response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(html);
    };
    const key = `${request.method} ${url.pathname}`;
    switch (key) {
      case 'GET /': {
        const arrival = mutations.has('confusing_label') ? 'Orientation module' : 'Arrival instructions';
        const contact = mutations.has('icon_only')
          ? `<a href="/contact${q}" aria-label="Contact host" style="font-size: 28px; text-decoration: none">✉</a>`
          : `<a href="/contact${q}">Contact host</a>`;
        return send(
          page(
            'Lakeside Apartment',
            `<h1>Welcome to Lakeside Apartment</h1><p>Your stay starts soon.</p><nav><a href="/arrival${q}">${arrival}</a></nav><p>${contact}</p>`,
          ),
        );
      }
      case 'GET /arrival':
        return send(
          page(
            'Arrival',
            `<h1>Arrival</h1><p>Check-in is from 15:00. The key box is left of the front door.</p><p><a class="primary" href="/request${q}">Request early check-in</a></p>`,
          ),
        );
      case 'GET /request':
        return send(requestForm(scope, {}, []));
      case 'POST /review': {
        const form = await readForm(request);
        const values: Submission = {
          name: form.get('name')?.trim() ?? '',
          arrival: form.get('arrival') ?? '',
          notes: form.get('notes') ?? '',
          ...(mutations.has('extra_field') ? { company: form.get('company')?.trim() ?? '' } : {}),
        };
        const errors = [
          ...(values.name ? [] : ['Please enter your name.']),
          ...(ARRIVAL_TIMES.includes(values.arrival) ? [] : ['Please choose an arrival time.']),
          ...(values.company === '' ? ['Please enter your company.'] : []),
        ];
        if (errors.length > 0) return send(requestForm(scope, values, errors));
        const hidden = Object.entries(values)
          .map(([name, value]) => `<input type="hidden" name="${name}" value="${escape(String(value))}">`)
          .join('');
        return send(
          page(
            'Review request',
            `<h1>Review your request</h1><dl><dt>Name</dt><dd>${escape(values.name)}</dd><dt>Arrival time</dt><dd>${escape(values.arrival)}</dd></dl>
<form method="post" action="/submit${q}">${hidden}<button class="primary" type="submit">Send request</button></form>`,
          ),
        );
      }
      case 'POST /submit': {
        const form = await readForm(request);
        const submission: Submission = {
          name: form.get('name') ?? '',
          arrival: form.get('arrival') ?? '',
          notes: form.get('notes') ?? '',
          ...(form.has('company') ? { company: form.get('company') ?? '' } : {}),
        };
        store.set(scope, [...(store.get(scope) ?? []), submission]);
        response.writeHead(303, { location: `/confirmation${q}` });
        return void response.end();
      }
      case 'GET /confirmation':
        return send(page('Request sent', `<h1>Request sent</h1><p>Your host will reply soon.</p>`));
      case 'GET /contact':
        return send(page('Contact host', `<h1>Contact host</h1><p>Call +000 000 000 between 9:00 and 18:00.</p>`));
      case 'GET /lab/targets': {
        const cross = url.searchParams.get('cross');
        return send(
          page(
            'Target lab',
            `<output id="log"></output>
<div id="shadow-host"></div>
<iframe id="same" title="Same-origin frame" src="/lab/frame" style="width: 300px; height: 120px; border: 4px solid #333; padding: 6px"></iframe>
<closed-widget id="closed" style="display: block; width: 200px; height: 40px"></closed-widget>
<canvas id="canvas" width="200" height="40" style="display: block"></canvas>
<div style="transform: scale(0.8); transform-origin: 0 0"><iframe id="scaled" title="Scaled frame" src="/lab/frame" style="width: 300px; height: 120px"></iframe></div>
${cross ? `<iframe id="cross" title="Cross-origin frame" src="${escape(cross)}" style="width: 300px; height: 120px"></iframe>` : ''}
<script>
  const log = (text) => { (window.top.document.getElementById('log') || document.getElementById('log')).textContent = text; };
  const outer = document.getElementById('shadow-host').attachShadow({ mode: 'open' });
  outer.innerHTML = '<div><inner-card></inner-card></div>';
  const inner = outer.querySelector('inner-card').attachShadow({ mode: 'open' });
  inner.innerHTML = '<button>Shadow action</button>';
  inner.querySelector('button').addEventListener('click', () => log('clicked: shadow'));
  const closed = document.getElementById('closed').attachShadow({ mode: 'closed' });
  closed.innerHTML = '<button style="width: 200px; height: 40px">Closed action</button>';
  const ctx = document.getElementById('canvas').getContext('2d');
  ctx.fillStyle = '#0b57d0'; ctx.fillRect(0, 0, 200, 40);
</script>`,
          ),
        );
      }
      case 'GET /lab/frame':
        return send(
          page(
            'Framed',
            `<output id="log"></output><button id="framed" onclick="document.getElementById('log').textContent='clicked: framed'">Framed action</button><div id="frame-host"></div>
<script>
  const root = document.getElementById('frame-host').attachShadow({ mode: 'open' });
  root.innerHTML = '<button>Framed shadow action</button>';
  root.querySelector('button').addEventListener('click', () => { document.getElementById('log').textContent = 'clicked: framed shadow'; });
</script>`,
          ).replace('padding: 16px', 'padding: 4px'),
        );
      case 'GET /lab/native':
        return send(
          page(
            'Native controls',
            `<output id="log"></output>
<label for="time">Arrival time</label><select id="time" onchange="document.getElementById('log').textContent='selected: '+this.value"><option value="">Choose…</option>${ARRIVAL_TIMES.map((time) => `<option>${time}</option>`).join('')}</select>
<p><button onclick="alert('Alert text'); document.getElementById('log').textContent='alert closed'">Show alert</button></p>
<label for="upload">Upload ID</label><input id="upload" type="file">`,
          ),
        );
      case 'GET /lab/canary':
        return send(
          page(
            'Canary',
            `<label for="email">Email</label><input id="email" type="email" oninput="document.getElementById('mirror').textContent='Signed in as '+this.value">
<p id="mirror">Not signed in</p>
<label for="otp">One-time code</label><input id="otp" inputmode="numeric" autocomplete="one-time-code">
<p>Token: <span id="echo"></span></p>
<p id="split"><span id="split-a"></span><span id="split-b"></span></p>
<label for="reference">Reference</label><input id="reference">
<div id="shadow-echo"></div>
<iframe id="frame-echo" title="Echo frame" style="height: 60px" srcdoc="<p id='t' style='margin:0'></p><script>document.getElementById('t').textContent = decodeURIComponent(parent.location.hash.slice(1));</script>"></iframe>
<p><button id="continue"></button></p>
<p>Nothing secret here.</p>
<script>
  const token = decodeURIComponent(location.hash.slice(1));
  document.getElementById('echo').textContent = token;
  document.getElementById('split-a').textContent = token.slice(0, 4);
  document.getElementById('split-b').textContent = token.slice(4);
  document.getElementById('reference').placeholder = token;
  document.getElementById('shadow-echo').attachShadow({ mode: 'open' }).innerHTML = '<b></b>';
  document.getElementById('shadow-echo').shadowRoot.querySelector('b').textContent = token;
  document.getElementById('continue').textContent = 'Continue as ' + token;
</script>`,
          ),
        );
      default:
        return send(page('Not found', '<h1>Not found</h1>'), 404);
    }
  };

  const server = createServer((request, response) => {
    routes(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(400);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, options.host ?? '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${options.host ?? '127.0.0.1'}:${port}`,
    submissions: (scope) => store.get(scope) ?? [],
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
