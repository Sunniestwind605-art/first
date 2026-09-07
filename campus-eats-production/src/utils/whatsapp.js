const { pool } = require('../config/db');

function normalizePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('27') && digits.length === 11) return digits;
  if (digits.startsWith('0') && digits.length === 10) return `27${digits.slice(1)}`;
  return digits;
}

function configured() {
  return Boolean(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

async function logNotification({ to, templateName, payload, status, providerMessageId = null, error = null }) {
  try {
    await pool.query(`INSERT INTO whatsapp_notifications(recipient_phone,template_name,payload_json,status,provider_message_id,error_message)
      VALUES($1,$2,$3::jsonb,$4,$5,$6)`, [normalizePhone(to), templateName, JSON.stringify(payload || {}), status, providerMessageId, error]);
  } catch (e) {
    console.error('[whatsapp] failed to persist notification log', e.message);
  }
}

async function sendTemplate(to, templateName, bodyParams = [], options = {}) {
  const phone = normalizePhone(to);
  if (!phone || !templateName) return { ok: false, skipped: true, reason: 'missing recipient/template' };

  const payload = {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: options.languageCode || process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en' },
      components: [{
        type: 'body',
        parameters: bodyParams.map(v => ({ type: 'text', text: String(v) }))
      }]
    }
  };

  if ((process.env.WHATSAPP_MOCK || '').toLowerCase() === 'true' || !configured()) {
    console.log(`[WHATSAPP ${configured() ? 'MOCK' : 'UNCONFIGURED'}] -> ${phone} template=${templateName}`, bodyParams);
    await logNotification({ to: phone, templateName, payload, status: configured() ? 'mocked' : 'skipped', error: configured() ? null : 'WhatsApp provider not configured' });
    return { ok: configured(), mock: true, skipped: !configured() };
  }

  const graphVersion = process.env.WHATSAPP_GRAPH_VERSION || 'v23.0';
  const url = `https://graph.facebook.com/${graphVersion}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.error?.message || `WhatsApp API ${response.status}`;
      await logNotification({ to: phone, templateName, payload, status: 'failed', error: message });
      throw new Error(message);
    }
    const id = data?.messages?.[0]?.id || null;
    await logNotification({ to: phone, templateName, payload, status: 'sent', providerMessageId: id });
    return { ok: true, id, data };
  } catch (error) {
    console.error('[whatsapp] send failed', error.message);
    throw error;
  }
}

module.exports = { normalizePhone, sendTemplate, configured };
