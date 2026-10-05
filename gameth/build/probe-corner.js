// BUILD ARTEFACT — checks whether the AI's price/tier optimum is a corner solution.
var Core=require('../src/core.js'), Engine=require('../src/engine.js'), Nash=require('../src/nash.js');
var CFG=Engine.CFG||require('../src/engine.js').CFG;
var SEEDS=['hotplate','alpha','bravo','charlie','delta','echo','foxtrot','golf'];
var hiP=0,hiT=0,n=0, prices=[], tiers=[];
SEEDS.forEach(function(s){
  var town=Core.generateTown(s), st=Engine.makeState(town);
  st.mods={demand2d:true,priceQuality:true,delivery:true,roads:true,agglomRent:true,loyalty:true,entry:true};
  for(var d=0;d<6;d++){
    var mv=Nash.aiMove(town,st,'B','optimizer');
    prices.push(+mv.price.toFixed(2)); tiers.push(mv.tier); n++;
    var B=st.players.filter(function(p){return p.id==='B';})[0];
    B.x=mv.x;B.y=mv.y;B.price=mv.price;B.tier=mv.tier;
    var r=Engine.evaluate(town,st); Engine.stepLoyalty(st,r); st.round++;
  }
});
var pmax=Math.max.apply(null,prices), pmin=Math.min.apply(null,prices);
function cnt(a,v){return a.filter(function(x){return x===v;}).length;}
console.log('AI optimizer price/tier choices over '+n+' decisions');
console.log('price range chosen : '+pmin.toFixed(2)+' .. '+pmax.toFixed(2));
console.log('distinct prices    : '+Object.keys(prices.reduce(function(m,v){m[v]=1;return m;},{})).sort(function(a,b){return a-b;}).join(', '));
console.log('tier 0 / 1 / 2     : '+cnt(tiers,0)+' / '+cnt(tiers,1)+' / '+cnt(tiers,2));
console.log('at max price       : '+cnt(prices,pmax)+'/'+n+'  ('+Math.round(100*cnt(prices,pmax)/n)+'%)');
