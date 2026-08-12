import http from 'node:http';

const drift = process.argv.includes('--drift');
const port = 4319;
const paths = {
  '/shipments': { get: { operationId: 'getShipments', summary: 'Get shipments', responses: { 200: { content: { 'application/json': { schema: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' } } } } } } } } } },
  '/delivery-options': { get: { operationId: 'getDeliveryOptions', summary: 'Get delivery options', responses: { 200: { content: { 'application/json': { schema: { type: 'array', items: { type: 'string' } } } } } } } },
  [drift ? '/delivery/change' : '/delivery/{id}']: {
    [drift ? 'post' : 'patch']: {
      operationId: 'rescheduleDelivery', summary: 'Reschedule delivery',
      parameters: drift ? [] : [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['date'], properties: { date: { type: 'string', minLength: 10, maxLength: 10 } }, additionalProperties: false } } } },
      responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' } } } } } } },
    },
  },
};
const openapi = { openapi: '3.0.3', info: { title: 'IRIS Foundry Shipping Fixture', version: drift ? '0.2.0' : '0.1.0' }, paths };

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  response.end(body);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url || '/', `http://localhost:${port}`);
  if (url.pathname === '/openapi.json') return json(response, 200, openapi);
  if (request.method === 'GET' && url.pathname === '/shipments') return json(response, 200, [{ id: 'shipment-1', status: 'in_transit' }]);
  if (request.method === 'GET' && url.pathname === '/delivery-options') return json(response, 200, ['2030-01-01', '2030-01-02']);
  if ((request.method === 'PATCH' && /^\/delivery\/[^/]+$/.test(url.pathname)) || (drift && request.method === 'POST' && url.pathname === '/delivery/change')) return json(response, 200, { ok: true });
  return json(response, 404, { error: 'not_found' });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`IRIS Foundry fixture listening at http://localhost:${port} (${drift ? 'drift' : 'stable'})`);
});

