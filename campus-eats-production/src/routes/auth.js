const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('../config/db');
const { verifyToken, requireStaff } = require('../middleware/auth');
const { normalizePhone } = require('../utils/whatsapp');
const { sha256, sendVerificationCode } = require('../utils/notifications');

const router = express.Router();
const SALT_ROUNDS = 12;
const VERIFY_TTL_MINUTES = Number(process.env.VERIFICATION_TTL_MINUTES || 10);

function signToken(payload){ return jwt.sign(payload,process.env.JWT_SECRET,{expiresIn:process.env.JWT_EXPIRES_IN||'7d'}); }
function validEmail(v){ return !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
function verificationHash(customerId, code){ return sha256(`${customerId}:${code}:${process.env.JWT_SECRET}`); }
function newCode(){ return String(crypto.randomInt(100000,1000000)); }

async function issueVerification(customer) {
  const code = newCode();
  await pool.query(`UPDATE customers SET verification_code_hash=$1,
    verification_expires_at=now()+($2 || ' minutes')::interval,
    verification_sent_at=now(), verification_attempts=0 WHERE id=$3`,
    [verificationHash(customer.id, code), VERIFY_TTL_MINUTES, customer.id]);
  await sendVerificationCode(customer, code);
}

router.post('/register', async(req,res)=>{
  try{
    const {fullName,email,password}=req.body;
    const phone=normalizePhone(req.body.phone);
    const whatsappOptIn=req.body.whatsappOptIn === true;
    if(!fullName||!phone||!password||!validEmail(email)) return res.status(400).json({error:'Full name, phone and password are required; email must be valid if provided'});
    if(!whatsappOptIn) return res.status(400).json({error:'WhatsApp service-message consent is required so we can verify the account and send order updates'});
    if(password.length<8) return res.status(400).json({error:'Password must be at least 8 characters'});

    const exists=await pool.query('SELECT id,phone_verified_at FROM customers WHERE phone=$1 OR (email IS NOT NULL AND email=$2)',[phone,email?email.toLowerCase():null]);
    if(exists.rowCount) return res.status(409).json({error:'An account with this phone or email already exists',verificationRequired:!exists.rows[0].phone_verified_at,customerId:exists.rows[0].id});

    const hash=await bcrypt.hash(password,SALT_ROUNDS);
    const r=await pool.query(`INSERT INTO customers(full_name,email,phone,password_hash,whatsapp_opt_in)
      VALUES($1,$2,$3,$4,TRUE) RETURNING id,full_name,email,phone,whatsapp_opt_in,created_at`,
      [fullName,email?email.toLowerCase():null,phone,hash]);
    const customer=r.rows[0];
    await issueVerification(customer);
    res.status(201).json({verificationRequired:true,customerId:customer.id,phone:customer.phone});
  }catch(e){ console.error('register',e); res.status(500).json({error:'Registration failed'}); }
});

router.post('/verify', async(req,res)=>{
  try{
    const customerId=String(req.body.customerId||'');
    const code=String(req.body.code||'').replace(/\D/g,'');
    if(!customerId||code.length!==6) return res.status(400).json({error:'Customer ID and 6-digit verification code are required'});
    const r=await pool.query(`SELECT id,full_name,email,phone,whatsapp_opt_in,phone_verified_at,verification_code_hash,
      verification_expires_at,verification_attempts FROM customers WHERE id=$1`,[customerId]);
    if(!r.rowCount) return res.status(404).json({error:'Account not found'});
    const customer=r.rows[0];
    if(customer.phone_verified_at) return res.json({token:signToken({id:customer.id,type:'customer'}),customer});
    if(!customer.verification_expires_at || new Date(customer.verification_expires_at) < new Date()) return res.status(410).json({error:'Verification code expired. Request a new one.'});
    if(customer.verification_attempts>=5) return res.status(429).json({error:'Too many verification attempts. Request a new code.'});
    const expected=verificationHash(customer.id,code);
    const ok=crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(customer.verification_code_hash||''.padEnd(64,'0')));
    if(!ok){
      await pool.query('UPDATE customers SET verification_attempts=verification_attempts+1 WHERE id=$1',[customer.id]);
      return res.status(400).json({error:'Incorrect verification code'});
    }
    const v=await pool.query(`UPDATE customers SET phone_verified_at=now(),verification_code_hash=NULL,
      verification_expires_at=NULL,verification_attempts=0 WHERE id=$1
      RETURNING id,full_name,email,phone,whatsapp_opt_in,phone_verified_at,created_at`,[customer.id]);
    const verified=v.rows[0];
    res.json({token:signToken({id:verified.id,type:'customer'}),customer:verified});
  }catch(e){ console.error('verify',e); res.status(500).json({error:'Verification failed'}); }
});

router.post('/resend-verification', async(req,res)=>{
  try{
    const customerId=String(req.body.customerId||'');
    const r=await pool.query(`SELECT id,full_name,phone,whatsapp_opt_in,phone_verified_at,verification_sent_at FROM customers WHERE id=$1`,[customerId]);
    if(!r.rowCount) return res.status(404).json({error:'Account not found'});
    const customer=r.rows[0];
    if(customer.phone_verified_at) return res.json({alreadyVerified:true});
    if(customer.verification_sent_at && Date.now()-new Date(customer.verification_sent_at).getTime()<60000) return res.status(429).json({error:'Please wait a minute before requesting another code'});
    await issueVerification(customer);
    res.json({sent:true});
  }catch(e){ console.error('resend verification',e); res.status(500).json({error:'Could not resend verification'}); }
});

router.post('/login', async(req,res)=>{
  try{
    const {password}=req.body;
    const as=req.body.as==='staff'?'staff':'customer';
    const identifier=String(req.body.identifier||req.body.email||req.body.phone||'').trim();
    if(!identifier||!password) return res.status(400).json({error:'Phone/email and password are required'});
    const isEmail=identifier.includes('@');
    const table=as==='staff'?'staff':'customers';
    const query=isEmail?`SELECT * FROM ${table} WHERE lower(email)=lower($1)`:`SELECT * FROM ${table} WHERE phone=$1`;
    const value=isEmail?identifier:normalizePhone(identifier);
    const r=await pool.query(query,[value]); const account=r.rows[0];
    const dummy='$2b$12$0gH67R9G1xRNc5g/1pWqUOzdQ18zlSBVPbkaBPqHFzOEQAS6YfdjC';
    const ok=await bcrypt.compare(password,account?account.password_hash:dummy);
    if(!account||!ok) return res.status(401).json({error:'Invalid credentials'});
    if(as==='staff'&&!account.is_active) return res.status(403).json({error:'Staff account is deactivated'});
    if(as==='customer'&&!account.phone_verified_at) return res.status(403).json({error:'Please verify your WhatsApp number first',verificationRequired:true,customerId:account.id});
    const payload=as==='staff'?{id:account.id,type:'staff',role:account.role}:{id:account.id,type:'customer'};
    delete account.password_hash; delete account.verification_code_hash;
    res.json({token:signToken(payload),[as]:account});
  }catch(e){ console.error('login',e); res.status(500).json({error:'Login failed'}); }
});

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
    if(!fullName||!email||!phone||!password) return res.status(400).json({error:'Missing required fields'});
    const hash=await bcrypt.hash(password,SALT_ROUNDS);
    const r=await pool.query(`INSERT INTO staff(full_name,email,phone,password_hash,role,whatsapp_enabled) VALUES($1,$2,$3,$4,$5,TRUE)
      RETURNING id,full_name,email,phone,role,created_at`,[fullName,email.toLowerCase(),normalizePhone(phone),hash,role||'runner']);
    res.status(201).json({staff:r.rows[0]});
  }catch(e){ console.error('staff register',e); res.status(500).json({error:'Staff registration failed'}); }
});

module.exports=router;
