const { pool } = require('../config/db');

function configured(){
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

function esc(value=''){
  return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function logEmail(to, subject, status, providerMessageId=null, errorMessage=null){
  try{
    await pool.query(`INSERT INTO email_notifications(recipient_email,subject,status,provider_message_id,error_message)
      VALUES($1,$2,$3,$4,$5)`,[to,subject,status,providerMessageId,errorMessage]);
  }catch(e){ console.error('[email] log failed',e.message); }
}

async function sendEmail({to,subject,text,html}){
  if(!to) return {skipped:true};
  const mock=(process.env.EMAIL_MOCK||'false').toLowerCase()==='true';
  if(mock || !configured()){
    console.log(`[email ${mock?'mock':'not-configured'}] to=${to} subject=${subject}`);
    await logEmail(to,subject,mock?'mock':'not_configured');
    return {mock:true};
  }
  try{
    const r=await fetch('https://api.resend.com/emails',{
      method:'POST',
      headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json'},
      body:JSON.stringify({from:process.env.EMAIL_FROM,to:[to],subject,text,html})
    });
    const data=await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(data.message||`Email provider returned ${r.status}`);
    await logEmail(to,subject,'sent',data.id||null);
    return data;
  }catch(e){
    await logEmail(to,subject,'failed',null,e.message);
    console.error('[email] send failed',e.message);
    throw e;
  }
}

function brandedEmail(title,bodyHtml,cta){
  const button=cta?`<p style="margin:28px 0"><a href="${esc(cta.url)}" style="background:#A8412C;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700;display:inline-block">${esc(cta.label)}</a></p>`:'';
  return `<!doctype html><html><body style="margin:0;background:#EFE9DA;font-family:Arial,sans-serif;color:#2B2418"><div style="max-width:620px;margin:auto;padding:28px 18px"><div style="background:#1F3823;color:white;border-top:4px solid #C9A227;padding:18px 22px;font-size:22px;font-weight:700">Campus Eats</div><div style="background:white;padding:24px 22px"><h1 style="font-size:25px;margin-top:0">${esc(title)}</h1>${bodyHtml}${button}<p style="font-size:12px;color:#70695e;margin-top:28px">Campus Eats · Wits University · Thuma Mina</p></div></div></body></html>`;
}

module.exports={configured,sendEmail,brandedEmail,esc};
