// BUILD ARTEFACT — profit as a function of price & tier, at a fixed good pitch.
var Core=require('../src/core.js'), Engine=require('../src/engine.js');
var town=Core.generateTown('hotplate'), st=Engine.makeState(town);
st.mods={demand2d:true,priceQuality:true,delivery:true,roads:true,agglomRent:true,loyalty:false,entry:false};
var B=st.players.filter(function(p){return p.id==='B';})[0];
var save={x:B.x,y:B.y};
console.log('profit(price, tier) for B at its opening pitch — seed hotplate\n');
console.log('price   Fast(Q1.0)   Casual(Q1.8)   Fine(Q3.0)');
for(var pr=6;pr<=20;pr+=2){
  var row=('$'+pr).padEnd(8);
  for(var t=0;t<3;t++){
    B.price=pr;B.tier=t;B.x=save.x;B.y=save.y;
    row+=('$'+Math.round(Engine.profitOf(town,st,'B'))).padEnd(14);
  }
  console.log(row);
}
console.log('\nunit cost / fixed cost by tier:');
for(var t=0;t<3;t++){
  var Q=Engine.CFG.tiers[t];
  console.log('  tier '+t+' (Q='+Q+'): unit $'+(Engine.CFG.c0+Engine.CFG.c1*(Q-1)).toFixed(2)+
              '  fixed $'+(Engine.CFG.f0+Engine.CFG.f1*Q*Q).toFixed(0)+
              '  margin@$20 $'+(20-(Engine.CFG.c0+Engine.CFG.c1*(Q-1))).toFixed(2));
}
