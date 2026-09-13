const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('../config/db');
const { verifyToken, requireStaff } = require('../middleware/auth');
const { normalizePhone } = require('../utils/whatsapp');
const { sendToOwner } = require('../utils/push');

const router = express.Router();
const SALT_ROUNDS = 12;
const RESET_TTL_MINUTES = 10;
const RESET_MAX_ATTEMPTS = 5;

function signToken(payload){ return jwt.sign(payload,process.env.JWT_SECRET,{expiresIn:process.env.JWT_EXPIRES_IN||'7d'}); }
function validEmail(v){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v||'')); }
function resetCodeHash(code){ return crypto.createHash('sha256').update(`${String(code)}:${process.env.JWT_SECRET}`).digest('hex'); }
function sameHash(a,b){
  try{
    const aa=Buffer.from(String(a),'hex'),bb=Buffer.from(String(b),'hex');
    return aa.length===bb.length&&crypto.timingSafeEqual(aa,bb);
  }catch{return false;}
}

router.post('/register', async(req,res)=>{
  try{
    const fullName=String(req.body.fullName||'').trim();
    const email=String(req.body.email||'').trim().toLowerCase();
    const phone=normalizePhone(req.body.phone);
    const password=String(req.body.password||'');
    if(!fullName||!validEmail(email)||!phone||!password) return res.status(400).json({error:'Full name, valid email, phone number and password are required'});
    if(password.length<8) return res.status(400).json({error:'Password must be at least 8 characters'});
    const exists=await pool.query('SELECT id FROM customers WHERE lower(email)=lower($1) OR phone=$2',[email,phone]);
    if(exists.rowCount) return res.status(409).json({error:'An account with this email or phone already exists'});
    const hash=await bcrypt.hash(password,SALT_ROUNDS);
    const r=await pool.query(`INSERT INTO customers(full_name,email,phone,password_hash)
      VALUES($1,$2,$3,$4) RETURNING id,full_name,email,phone,created_at`,[fullName,email,phone,hash]);
    const customer=r.rows[0];
    res.status(201).json({token:signToken({id:customer.id,type:'customer'}),customer});
  }catch(e){ console.error('register',e); res.status(500).json({error:'Registration failed'}); }
});

router.post('/login', async(req,res)=>{
  try{
    const password=String(req.body.password||'');
    const as=req.body.as==='staff'?'staff':'customer';
    const email=String(req.body.email||req.body.identifier||'').trim().toLowerCase();
    if(!validEmail(email)||!password) return res.status(400).json({error:'Email and password are required'});
    const table=as==='staff'?'staff':'customers';
    const r=await pool.query(`SELECT * FROM ${table} WHERE lower(email)=lower($1)`,[email]);
    const account=r.rows[0];
    const dummy='$2b$12$0gH67R9G1xRNc5g/1pWqUOzdQ18zlSBVPbkaBPqHFzOEQAS6YfdjC';
    const ok=await bcrypt.compare(password,account?account.password_hash:dummy);
    if(!account||!ok) return res.status(401).json({error:'Invalid email or password'});
    if(as==='staff'&&!account.is_active) return res.status(403).json({error:'Staff account is deactivated'});
    const payload=as==='staff'?{id:account.id,type:'staff',role:account.role}:{id:account.id,type:'customer'};
    delete account.password_hash; delete account.verification_code_hash;
    res.json({token:signToken(payload),[as]:account});
  }catch(e){ console.error('login',e); res.status(500).json({error:'Login failed'}); }
});

router.post('/forgot-password',async(req,res)=>{
  const generic={ok:true,message:'If that account can receive Campus Eats notifications, a 6-digit reset code has been sent to its enrolled devices.'};
  try{
    const email=String(req.body.email||'').trim().toLowerCase();
    if(!validEmail(email)) return res.json(generic);
    const cr=await pool.query('SELECT id,full_name,email FROM customers WHERE lower(email)=lower($1)',[email]);
    if(!cr.rowCount) return res.json(generic);
    const customer=cr.rows[0];
    const recent=await pool.query(`SELECT created_at FROM password_reset_codes WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 1`,[customer.id]);
    if(recent.rowCount&&Date.now()-new Date(recent.rows[0].created_at).getTime()<60000) return res.json(generic);
    await pool.query(`UPDATE password_reset_codes SET used_at=COALESCE(used_at,now()) WHERE customer_id=$1 AND used_at IS NULL`,[customer.id]);
    const code=String(crypto.randomInt(100000,1000000));
    await pool.query(`INSERT INTO password_reset_codes(customer_id,code_hash,expires_at) VALUES($1,$2,now()+($3 || ' minutes')::interval)`,[customer.id,resetCodeHash(code),RESET_TTL_MINUTES]);
    sendToOwner('customer',customer.id,{
      title:'Campus Eats password reset',
      body:`Your reset code is ${code}. It expires in ${RESET_TTL_MINUTES} minutes.`,
      url:`/forgot-password.html?email=${encodeURIComponent(email)}`,
      tag:'campus-eats-password-reset',
      requireInteraction:true,
      data:{type:'password-reset'}
    }).catch(e=>console.error('password reset push',e));
    res.json(generic);
  }catch(e){console.error('forgot password',e);res.json(generic);}
});

router.post('/reset-password',async(req,res)=>{
  try{
    const email=String(req.body.email||'').trim().toLowerCase();
    const code=String(req.body.code||'').trim();
    const newPassword=String(req.body.newPassword||'');
    if(!validEmail(email)||!/^\d{6}$/.test(code)||newPassword.length<8) return res.status(400).json({error:'Enter a valid email, 6-digit code and a password of at least 8 characters'});
    const r=await pool.query(`SELECT pr.id,pr.code_hash,pr.attempts,c.id customer_id
      FROM password_reset_codes pr JOIN customers c ON c.id=pr.customer_id
      WHERE lower(c.email)=lower($1) AND pr.used_at IS NULL AND pr.expires_at>now()
      ORDER BY pr.created_at DESC LIMIT 1`,[email]);
    if(!r.rowCount) return res.status(400).json({error:'The reset code is invalid or has expired'});
    const row=r.rows[0];
    if(row.attempts>=RESET_MAX_ATTEMPTS) return res.status(429).json({error:'Too many incorrect attempts. Request a new reset code.'});
    if(!sameHash(row.code_hash,resetCodeHash(code))){
      await pool.query('UPDATE password_reset_codes SET attempts=attempts+1 WHERE id=$1',[row.id]);
      return res.status(400).json({error:'The reset code is invalid or has expired'});
    }
    const hash=await bcrypt.hash(newPassword,SALT_ROUNDS);
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      await client.query('UPDATE customers SET password_hash=$1 WHERE id=$2',[hash,row.customer_id]);
      await client.query('UPDATE password_reset_codes SET used_at=now() WHERE customer_id=$1 AND used_at IS NULL',[row.customer_id]);
      await client.query('COMMIT');
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
    res.json({ok:true,message:'Password updated. You can sign in with your new password.'});
  }catch(e){console.error('reset password',e);res.status(500).json({error:'Could not reset password'});}
});

router.post('/verify',(_req,res)=>res.status(410).json({error:'Email verification is disabled during the Web Push pilot'}));
router.post('/resend-verification',(_req,res)=>res.status(410).json({error:'Email verification is disabled during the Web Push pilot'}));

router.post('/staff/demo-login', async(req,res)=>{
  try{
    const expected=process.env.DEMO_STAFF_PASSCODE||'comrades_2026';
    if(String(req.body.passcode||'')!==expected) return res.status(401).json({error:'Wrong passcode'});
    const r=await pool.query(`SELECT id,full_name,email,phone,role FROM staff WHERE email='demo.staff@campuseats.local' AND is_active=TRUE`);
    if(!r.rowCount) return res.status(500).json({error:'Demo staff account not initialized'});
    const staff=r.rows[0];
    res.json({token:signToken({id:staff.id,type:'staff',role:staff.role}),staff});
  }catch(e){ console.error('demo staff login',e); res.status(500).json({error:'Staff login failed'}); }
});

router.post('/staff/register',verifyToken,requireStaff('admin'),async(req,res)=>{
  try{
    const {fullName,email,phone,password,role}=req.body;
    if(!fullName||!validEmail(email)||!phone||!password) return res.status(400).json({error:'Full name, valid email, phone and password are required'});
    const hash=await bcrypt.hash(password,SALT_ROUNDS);
    const r=await pool.query(`INSERT INTO staff(full_name,email,phone,password_hash,role,email_enabled,whatsapp_enabled) VALUES($1,$2,$3,$4,$5,FALSE,FALSE)
      RETURNING id,full_name,email,phone,role,created_at`,[fullName,email.toLowerCase(),normalizePhone(phone),hash,role||'runner']);
    res.status(201).json({staff:r.rows[0]});
  }catch(e){ console.error('staff register',e); res.status(500).json({error:'Staff registration failed'}); }
});

module.exports=router;
