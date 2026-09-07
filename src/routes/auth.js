const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');
const { verifyToken, requireStaff } = require('../middleware/auth');
const router = express.Router();
const SALT_ROUNDS=12;
function signToken(payload){ return jwt.sign(payload,process.env.JWT_SECRET,{expiresIn:process.env.JWT_EXPIRES_IN||'7d'}); }
function normalizePhone(v){ return String(v||'').replace(/[\s-]/g,''); }
function validEmail(v){ return !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

router.post('/register', async(req,res)=>{
  try{
    const {fullName,email,password,buildingId,roomNumber}=req.body;
    const phone=normalizePhone(req.body.phone);
    if(!fullName||!phone||!password||!validEmail(email)) return res.status(400).json({error:'fullName, phone and password are required; email must be valid if provided'});
    if(password.length<8) return res.status(400).json({error:'Password must be at least 8 characters'});
    const exists=await pool.query('SELECT id FROM customers WHERE phone=$1 OR (email IS NOT NULL AND email=$2)',[phone,email?email.toLowerCase():null]);
    if(exists.rowCount) return res.status(409).json({error:'An account with this phone or email already exists'});
    const hash=await bcrypt.hash(password,SALT_ROUNDS);
    const r=await pool.query(`INSERT INTO customers(full_name,email,phone,password_hash,building_id,room_number)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id,full_name,email,phone,building_id,room_number,created_at`,
      [fullName,email?email.toLowerCase():null,phone,hash,buildingId||null,roomNumber||null]);
    const customer=r.rows[0];
    res.status(201).json({token:signToken({id:customer.id,type:'customer'}),customer});
  }catch(e){ console.error('register',e); res.status(500).json({error:'Registration failed'}); }
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
    const payload=as==='staff'?{id:account.id,type:'staff',role:account.role}:{id:account.id,type:'customer'};
    delete account.password_hash;
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
    const r=await pool.query(`INSERT INTO staff(full_name,email,phone,password_hash,role) VALUES($1,$2,$3,$4,$5)
      RETURNING id,full_name,email,phone,role,created_at`,[fullName,email.toLowerCase(),normalizePhone(phone),hash,role||'runner']);
    res.status(201).json({staff:r.rows[0]});
  }catch(e){ if(e.code==='23505')return res.status(409).json({error:'Staff email already exists'}); console.error(e); res.status(500).json({error:'Staff registration failed'}); }
});
module.exports=router;
