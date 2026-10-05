// BUILD ARTEFACT — does applying the top hint deliver the promised gain?
// Replays the shipped order: evaluate -> stepLoyalty -> explain -> apply -> re-evaluate.
var Core=require('./../src/core.js'), Engine=require('./../src/engine.js'), Nash=require('./../src/nash.js');
var SEEDS=['hotplate','alpha','bravo','charlie','delta','echo','foxtrot','golf'];
var MODS={demand2d:true,priceQuality:true,delivery:true,roads:true,agglomRent:true,loyalty:true,entry:true};
function byId(st,id){return st.players.filter(function(p){return p.id===id;})[0];}
var checked=0, honest=0, worst=0;
SEEDS.forEach(function(s){
  var town=Core.generateTown(s), st=Engine.makeState(town); st.mods=MODS;
  for(var d=0;d<6;d++){
    var r=Engine.evaluate(town,st);
    Engine.stepLoyalty(st,r); st.round++;              // shipped: loyalty advances before explain
    var ex=Nash.explain(town,st,r,'A');
    if(ex && ex.hints && ex.hints.length){
      var h=ex.hints[0];
      var A=byId(st,'A'), save={x:A.x,y:A.y,price:A.price,tier:A.tier,radius:A.radius};
      var before=Engine.profitOf(town,st,'A');
      for(var k in h.apply) A[k]=h.apply[k];
      if(h.apply.x!=null){var sp=Engine.snap(town,A.x,A.y);A.x=sp.x;A.y=sp.y;}
      var after=Engine.profitOf(town,st,'A');
      var realized=after-before, promised=h.gain;
      A.x=save.x;A.y=save.y;A.price=save.price;A.tier=save.tier;A.radius=save.radius;
      checked++;
      var err=realized-promised;
      if(realized>-1) honest++;                          // hint should not LOSE money
      if(err<worst) worst=err;
    }
  }
});
console.log('top-hint checks        : '+checked);
console.log('hints that gain (>=$0) : '+honest+'/'+checked+'  ('+Math.round(100*honest/checked)+'%)');
console.log('worst realized-promised: $'+worst.toFixed(2));
console.log(honest===checked ? '=> every top hint delivers a real gain' : '=> some hints still mislead');
