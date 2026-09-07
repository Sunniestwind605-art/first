const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
const { pool } = require('./config/db');

async function applySchema() {
  if ((process.env.AUTO_MIGRATE || 'true').toLowerCase() !== 'true') return;
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('[bootstrap] schema ready');
}

async function seedDemoData() {
  if ((process.env.AUTO_SEED || 'true').toLowerCase() !== 'true') return;
  const buildings = JSON.parse(fs.readFileSync(path.join(__dirname,'..','seed-buildings.json'),'utf8'));
  for (const name of buildings) {
    await pool.query(`INSERT INTO buildings(name, campus_zone, est_minutes) VALUES($1,'Wits',10) ON CONFLICT(name) DO NOTHING`, [name]);
  }
  const menu = JSON.parse(fs.readFileSync(path.join(__dirname,'..','seed-menu.json'),'utf8'));
  for (const item of menu) {
    await pool.query(`INSERT INTO menu_items(name,description,price_cents,is_available) VALUES($1,$2,$3,TRUE)
      ON CONFLICT(name) DO UPDATE SET description=EXCLUDED.description, price_cents=EXCLUDED.price_cents`, [item.name,item.description,item.price_cents]);
  }
  const demoPasswordHash = await bcrypt.hash('demo-not-used-directly', 12);
  await pool.query(`INSERT INTO staff(full_name,email,phone,password_hash,role,is_active)
    VALUES('Campus Eats Demo Staff','demo.staff@campuseats.local','0000000000',$1,'admin',TRUE)
    ON CONFLICT(email) DO UPDATE SET is_active=TRUE`, [demoPasswordHash]);
  console.log(`[bootstrap] seeded ${buildings.length} buildings and ${menu.length} menu items`);
}

module.exports = { applySchema, seedDemoData };
