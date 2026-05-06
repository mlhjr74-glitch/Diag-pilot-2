// Owns: Polsia R2 proxy file uploads
// Does NOT own: database, routes

const crypto = require('crypto');

async function uploadToR2(buffer, originalname, mimetype) {
  const R2_BASE_URL = process.env.POLSIA_R2_BASE_URL || 'https://polsia.com';
  const POLSIA_API_KEY = process.env.POLSIA_API_KEY || '';

  const boundary = '----FormBoundary' + crypto.randomBytes(8).toString('hex');
  const filename = `diagrams/${Date.now()}-${originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const CRLF = '\r\n';
  const preamble = Buffer.from(
    `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}` +
    `Content-Type: ${mimetype}${CRLF}${CRLF}`
  );
  const epilogue = Buffer.from(`${CRLF}--${boundary}--${CRLF}`);
  const body = Buffer.concat([preamble, buffer, epilogue]);

  const res = await fetch(`${R2_BASE_URL}/r2/upload`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${POLSIA_API_KEY}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length)
    },
    body
  });

  if (!res.ok) throw new Error(`R2 upload failed (${res.status}): ${await res.text().catch(() => 'unknown')}`);
  const result = await res.json();
  if (!result.url) throw new Error('R2 upload returned no URL: ' + JSON.stringify(result));
  return result.url;
}

module.exports = { uploadToR2 };
