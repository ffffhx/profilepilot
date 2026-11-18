import fs from 'node:fs';
const p='designs/profilepilot-promo/src/scenes.json';
const scenes=JSON.parse(fs.readFileSync(p,'utf8'));
scenes.stage='final';
fs.writeFileSync(p,JSON.stringify(scenes,null,2));
