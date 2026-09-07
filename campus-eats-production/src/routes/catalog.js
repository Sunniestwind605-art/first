const express = require('express');
const { pool } = require('../config/db');
const router = express.Router();
router.get('/menu', async (_req,res)=>{
  try {
    const r=await pool.query(`SELECT id,name,description,price_cents,is_available FROM menu_items WHERE is_available=TRUE ORDER BY name`);
    res.json({items:r.rows});
  } catch(e){ console.error(e); res.status(500).json({error:'Failed to load menu'}); }
});
router.get('/buildings', async (_req,res)=>{
  try {
    const r=await pool.query(`SELECT id,name,est_minutes FROM buildings WHERE is_active=TRUE ORDER BY name`);
    res.json({buildings:r.rows});
  } catch(e){ console.error(e); res.status(500).json({error:'Failed to load buildings'}); }
});
module.exports=router;
