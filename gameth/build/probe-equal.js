// BUILD ARTEFACT — equal skill, simultaneous commitment. Both players best-respond
// to the morning board. If the last-mover advantage is truly gone this should be
// near a coin flip; a persistent large skew would mean a seat advantage remains.
var Core=require('./../src/core.js'), Engine=require('./../src/engine.js'), Nash=require('./../src/nash.js');
var SEEDS=['hotplate','alpha','bravo','charlie'];
           
var MODS={demand2d:true,priceQuality:true,delivery:true,roads:true,agglomRent:true,loyalty:true,entry:true};
function byId(st,id){return st.players.filter(function(p){return p.id===id;})[0];}
var winA=0,winB=0,sumA=0,sumB=0,DAYS=8;
SEEDS.forEach(function(s){
  var town=Core.generateTown(s), st=Engine.makeState(town); st.mods=MODS;
  var cum={A:0,B:0};
  for(var d=0;d<DAYS;d++){
    var A=byId(st,'A'), B=byId(st,'B');
    var ma=Nash.aiMove(town,st,'A','optimizer');   // both plan vs the morning board
    var mb=Nash.aiMove(town,st,'B','optimizer');
    A.x=ma.x;A.y=ma.y;A.price=ma.price;A.tier=ma.tier;
    B.x=mb.x;B.y=mb.y;B.price=mb.price;B.tier=mb.tier;
    var r=Engine.evaluate(town,st);
    var e=Engine.checkEntry(town,st,r); if(e)Engine.spawnChain(st,e);
    r.perPlayer.forEach(function(pp){cum[pp.id]=(cum[pp.id]||0)+pp.profit;});
    Engine.stepLoyalty(st,r); st.round++;
  }
  sumA+=cum.A; sumB+=cum.B;
  if(cum.A>cum.B)winA++; else if(cum.B>cum.A)winB++;
});
console.log('equal skill, simultaneous — '+SEEDS.length+' towns, '+DAYS+' days\n');
console.log('A/town  $'+Math.round(sumA/SEEDS.length)+'   B/town  $'+Math.round(sumB/SEEDS.length));
console.log('wins A/B: '+winA+'/'+winB+'   ties: '+(SEEDS.length-winA-winB));
var sk=100*(sumB-sumA)/((sumA+sumB)/2);
console.log('seat skew: '+sk.toFixed(1)+'%  '+(Math.abs(sk)<8?'=> fair (no seat advantage)':'=> seat advantage remains'));
