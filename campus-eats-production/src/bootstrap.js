const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('./config/db');
const { normalizePhone } = require('./utils/whatsapp');

async function applySchema() {
  if ((process.env.AUTO_MIGRATE || 'true').toLowerCase() !== 'true') return;
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  await pool.query(sql);
  console.log('[bootstrap] schema ready');
}

function loadJsonEnv(name, fallback) {
  try { return JSON.parse(process.env[name] || JSON.stringify(fallback)); }
  catch (e) { console.error(`[bootstrap] invalid ${name}`); return fallback; }
}

function loadStaffDirectory() {
  const rows = loadJsonEnv('STAFF_DIRECTORY_JSON', []);
  return Array.isArray(rows) ? rows : [];
}

function loadStaffEmailMap() {
  const raw = loadJsonEnv('STAFF_EMAIL_MAP_JSON', {});
  if (!raw || Array.isArray(raw) || typeof raw !== 'object') return {};
  return Object.fromEntries(Object.entries(raw).map(([name,email]) => [String(name).trim().toLowerCase(), String(email||'').trim().toLowerCase()]));
}

async function seedData() {
  if ((process.env.AUTO_SEED || 'true').toLowerCase() !== 'true') return;
  const buildings = JSON.parse(fs.readFileSync(path.join(__dirname,'..','seed-buildings.json'),'utf8'));
  await pool.query(`UPDATE buildings SET is_active=FALSE`);
  for (const name of buildings) await pool.query(`INSERT INTO buildings(name,campus_zone,est_minutes,is_active) VALUES($1,'Braamfontein Main Campus',10,TRUE) ON CONFLICT(name) DO UPDATE SET campus_zone=EXCLUDED.campus_zone,is_active=TRUE`,[name]);
  const menu = JSON.parse(fs.readFileSync(path.join(__dirname,'..','seed-menu.json'),'utf8'));
  for (const item of menu) await pool.query(`INSERT INTO menu_items(name,description,price_cents,is_available) VALUES($1,$2,$3,TRUE) ON CONFLICT(name) DO UPDATE SET description=EXCLUDED.description,price_cents=EXCLUDED.price_cents`,[item.name,item.description,item.price_cents]);

  const directory = loadStaffDirectory();
  const emailMap = loadStaffEmailMap();
  for (const [idx, member] of directory.entries()) {
    const name=String(member.name||'').trim(), phone=normalizePhone(member.phone);
    if(!name||!phone) continue;
    const mappedEmail=emailMap[name.toLowerCase()];
    const suppliedEmail=String(mappedEmail || member.email || '').trim().toLowerCase();
    const hasRealEmail=/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(suppliedEmail) && !suppliedEmail.endsWith('@staff.campuseats.local');
    const email=hasRealEmail?suppliedEmail:`${name.toLowerCase().replace(/[^a-z0-9]+/g,'.')}@staff.campuseats.local`;
    const passwordHash=await bcrypt.hash(`managed-staff-${idx}-${process.env.JWT_SECRET||'campus-eats'}`,12);
    await pool.query(`INSERT INTO staff(full_name,email,phone,password_hash,role,is_active,email_enabled,whatsapp_enabled)
      VALUES($1,$2,$3,$4,$5,TRUE,$6,FALSE)
      ON CONFLICT(phone) DO UPDATE SET full_name=EXCLUDED.full_name,email=EXCLUDED.email,role=EXCLUDED.role,is_active=TRUE,email_enabled=EXCLUDED.email_enabled,whatsapp_enabled=FALSE`,
      [name,email,phone,passwordHash,member.role||'runner',hasRealEmail]);
  }

  const demoPasswordHash=await bcrypt.hash('demo-not-used-directly',12);
  await pool.query(`INSERT INTO staff(full_name,email,phone,password_hash,role,is_active,email_enabled,whatsapp_enabled)
    VALUES('Campus Eats Demo Staff','demo.staff@campuseats.local','27000000000',$1,'admin',TRUE,FALSE,FALSE)
    ON CONFLICT(email) DO UPDATE SET is_active=TRUE,email_enabled=FALSE,whatsapp_enabled=FALSE`,[demoPasswordHash]);
  console.log(`[bootstrap] seeded ${buildings.length} active main-campus locations, ${menu.length} menu items, ${directory.length} configured staff`);
}
module.exports={applySchema,seedDemoData:seedData,seedData};
