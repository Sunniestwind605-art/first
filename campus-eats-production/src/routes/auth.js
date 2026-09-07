const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');
const { verifyToken, requireStaff } = require('../middleware/auth');
const { normalizePhone } = require('../utils/whatsapp');

const router = express.Router();
const SALT_ROUNDS = 12;

function signToken(payload){ return jwt.sign(payload,process.env.JWT_SECRET,{expiresIn:process.env.JWT_EXPIRES_IN||'7d'}); }
function validEmail(v){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v||'')); }

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
