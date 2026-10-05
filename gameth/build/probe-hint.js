// BUILD ARTEFACT — is the hint baseline consistent with the scoreboard?
var Core=require('../src/core.js'), Engine=require('../src/engine.js'), Nash=require('../src/nash.js');
var town=Core.generateTown('hotplate'), st=Engine.makeState(town);
st.mods={demand2d:true,priceQuality:true,delivery:true,roads:true,agglomRent:true,loyalty:true,entry:true};
var r=Engine.evaluate(town,st);
var mine=r.perPlayer.filter(function(p){return p.id==='A';})[0];
var direct=Engine.profitOf(town,st,'A');
console.log('evaluate() profit for A : $'+mine.profit.toFixed(2));
console.log('profitOf() profit for A : $'+direct.toFixed(2));
console.log('difference              : $'+(direct-mine.profit).toFixed(2));
console.log(Math.abs(direct-mine.profit)<0.01 ? '=> consistent' : '=> INCONSISTENT — hint gains are measured against the wrong baseline');
// and after a few loyalty rounds, when prevFrac is populated
for(var d=0;d<3;d++){ var rr=Engine.evaluate(town,st); Engine.stepLoyalty(st,rr); st.round++; }
var r2=Engine.evaluate(town,st);
var m2=r2.perPlayer.filter(function(p){return p.id==='A';})[0];
var d2=Engine.profitOf(town,st,'A');
console.log('\nafter 3 loyalty rounds:');
console.log('evaluate() : $'+m2.profit.toFixed(2)+'   profitOf() : $'+d2.toFixed(2)+'   diff $'+(d2-m2.profit).toFixed(2));
