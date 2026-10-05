// BUILD ARTEFACT — does the hint baseline drift after stepLoyalty?
// Reproduces the shipped call order: evaluate -> stepLoyalty -> explain.
var Core=require('../src/core.js'), Engine=require('../src/engine.js'), Nash=require('../src/nash.js');
var town=Core.generateTown('hotplate'), st=Engine.makeState(town);
st.mods={demand2d:true,priceQuality:true,delivery:true,roads:true,agglomRent:true,loyalty:true,entry:true};
// play two days so prevFrac is populated and moving
for(var d=0;d<2;d++){ var r0=Engine.evaluate(town,st); Engine.stepLoyalty(st,r0); st.round++; }
var r=Engine.evaluate(town,st);                     // the result shown on the scoreboard
var mineProfit=r.perPlayer.filter(function(p){return p.id==='A';})[0].profit;
Engine.stepLoyalty(st,r);                            // shipped order: loyalty advances BEFORE explain runs
var baselineNow=Engine.profitOf(town,st,'A');        // what the hint code's probe() measures against
console.log('scoreboard profit (explain uses as baseline) : $'+mineProfit.toFixed(2));
console.log('profitOf baseline at probe time             : $'+baselineNow.toFixed(2));
console.log('baseline drift from the loyalty step        : $'+(baselineNow-mineProfit).toFixed(2));
console.log(Math.abs(baselineNow-mineProfit)>1
  ? '=> BUG: hints compare a post-loyalty probe against a pre-loyalty baseline'
  : '=> baseline stable');
