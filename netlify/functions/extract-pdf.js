/* Detect MIME type from URL extension (when caller didn't pass mediaType
   explicitly). Day Sheet uploads land here as last-page screenshots
   (image/png|jpeg|heic) or as full PDFs — both must reach Claude with the
   right content-block type. */
function sniffMediaType(url) {
  const u = String(url || '').toLowerCase().split('?')[0];
  if (u.endsWith('.png'))                   return 'image/png';
  if (u.endsWith('.jpg') || u.endsWith('.jpeg')) return 'image/jpeg';
  if (u.endsWith('.heic') || u.endsWith('.heif')) return 'image/heic';
  if (u.endsWith('.gif'))                   return 'image/gif';
  if (u.endsWith('.webp'))                  return 'image/webp';
  return 'application/pdf';
}

/* Build the right Anthropic content block for the media type — image inputs
   use the 'image' source shape; PDFs use 'document'. Surfaced as a helper so
   the test runner can assert the routing rule without invoking the network. */
function buildContentBlock(mediaType, b64) {
  if (mediaType && mediaType.startsWith('image/')) {
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } };
  }
  return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
}

exports.sniffMediaType = sniffMediaType;
exports.buildContentBlock = buildContentBlock;

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const KEY = process.env.ANTHROPIC_KEY;
  if (!KEY) return { statusCode: 500, body: JSON.stringify({ error: 'No API key' }) };
  let body;
  try { body = JSON.parse(event.body); } catch { return { statusCode: 400, body: 'Bad JSON' }; }
  const { pdfUrl, prompt, mediaType: mediaTypeIn } = body;
  if (!pdfUrl || !prompt) return { statusCode: 400, body: JSON.stringify({ error: 'pdfUrl and prompt required' }) };
  const pdfResp = await fetch(pdfUrl);
  if (!pdfResp.ok) return { statusCode: 500, body: JSON.stringify({ error: 'PDF fetch failed: ' + pdfResp.status }) };
  const b64 = Buffer.from(await pdfResp.arrayBuffer()).toString('base64');
  const mediaType = mediaTypeIn || sniffMediaType(pdfUrl);
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{ role: 'user', content: [
        buildContentBlock(mediaType, b64),
        { type: 'text', text: prompt }
      ]}]
    })
  });
  const data = await resp.json();
  if (data.error) return { statusCode: 500, body: JSON.stringify({ error: data.error.message }) };
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify({ text: data.content?.[0]?.text || '' })
  };
};
