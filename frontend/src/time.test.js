import { resolveTimestamp } from './time.js';
let pass=0, fail=0;
const t=(n,c)=>{ if(c){pass++;console.log('  pass ',n)}else{fail++;console.log('  FAIL ',n)} };
const at=(h,m)=>{const d=new Date(2026,9,2,h,m,0);return d};
const dayStart=at(4,0).toISOString();
t('now -> null iso', resolveTimestamp('now','',dayStart).iso===null);
let r=resolveTimestamp('custom','19:30',dayStart,at(21,10));
t('earlier today ok', new Date(r.iso).getHours()===19 && new Date(r.iso).getMinutes()===30);
r=resolveTimestamp('custom','22:00',dayStart,at(21,10));
t('future time rejected at 9pm', !!r.error && !r.iso);
// 1am, register day started yesterday 4am
const ds2=new Date(2026,9,1,4,0).toISOString();
r=resolveTimestamp('custom','23:30',ds2,at(1,0));
t('11:30pm at 1am means last night', new Date(r.iso).getDate()===1 && new Date(r.iso).getHours()===23);
r=resolveTimestamp('custom','03:00',dayStart,at(21,10));
t('before 4am rollover rejected', !!r.error);
t('empty time rejected', !!resolveTimestamp('custom','',dayStart).error);
console.log(`${pass}/${pass+fail} passed`); process.exit(fail?1:0);
