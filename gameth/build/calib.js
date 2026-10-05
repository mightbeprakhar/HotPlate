// BUILD ARTEFACT — calibrates (theta_q, f1) so the menu tier is situational,
// not a dominant strategy. Reports the tier mix the AI actually picks.
var Core=require('../src/core.js'), Engine=require('../src/engine.js'), Nash=require('../src/nash.js');
var C=Engine.CONFIG;
var SEEDS=['hotplate','alpha','bravo','charlie','delta','echo','foxtrot','golf','hotel','india'];
var MODS={demand2d:true,priceQuality:true,delivery:true,roads:true,agglomRent:true,loyalty:true,entry:false};

function tierMix(tq,f1){
  C.theta_q=tq; C.f1=f1;
  var t=[0,0,0], byTaste={};
  SEEDS.forEach(function(s){
    var town=Core.generateTown(s), st=Engine.makeState(town); st.mods=MODS;
    for(var d=0;d<5;d++){
      var mv=Nash.aiMove(town,st,'B','optimizer');
      t[mv.tier]++;
      var z=Core.ZONES[town.zone[mv.y*town.W+mv.x]]||'?';
      byTaste[z]=byTaste[z]||[0,0,0]; byTaste[z][mv.tier]++;
      var B=st.players.filter(function(p){return p.id==='B';})[0];
      B.x=mv.x;B.y=mv.y;B.price=mv.price;B.tier=mv.tier;
      var r=Engine.evaluate(town,st); Engine.stepLoyalty(st,r); st.round++;
    }
  });
  return {t:t,byTaste:byTaste};
}
console.log('theta_q  f1    Fast/Casual/Fine');
[[0.82,44],[0.70,56],[0.62,56],[0.62,70],[0.54,70],[0.48,78],[0.42,78]].forEach(function(cfg){
  var r=tierMix(cfg[0],cfg[1]);
  console.log(String(cfg[0]).padEnd(9)+String(cfg[1]).padEnd(6)+r.t.join(' / '));
});
